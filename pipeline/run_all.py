"""원본 CSV → 검증 → 팀 전처리·EDA → 웹앱 집계 → Neon 적재를 한 번에.

실행 (저장소 루트에서):
  py pipeline/run_all.py                         # data/raw 사용, 팀 코드는 team/main, Neon 적재
  py pipeline/run_all.py --raw <폴더> --no-db    # 적재 없이 결과 파일만 확인
  py pipeline/run_all.py --skip-raw              # 원본·집계는 그대로 두고 팀 분석 결과(ana_*)만 다시 적재
  py pipeline/run_all.py --team-script <경로>    # git 대신 로컬 pipeline.py 사용

단계
  1) 원본 17개 확인·자체 검증 리포트(pipeline/reports/validation.md)
  2) 팀 pipeline.py 실행 → pipeline/reports/analysis/ (검증 FAIL 이면 중단)
  3) 웹앱 폴백 JSON 생성(web/src/data/generated)
  4) Neon: raw_*(원본) · agg_*(웹앱 집계) · ana_*(팀 분석) · ana_meta(요약·출처·실행 기록)를
     '<이름>__new' 에 적재 후 한 트랜잭션으로 교체 → 실패하면 기존 데이터 그대로
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

import build
import validate
from io_utils import ensure_data, load_all
from schema import RAW_DIR, REPORT_DIR
from team_analysis import fetch_team_script, read_outputs, run_team

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def step(n: int, title: str) -> None:
    print(f"\n[{n}] {title}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, default=RAW_DIR, help="원본 CSV 01~17 폴더 (기본 data/raw)")
    ap.add_argument("--team-ref", default="team/main", help="팀 pipeline.py 를 꺼낼 git ref (기본 team/main)")
    ap.add_argument("--team-script", type=Path, help="git 대신 사용할 로컬 pipeline.py 경로")
    ap.add_argument("--no-db", action="store_true", help="DB 적재 생략")
    ap.add_argument("--skip-raw", action="store_true", help="raw_*/agg_* 는 그대로 두고 ana_* 만 적재")
    a = ap.parse_args()
    raw = a.raw.resolve()
    sys.argv = [sys.argv[0], "--raw", str(raw)]  # validate/build 는 같은 --raw 인자를 읽는다
    t0 = time.time()

    step(1, f"원본 확인·검증 ({raw})")
    ensure_data(raw)
    validate.main()

    step(2, "팀 전처리·EDA 실행")
    if a.team_script:
        script, provenance = a.team_script.resolve(), f"로컬 파일 {a.team_script}"
    else:
        script, provenance = fetch_team_script(a.team_ref)
    print(f"  팀 코드: {provenance}")
    out_dir = REPORT_DIR / "analysis"
    run_team(script, raw, out_dir)
    ana_tables, meta = read_outputs(out_dir)
    print(f"  → {len(ana_tables)}개 표, {len(meta)}개 요약 ({out_dir})")

    step(3, "웹앱 폴백 JSON 생성")
    build.main()

    if a.no_db:
        print(f"\n--no-db: DB 적재 생략. 완료 ({time.time() - t0:.0f}s)")
        return

    step(4, "Neon 적재 (스테이징 → 한 번에 교체)")
    import psycopg  # DB 단계에서만 필요

    from load_db import copy_df, database_url, load_raw_agg, swap
    run_info = {
        "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "team_code": provenance,
        "raw_dir": str(raw), "skip_raw": a.skip_raw,
        "tables": {k: len(v[0]) for k, v in ana_tables.items()},
    }
    meta_df = pd.DataFrame([{"name": k, "data": json.dumps(v, ensure_ascii=False)} for k, v in {**meta, "run_info": run_info}.items()])
    with psycopg.connect(database_url()) as conn, conn.cursor() as cur:
        loaded = [] if a.skip_raw else load_raw_agg(cur, load_all(raw))
        for name, (df, kinds) in ana_tables.items():
            copy_df(cur, name, kinds, df)
            loaded.append(name)
            print(f"- {name}: {len(df):,}행")
        copy_df(cur, "ana_meta", {"name": "str", "data": "json"}, meta_df)
        loaded.append("ana_meta")
        swap(cur, loaded)
        conn.commit()
    print(f"\n완료: {len(loaded)}개 테이블 교체 ({time.time() - t0:.0f}s)")
    if not a.skip_raw:
        print("※ 원본을 다시 적재했다면 Vercel 을 재배포해 서버의 기준 데이터 캐시를 비우세요.")


if __name__ == "__main__":
    main()
