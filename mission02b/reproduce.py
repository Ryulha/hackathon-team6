"""Run unchanged Mission01 real supplied-data pipeline in isolated output cwd."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
HOME = ROOT/"mission02b"


def preservation():
    before = json.loads((HOME/"audit/before.json").read_text())
    changed = []
    for rel, meta in before["files"].items():
        p = ROOT/rel
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != meta["sha256"]:
            changed.append(rel)
    result = dict(files_checked=len(before["files"]),changed_files=changed,passed=not changed,
                  git_available=False,git_reason=before["git_stderr"])
    (HOME/"audit/preservation_check.json").write_text(json.dumps(result,ensure_ascii=False,indent=2))
    if changed:
        raise AssertionError(f"Protected files changed: {changed}")
    return result


def main():
    preservation()
    out = HOME/"reproduction"
    out.mkdir(exist_ok=False)
    data = next(ROOT.glob("*/data/09_sales.csv")).parent
    with (HOME/"audit/real_pipeline.log").open("w") as log:
        subprocess.run([sys.executable,"-m","forecast","--data-dir",str(data),"all"],
                       cwd=out,env=dict(os.environ,PYTHONPATH=str(ROOT/"src"),PYTHONDONTWRITEBYTECODE="1"),
                       stdout=log,stderr=subprocess.STDOUT,check=True)
    paths = ["outputs/evaluation/backtest_predictions.csv","outputs/evaluation/modeling_dataset.csv",
             "outputs/evaluation/metrics.csv","outputs/evaluation/summary.json",
             "outputs/demo/menu_forecast.csv","outputs/demo/ingredient_forecast.csv",
             "outputs/demo/menu_actual_comparison.csv"]
    checks = {}
    for rel in paths:
        a,b = ROOT/rel,out/rel
        checks[rel] = dict(bytes_equal=a.read_bytes()==b.read_bytes())
        if rel.endswith(".csv"):
            pd.testing.assert_frame_equal(pd.read_csv(a),pd.read_csv(b),check_exact=True)
            checks[rel]["values_exact"] = True
        assert checks[rel]["bytes_equal"]
    (HOME/"audit/reproduction_comparison.json").write_text(json.dumps(checks,indent=2))
    print(json.dumps(preservation(),ensure_ascii=False,indent=2))


if __name__=="__main__":
    main()
