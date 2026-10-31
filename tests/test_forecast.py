import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import pandas as pd
import pytest
from pandas.testing import assert_frame_equal

from forecast import predict_demand
from forecast.adapters import save_forecast
from forecast.data import DataBundle, build_daily_panel, validate_data
from forecast.evaluation import metrics
from forecast.features import FEATURES, FeatureBuilder
from forecast.model import DemandModel
from forecast.pipeline import Predictor, estimate_cancellation_rates, to_ingredient_usage


def changed_future(data, origin="2026-09-24"):
    tables = dict(data.tables)
    sales = data["sales"].copy()
    future = sales.date.ge(origin)
    sales.loc[future, ["demand_qty", "qty", "cancel_qty", "lost_qty", "sales_amount"]] *= 11
    tables["sales"] = sales
    return DataBundle(tables, data.data_dir)


def test_all_17_files_and_sales_identities(data):
    assert len(data.tables) == 17
    sales = data["sales"]
    assert len(sales) == 98910
    assert (sales.qty == sales.demand_qty - sales.lost_qty).all()
    assert (sales.qty - sales.cancel_qty >= 0).all()
    validate_data(data)


def test_corrupt_sales_fail_fast(data):
    tables = copy.deepcopy(data.tables)
    tables["sales"].loc[0, "qty"] += 1
    with pytest.raises(ValueError, match="qty !="):
        validate_data(DataBundle(tables, data.data_dir))


def test_active_missing_day_zero_inactive_day_nan(data):
    tables = dict(data.tables)
    sales = data["sales"]
    remove = sales.date.eq("2026-03-10") & sales.store_id.eq("S01") & sales.menu_id.eq("M001")
    tables["sales"] = sales.loc[~remove]
    panel = build_daily_panel(DataBundle(tables, data.data_dir))
    active = panel.loc[panel.date.eq("2026-03-10") & panel.store_id.eq("S01") & panel.menu_id.eq("M001")].iloc[0]
    assert active.is_available and active.demand_qty == 0
    inactive = panel.loc[panel.date.eq("2026-03-10") & panel.store_id.eq("S01") & panel.menu_id.eq("M009")].iloc[0]
    assert not inactive.is_available and pd.isna(inactive.demand_qty)


def test_inactive_training_excluded_and_launch_is_not_zero_history(builder):
    samples = builder.supervised(origin_start="2026-03-29", origin_end="2026-04-02")
    assert not ((samples.menu_id == "M009") & (samples.target_date < "2026-04-01")).any()
    launch = builder.origin("2026-04-01", 1)
    row = launch.loc[launch.store_id.eq("S01") & launch.menu_id.eq("M009")].iloc[0]
    assert row.is_available == 1 and row.history_days == 0 and row.tenure_days == 1
    assert row.baseline_qty > 0  # documented category fallback
    never_offered = launch.loc[launch.store_id.eq("S02") & launch.menu_id.eq("M015")].iloc[0]
    assert never_offered.is_available == 0 and never_offered.baseline_qty == 0


def test_same_weekday_mean_strictly_before_origin(builder):
    origin = pd.Timestamp("2026-09-24")
    rows = builder.origin(origin, 7)
    row = rows.loc[rows.store_id.eq("S01") & rows.menu_id.eq("M001") & rows.horizon.eq(6)].iloc[0]
    hist = builder.wide.loc[(builder.wide.index < origin) & (builder.wide.index >= origin - pd.Timedelta(days=28))]
    expected = hist.loc[hist.index.dayofweek == row.weekday, ("S01", "M001")].mean()
    assert row.baseline_qty == pytest.approx(expected)


def test_promotion_period_and_target_are_distinct(builder):
    features = builder.origin("2026-07-08", 1).set_index(["store_id", "menu_id"])
    assert features.loc[("S02", "M004"), "promo_target"] == 1
    assert features.loc[("S02", "M001"), "promo_period"] == 1
    assert features.loc[("S02", "M001"), "promo_target"] == 0
    assert features.loc[("S01", "M004"), "promo_period"] == 0


def test_future_sales_cannot_change_features(data, builder):
    changed = FeatureBuilder(changed_future(data)).origin("2026-09-24", 7)
    assert_frame_equal(builder.origin("2026-09-24", 7)[FEATURES], changed[FEATURES])


@pytest.mark.parametrize("name", ["baseline", "catboost"])
def test_future_sales_cannot_change_forecasts_or_ingredients(data, fitted_model, name):
    model, _ = fitted_model
    before = Predictor(data, model, name).predict_demand("2026-09-24")
    after = Predictor(changed_future(data), model, name).predict_demand("2026-09-24")
    assert_frame_equal(before.menus, after.menus, check_exact=True)
    assert_frame_equal(before.ingredients, after.ingredients, check_exact=True)
    assert before.metadata == after.metadata


def test_model_save_load_same_prediction_and_internal_function(data, fitted_model):
    model, directory = fitted_model
    reloaded = DemandModel.load(directory / "catboost")
    first = Predictor(data, model, "catboost").predict_demand("2026-09-24")
    second = Predictor(data, reloaded, "catboost").predict_demand("2026-09-24")
    assert_frame_equal(first.menus, second.menus, check_exact=True)
    third = predict_demand("2026-09-24", data_dir=data.data_dir, artifact_dir=directory)
    assert_frame_equal(first.menus, third.menus, check_exact=True)


def test_saved_provenance_blocks_future_label_model(builder, fitted_model):
    model, _ = fitted_model
    features = builder.origin(model.metadata["train_target_max"], 1)
    with pytest.raises(ValueError, match="labels on or after"):
        model.predict(features)
    contaminated = DemandModel(model.estimator, {**model.metadata, "selection_target_max": "2026-09-24"})
    with pytest.raises(ValueError, match="labels on or after"):
        contaminated.predict(builder.origin("2026-09-24", 7))


def test_baseline_selection_also_respects_origin(data):
    predictor = Predictor(data, selected_model="baseline", selection_metadata={"selection_target_max": "2026-07-31"})
    with pytest.raises(ValueError, match="selection used labels"):
        predictor.predict_demand("2026-07-24")


def test_future_training_records_do_not_change_training_matrix(data, builder):
    # Rebuilding historical training data after altering future answers remains identical.
    start, end = "2026-05-01", "2026-05-02"
    first = builder.supervised(origin_start=start, origin_end=end)
    second = FeatureBuilder(changed_future(data)).supervised(origin_start=start, origin_end=end)
    assert_frame_equal(first, second, check_exact=True)


def test_seven_days_nonnegative_and_store_scenario(data, fitted_model):
    model, _ = fitted_model
    predictor = Predictor(data, model, "catboost")
    result = predictor.predict_demand("2026-09-24")
    assert result.menus.target_date.nunique() == 7
    assert len(result.menus) == 7 * 3 * 16
    assert str(result.menus.target_date.min().date()) == "2026-09-24"
    assert str(result.menus.target_date.max().date()) == "2026-09-30"
    assert np.isfinite(result.menus[["pred_demand_qty", "pred_net_qty"]].to_numpy()).all()
    assert (result.menus.pred_net_qty >= 0).all()
    assert (result.menus.pred_net_qty <= result.menus.pred_demand_qty).all()
    assert np.isfinite(result.ingredients.pred_use_qty).all()
    assert (result.ingredients.pred_use_qty >= 0).all()
    doubled = predictor.predict_demand("2026-09-24", store_ids=["S01"], demand_multiplier=1.2)
    original = result.menus.loc[result.menus.store_id.eq("S01")]
    np.testing.assert_allclose(doubled.menus.pred_net_qty, original.pred_net_qty * 1.2)
    np.testing.assert_allclose(doubled.ingredients.pred_use_qty,
                               result.ingredients.loc[result.ingredients.store_id.eq("S01"), "pred_use_qty"] * 1.2)
    assert predictor.predict_demand("2026-09-24", forecast_days=3).menus.target_date.nunique() == 3


def test_cancellation_denominator_and_origin(data):
    origin = pd.Timestamp("2026-09-24")
    rows = data["sales"].loc[lambda x: x.date.lt(origin) & x.date.ge(origin - pd.Timedelta(days=56)) & x.store_id.eq("S01") & x.menu_id.eq("M001")]
    rates = estimate_cancellation_rates(data, origin)
    value = rates.loc[rates.store_id.eq("S01") & rates.menu_id.eq("M001"), "cancel_rate"].item()
    assert value == pytest.approx(rows.cancel_qty.sum() / rows.qty.sum())
    assert_frame_equal(rates, estimate_cancellation_rates(changed_future(data), origin))


def test_cancel_fallbacks_when_no_accepted_orders(data):
    tables = dict(data.tables)
    sales = data["sales"].copy()
    # Force one pair to no accepted orders, keeping other-store same-menu history.
    mask = sales.store_id.eq("S01") & sales.menu_id.eq("M001")
    sales = sales.loc[~mask]
    tables["sales"] = sales
    origin = pd.Timestamp("2026-09-24")
    available = sales.loc[sales.date.between(origin - pd.Timedelta(days=56), origin - pd.Timedelta(days=1)) & sales.menu_id.eq("M001")]
    rates = estimate_cancellation_rates(DataBundle(tables, data.data_dir), origin)
    actual = rates.loc[rates.store_id.eq("S01") & rates.menu_id.eq("M001"), "cancel_rate"].item()
    assert actual == pytest.approx(available.cancel_qty.sum() / available.qty.sum())
    tables["sales"] = sales.iloc[:0]
    assert estimate_cancellation_rates(DataBundle(tables, data.data_dir), origin).cancel_rate.eq(0).all()


def test_set_bom_once_and_preserve_units(data):
    menus = pd.DataFrame({"as_of_date": [pd.Timestamp("2026-09-24")], "target_date": [pd.Timestamp("2026-09-24")], "store_id": ["S01"], "menu_id": ["M004"], "pred_net_qty": [10.0]})
    result = to_ingredient_usage(menus, data)
    expected = data["bom"].loc[data["bom"].menu_id.eq("M004")].set_index("ingredient_id")
    assert len(result) == len(expected)
    for row in result.itertuples():
        assert row.pred_use_qty == expected.loc[row.ingredient_id, "qty_per_menu"] * 10
        assert row.use_unit == expected.loc[row.ingredient_id, "use_unit"]
    assert result.loc[result.ingredient_id.eq("I018"), "pred_use_qty"].item() == 10
    tables = copy.deepcopy(data.tables)
    tables["bom"].loc[0, "use_unit"] = "wrong"
    with pytest.raises(ValueError, match="use_unit mismatch"):
        to_ingredient_usage(menus, DataBundle(tables, data.data_dir))


@pytest.mark.parametrize("kwargs", [{"forecast_days": 0}, {"forecast_days": 8}, {"store_ids": ["unknown"]}, {"store_ids": []}, {"demand_multiplier": -1}, {"demand_multiplier": np.nan}])
def test_invalid_requests_fail(data, fitted_model, kwargs):
    model, _ = fitted_model
    with pytest.raises(ValueError):
        Predictor(data, model, "catboost").predict_demand("2026-08-01", **kwargs)


def test_outside_calendar_and_stale_history_fail(data):
    predictor = Predictor(data)
    with pytest.raises(ValueError, match="outside supplied calendar"):
        predictor.predict_demand("2026-10-01")
    with pytest.raises(ValueError, match="day before"):
        Predictor(data.before("2026-09-20")).predict_demand("2026-09-24")


def test_csv_adapter_and_no_inference_write(data, tmp_path):
    result = Predictor(data).predict_demand("2026-09-24")
    paths = save_forecast(result, tmp_path)
    saved = pd.read_csv(paths["menu_forecast"])
    assert len(saved) == 336
    np.testing.assert_allclose(saved.pred_net_qty, result.menus.pred_net_qty)
    ingredients = pd.read_csv(paths["ingredient_forecast"])
    assert len(ingredients) == len(result.ingredients)
    assert json.loads(Path(paths["metadata"]).read_text())["status"] == "PROPOSED — NOT TEAM APPROVED"


def test_standalone_cli_prediction(data, fitted_model, tmp_path):
    _, directory = fitted_model
    completed = subprocess.run([sys.executable, "-m", "forecast", "--data-dir", str(data.data_dir), "predict",
                                "--as-of-date", "2026-09-24", "--artifact-dir", str(directory), "--output-dir", str(tmp_path)],
                               capture_output=True, text=True, timeout=60)
    assert completed.returncode == 0, completed.stderr
    assert len(pd.read_csv(tmp_path / "menu_forecast.csv")) == 336


def test_metrics_sign_and_zero_denominator():
    score = metrics([10, 0], [12, 1])
    assert score["MAE"] == 1.5 and score["WAPE"] == .3 and score["Bias"] == .3
    assert metrics([0, 0], [1, 0])["WAPE"] is None


def test_original_manifest_unchanged(data):
    path = Path("outputs/audit/source_manifest.json")
    if not path.exists():
        pytest.skip("Run forecast audit to establish original-file manifest")
    for name, expected in json.loads(path.read_text()).items():
        source = Path(name) if Path(name).is_absolute() else data.data_dir / name
        assert hashlib.sha256(source.read_bytes()).hexdigest() == expected, str(source)


def test_full_evaluation_artifact_has_no_future_dependence(data):
    directory = Path("models/evaluated")
    if not (directory / "selection.json").exists():
        pytest.skip("Run forecast evaluate for full-model integration check")
    predictor = Predictor.from_artifacts(data.data_dir, directory)
    first = predictor.predict_demand("2026-09-24")
    assert predictor.model.metadata["train_target_max"] == "2026-07-31"
    predictor.data = changed_future(data)
    second = predictor.predict_demand("2026-09-24")
    assert_frame_equal(first.menus, second.menus, check_exact=True)
    assert_frame_equal(first.ingredients, second.ingredients, check_exact=True)


def test_standalone_train_respects_target_cutoff(data, tmp_path):
    artifacts = tmp_path / "artifacts"
    result = subprocess.run([sys.executable, "-m", "forecast", "--data-dir", str(data.data_dir), "train",
                             "--as-of-date", "2026-03-01", "--iterations", "8", "--artifact-dir", str(artifacts)],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    model = DemandModel.load(artifacts / "catboost")
    assert model.metadata["train_target_max"] == "2026-02-28"
    assert model.metadata["selection_target_max"] == "2026-02-28"
    result = Predictor.from_artifacts(data.data_dir, artifacts).predict_demand("2026-03-01")
    assert result.menus.target_date.nunique() == 7


def test_reported_evaluation_matches_saved_backtest():
    path = Path("outputs/evaluation/backtest_predictions.csv")
    if not path.exists():
        pytest.skip("Run forecast evaluate for metric consistency check")
    frame = pd.read_csv(path, parse_dates=["as_of_date", "target_date"])
    report = json.loads(Path("outputs/evaluation/summary.json").read_text())
    for split, start, end in [("validation", "2026-07-01", "2026-07-31"), ("test", "2026-08-01", "2026-09-30")]:
        rows = frame.loc[frame.split.eq(split)]
        assert rows.target_date.between(start, end).all() and rows.as_of_date.ge(start).all()
        assert ((rows.target_date - rows.as_of_date).dt.days == rows.horizon).all()
        assert rows.horizon.between(0, 6).all()
        for model in ["baseline", "catboost"]:
            actual = metrics(rows.demand_qty, rows[f"pred_{model}"])
            assert actual["WAPE"] == pytest.approx(report[split][model]["WAPE"])
            assert actual["MAE"] == pytest.approx(report[split][model]["MAE"])
    expected = min(report["validation"], key=lambda k: report["validation"][k]["WAPE"])
    assert report["selected_model"] == expected
