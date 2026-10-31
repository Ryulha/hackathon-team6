"""Direct horizons: every history feature is frozen strictly before the origin."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .data import DataBundle, build_daily_panel, day

CAT_FEATURES = ["store_id", "menu_id", "category"]
FEATURES = CAT_FEATURES + [
    "horizon", "weekday", "month", "is_weekend", "is_holiday", "day_of_year",
    "mean_7", "mean_14", "mean_28", "weekday_mean_4", "trend", "store_mean_7",
    "store_trend", "promo_period", "promo_target", "is_available", "tenure_days",
    "history_days", "baseline_qty",
]


class FeatureBuilder:
    def __init__(self, data: DataBundle):
        self.data = data
        self.panel = build_daily_panel(data)
        self.wide = self.panel.pivot(index="date", columns=["store_id", "menu_id"], values="demand_qty")
        # min_count avoids converting an entirely unobserved store day into a zero.
        self.store = self.panel.groupby(["date", "store_id"]).demand_qty.sum(min_count=1).unstack("store_id")

    def origin(self, as_of_date, forecast_days: int = 7) -> pd.DataFrame:
        origin = day(as_of_date)
        if isinstance(forecast_days, bool) or not isinstance(forecast_days, int) or forecast_days < 1:
            raise ValueError("forecast_days must be a positive integer")
        dates = pd.date_range(origin, periods=forecast_days)
        if not dates.isin(self.data["calendar"].date).all():
            raise ValueError("Forecast dates outside supplied calendar; extend calendar and availability schedules explicitly")
        targets = self.panel.loc[self.panel.date.isin(dates),
                                 ["date", "store_id", "menu_id", "category", "is_available", "available_since"]].copy()
        targets = targets.rename(columns={"date": "target_date"})
        targets["as_of_date"] = origin
        targets["horizon"] = (targets.target_date - origin).dt.days
        targets["weekday"] = targets.target_date.dt.dayofweek
        targets["month"] = targets.target_date.dt.month
        targets["day_of_year"] = targets.target_date.dt.dayofyear
        targets["is_weekend"] = (targets.weekday >= 5).astype(int)
        targets = targets.merge(self.data["calendar"][["date", "is_holiday"]], left_on="target_date", right_on="date", validate="many_to_one").drop(columns="date")
        targets["tenure_days"] = ((targets.target_date - targets.available_since).dt.days + 1).fillna(0).clip(lower=0)
        hist = self.wide.loc[self.wide.index < origin]
        stats = pd.DataFrame(index=self.wide.columns)
        for n in [7, 14, 28]:
            stats[f"mean_{n}"] = hist.loc[hist.index >= origin - pd.Timedelta(days=n)].mean()
        prev = hist.loc[(hist.index >= origin - pd.Timedelta(days=14)) & (hist.index < origin - pd.Timedelta(days=7))].mean()
        stats["trend"] = (stats.mean_7 - prev) / prev.clip(lower=1)
        stats["history_days"] = hist.count()
        recent = hist.loc[hist.index >= origin - pd.Timedelta(days=28)]
        stats = stats.reset_index()
        targets = targets.merge(stats, on=["store_id", "menu_id"], validate="many_to_one")
        weekday = []
        for w in range(7):
            vals = recent.loc[recent.index.dayofweek == w].mean().rename("weekday_mean_4").reset_index()
            vals["weekday"] = w
            weekday.append(vals)
        targets = targets.merge(pd.concat(weekday), on=["store_id", "menu_id", "weekday"], validate="many_to_one")
        # Explicit cold-start fallback: pair weekday -> pair 28d -> store-category 28d -> store 28d menu average -> 0.
        fallback = stats.merge(self.data["menus"][["menu_id", "category"]], on="menu_id")
        category = fallback.groupby(["store_id", "category"]).mean_28.mean().rename("category_fallback").reset_index()
        targets = targets.merge(category, on=["store_id", "category"], validate="many_to_one")
        store_fallback = fallback.groupby("store_id").mean_28.mean()
        targets["baseline_qty"] = targets.weekday_mean_4.fillna(targets.mean_28).fillna(targets.category_fallback).fillna(targets.store_id.map(store_fallback)).fillna(0)
        store_hist = self.store.loc[self.store.index < origin]
        s7 = store_hist.loc[store_hist.index >= origin - pd.Timedelta(days=7)].mean()
        s28 = store_hist.loc[store_hist.index >= origin - pd.Timedelta(days=28)].mean()
        targets["store_mean_7"] = targets.store_id.map(s7)
        targets["store_trend"] = targets.store_id.map((s7 - s28) / s28.clip(lower=1))
        targets["promo_period"] = 0
        targets["promo_target"] = 0
        for row in self.data["promotions"].itertuples():
            mask = targets.store_id.eq(row.store_id) & targets.target_date.between(row.start_date, row.end_date)
            targets.loc[mask, "promo_period"] = 1
            targets.loc[mask & targets.menu_id.isin(str(row.target_menu).split(",")), "promo_target"] = 1
        targets["is_available"] = targets.is_available.astype(int)
        targets.loc[targets.is_available.eq(0), "baseline_qty"] = 0
        targets[FEATURES[3:]] = targets[FEATURES[3:]].fillna(0)
        return targets.drop(columns=["available_since", "category_fallback"]).sort_values(["target_date", "store_id", "menu_id"]).reset_index(drop=True)

    def supervised(self, origin_start=None, origin_end=None, max_horizon=7, warmup_days=28):
        first = self.wide.index.min() + pd.Timedelta(days=warmup_days)
        start = max(first, day(origin_start)) if origin_start else first
        end = min(self.wide.index.max(), day(origin_end)) if origin_end else self.wide.index.max()
        frames = []
        for origin in pd.date_range(start, end):
            days = min(max_horizon, (self.wide.index.max() - origin).days + 1)
            frames.append(self.origin(origin, days))
        if not frames:
            raise ValueError("Insufficient history for supervised learning")
        result = pd.concat(frames, ignore_index=True)
        truth = self.panel[["date", "store_id", "menu_id", "demand_qty"]].rename(columns={"date": "target_date"})
        result = result.merge(truth, on=["target_date", "store_id", "menu_id"], validate="many_to_one")
        return result.loc[result.is_available.eq(1) & result.demand_qty.notna()].reset_index(drop=True)
