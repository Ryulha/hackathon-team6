"""개발용 소형 합성 CSV 생성 → pipeline/fixtures/ (제공 데이터 아님! 배포 전 실제 데이터로 교체)

명세서 컬럼 구조만 맞춘 가짜 데이터로, 데이터 공개 전 파이프라인·화면을 끝까지 돌려보기 위한 용도.
리스트/요일 표기 등 실제 포맷은 모름 → 의도적으로 '월,수,금' / 'M01|M02' 를 섞어 파서 내성 확인.
실행: py pipeline/make_fixtures.py
"""
from __future__ import annotations

import random
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

OUT = Path(__file__).resolve().parent / "fixtures"
START, DAYS = date(2026, 8, 1), 61
WD = "월화수목금토일"
rng = random.Random(42)
sys.stdout.reconfigure(encoding="utf-8")

stores = pd.DataFrame([
    ["S01", "강남점", "오피스", "단독", 10, 22, "Y", "Y", 1.0],
    ["S02", "홍대점", "대학가", "단독", 11, 23, "Y", "N", 0.8],
], columns=["store_id", "store_name", "trade_area", "store_type", "open_hour", "close_hour",
            "dine_in", "delivery", "relative_size"])
menus = pd.DataFrame([
    ["M01", "불고기버거", "버거", 0, "", 6000],
    ["M02", "감자튀김", "사이드", 0, "", 2500],
    ["M03", "불고기세트", "세트", 1, "M01|M02", 8000],
], columns=["menu_id", "menu_name", "category", "is_set", "set_components", "virtual_price"])
ingredients = pd.DataFrame([
    ["I01", "번", "SP1", "개", "박스", 50, "냉동", 30, 1],
    ["I02", "불고기패티", "SP1", "g", "팩", 2000, "냉동", 20, 1],
    ["I03", "양상추", "SP2", "g", "박스", 1000, "냉장", 4, 1],
    ["I04", "감자", "SP2", "g", "박스", 5000, "냉동", 60, 1],
], columns=["ingredient_id", "ingredient_name", "supplier_id", "use_unit", "order_unit",
            "use_qty_per_order_unit", "storage", "shelf_life_days", "min_order_qty"])
bom = pd.DataFrame([
    ["M01", "I01", 1, "개"], ["M01", "I02", 100, "g"], ["M01", "I03", 20, "g"],
    ["M02", "I04", 150, "g"],
    ["M03", "I01", 1, "개"], ["M03", "I02", 100, "g"], ["M03", "I03", 20, "g"], ["M03", "I04", 150, "g"],
], columns=["menu_id", "ingredient_id", "qty_per_menu", "use_unit"])
suppliers = pd.DataFrame([
    ["SP1", "냉동물류", "월,수,금", "14:00", 2, "화,목,토", 100000, "냉동 전용"],
    ["SP2", "신선채소", "월,화,수,목,금,토", "11:00", 1, "화,수,목,금,토,일", 30000, ""],
], columns=["supplier_id", "supplier_name", "order_days", "order_cutoff", "lead_time_days",
            "delivery_days", "min_order_amount", "note"])
price = pd.DataFrame([
    ["I01", "2026-01-01", 15000], ["I02", "2026-01-01", 30000], ["I02", "2026-09-01", 32000],
    ["I03", "2026-01-01", 8000], ["I04", "2026-01-01", 12000],
], columns=["ingredient_id", "valid_from", "unit_price"])

dates = [START + timedelta(d) for d in range(DAYS)]
calendar = pd.DataFrame([[d.isoformat(), WD[d.weekday()], int(d == date(2026, 8, 15)),
                          "광복절" if d == date(2026, 8, 15) else ""] for d in dates],
                        columns=["date", "weekday", "is_holiday", "holiday_name"])
promotions = pd.DataFrame([["P01", "S01", "2026-09-10", "2026-09-16", "세트할인", "M03"]],
                          columns=["promo_id", "store_id", "start_date", "end_date", "promo_type", "target_menu"])
menu_availability = pd.DataFrame([
    ["S02", "M03", "2026-08-01", "2026-08-10", "미취급", "신메뉴 도입 전"],
    ["S02", "M03", "2026-08-11", "2026-09-30", "취급", ""],
], columns=["store_id", "menu_id", "start_date", "end_date", "status", "note"])

base = {"M01": 4, "M02": 3, "M03": 3}
sales_rows = []
for d in dates:
    for _, s in stores.iterrows():
        for m, b in base.items():
            if s.store_id == "S02" and m == "M03" and d < date(2026, 8, 11):
                continue
            promo = int(s.store_id == "S01" and date(2026, 9, 10) <= d <= date(2026, 9, 16))
            for h in range(s.open_hour, s.close_hour):
                lam = b * s.relative_size * (1.3 if d.weekday() >= 5 else 1) * (1.5 if promo and m == "M03" else 1)
                lam *= 2 if h in (12, 18) else 0.6
                demand = max(0, round(rng.gauss(lam, lam ** 0.5)))
                lost = 1 if demand and rng.random() < 0.02 else 0
                qty = demand - lost
                cancel = 1 if qty and rng.random() < 0.03 else 0
                sales_rows.append([d.isoformat(), h, s.store_id, m, "매장", demand, qty, cancel, lost,
                                   (qty - cancel) * int(menus.set_index("menu_id").virtual_price[m]), promo])
sales = pd.DataFrame(sales_rows, columns=["date", "hour", "store_id", "menu_id", "channel", "demand_qty",
                                          "qty", "cancel_qty", "lost_qty", "sales_amount", "promo_flag"])

# 재고: 소진 = (qty-cancel 아닌) qty 기준 BOM 소진으로 가정한 단순 시뮬레이션
cons = (sales.merge(bom, on="menu_id").assign(c=lambda x: x.qty * x.qty_per_menu)
        .groupby(["date", "store_id", "ingredient_id"]).c.sum())
ing = ingredients.set_index("ingredient_id")
po_rows, rc_rows, inv_rows, lot_rows = [], [], [], []
po_n = 0
for sid in stores.store_id:
    for iid in ing.index:
        conv, life = ing.use_qty_per_order_unit[iid], int(ing.shelf_life_days[iid])
        lots = [[f"L{sid}{iid}0", START, conv * 3]]  # [lot_id, receipt_date, qty]
        pending: dict[date, float] = {}
        for d in dates:
            opening = sum(l[2] for l in lots)
            recv = pending.pop(d, 0)
            if recv:
                lots.append([f"L{sid}{iid}{d:%m%d}", d, recv])
            need = cons.get((d.isoformat(), sid, iid), 0)
            used = 0.0
            for l in lots:  # FIFO
                take = min(l[2], need - used)
                l[2] -= take
                used += take
            waste = sum(l[2] for l in lots if (d - l[1]).days + 1 >= life)
            lots = [l for l in lots if l[2] > 0 and (d - l[1]).days + 1 < life]
            closing = sum(l[2] for l in lots)
            inv_rows.append([d.isoformat(), sid, iid, ing.use_unit[iid], opening, recv, 0, opening, used, waste,
                             0, 0, closing, 0, int(used < need), 0, 0, 0, 0])
            for l in lots:
                lot_rows.append([d.isoformat(), sid, iid, l[0], l[1].isoformat(),
                                 (l[1] + timedelta(life - 1)).isoformat(), l[2], ing.use_unit[iid]])
            sp = suppliers.set_index("supplier_id").loc[ing.supplier_id[iid]]
            if WD[d.weekday()] in sp.order_days and closing < need * 4:
                po_n += 1
                q = max(1, round(need * 5 / conv))
                eta = d + timedelta(int(sp.lead_time_days))
                pending[eta] = pending.get(eta, 0) + q * conv
                pid = f"PO{po_n:04d}"
                po_rows.append([pid, f"{pid}-1", d.isoformat(), "10:00", sid, sp.name, iid, q, ing.order_unit[iid],
                                15000, q * 15000, eta.isoformat(), "정기"])
                if eta <= dates[-1]:
                    rc_rows.append([f"R{po_n:04d}", f"{pid}-1", pid, sid, iid, eta.isoformat(), q, ing.order_unit[iid],
                                    q * conv, "완료", 0])

inventory = pd.DataFrame(inv_rows, columns=[
    "date", "store_id", "ingredient_id", "use_unit", "opening_qty", "received_qty", "adjust_qty", "counted_qty",
    "consumed_qty", "waste_qty", "transfer_in_qty", "transfer_out_qty", "closing_qty", "closing_value",
    "stockout_flag", "emergency_flag", "avg_consumption_7d", "low_stock_flag", "overstock_flag"])
inventory["avg_consumption_7d"] = (inventory.groupby(["store_id", "ingredient_id"]).consumed_qty
                                   .transform(lambda s: s.rolling(7, 1).mean()))
pos = pd.DataFrame(po_rows, columns=["po_id", "po_line_id", "order_date", "order_time", "store_id", "supplier_id",
                                     "ingredient_id", "order_qty", "order_unit", "unit_price", "order_amount",
                                     "expected_date", "order_type"])
receipts = pd.DataFrame(rc_rows, columns=["receipt_id", "po_line_id", "po_id", "store_id", "ingredient_id",
                                          "receipt_date", "received_qty", "order_unit", "received_use_qty",
                                          "status", "delay_days"])
lots_df = pd.DataFrame(lot_rows, columns=["date", "store_id", "ingredient_id", "lot_id", "receipt_date",
                                          "last_use_date", "remaining_qty", "use_unit"])
waste = inventory[inventory.waste_qty > 0][["date", "store_id", "ingredient_id", "waste_qty", "use_unit"]].assign(
    reason="사용기한 경과", waste_cost=0)
transfers = pd.DataFrame([["T001", "2026-09-05", 15, "S01", "S02", "I03", 500, "g", "긴급 지원"]],
                         columns=["transfer_id", "date", "hour", "from_store_id", "to_store_id", "ingredient_id",
                                  "qty", "use_unit", "reason"])
stockouts = inventory[inventory.stockout_flag == 1][["date", "store_id", "ingredient_id"]].assign(
    first_lost_hour=19, affected_menus="M01|M03", report="POS 자동")

files = {
    "01_stores.csv": stores, "02_menus.csv": menus, "03_ingredients.csv": ingredients, "04_bom.csv": bom,
    "05_suppliers.csv": suppliers, "06_ingredient_price_history.csv": price, "07_calendar.csv": calendar,
    "08_promotions.csv": promotions, "09_sales.csv": sales, "10_inventory_daily.csv": inventory,
    "11_purchase_orders.csv": pos, "12_receipts.csv": receipts, "13_waste.csv": waste,
    "14_transfers.csv": transfers, "15_menu_availability.csv": menu_availability,
    "16_inventory_lots_daily.csv": lots_df, "17_stockouts.csv": stockouts,
}
OUT.mkdir(exist_ok=True)
for name, df in files.items():
    df.to_csv(OUT / name, index=False, encoding="utf-8")
    print(f"- {name}: {len(df):,}행")
