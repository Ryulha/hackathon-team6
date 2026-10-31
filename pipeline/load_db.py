"""raw_* (원본 17개) + agg_* (집계) 테이블을 Postgres(Neon)에 적재.

- raw/agg 테이블 DDL은 이 스크립트가 소유(매 실행 DROP → CREATE → COPY).
- 앱 테이블(app_*)은 Drizzle(web/src/db/schema.ts, drizzle-kit push)이 소유하므로 건드리지 않는다.
실행: DATABASE_URL=... py pipeline/load_db.py [--raw <dir>]
     (DATABASE_URL 미지정 시 web/.env.local 에서 읽음 — `vercel env pull` 결과)
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
}


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    env_file = ROOT / "web" / ".env.local"
    if not url and env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"')
    if not url:
        raise SystemExit("[!] DATABASE_URL 이 없습니다. `cd web && vercel env pull .env.local` 후 다시 실행하세요.")
    return url


def copy_df(cur, table: str, cols: dict[str, str], df: pd.DataFrame) -> None:
    cols = {c: k for c, k in cols.items() if c in df.columns}
    cur.execute(f'DROP TABLE IF EXISTS "{table}"')
    ddl = ", ".join(f'"{c}" {PG_TYPES[k]}' for c, k in cols.items())
    cur.execute(f'CREATE TABLE "{table}" ({ddl})')
    buf = io.StringIO()
    df[list(cols)].to_csv(buf, index=False, header=False, date_format="%Y-%m-%d")
    buf.seek(0)
    col_sql = ", ".join(f'"{c}"' for c in cols)
    with cur.copy(f'COPY "{table}" ({col_sql}) FROM STDIN WITH (FORMAT csv)') as cp:
        while chunk := buf.read(1 << 20):
            cp.write(chunk)
    if table in INDEXES:
        cur.execute(f'CREATE INDEX ON "{table}" {INDEXES[table]}')


def main() -> None:
    raw = raw_dir_from_argv()
    ensure_data(raw)
    raw_tables = load_all(raw)
    agg = {k: v for k, v in build_tables(raw_tables).items() if k.startswith("agg_")}
    with psycopg.connect(database_url()) as conn, conn.cursor() as cur:
        for file_name, (name, cols, _) in SCHEMA.items():
            if name not in raw_tables:
                continue
            t0 = time.time()
            copy_df(cur, f"raw_{name}", cols, raw_tables[name])
            print(f"- raw_{name}: {len(raw_tables[name]):,}행 ({time.time() - t0:.1f}s)")
        for name, df in agg.items():
            copy_df(cur, name, AGG_TYPES[name], df)
            print(f"- {name}: {len(df):,}행")
        conn.commit()
    print("완료")


if __name__ == "__main__":
    main()
