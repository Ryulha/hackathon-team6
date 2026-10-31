"""Independent arithmetic and preservation checks over saved experimental results."""
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
import pandas as pd

from forecast.data import load_data
from .reproduce import preservation

ROOT=Path(__file__).resolve().parents[1]
HOME=ROOT/"mission02b"
OUT=HOME/"runs/main"


def main():
    checks={"preservation":preservation(),"scopes":{}}
    data=load_data(next(ROOT.glob("*/data/09_sales.csv")).parent)
    for scope in ["validation/A","validation/B","holdout"]:
        p=OUT/scope
        menu=pd.read_csv(p/"menu_predictions.csv.gz",parse_dates=["as_of_date","target_date"])
        reported=pd.read_csv(p/"menu_metrics.csv").query("dimension == 'overall'").set_index("model")
        cols=[c for c in menu if c.startswith("pred_")]
        # Independent array arithmetic, no experimental metric helper.
        for col in cols:
            error=menu[col].to_numpy()-menu.demand_qty.to_numpy()
            row=reported.loc[col[5:]]
            np.testing.assert_allclose([np.abs(error).sum()/menu.demand_qty.sum(),np.abs(error).mean(),error.sum()/menu.demand_qty.sum(),np.maximum(-error,0).sum(),np.maximum(error,0).sum()],
                                       [row.WAPE,row.MAE,row.Bias,row.under_qty,row.over_qty],rtol=1e-12)
        daily=pd.read_csv(p/"ingredient_predictions.csv.gz",parse_dates=["as_of_date","target_date"])
        macro=pd.read_csv(p/"daily_macro.csv").query("truth == 'no_stockout_proxy'").set_index("model")
        active=daily.loc[daily.horizon.eq(0) & daily.eligible]
        for col in cols:
            values=[]
            for _,g in active.groupby(["store_id","ingredient_id","use_unit"]):
                den=g.no_stockout_proxy.sum()
                if den:
                    values.append(np.abs(g[col]-g.no_stockout_proxy).sum()/den)
            np.testing.assert_allclose(np.mean(values),macro.loc[col[5:],"macro_WAPE"],rtol=1e-12)
        cover=pd.read_csv(p/"coverage_predictions.csv.gz",parse_dates=["as_of_date"])
        cm=pd.read_csv(p/"coverage_macro.csv").query("truth == 'no_stockout_proxy'").set_index(["model","cover_days"])
        cohort=None
        for n in [1,2,3,7]:
            rows=cover.loc[cover.cover_days.eq(n)]
            origins=set(rows.as_of_date)
            assert cohort is None or cohort==origins
            cohort=origins
            # Independently sum only that origin's first n horizons.
            source=daily.loc[daily.as_of_date.isin(origins) & daily.horizon.lt(n)]
            keys=["as_of_date","store_id","ingredient_id","use_unit"]
            sums=source.groupby(keys)[cols+["no_stockout_proxy"]].sum().sort_index()
            saved=rows.set_index(keys).sort_index()
            np.testing.assert_allclose(sums[cols+["no_stockout_proxy"]],saved[cols+["no_stockout_proxy"]],atol=1e-8)
            for col in cols:
                ratios=[]
                for _,g in rows.loc[rows.eligible].groupby(["store_id","ingredient_id","use_unit"]):
                    den=g.no_stockout_proxy.sum()
                    if den:
                        ratios.append(np.abs(g[col]-g.no_stockout_proxy).sum()/den)
                np.testing.assert_allclose(np.mean(ratios),cm.loc[(col[5:],n),"macro_WAPE"],rtol=1e-12)
        # Independent sampled menu->ingredient BOM multiplication across all
        # source menus on one origin/store; cancellation rate re-derived raw.
        origin=menu.as_of_date.min();store="S01"
        sample=menu.loc[menu.as_of_date.eq(origin) & menu.store_id.eq(store)].copy()
        hist=data["sales"].loc[data["sales"].date.lt(origin) & data["sales"].date.ge(origin-pd.Timedelta(days=56))]
        hist=hist.loc[hist.store_id.eq(store)].groupby("menu_id")[["qty","cancel_qty"]].sum()
        for row in sample.itertuples():
            assert hist.loc[row.menu_id,"qty"]>0
        sample["rate"]=sample.menu_id.map(hist.cancel_qty/hist.qty)
        joined=sample.merge(data["bom"],on="menu_id")
        for col in cols:
            joined["amount"]=joined[col]*(1-joined.rate)*joined.qty_per_menu
            independent=joined.groupby(["target_date","ingredient_id","use_unit"]).amount.sum()
            target=daily.loc[daily.as_of_date.eq(origin) & daily.store_id.eq(store)].set_index(["target_date","ingredient_id","use_unit"])
            np.testing.assert_allclose(independent,target.loc[independent.index,col],atol=1e-8)
        checks["scopes"][scope]=dict(menu_rows=len(menu),models=len(cols),daily_eligible_rows=len(active),common_7day_origins=len(cohort),
            menu_metrics_recomputed=True,daily_macro_recomputed=True,all_cover_sums_and_macro_recomputed=True,sampled_BOM_verified=True)
    selection=json.loads((OUT/"selection.json").read_text())
    assert hashlib.sha256((OUT/"selection.json").read_bytes()).hexdigest()==json.loads((OUT/"selection_lock.json").read_text())["sha256"]
    for file,sha in selection["code_sha256"].items():
        assert hashlib.sha256((HOME/file).read_bytes()).hexdigest()==sha
    assert json.loads((OUT/"holdout_complete.json").read_text())["legacy_cohort_and_predictions_match"]
    checks["frozen_selection_and_model_code"]=True
    checks["tests"]={}
    for file in ["mission01_tests.xml","new_tests_preholdout.xml","all_tests.xml"]:
        tree=ET.parse(HOME/"audit"/file)
        suites=list(tree.getroot().iter("testsuite"))
        counts={key:sum(int(s.attrib.get(key,0)) for s in suites) for key in ["tests","failures","errors","skipped"]}
        assert counts["failures"]==counts["errors"]==counts["skipped"]==0
        checks["tests"][file]=counts
    checks["real_pipeline_reproduced"]=all(v["bytes_equal"] for v in json.loads((HOME/"audit/reproduction_comparison.json").read_text()).values())
    assert checks["real_pipeline_reproduced"]
    (HOME/"audit/verification.json").write_text(json.dumps(checks,indent=2,ensure_ascii=False))
    print(json.dumps(checks,indent=2,ensure_ascii=False))


if __name__=="__main__":
    main()
