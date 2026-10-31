"use client";

import { useApp } from "@/state/app-state";

// TODO(10/31): 실제 데이터 검증 결과(pipeline/reports/validation.md)로 문구·수치 갱신
const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "수요 예측",
    items: [
      "판매량(qty)이 아니라 품절 제한 전 수요(demand_qty)를 기준으로 예측합니다. 품절일의 판매량만 쓰면 수요를 과소추정하기 때문입니다.",
      "최근 N주(설정) 같은 요일 평균을 기본으로 하고, 프로모션 대상 메뉴(target_menu)·기간에는 과거 프로모션 대비 증가율을 곱합니다.",
      "메뉴 미취급 기간(15번)은 수요 0과 구분해 평균 계산에서 제외합니다.",
      "공휴일 효과는 아직 반영하지 않습니다.",
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
      "기준일 전날 영업 종료 후 입고 묶음별 잔량을 기준일 시작 재고로 사용합니다.",
      "사용기한이 빠른 묶음부터 사용(FEFO)하고, 마지막 사용일 영업 종료 후 남은 양은 폐기로 봅니다.",
      "입고는 영업 시작 전에 도착한다고 가정합니다.",
    ],
  },
  {
    title: "발주",
    items: [
      "공급사 발주 가능 요일·마감 시각·리드타임(달력일)·입고 가능 요일을 반영해 다음 두 번의 발주 기회를 찾습니다.",
      "이번 발주량 = 이번 입고일부터 다음 입고일 전까지의 부족량 + 안전재고 − (현재고·입고 예정분 반영 후 남는 재고).",
      "품목 최소 발주수량과 공급사 발주서 1건의 최소 발주금액을 확인합니다. 미달이면 경고만 하고 자동으로 늘리지 않습니다.",
      "예정일이 지났는데 입고되지 않은 발주분은 기준일에 도착한다고 가정합니다.",
      "단가는 발주일 시점의 단가 이력(valid_from)을 적용합니다.",
    ],
  },
  {
    title: "반영하지 못한 조건 / 한계",
    items: [
      "판매·재고·발주 이력은 합성 데이터이며, 결과는 실제 매장 성과와 무관합니다.",
      "발주 확정은 모의 구현이며 실제 공급사 시스템과 연동되지 않습니다.",
    ],
  },
];

export default function AssumptionsPage() {
  const { snapshot } = useApp();
  return (
    <>
      <section className="card text-sm">
        <h2 className="mb-1 font-semibold">데이터</h2>
        {snapshot && (
          <p>기록 기간 {snapshot.meta.dataStart} ~ {snapshot.meta.dataEnd} · 기준일 {snapshot.meta.asOf} · 출처 {snapshot.meta.source === "db" ? "Postgres DB" : "번들 JSON(DB 장애 시 폴백)"}
            {snapshot.meta.fixture && " · 개발용 합성 픽스처"}</p>
        )}
      </section>
      {SECTIONS.map((s) => (
        <section key={s.title} className="card text-sm">
          <h2 className="mb-1 font-semibold">{s.title}</h2>
          <ul className="ml-4 list-disc space-y-1">{s.items.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </section>
      ))}
    </>
  );
}
