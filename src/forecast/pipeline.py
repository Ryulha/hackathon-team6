"""Inference and BOM conversion; persistence adapters live in adapters.py."""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path

import numpy as np
import pandas as pd

from .data import DataBundle, day, load_data
from .features import FeatureBuilder
from .model import DemandModel


@dataclass
class ForecastResult:
    menus: pd.DataFrame
    ingredients: pd.DataFrame
    metadata: dict


def estimate_cancellation_rates(data: DataBundle, as_of_date, lookback_days=56):
    origin = day(as_of_date)
    sales = data["sales"].loc[lambda x: (x.date < origin) & (x.date >= origin - pd.Timedelta(days=lookback_days))]
    pairs = pd.MultiIndex.from_product([data["stores"].store_id, data["menus"].menu_id], names=["store_id", "menu_id"]).to_frame(index=False)
    sums = sales.groupby(["store_id", "menu_id"], as_index=False)[["qty", "cancel_qty"]].sum()
    pairs = pairs.merge(sums, on=["store_id", "menu_id"], how="left")
    # Cancellation is conditional on accepted orders, not demand (which contains stockout losses).
    by_menu = sales.groupby("menu_id")[["qty", "cancel_qty"]].sum()
    menu_rate = by_menu.cancel_qty.div(by_menu.qty.where(by_menu.qty > 0))
    total = sales.qty.sum()
    global_rate = float(sales.cancel_qty.sum() / total) if total else 0.0
    pairs["cancel_rate"] = pairs.cancel_qty.div(pairs.qty.where(pairs.qty > 0)).fillna(pairs.menu_id.map(menu_rate)).fillna(global_rate).clip(0, 1)
    return pairs[["store_id", "menu_id", "cancel_rate"]]


def to_ingredient_usage(menus: pd.DataFrame, data: DataBundle) -> pd.DataFrame:
    """Each predicted menu uses its own BOM, including sets; never expand components."""
    if not set(menus.menu_id).issubset(set(data["bom"].menu_id)):
        raise ValueError("Prediction contains a menu without BOM")
    units = data["bom"].merge(data["ingredients"][["ingredient_id", "use_unit"]], on="ingredient_id", suffixes=("", "_master"))
    if not units.use_unit.eq(units.use_unit_master).all():
        raise ValueError("BOM use_unit mismatch")
    if menus.pred_net_qty.isna().any() or (menus.pred_net_qty < 0).any() or not np.isfinite(menus.pred_net_qty).all():
        raise ValueError("Invalid predicted net quantities")
    joined = menus.merge(data["bom"], on="menu_id", how="left", validate="many_to_many")
    joined["pred_use_qty"] = joined.pred_net_qty * joined.qty_per_menu
    keys = ["as_of_date", "target_date", "store_id", "ingredient_id", "use_unit"]
    return joined.groupby(keys, as_index=False).pred_use_qty.sum().sort_values(keys).reset_index(drop=True)


class Predictor:
    def __init__(self, data: DataBundle, model: DemandModel | None = None, selected_model="baseline", selection_metadata=None):
        if selected_model not in {"baseline", "catboost"}:
            raise ValueError("selected_model must be baseline or catboost")
        if selected_model == "catboost" and model is None:
            raise ValueError("CatBoost requires a saved fitted model")
        self.data, self.model, self.selected_model = data, model, selected_model
        self.selection_metadata = selection_metadata or {}

    @classmethod
    def from_artifacts(cls, data_dir=None, artifact_dir="models/evaluated", model_name=None):
        directory = Path(artifact_dir)
        selection = json.loads((directory / "selection.json").read_text(encoding="utf-8"))
        selected = model_name or selection["selected_model"]
        model = DemandModel.load(directory / "catboost") if selected == "catboost" else None
        return cls(load_data(data_dir), model, selected, selection)

    def predict_demand(self, as_of_date, forecast_days=7, store_ids=None, demand_multiplier=1.0):
        origin = day(as_of_date)
        selection_max = self.selection_metadata.get("selection_target_max")
        if selection_max and origin <= day(selection_max):
            raise ValueError("Model selection used labels on or after forecast origin")
        if not np.isfinite(demand_multiplier) or demand_multiplier < 0:
            raise ValueError("demand_multiplier must be finite and nonnegative")
        if not isinstance(forecast_days, int) or isinstance(forecast_days, bool) or forecast_days < 1:
            raise ValueError("forecast_days must be a positive integer")
        stores = self.data["stores"].store_id.tolist() if store_ids is None else list(store_ids)
        if not stores or len(set(stores)) != len(stores) or not set(stores).issubset(set(self.data["stores"].store_id)):
            raise ValueError("store_ids must contain distinct known stores")
        history = self.data.before(origin)
        if history["sales"].empty or history["sales"].date.max() < origin - pd.Timedelta(days=1):
            raise ValueError("Sales history must reach the day before the forecast origin")
        features = FeatureBuilder(history).origin(origin, forecast_days)
        features = features.loc[features.store_id.isin(stores)].copy()
        values = self.model.predict(features) if self.selected_model == "catboost" else features.baseline_qty.to_numpy()
        menus = features[["as_of_date", "target_date", "store_id", "menu_id", "is_available", "horizon"]].copy()
        menus["pred_demand_qty"] = values * demand_multiplier
        rates = estimate_cancellation_rates(history, origin)
        menus = menus.merge(rates, on=["store_id", "menu_id"], validate="many_to_one")
        menus["pred_net_qty"] = menus.pred_demand_qty * (1 - menus.cancel_rate)
        if not np.isfinite(menus[["pred_demand_qty", "pred_net_qty"]].to_numpy()).all():
            raise ValueError("Nonfinite forecast")
        ingredients = to_ingredient_usage(menus, history)
        metadata = {
            "status": "PROPOSED — NOT TEAM APPROVED", "model": self.selected_model,
            "as_of_date": str(origin.date()), "forecast_days": forecast_days,
            "sales_history_max": str(history["sales"].date.max().date()),
            "demand_multiplier": demand_multiplier, "cancel_rate_lookback_days": 56,
            "selection_target_max": selection_max,
            "assumptions": ["No stockouts: all latent demand can be served", "Known calendar, promotion and availability schedules at origin", "Cancellation rates transfer from accepted orders to fully served demand", "Multiplier is a user scenario, not learned causal effect"],
            "model_provenance": self.model.metadata if self.model else {"model": "same-weekday last-four mean", "uses_training": False},
        }
        return ForecastResult(menus.reset_index(drop=True), ingredients, metadata)


def predict_demand(as_of_date, forecast_days=7, store_ids=None, demand_multiplier=1.0,
                   *, data_dir=None, artifact_dir="models/evaluated") -> ForecastResult:
    """Provisional internal callable. Reads a fitted model without training or CSV writes."""
    return Predictor.from_artifacts(data_dir, artifact_dir).predict_demand(
        as_of_date, forecast_days, store_ids, demand_multiplier)
