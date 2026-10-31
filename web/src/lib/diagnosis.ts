// 슈퍼바이저 매장 진단 — 매장별 손익 지표와 '방문 전 확인할 것' (순수 함수, 테스트 가능)
// 인건비는 제공 데이터에 없어 제외한다.

export type Period = {
  sales: number;
  /** 식자재비 = 실제 소진량 × 단가 (팀 분석 ana_ingredient_daily.consumed_cost) */
  food: number;
  waste: number;
  /** 폐기 중 사용기한 경과분 (발주로 줄일 수 있는 폐기) */
  expiryWaste: number;
  lostQty: number;
  /** 품절로 못 판 금액 = 품절 수량 × 판매가 */
  lostAmount: number;
  emergencyCount: number;
  emergencyAmount: number;
};
export type WasteCause = { ingredient: string; reason: string; cost: number };
export type StoreInput = { storeId: string; storeName: string; cur: Period; prev: Period; wasteTop: WasteCause[]; emergencyItems: string[] };

/** 경고 기준 — 화면에 그대로 문장으로 보여준다 */
export const RULES = {
  foodRatioPp: 0.005, // 식자재비율: 다른 매장 평균·직전 기간보다 0.5%p 이상 높으면
  wasteTimes: 1.5, // 폐기율: 다른 매장 평균·직전 기간의 1.5배 이상이면
} as const;

export type Flag = { key: "food" | "waste" | "emergency" | "lost"; text: string };
export type StoreDiagnosis = StoreInput & {
  foodRatio: number;
  prevFoodRatio: number;
  othersFoodRatio: number;
  wasteRatio: number;
  prevWasteRatio: number;
  othersWasteRatio: number;
  flags: Flag[];
  /** 방문 전 준비할 해결책 */
  actions: string[];
};

const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const pp = (x: number) => `${(x * 100).toFixed(1)}%p`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const ACTION_BY_REASON: Record<string, (item: string) => string> = {
  "소비기한 경과": (i) => `${i}: 사용기한 안에 다 못 써서 버림 → 발주량을 줄이거나 작은 포장으로 바꾸기 검토 (발주로 줄일 수 있는 폐기)`,
  "보관 불량": (i) => `${i}: 보관 문제로 버림 → 냉장·냉동 온도 기록과 밀봉 상태를 현장에서 확인`,
  "품질 이상": (i) => `${i}: 품질 문제로 버림 → 입고 검수 강화, 공급사에 품질 이슈 전달`,
  "조리 실수": (i) => `${i}: 조리 실수로 버림 → 조리 순서·계량 교육 점검`,
};

export function diagnose(stores: StoreInput[]): StoreDiagnosis[] {
  const fr = (p: Period) => ratio(p.food, p.sales);
  const wr = (p: Period) => ratio(p.waste, p.sales);
  return stores.map((s) => {
    const others = stores.filter((o) => o.storeId !== s.storeId);
    const foodRatio = fr(s.cur);
    const prevFoodRatio = fr(s.prev);
    const othersFoodRatio = mean(others.map((o) => fr(o.cur)));
    const wasteRatio = wr(s.cur);
    const prevWasteRatio = wr(s.prev);
    const othersWasteRatio = mean(others.map((o) => wr(o.cur)));
    const flags: Flag[] = [];

    const foodVsOthers = foodRatio - othersFoodRatio;
    const foodVsPrev = foodRatio - prevFoodRatio;
    if (others.length && foodVsOthers >= RULES.foodRatioPp) flags.push({ key: "food", text: `식자재비율 ${pct(foodRatio)} — 다른 매장 평균(${pct(othersFoodRatio)})보다 ${pp(foodVsOthers)} 높음` });
    else if (s.prev.sales > 0 && foodVsPrev >= RULES.foodRatioPp) flags.push({ key: "food", text: `식자재비율 ${pct(foodRatio)} — 직전 기간(${pct(prevFoodRatio)})보다 ${pp(foodVsPrev)} 올라감` });

    if (s.cur.waste > 0) {
      if (others.length && othersWasteRatio > 0 && wasteRatio >= othersWasteRatio * RULES.wasteTimes) {
        flags.push({ key: "waste", text: `폐기율 ${pct(wasteRatio, 2)} — 다른 매장 평균(${pct(othersWasteRatio, 2)})의 ${(wasteRatio / othersWasteRatio).toFixed(1)}배` });
      } else if (prevWasteRatio > 0 && wasteRatio >= prevWasteRatio * RULES.wasteTimes) {
        flags.push({ key: "waste", text: `폐기율 ${pct(wasteRatio, 2)} — 직전 기간(${pct(prevWasteRatio, 2)})의 ${(wasteRatio / prevWasteRatio).toFixed(1)}배` });
      }
    }
    if (s.cur.emergencyCount > 0) flags.push({ key: "emergency", text: `긴급발주 ${s.cur.emergencyCount}회 (${Math.round(s.cur.emergencyAmount).toLocaleString("ko-KR")}원)${s.emergencyItems.length ? ` — ${s.emergencyItems.join(", ")}` : ""}` });
    if (s.cur.lostQty > 0) flags.push({ key: "lost", text: `품절로 못 판 메뉴 ${s.cur.lostQty}개 (약 ${Math.round(s.cur.lostAmount).toLocaleString("ko-KR")}원)` });

    const actions: string[] = [];
    if (flags.some((f) => f.key === "waste" || f.key === "food")) {
      for (const c of s.wasteTop.slice(0, 2)) actions.push((ACTION_BY_REASON[c.reason] ?? ((i: string) => `${i}: ${c.reason} 원인 확인`))(c.ingredient));
    }
    if (flags.some((f) => f.key === "food") && !s.wasteTop.length) actions.push("폐기가 아닌데 식자재비율이 오름 → 단가 변경·메뉴 구성(세트 비중) 확인");
    if (flags.some((f) => f.key === "emergency" || f.key === "lost")) actions.push("품절·긴급발주 품목은 발주 여유분을 '넉넉하게'로, 품절이 난 시간대에 재고가 충분했는지 확인");
    return { ...s, foodRatio, prevFoodRatio, othersFoodRatio, wasteRatio, prevWasteRatio, othersWasteRatio, flags, actions };
  });
}
