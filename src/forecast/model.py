"""CatBoost persistence with temporal provenance and fixed feature schema."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor

from .features import CAT_FEATURES, FEATURES
from .data import day

DEFAULT_PARAMS = dict(iterations=400, depth=6, learning_rate=0.05, l2_leaf_reg=5,
                      loss_function="RMSE", eval_metric="MAE", random_seed=42,
                      thread_count=4, allow_writing_files=False, verbose=False)


class DemandModel:
    def __init__(self, estimator=None, metadata=None):
        self.estimator = estimator
        self.metadata = metadata or {}

    @classmethod
    def fit(cls, train, validation=None, *, iterations=400, max_horizon=7):
        if train.empty or train.demand_qty.isna().any():
            raise ValueError("Training data empty or missing targets")
        params = dict(DEFAULT_PARAMS, iterations=iterations, cat_features=CAT_FEATURES)
        estimator = CatBoostRegressor(**params)
        kwargs = {}
        if validation is not None:
            if validation.empty or train.target_date.max() >= validation.as_of_date.min():
                raise ValueError("Validation origins must follow all training targets")
            kwargs = dict(eval_set=(validation[FEATURES], validation.demand_qty),
                          early_stopping_rounds=50, use_best_model=True)
        estimator.fit(train[FEATURES], train.demand_qty, **kwargs)
        max_label = train.target_date.max()
        if validation is not None:
            max_label = max(max_label, validation.target_date.max())
        metadata = {
            "schema_version": 1, "status": "PROPOSED — NOT TEAM APPROVED",
            "features": FEATURES, "cat_features": CAT_FEATURES,
            "train_target_min": str(train.target_date.min().date()),
            "train_target_max": str(train.target_date.max().date()),
            "selection_target_max": str(max_label.date()), "max_horizon": max_horizon,
            "train_rows": len(train), "iterations": estimator.tree_count_,
            "params": dict(DEFAULT_PARAMS, iterations=iterations),
            "seed": 42, "origin_semantics": "Asia/Seoul start of day, sales date < as_of_date",
        }
        return cls(estimator, metadata)

    def predict(self, features):
        origins = pd.to_datetime(features.as_of_date)
        cutoff = day(self.metadata["selection_target_max"])
        if (origins <= cutoff).any():
            raise ValueError("Model training/selection used labels on or after forecast origin")
        if features.horizon.max() >= self.metadata["max_horizon"]:
            raise ValueError("Requested horizon exceeds fitted direct-horizon range; retrain with larger max_horizon")
        values = np.maximum(self.estimator.predict(features[FEATURES]), 0)
        values = np.where(features.is_available.eq(1), values, 0)
        if not np.isfinite(values).all():
            raise ValueError("Nonfinite model prediction")
        return values

    def save(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        self.estimator.save_model(str(directory / "model.cbm"))
        (directory / "metadata.json").write_text(json.dumps(self.metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    @classmethod
    def load(cls, directory):
        directory = Path(directory)
        metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        if metadata.get("features") != FEATURES or metadata.get("schema_version") != 1:
            raise ValueError("Incompatible model feature schema")
        estimator = CatBoostRegressor()
        estimator.load_model(str(directory / "model.cbm"))
        return cls(estimator, metadata)
