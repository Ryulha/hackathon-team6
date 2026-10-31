"""Matched prediction cohorts and ingredient-specific, unit-safe metrics."""
from pathlib import Path
import numpy as np
import pandas as pd

from forecast.data import build_daily_panel
from forecast.pipeline import estimate_cancellation_rates

KEYS = ["as_of_date", "target_date", "horizon", "store_id", "menu_id"]
IKEY = ["as_of_date", "target_date", "horizon", "store_id", "ingredient_id", "use_unit"]
TRUTHS = ["no_stockout_proxy", "consumed_qty", "rate_adjusted_demand", "latent_demand"]


def score(y, p):
    y, p = np.asarray(y, float), np.asarray(p, float)
    if y.shape != p.shape or not np.isfinite(y).all() or not np.isfinite(p).all():
        raise ValueError("Unaligned/nonfinite targets")
    e = p - y
    den = np.abs(y).sum()
    return dict(n=len(y), actual_sum=float(y.sum()), predicted_sum=float(p.sum()),
                MAE=float(np.abs(e).mean()) if len(e) else np.nan,
                WAPE=float(np.abs(e).sum()/den) if den else np.nan,
                Bias=float(e.sum()/den) if den else np.nan,
                under_qty=float(np.maximum(-e, 0).sum()), over_qty=float(np.maximum(e, 0).sum()),
                zero_rows=int((y == 0).sum()))


def validate_cohort(frame, data, start, end):
    if frame.duplicated(KEYS).any() or not frame.as_of_date.ge(start).all() or not frame.target_date.between(start, end).all():
        raise ValueError("Duplicate or out-of-split keys")
    if not ((frame.target_date - frame.as_of_date).dt.days == frame.horizon).all():
        raise ValueError("Horizon mismatch")
    panel = build_daily_panel(data)
    dates = frame[["as_of_date", "target_date", "horizon"]].drop_duplicates()
    expected = dates.merge(panel.loc[panel.is_available, ["date", "store_id", "menu_id"]],
                           left_on="target_date", right_on="date")
    if not pd.MultiIndex.from_frame(frame[KEYS]).sort_values().equals(pd.MultiIndex.from_frame(expected[KEYS]).sort_values()):
        raise ValueError("Active target population mismatch")


def menu_metrics(frame, train_history):
    f = frame.copy()
    history = train_history.loc[train_history.is_available]
    band = history.groupby(["store_id", "menu_id"]).demand_qty.mean().rename("historical_mean").reset_index()
    f = f.merge(band, on=["store_id", "menu_id"], how="left", validate="many_to_one")
    f["size_band"] = np.select([f.historical_mean.isna(), f.historical_mean.lt(5), f.historical_mean.lt(20)],
                               ["cold", "low", "medium"], default="high")
    f["target_month"] = f.target_date.dt.strftime("%Y-%m")
    f["store_menu"] = f.store_id + "/" + f.menu_id
    rows = []
    for dim in ["overall", "store_id", "menu_id", "store_menu", "horizon", "size_band", "target_month"]:
        groups = [("all", f)] if dim == "overall" else f.groupby(dim)
        for label, group in groups:
            for col in [c for c in f if c.startswith("pred_")]:
                rows.append(dict(model=col[5:], dimension=dim, group=str(label), **score(group.demand_qty, group[col])))
    return pd.DataFrame(rows)


def ingredient_rows(data, menus):
    models = [c for c in menus if c.startswith("pred_")]
    panel = build_daily_panel(data)
    rates = pd.concat([estimate_cancellation_rates(data.before(o), o).assign(as_of_date=o)
                       for o in sorted(menus.as_of_date.unique())], ignore_index=True)
    f = menus.merge(rates, on=["as_of_date", "store_id", "menu_id"], validate="many_to_one")
    truth = panel[["date", "store_id", "menu_id", "net_qty", "qty", "cancel_qty", "lost_qty"]].rename(columns={"date": "target_date"})
    f = f.merge(truth, on=["target_date", "store_id", "menu_id"], validate="many_to_one")
    f["latent_demand"] = f.demand_qty
    f["rate_adjusted_demand"] = f.demand_qty * (1-f.cancel_rate)
    f["lost_recovery"] = f.lost_qty * (1-f.cancel_rate)
    f["no_stockout_proxy"] = f.net_qty + f.lost_recovery
    f["consumed_qty"] = f.net_qty
    f["cancel_error"] = f.cancel_qty - f.qty * f.cancel_rate
    for m in models:
        f["raw_" + m] = f[m]
        f[m] *= 1-f.cancel_rate
        f["demand_error_" + m] = f[m] - f.rate_adjusted_demand
    f = f.merge(data["bom"], on="menu_id", validate="many_to_many")
    units = data["bom"].merge(data["ingredients"][["ingredient_id", "use_unit"]], on="ingredient_id", suffixes=("", "_master"))
    if not units.use_unit.eq(units.use_unit_master).all():
        raise ValueError("BOM unit mismatch")
    nums = TRUTHS + ["lost_recovery", "cancel_error"] + models + ["raw_"+m for m in models] + ["demand_error_"+m for m in models]
    f[nums] = f[nums].mul(f.qty_per_menu, axis=0)
    amounts = f.groupby(IKEY, as_index=False)[nums].sum()
    counts = f.groupby(IKEY).size().rename("active_bom_rows").reset_index()
    grid = menus[["as_of_date", "target_date", "horizon"]].drop_duplicates().merge(
        data["stores"][["store_id"]], how="cross").merge(
        data["ingredients"][["ingredient_id", "use_unit"]], how="cross")
    grid = grid.merge(amounts, on=IKEY, how="left", validate="one_to_one").merge(counts, on=IKEY, how="left", validate="one_to_one")
    grid[nums+["active_bom_rows"]] = grid[nums+["active_bom_rows"]].fillna(0)
    grid["eligible"] = grid.active_bom_rows.gt(0)
    inventory = data["inventory"][["date", "store_id", "ingredient_id", "use_unit", "consumed_qty"]].rename(columns={"date": "target_date", "consumed_qty": "observed_inventory"})
    check = grid.merge(inventory, on=["target_date", "store_id", "ingredient_id", "use_unit"], validate="many_to_one")
    np.testing.assert_allclose(check.consumed_qty, check.observed_inventory, atol=1e-8)
    for m in models:
        np.testing.assert_allclose(grid[m]-grid.no_stockout_proxy, grid["demand_error_"+m]+grid.cancel_error, atol=1e-8)
        np.testing.assert_allclose(grid[m]-grid.consumed_qty, grid["demand_error_"+m]+grid.cancel_error+grid.lost_recovery, atol=1e-8)
    return grid.sort_values(IKEY).reset_index(drop=True)


def covers(daily, days):
    if days not in [1, 2, 3, 7]:
        raise ValueError("Unsupported cover")
    keys = ["as_of_date", "store_id", "ingredient_id", "use_unit"]
    complete = daily.groupby(keys).horizon.agg(["size", "nunique", "min", "max"])
    complete = complete.loc[complete["size"].eq(7) & complete["nunique"].eq(7) & complete["min"].eq(0) & complete["max"].eq(6)].reset_index()[keys]
    f = daily.merge(complete, on=keys, validate="many_to_one").loc[lambda x: x.horizon.lt(days)]
    nums = [c for c in daily if c in TRUTHS+["lost_recovery", "cancel_error"] or c.startswith(("pred_", "raw_pred_", "demand_error_pred_"))]
    result = f.groupby(keys, as_index=False)[nums].sum()
    elig = f.groupby(keys, as_index=False).eligible.any()
    return result.merge(elig, on=keys, validate="one_to_one").assign(cover_days=days)


def ingredient_metrics(frame, dims):
    if not {"ingredient_id", "use_unit"}.issubset(dims):
        raise ValueError("Cannot pool units across ingredients")
    rows = []
    for labels, g in frame.groupby(dims, dropna=False):
        labels = labels if isinstance(labels, tuple) else (labels,)
        active = g.loc[g.eligible]
        for truth in TRUTHS:
            for col in [c for c in frame if c.startswith("pred_")]:
                pcol = "raw_"+col if truth == "latent_demand" else col
                rows.append(dict(zip(dims, labels), truth=truth, model=col[5:], excluded=len(g)-len(active), **score(active[truth], active[pcol])))
    return pd.DataFrame(rows)


def summarize(data, predictions, start, end, directory):
    path = Path(directory)
    path.mkdir(parents=True, exist_ok=True)
    validate_cohort(predictions, data, start, end)
    panel = build_daily_panel(data)
    mm = menu_metrics(predictions, panel.loc[panel.date.lt(start)])
    daily = ingredient_rows(data, predictions)
    im = ingredient_metrics(daily.loc[daily.horizon.eq(0)], ["store_id", "ingredient_id", "use_unit"])
    pooled = ingredient_metrics(daily.loc[daily.horizon.eq(0)], ["ingredient_id", "use_unit"])
    cover = pd.concat([covers(daily, n) for n in [1, 2, 3, 7]], ignore_index=True)
    cm = ingredient_metrics(cover, ["cover_days", "store_id", "ingredient_id", "use_unit"])
    cp = ingredient_metrics(cover, ["cover_days", "ingredient_id", "use_unit"])
    macro = im.groupby(["truth", "model"], as_index=False).agg(macro_WAPE=("WAPE", "mean"), defined_series=("WAPE", "count"))
    cover_macro = cm.groupby(["cover_days", "truth", "model"], as_index=False).agg(macro_WAPE=("WAPE", "mean"), defined_series=("WAPE", "count"))
    components = []
    for labels, g in daily.loc[daily.horizon.eq(0) & daily.eligible].groupby(["store_id", "ingredient_id", "use_unit"]):
        for m in [c for c in g if c.startswith("pred_")]:
            components.append(dict(zip(["store_id", "ingredient_id", "use_unit"], labels), model=m[5:],
                demand_component_MAE=float(g["demand_error_"+m].abs().mean()),
                cancellation_component_MAE=float(g.cancel_error.abs().mean()),
                proxy_MAE=float((g[m]-g.no_stockout_proxy).abs().mean()),
                demand_signed=float(g["demand_error_"+m].sum()), cancellation_signed=float(g.cancel_error.sum()),
                lost_recovery=float(g.lost_recovery.sum())))
    tables = dict(menu_metrics=mm, daily_series_metrics=im, daily_ingredient_metrics=pooled,
                  daily_macro=macro, coverage_series_metrics=cm, coverage_ingredient_metrics=cp,
                  coverage_macro=cover_macro, error_components=pd.DataFrame(components))
    for name, f in tables.items():
        f.to_csv(path / f"{name}.csv", index=False)
    predictions.to_csv(path / "menu_predictions.csv.gz", index=False, date_format="%Y-%m-%d")
    daily.to_csv(path / "ingredient_predictions.csv.gz", index=False, date_format="%Y-%m-%d")
    cover.to_csv(path / "coverage_predictions.csv.gz", index=False, date_format="%Y-%m-%d")
    return tables
