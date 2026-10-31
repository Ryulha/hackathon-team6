"""Separate provisional interface returning the existing ForecastResult class."""
import numpy as np
import pandas as pd

from forecast.data import day, load_data
from forecast.pipeline import ForecastResult, estimate_cancellation_rates, to_ingredient_usage
from .features import AdaptiveBuilder
from .models import ExperimentModel
from .correction import correction_at_origin


class ExperimentalPredictor:
    def __init__(self, data, model):
        self.data, self.model = data, model

    @classmethod
    def from_artifacts(cls, artifact_dir, data_dir=None):
        return cls(load_data(data_dir), ExperimentModel.load(artifact_dir))

    def predict_demand(self, as_of_date, forecast_days=7, store_ids=None, demand_multiplier=1., *, residual_bank=None):
        origin = day(as_of_date)
        if not isinstance(forecast_days, int) or isinstance(forecast_days, bool) or not 1 <= forecast_days <= 7:
            raise ValueError("forecast_days must be an integer in 1..7")
        if not np.isfinite(demand_multiplier) or demand_multiplier < 0:
            raise ValueError("Invalid demand_multiplier")
        stores = self.data["stores"].store_id.tolist() if store_ids is None else list(store_ids)
        if not stores or len(set(stores)) != len(stores) or not set(stores).issubset(self.data["stores"].store_id):
            raise ValueError("Invalid stores")
        history = self.data.before(origin)
        if history["sales"].empty or history["sales"].date.max() < origin-pd.Timedelta(days=1):
            raise ValueError("Sales must reach day before origin")
        f = AdaptiveBuilder(history).origin(origin, forecast_days)
        f = f.loc[f.store_id.isin(stores)].copy()
        values = self.model.predict(f)
        correction_meta = {}
        if self.model.metadata.get("residual_correction"):
            if residual_bank is None:
                raise ValueError("Residual model requires explicit prequential residual_bank (empty allowed)")
            bank = residual_bank.copy()
            for col in ["as_of_date", "target_date"]:
                bank[col] = pd.to_datetime(bank[col])
            if len(bank) and bank.as_of_date.le(day(self.model.metadata["train_target_max"])).any():
                raise ValueError("Residual bank must be out-of-sample for fitted model")
            corrected = correction_at_origin(f.assign(prediction=values), bank, origin)
            values = np.where(f.is_available.eq(1), np.maximum(values+corrected.correction, 0), 0)
            correction_meta = {"residual_target_max": str(corrected.residual_target_max.max())}
        menus = f[["as_of_date", "target_date", "horizon", "store_id", "menu_id", "is_available"]].copy()
        menus["pred_demand_qty"] = values * demand_multiplier
        menus = menus.merge(estimate_cancellation_rates(history, origin), on=["store_id", "menu_id"], validate="many_to_one")
        menus["pred_net_qty"] = menus.pred_demand_qty * (1-menus.cancel_rate)
        ingredients = to_ingredient_usage(menus, history)
        metadata = dict(status="PROPOSED — NOT TEAM APPROVED", model=self.model.spec.name,
                        as_of_date=str(origin.date()), forecast_days=forecast_days,
                        sales_history_max=str(history["sales"].date.max().date()),
                        demand_multiplier=demand_multiplier, cancel_rate_lookback_days=56,
                        model_provenance=self.model.metadata, **correction_meta,
                        assumptions=["No stockouts", "Known calendar/availability/promotion schedules",
                                     "Historical cancellation rate transfers to fully served demand",
                                     "Scenario multiplier is not a learned causal effect"])
        return ForecastResult(menus.reset_index(drop=True), ingredients, metadata)


def predict_demand(as_of_date, forecast_days=7, store_ids=None, demand_multiplier=1., *, artifact_dir, data_dir=None, residual_bank=None):
    return ExperimentalPredictor.from_artifacts(artifact_dir, data_dir).predict_demand(
        as_of_date, forecast_days, store_ids, demand_multiplier, residual_bank=residual_bank)
