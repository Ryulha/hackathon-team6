"""Origin-frozen adaptive features; original Mission 01 features remain unchanged."""
import numpy as np
import pandas as pd

from forecast.features import FeatureBuilder, FEATURES
from forecast.data import day

ADAPTIVE = ["ewma_7", "ewma_28", "ratio_7_28", "share_7", "share_28",
            "share_change", "weekday_change", "zero_rate_14", "zero_rate_28"]
SHARE_FEATURES = ["store_id", "menu_id", "category", "horizon", "weekday", "month",
                  "is_weekend", "is_holiday", "promo_period", "promo_target",
                  "tenure_days", "history_days", "share_7", "share_28",
                  "share_change", "smoothed_share", "weekday_share", "zero_rate_28"]
STORE_KEYS = ["as_of_date", "target_date", "horizon", "store_id"]
STORE_FEATURES = ["store_id", "horizon", "weekday", "month", "is_weekend",
                  "is_holiday", "day_of_year", "store_mean_7", "store_trend",
                  "total_mean_28", "total_weekday", "total_ewma_7",
                  "promo_period", "active_menus"]


def weighted_mean(frame, origin, half_life):
    ages = (origin - frame.index).days.to_numpy() - 1
    weights = pd.Series(np.exp2(-ages / half_life), index=frame.index)
    return frame.mul(weights, axis=0).sum().div(frame.notna().mul(weights, axis=0).sum())


class AdaptiveBuilder(FeatureBuilder):
    def origin(self, as_of_date, forecast_days=7):
        origin = day(as_of_date)
        f = super().origin(origin, forecast_days)
        hist = self.wide.loc[(self.wide.index < origin) &
                             (self.wide.index >= origin - pd.Timedelta(days=56))]
        total = self.store.reindex(hist.index)
        pair_total = pd.DataFrame({pair: total[pair[0]] for pair in hist.columns}, index=hist.index)
        pair_total.columns = hist.columns
        daily_share = hist.div(pair_total.replace(0, np.nan))
        stats = pd.DataFrame(index=hist.columns)
        for half in [7, 28]:
            stats[f"ewma_{half}"] = weighted_mean(hist, origin, half)
        for n in [7, 28]:
            recent = daily_share.loc[daily_share.index >= origin - pd.Timedelta(days=n)]
            stats[f"share_{n}"] = recent.mean()
        for n in [14, 28]:
            recent = hist.loc[hist.index >= origin - pd.Timedelta(days=n)]
            stats[f"zero_rate_{n}"] = recent.eq(0).sum().div(recent.count().replace(0, np.nan))
        # Factorized prior: store category share x pooled within-category menu share.
        long = hist.stack([0, 1], future_stack=True).rename("demand").reset_index()
        long = long.merge(self.data["menus"][["menu_id", "category"]], on="menu_id", validate="many_to_one")
        cat = long.groupby(["store_id", "category"]).demand.sum()
        store_sum = long.groupby("store_id").demand.sum()
        menu_sum = long.groupby("menu_id").demand.sum()
        category_sum = long.groupby("category").demand.sum()
        menu_cat = self.data["menus"].set_index("menu_id").category
        priors = []
        for s, m in hist.columns:
            c = menu_cat[m]
            ncat = int(menu_cat.eq(c).sum())
            store_cat_share = cat.get((s, c), 0) / max(store_sum.get(s, 0), 1)
            within = menu_sum.get(m, 0) / category_sum[c] if category_sum.get(c, 0) > 0 else 1 / ncat
            # New menus have no own demand; use category/menu-count fallback.
            if hist[(s, m)].count() == 0:
                within = 1 / ncat
            priors.append(max(store_cat_share * within, 1e-8))
        prior = pd.Series(priors, index=hist.columns)
        recent = daily_share.loc[daily_share.index >= origin - pd.Timedelta(days=28)]
        stats["smoothed_share"] = (recent.sum() + 7 * prior) / (recent.count() + 7)
        f = f.merge(stats.reset_index(), on=["store_id", "menu_id"], validate="many_to_one")
        weekday_rows = []
        for w in range(7):
            r = hist.loc[(hist.index >= origin - pd.Timedelta(days=28)) & (hist.index.dayofweek == w)]
            s = daily_share.reindex(r.index)
            last = r.iloc[-1] if len(r) else pd.Series(np.nan, index=hist.columns)
            prev = r.iloc[:-1].mean()
            q = pd.DataFrame({"weekday_change": (last - prev) / prev.clip(lower=1),
                              "weekday_share": (s.sum() + 3 * stats.smoothed_share) / (s.count() + 3)})
            weekday_rows.append(q.reset_index().assign(weekday=w))
        f = f.merge(pd.concat(weekday_rows), on=["store_id", "menu_id", "weekday"], validate="many_to_one")
        f["ratio_7_28"] = f.mean_7 / f.mean_28.clip(lower=1)
        f["share_change"] = f.share_7 - f.share_28
        t28 = total.loc[total.index >= origin - pd.Timedelta(days=28)]
        f["total_mean_28"] = f.store_id.map(t28.mean())
        f["total_ewma_7"] = f.store_id.map(weighted_mean(total, origin, 7))
        f["total_weekday"] = [t28.loc[t28.index.dayofweek == w, s].mean()
                               for s, w in zip(f.store_id, f.weekday)]
        f["active_menus"] = f.groupby(STORE_KEYS).is_available.transform("sum")
        extra = list(dict.fromkeys(ADAPTIVE + SHARE_FEATURES[3:] + STORE_FEATURES[1:]))
        f[extra] = f[extra].fillna(0)
        if not np.isfinite(f[FEATURES[3:] + ADAPTIVE].to_numpy()).all():
            raise ValueError("Nonfinite features")
        return f


def store_frame(frame, training=False):
    result = frame.groupby(STORE_KEYS, as_index=False)[
        [c for c in STORE_FEATURES if c not in STORE_KEYS]].first()
    if training:
        truth = frame.groupby(STORE_KEYS, as_index=False).demand_qty.sum()
        result = result.merge(truth, on=STORE_KEYS, validate="one_to_one")
    return result
