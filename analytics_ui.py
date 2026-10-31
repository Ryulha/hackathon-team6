"""기존 발주 화면에 연결하는 EDA·검증·AI 브리핑 UI."""
from pathlib import Path
import json
import os

import pandas as pd
import plotly.express as px
import streamlit as st

import briefing as B

ANALYSIS = Path(__file__).resolve().parent / "analysis"


def setting(name, default=""):
    value = os.environ.get(name)
    if value:
        return value
    try:
        return str(st.secrets.get(name, default))
    except (FileNotFoundError, KeyError):
        return default


def show_briefing(D, df, state, store, day, risk, adj, promo):
    context = B.build_context(D, df, state, store, day, risk, adj, promo)
    fingerprint = B.context_hash(context)
    key = "brief_" + fingerprint
    st.markdown("### 오늘 발주를 짧게 정리했어요")
    st.caption("발주서에서 수정한 수량을 반영합니다. 수량·금액·입고일은 계산 결과이며, AI는 이유를 설명합니다.")
    api_key = setting("OPENAI_API_KEY")
    with st.expander("AI 연결 설정"):
        if api_key:
            st.caption("서버에 API 키가 설정되어 있습니다.")
        else:
            api_key = st.text_input("OpenAI API 키", type="password", key="private_api_key", help="현재 세션에서만 사용하며 보고서와 파일에 저장하지 않습니다.")
        model = st.text_input("모델", value=setting("OPENAI_MODEL", "gpt-4.1-mini"), key="api_model")
        st.caption("해설 생성 버튼을 누르면 선택 매장의 계산 요약이 OpenAI로 전송됩니다. 원본 CSV 전체는 전송하지 않습니다.")
    if st.button("AI 해설 생성 / 새로고침", disabled=not bool(api_key), type="primary", key="generate_ai"):
        with st.spinner("발주 이유를 정리하고 있어요…"):
            try:
                st.session_state[key] = B.generate_brief(context, api_key, model)
            except B.BriefingError as error:
                st.warning(str(error))
    brief = st.session_state.get(key) or B.default_brief(context)
    st.info(brief["overview"])
    st.caption(f"{brief['source']} · {brief['generated_at'][:19].replace('T', ' ')} (한국시간)")
    if not api_key:
        st.caption("현재는 계산 기반 기본 브리핑입니다. 키를 설정하면 같은 계산 결과를 AI가 풀어서 설명합니다.")
    for s in context["suppliers"]:
        if s["gap"]:
            st.error(f"{s['name']}: 최소 발주금액까지 {s['gap']:,}원 부족합니다.")
    reasons = {x["ingredient_id"]: x["explanation"] for x in brief["items"]}
    active = [x for x in context["items"] if x["action"] != "추가 발주 보류" or x["expiry_waste_next_3d"]]
    if not active:
        st.success("이번 발주 주기에 추가로 챙길 품목이 없습니다.")
    def show_item(x):
        with st.container(border=True):
            st.markdown(f"**{x['name']} · {x['order_qty']}{x['order_unit']} · {x['action']}**")
            st.caption(f"가상 금액 {x['amount']:,}원 · 가장 빠른 정기 입고 {x['arrival_date'][5:]} · 다음 입고 기회 {x['next_arrival_date'][5:]}")
            st.write(reasons[x["ingredient_id"]])
            if x["expiry_waste_next_3d"]:
                st.caption(f"기존 재고에서 3일 내 기한 만료 폐기 예상 {x['expiry_waste_next_3d']:,.1f}{x['use_unit']} · 사용기한이 빠른 재고부터 사용")
    for x in active[:5]:
        show_item(x)
    if len(active) > 5:
        with st.expander(f"추가 확인할 품목 {len(active) - 5}개"):
            for x in active[5:]:
                show_item(x)
    with st.expander("충분한 품목과 해석 범위"):
        for x in context["items"]:
            if x not in active:
                st.write(f"{x['name']}: {reasons[x['ingredient_id']]}")
        for note in context["limitations"]:
            st.caption(note)
    md = B.markdown_report(context, brief)
    st.download_button("발주 브리핑 다운로드", md.encode("utf-8-sig"), file_name=f"발주브리핑_{store}_{day.date()}.md", mime="text/markdown")
    with st.expander("개발·검증용 계산 근거 JSON"):
        st.download_button("LLM 입력 JSON 다운로드", json.dumps(context, ensure_ascii=False, indent=2, allow_nan=False).encode(), file_name=f"발주근거_{store}_{day.date()}.json", mime="application/json")


@st.cache_data(show_spinner=False)
def load_analysis():
    return pd.read_csv(ANALYSIS / "ingredient_daily.csv", parse_dates=["date"]), pd.read_csv(ANALYSIS / "menu_daily.csv", parse_dates=["date"])


@st.cache_data(show_spinner=False)
def load_waste():
    return pd.read_csv(ANALYSIS.parent / "data" / "13_waste.csv", parse_dates=["date"])


def show_eda(D, store):
    st.markdown("### 판매·폐기 이력에서 관리할 부분을 찾아보세요")
    if not (ANALYSIS / "ingredient_daily.csv").exists():
        st.info("분석 데이터를 먼저 생성해 주세요: python pipeline.py")
        return
    panel, menus = load_analysis()
    sids = ["전체"] + list(D.stores.store_id)
    names = D.stores.set_index("store_id").store_name.to_dict()
    a, b = st.columns([1, 2])
    selected = a.selectbox("분석할 매장", sids, index=sids.index(store), format_func=lambda x: names.get(x, x), key="eda_store")
    dates = b.date_input("분석 기간", value=(menus.date.min().date(), menus.date.max().date()), min_value=menus.date.min().date(), max_value=menus.date.max().date(), key="eda_range")
    st.caption("제공 기간의 사후 분석입니다. 이 탭의 당일 실적은 아침 발주 예측에 입력되지 않습니다. 모든 비용은 가상 금액입니다.")
    if len(dates) != 2:
        st.info("시작일과 종료일을 선택하세요.")
        return
    start, end = map(pd.Timestamp, dates)
    p = panel[panel.date.between(start, end)]
    m = menus[menus.date.between(start, end)]
    if selected != "전체":
        p, m = p[p.store_id == selected], m[m.store_id == selected]
    waste_detail = load_waste()
    waste_detail = waste_detail[waste_detail.date.between(start, end)]
    if selected != "전체":
        waste_detail = waste_detail[waste_detail.store_id == selected]
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("확정 판매", f"{m.net_sales_qty.sum():,.0f}개")
    c2.metric("품절로 놓친 메뉴", f"{m.lost_qty.sum():,.0f}개")
    c3.metric("가상 폐기비용", f"{p.waste_cost.sum():,.0f}원")
    c4.metric("품절 품목·일", f"{p.stockout_flag.sum():,.0f}건")
    st.caption("확정 판매는 주문−취소입니다. 품절 품목·일은 한 날 여러 식자재가 품절이면 각각 셉니다.")
    st.markdown("#### 폐기 사유에 따라 대응을 구분하세요")
    reason = waste_detail.groupby("reason", as_index=False).waste_cost.sum().sort_values("waste_cost", ascending=False)
    reason["비중"] = reason.waste_cost / reason.waste_cost.sum() if reason.waste_cost.sum() else 0
    reason["관리 방향"] = reason.reason.map(lambda x: "발주·재고 운용 개선 검토" if x == "소비기한 경과" else "보관·품질·조리 운영 관리")
    st.dataframe(reason.rename(columns={"reason": "폐기 사유", "waste_cost": "가상 폐기비용(원)"}), hide_index=True, width="stretch", column_config={"비중": st.column_config.NumberColumn(format="percent")})
    st.caption("비중은 비용 기준입니다. 소비기한 경과도 전액 줄일 수 있는 금액은 아닙니다. 보관·품질·조리 폐기는 발주 개선 효과 산정에서 제외합니다.")
    left, right = st.columns(2)
    waste = waste_detail[waste_detail.reason.eq("소비기한 경과")].groupby("ingredient_id", as_index=False).waste_cost.sum().merge(D.ing[["ingredient_id", "ingredient_name"]], on="ingredient_id", validate="many_to_one").sort_values("waste_cost").tail(8)
    with left:
        st.markdown("#### 소비기한 경과 폐기가 큰 식자재")
        if waste.empty:
            st.caption("선택 범위에는 소비기한 경과 폐기가 없습니다.")
        else:
            fig = px.bar(waste, x="waste_cost", y="ingredient_name", orientation="h", labels={"waste_cost": "소비기한 경과 가상 비용 (원)", "ingredient_name": "식자재"}, color_discrete_sequence=["#418361"])
            fig.update_layout(height=350, margin=dict(l=0, r=15, t=10, b=10))
            st.plotly_chart(fig, use_container_width=True)
    with right:
        st.markdown("#### 양상추 1박스 = 며칠치?")
        lettuce = panel[panel.date.between(start, end) & panel.ingredient_name.eq("양상추")].groupby("store_name", as_index=False).agg(avg=("consumed_qty", "mean"), pack=("use_qty_per_order_unit", "first"))
        lettuce["하루 평균 소진(kg)"] = lettuce.avg / 1000
        lettuce["1박스(일치)"] = lettuce.pack / lettuce.avg.where(lettuce.avg.gt(0))
        expiry = load_waste()
        expiry = expiry[expiry.date.between(start, end) & expiry.reason.eq("소비기한 경과") & expiry.ingredient_id.eq("I009")]
        expiry = expiry.groupby("store_id", as_index=False).agg(기한경과폐기비용=("waste_cost", "sum"), 발생횟수=("waste_cost", "size"))
        expiry = D.stores[["store_id", "store_name"]].merge(expiry, on="store_id", how="left", validate="one_to_one")
        lettuce = lettuce.merge(expiry.drop(columns="store_id"), on="store_name", how="left", validate="one_to_one")
        lettuce[["기한경과폐기비용", "발생횟수"]] = lettuce[["기한경과폐기비용", "발생횟수"]].fillna(0).astype(int)
        st.dataframe(lettuce.rename(columns={"store_name": "매장", "기한경과폐기비용": "기한 경과 폐기비용", "발생횟수": "발생 횟수"})[["매장", "하루 평균 소진(kg)", "1박스(일치)", "기한 경과 폐기비용", "발생 횟수"]], hide_index=True, width="stretch", column_config={"하루 평균 소진(kg)": st.column_config.NumberColumn(format="%.2f"), "1박스(일치)": st.column_config.NumberColumn(format="%.2f"), "기한 경과 폐기비용": st.column_config.NumberColumn(format="%d원"), "발생 횟수": st.column_config.NumberColumn(format="%d회")})
        st.caption("폐기비용·횟수는 선택 기간의 양상추 소비기한 경과 기록만 집계합니다. 전체 제공 기간에는 A 0원·0회, B 63,192원·2회, C 105,134원·6회입니다.")
        st.caption("전체 매장 비교 · 선택한 기간의 실제 소진 평균 기준. 양상추 1박스는 8kg, 소비기한은 입고일 포함 5일입니다. 현재 남는 양이나 폐기 발생을 뜻하지 않습니다.")
    lost = m.groupby("menu_name", as_index=False)[["demand_qty", "lost_qty"]].sum().sort_values("lost_qty", ascending=False)
    lost = lost[lost.lost_qty > 0].head(8)
    st.markdown("#### 품절 때문에 놓친 메뉴")
    if lost.empty:
        st.caption("선택한 범위에는 품절 판매손실이 없습니다.")
    else:
        lost["손실률"] = lost.lost_qty / lost.demand_qty
        st.dataframe(lost.rename(columns={"menu_name": "메뉴", "demand_qty": "품절 전 수요", "lost_qty": "놓친 메뉴 수량"}), hide_index=True, width="stretch", column_config={"손실률": st.column_config.NumberColumn(format="percent")})
    a, b = st.columns(2)
    a.download_button("선택 범위 분석 데이터 CSV", p.to_csv(index=False).encode("utf-8-sig"), file_name="식자재_분석용데이터.csv", mime="text/csv")
    b.download_button("전체 기간 운영 분석 보고서", (ANALYSIS / "운영_분석_보고서.html").read_bytes(), file_name="운영_분석_보고서.html", mime="text/html")
    with st.expander("데이터 검증과 컬럼 설명"):
        checks = pd.read_csv(ANALYSIS / "validation_checks.csv")
        failures = int(checks.status.eq("FAIL").sum())
        st.write(f"{len(checks)}개 검사항목 · 오류 {failures}건 · 안내 {int(checks.status.eq('WARN').sum())}개")
        st.dataframe(checks, hide_index=True, width="stretch")
        st.download_button("검증 결과 CSV", (ANALYSIS / "validation_checks.csv").read_bytes(), file_name="데이터_검증결과.csv", mime="text/csv")
        st.download_button("데이터 컬럼 설명 CSV", (ANALYSIS / "data_dictionary.csv").read_bytes(), file_name="데이터_컬럼설명.csv", mime="text/csv")
