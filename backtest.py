"""
backtest.py — 발주 정책 백테스트 (3번 파트)

같은 기간·같은 실제 수요로 정책별 결과를 비교한다.
  - replay : 실제 과거 발주(11_purchase_orders, 정기+긴급)를 그대로 재생 → 기준선
  - base   : 엔진 기본 (z 1.28, 폐기조정 off, 품절이력 off)
  - waste  : + 폐기 고려 감량
  - full   : + 품절 이력 z 상향
  - smart  : full + 기한별 차등 z (사용기한 14일 이상 품목은 z 2.05)
  - tight  : full, z 0.67
  - loose  : full, z 2.05

실행 (engine.py와 같은 폴더):
    python backtest.py                                  # 9월, 전 매장, 전 정책
    python backtest.py --start 2026-09-01 --end 2026-09-30 --stores S02 S03 --configs replay base full

출력:
    analysis/backtest_summary.csv  (정책 × 매장 + 매장 합계)
    analysis/backtest_daily.csv    (정책 × 매장 × 날짜)

시뮬레이션 규칙 (가정표에 기재):
  - 시작일 아침 재고 = 실제 기록(engine.morning_lots), 시작 시점 입고 예정 = 실제 발주
  - 매일: 07시 입고 → (엔진 정책이면) 발주 판단 → 실제 수요(demand_qty-cancel_qty)×BOM만큼 FEFO 소진
          → 부족분 = 품절 손실 → 마감 후 마지막 사용일 도래분 폐기(소비기한 경과)
  - 최소 발주금액: 미달 시 급한 품목 없으면 미룸, 있으면 engine.min_amount_fix 보충안 적용
  - 긴급발주(엔진 정책): 품절 발생 시 명세서 운영 규칙과 동일하게 올림(f×1.5÷포장단위), 다음날 07시 입고
           f = 시뮬레이션상 전일까지 7일 평균 소진량. replay는 실제 긴급발주를 그대로 재생
  - 미반영: 매장 간 이동, 시작일 이후 실사조정, 품질·보관·조리 폐기
"""
from __future__ import annotations

import argparse
import math
import time
from pathlib import Path

import pandas as pd

import engine as E

CONFIGS = {
    "replay": None,
    "base":  dict(z=1.28, waste_aware=False, stockout_boost=False, shelf_tier=False),
    "waste": dict(z=1.28, waste_aware=True,  stockout_boost=False, shelf_tier=False),
    "full":  dict(z=1.28, waste_aware=True,  stockout_boost=True,  shelf_tier=False),
    "smart": dict(z=1.28, waste_aware=True,  stockout_boost=True,  shelf_tier=True),
    "tight": dict(z=0.67, waste_aware=True,  stockout_boost=True,  shelf_tier=False),
    "loose": dict(z=2.05, waste_aware=True,  stockout_boost=True,  shelf_tier=False),
}
LABELS = {
    "replay": "실제 과거 발주 (기준)", "base": "엔진 기본 (z 1.28)", "waste": "+ 폐기 조정",
    "full": "+ 품절 이력 z 상향", "smart": "+ 기한별 차등 z (장기 품목 2.05)",
    "tight": "타이트 (z 0.67)", "loose": "넉넉 (z 2.05)",
}


def demand_by_day(D, store, start, end):
    """{date: {ingredient_id: use_qty}} — 실제 수요(demand-cancel) × BOM"""
    x = D.daily[(D.daily.store_id == store) & D.daily.date.between(start, end)]
    x = x.merge(D.bom[["menu_id", "ingredient_id", "qty_per_menu"]], on="menu_id")
    x["u"] = x.y * x.qty_per_menu
    g = x.groupby(["date", "ingredient_id"]).u.sum()
    out = {}
    for (d, i), v in g.items():
        out.setdefault(d, {})[i] = float(v)
    return out


def unit_cost(D, ing_id, day, pack_of):
    return E.unit_price(D, ing_id, day) / pack_of[ing_id]


def run(D, store, start, end, name, cfg):
    ing = D.ing.set_index("ingredient_id")
    pack_of = ing.use_qty_per_order_unit.astype(float).to_dict()
    shelf_of = ing.shelf_life_days.astype(int).to_dict()
    days = pd.date_range(start, end)
    dem = demand_by_day(D, store, start, end)

    # ── 초기 상태: 실제 기록
    ml = E.morning_lots(D, store, start)
    lots = {}  # ing -> [[last_use, qty, receipt]]
    for r in ml.itertuples():
        lots.setdefault(r.ingredient_id, []).append([r.last_use_date, float(r.qty), r.receipt_date])
    pend = []  # [arrival, ing, use_qty, last_use]
    real_po = D.po[(D.po.store_id == store)]
    if name == "replay":
        p = real_po[(real_po.expected_date > start) & (real_po.expected_date <= end)]
    else:
        p = real_po[(real_po.order_date < start) & (real_po.expected_date > start)]
    for r in p.itertuples():
        q = float(r.order_qty) * pack_of[r.ingredient_id]
        pend.append([r.expected_date, r.ingredient_id, q,
                     r.expected_date + pd.Timedelta(days=shelf_of[r.ingredient_id] - 1)])
    so_log = []  # (date, ing)
    so_detail = []
    cons_hist = {}  # ing -> [일별 소진량]  (긴급발주 f 계산용)

    # ── 엔진 입력 가로채기: 실제 기록 대신 시뮬레이션 상태를 쓰게 함
    def fake_morning_lots(_D, _store, day):
        rows = [(i, rc, lu, q) for i, ls in lots.items() for lu, q, rc in ls if q > 0 and lu >= day]
        return pd.DataFrame(rows, columns=["ingredient_id", "receipt_date", "last_use_date", "qty"])

    def fake_pending(_D, _store, day):
        rows = [(i, a, q) for a, i, q, _ in pend if a > day]
        return pd.DataFrame(rows, columns=["ingredient_id", "expected_date", "use_qty"])

    def fake_so_hist(_D, _store, day, window=E.SO_WINDOW):
        x = pd.DataFrame(so_log, columns=["date", "ingredient_id"])
        x = x[(x.date < day) & (x.date >= day - pd.Timedelta(days=window))]
        if x.empty:
            return pd.DataFrame(columns=["stockout_28d", "stockout_hour", "last_stockout"])
        g = x.groupby("ingredient_id").agg(stockout_28d=("date", "nunique"), last_stockout=("date", "max"))
        g["stockout_hour"] = None
        return g

    orig = (E.morning_lots, E.pending_arrivals, E.stockout_history)
    E.morning_lots, E.pending_arrivals, E.stockout_history = fake_morning_lots, fake_pending, fake_so_hist
    daily_rows = []
    try:
        for t in days:
            # 1) 07시 입고 (시작일 입고분은 morning_lots에 이미 포함)
            if t > start:
                for a, i, q, lu in [x for x in pend if x[0] == t]:
                    lots.setdefault(i, []).append([lu, q, t])
            pend = [x for x in pend if x[0] > t]

            # 2) 발주 판단 (엔진 정책)
            order_amt, n_lines = 0.0, 0
            if cfg is not None:
                df, _ = E.recommend(D, store, t, **cfg)
                for sid, sub in df.groupby("supplier_id"):
                    total = float((sub.rec * sub.price).sum())
                    mina = float(D.sup.set_index("supplier_id").loc[sid, "min_order_amount"])
                    if 0 < total < mina:
                        urgent = bool((sub.rec.gt(0) & sub.status.str.startswith(("🔴", "🛒"))).any())
                        if not urgent:
                            df.loc[sub.index, "rec"] = 0
                        else:
                            _, _, plan = E.min_amount_fix(D, df, sid)
                            for pr in plan.itertuples():
                                df.loc[df.ingredient_id == pr.ingredient_id, "rec"] += int(pr.추가)
                for r in df[df.rec > 0].itertuples():
                    q = r.rec * r.pack
                    pend.append([r.arrival, r.ingredient_id, float(q),
                                 r.arrival + pd.Timedelta(days=r.shelf - 1)])
                    order_amt += r.rec * r.price
                    n_lines += 1
            else:
                po_t = real_po[real_po.order_date == t]
                order_amt, n_lines = float(po_t.order_amount.sum()), len(po_t)

            # 3) 실제 수요 FEFO 소진 → 4) 마감 후 폐기
            need_t = dem.get(t, {})
            waste_cost = lost_items = 0
            lost_use = demand_use = 0.0
            inv_value = 0.0
            for i in ing.index:
                ls = sorted([l for l in lots.get(i, []) if l[1] > 0], key=lambda z: (z[0], z[2]))
                need = need_t.get(i, 0.0)
                demand_use += need
                for l in ls:
                    if need <= 0:
                        break
                    if l[0] < t:
                        continue
                    use = min(l[1], need)
                    l[1] -= use
                    need -= use
                used = need_t.get(i, 0.0) - max(need, 0.0)
                cons_hist.setdefault(i, []).append(used)
                if need > 1e-6:
                    lost_items += 1
                    lost_use += need
                    so_log.append((t, i))
                    so_detail.append(dict(config=name, store_id=store, date=t.date(), ingredient_id=i,
                                          품목=ing.loc[i, "ingredient_name"],
                                          lost_use=round(need, 1), demand_use=round(need_t.get(i, 0.0), 1)))
                    if cfg is not None:  # 긴급발주: 다음날 07시 입고
                        h = cons_hist[i][-8:-1] or [need_t.get(i, 0.0)]
                        f = max(sum(h) / len(h), need_t.get(i, 0.0) / 2)
                        units = max(1, math.ceil(f * 1.5 / pack_of[i]))
                        arr = t + pd.Timedelta(days=1)
                        pend.append([arr, i, units * pack_of[i], arr + pd.Timedelta(days=shelf_of[i] - 1)])
                        order_amt += units * E.unit_price(D, i, t)
                        n_lines += 1
                c = unit_cost(D, i, t, pack_of)
                w = sum(l[1] for l in ls if l[0] <= t)
                waste_cost += w * c
                ls = [l for l in ls if l[0] > t and l[1] > 1e-9]
                lots[i] = ls
                inv_value += sum(l[1] for l in ls) * c
            daily_rows.append(dict(config=name, store_id=store, date=t.date(),
                                   expiry_waste_cost=round(waste_cost), stockout_items=lost_items,
                                   lost_use=lost_use, demand_use=demand_use,
                                   inventory_value=round(inv_value), order_amount=round(order_amt),
                                   order_lines=n_lines))
    finally:
        E.morning_lots, E.pending_arrivals, E.stockout_history = orig
    return pd.DataFrame(daily_rows), pd.DataFrame(so_detail)


def summarize(daily):
    g = daily.groupby(["config", "store_id"])
    s = g.agg(expiry_waste_cost=("expiry_waste_cost", "sum"),
              stockout_item_days=("stockout_items", "sum"),
              avg_inventory_value=("inventory_value", "mean"),
              order_amount=("order_amount", "sum"),
              order_lines=("order_lines", "sum"),
              lost_use=("lost_use", "sum"), demand_use=("demand_use", "sum")).reset_index()
    tot = s.groupby("config").sum(numeric_only=True).reset_index()
    tot["store_id"] = "합계"
    s = pd.concat([s, tot], ignore_index=True)
    s["avg_inventory_value"] = s["avg_inventory_value"].round()
    s["label"] = s.config.map(LABELS)
    order = {k: n for n, k in enumerate(CONFIGS)}
    s = s.sort_values(["store_id", "config"], key=lambda c: c.map(order) if c.name == "config" else c)
    return s[["store_id", "config", "label", "expiry_waste_cost", "stockout_item_days",
              "avg_inventory_value", "order_amount", "order_lines"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-09-01")
    ap.add_argument("--end", default="2026-09-30")
    ap.add_argument("--stores", nargs="*", default=None)
    ap.add_argument("--configs", nargs="*", default=list(CONFIGS))
    ap.add_argument("--out", default="analysis")
    a = ap.parse_args()

    D = E.load()
    start, end = pd.Timestamp(a.start), pd.Timestamp(a.end)
    stores = a.stores or D.stores.store_id.tolist()
    allrows, sorows = [], []
    for name in a.configs:
        for s in stores:
            t0 = time.time()
            d, so_d = run(D, s, start, end, name, CONFIGS[name])
            allrows.append(d)
            sorows.append(so_d)
            print(f"  {name:<7} {s}  {time.time() - t0:5.1f}s  "
                  f"폐기 {d.expiry_waste_cost.sum():>9,.0f}원  품절 {d.stockout_items.sum():>3}품목·일")
    daily = pd.concat(allrows, ignore_index=True)
    summ = summarize(daily)

    Path(a.out).mkdir(exist_ok=True)
    daily.to_csv(Path(a.out) / "backtest_daily.csv", index=False, encoding="utf-8-sig")
    summ.to_csv(Path(a.out) / "backtest_summary.csv", index=False, encoding="utf-8-sig")
    so = pd.concat([x for x in sorows if len(x)], ignore_index=True) if any(len(x) for x in sorows) else pd.DataFrame()
    so.to_csv(Path(a.out) / "backtest_stockouts.csv", index=False, encoding="utf-8-sig")
    pd.set_option("display.width", 200)
    print(f"\n[백테스트 {a.start} ~ {a.end}]  소비기한 경과 폐기만 집계, 합성 데이터·가상 금액")
    print(summ.to_string(index=False))

    if len(so):
        print("\n[품절 상세] 정책별 품목 (품절일수 / 부족량 합 / 해당일 수요 합)")
        t = so.groupby(["config", "store_id", "품목"]).agg(days=("date", "nunique"), lost=("lost_use", "sum"),
                                                           demand=("demand_use", "sum")).reset_index()
        t["부족률"] = (t.lost / t.demand).round(3)
        print(t.sort_values(["config", "days"], ascending=[True, False]).to_string(index=False))

    # 시뮬레이터 검증: replay 폐기 vs 실제 기록(소비기한 경과)
    if "replay" in a.configs:
        w = D.waste[(D.waste.reason == "소비기한 경과") & D.waste.date.between(start, end) &
                    D.waste.store_id.isin(stores)]
        print(f"\n[검증] 실제 기록 소비기한 경과 폐기비용 {w.waste_cost.sum():,.0f}원 "
              f"vs replay 시뮬레이션 {daily[daily.config == 'replay'].expiry_waste_cost.sum():,.0f}원")


if __name__ == "__main__":
    main()