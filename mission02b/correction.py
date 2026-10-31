"""Prequential residuals only: a label is released strictly after target day."""
import numpy as np
import pandas as pd


def correction_at_origin(current, bank, origin):
    past = bank.loc[bank.target_date.lt(origin) & bank.target_date.ge(origin-pd.Timedelta(days=28))].copy()
    if len(past) and not past.as_of_date.le(past.target_date).all():
        raise ValueError("Invalid residual forecast timestamps")
    current = current.copy()
    current["correction"] = 0.0
    current["residual_target_max"] = pd.NaT
    if past.empty:
        return current
    past["residual"] = past.demand_qty - past.prediction
    global_mean = past.groupby("horizon").residual.mean()
    pair = past.groupby(["store_id", "menu_id", "horizon"]).residual.agg(["sum", "count"])
    for i, r in current.iterrows():
        key = (r.store_id, r.menu_id, r.horizon)
        mu = global_mean.get(r.horizon, 0)
        if key in pair.index:
            s = pair.loc[key]
            mu = (s["sum"] + 20*mu) / (s["count"]+20)
        bound = .3 * max(r.prediction, 1)
        current.loc[i, "correction"] = np.clip(mu, -bound, bound)
    current["residual_target_max"] = past.target_date.max()
    return current


def prequential(frame, prediction_col):
    source = frame.rename(columns={prediction_col: "prediction"})
    bank = source.iloc[:0].copy()
    results = []
    for origin, current in source.groupby("as_of_date", sort=True):
        corrected = correction_at_origin(current, bank, origin)
        corrected["corrected_prediction"] = np.maximum(corrected.prediction + corrected.correction, 0)
        results.append(corrected)
        # Bank stores BASE forecasts, never corrected forecasts; observations
        # remain unavailable until correction_at_origin releases target < origin.
        bank = pd.concat([bank, current], ignore_index=True)
    return pd.concat(results).sort_index()
