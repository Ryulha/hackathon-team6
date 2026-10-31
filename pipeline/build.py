"""전처리·집계 → web/src/data/generated/*.json (DB 장애 시 폴백 + DB 적재 원본)

행 구조는 DB 테이블 컬럼과 동일(snake_case, 날짜는 'YYYY-MM-DD' 문자열)하게 맞춰
웹 쪽이 DB/JSON 어느 쪽에서 읽어도 같은 타입으로 다룬다.
실행: py pipeline/build.py [--raw <dir>]
"""
from __future__ import annotations

import json

import pandas as pd

from io_utils import ensure_data, load_all, raw_dir_from_argv
from schema import GENERATED_DIR

# 화면·엔진에 그대로 넘기는 마스터·이력 테이블
PASSTHROUGH = [
    "stores", "menus", "ingredients", "bom", "suppliers", "ingredient_price_history",
    "calendar", "promotions", "menu_availability", "purchase_orders", "receipts",
    "transfers", "stockouts", "inventory_daily", "inventory_lots_daily",
]


def to_records(df: pd.DataFrame) -> list[dict]:
    df = df.copy()
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].dt.strftime("%Y-%m-%d")
    return json.loads(df.to_json(orient="records", force_ascii=False))


def daily_demand(sales: pd.DataFrame) -> pd.DataFrame:
    """시간대·채널을 합쳐 날짜×매장×메뉴 일별 수요.
    예측 기준은 demand_qty(품절 제한 전 수요) — 판매량(qty)만 쓰면 품절일 수요를 과소추정한다.
    """
    g = sales.groupby(["date", "store_id", "menu_id"], as_index=False).agg(
        demand_qty=("demand_qty", "sum"), qty=("qty", "sum"), cancel_qty=("cancel_qty", "sum"),
        lost_qty=("lost_qty", "sum"), sales_amount=("sales_amount", "sum"), promo_flag=("promo_flag", "max"),
    )
    return g


def daily_waste(waste: pd.DataFrame) -> pd.DataFrame:
    return waste.groupby(["date", "store_id", "ingredient_id", "reason"], as_index=False).agg(
        waste_qty=("waste_qty", "sum"), waste_cost=("waste_cost", "sum"))


def build_tables(t: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    outs = {name: t[name] for name in PASSTHROUGH if name in t}
    if "sales" in t:
        outs["agg_daily_demand"] = daily_demand(t["sales"])
    if "waste" in t:
        outs["agg_daily_waste"] = daily_waste(t["waste"])
    return outs


def main() -> None:
    raw = raw_dir_from_argv()
    ensure_data(raw)
    outs = build_tables(load_all(raw))
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    meta = {"tables": {}, "source": str(raw)}
    for name, df in outs.items():
        path = GENERATED_DIR / f"{name}.json"
        path.write_text(json.dumps(to_records(df), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        meta["tables"][name] = {"rows": len(df), "kb": round(path.stat().st_size / 1024)}
        print(f"- {name}: {len(df):,}행, {meta['tables'][name]['kb']:,}KB")
    if "calendar" in outs:
        meta["data_start"] = outs["calendar"]["date"].min().strftime("%Y-%m-%d")
    if "inventory_daily" in outs:
        meta["data_end"] = outs["inventory_daily"]["date"].max().strftime("%Y-%m-%d")
    (GENERATED_DIR / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {GENERATED_DIR}")


if __name__ == "__main__":
    main()
