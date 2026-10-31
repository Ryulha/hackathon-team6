"""재현 가능한 전처리·검증·EDA. python pipeline.py [--data DIR] [--out DIR]"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
KEY = ["date", "store_id", "ingredient_id"]
MENU_KEY = ["date", "store_id", "menu_id"]
PRIMARY = {
    1: ["store_id"], 2: ["menu_id"], 3: ["ingredient_id"],
    4: ["menu_id", "ingredient_id"], 5: ["supplier_id"],
    6: ["ingredient_id", "valid_from"], 7: ["date"], 8: ["promo_id"],
    9: ["date", "hour", "store_id", "menu_id", "channel"], 10: KEY,
    11: ["po_line_id"], 12: ["receipt_id"], 14: ["transfer_id"],
    15: ["store_id", "menu_id", "start_date"],
    16: KEY + ["lot_id"], 17: KEY,
}


def read_sources(data_dir):
    tables, manifest = {}, []
    for f in sorted(Path(data_dir).glob("*.csv")):
        n = int(f.name[:2])
        d = pd.read_csv(f, encoding="utf-8-sig")
        for c in d.columns:
            if c in {"date", "valid_from", "start_date", "end_date", "order_date", "expected_date", "receipt_date", "last_use_date"}:
                d[c] = pd.to_datetime(d[c], errors="raise")
        tables[n] = d
        manifest.append({"file": f.name, "rows": len(d), "columns": len(d.columns),
                         "sha256": hashlib.sha256(f.read_bytes()).hexdigest()})
    if set(tables) != set(range(1, 18)):
        raise ValueError("01~17 CSV 전체가 필요합니다.")
    return tables, manifest


def menu_panel(t):
    s = t[9].copy()
    s["net_sales_qty"] = s.qty - s.cancel_qty
    # 합성 데이터에만 존재하는 관측 불가능 수요. 실제 판매와 명시적으로 분리.
    s["synthetic_net_demand_qty"] = s.demand_qty - s.cancel_qty
    cols = ["demand_qty", "qty", "cancel_qty", "lost_qty", "net_sales_qty", "synthetic_net_demand_qty", "sales_amount"]
    daily = s.groupby(MENU_KEY, as_index=False)[cols].sum()
    grid = pd.MultiIndex.from_product([t[7].date, t[1].store_id, t[2].menu_id], names=MENU_KEY).to_frame(index=False)
    availability = t[15].copy()
    # 전체 미취급 행은 날짜가 비어 있다. 원본은 보존하고 파생 테이블에서만 기간을 설정.
    unavailable = availability.status.eq("미취급")
    availability.loc[unavailable, "start_date"] = availability.loc[unavailable, "start_date"].fillna(t[7].date.min())
    availability.loc[unavailable, "end_date"] = availability.loc[unavailable, "end_date"].fillna(t[7].date.max())
    pairs = grid[["store_id", "menu_id"]].drop_duplicates().merge(availability[["store_id", "menu_id"]].drop_duplicates(), how="left", indicator=True)
    if pairs._merge.eq("left_only").any():
        raise ValueError("메뉴 취급 정보가 없는 매장·메뉴 조합입니다.")
    a = grid.merge(availability, on=["store_id", "menu_id"], how="left", validate="many_to_many")
    a = a[(a.date >= a.start_date) & (a.date <= a.end_date)]
    if a.duplicated(MENU_KEY).any():
        raise ValueError("메뉴 취급 기간이 중복됩니다. 임의 제거하지 않습니다.")
    panel = grid.merge(a[MENU_KEY + ["status"]], on=MENU_KEY, how="left", validate="one_to_one")
    # 명세서: 취급 기간 밖은 미취급. 단품 취급 상태를 세트에 전파하지 않음.
    panel["status"] = panel.status.fillna("미취급")
    panel = panel.merge(daily, on=MENU_KEY, how="left", validate="one_to_one")
    panel[cols] = panel[cols].fillna(0)
    panel["available"] = panel.status.eq("취급")
    panel["observation_state"] = np.select(
        [~panel.available, panel.lost_qty.gt(0), panel.net_sales_qty.eq(0)],
        ["미취급", "품절 손실 발생", "취급 중 판매 없음"], default="판매 발생")
    panel["promo_target"] = False
    for p in t[8].itertuples():
        mask = panel.store_id.eq(p.store_id) & panel.date.between(p.start_date, p.end_date) & panel.menu_id.isin(p.target_menu.split(","))
        panel.loc[mask, "promo_target"] = True
    return panel.merge(t[2][["menu_id", "menu_name", "category"]], on="menu_id", validate="many_to_one")


def ingredient_panel(t, menus):
    # BOM 전개는 메뉴 일집계에서 한 번만 수행. 세트 구성 재전개 금지.
    b = menus.merge(t[4][["menu_id", "ingredient_id", "qty_per_menu"]], on="menu_id", validate="many_to_many")
    for src, dst in [("net_sales_qty", "bom_consumed_qty"), ("synthetic_net_demand_qty", "synthetic_need_qty"), ("lost_qty", "synthetic_lost_need_qty")]:
        b[dst] = b[src] * b.qty_per_menu
    usage = b.groupby(KEY, as_index=False)[["bom_consumed_qty", "synthetic_need_qty", "synthetic_lost_need_qty"]].sum()
    out = t[10].merge(usage, on=KEY, how="left", validate="one_to_one")
    out = out.merge(t[1][["store_id", "store_name", "trade_area"]], on="store_id", validate="many_to_one")
    ingcols = [c for c in t[3] if c != "use_unit"]
    out = out.merge(t[3][ingcols], on="ingredient_id", validate="many_to_one")
    out = out.merge(t[7], on="date", validate="many_to_one")
    w = t[13].groupby(KEY, as_index=False).waste_cost.sum()
    out = out.merge(w, on=KEY, how="left", validate="one_to_one")
    r = t[12].rename(columns={"receipt_date": "date"}).groupby(KEY, as_index=False).received_use_qty.sum()
    out = out.merge(r, on=KEY, how="left", validate="one_to_one")
    po = t[11].rename(columns={"order_date": "date"}).copy()
    po["regular_amount"] = po.order_amount.where(po.order_type.eq("정기"), 0)
    po["emergency_amount"] = po.order_amount.where(po.order_type.eq("긴급"), 0)
    po = po.groupby(KEY, as_index=False)[["order_qty", "order_amount", "regular_amount", "emergency_amount"]].sum()
    out = out.merge(po, on=KEY, how="left", validate="one_to_one")
    zeros = ["waste_cost", "received_use_qty", "order_qty", "order_amount", "regular_amount", "emergency_amount"]
    out[zeros] = out[zeros].fillna(0)
    # 마감 로트를 동일 단위로 집계한 뒤 결합해 행 증식을 방지.
    lots = t[16].assign(expiring_3d_qty=lambda x: x.remaining_qty.where(x.last_use_date <= x.date + pd.Timedelta(days=3), 0))
    lots = lots.groupby(KEY, as_index=False).agg(lot_closing_qty=("remaining_qty", "sum"), closing_expiring_3d_qty=("expiring_3d_qty", "sum"))
    out = out.merge(lots, on=KEY, how="left", validate="one_to_one")
    out[["lot_closing_qty", "closing_expiring_3d_qty"]] = out[["lot_closing_qty", "closing_expiring_3d_qty"]].fillna(0)
    # 해당 일자 이하 최신 유효 단가만 적용.
    out = pd.merge_asof(out.sort_values("date"), t[6].sort_values("valid_from"), left_on="date", right_on="valid_from", by="ingredient_id", direction="backward")
    out["unit_cost_use"] = out.unit_price / out.use_qty_per_order_unit
    out["consumed_cost"] = out.consumed_qty * out.unit_cost_use
    out["synthetic_lost_need_cost"] = out.synthetic_lost_need_qty * out.unit_cost_use
    out["inventory_balance_diff"] = out.closing_qty - (out.opening_qty + out.received_qty + out.adjust_qty + out.transfer_in_qty - out.transfer_out_qty - out.consumed_qty - out.waste_qty)
    out["bom_consumption_diff"] = out.consumed_qty - out.bom_consumed_qty
    out = out.sort_values(["store_id", "ingredient_id", "date"]).reset_index(drop=True)
    g = out.groupby(["store_id", "ingredient_id"], sort=False)
    out["consumed_avg_7d_past"] = g.consumed_qty.transform(lambda x: x.shift(1).rolling(7, min_periods=1).mean())
    out["consumed_avg_28d_past"] = g.consumed_qty.transform(lambda x: x.shift(1).rolling(28, min_periods=1).mean())
    out["stockout_days_7d_past"] = g.stockout_flag.transform(lambda x: x.shift(1).rolling(7, min_periods=1).sum())
    out["closing_qty_prev"] = g.closing_qty.shift(1)
    out["stock_days_at_open"] = out.counted_qty / out.consumed_avg_7d_past.where(out.consumed_avg_7d_past.gt(0))
    return out


def validate(t, menu, panel):
    checks = []

    def add(name, bad, detail="", severity="error"):
        bad = int(bad)
        checks.append({"check": name, "status": "PASS" if bad == 0 else ("WARN" if severity == "warning" else "FAIL"),
                       "issue_count": bad, "detail": detail})

    optional = {2: ["set_components"], 7: ["holiday_name"], 15: ["note"]}
    for n, d in t.items():
        required = d.drop(columns=optional.get(n, [])).copy()
        if n == 15:
            for c in ["start_date", "end_date"]:
                required.loc[required.status.eq("미취급"), c] = required.loc[required.status.eq("미취급"), c].fillna(t[7].date.min())
        add(f"{n:02d} 필수값 누락", required.isna().sum().sum())
        if n in PRIMARY:
            add(f"{n:02d} 기본키 중복", d.duplicated(PRIMARY[n]).sum())
        # 사유가 다른 두 폐기 기록은 모두 유효하므로 전체 행 중복도 자동 삭제하지 않음.
        add(f"{n:02d} 완전 중복행", d.duplicated().sum())
        if n in {9, 10, 13, 14, 16, 17}:
            add(f"{n:02d} 기준일 범위", (~d.date.isin(t[7].date)).sum())
        for col, target in [("store_id", 1), ("from_store_id", 1), ("to_store_id", 1), ("menu_id", 2), ("ingredient_id", 3), ("supplier_id", 5), ("po_line_id", 11)]:
            if col in d and not (n == target and col in PRIMARY.get(n, [])):
                key = "store_id" if col.endswith("store_id") else col
                add(f"{n:02d} {col} 연결", (~d[col].isin(t[target][key])).sum())
    s, i = t[9], t[10]
    add("실제 주문 = 수요 - 품절손실", (s.qty != s.demand_qty - s.lost_qty).sum())
    add("취소량은 주문량 이하", (s.cancel_qty > s.qty).sum())
    add("판매 수량 음수", (s[["demand_qty", "qty", "cancel_qty", "lost_qty"]] < 0).sum().sum())
    prices = s.merge(t[2][["menu_id", "virtual_price"]], on="menu_id", validate="many_to_one")
    add("매출 = 확정판매 × 메뉴가격", (prices.sales_amount != (prices.qty - prices.cancel_qty) * prices.virtual_price).sum())
    add("기말 재고 수지", panel.inventory_balance_diff.abs().gt(1e-6).sum())
    add("실사 재고 수지", (i.counted_qty != i.opening_qty + i.received_qty + i.adjust_qty).sum())
    add("BOM 환산 소진 일치", panel.bom_consumption_diff.abs().gt(1e-6).sum())
    add("일별 로트 합계 = 기말재고", (panel.lot_closing_qty != panel.closing_qty).sum())
    add("전일 기말 = 당일 기초", (panel.closing_qty_prev.notna() & panel.opening_qty.ne(panel.closing_qty_prev)).sum())
    add("입고 상세 = 재고 입고량", (panel.received_use_qty != panel.received_qty).sum())
    w = t[13].groupby(KEY, as_index=False).waste_qty.sum().rename(columns={"waste_qty": "detail_qty"})
    z = i.merge(w, on=KEY, how="left", validate="one_to_one").fillna({"detail_qty": 0})
    add("폐기 상세 = 재고 폐기량", (z.waste_qty != z.detail_qty).sum())
    for col, store_col in [("transfer_in_qty", "to_store_id"), ("transfer_out_qty", "from_store_id")]:
        tr = t[14].rename(columns={store_col: "store_id"}).groupby(KEY, as_index=False).qty.sum()
        z = i.merge(tr, on=KEY, how="left", validate="one_to_one").fillna({"qty": 0})
        add(f"이동 상세 = {col}", (z[col] != z.qty).sum())
    for n in [4, 10, 12, 13, 14, 16]:
        d = t[n]
        z = d.merge(t[3][["ingredient_id", "use_unit"]], on="ingredient_id", suffixes=("", "_master"), validate="many_to_one") if "use_unit" in d else None
        if z is not None:
            add(f"{n:02d} 사용 단위 일치", z.use_unit.ne(z.use_unit_master).sum())
    rc = t[12].merge(t[3][["ingredient_id", "use_qty_per_order_unit", "order_unit"]], on="ingredient_id", suffixes=("", "_master"), validate="many_to_one")
    add("입고 포장 단위 일치", rc.order_unit.ne(rc.order_unit_master).sum())
    add("입고 포장 환산", (rc.received_use_qty != rc.received_qty * rc.use_qty_per_order_unit).sum())
    add("발주 라인 금액", (t[11].order_amount != t[11].order_qty * t[11].unit_price).sum())
    order = t[11].merge(t[3][["ingredient_id", "supplier_id", "order_unit", "min_order_qty"]], on="ingredient_id", suffixes=("", "_master"), validate="many_to_one")
    add("발주 공급사 일치", order.supplier_id.ne(order.supplier_id_master).sum())
    add("발주 포장 단위 일치", order.order_unit.ne(order.order_unit_master).sum())
    add("발주 수량 정수·최소수량", ((order.order_qty % 1 != 0) | order.order_qty.lt(order.min_order_qty)).sum())
    order = pd.merge_asof(order.sort_values("order_date"), t[6].sort_values("valid_from"), left_on="order_date", right_on="valid_from", by="ingredient_id", direction="backward", suffixes=("", "_effective"))
    add("발주일 유효 단가 일치", order.unit_price.ne(order.unit_price_effective).sum())
    recorded = i.merge(t[17][KEY].assign(recorded_flag=1), on=KEY, how="left", validate="one_to_one").fillna({"recorded_flag": 0})
    add("품절 내역 = 재고 품절 표시", recorded.stockout_flag.ne(recorded.recorded_flag).sum())
    missing = t[11][~t[11].po_line_id.isin(t[12].po_line_id)]
    add("기간 내 도착 예정이나 입고 없는 발주", missing.expected_date.le(t[7].date.max()).sum())
    add("기간 밖 도착 예정 발주", len(missing[missing.expected_date > t[7].date.max()]), "데이터 종료 후 도착 예정이므로 미입고 오류가 아님", "warning")
    add("미취급 기간 판매", ((~menu.available) & menu.qty.gt(0)).sum())
    add("일별 패널 행수", abs(len(panel) - len(t[7]) * len(t[1]) * len(t[3])))
    add("일별 패널 기본키", panel.duplicated(KEY).sum())
    add("적용 단가 누락", panel.unit_price.isna().sum())
    add("미래 단가 사용", panel.valid_from.gt(panel.date).sum())
    add("음수 기말재고", i.closing_qty.lt(0).sum())
    add("마감 후 만료 로트 잔량", ((t[16].last_use_date <= t[16].date) & t[16].remaining_qty.gt(0)).sum())
    return pd.DataFrame(checks)


def eda_tables(t, menu, panel):
    store = menu.groupby(["store_id"], as_index=False).agg(net_sales_qty=("net_sales_qty", "sum"), demand_qty=("demand_qty", "sum"), lost_qty=("lost_qty", "sum"), sales_amount=("sales_amount", "sum"))
    store["lost_rate"] = store.lost_qty / store.demand_qty
    v = panel.groupby("store_id", as_index=False).agg(waste_cost=("waste_cost", "sum"), consumed_cost=("consumed_cost", "sum"), stockout_item_days=("stockout_flag", "sum"), emergency_amount=("emergency_amount", "sum"), inventory_item_days=("ingredient_id", "size"))
    store = store.merge(v, on="store_id", validate="one_to_one").merge(t[1][["store_id", "store_name"]], on="store_id", validate="one_to_one")
    store["waste_cost_share"] = store.waste_cost / (store.waste_cost + store.consumed_cost)
    waste = t[13].groupby(["ingredient_id", "reason"], as_index=False).agg(waste_qty=("waste_qty", "sum"), waste_cost=("waste_cost", "sum"))
    waste = waste.merge(t[3][["ingredient_id", "ingredient_name", "use_unit"]], on="ingredient_id", validate="many_to_one").sort_values("waste_cost", ascending=False)
    # 품절 메뉴 손실을 식자재 여러 개에 중복 귀속하지 않도록 판매손실은 메뉴 테이블에서 집계.
    lost = menu.groupby(["store_id", "menu_id", "menu_name"], as_index=False)[["demand_qty", "lost_qty"]].sum()
    lost["lost_rate"] = lost.lost_qty / lost.demand_qty.replace(0, np.nan)
    lost = lost[lost.lost_qty > 0].sort_values("lost_qty", ascending=False)
    daily = menu.groupby(["date", "store_id"], as_index=False).net_sales_qty.sum().merge(t[7], on="date", validate="many_to_one")
    weekday = daily.groupby(["store_id", "weekday"], as_index=False).agg(avg_net_sales=("net_sales_qty", "mean"), days=("date", "size"))
    order = {x: n for n, x in enumerate("월화수목금토일")}
    weekday["weekday_order"] = weekday.weekday.map(order)
    weekday = weekday.sort_values(["store_id", "weekday_order"])
    monthly = menu.assign(month=menu.date.dt.strftime("%Y-%m")).groupby(["month", "store_id"], as_index=False)[["net_sales_qty", "lost_qty", "sales_amount"]].sum()
    waste_items = waste.groupby(["ingredient_id", "ingredient_name"], as_index=False).waste_cost.sum().sort_values("waste_cost", ascending=False)
    reasons = t[13].groupby("reason", as_index=False).waste_cost.sum().sort_values("waste_cost", ascending=False)
    reasons["cost_share"] = reasons.waste_cost / reasons.waste_cost.sum()
    reasons["management_scope"] = np.where(reasons.reason.eq("소비기한 경과"), "발주·재고 운용 개선 검토", "보관·품질·조리 운영 관리")
    expiry = waste[waste.reason.eq("소비기한 경과")].groupby(["ingredient_id", "ingredient_name"], as_index=False).waste_cost.sum().sort_values("waste_cost", ascending=False)
    lettuce = panel[panel.ingredient_name.eq("양상추")].groupby(["store_id", "store_name"], as_index=False).agg(avg_daily_consumed_qty=("consumed_qty", "mean"), observed_days=("date", "nunique"), pack_qty=("use_qty_per_order_unit", "first"), shelf_life_days=("shelf_life_days", "first"))
    lettuce["one_pack_days"] = lettuce.pack_qty / lettuce.avg_daily_consumed_qty.replace(0, np.nan)
    lettuce_waste = t[13][t[13].reason.eq("소비기한 경과") & t[13].ingredient_id.eq("I009")].groupby("store_id", as_index=False).agg(expiry_waste_cost=("waste_cost", "sum"), expiry_waste_events=("waste_cost", "size"))
    lettuce = lettuce.merge(lettuce_waste, on="store_id", how="left", validate="one_to_one")
    lettuce[["expiry_waste_cost", "expiry_waste_events"]] = lettuce[["expiry_waste_cost", "expiry_waste_events"]].fillna(0).astype(int)
    summary = {"period_start": str(t[7].date.min().date()), "period_end": str(t[7].date.max().date()),
               "store_count": len(t[1]), "ingredient_count": len(t[3]), "menu_count": len(t[2]),
               "sales_rows": len(t[9]), "panel_rows": len(panel),
               "net_sales_qty": int(menu.net_sales_qty.sum()), "lost_qty": int(menu.lost_qty.sum()),
               "lost_rate": float(menu.lost_qty.sum() / menu.demand_qty.sum()),
               "waste_cost": int(t[13].waste_cost.sum()), "stockout_item_days": int(panel.stockout_flag.sum()),
               "top_waste_items": waste_items.head(5).to_dict("records"),
               "waste_reasons": reasons.to_dict("records"),
               "expiry_waste_cost": int(expiry.waste_cost.sum()),
               "top_expiry_items": expiry.head(5).to_dict("records"),
               "lettuce_pack_coverage": lettuce.to_dict("records"),
               "stores": store.to_dict("records")}
    return {"store_summary": store, "waste_by_reason": waste, "waste_reason_summary": reasons, "lettuce_pack_coverage": lettuce, "lost_sales_by_menu": lost, "weekday_sales": weekday, "monthly_sales": monthly}, summary


def write_report(out, summary, eda, checks):
    h = html.escape
    total = summary["waste_cost"]
    top = summary["top_expiry_items"]
    expiry_cost = summary["expiry_waste_cost"]
    expiry_share = expiry_cost / total if total else 0
    lettuce = summary["lettuce_pack_coverage"]
    lettuce_comparison = ", ".join(f"{x['store_name']} {x['one_pack_days']:.2f}일치" for x in lettuce)
    lettuce_expiry = next((x["waste_cost"] for x in top if x["ingredient_name"] == "양상추"), 0)
    insights = [
        f"폐기비용 {total:,}원 중 소비기한 경과는 {expiry_cost:,}원({expiry_share:.1%})입니다. 발주·재고 운용 개선의 우선 검토 대상으로 구분하고, 나머지 {1-expiry_share:.1%}는 보관·품질·조리 운영 관리로 분리하세요. 치즈·토마토의 소비기한 경과 폐기는 각각 0원이므로 발주 개선 효과로 연결하지 않습니다.",
        f"양상추 1박스는 8kg으로, 기간 평균 실제 소진량 기준 {lettuce_comparison}입니다. 같은 한 박스라도 작은 매장에서는 더 오래 갑니다. 매장별 잔량·입고 예정량과 5일의 소비기한을 함께 확인해 발주 수량을 검토하세요. 실제 소비기한 경과 폐기는 B·C 매장에서만 발생했고 A는 0원입니다.",
        f"양상추의 소비기한 경과 폐기는 {lettuce_expiry:,}원으로 해당 사유 폐기의 {lettuce_expiry/expiry_cost:.1%}입니다. 먼저 양상추의 사용기한 임박 재고와 다음 입고 시점을 점검하고, 과잉 위험이 보이면 수량 수정·발주 보류·매장 이동을 검토하세요."
    ]
    bars = "".join(f'<div class="barrow"><span>{h(x["ingredient_name"])}</span><div><i style="width:{100*x["waste_cost"]/top[0]["waste_cost"]:.1f}%"></i></div><b>{x["waste_cost"]:,.0f}원</b></div>' for x in top) if top else "소비기한 경과 폐기 기록이 없습니다."
    reasons = eda["waste_reason_summary"].rename(columns={"reason": "폐기 사유", "waste_cost": "가상 폐기비용(원)", "cost_share": "비용 비중", "management_scope": "관리 방향"}).copy()
    reasons["가상 폐기비용(원)"] = reasons["가상 폐기비용(원)"].map(lambda x: f"{x:,.0f}")
    reasons["비용 비중"] = reasons["비용 비중"].map(lambda x: f"{x:.1%}")
    coverage = eda["lettuce_pack_coverage"][["store_name", "avg_daily_consumed_qty", "one_pack_days", "shelf_life_days", "expiry_waste_cost", "expiry_waste_events"]].rename(columns={"store_name": "매장", "avg_daily_consumed_qty": "하루 평균 소진량", "one_pack_days": "1박스 = 며칠치", "shelf_life_days": "소비기한", "expiry_waste_cost": "소비기한 경과 폐기비용", "expiry_waste_events": "발생 횟수"}).copy()
    coverage["하루 평균 소진량"] = coverage["하루 평균 소진량"].map(lambda x: f"{x/1000:.2f}kg")
    coverage["1박스 = 며칠치"] = coverage["1박스 = 며칠치"].map(lambda x: f"{x:.2f}일치")
    coverage["소비기한"] = coverage["소비기한"].map(lambda x: f"{x}일")
    coverage["소비기한 경과 폐기비용"] = coverage["소비기한 경과 폐기비용"].map(lambda x: f"{x:,.0f}원")
    coverage["발생 횟수"] = coverage["발생 횟수"].map(lambda x: f"{x:,.0f}회")
    stores = eda["store_summary"][["store_name", "net_sales_qty", "lost_qty", "lost_rate", "waste_cost", "stockout_item_days"]].rename(columns={"store_name": "매장", "net_sales_qty": "확정 판매(메뉴 개)", "lost_qty": "품절 손실(메뉴 개)", "lost_rate": "수요 대비 손실률", "waste_cost": "가상 폐기비용(원)", "stockout_item_days": "품절 품목·일"})
    stores["수요 대비 손실률"] = stores["수요 대비 손실률"].map(lambda x: f"{x:.3%}")
    for c in ["확정 판매(메뉴 개)", "품절 손실(메뉴 개)", "가상 폐기비용(원)", "품절 품목·일"]:
        stores[c] = stores[c].map(lambda x: f"{x:,.0f}")
    body = f'''<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>식자재 운영 분석 보고서</title>
<style>body{{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;background:#f5f4ef;color:#24322b;margin:0;line-height:1.65}}main{{max-width:1100px;margin:auto;padding:44px 24px}}h1{{font-size:32px;margin:8px 0}}h2{{font-size:22px;margin-top:36px}}.eyebrow{{color:#566b5d;font-weight:700}}.lead{{font-size:18px}}.cards{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}}.card,section{{background:white;border:1px solid #e1e5df;border-radius:14px;padding:22px}}.card b{{display:block;font-size:28px;color:#255c40}}.muted{{color:#617267;font-size:14px}}li{{margin:12px 0}}table{{border-collapse:collapse;width:100%;font-size:14px}}td,th{{padding:12px 9px;border-bottom:1px solid #e1e5df;text-align:right}}th{{background:#edf2ec}}td:first-child,th:first-child{{text-align:left}}.tablewrap{{overflow-x:auto}}.barrow{{display:grid;grid-template-columns:140px 1fr 110px;gap:14px;align-items:center;margin:14px 0}}.barrow div{{background:#edf2ec;height:20px;border-radius:4px}}i{{display:block;background:#418361;height:20px;border-radius:4px}}.barrow b{{text-align:right;font-size:14px}}details{{background:white;border-radius:12px;padding:18px;margin-top:20px}}summary{{cursor:pointer;font-weight:700}}a{{color:#255c40}}@media(max-width:1000px){{.cards{{grid-template-columns:repeat(2,1fr)}}.barrow{{grid-template-columns:95px 1fr 90px;gap:8px}}main{{padding:24px 16px}}h1{{font-size:26px}}}}@media print{{body{{background:white}}main{{padding:0}}.card,section{{break-inside:avoid}}details{{display:none}}}}</style>
<main><div class="eyebrow">크라이치즈버거 · 식자재 관리 및 발주</div><h1>어느 품목부터 관리하면 좋을까요?</h1>
<p class="lead">판매·재고·폐기 이력을 연결해, 발주 판단에 필요한 항목을 정리했습니다.</p>
<p class="muted">분석 기간 {summary['period_start']} ~ {summary['period_end']} · 합성 데이터, 가상 금액 · 계산 기반 EDA 보고서이며 LLM 생성 보고서가 아닙니다.</p>
<div class="cards"><div class="card">분석용 데이터<b>{summary['panel_rows']:,}</b><span class="muted">날짜 × 매장 × 식자재</span></div><div class="card">가상 폐기비용<b>{total:,}원</b><span class="muted">기간 전체, 3개 매장</span></div><div class="card">품절 판매손실<b>{summary['lost_qty']:,}개</b><span class="muted">주문 메뉴 수량 기준</span></div><div class="card">데이터 검증<b>{int(checks.status.eq('FAIL').sum())}건 오류</b><span class="muted">{len(checks)}개 항목 검사 · {int(checks.status.eq('WARN').sum())}개 안내</span></div></div>
<h2>운영에 먼저 반영할 사항</h2><section><ol>{''.join('<li>'+h(x)+'</li>' for x in insights)}</ol></section>
<h2>폐기 사유에 따라 대응을 구분하세요</h2><section class="tablewrap">{reasons.to_html(index=False, border=0)}<p class="muted">비중은 폐기 수량이 아닌 가상 폐기비용 기준입니다. 소비기한 경과는 발주·재고 운용으로 개선할 수 있는지 검토할 범위이며, 전액 절감 가능액이나 과다 발주만으로 발생했다는 뜻은 아닙니다. 보관·품질·조리 폐기는 이 앱의 발주 개선 효과 산정에서 제외합니다.</p></section>
<h2>소비기한 경과 폐기부터 확인하세요</h2><section>{bars}<p class="muted">소비기한 경과 사유만 집계했습니다. 총폐기 상위인 슬라이스 치즈·토마토는 이 사유의 폐기가 각각 0원입니다. 원인별 구분 없이 총폐기 감소를 발주 개선 성과로 주장하지 않습니다.</p></section>
<h2>양상추 한 박스는 매장마다 며칠치일까요?</h2><section class="tablewrap">{coverage.to_html(index=False, border=0)}<p class="muted">1박스 8,000g ÷ 분석 기간의 매장별 하루 평균 실제 소진량. 모든 영업일(273일)을 포함한 사후 평균이며, 품절로 줄어든 소진도 포함합니다. 소비기한 경과 폐기비용·발생 횟수는 13_waste.csv에서 reason=소비기한 경과, ingredient_id=I009인 기록을 매장별로 집계했습니다. 발생 횟수는 해당 폐기 내역 행 수이며, 기록상 매장별 발생일 수와 같습니다. 비용은 가상 원화입니다. 현재 잔량·확정 수요·앞으로 남을 양을 뜻하지 않습니다. 1박스가 하루치보다 크다는 사실만으로 소비기한 경과를 단정할 수 없습니다.</p></section>
<h2>매장별 현황</h2><section class="tablewrap">{stores.to_html(index=False, border=0)}<p class="muted">손실률 = 품절 손실 메뉴 수량 ÷ 품절 전 수요 메뉴 수량. 품절 품목·일은 동일 날짜의 여러 품목을 각각 셉니다.</p></section>
<h2>발주 도우미와 연결하는 방법</h2><section><ol><li>매장과 기준일을 선택합니다.</li><li>입고 전 품절 위험과 사용기한 임박 품목을 먼저 확인합니다.</li><li>발주 수량을 수정하면 최신 수량으로 부족·폐기 전망을 다시 계산합니다.</li><li>AI 브리핑으로 이유를 확인하고 발주서를 내려받습니다.</li></ol></section>
<details><summary>검증 내역과 데이터 정의 보기</summary><div class="tablewrap">{checks.to_html(index=False,border=0)}</div><p>첫날 과거 평균은 이력이 없으므로 빈값입니다. 당일 소진·폐기·기말·품절·수요는 사후 분석용이며 아침 예측 입력에 쓰지 않습니다. 당일 실사재고는 07시 입고와 실사 이후 사용할 수 있습니다.</p><p>기간 밖 입고 예정 25건은 오류가 아닙니다. 로트 합계는 일별 재고와 일치하나 명세서에 알려진 세부 로트 전개 차이는 재생 검증 범위 밖입니다. 취소가 없었을 잠재 수요는 제공되지 않으며 합성 보정수요는 demand_qty − cancel_qty로 정의했습니다.</p></details>
<p class="muted">원본: 제공 CSV 01~17 및 행사 당일 데이터명세서. 전처리와 집계는 pipeline.py로 재실행할 수 있습니다. 원본 데이터와 파생 상세 데이터는 공개 저장소에 올리지 마세요.</p></main></html>'''
    (out / "운영_분석_보고서.html").write_text(body, encoding="utf-8")
    summary["insights"] = insights


def dictionary(panel):
    notes = {
        "date": ("공통", "기준일, 한 행은 날짜×매장×식자재"),
        "counted_qty": ("당일 아침", "입고·실사 이후 사용 가능 재고, use_unit"),
        "opening_qty": ("당일 아침", "07시 입고 전 기초재고, use_unit"),
        "received_qty": ("당일 아침", "07시 입고량, use_unit"),
        "adjust_qty": ("당일 아침", "실사 조정량, use_unit"),
        "consumed_avg_7d_past": ("과거만", "당일 제외 이전 7일 실제 소진 평균, 첫날 미정"),
        "consumed_avg_28d_past": ("과거만", "당일 제외 이전 28일 실제 소진 평균"),
        "stockout_days_7d_past": ("과거만", "당일 제외 이전 7일 품절 품목·일"),
        "closing_qty_prev": ("과거만", "전일 마감재고, 첫날 미정"),
        "stock_days_at_open": ("당일 아침", "실사재고÷과거7일 소진평균, 평균0 또는 이력없음이면 미정"),
        "synthetic_need_qty": ("사후·합성 전용", "(품절 전 수요−실제 취소)×세트 포함 해당 메뉴 BOM, use_unit"),
        "synthetic_lost_need_qty": ("사후·합성 전용", "품절손실×BOM, 복수 식자재에 중복 귀속 가능. 품목 간 합산 금지"),
        "synthetic_lost_need_cost": ("사후·합성 전용", "손실소요량×사용단위당 가상 단가. 손실매출 아님, 합산 금지"),
        "avg_consumption_7d": ("사후", "제공 평균: 당일 포함, 예측 입력 사용 금지"),
        "bom_consumed_qty": ("사후", "(실제 주문−취소)×해당 메뉴 BOM, use_unit"),
        "consumed_cost": ("사후", "실제 소진×당일 사용단위당 가상 단가"),
        "waste_cost": ("사후", "폐기 내역 가상 비용 합계, 원"),
        "unit_price": ("기준일 단가", "발주 포장단위당 가상 원화, valid_from≤date 최신"),
        "unit_cost_use": ("기준일 단가", "unit_price÷use_qty_per_order_unit, 원/use_unit"),
        "order_qty": ("사후", "당일 정기·긴급 발주 수량 합계, order_unit"),
        "order_amount": ("사후", "당일 발주 가상 금액 합계, 원"),
        "regular_amount": ("사후", "당일 정기발주 가상 금액, 원"),
        "emergency_amount": ("사후", "당일 긴급발주 가상 금액, 원"),
        "received_use_qty": ("당일 아침", "실제 입고 내역 집계, use_unit"),
        "lot_closing_qty": ("사후", "마감 로트 잔량 합계, use_unit"),
        "min_order_qty": ("공통·마스터", "품목별 최소 발주 수량, order_unit"),
        "use_qty_per_order_unit": ("공통·마스터", "발주 단위 1개당 사용 단위 수량"),
        "shelf_life_days": ("공통·마스터", "입고일 포함 사용가능 일수"),
        "order_days": ("공통·마스터", "정기발주 가능 요일 목록"),
        "order_cutoff": ("공통·마스터", "정기발주 마감, 정각 제외"),
        "lead_time_days": ("공통·마스터", "발주 후 입고까지 일수"),
        "delivery_days": ("공통·마스터", "입고 가능한 요일"),
        "min_order_amount": ("공통·마스터", "공급사 발주서별 최소 가상 금액, 원"),
        "closing_expiring_3d_qty": ("사후", "당일 마감 로트 중 다음 3일 이내 사용기한 도래 잔량"),
        "inventory_balance_diff": ("검증", "기말−재고수지, 정상 0"),
        "bom_consumption_diff": ("검증", "재고소진−BOM환산소진, 정상 0"),
    }
    # 사용자가 검토한 원본·연결·단위 정의를 재실행 시에도 보존.
    notes.update({'store_id': ('공통·마스터',
              '10_inventory_daily.csv의 store_id를 행별로 그대로 유지한 매장 연결 키. 이 값으로 01_stores.csv의 store_id와 병합하며 수치 '
              '계산·집계 없음. 단위: 매장 ID(문자, S01~S03); use_unit/order_unit/원에 해당하지 않음.'),
 'ingredient_id': ('공통·마스터',
                   '10_inventory_daily.csv의 ingredient_id를 행별로 그대로 유지한 식자재 연결 키. 이 값으로 03_ingredients.csv의 '
                   'ingredient_id 및 식자재별 집계·단가 이력을 연결하며 수치 계산 없음. 단위: 식자재 ID(문자, I001~I022); '
                   'use_unit/order_unit/원에 해당하지 않음.'),
 'use_unit': ('공통·마스터',
              '10_inventory_daily.csv의 use_unit을 그대로 유지. 03_ingredients.csv 및 관련 이력의 동일 식자재 use_unit과 일치하는지 '
              '검증하며 환산·집계 없음. 단위: 사용 단위명(개/g/ml/매/캔/장 등); 해당 행의 재고·소진·폐기·이동 수량을 해석하는 기준으로 order_unit 및 원과 '
              '구분.'),
 'store_name': ('공통·마스터',
                '01_stores.csv의 store_name을 store_id 기준 다대일 병합으로 연결. 매장별 일별 재고 행마다 동일 명칭을 부여하며 계산·집계 없음. 단위: '
                '매장명(문자); use_unit/order_unit/원에 해당하지 않음.'),
 'trade_area': ('공통·마스터',
                '01_stores.csv의 trade_area를 store_id 기준 다대일 병합으로 연결. 원본 상권 분류를 그대로 사용하며 계산·집계 없음. 단위: 상권 '
                '유형(범주형 문자); use_unit/order_unit/원에 해당하지 않음.'),
 'ingredient_name': ('공통·마스터',
                     '03_ingredients.csv의 ingredient_name을 ingredient_id 기준 다대일 병합으로 연결. 원본 식자재명을 그대로 사용하며 '
                     '계산·집계 없음. 단위: 식자재명(문자); use_unit/order_unit/원에 해당하지 않음.'),
 'supplier_id': ('공통·마스터',
                 '03_ingredients.csv의 supplier_id를 ingredient_id 기준 다대일 병합으로 연결한 식자재별 공급사 키. '
                 'decision_features_daily.csv에서는 이 값으로 05_suppliers.csv의 supplier_id와 병합해 공급 조건을 추가하며 계산·집계 '
                 '없음. 단위: 공급사 ID(문자); use_unit/order_unit/원에 해당하지 않음.'),
 'order_unit': ('공통·마스터',
                '03_ingredients.csv의 order_unit을 ingredient_id 기준 다대일 병합으로 연결. 원본 발주 포장 단위명(박스/트레이/팩/EA/BOX '
                '등)을 그대로 사용하며 계산·집계 없음. 단위: order_unit의 단위명; order_qty·min_order_qty는 이 기준 수량, unit_price는 '
                '원/order_unit이며 재고 수량의 use_unit과 구분.'),
 'storage': ('공통·마스터',
             '03_ingredients.csv의 storage를 ingredient_id 기준 다대일 병합으로 연결. 원본 보관 방식(냉동/냉장/상온)을 그대로 사용하며 계산·집계 '
             '없음. 단위: 보관 방식(범주형 문자); use_unit/order_unit/원에 해당하지 않음.'),
 'weekday': ('공통·마스터',
             '07_calendar.csv의 weekday를 10_inventory_daily.csv의 date와 07_calendar.csv의 date가 일치하는 행에 다대일 '
             '병합으로 연결. 날짜에서 요일을 새로 계산하지 않고 제공된 요일값을 그대로 사용. 단위: 요일(월~일, 범주형 문자); use_unit/order_unit/원에 해당하지 '
             '않음.'),
 'is_holiday': ('공통·마스터',
                '07_calendar.csv의 is_holiday를 date 기준 다대일 병합으로 연결. 제공된 공휴일 표시를 그대로 사용하며 합산·비율 계산 없음. 단위: 무차원 '
                '0/1 표시(1=공휴일, 0=비공휴일); use_unit/order_unit/원에 해당하지 않음.'),
 'holiday_name': ('공통·마스터',
                  '07_calendar.csv의 holiday_name을 date 기준 다대일 병합으로 연결. 원본 공휴일명을 그대로 사용하며 비공휴일의 공란은 해당 없음으로 '
                  '보존. 단위: 공휴일명(문자); use_unit/order_unit/원에 해당하지 않음.'),
 'valid_from': ('공통·마스터',
                '06_ingredient_price_history.csv의 valid_from을 날짜형으로 변환한 뒤 ingredient_id가 같고 valid_from <= '
                '기준일 date인 이력 중 가장 최근 행을 merge_asof(direction=backward)로 선택한 단가 적용 시작일. 해당 행의 unit_price를 함께 '
                '연결하며 미래 단가는 사용하지 않음. 단위: 날짜(YYYY-MM-DD); 연결된 unit_price의 단위는 가상 원/order_unit이며 valid_from '
                '자체는 수량·금액이 아님.')})
    master = {"store_id", "ingredient_id", "store_name", "trade_area", "ingredient_name", "supplier_id", "use_unit", "order_unit", "storage", "shelf_life_days", "min_order_qty", "use_qty_per_order_unit", "weekday", "is_holiday", "holiday_name", "valid_from"}
    rows = []
    for c in panel:
        time, meaning = notes.get(c, ("공통·마스터" if c in master else "사후", "제공 CSV 동일 컬럼 정의" if c in t10_columns() else "집계값, 전처리 설명 참조"))
        rows.append({"column": c, "dtype": str(panel[c].dtype), "available_at": time, "definition": meaning})
    return pd.DataFrame(rows)


def t10_columns():
    return {"consumed_qty", "waste_qty", "transfer_in_qty", "transfer_out_qty", "closing_qty", "closing_value", "stockout_flag", "emergency_flag", "low_stock_flag", "overstock_flag"}


def run(data_dir=ROOT / "data", out=ROOT / "analysis"):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    t, manifest = read_sources(data_dir)
    menu = menu_panel(t)
    panel = ingredient_panel(t, menu)
    checks = validate(t, menu, panel)
    eda, summary = eda_tables(t, menu, panel)
    feature_cols = ["date", "store_id", "store_name", "ingredient_id", "ingredient_name", "supplier_id", "use_unit", "order_unit", "use_qty_per_order_unit", "shelf_life_days", "storage", "min_order_qty", "opening_qty", "received_qty", "adjust_qty", "counted_qty", "closing_qty_prev", "consumed_avg_7d_past", "consumed_avg_28d_past", "stockout_days_7d_past", "stock_days_at_open", "weekday", "is_holiday", "holiday_name", "unit_price", "valid_from"]
    features = panel[feature_cols].merge(t[5].drop(columns=["supplier_name", "note"]), on="supplier_id", validate="many_to_one")
    all_columns = panel.reindex(columns=list(dict.fromkeys(list(panel.columns) + list(features.columns))))
    for name, df in {"ingredient_daily": panel, "menu_daily": menu, "validation_checks": checks,
                     "decision_features_daily": features, "data_dictionary": dictionary(all_columns), **eda}.items():
        df.to_csv(out / f"{name}.csv", index=False, encoding="utf-8-sig", date_format="%Y-%m-%d", float_format="%.8f")
    write_report(out, summary, eda, checks)
    for name, data in [("eda_summary", summary), ("source_manifest", manifest)]:
        (out / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({"panel_rows": len(panel), "menu_rows": len(menu), "checks": len(checks), "failures": int(checks.status.eq('FAIL').sum()), "warnings": checks[checks.status.eq('WARN')].to_dict('records')}, ensure_ascii=False, indent=2))
    if checks.status.eq("FAIL").any():
        raise RuntimeError("검증 실패: validation_checks.csv를 확인하세요. 데이터는 자동 수정하지 않습니다.")
    return panel, menu, checks, summary


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", type=Path, default=ROOT / "data")
    p.add_argument("--out", type=Path, default=ROOT / "analysis")
    args = p.parse_args()
    run(args.data, args.out)
