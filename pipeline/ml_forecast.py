"""팀 CatBoost 수요예측 → Neon ana_ml_forecast 적재 (웹 발주 엔진이 앞 7일 예측으로 사용).

실행 (저장소 루트에서): py pipeline/ml_forecast.py [--raw <dir>] [--no-db] [--branch team/data_cry]
1) 팀 브랜치의 src/forecast 를 pipeline/.team_cache/data_cry 로 꺼내고 전용 가상환경(고정 버전) 준비
2) 원본 CSV 복사본에 10월 달력(공휴일 캘린더 연동)·취급 일정 연장 — 원본은 그대로
   팀 코드는 달력 밖 날짜를 거부하므로(제공 달력은 9/30까지) 10/1 예측에 필요
3) 모델 학습·기준일별 7일 예측 (ml_forecast_worker.py)
4) ana_ml_forecast 로 교체 적재
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import psycopg

from io_utils import ensure_data
from load_db import copy_df, database_url, swap
from schema import RAW_DIR, ROOT

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CACHE = Path(__file__).resolve().parent / ".team_cache"
CODE = CACHE / "data_cry"
DATA_EXT = CACHE / "data_ext"
EXTEND_TO = date(2026, 10, 31)
ICS = "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics"
FALLBACK_HOLIDAYS = {"2026-10-03": "개천절", "2026-10-05": "대체공휴일", "2026-10-09": "한글날"}  # 웹 엔진과 같은 가정
PINS = ["catboost==1.2.10", "numpy==2.3.5", "pandas==2.3.3", "scikit-learn==1.9.1", "matplotlib>=3.9,<4"]
TYPES = {"origin": "date", "date": "date", "store_id": "id", "menu_id": "id", "horizon": "int", "is_available": "flag01",
         "pred_demand_qty": "float", "cancel_rate": "float", "pred_net_qty": "float", "model": "str"}


def run(cmd: list, **kw) -> None:
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def prepare_code(branch: str) -> Path:
    if CODE.exists():
        shutil.rmtree(CODE / "src", ignore_errors=True)
    CODE.mkdir(parents=True, exist_ok=True)
    tar = subprocess.run(["git", "archive", branch, "src", "pyproject.toml"], cwd=ROOT, check=True, capture_output=True).stdout
    run(["tar", "-x", "-C", CODE], input=tar)
    py = CODE / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if not py.exists():
        run([sys.executable, "-m", "venv", CODE / ".venv"])
        run([py, "-m", "pip", "install", "-q", *PINS])
    run([py, "-m", "pip", "install", "-q", "--no-deps", "-e", CODE])
    return py


def korean_holidays() -> dict[str, str]:
    try:
        text = urllib.request.urlopen(ICS, timeout=10).read().decode("utf-8")
        out = {}
        for ev in text.replace("\r", "").split("BEGIN:VEVENT")[1:]:
            d = re.search(r"^DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})", ev, re.M)
            name = re.search(r"^SUMMARY:(.*)$", ev, re.M)
            desc = re.search(r"^DESCRIPTION:(.*)$", ev, re.M)
            if d and name and desc and desc.group(1).startswith("공휴일"):
                out[f"{d.group(1)}-{d.group(2)}-{d.group(3)}"] = name.group(1).strip()
        return out or FALLBACK_HOLIDAYS
    except OSError:
        return FALLBACK_HOLIDAYS


def extend_data(raw: Path) -> Path:
    """원본 복사본: 달력을 10월까지, 마지막 날까지 이어지던 취급 일정은 그대로 이어진다고 가정(웹 엔진과 같은 가정)"""
    DATA_EXT.mkdir(parents=True, exist_ok=True)
    for f in raw.glob("*.csv"):
        shutil.copy2(f, DATA_EXT / f.name)
    cal = pd.read_csv(raw / "07_calendar.csv", encoding="utf-8-sig", dtype=str)
    end = date.fromisoformat(cal.date.max())
    hol = korean_holidays()
    wd = "월화수목금토일"
    extra = []
    d = end + timedelta(days=1)
    while d <= EXTEND_TO:
        k = d.isoformat()
        extra.append({"date": k, "weekday": wd[d.weekday()], "is_holiday": "1" if k in hol else "0", "holiday_name": hol.get(k, "")})
        d += timedelta(days=1)
    pd.concat([cal, pd.DataFrame(extra)]).to_csv(DATA_EXT / "07_calendar.csv", index=False, encoding="utf-8-sig")
    av = pd.read_csv(raw / "15_menu_availability.csv", encoding="utf-8-sig", dtype=str)
    av.loc[av.end_date == end.isoformat(), "end_date"] = EXTEND_TO.isoformat()
    av.to_csv(DATA_EXT / "15_menu_availability.csv", index=False, encoding="utf-8-sig")
    print(f"  달력 {end + timedelta(days=1)}~{EXTEND_TO} 추가 (공휴일 {sorted(k[5:] for k in hol if end.isoformat() < k <= EXTEND_TO.isoformat())})")
    return DATA_EXT


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=RAW_DIR)
    ap.add_argument("--branch", default="team/data_cry")
    ap.add_argument("--no-db", action="store_true")
    args = ap.parse_args()
    ensure_data(args.raw)

    print("[1] 팀 예측 코드·가상환경")
    py = prepare_code(args.branch)
    print("[2] 확장 데이터")
    data_dir = extend_data(args.raw)
    print("[3] CatBoost 학습·예측")
    out_csv = CACHE / "ml_forecast.csv"
    run([py, Path(__file__).with_name("ml_forecast_worker.py"), data_dir, CACHE / "ml_models", out_csv], cwd=CODE)
    df = pd.read_csv(out_csv)
    if args.no_db:
        return
    print("[4] Neon 적재 → ana_ml_forecast")
    with psycopg.connect(database_url()) as conn, conn.cursor() as cur:
        copy_df(cur, "ana_ml_forecast", TYPES, df)
        cur.execute('CREATE INDEX ON "ana_ml_forecast__new" (store_id, origin)')
        swap(cur, ["ana_ml_forecast"])
    print(f"  → {len(df):,}행 적재")


if __name__ == "__main__":
    main()
