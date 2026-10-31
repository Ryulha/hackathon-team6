"""Reproduce the real supplied-data pipeline in an isolated working directory."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pandas as pd

ROOT=Path(__file__).resolve().parents[1]
LOCAL=ROOT/'mission02a'


def check_preserved():
    manifest=json.loads((LOCAL/'evidence/preserved_manifest.json').read_text())
    changes=[p for p,h in manifest.items() if not (ROOT/p).exists() or hashlib.sha256((ROOT/p).read_bytes()).hexdigest()!=h]
    result={'files_checked':len(manifest),'changed_files':changes,'pass':not changes}
    (LOCAL/'evidence/preservation_check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    if changes:raise AssertionError(f'Protected files changed: {changes}')
    return result


def main():
    check_preserved()
    sandbox=LOCAL/'reproduction'
    (sandbox/'docs').mkdir(parents=True,exist_ok=True)
    data=next(ROOT.glob('*/data/09_sales.csv')).parent
    command=[sys.executable,'-m','forecast','--data-dir',str(data),'all']
    with (LOCAL/'evidence/reproduction.log').open('w') as log:
        subprocess.run(command,cwd=sandbox,env=dict(os.environ,PYTHONPATH=str(ROOT/'src')),stdout=log,stderr=subprocess.STDOUT,check=True)
    results={}
    for path in ['outputs/evaluation/backtest_predictions.csv','outputs/evaluation/modeling_dataset.csv','outputs/evaluation/metrics.csv','outputs/evaluation/summary.json','outputs/demo/menu_forecast.csv','outputs/demo/ingredient_forecast.csv','outputs/demo/menu_actual_comparison.csv']:
        a,b=ROOT/path,sandbox/path
        results[path]={'bytes_equal':a.read_bytes()==b.read_bytes()}
        if path.endswith('.csv'):
            x,y=pd.read_csv(a),pd.read_csv(b)
            pd.testing.assert_frame_equal(x,y,check_exact=True)
            results[path].update(values_exact=True,rows=len(x))
        assert results[path]['bytes_equal']
    (LOCAL/'evidence/reproduction_comparison.json').write_text(json.dumps(results,indent=2))
    print(json.dumps(check_preserved(),indent=2))


if __name__=='__main__':main()
