"""데이터 품질·해석 검증 리포트 → pipeline/reports/validation.md

결과는 docs/데이터_사용_가정표.md 의 근거로 사용한다.
실행: py pipeline/validate.py [--raw <dir>]
"""
from __future__ import annotations

import pandas as pd

from io_utils import ensure_data, load_all, raw_dir_from_argv
from schema import FOREIGN_KEYS, REPORT_DIR, SCHEMA

TOL = 1e-6
lines: list[str] = []


def out(s: str = "") -> None:
    print(s)
    lines.append(s)


def ratio(mask: pd.Series) -> str:
    n = len(mask)
    return f"{int(mask.sum())}/{n} ({mask.mean():.1%})" if n else "0/0"


def check_structure(t: dict[str, pd.DataFrame]) -> None:
    out("## 1. 구조")
    for file_name, (name, cols, pk) in SCHEMA.items():
        if name not in t:
            out(f"- [누락] {file_name}")
            continue
        df = t[name]
        missing = [c for c in cols if c not in df.columns]
        extra = [c for c in df.columns if c not in cols]
        dup = int(df.duplicated(pk).sum()) if pk and not missing else 0
        date_cols = [c for c, k in cols.items() if k == "date" and c in df.columns]
        rng = ""
        if date_cols:
            d = df[date_cols[0]]
            rng = f", {date_cols[0]} {d.min():%Y-%m-%d}~{d.max():%Y-%m-%d}"
        out(f"- {file_name}: {len(df):,}행{rng}"
            + (f", 누락컬럼 {missing}" if missing else "")
            + (f", 추가컬럼 {extra}" if extra else "")
            + (f", PK중복 {dup}" if dup else ""))


def check_fk(t: dict[str, pd.DataFrame]) -> None:
    out("\n## 2. 키 무결성")
    for tbl, col, ref, ref_col in FOREIGN_KEYS:
        if tbl not in t or ref not in t:
            continue
        orphan = ~t[tbl][col].isin(t[ref][ref_col])
        if orphan.any():
            out(f"- [!] {tbl}.{col} → {ref}: 고아 {ratio(orphan)} 예) {t[tbl][col][orphan].unique()[:5].tolist()}")
    out("- (위에 없으면 모두 통과)")


def check_units(t: dict[str, pd.DataFrame]) -> None:
    out("\n## 3. 단위")
    if "ingredients" not in t:
        return
    unit = t["ingredients"].set_index("ingredient_id")["use_unit"]
    for name in ("bom", "inventory_daily", "waste", "transfers", "inventory_lots_daily"):
        if name in t:
            mism = t[name]["use_unit"] != t[name]["ingredient_id"].map(unit)
            out(f"- {name}.use_unit ≠ ingredients.use_unit: {ratio(mism)}")
    if "receipts" in t:
        r = t["receipts"].merge(t["ingredients"][["ingredient_id", "use_qty_per_order_unit"]], on="ingredient_id")
        bad = (r["received_qty"] * r["use_qty_per_order_unit"] - r["received_use_qty"]).abs() > TOL
        out(f"- receipts: received_qty×환산계수 ≠ received_use_qty: {ratio(bad)}")
        out(f"- receipts.status 값: {t['receipts']['status'].value_counts().to_dict()}")


def check_inventory(t: dict[str, pd.DataFrame]) -> None:
    out("\n## 4. 재고 등식 (어떤 정의가 맞는지 확인)")
    if "inventory_daily" not in t:
        return
    d = t["inventory_daily"]
    flows = d["received_qty"] + d["transfer_in_qty"] - d["transfer_out_qty"] - d["consumed_qty"] - d["waste_qty"]
    variants = {
        "opening+adjust+흐름": d["opening_qty"] + d["adjust_qty"] + flows,
        "counted+흐름": d["counted_qty"] + flows,
        "opening+흐름(adjust 제외)": d["opening_qty"] + flows,
    }
    for label, calc in variants.items():
        out(f"- closing = {label}: 일치 {ratio((calc - d['closing_qty']).abs() < 1e-3)}")
    out(f"- counted = opening+adjust: 일치 {ratio((d['opening_qty'] + d['adjust_qty'] - d['counted_qty']).abs() < 1e-3)}")
    d2 = d.sort_values("date")
    prev = d2.groupby(["store_id", "ingredient_id"])["closing_qty"].shift()
    out(f"- 전일 closing = 당일 opening: {ratio((prev - d2['opening_qty']).abs().dropna() < 1e-3)}")
    if "inventory_lots_daily" in t:
        lots = t["inventory_lots_daily"].groupby(["date", "store_id", "ingredient_id"])["remaining_qty"].sum()
        m = d.set_index(["date", "store_id", "ingredient_id"])["closing_qty"].to_frame().join(lots, how="inner")
        out(f"- Σ lot 잔량 = closing_qty: {ratio((m['remaining_qty'] - m['closing_qty']).abs() < 1e-3)}")
    if "ingredients" in t and "inventory_lots_daily" in t:
        l = t["inventory_lots_daily"].merge(t["ingredients"][["ingredient_id", "shelf_life_days"]], on="ingredient_id")
        span = (l["last_use_date"] - l["receipt_date"]).dt.days + 1
        out(f"- last_use_date-receipt_date+1 = shelf_life_days: {ratio(span == l['shelf_life_days'])}")


def check_sales(t: dict[str, pd.DataFrame]) -> None:
    out("\n## 5. 판매 수량 관계")
    if "sales" not in t:
        return
    s = t["sales"]
    out(f"- demand = qty + lost: {ratio((s['qty'] + s['lost_qty'] - s['demand_qty']).abs() < 1e-6)}")
    out(f"- demand ≥ qty: {ratio(s['demand_qty'] >= s['qty'])}")
    out(f"- cancel ≤ qty: {ratio(s['cancel_qty'] <= s['qty'])}")
    out(f"- channel 값: {s['channel'].value_counts().to_dict()}")
    if "menus" in t:
        price = t["menus"].set_index("menu_id")["virtual_price"]
        calc = (s["qty"] - s["cancel_qty"]) * s["menu_id"].map(price)
        out(f"- sales_amount = (qty-cancel)×가격: {ratio((calc - s['sales_amount']).abs() < 1)} (프로모션 할인 시 불일치 가능)")
    if "menus" in t and "bom" in t:
        sets = t["menus"][t["menus"]["is_set"] == 1]["menu_id"]
        no_bom = sets[~sets.isin(t["bom"]["menu_id"])]
        out(f"- BOM 없는 세트 메뉴: {no_bom.tolist()}")
        no_bom_all = t["menus"][~t["menus"]["menu_id"].isin(t["bom"]["menu_id"])]["menu_id"]
        out(f"- BOM 없는 메뉴 전체: {no_bom_all.tolist()}")


def check_orders(t: dict[str, pd.DataFrame]) -> None:
    out("\n## 6. 발주·공급사")
    if "suppliers" in t:
        for _, r in t["suppliers"].iterrows():
            out(f"- {r['supplier_id']}: 발주 {r['order_days']} 마감 {r['order_cutoff']} LT {r['lead_time_days']}일 "
                f"입고 {r['delivery_days']} 최소 {r['min_order_amount']} / {r.get('note', '')}")
    if "purchase_orders" in t:
        po = t["purchase_orders"]
        out(f"- order_amount = qty×price: {ratio((po['order_qty'] * po['unit_price'] - po['order_amount']).abs() < 1)}")
        out(f"- order_type 값: {po['order_type'].value_counts().to_dict()}")
        lt = (po["expected_date"] - po["order_date"]).dt.days
        out(f"- 예정일-발주일 분포: {lt.value_counts().sort_index().to_dict()}")
        if "receipts" in t:
            no_rcpt = ~po["po_line_id"].isin(t["receipts"]["po_line_id"])
            out(f"- 입고 기록 없는 발주 라인: {ratio(no_rcpt)} (기간 말 입고 예정분 포함)")


def main() -> None:
    raw = raw_dir_from_argv()
    ensure_data(raw)
    t = load_all(raw)
    out(f"# 데이터 검증 리포트 ({raw})\n")
    for fn in (check_structure, check_fk, check_units, check_inventory, check_sales, check_orders):
        try:
            fn(t)
        except Exception as e:  # 한 검사가 실패해도 나머지는 진행
            out(f"- [오류] {fn.__name__}: {e!r}")
    REPORT_DIR.mkdir(exist_ok=True)
    (REPORT_DIR / "validation.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\n→ {REPORT_DIR / 'validation.md'}")


if __name__ == "__main__":
    main()
