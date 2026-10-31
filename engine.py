"""발주 추천 엔진.

판단 시점: 기준일 D 아침 (07시 입고 + 영업 전, 정기발주 마감 전).
사용 정보: D-1 영업종료까지의 기록 + D 07시 입고분. D 당일 판매·기말 정보와 D 당일 발주 기록은 쓰지 않는다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).parent / "data"
WD = ["월", "화", "수", "목", "금", "토", "일"]

# 데이터 기간(~9/30) 이후 공휴일 — 직접 추가한 가정
EXTRA_HOLIDAYS = {"2026-10-03": "개천절", "2026-10-05": "대체공휴일", "2026-10-09": "한글날"}

# 품절 위험 허용 수준 → 정규분포 z (서비스 수준)
RISK_LEVELS = {"넉넉하게 (여유분 확대)": 2.05, "보통": 1.28, "타이트하게 (재고 최소)": 0.67}


def _r(name):
    return pd.read_csv(DATA / name, encoding="utf-8-sig")


@dataclass
class Data:
    stores: pd.DataFrame
    menus: pd.DataFrame
    ing: pd.DataFrame
    bom: pd.DataFrame
    sup: pd.DataFrame
    price: pd.DataFrame
    cal: pd.DataFrame
    promo: pd.DataFrame
    avail: pd.DataFrame
    po: pd.DataFrame
    lots: pd.DataFrame
    inv: pd.DataFrame
    waste: pd.DataFrame
    daily: pd.DataFrame  # store × menu × date 수요 (demand - cancel)
    holidays: set


def load() -> Data:
    sales = _r("09_sales.csv")
    sales["y"] = sales["demand_qty"] - sales["cancel_qty"]  # 품절이 없었다면 확정됐을 수량
    daily = sales.groupby(["store_id", "menu_id", "date"], as_index=False)["y"].sum()
    daily["date"] = pd.to_datetime(daily["date"])

    cal = _r("07_calendar.csv")
    cal["date"] = pd.to_datetime(cal["date"])
    hol = set(cal.loc[cal.is_holiday == 1, "date"]) | {pd.Timestamp(d) for d in EXTRA_HOLIDAYS}

    sup = _r("05_suppliers.csv")
    sup["order_days_l"] = sup.order_days.str.split(",")
    sup["delivery_days_l"] = sup.delivery_days.str.split(",")

    price = _r("06_ingredient_price_history.csv")
    price["valid_from"] = pd.to_datetime(price["valid_from"])
    avail = _r("15_menu_availability.csv")
    for c in ["start_date", "end_date"]:
        avail[c] = pd.to_datetime(avail[c])
    po = _r("11_purchase_orders.csv")
    for c in ["order_date", "expected_date"]:
        po[c] = pd.to_datetime(po[c])
    lots = _r("16_inventory_lots_daily.csv")
    for c in ["date", "receipt_date", "last_use_date"]:
        lots[c] = pd.to_datetime(lots[c])
    inv = _r("10_inventory_daily.csv")
    inv["date"] = pd.to_datetime(inv["date"])
    waste = _r("13_waste.csv")
    waste["date"] = pd.to_datetime(waste["date"])
    promo = _r("08_promotions.csv")
    for c in ["start_date", "end_date"]:
        promo[c] = pd.to_datetime(promo[c])

    return Data(_r("01_stores.csv"), _r("02_menus.csv"), _r("03_ingredients.csv"), _r("04_bom.csv"),
                sup, price, cal, promo, avail, po, lots, inv, waste, daily, hol)


# ───────────────────────── 날짜 규칙 ─────────────────────────
def wd(t: pd.Timestamp) -> str:
    return WD[t.weekday()]


def is_holiday(D: Data, t) -> bool:
    return pd.Timestamp(t) in D.holidays


def next_order_day(sup_row, after: pd.Timestamp) -> pd.Timestamp:
    t = after + pd.Timedelta(days=1)
    for _ in range(14):
        if wd(t) in sup_row.order_days_l:
            return t
        t += pd.Timedelta(days=1)
    raise ValueError


def arrival_of(sup_row, order_day: pd.Timestamp) -> pd.Timestamp:
    t = order_day + pd.Timedelta(days=int(sup_row.lead_time_days))
    for _ in range(14):  # 입고 가능 요일까지 밀기 (현재 데이터에선 항상 다음날)
        if wd(t) in sup_row.delivery_days_l:
            return t
        t += pd.Timedelta(days=1)
    raise ValueError


def unit_price(D: Data, ing_id: str, day: pd.Timestamp) -> int:
    p = D.price[(D.price.ingredient_id == ing_id) & (D.price.valid_from <= day)]
    return int(p.sort_values("valid_from").unit_price.iloc[-1])


def menu_available(D: Data, store: str, menu: str, t: pd.Timestamp) -> bool:
    a = D.avail[(D.avail.store_id == store) & (D.avail.menu_id == menu) & (D.avail.status == "취급")]
    if a.empty:
        return False
    last_data = pd.Timestamp("2026-09-30")
    for _, r in a.iterrows():
        end = pd.Timestamp.max if r.end_date >= last_data else r.end_date  # 9/30 종료 = 데이터 끝, 계속 취급 가정
        if r.start_date <= t <= end:
            return True
    return False


# ───────────────────────── 수요 예측 ─────────────────────────
def forecast_menus(D: Data, store: str, day: pd.Timestamp, horizon: int, demand_adj: float = 0.0,
                   promo_on: bool = False) -> pd.DataFrame:
    """기준일 day부터 horizon일 동안 메뉴별 일 수요 예측. day 이전 데이터만 사용.

    예측 = 메뉴 수준(최근 28일, 요일효과 제거 평균) × 매장 요일지수 × (공휴일이면 공휴일 배수)
    """
    hist = D.daily[(D.daily.store_id == store) & (D.daily.date < day)]
    tot = hist.groupby("date").y.sum()
    tot = tot[tot.index >= day - pd.Timedelta(days=56)]
    nonhol = tot[[d not in D.holidays for d in tot.index]]
    dow = nonhol.groupby([WD[d.weekday()] for d in nonhol.index]).mean()
    dow_idx = (dow / dow.mean()).reindex(WD).fillna(1.0)

    # 공휴일 배수: 전체 과거 공휴일 / 같은 요일 평일 평균
    allt = D.daily[(D.daily.store_id == store) & (D.daily.date < day)].groupby("date").y.sum()
    ratios = []
    for h in [d for d in allt.index if d in D.holidays]:
        same = allt[(allt.index < h) & (allt.index >= h - pd.Timedelta(days=35)) &
                    [x.weekday() == h.weekday() and x not in D.holidays for x in allt.index]]
        if len(same):
            ratios.append(allt[h] / same.mean())
    hol_mult = float(np.median(ratios)) if ratios else 1.0

    # 행사 배수 (P01: 세트 할인) — 과거 행사기간 대상 메뉴 / 행사 직전 28일
    promo_mult = 1.0
    if promo_on and len(D.promo):
        p = D.promo.iloc[0]
        tm = p.target_menu.split(",")
        h = D.daily[(D.daily.store_id == p.store_id) & D.daily.menu_id.isin(tm)].groupby("date").y.sum()
        h = h[h.index < day]  # 시나리오 배수도 기준일 이전 관측만 사용
        during = h[(h.index >= p.start_date) & (h.index <= p.end_date)].mean()
        before = h[(h.index < p.start_date) & (h.index >= p.start_date - pd.Timedelta(days=28))].mean()
        promo_mult = float(during / before) if pd.notna(during) and pd.notna(before) and before > 0 else 1.0

    rows = []
    recent = hist[hist.date >= day - pd.Timedelta(days=28)]
    for m in D.menus.menu_id:
        r = recent[recent.menu_id == m].set_index("date").y
        # 취급 중이었던 날만, 주문 없는 날은 0으로 채움
        days = [day - pd.Timedelta(days=k) for k in range(1, 29)]
        days = [d for d in days if menu_available(D, store, m, d)]
        if days:
            vals = np.array([r.get(d, 0) / dow_idx[wd(d)] for d in days], dtype=float)
            level = vals.mean()
        else:
            level = 0.0
        for k in range(horizon):
            t = day + pd.Timedelta(days=k)
            if not menu_available(D, store, m, t):
                f = 0.0
            else:
                f = level * dow_idx[wd(t)] * (hol_mult if t in D.holidays else 1.0)
                if promo_on and m in D.promo.iloc[0].target_menu.split(","):
                    f *= promo_mult
            rows.append((m, t, f * (1 + demand_adj)))
    out = pd.DataFrame(rows, columns=["menu_id", "date", "f"])
    out.attrs.update(dow_idx=dow_idx.to_dict(), hol_mult=hol_mult, promo_mult=promo_mult)
    return out


def forecast_ingredients(D: Data, fm: pd.DataFrame) -> pd.DataFrame:
    """메뉴 예측 × BOM → 식자재 일 소요 (use_unit). 세트는 세트 BOM을 직접 사용."""
    x = fm.merge(D.bom[["menu_id", "ingredient_id", "qty_per_menu"]], on="menu_id")
    x["need"] = x.f * x.qty_per_menu
    return x.groupby(["ingredient_id", "date"], as_index=False).need.sum()


def ingredient_sigma(D: Data, store: str, day: pd.Timestamp) -> dict:
    """식자재 일 소요의 예측 오차 표준편차 (최근 56일, 요일·수준 보정 후 잔차)."""
    hist = D.daily[(D.daily.store_id == store) & (D.daily.date < day) &
                   (D.daily.date >= day - pd.Timedelta(days=56))]
    x = hist.merge(D.bom[["menu_id", "ingredient_id", "qty_per_menu"]], on="menu_id")
    x["u"] = x.y * x.qty_per_menu
    s = x.groupby(["ingredient_id", "date"]).u.sum().unstack(0).fillna(0)
    if s.empty:
        return {}
    wdk = [d.weekday() for d in s.index]
    resid = s - s.groupby(wdk).transform("mean")  # 요일 평균 제거
    return resid.std().fillna(0).to_dict()


# ───────────────────────── 재고 상태 (D 아침) ─────────────────────────
def morning_lots(D: Data, store: str, day: pd.Timestamp) -> pd.DataFrame:
    """전일 마감 + 당일 07시 입고 + 당일 아침 실사조정. 기간 밖은 조정 0 가정."""
    prev = day - pd.Timedelta(days=1)
    l = D.lots[(D.lots.store_id == store) & (D.lots.date == prev) & (D.lots.remaining_qty > 0) &
               (D.lots.last_use_date >= day)][["ingredient_id", "receipt_date", "last_use_date", "remaining_qty"]]
    arr = D.po[(D.po.store_id == store) & (D.po.expected_date == day) & (D.po.order_date < day)]
    if len(arr):
        a = arr.merge(D.ing[["ingredient_id", "use_qty_per_order_unit", "shelf_life_days"]], on="ingredient_id")
        a = a.groupby(["ingredient_id", "use_qty_per_order_unit", "shelf_life_days"], as_index=False).order_qty.sum()
        new = pd.DataFrame({
            "ingredient_id": a.ingredient_id,
            "receipt_date": day,
            "last_use_date": day + pd.to_timedelta(a.shelf_life_days - 1, unit="D"),
            "remaining_qty": a.order_qty * a.use_qty_per_order_unit,
        })
        l = pd.concat([l, new], ignore_index=True)
    l = l.rename(columns={"remaining_qty": "qty"}).copy().reset_index(drop=True)
    counts = D.inv[(D.inv.store_id == store) & (D.inv.date == day)]
    for count in counts.itertuples():
        delta = float(count.adjust_qty)
        if not delta:
            continue
        ids = l.index[l.ingredient_id.eq(count.ingredient_id)]
        ordered = l.loc[ids].sort_values(["last_use_date", "receipt_date"]).index
        if delta < 0:
            remaining = -delta
            for idx in ordered:
                used = min(float(l.at[idx, "qty"]), remaining)
                l.at[idx, "qty"] -= used
                remaining -= used
                if remaining < 1e-6:
                    break
            if remaining > 1e-6:
                raise ValueError("실사 차감량이 사용가능 로트보다 큽니다.")
        elif len(ids):
            newest = l.loc[ids].sort_values(["receipt_date", "last_use_date"]).index[-1]
            l.at[newest, "qty"] += delta
        else:
            # 현재 자료에서는 발생하지 않으며 기한을 임의로 만들지 않는다.
            raise ValueError("실사 증가분을 배정할 입고 묶음이 없습니다.")
    return l[l.qty > 0].reset_index(drop=True)


def pending_arrivals(D: Data, store: str, day: pd.Timestamp) -> pd.DataFrame:
    """D 이전에 발주했고 D 이후 도착 예정인 물량 (use_unit)."""
    p = D.po[(D.po.store_id == store) & (D.po.order_date < day) & (D.po.expected_date > day)]
    p = p.merge(D.ing[["ingredient_id", "use_qty_per_order_unit"]], on="ingredient_id")
    p["use_qty"] = p.order_qty * p.use_qty_per_order_unit
    return p[["ingredient_id", "expected_date", "use_qty"]]


# ───────────────────────── 시뮬레이션 ─────────────────────────
def simulate(lots: list[tuple[pd.Timestamp, float]], demand: dict, start: pd.Timestamp, days: int,
             arrivals: dict | None = None):
    """FEFO 소진 시뮬레이션. lots=[(last_use, qty)], demand={date: qty}, arrivals={date: [(last_use, qty)]}.
    반환: 일별 dict(date, open, end, lost, waste)"""
    lots = sorted([[lu, q] for lu, q in lots if q > 0])
    arrivals = arrivals or {}
    out = []
    for k in range(days):
        t = start + pd.Timedelta(days=k)
        for lu, q in arrivals.get(t, []):
            lots.append([lu, q])
        lots.sort()
        open_q = sum(q for _, q in lots)
        need = demand.get(t, 0.0)
        for lot in lots:
            if need <= 0:
                break
            use = min(lot[1], need)
            lot[1] -= use
            need -= use
        w = sum(q for lu, q in lots if lu <= t)  # 마지막 사용일 마감 후 폐기
        lots = [[lu, q] for lu, q in lots if lu > t and q > 1e-9]
        out.append(dict(date=t, open=open_q, end=sum(q for _, q in lots), lost=need, waste=w))
    return pd.DataFrame(out), lots


# ───────────────────────── 추천 ─────────────────────────
def store_state(D: Data, store: str, day: pd.Timestamp, demand_adj=0.0, promo_on=False, horizon=10):
    fm = forecast_menus(D, store, day, horizon, demand_adj, promo_on)
    fi = forecast_ingredients(D, fm)
    sig = ingredient_sigma(D, store, day)
    lots = morning_lots(D, store, day)
    pend = pending_arrivals(D, store, day)
    return dict(fm=fm, fi=fi, sig=sig, lots=lots, pend=pend)


def _lots_of(st, ing_id):
    l = st["lots"][st["lots"].ingredient_id == ing_id]
    return list(zip(l.last_use_date, l.qty))


def _arrivals_of(st, ing_id, shelf):
    p = st["pend"][st["pend"].ingredient_id == ing_id]
    a = {}
    for _, r in p.iterrows():
        a.setdefault(r.expected_date, []).append((r.expected_date + pd.Timedelta(days=shelf - 1), r.use_qty))
    return a


def recommend(D: Data, store: str, day: pd.Timestamp, z: float = 1.28, demand_adj: float = 0.0,
              promo_on: bool = False, horizon: int = 10):
    """매장·기준일의 품목별 추천표와 상태를 반환."""
    st = store_state(D, store, day, demand_adj, promo_on, horizon)
    rows = []
    for _, it in D.ing.iterrows():
        s = D.sup.set_index("supplier_id").loc[it.supplier_id]
        pack, shelf = int(it.use_qty_per_order_unit), int(it.shelf_life_days)
        dem = st["fi"][st["fi"].ingredient_id == it.ingredient_id].set_index("date").need.to_dict()
        lots = _lots_of(st, it.ingredient_id)
        arr = _arrivals_of(st, it.ingredient_id, shelf)
        can_order = wd(day) in s.order_days_l
        order_day = day if can_order else next_order_day(s, day - pd.Timedelta(days=1))
        arrival = arrival_of(s, order_day)
        nxt_arrival = arrival_of(s, next_order_day(s, order_day))
        win = max((nxt_arrival - arrival).days, 1)  # 이번 발주가 책임지는 일수
        avg = np.mean([dem.get(day + pd.Timedelta(days=k), 0) for k in range(7)])

        base, left = simulate(lots, dem, day, horizon, arr)
        base = base.set_index("date")
        on_hand = sum(q for _, q in lots)
        # 품절 예상일 (발주 안 할 때)
        so = base[base.lost > 1e-6]
        stockout_date = so.index[0] if len(so) else None
        lost_before_arrival = base.loc[day:arrival - pd.Timedelta(days=1), "lost"].sum()
        lost_window = base.loc[arrival:nxt_arrival - pd.Timedelta(days=1), "lost"].sum()
        # 다음 입고일 아침에 남아있을 사용가능 재고
        left_at_next = base.loc[nxt_arrival - pd.Timedelta(days=1), "end"] if nxt_arrival - pd.Timedelta(days=1) in base.index else 0
        ss = z * st["sig"].get(it.ingredient_id, 0) * math.sqrt(win + 1)  # 안전재고
        need = lost_window + max(0.0, ss - left_at_next)
        rec = 0
        if can_order and need > 1e-6 and avg > 0:
            rec = max(math.ceil(need / pack), int(it.min_order_qty))
        # 기한 임박 폐기 (발주 안 할 때, 향후 3일)
        waste3 = base.loc[day:day + pd.Timedelta(days=2), "waste"].sum()
        expiring = [(lu, q) for lu, q in lots if lu <= day + pd.Timedelta(days=2)]

        days_left = on_hand / avg if avg > 0 else np.inf
        if lost_before_arrival > 1e-6:
            status = "🔴 오늘 품절 위험" if stockout_date == day else "🔴 입고 전 품절"
        elif rec > 0 and lost_window > 1e-6:
            status = "🛒 오늘 발주"
        elif rec > 0:
            status = "🟡 여유분 보충"
        elif waste3 > 1e-6:
            status = "🟠 기한 임박"
        else:
            status = "🟢 충분"
        if waste3 > 1e-6 and not status.startswith("🟠"):
            status += " · 🟠기한임박"

        rows.append(dict(
            ingredient_id=it.ingredient_id, 품목=it.ingredient_name, supplier_id=it.supplier_id,
            공급사=s.supplier_name, 보관=it.storage, use_unit=it.use_unit, order_unit=it.order_unit,
            pack=pack, shelf=shelf, min_order_qty=int(it.min_order_qty),
            can_order=can_order, order_day=order_day, arrival=arrival, next_arrival=nxt_arrival, win=win,
            on_hand=on_hand, avg=avg, days_left=days_left, stockout_date=stockout_date,
            lost_before_arrival=lost_before_arrival, lost_window=lost_window, left_at_next=left_at_next,
            ss=ss, need=need, rec=rec, waste3=waste3,
            expiring_qty=sum(q for _, q in expiring),
            expiring_date=min([lu for lu, _ in expiring]) if expiring else None,
            price=unit_price(D, it.ingredient_id, day), status=status,
        ))
    df = pd.DataFrame(rows)
    df["amount"] = df.rec * df.price
    return df, st


def project(D: Data, st, row, order_units: int, day: pd.Timestamp, horizon=10):
    """주문 수량별 재고 전망 (차트·폐기 예측용)."""
    dem = st["fi"][st["fi"].ingredient_id == row.ingredient_id].set_index("date").need.to_dict()
    lots = _lots_of(st, row.ingredient_id)
    arr = _arrivals_of(st, row.ingredient_id, row.shelf)
    if order_units > 0:
        arr = {k: list(v) for k, v in arr.items()}
        arr.setdefault(row.arrival, []).append(
            (row.arrival + pd.Timedelta(days=row.shelf - 1), order_units * row.pack))
    sim, _ = simulate(lots, dem, day, horizon, arr)
    return sim


def order_waste(D: Data, st, row, order_units: int, day: pd.Timestamp, horizon=14) -> float:
    """이번 발주로 늘어나는 예상 폐기량 (use_unit). 다음 발주들은 추가 입고가 없다고 보수적으로 가정하지 않고,
    이번 lot이 소비기한 내 소진되는지만 본다: 추가폐기 = (주문 시 폐기) - (미주문 시 폐기)."""
    a = project(D, st, row, order_units, day, horizon).waste.sum()
    b = project(D, st, row, 0, day, horizon).waste.sum()
    return max(0.0, a - b)


def min_amount_fix(D: Data, df: pd.DataFrame, supplier_id: str, qty_col="rec"):
    """최소 발주금액 미달 시 대안. 반환: (부족액, 급한품목있음, 보충안 DataFrame)"""
    s = D.sup.set_index("supplier_id").loc[supplier_id]
    sub = df[df.supplier_id == supplier_id]
    total = (sub[qty_col] * sub.price).sum()
    gap = max(0, int(s.min_order_amount) - int(total))
    if gap == 0 or total == 0:
        return gap, False, pd.DataFrame()
    urgent = bool((sub[qty_col].gt(0) & sub.status.str.startswith(("🔴", "🛒"))).any())
    # 보충 후보: 오래 가는 품목(소비기한 ≥ 30일) 중 하루 사용량(포장 기준)이 큰 순, 1단위씩
    cand = sub[(sub.shelf >= 30) & (sub.avg > 0)].copy()
    cand["daily_units"] = cand.avg / cand.pack
    cand = cand.sort_values("daily_units", ascending=False)
    add = {i: 0 for i in cand.index}
    need = gap
    guard = 0
    while need > 0 and len(cand) and guard < 200:
        for i, r in cand.iterrows():
            # 2주 사용량 이상은 당기지 않음
            if (r[qty_col] + add[i] + 1) * r.pack > r.avg * 14:
                continue
            add[i] += 1
            need -= r.price
            if need <= 0:
                break
        guard += 1
        if all((cand.loc[i, qty_col] + add[i] + 1) * cand.loc[i, "pack"] > cand.loc[i, "avg"] * 14 for i in cand.index):
            break
    plan = cand.assign(추가=[add[i] for i in cand.index])
    plan = plan[plan.추가 > 0][["ingredient_id", "품목", "order_unit", "추가", "price", "days_left"]]
    return gap, urgent, plan


def transfer_options(D: Data, store: str, day: pd.Timestamp, ing_id: str, short_qty: float, z=1.28):
    """다른 매장 여유분 (다음 입고 전까지 자기 매장 필요량 + 안전재고를 뺀 사용가능 재고)."""
    out = []
    it = D.ing.set_index("ingredient_id").loc[ing_id]
    s = D.sup.set_index("supplier_id").loc[it.supplier_id]
    for o in D.stores.store_id:
        if o == store:
            continue
        st = store_state(D, o, day, horizon=5)
        lots = _lots_of(st, ing_id)
        dem = st["fi"][st["fi"].ingredient_id == ing_id].set_index("date").need.to_dict()
        od = day if wd(day) in s.order_days_l else next_order_day(s, day - pd.Timedelta(days=1))
        arr_day = arrival_of(s, od)
        days = max((arr_day - day).days, 1)
        need_self = sum(dem.get(day + pd.Timedelta(days=k), 0) for k in range(days))
        ss = z * st["sig"].get(ing_id, 0)
        surplus = sum(q for _, q in lots) - need_self - ss
        if surplus > 0:
            out.append(dict(store_id=o, 여유=surplus, 이동가능=min(surplus, short_qty)))
    return pd.DataFrame(out)
