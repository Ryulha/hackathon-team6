import { DEFAULT_SETTINGS } from "../src/lib/engine";
import type { Brief, BriefContext } from "../src/lib/briefing";

export function context(): BriefContext {
  return {
    storeId: "S03", asOf: "2026-09-15", settings: { ...DEFAULT_SETTINGS }, totalAmount: 4000, itemCount: 2,
    items: [
      { id: "I020", name: "토스트 식빵", action: "입고 전 부족 대응", reason: "입고 전에 부족할 전망입니다. 다른 매장의 여유 재고를 확인하세요.",
        orderQty: 1, orderUnit: "EA", useUnit: "장", amount: 4000, arrival: "2026-09-16", shortageBefore: 3, shortageAfter: 0, existingWaste: 0, additionalWaste: 0 },
      { id: "I009", name: "양상추", action: "사용기한 우선 확인", reason: "추가 발주보다 기존 재고를 먼저 사용하세요.",
        orderQty: 0, orderUnit: "BOX", useUnit: "g", amount: 0, arrival: "2026-09-16", shortageBefore: 0, shortageAfter: 0, existingWaste: 2100, additionalWaste: 0 },
    ],
    supplierWarnings: [{ name: "공급업체 A", gap: 116000 }],
  };
}

export function brief(c = context()): Brief {
  return { overview: "입고 전 부족과 사용기한부터 확인하세요.", items: c.items.map((i) => ({ id: i.id, explanation: i.reason })) };
}

export function gemini(value: unknown = brief()) {
  return { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }] };
}
