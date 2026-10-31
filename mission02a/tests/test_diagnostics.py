"""Diagnostic correctness tests independent of Mission 01's unchanged tests."""
import json

import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal
import pytest

from forecast.data import DataBundle,load_data
from forecast.features import FeatureBuilder,FEATURES
from forecast.pipeline import Predictor,estimate_cancellation_rates
from mission02a.diagnostics import ROOT,OUT,TRUTHS,MODELS,score,coverage_rows,metrics_table,build_ingredient_rows
from mission02a.reproduce import check_preserved


@pytest.fixture(scope='module')
def data():return load_data(next(ROOT.glob('*/data/09_sales.csv')).parent)


def tiny():
    rows=[]
    for origin,scale in [('2026-08-01',1),('2026-08-02',10)]:
        for h in range(7):
            r=dict(split='test',as_of_date=pd.Timestamp(origin),target_date=pd.Timestamp(origin)+pd.Timedelta(days=h),horizon=h,store_id='S01',ingredient_id='I001',use_unit='개',eligible=True)
            for t in TRUTHS:r[t]=scale
            for m in MODELS:r[f'pred_{m}']=scale+1;r[f'demand_error_{m}']=1
            r.update(lost_recovery=0,cancel_error=0)
            rows.append(r)
    return pd.DataFrame(rows)


def test_cover_sums_same_origin_without_rolling_updates():
    f=coverage_rows(tiny(),3).sort_values('as_of_date')
    assert f.consumed_qty.tolist()==[3,30]
    assert f.pred_catboost.tolist()==[6,33]
    assert f.n_days.tolist()==[3,3]


def test_common_origin_cohort_and_missing_middle_day():
    x=tiny();x=x.drop(x.loc[x.as_of_date.eq('2026-08-02') & x.horizon.eq(3)].index)
    for n in [1,2,3,7]:
        assert coverage_rows(x,n).as_of_date.tolist()==[pd.Timestamp('2026-08-01')]
    assert len(coverage_rows(x,3,False))==2
    assert len(coverage_rows(x,7,False))==1


def test_duplicate_horizon_not_accepted_as_complete():
    x=tiny();x=pd.concat([x,x.iloc[[0]]],ignore_index=True)
    assert coverage_rows(x,7).as_of_date.tolist()==[pd.Timestamp('2026-08-02')]


def test_metric_denominator_sign_and_active_zero():
    result=score([0,10],[2,8])
    assert result['MAE']==2 and result['Bias']==0 and result['WAPE']==.4
    assert np.isnan(score([0],[2])['WAPE'])
    assert score([0],[2])['MAE']==2
    assert score([],[])['n']==0 and np.isnan(score([],[])['MAE'])


def test_unit_pooling_rejected():
    with pytest.raises(ValueError,match='raw units'):
        metrics_table(tiny(),['store_id'])


def test_unavailable_not_zero_scored():
    x=tiny();x['eligible']=False
    m=metrics_table(x,['store_id','ingredient_id','use_unit'])
    assert m.n.eq(0).all() and m.WAPE.isna().all() and m.excluded_unavailable.eq(14).all()


@pytest.mark.parametrize('origin',['2026-08-01','2026-08-31','2026-09-24'])
def test_frozen_origin_predictions_ignore_future_sales_and_operations(data,origin):
    tables={k:v.copy(deep=True) for k,v in data.tables.items()}
    cols=['demand_qty','qty','cancel_qty','lost_qty','sales_amount']
    tables['sales'].loc[tables['sales'].date.ge(origin),cols]*=19
    for name in ['inventory','lots','waste','stockouts','orders','receipts','transfers']:
        tables[name]=tables[name].iloc[0:0]
    altered=DataBundle(tables,data.data_dir)
    before=FeatureBuilder(data).origin(origin,7)
    after=FeatureBuilder(altered).origin(origin,7)
    assert_frame_equal(before[FEATURES],after[FEATURES],check_exact=True)
    assert_frame_equal(estimate_cancellation_rates(data,origin),estimate_cancellation_rates(altered,origin),check_exact=True)
    p=Predictor.from_artifacts(data.data_dir,ROOT/'models/evaluated')
    old=p.predict_demand(origin,7);p.data=altered;new=p.predict_demand(origin,7)
    assert_frame_equal(old.menus,new.menus,check_exact=True)
    assert_frame_equal(old.ingredients,new.ingredients,check_exact=True)


def test_real_data_full_ingredient_grid_and_truth_decomposition(data):
    b=pd.read_csv(ROOT/'outputs/evaluation/backtest_predictions.csv',parse_dates=['as_of_date','target_date'])
    b=b.loc[b.as_of_date.eq('2026-09-24')]
    f,_,_=build_ingredient_rows(data,b)
    assert len(f)==7*3*22 and f.ingredient_id.nunique()==22
    np.testing.assert_allclose(f.net_qty,f.consumed_qty)
    np.testing.assert_allclose(f.no_stockout_proxy,f.consumed_qty+f.lost_recovery)
    p=Predictor.from_artifacts(data.data_dir,ROOT/'models/evaluated').predict_demand('2026-09-24')
    keys=['as_of_date','target_date','store_id','ingredient_id','use_unit']
    matched=f.merge(p.ingredients,on=keys,validate='one_to_one')
    np.testing.assert_allclose(matched.pred_catboost,matched.pred_use_qty,rtol=1e-12,atol=1e-8)
    # S02 chicken ingredient has no active source menu in Test; preserved as excluded.
    inactive=f.loc[f.store_id.eq('S02') & f.ingredient_id.eq('I004')]
    assert not inactive.eligible.any() and inactive.consumed_qty.eq(0).all()


def test_saved_outputs_keep_all_22_and_identical_candidate_coverage():
    m=pd.read_csv(OUT/'daily_store_ingredient_metrics.csv')
    assert len(m)==2*3*22*len(TRUTHS)*len(MODELS)
    assert m.groupby(['split','truth','model']).size().eq(66).all()
    c=pd.read_csv(OUT/'coverage_prediction_rows.csv',parse_dates=['as_of_date','target_start','target_end'])
    primary=c.loc[c.origin_cohort.eq('common_7day_origins')]
    for split,n in [('validation',25),('test',55)]:
        sets=[set(primary.loc[primary.split.eq(split) & primary.cover_days.eq(h),'as_of_date']) for h in [1,2,3,7]]
        assert all(s==sets[0] for s in sets) and len(sets[0])==n
    assert primary[[f'pred_{m}' for m in MODELS]].notna().all().all()


def test_protected_mission01_and_sources_unchanged():
    assert check_preserved()['pass']


def test_exact_pipeline_reproduction_evidence():
    evidence=json.loads((ROOT/'mission02a/evidence/reproduction_comparison.json').read_text())
    assert len(evidence)==7 and all(v['bytes_equal'] for v in evidence.values())
