"""Read frozen Mission 01 predictions, evaluate ingredient usage, never fit models.

All quantities are grouped by ingredient and use_unit. Overall summaries average
dimensionless series WAPEs; they never sum quantities across ingredients.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd

from forecast.data import build_daily_panel, load_data
from forecast.pipeline import estimate_cancellation_rates

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'mission02a/outputs'
KEY = ['split', 'as_of_date', 'target_date', 'horizon', 'store_id', 'ingredient_id', 'use_unit']
PART1=Path('/Users/hyewon/Downloads/hackathon-team6-main')
MODELS = ['baseline', 'catboost', 'part1_engine']
TRUTHS = ['consumed_qty', 'no_stockout_proxy', 'rate_adjusted_demand', 'part1_synthetic_need']


def load_part1_engine(data_dir):
    # Read-only import: never create __pycache__ in the other contributor's folder.
    old=sys.dont_write_bytecode
    sys.dont_write_bytecode=True
    try:
        spec=importlib.util.spec_from_file_location('mission02a_reference_engine',PART1/'engine.py')
        module=importlib.util.module_from_spec(spec)
        sys.modules[spec.name]=module
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode=old
    module.DATA=data_dir
    return module,module.load()


def engine_predictions(data,backtest):
    engine,bundle=load_part1_engine(data.data_dir)
    frames=[]
    for origin,g in backtest.groupby('as_of_date'):
        for store in data['stores'].store_id:
            f=engine.forecast_menus(bundle,store,origin,int(g.horizon.max())+1,demand_adj=0.0,promo_on=False)
            frames.append(f.rename(columns={'date':'target_date','f':'pred_part1_engine'}).assign(as_of_date=origin,store_id=store))
    return pd.concat(frames,ignore_index=True)


def score(y, p):
    y, p = np.asarray(y, float), np.asarray(p, float)
    if len(y) != len(p) or not np.isfinite(y).all() or not np.isfinite(p).all():
        raise ValueError('Metrics need aligned finite values')
    e = p - y
    den = np.abs(y).sum()
    return dict(n=len(y), actual_sum=float(y.sum()), predicted_sum=float(p.sum()),
                MAE=float(np.abs(e).mean()) if len(e) else np.nan,
                mean_error=float(e.mean()) if len(e) else np.nan,
                Bias=float(e.sum()/den) if den else np.nan,
                WAPE=float(np.abs(e).sum()/den) if den else np.nan,
                zero_actual_days=int((y == 0).sum()),
                underprediction_rate=float((e < 0).mean()) if len(e) else np.nan)


def metrics_table(frame, dims, eligibility='eligible'):
    # Every requested grain retains ingredient identity and unit, including NA rows.
    if not {'ingredient_id', 'use_unit'}.issubset(dims):
        raise ValueError('Do not aggregate raw units across ingredients')
    rows = []
    for labels, group in frame.groupby(dims, dropna=False, sort=True):
        labels = labels if isinstance(labels, tuple) else (labels,)
        active = group.loc[group[eligibility]]
        for truth in TRUTHS:
            for model in MODELS:
                rows.append(dict(zip(dims, labels), truth=truth, model=model,
                                 total_grid_rows=len(group), excluded_unavailable=len(group)-len(active),
                                 **score(active[truth], active[f'pred_{model}'])))
    return pd.DataFrame(rows)


def validate_menu_keys(backtest, panel):
    keys = ['as_of_date', 'target_date', 'store_id', 'menu_id']
    if backtest.duplicated(keys).any():
        raise ValueError('Duplicate forecast keys')
    if not ((backtest.target_date-backtest.as_of_date).dt.days == backtest.horizon).all():
        raise ValueError('Origin/target/horizon mismatch')
    if not np.isfinite(backtest[['pred_baseline','pred_catboost']]).all().all():
        raise ValueError('Candidate has missing/nonfinite predictions')
    for split, start, end in [('validation','2026-07-01','2026-07-31'), ('test','2026-08-01','2026-09-30')]:
        b=backtest.loc[backtest.split.eq(split)]
        if not (b.as_of_date.ge(start) & b.target_date.between(start,end)).all():
            raise ValueError('Target-date split violation')
    targets=backtest[['split','as_of_date','target_date','horizon']].drop_duplicates()
    expected=targets.merge(panel.loc[panel.is_available,['date','store_id','menu_id']],left_on='target_date',right_on='date')
    left=pd.MultiIndex.from_frame(backtest[keys]).sort_values()
    right=pd.MultiIndex.from_frame(expected[keys]).sort_values()
    if not left.equals(right):
        raise ValueError('Forecast population differs from active menu calendar')


def build_ingredient_rows(data, backtest):
    panel=build_daily_panel(data)
    validate_menu_keys(backtest,panel)
    rates=[]
    for origin in sorted(backtest.as_of_date.unique()):
        rates.append(estimate_cancellation_rates(data.before(origin),origin).assign(as_of_date=origin))
    rates=pd.concat(rates,ignore_index=True)
    menus=backtest.merge(rates,on=['as_of_date','store_id','menu_id'],validate='many_to_one')
    reference=engine_predictions(data,backtest)
    active_ref=reference.merge(panel[['date','store_id','menu_id','is_available']],left_on=['target_date','store_id','menu_id'],right_on=['date','store_id','menu_id'],validate='many_to_one')
    if active_ref.loc[~active_ref.is_available,'pred_part1_engine'].ne(0).any():
        raise ValueError('Reference engine predicts unavailable menu demand')
    if not np.isfinite(reference.pred_part1_engine).all() or reference.pred_part1_engine.lt(0).any():
        raise ValueError('Invalid reference engine forecast')
    menus=menus.merge(reference,on=['as_of_date','target_date','store_id','menu_id'],how='left',validate='one_to_one')
    if menus.pred_part1_engine.isna().any():raise ValueError('Reference engine population mismatch')
    truth=panel[['date','store_id','menu_id','qty','cancel_qty','lost_qty','net_qty']].rename(columns={'date':'target_date'})
    menus=menus.merge(truth,on=['target_date','store_id','menu_id'],validate='many_to_one')
    menus['rate_adjusted_demand']=menus.demand_qty*(1-menus.cancel_rate)
    menus['no_stockout_proxy']=menus.net_qty+menus.lost_qty*(1-menus.cancel_rate)
    menus['part1_synthetic_need']=menus.net_qty+menus.lost_qty
    for model in MODELS:
        if model!='part1_engine':menus[f'pred_{model}']*=1-menus.cancel_rate
        menus[f'demand_error_{model}']=menus[f'pred_{model}']-menus.rate_adjusted_demand
    menus['cancel_error']=menus.cancel_qty-menus.qty*menus.cancel_rate
    menus['lost_recovery']=menus.lost_qty*(1-menus.cancel_rate)
    contrib=menus.merge(data['bom'],on='menu_id',validate='many_to_many')
    amount_cols=['rate_adjusted_demand','no_stockout_proxy','part1_synthetic_need','net_qty','cancel_error','lost_recovery']
    amount_cols += [f'{prefix}_{m}' for m in MODELS for prefix in ['pred','demand_error']]
    for col in amount_cols:
        contrib[col]*=contrib.qty_per_menu
    grouped=contrib.groupby(KEY,as_index=False)[amount_cols].sum()
    counts=contrib.groupby(KEY).menu_id.nunique().rename('active_bom_menus').reset_index()
    dates=backtest[['split','as_of_date','target_date','horizon']].drop_duplicates()
    grid=dates.merge(data['stores'][['store_id']],how='cross').merge(data['ingredients'][['ingredient_id','use_unit']],how='cross')
    grid=grid.merge(grouped,on=KEY,how='left',validate='one_to_one').merge(counts,on=KEY,how='left',validate='one_to_one')
    grid[amount_cols+['active_bom_menus']]=grid[amount_cols+['active_bom_menus']].fillna(0)
    grid['eligible']=grid.active_bom_menus.gt(0)
    inv=data['inventory'][['date','store_id','ingredient_id','use_unit','consumed_qty','stockout_flag']].rename(columns={'date':'target_date'})
    grid=grid.merge(inv,on=['target_date','store_id','ingredient_id','use_unit'],how='left',validate='many_to_one')
    if grid.consumed_qty.isna().any() or not np.allclose(grid.net_qty,grid.consumed_qty,atol=1e-10):
        raise ValueError('Observed consumption does not reconcile to net menu BOM')
    if (grid.loc[~grid.eligible,amount_cols+['consumed_qty']] != 0).any().any():
        raise ValueError('Unavailable ingredient has nonzero target/prediction')
    for m in MODELS:
        np.testing.assert_allclose(grid[f'pred_{m}']-grid.no_stockout_proxy,
                                   grid[f'demand_error_{m}']+grid.cancel_error,atol=1e-8)
    return grid.sort_values(KEY).reset_index(drop=True), contrib, rates


def coverage_rows(daily, days, common_seven=True):
    if days not in [1,2,3,7]:
        raise ValueError('Unsupported cover days')
    # Check complete contiguous targets at the SAME origin, including inactive zeros.
    origin_keys=['split','as_of_date','store_id','ingredient_id','use_unit']
    require=7 if common_seven else days
    selected=daily.loc[daily.horizon.lt(require)]
    complete=selected.groupby(origin_keys).horizon.agg(['count','nunique','min','max'])
    complete=complete.loc[complete['count'].eq(require) & complete['nunique'].eq(require) & complete['min'].eq(0) & complete['max'].eq(require-1)].reset_index()[origin_keys]
    frame=daily.merge(complete,on=origin_keys,how='inner',validate='many_to_one')
    frame=frame.loc[frame.horizon.lt(days)]
    numeric=TRUTHS+[f'pred_{m}' for m in MODELS]+['lost_recovery','cancel_error']+[f'demand_error_{m}' for m in MODELS]
    result=frame.groupby(origin_keys,as_index=False)[numeric].sum()
    extent=frame.groupby(origin_keys,as_index=False).agg(eligible=('eligible','any'),active_days=('eligible','sum'),target_start=('target_date','min'),target_end=('target_date','max'),n_days=('horizon','nunique'))
    result=result.merge(extent,on=origin_keys,validate='one_to_one')
    if not (result.n_days.eq(days) & result.target_start.eq(result.as_of_date) & result.target_end.eq(result.as_of_date+pd.to_timedelta(days-1,unit='D'))).all():
        raise ValueError('Incomplete or shifted cover window')
    result['cover_days']=days
    result['origin_cohort']='common_7day_origins' if common_seven else 'all_complete_origins'
    return result


def macro_scores(scores, dims):
    # Equal-weight store x ingredient series; denominator-zero rows stay NA.
    return scores.groupby(dims,dropna=False,as_index=False).agg(
        macro_WAPE=('WAPE','mean'),macro_Bias=('Bias','mean'),
        defined_series=('WAPE','count'),total_series=('WAPE','size'))


def operations_audit(data):
    inv=data['inventory'];waste=data['waste'];sales=data['sales']
    expiry=waste.loc[waste.reason.eq('소비기한 경과')]
    summary={'inventory_rows':len(inv),'waste_cost':int(waste.waste_cost.sum()),
             'expiry_cost':int(expiry.waste_cost.sum()),'lost_menu_qty':int(sales.lost_qty.sum()),
             'expiry_share':float(expiry.waste_cost.sum()/waste.waste_cost.sum()),
             'stockout_item_days':int(inv.stockout_flag.sum()),
             'part1_pipeline':'VERIFIED: supplied local pipeline.py read and independently rerun',
             'github_head':'UNVERIFIED: local extracted snapshot has no .git or repository URL',
             'part1_117_checks':'See evidence/part1_pipeline.log and part1_reproduction/validation_checks.csv'}
    costs=expiry.groupby('ingredient_id',as_index=False).agg(expiry_cost=('waste_cost','sum'),expiry_events=('waste_cost','size'))
    avg=inv.groupby(['store_id','ingredient_id','use_unit'],as_index=False).agg(mean_consumed_273d=('consumed_qty','mean'),days=('date','size'))
    context=avg.merge(data['ingredients'].drop(columns='use_unit'),on='ingredient_id',validate='many_to_one')
    context=context.merge(data['suppliers'].drop(columns='note'),on='supplier_id',validate='many_to_one')
    event=expiry.groupby(['store_id','ingredient_id'],as_index=False).agg(expiry_cost=('waste_cost','sum'),expiry_events=('waste_cost','size'))
    context=context.merge(event,on=['store_id','ingredient_id'],how='left').fillna({'expiry_cost':0,'expiry_events':0})
    context['pack_days_posthoc']=context.use_qty_per_order_unit/context.mean_consumed_273d.replace(0,np.nan)
    context['shelf_le_7d']=context.shelf_life_days.le(7)
    context['pack_gt_one_day_posthoc']=context.pack_days_posthoc.gt(1)
    context['pack_gt_shelf_posthoc']=context.pack_days_posthoc.gt(context.shelf_life_days)
    context['supplier_min_amount_constraint']=context.min_order_amount.gt(0)
    context['usage']='POSTHOC EXPLORATORY CONTEXT ONLY; NEVER A BACKTEST FEATURE; NOT AN ORDER QUANTITY'
    assert summary['waste_cost']==2494848 and summary['expiry_cost']==379545 and summary['lost_menu_qty']==74
    for item,expected in [('I009',168326),('I020',71499),('I017',32479)]:
        assert costs.set_index('ingredient_id').loc[item,'expiry_cost']==expected
    return summary,context,costs


def error_diagnostics(data,daily,contrib):
    f=daily.loc[daily.horizon.eq(0)].copy()
    # Past ingredient demand establishes a scale; future actuals define diagnostic strata only.
    panel=build_daily_panel(data)
    joined=panel.loc[panel.is_available].merge(data['bom'],on='menu_id')
    joined['latent_usage']=joined.demand_qty*joined.qty_per_menu
    hist=joined.groupby(['date','store_id','ingredient_id','use_unit'],as_index=False).latent_usage.sum()
    hist=hist.sort_values('date')
    hist['past_28_mean']=hist.groupby(['store_id','ingredient_id']).latent_usage.transform(lambda s:s.shift(1).rolling(28,min_periods=1).mean())
    f=f.merge(hist[['date','store_id','ingredient_id','past_28_mean']],left_on=['target_date','store_id','ingredient_id'],right_on=['date','store_id','ingredient_id'],how='left')
    f['realized_band']=np.select([f.consumed_qty.gt(1.5*f.past_28_mean),f.consumed_qty.lt(.5*f.past_28_mean)],['high_gt_1.5_past_mean','low_lt_0.5_past_mean'],default='middle')
    f['weekday']=f.target_date.dt.dayofweek
    f['month']=f.target_date.dt.strftime('%Y-%m')
    segments={}
    for dim in ['realized_band','weekday','month','stockout_flag']:
        segments[dim]=metrics_table(f,['split','store_id','ingredient_id','use_unit',dim])
    # Error contributions add to signed aggregate error; absolute menu errors do NOT.
    c=contrib.loc[contrib.horizon.eq(0)].copy()
    c['signed_error']=c.pred_catboost-c.no_stockout_proxy
    c['abs_menu_error']=c.signed_error.abs()
    attribution=c.groupby(['split','store_id','ingredient_id','use_unit','menu_id'],as_index=False).agg(
        signed_error=('signed_error','sum'),abs_menu_error=('abs_menu_error','sum'),actual_proxy=('no_stockout_proxy','sum'))
    component=[]
    for keys,g in f.groupby(['split','store_id','ingredient_id','use_unit']):
        g=g.loc[g.eligible]
        if not len(g):continue
        component.append(dict(zip(['split','store_id','ingredient_id','use_unit'],keys),
            demand_component_MAE=float(g.demand_error_catboost.abs().mean()),
            cancellation_component_MAE=float(g.cancel_error.abs().mean()),
            lost_recovery_mean=float(g.lost_recovery.mean()),
            total_proxy_MAE=float((g.pred_catboost-g.no_stockout_proxy).abs().mean()),
            demand_component_signed=float(g.demand_error_catboost.sum()),
            cancellation_component_signed=float(g.cancel_error.sum())))
    pre=hist.loc[hist.date.lt('2026-08-01')]
    distribution=pre.groupby(['store_id','ingredient_id','use_unit'],as_index=False).agg(
        mean=('latent_usage','mean'),std=('latent_usage','std'),active_days=('latent_usage','size'),
        zero_rate=('latent_usage',lambda x:(x==0).mean()))
    distribution['cv']=distribution['std']/distribution['mean'].replace(0,np.nan)
    return f,segments,attribution,pd.DataFrame(component),distribution


def write_csv(frame,name):
    frame.to_csv(OUT/name,index=False,encoding='utf-8-sig',date_format='%Y-%m-%d')


def main():
    OUT.mkdir(exist_ok=True)
    data=load_data(next(ROOT.glob('*/data/09_sales.csv')).parent)
    backtest=pd.read_csv(ROOT/'outputs/evaluation/backtest_predictions.csv',parse_dates=['as_of_date','target_date'])
    daily,contrib,rates=build_ingredient_rows(data,backtest)
    write_csv(daily,'ingredient_prediction_rows.csv')
    write_csv(rates,'origin_cancellation_rates.csv')
    daily_scores=metrics_table(daily.loc[daily.horizon.eq(0)],['split','store_id','ingredient_id','use_unit'])
    write_csv(daily_scores,'daily_store_ingredient_metrics.csv')
    write_csv(metrics_table(daily.loc[daily.horizon.eq(0)],['split','ingredient_id','use_unit']),'daily_ingredient_metrics.csv')
    write_csv(metrics_table(daily,['split','horizon','store_id','ingredient_id','use_unit']),'horizon_metrics.csv')
    write_csv(metrics_table(daily.loc[daily.horizon.eq(0)],['split','target_date','store_id','ingredient_id','use_unit']),'daily_date_metrics.csv')
    write_csv(macro_scores(daily_scores,['split','truth','model','store_id']),'daily_store_macro_metrics.csv')
    write_csv(macro_scores(daily_scores,['split','truth','model']),'daily_macro_metrics.csv')
    covers=pd.concat([coverage_rows(daily,n,common) for common in [True,False] for n in [1,2,3,7]],ignore_index=True)
    write_csv(covers,'coverage_prediction_rows.csv')
    cm=metrics_table(covers,['split','origin_cohort','cover_days','store_id','ingredient_id','use_unit'])
    write_csv(cm,'coverage_store_ingredient_metrics.csv')
    write_csv(metrics_table(covers,['split','origin_cohort','cover_days','ingredient_id','use_unit']),'coverage_ingredient_metrics.csv')
    write_csv(macro_scores(cm,['split','origin_cohort','cover_days','truth','model']),'coverage_macro_metrics.csv')
    write_csv(macro_scores(cm,['split','origin_cohort','cover_days','truth','model','store_id']),'coverage_store_macro_metrics.csv')
    summary,context,costs=operations_audit(data)
    write_csv(context,'operating_constraints.csv');write_csv(costs,'expiry_cost_by_ingredient.csv')
    f,segments,attribution,components,distribution=error_diagnostics(data,daily,contrib)
    for name,frame in segments.items():write_csv(frame,f'error_by_{name}.csv')
    write_csv(f,'daily_diagnostic_rows.csv');write_csv(attribution,'menu_error_attribution.csv')
    write_csv(components,'error_components.csv');write_csv(distribution,'pretest_distribution.csv')
    panel=build_daily_panel(data)
    panel['month']=panel.date.dt.strftime('%Y-%m')
    monthly=panel.loc[panel.is_available].groupby(['month','store_id','menu_id'],as_index=False).agg(
        mean_demand=('demand_qty','mean'),days=('date','size'),zero_rate=('demand_qty',lambda x:(x==0).mean()))
    write_csv(monthly,'menu_monthly_diagnostics.csv')
    selection=json.loads((ROOT/'outputs/evaluation/summary.json').read_text())
    summary.update({'mission01':selection,'ingredient_count':daily.ingredient_id.nunique(),
                    'candidate_key_alignment':'PASS: paired columns, exact active-menu population',
                    'daily_rows':len(daily),'test_daily_grid_rows':len(daily.loc[daily.split.eq('test') & daily.horizon.eq(0)]),
                    'test_unavailable_daily_rows':int((~daily.loc[daily.split.eq('test') & daily.horizon.eq(0),'eligible']).sum()),
                    'test_common_origins':int(covers.loc[covers.split.eq('test') & covers.origin_cohort.eq('common_7day_origins')].as_of_date.nunique()),
                    'validation_common_origins':int(covers.loc[covers.split.eq('validation') & covers.origin_cohort.eq('common_7day_origins')].as_of_date.nunique()),
                    'synthetic_data':True,'new_model_training':False})
    (OUT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print(json.dumps({k:v for k,v in summary.items() if k!='mission01'},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
