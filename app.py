import math
import re

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

import engine as E
import analytics_ui as A

st.set_page_config(page_title="오늘의 발주 도우미", page_icon="🍔", layout="wide")

st.markdown("""
<style>
.block-container {padding-top: 1.6rem; max-width: 1300px;}
.card {border-radius: 10px; padding: 9px 14px; margin-bottom: 7px; border: 1px solid rgba(128,128,128,.25);}
.card.red {border-left: 6px solid #e5484d;}
.card.blue {border-left: 6px solid #0090ff;}
.card.yellow {border-left: 6px solid #f5b400;}
.card.orange {border-left: 6px solid #f76b15;}
.card.green {border-left: 6px solid #30a46c;}
.card .t {font-size: 1.05rem; font-weight: 700;}
.card .r {opacity: .85;}
.card .q {float: right; font-size: 1.05rem; font-weight: 700;}
.sup {border-radius: 10px; padding: 10px 14px; margin: 6px 0 10px 0; background: rgba(128,128,128,.08);}
.big {font-size: 1.9rem; font-weight: 800; line-height: 1.1}
.lbl {opacity: .7; font-size: .9rem}
</style>
""", unsafe_allow_html=True)


@st.cache_resource
def get_data():
    return E.load()


@st.cache_data(show_spinner=False)
def get_rec(store, day, z, adj, promo):
    df, st_ = E.recommend(get_data(), store, pd.Timestamp(day), z, adj, promo)
    return df, st_


D = get_data()
WDK = E.WD


def fd(t):
    t = pd.Timestamp(t)
    return f"{t.month}/{t.day}({WDK[t.weekday()]})"


def bold(t):
    return re.sub(r"[*][*](.+?)[*][*]", r"<b>\1</b>", t)


def fq(q, unit):
    if unit in ("g", "ml") and q >= 1000:
        return f"{q/1000:,.1f}{'kg' if unit == 'g' else 'L'}"
    return f"{q:,.0f}{unit}"


# ───────────── 사이드바: 입력 ─────────────
with st.sidebar:
    st.markdown("### 🍔 오늘의 발주 도우미")
    store_names = dict(zip(D.stores.store_id, D.stores.store_name + " · " + D.stores.trade_area))
    qp = st.query_params
    sids = list(D.stores.store_id)
    store = st.selectbox("매장", sids, index=sids.index(qp.get("store", "S01")) if qp.get("store") in sids else 0,
                         format_func=lambda s: store_names[s])
    try:
        d0 = pd.Timestamp(qp.get("date", "2026-10-01"))
    except Exception:
        d0 = pd.Timestamp("2026-10-01")
    day = st.date_input("기준일 (오늘 아침)", value=d0,
                        min_value=pd.Timestamp("2026-02-01"), max_value=pd.Timestamp("2026-10-01"))
    day = pd.Timestamp(day)
    st.caption(f"{fd(day)} 07시 입고·실사 직후, 발주 마감 전 기준")
    st.divider()
    st.markdown("**조건 바꿔보기**")
    risk = st.radio("품절 대비", list(E.RISK_LEVELS), index=1,
                    help="넉넉하게: 판매 변동에 대비한 여유분을 더 쌓음 / 타이트하게: 재고·폐기 최소")
    adj = st.slider("예상 판매량 조정", -30, 30, 0, 5, format="%d%%",
                    help="날씨·주변 행사 등 감으로 아는 변화가 있으면 반영하세요") / 100
    promo = st.toggle("세트 할인 행사 진행", value=False,
                      help="과거 S02 세트 할인 행사의 판매 증가율을 대상 세트에 적용")
    st.divider()
    with st.expander("이용 방법"):
        st.markdown("1. 매장과 날짜를 고르면 **오늘 해야 할 일**이 위에 뜹니다.\n"
                    "2. **발주서** 탭에서 수량을 직접 고치면 금액·품절·폐기 점검이 바로 바뀝니다.\n"
                    "3. 확정 후 **발주서 다운로드**.")

z = E.RISK_LEVELS[risk]
with st.spinner("계산 중…"):
    df, S = get_rec(store, day.strftime("%Y-%m-%d"), z, adj, promo)

# ───────────── 헤더 ─────────────
st.markdown(f"## {D.stores.set_index('store_id').loc[store, 'store_name']} · {fd(day)} 아침 발주 판단")

n_red = df.status.str.startswith("🔴").sum()
n_ord = df.status.str.startswith("🛒").sum()
n_org = df.status.str.contains("🟠").sum()

if n_red == 0:
    st.success("오늘은 위험 품목 없음, 평소대로 발주하면 돼요")

# 사용자가 고친 수량 (session_state)
qkey = f"q_{store}_{day.date()}_{z}_{adj}_{promo}"
if qkey not in st.session_state:
    st.session_state[qkey] = dict(zip(df.ingredient_id, df.rec))
qty = st.session_state[qkey]
ver = st.session_state.setdefault(qkey + "_v", 0)
df["qty"] = df.ingredient_id.map(qty).fillna(0).astype(int)
df["amt"] = df.qty * df.price

c1, c2, c3, c4 = st.columns(4)
for c, n, lbl, col in [(c1, n_red, "🚨 위험", "#e5484d"), (c2, n_ord, "🛒 오늘 발주", "#0090ff"),
                       (c3, n_org, "🟠 기한 임박", "#f76b15")]:
    c.markdown(f"<div class='lbl'>{lbl}</div><div class='big' style='color:{col}'>{n}개</div>", unsafe_allow_html=True)
c4.markdown(f"<div class='lbl'>오늘 발주 총액</div><div class='big'>{df.amt.sum():,.0f}원</div>", unsafe_allow_html=True)

# 공급사 마감 배너
for sid, s in D.sup.set_index("supplier_id").iterrows():
    sub = df[df.supplier_id == sid]
    r0 = sub.iloc[0]
    if r0.can_order:
        cnt = int((sub.qty > 0).sum())
        msg = (f"**{s.supplier_name}** — 오늘 **{s.order_cutoff} 전**까지 발주 → **{fd(r0.arrival)} 07시 입고** · "
               f"이번에 시켜야 할 품목 **{cnt}개** · 이번 발주로 {fd(r0.next_arrival)} 아침까지 버팀")
    else:
        msg = (f"**{s.supplier_name}** — 오늘은 발주일이 아니에요. 다음 발주 {fd(r0.order_day)} "
               f"({s.order_cutoff} 마감) → {fd(r0.arrival)} 입고")
    st.markdown(f"<div class='sup'>{bold(msg)}</div>", unsafe_allow_html=True)


def reason(r):
    unit = r.use_unit
    if r.status.startswith("🔴 오늘"):
        return (f"남은 {fq(r.on_hand, unit)}로는 오늘 영업도 부족해요 (하루 약 {fq(r.avg, unit)} 사용). "
                f"입고는 {fd(r.arrival)}라 **다른 매장에서 받아와야** 해요.")
    if r.status.startswith("🔴 입고"):
        return f"{fd(r.stockout_date)} 품절 예상인데 가장 빠른 입고는 {fd(r.arrival)}예요. 매장 이동을 검토하세요."
    if r.status.startswith("🛒"):
        return (f"남은 재고 {r.days_left:.1f}일치 → **{fd(r.stockout_date)} 품절 예상**. "
                f"다음 입고 기회가 {fd(r.next_arrival)}라 오늘 시켜야 해요.")
    if r.status.startswith("🟡"):
        return (f"{fd(r.next_arrival)}까지 버티긴 하지만 남는 양({fq(r.left_at_next, unit)})이 "
                f"판매 변동 대비 여유분({fq(r.ss, unit)})보다 적어요.")
    if "🟠" in r.status:
        return (f"{fq(r.expiring_qty, unit)}가 {fd(r.expiring_date)}에 기한 만료 → "
                f"3일 내 **{fq(r.waste3, unit)} 폐기 예상**. 오늘 먼저 사용하세요.")
    if not r.can_order and r.lost_window > 1e-6:
        return f"재고 {r.days_left:.1f}일치. 오늘은 발주일이 아니고, {fd(r.order_day)} 발주 때 주문하면 돼요."
    return f"재고 {r.days_left:.1f}일치, 다음 입고까지 충분해요."


df["이유"] = df.apply(reason, axis=1)

tab1, tab_ai, tab2, tab3, tab_eda, tab4 = st.tabs(["✅ 오늘의 할 일", "💬 발주 브리핑", "📋 발주서", "🔍 품목별 근거", "📈 운영 분석", "📊 데이터·가정"])

# ───────────── 탭1: 오늘의 할 일 ─────────────
with tab1:
    order = {"🔴": 0, "🛒": 1, "🟠": 2, "🟡": 3, "🟢": 4}
    todo = df[~df.status.str.startswith("🟢")].copy()
    todo["o"] = todo.status.str[0].map(order)
    todo = todo.sort_values(["o", "days_left"])
    if todo.empty:
        st.success("오늘은 따로 챙길 품목이 없어요. 👍")
    left, right = st.columns([3, 2])
    with left:
        groups = [("🔴", "품절 위험 — 입고 전에 떨어져요, 매장 이동 필요", "red"),
                  ("🛒", "오늘 발주 — 안 시키면 다음 입고 전에 떨어져요", "blue"),
                  ("🟠", "기한 임박 — 먼저 쓰세요", "orange"),
                  ("🟡", "여유분 보충 — 시켜두면 안심", "yellow")]
        for em, title, cls in groups:
            g = todo[todo.status.str.startswith(em)] if em != "🟠" else todo[todo.status.str.contains("🟠")]
            if g.empty:
                continue
            st.markdown(f"#### {em} {title} ({len(g)})")
            for _, r in g.iterrows():
                if em == "🟠":
                    line = (f"{fq(r.expiring_qty, r.use_unit)} {fd(r.expiring_date)} 만료 · "
                            f"3일 내 {fq(r.waste3, r.use_unit)} 폐기 예상")
                    q = ""
                elif em == "🔴":
                    line = f"남은 {fq(r.on_hand, r.use_unit)} · 입고 전 품절 → 매장 이동 필요"
                    q = f"{r.qty} {r.order_unit}" if r.qty else ""
                elif em == "🛒":
                    line = f"{r.days_left:.1f}일치 남음 → {fd(r.stockout_date)} 품절 예상"
                    q = f"{r.qty} {r.order_unit}"
                else:
                    line = f"{r.days_left:.1f}일치 남음 · {fd(r.next_arrival)}까지는 버티지만 여유분 부족"
                    q = f"{r.qty} {r.order_unit}"
                st.markdown(f"<div class='card {cls}'><span class='q'>{q}</span>"
                            f"<span class='t'>{r.품목}</span>&nbsp;&nbsp;<span class='r'>{line}</span>"
                            f"<span class='lbl'>&nbsp;· {r.공급사}</span></div>", unsafe_allow_html=True)
        ok = df[df.status.str.startswith("🟢")]
        if len(ok):
            st.caption("🟢 충분: " + ", ".join(ok.품목))
    with right:
        st.markdown("#### 매장 이동 제안")
        need_tr = df[df.status.str.startswith("🔴 오늘") | df.status.str.startswith("🔴 입고")]
        if need_tr.empty:
            st.caption("오늘은 다른 매장에서 받아올 품목이 없어요.")
        for _, r in need_tr.iterrows():
            short = max(r.lost_before_arrival, r.avg)
            tr = E.transfer_options(D, store, day, r.ingredient_id, short, z)
            if tr.empty:
                st.warning(f"{r.품목}: 여유 있는 매장이 없어요 → 긴급발주 (다음날 07시 입고)")
            else:
                b = tr.sort_values("여유", ascending=False).iloc[0]
                st.info(f"**{r.품목}** — {store_names[b.store_id].split(' · ')[0]}에서 "
                        f"**{fq(b.이동가능, r.use_unit)}** 받아오기 (그 매장 여유 {fq(b.여유, r.use_unit)})")
        st.markdown("#### 최소 발주금액 점검")
        for sid, s in D.sup.set_index("supplier_id").iterrows():
            if int(s.min_order_amount) == 0:
                continue
            gap, urgent, plan = E.min_amount_fix(D, df, sid, "qty")
            tot = int(df[df.supplier_id == sid].amt.sum())
            if tot == 0:
                st.caption(f"{s.supplier_name}: 오늘 발주 없음")
            elif gap == 0:
                st.success(f"{s.supplier_name}: {tot:,}원 ≥ 최소 {int(s.min_order_amount):,}원 ✔")
            else:
                st.error(f"{s.supplier_name}: {tot:,}원 — 최소 {int(s.min_order_amount):,}원까지 **{gap:,}원 부족**")
                if urgent:
                    urg = df[(df.supplier_id == sid) & (df.qty > 0) & df.status.str.startswith(("🔴", "🛒"))]
                    alt = []
                    for _, ur in urg.iterrows():
                        trx = E.transfer_options(D, store, day, ur.ingredient_id, ur.qty * ur.pack, z)
                        if len(trx) and trx.이동가능.max() >= ur.need:
                            bb = trx.sort_values("여유", ascending=False).iloc[0]
                            alt.append(f"{ur.품목} {fq(min(bb.이동가능, ur.qty * ur.pack), ur.use_unit)} ← "
                                       f"{store_names[bb.store_id].split(' · ')[0]}")
                    if alt and len(alt) == len(urg):
                        st.markdown("**안 1) 급한 품목만 다른 매장에서 받아오고 발주는 다음 발주일로:** " + ", ".join(alt))
                        st.markdown("**안 2) 오래 보관되는 품목을 미리 채워 오늘 발주:**")
                    else:
                        st.markdown("급한 품목이 있어 미룰 수 없어요. **오래 보관되는 품목을 미리 채우는 안:**")
                else:
                    st.markdown("급한 품목이 없으니 **다음 발주일로 미뤄도 돼요.** 또는 아래처럼 채워서 오늘 발주:")
                if len(plan):
                    st.dataframe(plan.assign(남은일수=plan.days_left.round(1), 단가=[f"{p:,}원" for p in plan.price])
                                 [["품목", "추가", "order_unit", "단가", "남은일수"]]
                                 .rename(columns={"order_unit": "단위", "남은일수": "지금 재고(일치)"}), hide_index=True)
                    if st.button(f"이 안대로 {s.supplier_name} 수량 채우기", key=f"fill_{sid}"):
                        for _, p in plan.iterrows():
                            qty[p.ingredient_id] = qty.get(p.ingredient_id, 0) + int(p.추가)
                        st.session_state[qkey + "_v"] = ver + 1
                        st.rerun()

# ───────────── 탭2: 발주서 ─────────────
with tab2:
    st.caption("‘발주 수량’ 칸을 직접 고치면 금액과 아래 점검이 바로 바뀝니다.")
    for sid, s in D.sup.set_index("supplier_id").iterrows():
        sub = df[df.supplier_id == sid]
        r0 = sub.iloc[0]
        st.markdown(f"#### {s.supplier_name}  "
                    f"<span style='font-size:.9rem;opacity:.7'>"
                    f"{'오늘 ' + s.order_cutoff + ' 마감 · ' + fd(r0.arrival) + ' 입고' if r0.can_order else '오늘 발주일 아님'}"
                    f"{' · 최소 ' + format(int(s.min_order_amount), ',') + '원' if int(s.min_order_amount) else ''}</span>",
                    unsafe_allow_html=True)
        view = pd.DataFrame({
            "상태": sub.status.str.split(" · ").str[0],
            "품목": sub.품목,
            "남은 재고": [f"{r.on_hand / r.pack:.1f} {r.order_unit} ({r.days_left:.1f}일치)" if r.avg > 0
                          else f"{r.on_hand / r.pack:.1f} {r.order_unit} (판매 없음)" for r in sub.itertuples()],
            "추천": sub.rec,
            "발주 수량": sub.qty,
            "단위": sub.order_unit,
            "단가": [f"{p:,}원" for p in sub.price],
            "id": sub.ingredient_id,
        })
        ed = st.data_editor(
            view, hide_index=True, width="stretch", height=35 * (len(view) + 1) + 3, disabled=[c for c in view.columns if c != "발주 수량"],
            column_config={
                "발주 수량": st.column_config.NumberColumn(min_value=0, max_value=99, step=1),
                "id": None,
            },
            key=f"ed_{qkey}_{sid}_{ver}",
        )
        changed = False
        for _, r in ed.iterrows():
            v = int(r["발주 수량"]) if not pd.isna(r["발주 수량"]) else 0
            if qty.get(r.id) != v:
                qty[r.id] = v
                changed = True
        if changed:
            st.rerun()
        tot = int((sub.qty * sub.price).sum())
        mn = int(s.min_order_amount)
        st.markdown(f"**합계 {tot:,}원**" + ("" if mn == 0 or tot == 0 else (" ✔ 최소금액 충족" if tot >= mn else f" ⚠️ 최소금액까지 {mn - tot:,}원 부족")))

        # 수정 수량 점검
        warns = []
        for _, r in sub.iterrows():
            if not r.can_order:
                continue
            sim = E.project(D, S, r, int(r.qty), day).set_index("date")
            win = sim.loc[r.arrival:r.next_arrival - pd.Timedelta(days=1)]
            lost = win.lost.sum()
            extra_w = E.order_waste(D, S, r, int(r.qty), day)
            if lost > 1e-6:
                d0 = win[win.lost > 1e-6].index[0]
                warns.append(f"⚠️ **{r.품목}** {r.qty}{r.order_unit}이면 **{fd(d0)} 품절 예상** (부족 {fq(lost, r.use_unit)})")
            if extra_w > 0.05 * r.pack and r.qty > 0:
                warns.append(f"🗑 **{r.품목}** {r.qty}{r.order_unit}이면 기한 내 다 못 써서 **{fq(extra_w, r.use_unit)} 폐기 예상**")
        if warns:
            st.markdown("\n".join(f"- {w}" for w in warns))
        elif r0.can_order:
            st.caption("✅ 다음 입고 주기의 예상 소요량을 충당합니다. 폐기 점검은 표시된 시뮬레이션 기간 안의 추정입니다.")
        st.write("")

    out = df[df.qty > 0].assign(매장=store_names[store].split(" · ")[0], 발주일=day.date(),
                                입고예정일=df.arrival.dt.date)
    out = out[["매장", "공급사", "발주일", "입고예정일", "품목", "qty", "order_unit", "price", "amt"]].rename(
        columns={"qty": "수량", "order_unit": "단위", "price": "단가", "amt": "금액"})
    st.download_button("⬇️ 발주서 다운로드 (CSV)", out.to_csv(index=False).encode("utf-8-sig"),
                       file_name=f"발주서_{store}_{day.date()}.csv", mime="text/csv", type="primary")

# ───────────── 탭3: 품목별 근거 ─────────────
with tab3:
    sel = st.selectbox("품목", df.ingredient_id, format_func=lambda i: f"{df.set_index('ingredient_id').loc[i, 'status'].split(' · ')[0]}  {df.set_index('ingredient_id').loc[i, '품목']}")
    r = df.set_index("ingredient_id").loc[sel]
    r = r.copy(); r["ingredient_id"] = sel
    u = r.use_unit
    a, b = st.columns([2, 3])
    with a:
        st.markdown(f"### {r.품목}")
        st.markdown(r.이유)
        st.markdown("**추천 수량 계산**")
        steps = pd.DataFrame([
            ("① 하루 예상 사용량 (7일 평균)", fq(r.avg, u)),
            ("② 지금 쓸 수 있는 재고", fq(r.on_hand, u)),
            ("③ 이번 발주가 책임질 기간", f"{fd(r.arrival)} ~ {fd(r.next_arrival - pd.Timedelta(days=1))} ({r.win}일)"),
            ("④ 그 기간 동안 모자라는 양", fq(r.lost_window, u)),
            ("⑤ 판매 변동 대비 여유분", f"{fq(r.ss, u)} (‘{risk.split(' ')[0]}’ 기준)"),
            ("⑥ 다음 입고일 아침 남는 재고", fq(r.left_at_next, u)),
            ("⑦ 필요량 = ④ + max(0, ⑤−⑥)", fq(r.need, u)),
            (f"⑧ {r.order_unit} 단위로 올림 (1{r.order_unit}={r.pack:,}{u})", f"{r.rec} {r.order_unit}"),
        ], columns=["단계", "값"])
        st.dataframe(steps, hide_index=True, width="stretch")
        st.caption(f"단가 {r.price:,}원/{r.order_unit} (기준일 유효 단가) · 소비기한 {r.shelf}일 · {r.보관}")
    with b:
        cur = int(qty.get(sel, 0))
        q2 = st.number_input("이 품목 발주 수량으로 시뮬레이션", 0, 99, cur, key=f"num_{qkey}_{sel}",
                             disabled=not r.can_order)
        if q2 != cur:
            qty[sel] = int(q2)
            st.rerun()
        hz = (r.next_arrival - day).days  # 다음 입고 전날까지만
        xs = [fd(day + pd.Timedelta(days=k)) for k in range(hz)]
        fig = go.Figure()
        for label, qn, color, dash in [("발주 안 함", 0, "#8b8d98", "dot"), (f"{cur}{r.order_unit} 발주", cur, "#0090ff", "solid")]:
            sim = E.project(D, S, r, qn, day, hz)
            fig.add_trace(go.Scatter(x=sim.date.map(fd), y=sim.open / r.pack, name=label, mode="lines+markers",
                                     line=dict(color=color, dash=dash, width=3 if dash == "solid" else 2),
                                     hovertemplate="아침 %{y:.1f}" + r.order_unit + "<extra>" + label + "</extra>"))
            so = sim[sim.lost > 1e-6]
            if len(so):
                fig.add_trace(go.Scatter(x=so.date.map(fd), y=[0] * len(so), mode="markers", name=f"품절 ({label})",
                                         marker=dict(symbol="x", size=13, color="#e5484d")))
            if qn == cur:
                wsum = sim.waste.sum()
        need_line = S["fi"][S["fi"].ingredient_id == sel].set_index("date").need.iloc[:hz]
        fig.add_trace(go.Bar(x=need_line.index.map(fd), y=need_line.values / r.pack, name="그날 쓸 양",
                             marker_color="rgba(128,128,128,.25)"))
        fig.update_layout(height=380, margin=dict(l=10, r=10, t=30, b=10), yaxis_title=f"재고 ({r.order_unit})",
                          xaxis=dict(type="category", categoryorder="array", categoryarray=xs,
                                     tickmode="array", tickvals=xs),
                          legend=dict(orientation="h", y=-0.15), title="재고 전망 (아침 기준, 다음 발주분 입고 전까지)",
                          hovermode="x unified")
        st.plotly_chart(fig, use_container_width=True)
        if wsum > 0:
            st.caption(f"🗑 이 기간 기한 만료 폐기 예상: {fq(wsum, u)}")

# ───────────── 탭4: 데이터·가정 ─────────────
with tab4:
    st.markdown("#### 어떻게 계산하나요")
    fa = S["fm"].attrs
    st.markdown(
        f"- **수요 예측**: 메뉴별 최근 28일 *품절 전 수요*(demand − 취소) 평균 × 매장 요일지수 × 공휴일 배수 "
        f"(이 매장 공휴일 배수 {fa['hol_mult']:.2f}) → 메뉴 BOM으로 식자재 사용량 환산. 세트는 세트 BOM 그대로.\n"
        f"- **재고**: 전날 마감 입고묶음(lot) 잔량 + 오늘 07시 입고분 + 아침 실사조정. 사용기한 빠른 묶음부터 쓰고(FEFO), "
        f"마지막 사용일이 지나면 폐기로 계산.\n"
        f"- **추천량**: 이번 입고 ~ 다음 입고 전날까지 모자라는 양 + 판매 변동 여유분 → 발주 단위로 올림, 최소 발주수량 적용.\n"
        f"- **최소 발주금액**: 미달 시 급한 품목이 있으면 오래 보관되는 품목을 2주 사용량 한도로 당겨 채우고, 없으면 미루기를 제안.")
    st.markdown("#### 예측과 해석의 범위")
    st.info("현재 예측은 합성 데이터의 품절 전 수요를 사용합니다. 실제 운영에서는 관측 가능한 판매와 품절 기록으로 보완해야 합니다. 과거 표시된 예측 오차는 재현 근거가 없어 표시하지 않습니다.")
    st.caption("폐기 전망은 표시된 시뮬레이션 기간 안의 추정이며, 장기 보관 품목의 전체 소비기한 동안 폐기가 없다는 뜻은 아닙니다. AI 해설은 별도 탭에서 생성하며 계산 수량을 바꾸지 않습니다.")
    st.markdown("#### 데이터 사용·가정표")
    st.dataframe(pd.DataFrame([
        ("제공", "판매(09)", "demand_qty − cancel_qty를 수요로 사용 (품절로 잘린 qty 대신)"),
        ("제공", "BOM(04)·메뉴 취급(15)", "세트는 세트 BOM 직접 사용, 미취급 기간 메뉴는 수요 0"),
        ("제공", "입고묶음(16)·발주(11)", "전날 마감 잔량 + 당일 07시 입고 + 아침 실사조정 (당일 판매·기말 미사용)"),
        ("제공", "공급사(05)·단가(06)", "발주 요일·마감·리드타임·최소금액, 기준일 이하 최신 단가"),
        ("제공·가정", "실사조정", "기간 내 당일 아침 실사조정 반영. 10/1은 기록이 없어 0으로 가정"),
        ("가정", "9/30 취급 종료", "데이터 끝일 뿐이므로 10월에도 계속 취급으로 가정"),
        ("가정", "10월 공휴일", "10/3 개천절, 10/5 대체공휴일, 10/9 한글날 추가"),
        ("가정", "여유분", "z × (요일 보정 후 일 사용량 표준편차, 최근 56일) × √(책임기간+1)"),
        ("가정", "행사 배수", "S02 P01(7월 세트 할인) 기간 대상 세트 판매 ÷ 직전 28일"),
        ("가정", "최소금액 보충", "소비기한 30일 이상 품목만, 품목당 2주 사용량 한도"),
    ], columns=["구분", "항목", "처리"]), hide_index=True, width="stretch")
    if day <= pd.Timestamp("2026-09-30"):
        with st.expander("이 날 실제 기록된 발주와 비교"):
            hist = D.po[(D.po.store_id == store) & (D.po.order_date == day) & (D.po.order_type == "정기")]
            hist = hist.merge(D.ing[["ingredient_id", "ingredient_name"]], on="ingredient_id")
            comp = df[["ingredient_id", "품목", "qty", "order_unit"]].merge(
                hist[["ingredient_id", "order_qty"]], on="ingredient_id", how="left").fillna({"order_qty": 0})
            comp = comp[(comp.qty > 0) | (comp.order_qty > 0)]
            st.dataframe(comp.rename(columns={"qty": "추천", "order_qty": "실제 기록", "order_unit": "단위"})
                         [["품목", "추천", "실제 기록", "단위"]], hide_index=True)


with tab_ai:
    A.show_briefing(D, df, S, store, day, risk, adj, promo)

with tab_eda:
    A.show_eda(D, store)
