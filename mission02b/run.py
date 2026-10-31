"""Stage-gated local experiment runner. No automatic holdout during development."""
import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import importlib.metadata
import time

import numpy as np
import pandas as pd

from forecast.data import load_data
from forecast.model import DemandModel
from .features import AdaptiveBuilder
from .models import ExperimentModel, Spec, SPECS
from .evaluation import KEYS, summarize
from .correction import prequential

ROOT = Path(__file__).resolve().parents[1]
HOME = ROOT / "mission02b"
FOLDS = {"A": ("2026-06-01", "2026-06-30"), "B": ("2026-07-01", "2026-07-31")}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))


def protocol_check():
    lock = json.loads((HOME/"audit/protocol_lock.json").read_text())
    if digest(HOME/"PROTOCOL.md") != lock["sha256"]:
        raise ValueError("Protocol changed after preregistration")


def load_development():
    return load_data(next(ROOT.glob("*/data/09_sales.csv")).parent).before("2026-08-01")


def dataset(data, end):
    t = time.perf_counter()
    ds = AdaptiveBuilder(data).supervised(origin_end=end)
    ds = ds.loc[ds.target_date.le(end)].reset_index(drop=True)
    print(f"Dataset through {end}: {len(ds):,} rows ({time.perf_counter()-t:.2f}s)", flush=True)
    return ds


def train_predict(train, val, spec, directory):
    model = ExperimentModel.fit(train, spec)
    model.save(directory)
    start = time.perf_counter()
    p = model.predict(val)
    seconds = time.perf_counter()-start
    # Persistence must reproduce all validation predictions exactly.
    np.testing.assert_array_equal(p, ExperimentModel.load(directory).predict(val))
    return p, dict(model=spec.name, fit_seconds=model.metadata["fit_seconds"],
                   predict_seconds=seconds, prediction_rows=len(val), train_rows=len(train))


def development(out):
    protocol_check()
    if out.exists():
        raise ValueError("Use a NEW --output directory; never overwrite an experiment")
    out.mkdir(parents=True)
    write_json(out/"environment.json", dict(python=platform.python_version(),
        packages={p: importlib.metadata.version(p) for p in ["pandas", "numpy", "catboost", "pytest"]},
        protocol_sha256=digest(HOME/"PROTOCOL.md"), started_at=datetime.now(timezone.utc).isoformat()))
    data = load_development()
    ds = dataset(data, "2026-07-31")
    ds.to_pickle(out/"development_dataset.pkl")
    timing = []
    for fold, (start, end) in FOLDS.items():
        train = ds.loc[ds.target_date.lt(start)]
        val = ds.loc[ds.as_of_date.ge(start) & ds.target_date.between(start, end)]
        pred = val[KEYS+["demand_qty"]].copy()
        for spec in SPECS:
            print(f"Fold {fold}: fitting {spec.name} ({len(train):,} -> {len(val):,})", flush=True)
            pred["pred_"+spec.name], t = train_predict(train, val, spec, out/"models"/fold/spec.name)
            timing.append(dict(fold=fold, **t))
        summarize(data, pred, start, end, out/"initial"/fold)
        print(f"Fold {fold} A-C complete", flush=True)
    pd.DataFrame(timing).to_csv(out/"timings.csv", index=False)
    print(comparison(out, "initial").to_string(index=False), flush=True)


def read_tables(out, stage, fold):
    p = out/stage/fold
    return {name: pd.read_csv(p/f"{name}.csv") for name in ["menu_metrics", "daily_macro", "coverage_macro", "daily_ingredient_metrics"]}


def comparison(out, stage):
    rows = []
    for fold in FOLDS:
        t = read_tables(out, stage, fold)
        overall = t["menu_metrics"].loc[lambda x:x.dimension.eq("overall")]
        for r in overall.itertuples():
            daily = t["daily_macro"].loc[lambda x:x.model.eq(r.model) & x.truth.eq("no_stockout_proxy"), "macro_WAPE"].item()
            covers = t["coverage_macro"].loc[lambda x:x.model.eq(r.model) & x.truth.eq("no_stockout_proxy")].set_index("cover_days").macro_WAPE
            rows.append(dict(fold=fold, model=r.model, WAPE=r.WAPE, MAE=r.MAE, Bias=r.Bias,
                             ingredient_daily_macro=daily, **{f"cover_{n}":covers[n] for n in [1,2,3,7]}))
    return pd.DataFrame(rows)


def conditional(out):
    protocol_check()
    if (out/"conditional_decision.json").exists() or (out/"selection.json").exists():
        raise ValueError("Conditional stage already executed or selection locked")
    tables = {f:read_tables(out,"initial",f) for f in FOLDS}
    cmp = comparison(out, "initial")
    best = cmp.groupby("model").WAPE.mean().idxmin()
    mm = {f:t["menu_metrics"].loc[lambda x:x.dimension.eq("size_band")].pivot(index="model",columns="group",values="WAPE") for f,t in tables.items()}
    high_low = all("low" in m and "high" in m and m.loc["A0_RMSE","low"] > 1.25*m.loc["A0_RMSE","high"] for m in mm.values())
    improved_low = any(all(m.loc[s.name,"low"] <= .98*m.loc["A0_RMSE","low"] for m in mm.values()) for s in SPECS[1:]) if all("low" in m for m in mm.values()) else False
    bias = cmp.loc[cmp.model.eq(best)].Bias.to_numpy()
    residual = bool((np.abs(bias)>=.02).all() and (np.sign(bias)==np.sign(bias[0])).all())
    decision = dict(hurdle=bool(high_low and not improved_low), low_error_high_in_both=bool(high_low),
                    existing_low_improvement=bool(improved_low), residual=residual, residual_base=best,
                    base_bias=bias.tolist(), decided_at=datetime.now(timezone.utc).isoformat())
    write_json(out/"conditional_decision.json", decision)
    print(json.dumps(decision, indent=2), flush=True)
    data = load_development()
    ds = pd.read_pickle(out/"development_dataset.pkl")
    timing = pd.read_csv(out/"timings.csv").to_dict("records")
    for fold, (start, end) in FOLDS.items():
        pred = pd.read_csv(out/"initial"/fold/"menu_predictions.csv.gz",parse_dates=["as_of_date","target_date"])
        val = ds.loc[ds.as_of_date.ge(start) & ds.target_date.between(start,end)]
        # Verify serialized row order before assigning model outputs.
        pd.testing.assert_frame_equal(pred[KEYS].reset_index(drop=True), val[KEYS].reset_index(drop=True))
        if decision["hurdle"]:
            spec = Spec("D1_hurdle", loss="Poisson", kind="hurdle")
            print(f"Fold {fold}: conditional hurdle", flush=True)
            pred["pred_"+spec.name], t = train_predict(ds.loc[ds.target_date.lt(start)],val,spec,out/"models"/fold/spec.name)
            timing.append(dict(fold=fold,**t))
        if decision["residual"]:
            before = time.perf_counter()
            result = prequential(pred[KEYS+["demand_qty","pred_"+best]], "pred_"+best)
            pred["pred_D2_residual"] = result.corrected_prediction.to_numpy()
            result.to_csv(out/f"residual_trace_{fold}.csv.gz",index=False)
            base_t = next(t for t in timing if t["fold"]==fold and t["model"]==best)
            timing.append(dict(fold=fold,model="D2_residual",fit_seconds=base_t["fit_seconds"],
                               predict_seconds=base_t["predict_seconds"]+time.perf_counter()-before,
                               prediction_rows=len(pred),train_rows=base_t["train_rows"]))
        summarize(data,pred,start,end,out/"validation"/fold)
    pd.DataFrame(timing).to_csv(out/"timings.csv",index=False)
    comparison(out,"validation").to_csv(out/"validation_comparison.csv",index=False)


def select(out):
    protocol_check()
    if (out/"selection.json").exists():
        raise ValueError("Selection already locked")
    cmp = comparison(out,"validation")
    ranking = cmp.groupby("model").WAPE.mean().sort_values()
    base = cmp.loc[cmp.model.eq("A0_RMSE")].set_index("fold")
    gates = []
    for name in ranking.index:
        c = cmp.loc[cmp.model.eq(name)].set_index("fold")
        improvement = base.WAPE - c.WAPE
        gate = dict(model=name, mean_WAPE=float(c.WAPE.mean()), mean_improvement=float(improvement.mean()),
                    both_folds_better=bool(improvement.gt(0).all()), meaningful=bool(improvement.mean()>=.005),
                    ingredient_daily=bool(c.ingredient_daily_macro.le(base.ingredient_daily_macro+.01).all()),
                    covers=bool((c[[f"cover_{n}" for n in [1,2,3,7]]] <= base[[f"cover_{n}" for n in [1,2,3,7]]]+.01).all().all()),
                    menu_bias=bool(c.Bias.abs().le(base.Bias.abs()+.02).all()))
        item_ok = True
        for fold in FOLDS:
            t = read_tables(out,"validation",fold)["daily_ingredient_metrics"]
            t = t.loc[t.truth.eq("no_stockout_proxy") & t.ingredient_id.isin(["I009","I020","I017"])]
            b = t.loc[t.model.eq("A0_RMSE")].set_index(["ingredient_id","use_unit"]).Bias.abs()
            a = t.loc[t.model.eq(name)].set_index(["ingredient_id","use_unit"]).Bias.abs()
            item_ok &= bool(a.le(b+.03).all())
        gate["exploratory_item_bias"] = item_ok
        gate["eligible"] = all(gate[k] for k in ["both_folds_better","meaningful","ingredient_daily","covers","menu_bias","exploratory_item_bias"])
        gates.append(gate)
    eligible = [g["model"] for g in gates if g["eligible"]]
    selected = eligible[0] if eligible else "A0_RMSE"
    # The best non-baseline is a nominated research candidate, even if no model
    # passes the practical adoption threshold. Nomination is frozen pre-holdout.
    nominated = eligible[0] if eligible else next(n for n in ranking.index if n != "A0_RMSE")
    decision = dict(selected=selected,nominated=nominated,development_improvement_confirmed=bool(eligible),
                    default_model_replaced=False,iterations=400, gates=gates,
                    holdout_models=list(dict.fromkeys(["A0_RMSE",nominated])),
                    locked_at=datetime.now(timezone.utc).isoformat(),
                    protocol_sha256=digest(HOME/"PROTOCOL.md"),
                    code_sha256={p.name:digest(p) for p in HOME.glob("*.py") if p.name not in ["report.py","verify.py","reproduce.py","test_support.py"]})
    write_json(out/"selection.json",decision)
    write_json(out/"selection_lock.json",dict(sha256=digest(out/"selection.json")))
    print(json.dumps(decision,ensure_ascii=False,indent=2),flush=True)


def holdout(out):
    protocol_check()
    selection = json.loads((out/"selection.json").read_text())
    if digest(out/"selection.json") != json.loads((out/"selection_lock.json").read_text())["sha256"]:
        raise ValueError("Selection mutated")
    for file, sha in selection["code_sha256"].items():
        if digest(HOME/file) != sha:
            raise ValueError(f"Frozen model/evaluation code changed: {file}")
    marker = out/"holdout_started.json"
    if marker.exists():
        raise ValueError("Holdout was already opened: refuse repeat/tuning")
    write_json(marker,dict(started_at=datetime.now(timezone.utc).isoformat(),selection_sha256=digest(out/"selection.json")))
    data = load_data(next(ROOT.glob("*/data/09_sales.csv")).parent)
    ds = dataset(data,"2026-09-30")
    train = ds.loc[ds.target_date.le("2026-07-31")]
    val = ds.loc[ds.as_of_date.ge("2026-08-01") & ds.target_date.between("2026-08-01","2026-09-30")]
    pred = val[KEYS+["demand_qty"]].copy()
    timings = []
    conditional = json.loads((out/"conditional_decision.json").read_text())
    specs = {s.name:s for s in SPECS}
    specs["D1_hurdle"] = Spec("D1_hurdle",loss="Poisson",kind="hurdle")
    for name in selection["holdout_models"]:
        base_name = conditional["residual_base"] if name=="D2_residual" else name
        print(f"Locked holdout refit: {name}",flush=True)
        model = ExperimentModel.fit(train,specs[base_name])
        model.metadata["selection_target_max"] = "2026-07-31"
        model.metadata["residual_correction"] = name=="D2_residual"
        model.save(out/"models"/"holdout"/name)
        before = time.perf_counter()
        p = model.predict(val)
        np.testing.assert_array_equal(p,ExperimentModel.load(out/"models"/"holdout"/name).predict(val))
        if name=="D2_residual":
            trace = prequential(val[KEYS+["demand_qty"]].assign(prediction_base=p),"prediction_base")
            p = trace.corrected_prediction.to_numpy()
            trace.to_csv(out/"holdout_residual_trace.csv.gz",index=False)
        pred["pred_"+name] = p
        timings.append(dict(model=name,fit_seconds=model.metadata["fit_seconds"],predict_seconds=time.perf_counter()-before, prediction_rows=len(val)))
    old = DemandModel.load(ROOT/"models/evaluated/catboost")
    before = time.perf_counter()
    pred["pred_legacy122"] = old.predict(val)
    timings.append(dict(model="legacy122",fit_seconds=0.,predict_seconds=time.perf_counter()-before,prediction_rows=len(val)))
    original = pd.read_csv(ROOT/"outputs/evaluation/backtest_predictions.csv",parse_dates=["as_of_date","target_date"])
    original = original.loc[original.split.eq("test")]
    check = pred.merge(original[KEYS+["pred_catboost"]],on=KEYS,validate="one_to_one")
    if len(check)!=len(pred):
        raise ValueError("Historical cohort mismatch")
    np.testing.assert_allclose(check.pred_legacy122,check.pred_catboost,atol=1e-12)
    summarize(data,pred,"2026-08-01","2026-09-30",out/"holdout")
    pd.DataFrame(timings).to_csv(out/"holdout_timings.csv",index=False)
    write_json(out/"holdout_complete.json",dict(completed_at=datetime.now(timezone.utc).isoformat(),rows=len(pred),
                                               legacy_cohort_and_predictions_match=True,selection_sha256=digest(out/"selection.json")))
    print(pd.read_csv(out/"holdout/menu_metrics.csv").query("dimension == 'overall'").to_string(index=False),flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("stage",choices=["dev","conditional","select","holdout"])
    parser.add_argument("--output",default=str(HOME/"runs/main"))
    args=parser.parse_args()
    out=Path(args.output).resolve()
    if not out.is_relative_to(HOME):
        raise ValueError("All experiment outputs must stay inside mission02b")
    {"dev":development,"conditional":conditional,"select":select,"holdout":holdout}[args.stage](out)


if __name__=="__main__":
    main()
