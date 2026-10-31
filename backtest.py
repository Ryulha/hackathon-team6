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
  - final  : 최종 (튜닝 반영: z 2.6, 장기 품목 z 2.33, 최근 7일 추세 50%, 품절 이력 상향 0)
             ※ base~loose는 engine.py의 현재 상수(Z_LONG, RECENT_WEIGHT, Z_BOOST)를 그대로 쓰므로
               튜닝 반영 전 결과와 숫자가 다를 수 있음. 최종 비교는 replay vs final로 볼 것

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
           f = 전일까지 7일 평균 소진량. 시작 직후 7일은 실제 기록(10_inventory_daily.consumed_qty)으로 채움
           replay는 실제 긴급발주를 그대로 재생
  - 품절 손실 금액(데이터 기반): 메뉴 단위로 계산
           식자재별 부족률 = 부족량 ÷ 그날 필요량
           메뉴별 못 판 수량 = 그날 메뉴 수요 × (그 메뉴 재료 중 가장 큰 부족률)   ← 병목 재료 기준, 중복 집계 없음
           손실 = 못 판 수량 × (가상 판매가 − BOM×단가로 계산한 재료원가)
           부족분은 모든 메뉴에 같은 비율로 나뉜다고 가정
  - 매장 간 이동(기본 켜짐, --no-transfer로 끔): 세 매장을 하루씩 동시에 시뮬레이션.
           매장별 소진 후 부족하면 다른 매장에서 이동 → 그래도 부족하면 품절·긴급발주 (명세서 운영 규칙)
           보내는 매장은 최근 7일 평균 소진량 2일분을 남김, 사용기한 빠른 묶음부터, 원래 사용기한 유지
           하루 단위 근사(실제 이동은 시간대별)
  - 미반영: 시작일 이후 실사조정, 품질·보관·조리 폐기
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
    "final": dict(z=3.0,  waste_aware=True,  stockout_boost=True,  shelf_tier=True),
}
LABELS = {
    "replay": "실제 과거 발주 (기준)", "base": "엔진 기본 (z 1.28)", "waste": "+ 폐기 조정",
    "full": "+ 품절 이력 z 상향", "smart": "+ 기한별 차등 z (장기 품목 2.05)",
    "tight": "타이트 (z 0.67)", "loose": "넉넉 (z 2.05)",
    "final": "최종 (튜닝 반영)",
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


def menu_margins(D, day, pack_of):
    """메뉴 1개당 이익 = 가상 판매가 − 재료원가(BOM × 사용단위 단가). 데이터 기반"""
    cost = {i: unit_cost(D, i, day, pack_of) for i in pack_of}
    b = D.bom.assign(c=lambda x: x.qty_per_menu * x.ingredient_id.map(cost))
    mat = b.groupby("menu_id").c.sum()
    price = D.menus.set_index("menu_id").virtual_price
    return (price - mat.reindex(price.index).fillna(0)).clip(lower=0).to_dict()


def menu_demand_by_day(D, store, start, end):
    """{date: {menu_id: 수요}} — demand_qty − cancel_qty"""
    x = D.daily[(D.daily.store_id == store) & D.daily.date.between(start, end)]
    out = {}
    for r in x.itertuples():
        out.setdefault(r.date, {})[r.menu_id] = float(r.y)
    return out


def run(D, store, start, end, name, cfg):
    """매장 하나 단독 시뮬레이션 (매장 간 이동 없음). 이전 버전과 호환용"""
    d, so, _ = run_all(D, [store], start, end, name, cfg, transfers=False)
    return d, so


def run_all(D, stores, start, end, name, cfg, transfers=True):
    """[3] 여러 매장을 하루씩 동시에 시뮬레이션. transfers=True면 매장 간 이동 반영
    이동 규칙(명세서): 부족 시 이동 먼저, 그래도 부족하면 품절 처리 후 긴급발주.
    보내는 매장은 평균 소진량 2일분을 남기고, 사용기한 빠른 묶음부터 원래 사용기한을 유지한 채 이동."""
    ing = D.ing.set_index("ingredient_id")
    pack_of = ing.use_qty_per_order_unit.astype(float).to_dict()
    shelf_of = ing.shelf_life_days.astype(int).to_dict()
    days = pd.date_range(start, end)
    bom_of = D.bom.groupby("menu_id").ingredient_id.apply(list).to_dict()
    margin = menu_margins(D, start, pack_of)

    S = {}  # 매장별 상태
    for st_id in stores:
        ml = E.morning_lots(D, st_id, start)
        lots = {}
        for r in ml.itertuples():
            lots.setdefault(r.ingredient_id, []).append([r.last_use_date, float(r.qty), r.receipt_date])
        real_po = D.po[D.po.store_id == st_id]
        if name == "replay":
            p = real_po[(real_po.expected_date > start) & (real_po.expected_date <= end)]
        else:
            p = real_po[(real_po.order_date < start) & (real_po.expected_date > start)]
        pend = [[r.expected_date, r.ingredient_id, float(r.order_qty) * pack_of[r.ingredient_id],
                 r.expected_date + pd.Timedelta(days=shelf_of[r.ingredient_id] - 1)] for r in p.itertuples()]
        inv_prev = D.inv[(D.inv.store_id == st_id) & D.inv.date.between(start - pd.Timedelta(days=7),
                                                                         start - pd.Timedelta(days=1))]
        S[st_id] = dict(lots=lots, pend=pend, real_po=real_po, so_log=[],
                        cons={i: g.sort_values("date").consumed_qty.astype(float).tolist()
                              for i, g in inv_prev.groupby("ingredient_id")},
                        dem=demand_by_day(D, st_id, start, end), mdem=menu_demand_by_day(D, st_id, start, end))
    so_detail, tr_log = [], []

    # ── 엔진 입력 가로채기: 매장 ID별로 시뮬레이션 상태를 돌려줌
    def fake_morning_lots(_D, st_id, day):
        rows = [(i, rc, lu, q) for i, ls in S[st_id]["lots"].items() for lu, q, rc in ls if q > 0 and lu >= day]
        return pd.DataFrame(rows, columns=["ingredient_id", "receipt_date", "last_use_date", "qty"])

    def fake_pending(_D, st_id, day):
        rows = [(i, a, q) for a, i, q, _ in S[st_id]["pend"] if a > day]
        return pd.DataFrame(rows, columns=["ingredient_id", "expected_date", "use_qty"])

    def fake_so_hist(_D, st_id, day, window=E.SO_WINDOW):
        x = pd.DataFrame(S[st_id]["so_log"], columns=["date", "ingredient_id"])
        x = x[(x.date < day) & (x.date >= day - pd.Timedelta(days=window))]
        if x.empty:
            return pd.DataFrame(columns=["stockout_28d", "stockout_hour", "last_stockout"])
        g = x.groupby("ingredient_id").agg(stockout_28d=("date", "nunique"), last_stockout=("date", "max"))
        g["stockout_hour"] = None
        return g

    def avg7(st_id, i):
        h = S[st_id]["cons"].get(i, [])[-7:]
        return sum(h) / len(h) if h else 0.0

    def usable(st_id, i, t):
        return [l for l in S[st_id]["lots"].get(i, []) if l[1] > 0 and l[0] >= t]

    orig = (E.morning_lots, E.pending_arrivals, E.stockout_history)
    E.morning_lots, E.pending_arrivals, E.stockout_history = fake_morning_lots, fake_pending, fake_so_hist
    daily_rows = []
    sup_idx = D.sup.set_index("supplier_id")
    try:
        for t in days:
            order_amt = {s_: 0.0 for s_ in stores}
            n_lines = {s_: 0 for s_ in stores}
            for s_ in stores:
                st = S[s_]
                # 1) 07시 입고
                if t > start:
                    for a, i, q, lu in [x for x in st["pend"] if x[0] == t]:
                        st["lots"].setdefault(i, []).append([lu, q, t])
                st["pend"] = [x for x in st["pend"] if x[0] > t]
                # 2) 발주 판단
                if cfg is not None:
                    df, _ = E.recommend(D, s_, t, **cfg)
                    for sid, sub in df.groupby("supplier_id"):
                        total = float((sub.rec * sub.price).sum())
                        mina = float(sup_idx.loc[sid, "min_order_amount"])
                        if 0 < total < mina:
                            urgent = bool((sub.rec.gt(0) & sub.status.str.startswith(("🔴", "🛒"))).any())
                            if not urgent:
                                df.loc[sub.index, "rec"] = 0
                            else:
                                _, _, plan = E.min_amount_fix(D, df, sid)
                                for pr in plan.itertuples():
                                    df.loc[df.ingredient_id == pr.ingredient_id, "rec"] += int(pr.추가)
                    for r in df[df.rec > 0].itertuples():
                        st["pend"].append([r.arrival, r.ingredient_id, float(r.rec * r.pack),
                                           r.arrival + pd.Timedelta(days=r.shelf - 1)])
                        order_amt[s_] += r.rec * r.price
                        n_lines[s_] += 1
                else:
                    po_t = st["real_po"][st["real_po"].order_date == t]
                    order_amt[s_], n_lines[s_] = float(po_t.order_amount.sum()), len(po_t)

            # 3) 1단계: 매장별 자기 재고로 FEFO 소진 → 부족량 기록
            short = {}
            for s_ in stores:
                st = S[s_]
                need_t = st["dem"].get(t, {})
                for i in ing.index:
                    need = need_t.get(i, 0.0)
                    for l in sorted(usable(s_, i, t), key=lambda z: (z[0], z[2])):
                        if need <= 0:
                            break
                        use = min(l[1], need)
                        l[1] -= use
                        need -= use
                    if need > 1e-6:
                        short[(s_, i)] = need

            # 4) 2단계: 매장 간 이동 (보내는 매장은 평균 소진량 2일분을 남김)
            n_tr = {s_: 0 for s_ in stores}
            if transfers and len(stores) > 1:
                for (s_, i), need in sorted(short.items(), key=lambda kv: -kv[1]):
                    for o in sorted([x for x in stores if x != s_],
                                    key=lambda x: -sum(l[1] for l in usable(x, i, t))):
                        if need <= 1e-6:
                            break
                        surplus = sum(l[1] for l in usable(o, i, t)) - 2 * avg7(o, i)
                        if surplus <= 1e-6:
                            continue
                        move = min(need, surplus)
                        moved = 0.0
                        for l in sorted(usable(o, i, t), key=lambda z: (z[0], z[2])):
                            if moved >= move - 1e-9:
                                break
                            q = min(l[1], move - moved)
                            l[1] -= q
                            moved += q
                            # 받는 매장은 그날 바로 사용 (원래 사용기한 유지)
                        need -= moved
                        tr_log.append(dict(config=name, date=t.date(), from_store=o, to_store=s_,
                                           ingredient_id=i, qty=round(moved, 1)))
                        n_tr[s_] += 1
                    short[(s_, i)] = need

            # 5) 남은 부족분 = 품절 → 긴급발주, 6) 마감 후 폐기·재고 평가
            for s_ in stores:
                st = S[s_]
                need_t = st["dem"].get(t, {})
                waste_cost = inv_value = lost_use = demand_use = 0.0
                lost_items = 0
                short_frac = {}
                for i in ing.index:
                    d_i = need_t.get(i, 0.0)
                    demand_use += d_i
                    left = short.get((s_, i), 0.0)
                    st["cons"].setdefault(i, []).append(d_i - max(left, 0.0))
                    c = unit_cost(D, i, t, pack_of)
                    if left > 1e-6:
                        lost_items += 1
                        lost_use += left
                        st["so_log"].append((t, i))
                        if d_i > 0:
                            short_frac[i] = left / d_i
                        so_detail.append(dict(config=name, store_id=s_, date=t.date(), ingredient_id=i,
                                              품목=ing.loc[i, "ingredient_name"],
                                              lost_use=round(left, 1), demand_use=round(d_i, 1)))
                        if cfg is not None:  # 긴급발주: 다음날 07시 입고
                            h = st["cons"][i][-8:-1] or [d_i]
                            units = max(1, math.ceil(sum(h) / len(h) * 1.5 / pack_of[i]))
                            arr = t + pd.Timedelta(days=1)
                            st["pend"].append([arr, i, units * pack_of[i], arr + pd.Timedelta(days=shelf_of[i] - 1)])
                            order_amt[s_] += units * E.unit_price(D, i, t)
                            n_lines[s_] += 1
                    ls = [l for l in st["lots"].get(i, []) if l[1] > 0]
                    waste_cost += sum(l[1] for l in ls if l[0] <= t) * c
                    ls = [l for l in ls if l[0] > t and l[1] > 1e-9]
                    st["lots"][i] = ls
                    inv_value += sum(l[1] for l in ls) * c
                lost_menu_qty = lost_cost = 0.0
                for m, y in st["mdem"].get(t, {}).items():
                    fr = max((short_frac.get(i, 0.0) for i in bom_of.get(m, [])), default=0.0)
                    if fr > 0:
                        lost_menu_qty += y * fr
                        lost_cost += y * fr * margin.get(m, 0.0)
                daily_rows.append(dict(config=name, store_id=s_, date=t.date(),
                                       expiry_waste_cost=round(waste_cost), stockout_items=lost_items,
                                       lost_menu_qty=round(lost_menu_qty, 1), lost_sales_cost=round(lost_cost),
                                       lost_use=lost_use, demand_use=demand_use, transfers_in=n_tr[s_],
                                       inventory_value=round(inv_value), order_amount=round(order_amt[s_]),
                                       order_lines=n_lines[s_]))
    finally:
        E.morning_lots, E.pending_arrivals, E.stockout_history = orig
    return pd.DataFrame(daily_rows), pd.DataFrame(so_detail), pd.DataFrame(tr_log)


def summarize(daily):
    g = daily.groupby(["config", "store_id"])
    s = g.agg(expiry_waste_cost=("expiry_waste_cost", "sum"),
              stockout_item_days=("stockout_items", "sum"),
              lost_menu_qty=("lost_menu_qty", "sum"),
              lost_sales_cost=("lost_sales_cost", "sum"),
              avg_inventory_value=("inventory_value", "mean"),
              order_amount=("order_amount", "sum"),
              order_lines=("order_lines", "sum"),
              transfers_in=("transfers_in", "sum"),
              lost_use=("lost_use", "sum"), demand_use=("demand_use", "sum")).reset_index()
    tot = s.groupby("config").sum(numeric_only=True).reset_index()
    tot["store_id"] = "합계"
    s = pd.concat([s, tot], ignore_index=True)
    s["avg_inventory_value"] = s["avg_inventory_value"].round()
    s["label"] = s.config.map(LABELS)
    order = {k: n for n, k in enumerate(CONFIGS)}
    s = s.sort_values(["store_id", "config"], key=lambda c: c.map(order) if c.name == "config" else c)
    s["lost_menu_qty"] = s["lost_menu_qty"].round()
    return s[["store_id", "config", "label", "expiry_waste_cost", "stockout_item_days", "lost_menu_qty",
              "lost_sales_cost",
              "avg_inventory_value", "order_amount", "order_lines", "transfers_in"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-09-01")
    ap.add_argument("--end", default="2026-09-30")
    ap.add_argument("--stores", nargs="*", default=None)
    ap.add_argument("--configs", nargs="*", default=list(CONFIGS))
    ap.add_argument("--out", default="analysis")
    ap.add_argument("--no-transfer", action="store_true", help="매장 간 이동 없이 (이전 방식)")
    ap.add_argument("--forecast", choices=["engine", "catboost"], default=None, help="수요 예측 출처 (기본: engine.py 설정)")
    ap.add_argument("--artifact-dir", default=None, help="2번 모델 폴더 (models/evaluated)")
    a = ap.parse_args()

    if a.forecast:
        E.FORECAST_SOURCE = a.forecast
    if a.artifact_dir:
        E.FORECAST_ARTIFACT_DIR = a.artifact_dir
    print(f"수요 예측 출처: {E.FORECAST_SOURCE}")
    D = E.load()
    start, end = pd.Timestamp(a.start), pd.Timestamp(a.end)
    stores = a.stores or D.stores.store_id.tolist()
    allrows, sorows, trrows = [], [], []
    for name in a.configs:
        t0 = time.time()
        d, so_d, tr_d = run_all(D, stores, start, end, name, CONFIGS[name], transfers=not a.no_transfer)
        allrows.append(d)
        sorows.append(so_d)
        trrows.append(tr_d)
        print(f"  {name:<7} {time.time() - t0:5.1f}s  폐기 {d.expiry_waste_cost.sum():>9,.0f}원  "
              f"품절 {d.stockout_items.sum():>3}품목·일  못 판 메뉴 {d.lost_menu_qty.sum():>6,.0f}개  "
              f"이동 {len(tr_d):>3}건")
    daily = pd.concat(allrows, ignore_index=True)
    summ = summarize(daily)

    Path(a.out).mkdir(exist_ok=True)
    daily.to_csv(Path(a.out) / "backtest_daily.csv", index=False, encoding="utf-8-sig")
    summ.to_csv(Path(a.out) / "backtest_summary.csv", index=False, encoding="utf-8-sig")
    so = pd.concat([x for x in sorows if len(x)], ignore_index=True) if any(len(x) for x in sorows) else pd.DataFrame()
    so.to_csv(Path(a.out) / "backtest_stockouts.csv", index=False, encoding="utf-8-sig")
    tr = pd.concat([x for x in trrows if len(x)], ignore_index=True) if any(len(x) for x in trrows) else pd.DataFrame()
    tr.to_csv(Path(a.out) / "backtest_transfers.csv", index=False, encoding="utf-8-sig")
    pd.set_option("display.width", 200)
    print(f"\n[백테스트 {a.start} ~ {a.end}]  매장 간 이동 {'미반영' if a.no_transfer else '반영'}, "
          f"소비기한 경과 폐기만 집계, 합성 데이터·가상 금액")
    print(summ.to_string(index=False))

    if len(so):
        print("\n[품절 상세] 정책별 품목 (품절일수 / 부족량 합 / 해당일 수요 합)")
        t = so.groupby(["config", "store_id", "품목"]).agg(days=("date", "nunique"), lost=("lost_use", "sum"),
                                                           demand=("demand_use", "sum")).reset_index()
        t["부족률"] = (t.lost / t.demand).round(3)
        print(t.sort_values(["config", "days"], ascending=[True, False]).to_string(index=False))

    # 시뮬레이터 검증: replay vs 실제 기록 (폐기·품절)
    if "replay" in a.configs:
        w = D.waste[(D.waste.reason == "소비기한 경과") & D.waste.date.between(start, end) &
                    D.waste.store_id.isin(stores)]
        so_real = D.stockouts[D.stockouts.date.between(start, end) & D.stockouts.store_id.isin(stores)]
        rp = daily[daily.config == "replay"]
        print(f"\n[검증] 소비기한 경과 폐기: 실제 기록 {w.waste_cost.sum():,.0f}원 "
              f"vs replay {rp.expiry_waste_cost.sum():,.0f}원")
        print(f"[검증] 품절(품목·일): 실제 기록 {len(so_real)} vs replay {rp.stockout_items.sum()}")
        if not a.no_transfer:
            trf = pd.read_csv(E.DATA / "14_transfers.csv", encoding="utf-8-sig")
            trf["date"] = pd.to_datetime(trf["date"])
            trf = trf[trf.date.between(start, end) & trf.to_store_id.isin(stores)]
            n_sim = int(rp.transfers_in.sum())
            print(f"[검증] 매장 간 이동(건): 실제 기록 {len(trf)} vs replay {n_sim}")


if __name__ == "__main__":
    main()