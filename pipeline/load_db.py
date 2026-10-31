"""raw_* (원본 17개) + agg_* (집계) 테이블을 Postgres(Neon)에 적재.

- raw/agg 테이블 DDL은 이 스크립트가 소유(매 실행 새로 만들어 교체).
- 앱 테이블(app_*)은 Drizzle(web/src/db/schema.ts, drizzle-kit push)이 소유하므로 건드리지 않는다.
- 운영 중인 앱이 반쯤 적재된 테이블을 보지 않도록, 모두 '<이름>__new' 에 먼저 적재한 뒤
  한 트랜잭션 안에서 이름을 바꿔 교체한다(swap). 중간에 실패하면 아무것도 바뀌지 않는다.
실행: DATABASE_URL=... py pipeline/load_db.py [--raw <dir>]
     (DATABASE_URL 미지정 시 web/.env.local 에서 읽음 — `vercel env pull` 결과)
전체 자동 실행(팀 전처리 포함)은 pipeline/run_all.py 를 쓴다.
"""
from __future__ import annotations

import io
import os
import time

import pandas as pd
import psycopg

from build import build_tables
from io_utils import ensure_data, load_all, raw_dir_from_argv
from schema import PG_TYPES, ROOT, SCHEMA

AGG_TYPES = {
    "agg_daily_demand": {"date": "date", "store_id": "id", "menu_id": "id", "demand_qty": "float",
                         "qty": "float", "cancel_qty": "float", "lost_qty": "float",
                         "sales_amount": "float", "promo_flag": "flag01"},
    "agg_daily_waste": {"date": "date", "store_id": "id", "ingredient_id": "id", "reason": "str",
                        "waste_qty": "float", "waste_cost": "float"},
}
INDEXES = {
    "raw_inventory_daily": "(store_id, ingredient_id, date)",
    "raw_inventory_lots_daily": "(date, store_id)",
    "raw_sales": "(store_id, date)",
    "agg_daily_demand": "(store_id, date)",
    "raw_purchase_orders": "(store_id, order_date)",
    "ana_ingredient_daily": "(store_id, ingredient_id, date)",
    "ana_menu_daily": "(store_id, date)",
    "ana_decision_features_daily": "(store_id, date)",
}
STAGE = "__new"


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    env_file = ROOT / "web" / ".env.local"
    if not url and env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"')
    if not url:
        raise SystemExit("[!] DATABASE_URL 이 없습니다. `vercel env pull web/.env.local` 후 다시 실행하세요.")
    return url


def copy_df(cur, table: str, cols: dict[str, str], df: pd.DataFrame) -> None:
    """table + '__new' 에 적재 (교체는 swap 에서)"""
    cols = {c: k for c, k in cols.items() if c in df.columns}
    stage = f"{table}{STAGE}"
    cur.execute(f'DROP TABLE IF EXISTS "{stage}"')
    ddl = ", ".join(f'"{c}" {PG_TYPES[k]}' for c, k in cols.items())
    cur.execute(f'CREATE TABLE "{stage}" ({ddl})')
    buf = io.StringIO()
    df[list(cols)].to_csv(buf, index=False, header=False, date_format="%Y-%m-%d")
    buf.seek(0)
    col_sql = ", ".join(f'"{c}"' for c in cols)
    with cur.copy(f'COPY "{stage}" ({col_sql}) FROM STDIN WITH (FORMAT csv)') as cp:
        while chunk := buf.read(1 << 20):
            cp.write(chunk)
    if table in INDEXES:
        cur.execute(f'CREATE INDEX ON "{stage}" {INDEXES[table]}')


def swap(cur, tables: list[str]) -> None:
    """적재해 둔 '<이름>__new' 를 실제 이름으로 교체 (같은 트랜잭션 → 커밋 순간 한꺼번에 바뀜)"""
    for t in tables:
        cur.execute(f'DROP TABLE IF EXISTS "{t}"')
        cur.execute(f'ALTER TABLE "{t}{STAGE}" RENAME TO "{t}"')


def load_raw_agg(cur, raw_tables: dict[str, pd.DataFrame]) -> list[str]:
    """원본 17개(raw_*)와 웹앱용 집계(agg_*)를 스테이징에 적재하고 테이블 이름 목록을 돌려준다"""
    loaded = []
    for _, (name, cols, _) in SCHEMA.items():
        if name not in raw_tables:
            continue
        t0 = time.time()
        copy_df(cur, f"raw_{name}", cols, raw_tables[name])
        loaded.append(f"raw_{name}")
        print(f"- raw_{name}: {len(raw_tables[name]):,}행 ({time.time() - t0:.1f}s)")
    for name, df in build_tables(raw_tables).items():
        if name.startswith("agg_"):
            copy_df(cur, name, AGG_TYPES[name], df)
            loaded.append(name)
            print(f"- {name}: {len(df):,}행")
    return loaded


def main() -> None:
    raw = raw_dir_from_argv()
    ensure_data(raw)
    raw_tables = load_all(raw)
    with psycopg.connect(database_url()) as conn, conn.cursor() as cur:
        swap(cur, load_raw_agg(cur, raw_tables))
        conn.commit()
    print("완료")


if __name__ == "__main__":
    main()
