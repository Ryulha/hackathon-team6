"""Fixed-budget loss/feature/weight ablations and coherent hierarchy."""
from dataclasses import dataclass, asdict
from pathlib import Path
import json
import time

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor, CatBoostClassifier

from forecast.data import day
from forecast.features import FEATURES, CAT_FEATURES
from forecast.model import DEFAULT_PARAMS
from .features import ADAPTIVE, SHARE_FEATURES, STORE_FEATURES, STORE_KEYS, store_frame


@dataclass(frozen=True)
class Spec:
    name: str
    loss: str = "RMSE"
    adaptive: bool = False
    half_life: int | None = None
    kind: str = "direct"


SPECS = [Spec("A0_RMSE"), Spec("A1_MAE", "MAE"), Spec("A2_Poisson", "Poisson"),
         Spec("B1_features", adaptive=True), Spec("B2_decay28", half_life=28),
         Spec("B3_decay56", half_life=56), Spec("B4_features_decay28", adaptive=True, half_life=28),
         Spec("B5_features_decay56", adaptive=True, half_life=56),
         Spec("C_hierarchy", kind="hierarchy")]


def make_regressor(loss, features, iterations=400):
    return CatBoostRegressor(**dict(DEFAULT_PARAMS, loss_function=loss, iterations=iterations,
                                   cat_features=[x for x in CAT_FEATURES if x in features]))


def regression_prediction(estimator, frame, features, loss):
    prediction_type = "Exponent" if loss == "Poisson" else "RawFormulaVal"
    return np.maximum(estimator.predict(frame[features], prediction_type=prediction_type), 0)


class ExperimentModel:
    def __init__(self, spec, estimators=None, metadata=None):
        self.spec = spec
        self.estimators = estimators or {}
        self.metadata = metadata or {}

    @property
    def features(self):
        return FEATURES + (ADAPTIVE if self.spec.adaptive else [])

    @classmethod
    def fit(cls, train, spec, *, iterations=400):
        if train.empty or train.demand_qty.isna().any() or not train.is_available.eq(1).all():
            raise ValueError("Training needs nonempty active finite targets")
        if not np.isfinite(train.demand_qty).all() or train.demand_qty.lt(0).any():
            raise ValueError("Invalid demand targets")
        obj = cls(spec)
        start = time.perf_counter()
        if spec.kind == "hierarchy":
            sf = store_frame(train, training=True)
            total = make_regressor("RMSE", STORE_FEATURES, iterations)
            total.fit(sf[STORE_FEATURES], sf.demand_qty)
            denominator = train.groupby(STORE_KEYS).demand_qty.transform("sum")
            share = train.demand_qty.div(denominator.where(denominator > 0)).fillna(0)
            est = make_regressor("RMSE", SHARE_FEATURES, iterations)
            est.fit(train[SHARE_FEATURES], share)
            obj.estimators = {"total": total, "share": est}
        elif spec.kind == "hurdle":
            clf = CatBoostClassifier(iterations=iterations, depth=6, learning_rate=.05,
                                     l2_leaf_reg=5, random_seed=42, thread_count=4,
                                     verbose=False, allow_writing_files=False, cat_features=CAT_FEATURES)
            positive = train.demand_qty.gt(0)
            if positive.nunique() < 2:
                raise ValueError("Hurdle requires both zero and positive outcomes")
            clf.fit(train[obj.features], positive.astype(int))
            est = make_regressor("Poisson", obj.features, iterations)
            est.fit(train.loc[positive, obj.features], train.loc[positive, "demand_qty"])
            obj.estimators = {"occurrence": clf, "positive": est}
        else:
            est = make_regressor(spec.loss, obj.features, iterations)
            weight = None if spec.half_life is None else np.exp2(
                -(train.target_date.max() - train.target_date).dt.days / spec.half_life)
            est.fit(train[obj.features], train.demand_qty, sample_weight=weight)
            obj.estimators = {"direct": est}
        obj.metadata = dict(schema_version=1, status="PROPOSED — NOT TEAM APPROVED",
                            spec=asdict(spec), train_target_min=str(train.target_date.min().date()),
                            train_target_max=str(train.target_date.max().date()),
                            selection_target_max=str(train.target_date.max().date()),
                            train_rows=len(train), iterations=iterations, max_horizon=7,
                            features=obj.features, share_features=SHARE_FEATURES,
                            store_features=STORE_FEATURES, fit_seconds=time.perf_counter() - start,
                            params=dict(DEFAULT_PARAMS, loss_function=spec.loss, iterations=iterations),
                            origin_semantics="Asia/Seoul start of day; sales date < origin")
        return obj

    def predict(self, frame, *, return_totals=False):
        if frame.empty:
            raise ValueError("Empty forecast")
        if (frame.as_of_date <= day(self.metadata["selection_target_max"])).any():
            raise ValueError("Training/selection labels on or after forecast origin")
        if not frame.horizon.between(0, 6).all():
            raise ValueError("Horizon outside fitted range")
        sf = None
        if self.spec.kind == "hierarchy":
            sf = store_frame(frame)
            sf["pred_total"] = regression_prediction(self.estimators["total"], sf, STORE_FEATURES, "RMSE")
            scores = regression_prediction(self.estimators["share"], frame, SHARE_FEATURES, "RMSE")
            work = frame[STORE_KEYS + ["is_available", "smoothed_share"]].copy()
            work["_order"] = np.arange(len(work))
            work["score"] = np.where(work.is_available.eq(1), scores, 0)
            den = work.groupby(STORE_KEYS).score.transform("sum")
            fallback = work.smoothed_share.where(work.is_available.eq(1), 0)
            work.loc[den.eq(0), "score"] = fallback[den.eq(0)]
            den = work.groupby(STORE_KEYS).score.transform("sum")
            work.loc[den.eq(0), "score"] = work.loc[den.eq(0), "is_available"]
            den = work.groupby(STORE_KEYS).score.transform("sum")
            work["normalized"] = work.score.div(den.where(den > 0)).fillna(0)
            work = work.merge(sf[STORE_KEYS + ["pred_total"]], on=STORE_KEYS, validate="many_to_one").sort_values("_order")
            values = (work.normalized * work.pred_total).to_numpy()
            # All-inactive groups have zero forecast total by contract.
            active = frame.groupby(STORE_KEYS, as_index=False).is_available.sum()
            sf = sf.merge(active, on=STORE_KEYS, validate="one_to_one")
            sf.loc[sf.is_available.eq(0), "pred_total"] = 0
            sums = work.assign(prediction=values).groupby(STORE_KEYS, as_index=False).prediction.sum()
            check = sums.merge(sf, on=STORE_KEYS, validate="one_to_one")
            np.testing.assert_allclose(check.prediction, check.pred_total, atol=1e-8)
        elif self.spec.kind == "hurdle":
            prob = self.estimators["occurrence"].predict_proba(frame[self.features])[:, 1]
            values = prob * regression_prediction(self.estimators["positive"], frame, self.features, "Poisson")
        else:
            values = regression_prediction(self.estimators["direct"], frame, self.features, self.spec.loss)
        values = np.where(frame.is_available.eq(1), values, 0)
        if not np.isfinite(values).all():
            raise ValueError("Nonfinite prediction")
        return (values, sf) if return_totals else values

    def save(self, directory):
        p = Path(directory)
        p.mkdir(parents=True, exist_ok=False)
        for key, estimator in self.estimators.items():
            estimator.save_model(str(p / f"{key}.cbm"))
        (p / "metadata.json").write_text(json.dumps(self.metadata, indent=2, ensure_ascii=False))

    @classmethod
    def load(cls, directory):
        p = Path(directory)
        meta = json.loads((p / "metadata.json").read_text())
        obj = cls(Spec(**meta["spec"]), metadata=meta)
        if meta.get("schema_version") != 1 or meta["features"] != obj.features or meta["share_features"] != SHARE_FEATURES or meta["store_features"] != STORE_FEATURES:
            raise ValueError("Incompatible experimental feature schema")
        for path in p.glob("*.cbm"):
            est = CatBoostClassifier() if path.stem == "occurrence" else CatBoostRegressor()
            est.load_model(str(path))
            obj.estimators[path.stem] = est
        return obj
