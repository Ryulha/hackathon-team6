import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from pandas.testing import assert_frame_equal

from forecast.data import DataBundle, load_data, build_daily_panel
from forecast.features import FeatureBuilder, FEATURES
from forecast.pipeline import ForecastResult, to_ingredient_usage
from mission02b.features import AdaptiveBuilder, ADAPTIVE, SHARE_FEATURES, STORE_FEATURES, STORE_KEYS
from mission02b.models import ExperimentModel, SPECS, Spec
from mission02b.pipeline import ExperimentalPredictor
from mission02b.evaluation import score, covers, ingredient_metrics, ingredient_rows, validate_cohort, KEYS
from mission02b.correction import prequential, correction_at_origin

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def data():
    return load_data(next(ROOT.glob("*/data/09_sales.csv")).parent)


@pytest.fixture(scope="module")
def builder(data):
    return AdaptiveBuilder(data)


@pytest.fixture(scope="module")
def training(builder):
    return builder.supervised(origin_start="2026-05-01",origin_end="2026-05-04")


def mutate(data, origin):
    tables = {k:v.copy(deep=True) for k,v in data.tables.items()}
    f = tables["sales"]
    f.loc[f.date.ge(origin),["demand_qty","qty","cancel_qty","lost_qty","sales_amount"]] *= 113
    for name in ["inventory","stockouts","waste","lots","receipts","orders","transfers"]:
        tables[name] = tables[name].iloc[:0]
    return DataBundle(tables,data.data_dir)


@pytest.mark.parametrize("origin",["2026-04-01","2026-06-01","2026-07-25"])
def test_all_new_features_ignore_origin_and_future(data,builder,origin):
    a = builder.origin(origin,7)
    b = AdaptiveBuilder(mutate(data,origin)).origin(origin,7)
    assert_frame_equal(a,b,check_exact=True)


def test_original_feature_values_identical(data,builder):
    for origin in ["2026-04-01","2026-06-30"]:
        assert_frame_equal(builder.origin(origin)[FEATURES],FeatureBuilder(data).origin(origin)[FEATURES],check_exact=True)


def test_warmup_and_target_split(builder):
    ds = builder.supervised(origin_end="2026-02-02")
    assert ds.as_of_date.min() == pd.Timestamp("2026-01-29")
    train = ds.loc[ds.target_date.lt("2026-02-01")]
    assert train.target_date.max() == pd.Timestamp("2026-01-31")
    assert train.is_available.eq(1).all()
    assert train.demand_qty.notna().all()
    assert (train.target_date >= train.as_of_date).all()


def test_future_training_labels_do_not_change_matrix(data,builder):
    a = builder.supervised(origin_start="2026-05-25",origin_end="2026-05-31")
    b = AdaptiveBuilder(mutate(data,"2026-06-01")).supervised(origin_start="2026-05-25",origin_end="2026-05-31")
    assert_frame_equal(a.loc[a.target_date.lt("2026-06-01")],b.loc[b.target_date.lt("2026-06-01")],check_exact=True)


def test_zero_rates_denominator_active_days_and_cold_start(data,builder):
    origin = pd.Timestamp("2026-06-01")
    r = builder.origin(origin,1).set_index(["store_id","menu_id"]).loc[("S01","M001")]
    hist = builder.wide.loc[(builder.wide.index < origin) & (builder.wide.index >= origin-pd.Timedelta(days=14)),("S01","M001")]
    assert r.zero_rate_14 == pytest.approx(hist.eq(0).sum()/hist.count())
    launch = builder.origin("2026-04-01",1)
    cold = launch.loc[launch.store_id.eq("S01") & launch.menu_id.eq("M009")].iloc[0]
    assert cold.history_days == 0 and cold.smoothed_share > 0
    # Active missing records become zero, absent availability never becomes zero training data.
    tables = dict(data.tables)
    tables["sales"] = data["sales"].loc[~(data["sales"].date.eq("2026-05-31") & data["sales"].store_id.eq("S01") & data["sales"].menu_id.eq("M001"))]
    changed = AdaptiveBuilder(DataBundle(tables,data.data_dir))
    assert changed.panel.loc[lambda x:x.date.eq("2026-05-31") & x.store_id.eq("S01") & x.menu_id.eq("M001"),"demand_qty"].item() == 0
    assert changed.origin(origin,1).set_index(["store_id","menu_id"]).loc[("S01","M001"),"zero_rate_14"] >= 1/14


@pytest.mark.parametrize("spec",SPECS+[Spec("D1_hurdle",loss="Poisson",kind="hurdle")],ids=lambda s:s.name)
def test_each_model_persistence_future_invariance_scenario_and_availability(data,training,spec,tmp_path):
    model = ExperimentModel.fit(training,spec,iterations=8)
    model.save(tmp_path/"model")
    loaded = ExperimentModel.load(tmp_path/"model")
    first = ExperimentalPredictor(data,model).predict_demand("2026-06-01")
    second = ExperimentalPredictor(data,loaded).predict_demand("2026-06-01")
    changed = ExperimentalPredictor(mutate(data,"2026-06-01"),loaded).predict_demand("2026-06-01")
    assert isinstance(first,ForecastResult)
    assert_frame_equal(first.menus,second.menus,check_exact=True)
    assert_frame_equal(first.menus,changed.menus,check_exact=True)
    assert_frame_equal(first.ingredients,changed.ingredients,check_exact=True)
    assert first.menus.loc[first.menus.is_available.eq(0),"pred_demand_qty"].eq(0).all()
    scenario = ExperimentalPredictor(data,loaded).predict_demand("2026-06-01",store_ids=["S01"],demand_multiplier=1.2)
    np.testing.assert_allclose(scenario.menus.pred_demand_qty,first.menus.loc[first.menus.store_id.eq("S01"),"pred_demand_qty"]*1.2)
    np.testing.assert_allclose(scenario.ingredients.pred_use_qty,first.ingredients.loc[first.ingredients.store_id.eq("S01"),"pred_use_qty"]*1.2)
    assert (first.ingredients.pred_use_qty >= 0).all()


def test_poisson_original_scale_exactly_once(training,builder):
    model = ExperimentModel.fit(training,SPECS[2],iterations=8)
    f = builder.origin("2026-06-01")
    est = model.estimators["direct"]
    raw = est.predict(f[FEATURES],prediction_type="RawFormulaVal")
    expected = np.exp(raw)
    np.testing.assert_allclose(est.predict(f[FEATURES]),expected)
    np.testing.assert_allclose(model.predict(f),np.where(f.is_available.eq(1),expected,0))


def test_hierarchy_conserves_total_and_handles_all_inactive(training,builder):
    model = ExperimentModel.fit(training,SPECS[-1],iterations=8)
    f = builder.origin("2026-06-01")
    p, totals = model.predict(f,return_totals=True)
    sums = f.assign(pred=p).groupby(STORE_KEYS,as_index=False).pred.sum().merge(totals,on=STORE_KEYS)
    np.testing.assert_allclose(sums.pred,sums.pred_total,atol=1e-10)
    f["is_available"] = 0
    f["active_menus"] = 0
    p, totals = model.predict(f,return_totals=True)
    assert (p==0).all() and totals.pred_total.eq(0).all()


def test_provenance_horizon_and_invalid_requests(data,training,builder):
    model = ExperimentModel.fit(training,SPECS[0],iterations=3)
    with pytest.raises(ValueError,match="labels on or after"):
        model.predict(builder.origin(model.metadata["train_target_max"],1))
    f = builder.origin("2026-06-01",1)
    f["horizon"] = 7
    with pytest.raises(ValueError,match="Horizon"):
        model.predict(f)
    predictor = ExperimentalPredictor(data,model)
    for kwargs in [dict(forecast_days=0),dict(forecast_days=8),dict(forecast_days=True),dict(store_ids=[]),dict(store_ids=["S01","S01"]),dict(demand_multiplier=-1),dict(demand_multiplier=np.nan)]:
        with pytest.raises(ValueError):
            predictor.predict_demand("2026-06-01",**kwargs)
    with pytest.raises(ValueError,match="day before"):
        ExperimentalPredictor(data.before("2026-05-25"),model).predict_demand("2026-06-01")


def test_ingredient_identities_units_and_set_once(data,builder):
    f = builder.supervised(origin_start="2026-06-01",origin_end="2026-06-01")
    p = f[KEYS+["demand_qty"]].assign(pred_test=f.demand_qty.to_numpy())
    rows = ingredient_rows(data,p)
    np.testing.assert_allclose(rows.pred_test,rows.rate_adjusted_demand)
    np.testing.assert_allclose(rows.pred_test-rows.no_stockout_proxy,rows.cancel_error,atol=1e-8)
    assert rows.loc[~rows.eligible,"pred_test"].eq(0).all()
    with pytest.raises(ValueError,match="pool units"):
        ingredient_metrics(rows,["store_id"])
    menus = pd.DataFrame(dict(as_of_date=[pd.Timestamp("2026-06-01")],target_date=[pd.Timestamp("2026-06-01")],store_id=["S01"],menu_id=["M004"],pred_net_qty=[2.]))
    converted = to_ingredient_usage(menus,data).set_index("ingredient_id")
    bom = data["bom"].loc[data["bom"].menu_id.eq("M004")].set_index("ingredient_id")
    np.testing.assert_allclose(converted.pred_use_qty,bom.loc[converted.index,"qty_per_menu"]*2)
    assert converted.use_unit.equals(bom.loc[converted.index,"use_unit"])


def test_cover_common_cohort_and_no_cross_origin_updates():
    rows = []
    for o, scale in [("2026-06-01",1),("2026-06-02",10)]:
        for h in range(7):
            rows.append(dict(as_of_date=pd.Timestamp(o),horizon=h,store_id="S",ingredient_id="I",use_unit="g",eligible=True,
                             no_stockout_proxy=scale,consumed_qty=scale,rate_adjusted_demand=scale,latent_demand=scale,pred_m=scale+1))
    f = pd.DataFrame(rows)
    c = covers(f,3)
    assert c.pred_m.tolist()==[6,33] and c.consumed_qty.tolist()==[3,30]
    broken = f.drop(10)
    for n in [1,2,3,7]:
        assert covers(broken,n).as_of_date.tolist()==[pd.Timestamp("2026-06-01")]
        assert covers(pd.concat([f,f.iloc[[0]]]),n).as_of_date.tolist()==[pd.Timestamp("2026-06-02")]


def test_metric_sign_zero_and_under_over():
    m = score([0,10],[3,8])
    assert m["WAPE"]==.5 and m["Bias"]==.1 and m["MAE"]==2.5
    assert m["under_qty"]==2 and m["over_qty"]==3
    assert np.isnan(score([0],[2])["WAPE"])
    with pytest.raises(ValueError):
        score([1],[np.nan])


def test_residual_correction_releases_only_observed_targets():
    rows = []
    for o in pd.date_range("2026-06-01",periods=5):
        for h in range(3):
            rows.append(dict(as_of_date=o,target_date=o+pd.Timedelta(days=h),horizon=h,store_id="S",menu_id="M",demand_qty=8.,pred_base=10.))
    f = pd.DataFrame(rows)
    a = prequential(f,"pred_base")
    assert a.loc[a.as_of_date.eq("2026-06-01"),"correction"].eq(0).all()
    assert (a.loc[a.residual_target_max.notna(),"residual_target_max"] < a.loc[a.residual_target_max.notna(),"as_of_date"]).all()
    changed = f.copy()
    changed.loc[changed.target_date.ge("2026-06-03"),"demand_qty"] = 10000
    b = prequential(changed,"pred_base")
    np.testing.assert_array_equal(a.loc[a.as_of_date.le("2026-06-03"),"corrected_prediction"],b.loc[b.as_of_date.le("2026-06-03"),"corrected_prediction"])
    assert (a.corrected_prediction <= 10).all()


def test_protocol_immutable():
    p = ROOT/"mission02b"
    expected = json.loads((p/"audit/protocol_lock.json").read_text())["sha256"]
    assert hashlib.sha256((p/"PROTOCOL.md").read_bytes()).hexdigest()==expected


def test_cohort_rejects_missing_target(data,builder):
    f = builder.supervised(origin_start="2026-06-01",origin_end="2026-06-01")
    validate_cohort(f,data,"2026-06-01","2026-06-30")
    with pytest.raises(ValueError,match="population mismatch"):
        validate_cohort(f.iloc[1:],data,"2026-06-01","2026-06-30")
