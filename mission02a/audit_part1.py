"""Audit supplied Part 1 snapshot read-only. No order recommendation calls."""
import hashlib
import json

import numpy as np
import pandas as pd

from forecast.data import load_data,build_daily_panel
from mission02a.diagnostics import ROOT,PART1,OUT,load_part1_engine


def main():
    d=load_data(next(ROOT.glob('*/data/09_sales.csv')).parent)
    evidence=ROOT/'mission02a/evidence'
    checks={}
    checks['raw_csv_equal']={p.name:hashlib.sha256(p.read_bytes()).hexdigest()==hashlib.sha256((d.data_dir/p.name).read_bytes()).hexdigest() for p in (PART1/'data').glob('*.csv')}
    results={}
    repro=ROOT/'mission02a/part1_reproduction'
    for p in repro.glob('*.csv'):
        original=PART1/'analysis'/p.name
        a,b=pd.read_csv(p),pd.read_csv(original)
        pd.testing.assert_frame_equal(a,b,check_exact=True)
        results[p.name]={'rows':len(a),'values_exact':True,'bytes_equal':p.read_bytes()==original.read_bytes()}
    checks['part1_reproduction']=results
    m=pd.read_csv(repro/'menu_daily.csv',parse_dates=['date'])
    panel=build_daily_panel(d)
    merged=m.merge(panel,on=['date','store_id','menu_id'],suffixes=('_p1','_m1'),validate='one_to_one')
    checks['menu_rows']=len(merged)
    checks['availability_mismatches']=int(merged.available.ne(merged.is_available).sum())
    active=merged.loc[merged.available]
    checks['active_target_mismatches']=int(active.demand_qty_p1.ne(active.demand_qty_m1).sum())
    checks['active_net_mismatches']=int(active.net_sales_qty.ne(active.net_qty).sum())
    checks['inactive_p1_zero_m1_nan']=int((~merged.available & merged.demand_qty_p1.eq(0) & merged.demand_qty_m1.isna()).sum())
    engine,bundle=load_part1_engine(d.data_dir)
    records=[]
    for origin in ['2026-07-01','2026-08-01','2026-09-24']:
        day=pd.Timestamp(origin)
        altered=type(bundle)(**vars(bundle))
        altered.daily=bundle.daily.copy()
        altered.daily.loc[altered.daily.date.ge(day),'y']*=37
        for store in d['stores'].store_id:
            for promo_on in [False,True]:
                a=engine.forecast_menus(bundle,store,day,7,promo_on=promo_on)
                b=engine.forecast_menus(altered,store,day,7,promo_on=promo_on)
                pd.testing.assert_frame_equal(a,b,check_exact=True)
                pd.testing.assert_frame_equal(engine.forecast_ingredients(bundle,a),engine.forecast_ingredients(altered,b),check_exact=True)
                records.append(dict(origin=origin,store_id=store,promo_on=promo_on,invariant=True))
    checks['engine_future_invariance']=records
    saved=json.loads((evidence/'part1_preserved_manifest.json').read_text())
    changed=[p for p,h in saved.items() if hashlib.sha256((PART1/p).read_bytes()).hexdigest()!=h]
    checks['part1_preserved_files']=len(saved);checks['part1_changed_files']=changed
    assert not changed and all(checks['raw_csv_equal'].values())
    assert checks['availability_mismatches']==checks['active_target_mismatches']==checks['active_net_mismatches']==0
    validation=pd.read_csv(repro/'validation_checks.csv')
    checks['part1_checks']=len(validation)
    checks['part1_checks_status']=validation.status.value_counts().to_dict()
    checks['part1_warnings']=validation.loc[validation.status.eq('WARN')].to_dict('records')
    # Independently reconcile Part 1's synthetic target to our fourth target.
    p1=pd.read_csv(repro/'ingredient_daily.csv',parse_dates=['date'])
    ours=pd.read_csv(OUT/'ingredient_prediction_rows.csv',parse_dates=['target_date'])
    ours=ours.loc[ours.horizon.eq(0)]
    both=ours.merge(p1[['date','store_id','ingredient_id','synthetic_need_qty','bom_consumed_qty']],left_on=['target_date','store_id','ingredient_id'],right_on=['date','store_id','ingredient_id'],validate='many_to_one')
    np.testing.assert_allclose(both.part1_synthetic_need,both.synthetic_need_qty,atol=1e-8)
    np.testing.assert_allclose(both.consumed_qty,both.bom_consumed_qty,atol=1e-8)
    checks['truth_reconciliation_rows']=len(both)
    checks['github_head']='UNVERIFIED: supplied local snapshot, no .git or known remote URL'
    (evidence/'part1_audit.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2))
    print(json.dumps({k:v for k,v in checks.items() if k not in ['raw_csv_equal','part1_reproduction','engine_future_invariance']},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
