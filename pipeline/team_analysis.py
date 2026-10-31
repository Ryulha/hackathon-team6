"""팀 전처리·EDA 코드(팀 저장소 main 의 pipeline.py, 작성: 팀원)를 그대로 실행하고 결과를 DB 적재용으로 읽는다.

팀 코드를 복사·수정하지 않는다: 실행할 때마다 git 에서 지정한 ref 의 pipeline.py 를 꺼내 임시 폴더에서 실행.
팀 코드는 검증 실패(FAIL) 시 스스로 중단하므로, 실패하면 이후 단계(DB 적재)도 진행하지 않는다.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pandas as pd

from schema import ROOT

CACHE = Path(__file__).resolve().parent / ".team_cache"
# 팀 결과에서 날짜로 다룰 컬럼
DATE_COLS = {"date", "valid_from", "start_date", "end_date", "order_date", "expected_date", "receipt_date", "last_use_date"}


def _git(*args: str) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise SystemExit(f"[!] git {' '.join(args)} 실패: {r.stderr.strip()}")
    return r.stdout


def fetch_team_script(ref: str) -> tuple[Path, str]:
    """ref(예: team/main)의 pipeline.py 를 꺼내 캐시에 저장. (경로, '커밋 해시 작성자 메시지') 반환"""
    remote = ref.split("/", 1)[0]
    subprocess.run(["git", "fetch", "-q", remote], cwd=ROOT, check=False)
    commit = _git("log", "-1", "--format=%h %an %s", ref).strip()
    CACHE.mkdir(exist_ok=True)
    path = CACHE / "pipeline.py"
    path.write_text(_git("show", f"{ref}:pipeline.py"), encoding="utf-8")
    return path, commit


def run_team(script: Path, raw_dir: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"  python {script.name} --data {raw_dir} --out {out_dir}")
    r = subprocess.run([sys.executable, str(script), "--data", str(raw_dir), "--out", str(out_dir)], cwd=script.parent)
    if r.returncode != 0:
        raise SystemExit(f"[!] 팀 전처리 실패(검증 FAIL 포함) — {out_dir / 'validation_checks.csv'} 확인. DB 적재를 진행하지 않습니다.")


def _kinds(df: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, str]]:
    """pandas 타입 → 적재 kind. 금액 합계가 int4 범위를 넘을 수 있어 숫자는 모두 double"""
    df = df.copy()
    kinds: dict[str, str] = {}
    for c in df.columns:
        if c in DATE_COLS:
            df[c] = pd.to_datetime(df[c], errors="coerce")
            kinds[c] = "date"
        elif pd.api.types.is_bool_dtype(df[c]):
            df[c] = df[c].astype(int)
            kinds[c] = "flag01"
        elif pd.api.types.is_numeric_dtype(df[c]):
            kinds[c] = "float"
        else:
            kinds[c] = "str"
    return df, kinds


def read_outputs(out_dir: Path) -> tuple[dict[str, tuple[pd.DataFrame, dict[str, str]]], dict[str, object]]:
    """CSV → ana_<이름> 테이블, JSON → ana_meta 의 한 행"""
    tables = {}
    for f in sorted(out_dir.glob("*.csv")):
        name = "ana_" + "".join(ch if ch.isalnum() else "_" for ch in f.stem).lower()
        tables[name] = _kinds(pd.read_csv(f, encoding="utf-8-sig", low_memory=False))
    meta = {f.stem: json.loads(f.read_text(encoding="utf-8")) for f in sorted(out_dir.glob("*.json"))}
    return tables, meta
