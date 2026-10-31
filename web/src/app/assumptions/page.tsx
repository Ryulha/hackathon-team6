"use client";

import { useMemo, useState } from "react";
import { useInsights } from "@/components/use-insights";
import { OPT, SERVICE_LEVELS } from "@/lib/engine";
import { EXTRA_HOLIDAYS } from "@/lib/engine/forecast";
import { useApp } from "@/state/app-state";

const z = (k: keyof typeof SERVICE_LEVELS) => SERVICE_LEVELS[k].z;

const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "수요 예측",
    items: [
      "판매 확정 기준 수요 = 품절 전 수요(demand_qty) − 취소(cancel_qty)로 예측합니다. 품절일의 판매량만 쓰면 수요를 과소추정하고, 취소분은 식자재를 쓰지 않기 때문입니다.",
      "메뉴별 평소 수준 = 최근 N주(설정, 기본 4주) 하루 판매를 요일 효과로 나눈 평균. 미취급 기간(15번)은 0이 아니라 계산에서 제외합니다.",
      "요일 지수 = 최근 2N주 매장 전체 판매의 요일별 평균 ÷ 전체 평균(공휴일 제외). 공휴일 배수 = 과거 공휴일 판매 ÷ 직전 5주 같은 요일 평일 평균의 중앙값.",
      `데이터 이후(10/1~) 공휴일은 대한민국 공휴일 캘린더(구글 공개 캘린더)에서 받아옵니다. '공휴일'만 쓰고 기념일(국군의날·어버이날 등)은 뺍니다. 연결이 안 되면 미리 넣은 가정값(${Object.entries(EXTRA_HOLIDAYS).map(([d, n]) => `${d.slice(5)} ${n}`).join(", ")})을 씁니다.`,
      "점장은 '오늘 주문'에서 다가오는 공휴일마다 지난 공휴일처럼(배수 적용) / 평일처럼 / 쉬는 날(판매 0)을 고를 수 있고, 고르면 주문 수량이 바로 다시 계산됩니다.",
      "메뉴 수준은 최근 7일(취급한 날) 수준과 최근 N주 수준을 반씩 섞습니다(팀 엔진 3차, 백테스트로 정한 비율). 최근 2일 매장 판매(요일 보정)가 평소의 1.2배 이상이면 앞 3일 예측을 그 비율만큼 올립니다(최대 2배).",
      "AI 수요예측(기본): 팀 CatBoost 모델(data_cry 브랜치, 메뉴×매장 공통 모델, 기준일부터 0~6일 각각 직접 예측)을 그대로 학습·실행해 기준일부터 7일은 그 값을 씁니다. 8/1~9/30 기준일은 7/31까지 판매로, 10/1은 9/30까지 판매로 학습한 모델(122 trees) — 기준일 이후 정답은 학습에 쓰지 않습니다. 팀 보고서의 9/24 예측과 소수점까지 같은 값을 재현했습니다.",
      "AI 예측은 잠재 수요에 최근 56일 취소율을 반영한 판매 확정량입니다. 10/1 예측에 필요한 10월 달력은 공휴일 캘린더로, 취급 일정은 9/30 상태가 이어진다고 보고 만들었습니다(원본 파일은 수정하지 않음). 공휴일을 '평일처럼'으로 바꾼 날은 규칙 기반 평일 값을 씁니다.",
      "행사 효과는 '행사를 한다면' 시나리오로만 씁니다: 과거 행사 기간 대상 메뉴 판매 ÷ 직전 28일, 메뉴별 중앙값을 곱합니다.",
    ],
  },
  {
    title: "소요량·단위",
    items: [
      "메뉴 예측 × BOM(메뉴 1개당 사용량)으로 식자재 일별 소요량을 계산합니다. 세트 메뉴는 세트 자체의 BOM을 사용합니다.",
      "재고·소진·폐기는 사용단위(use_unit), 발주는 포장단위(order_unit)입니다. use_qty_per_order_unit으로 환산하고 발주 수량은 올림합니다.",
    ],
  },
  {
    title: "재고·사용기한",
    items: [
      "발주 판단 시점은 기준일 아침(07시 입고·영업 전 실사 후)입니다. 전날 마감 묶음별 잔량 + 오늘 입고분이 지금 재고입니다.",
      "사용기한이 빠른 묶음부터 사용(FEFO)하고, 마지막 사용일 영업 종료 후 남은 양은 폐기로 봅니다.",
      "품절 기록(17번)은 마감 후 보고되므로 기준일 전날까지만 씁니다.",
    ],
  },
  {
    title: "발주 수량 (팀 발주 최적화 엔진)",
    items: [
      "공급사 발주 가능 요일·마감 시각(정각 불가)·리드타임·입고 가능 요일로 이번 발주와 다음 발주의 도착일을 찾고, 그 사이를 이번 발주가 책임집니다.",
      "필요량 = 그 기간 예상 부족분 + max(0, 안전재고 − 다음 입고 전날 남을 양). 안전재고 = z × 하루 사용량 예측 오차의 표준편차(최근 56일, 요일 평균 제거) × √(책임 일수 + 1).",
      `z(여유분 수준, 팀 엔진 3차 튜닝값 — 3~8월 튜닝·9월 검증에서 폐기+품절 총비용 최소): 넉넉 ${z("loose")} / 보통 ${z("normal")} / 타이트 ${z("tight")}. 사용기한 ${OPT.longShelf}일 이상 품목은 최소 ${OPT.zLong}. 최근 품절 품목 상향은 튜닝 결과 효과가 없어 0으로 둡니다.`,
      "발주 엔진의 z 값은 규칙 기반 예측으로 튜닝했습니다. AI 예측과 함께 쓸 때의 총비용은 아직 따로 검증하지 않았습니다.",
      `폐기 고려 감량: 1단위 줄여도 예상 품절이 늘지 않고, 줄인 1단위의 ${OPT.wasteCutRatio * 100}% 이상이 기한 안에 못 쓰여 버려질 전망이면 줄입니다(품목 최소 발주수량은 지킴).`,
      "공급사 최소 발주금액 미달: 급한 품목(입고 전·이번 기간 품절 예상)이 없으면 다음 발주일로 미루기를 권하고, 있으면 사용기한 30일 이상 품목을 하루 사용량이 큰 순으로 1단위씩(2주 사용량까지만) 더 담는 안을 제시합니다.",
      "단가는 발주일 시점의 단가 이력(valid_from)을 적용합니다.",
    ],
  },
  {
    title: "반영하지 못한 조건 / 한계",
    items: [
      "판매·재고·발주 이력은 합성 데이터이며, 결과는 실제 매장 성과와 무관합니다.",
      "매장 간 이동은 추천하지 않습니다(알림에서 검토만 권함). 보관·품질·조리로 인한 폐기는 발주로 줄일 수 없어 계산에 넣지 않습니다.",
      "발주 확정은 모의 구현이며 실제 공급사 시스템과 연동되지 않습니다.",
    ],
  },
];

export default function AssumptionsPage() {
  const { snapshot } = useApp();
  const insights = useInsights(snapshot?.meta.storeId);
  return (
    <>
      <header>
        <h2 className="text-xl font-bold tracking-[-0.02em]">가정·근거</h2>
        <p className="hint mt-1">추천이 어떤 데이터와 규칙으로 계산되는지, 데이터를 어떻게 검증했는지 정리했습니다.</p>
      </header>
      <section className="card text-sm">
        <h3 className="section-title mb-1">데이터</h3>
        {snapshot && (
          <p>기록 기간 {snapshot.meta.dataStart} ~ {snapshot.meta.dataEnd} · 기준일 {snapshot.meta.asOf} · 출처 {snapshot.meta.source === "db" ? "Postgres DB" : "번들 JSON(DB 장애 시 폴백)"}
            {snapshot.meta.fixture && " · 개발용 합성 픽스처"}</p>
        )}
        {insights?.runInfo && <p className="hint mt-1">팀 전처리·분석 적재: {new Date(insights.runInfo.run_at).toLocaleString("ko-KR")} · 코드 {insights.runInfo.team_code}</p>}
      </section>

      {SECTIONS.map((s) => (
        <section key={s.title} className="card text-sm">
          <h3 className="section-title mb-1">{s.title}</h3>
          <ul className="ml-4 list-disc space-y-1">{s.items.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </section>
      ))}

      <Backtest />
      {insights && <Validation rows={insights.validation} />}
      {insights && <Dictionary rows={insights.dictionary} />}
    </>
  );
}

/** 팀 백테스트 결과 (feature/order-optimization 최적화로그.md, analysis/backtest_summary.csv) */
const BACKTEST = [
  { label: "실제 과거 발주 (기준)", waste: 23481, stockout: 6, inv: 1638619, amount: 21849600 },
  { label: "엔진 + 품절 이력 z 상향", waste: 8053, stockout: 23, inv: 916675, amount: 20874800 },
  { label: "넉넉 (z 2.05 일괄)", waste: 12850, stockout: 15, inv: 1008408, amount: 21204500 },
  { label: "채택: 기한별 차등 z", waste: 8053, stockout: 17, inv: 986652, amount: 21144400 },
];

function Backtest() {
  const f = (n: number) => n.toLocaleString("ko-KR");
  return (
    <section className="card overflow-x-auto text-sm">
      <h3 className="section-title">추천 방식 검증 (백테스트)</h3>
      <p className="hint mb-2">팀에서 가상매장 C의 2026년 9월을 같은 시작 재고·같은 실제 수요로 다시 돌려, 과거 실제 발주와 엔진 추천을 비교했습니다. 품절 시 다음 날 긴급 입고로 가정했습니다.</p>
      <table className="tbl">
        <thead><tr><th>방식</th><th className="num">기한 경과 폐기</th><th className="num">품절(품목·일)</th><th className="num">평균 재고금액</th><th className="num">발주금액</th></tr></thead>
        <tbody>
          {BACKTEST.map((r) => (
            <tr key={r.label} style={r.label.startsWith("채택") ? { background: "var(--accent-soft)", boxShadow: "inset 3px 0 0 var(--brand)" } : undefined}>
              <td>{r.label}</td><td className="num">{f(r.waste)}원</td><td className="num">{r.stockout}</td><td className="num">{f(r.inv)}원</td><td className="num">{f(r.amount)}원</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2">채택한 방식은 실제 과거 발주보다 <b>기한 경과 폐기 −66%, 평균 재고 −40%, 발주금액 −3%</b>였습니다.
        다만 <b>품절은 6 → 17로 늘었습니다</b> — 일부는 연휴 수요 급증처럼 안전재고로 막기 어려운 날로 추정되어 원인을 확인 중입니다. 품절을 더 줄이려면 추천 설정에서 &lsquo;넉넉하게&rsquo;를 고르세요.</p>
      <p className="hint mt-1">합성 데이터 기준 시뮬레이션 결과이며 실제 매장 성과가 아닙니다.</p>
    </section>
  );
}

function Validation({ rows }: { rows: { check: string; status: string; issue_count: number; detail: string | null }[] }) {
  const [all, setAll] = useState(false);
  const pass = rows.filter((r) => r.status === "PASS").length;
  const notPass = rows.filter((r) => r.status !== "PASS");
  const shown = all ? rows : notPass;
  return (
    <section className="card overflow-x-auto text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="section-title">데이터 검증 결과</h3>
        <button className="btn-ghost text-xs" onClick={() => setAll((v) => !v)}>{all ? "확인 필요 항목만" : `전체 ${rows.length}항목 보기`}</button>
      </div>
      <p className="hint mb-2">팀 전처리 단계에서 원본 17개 파일의 키·단위·재고 수지·수량 관계 등을 점검했습니다.
        <b className="text-[var(--foreground)]"> {rows.length}항목 중 {pass}항목 통과</b>{notPass.length ? `, 확인 필요 ${notPass.length}항목` : ""}.</p>
      {shown.length > 0 && (
        <table className="tbl">
          <thead><tr><th>점검</th><th>결과</th><th className="num">해당 건수</th><th>내용</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.check}>
              <td>{r.check}</td>
              <td><span className={`badge ${r.status === "PASS" ? "badge-muted" : r.status === "WARN" ? "badge-medium" : "badge-high"}`}>{r.status === "PASS" ? "통과" : r.status === "WARN" ? "주의" : "실패"}</span></td>
              <td className="num">{r.issue_count}</td><td className="hint">{r.detail ?? ""}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

function Dictionary({ rows }: { rows: { column: string; dtype: string; available_at: string; definition: string }[] }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? rows.filter((r) => r.column.toLowerCase().includes(k) || r.definition.toLowerCase().includes(k)) : rows.slice(0, 8);
  }, [q, rows]);
  return (
    <section className="card overflow-x-auto text-sm">
      <h3 className="section-title">용어 사전</h3>
      <p className="hint mb-2">분석에 쓴 {rows.length}개 항목의 정의와 언제 알 수 있는 값인지(판단 시점) 정리했습니다.</p>
      <input className="input mb-2 w-full max-w-sm" placeholder="예: 소진, closing, 안전재고" value={q} onChange={(e) => setQ(e.target.value)} aria-label="용어 검색" />
      <table className="tbl">
        <thead><tr><th>항목</th><th>알 수 있는 시점</th><th>정의</th></tr></thead>
        <tbody>{hits.map((r) => (
          <tr key={r.column}><td className="font-mono text-xs whitespace-nowrap">{r.column}</td><td className="hint whitespace-nowrap">{r.available_at}</td><td>{r.definition}</td></tr>
        ))}</tbody>
      </table>
      {!q && rows.length > hits.length && <p className="hint mt-1">검색하면 전체 {rows.length}개 중에서 찾습니다.</p>}
      {q && !hits.length && <p className="hint mt-1">찾는 용어가 없습니다.</p>}
    </section>
  );
}
