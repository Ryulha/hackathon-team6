import "server-only";
import { sql } from "@/db/client";

/**
 * 팀 데이터 분석 결과(pipeline/run_all.py 가 적재한 ana_* 테이블) — 화면 근거 카드용.
 * 분석 표는 파이프라인을 다시 돌리기 전에는 바뀌지 않으므로 서버 인스턴스에 캐시한다.
 * DB 가 없거나 아직 적재 전이면 available=false (화면에서 해당 카드를 숨김).
 */
export type Insights = {
  available: boolean;
  /** 폐기 사유별 비용·비중 (전체 매장, 전체 기간) */
  wasteReasons: { reason: string; waste_cost: number; cost_share: number; management_scope: string }[];
  /** 식자재별 가장 큰 폐기 사유 (전체 매장, 전체 기간) */
  wasteByIngredient: Record<string, { reason: string; cost: number; total: number }>;
  /** 양상추 1박스가 매장별 며칠치인지 + 기한 경과 폐기 */
  packCoverage: { store_id: string; store_name: string; avg_daily_consumed_qty: number; pack_qty: number; shelf_life_days: number; one_pack_days: number; expiry_waste_cost: number; expiry_waste_events: number }[];
  /** 이 매장 요일별 평균 판매(판매 확정 수량) */
  weekday: { weekday: string; avg_net_sales: number }[];
  validation: { check: string; status: string; issue_count: number; detail: string | null }[];
  dictionary: { column: string; dtype: string; available_at: string; definition: string }[];
  /** EDA 요약 문장 */
  insights: string[];
  runInfo: { run_at: string; team_code: string } | null;
};

const EMPTY: Insights = {
  available: false, wasteReasons: [], wasteByIngredient: {}, packCoverage: [], weekday: [], validation: [], dictionary: [], insights: [], runInfo: null,
};

let shared: Promise<Omit<Insights, "weekday">> | null = null;
const byStore = new Map<string, Promise<Insights["weekday"]>>();

async function q<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await sql!.query(text, params)) as T[];
}

async function loadShared(): Promise<Omit<Insights, "weekday">> {
  const [reasons, byIng, pack, validation, dictionary, meta] = await Promise.all([
    q<Insights["wasteReasons"][number]>(`SELECT reason, waste_cost, cost_share, management_scope FROM ana_waste_reason_summary ORDER BY waste_cost DESC`),
    q<{ ingredient_id: string; reason: string; waste_cost: number }>(`SELECT ingredient_id, reason, waste_cost FROM ana_waste_by_reason`),
    q<Insights["packCoverage"][number]>(`SELECT store_id, store_name, avg_daily_consumed_qty, pack_qty, shelf_life_days, one_pack_days, expiry_waste_cost, expiry_waste_events FROM ana_lettuce_pack_coverage ORDER BY store_id`),
    q<Insights["validation"][number]>(`SELECT "check", status, issue_count, detail FROM ana_validation_checks`),
    q<Insights["dictionary"][number]>(`SELECT "column", dtype, available_at, definition FROM ana_data_dictionary`),
    q<{ name: string; data: unknown }>(`SELECT name, data FROM ana_meta WHERE name IN ('eda_summary', 'run_info')`),
  ]);
  const wasteByIngredient: Insights["wasteByIngredient"] = {};
  for (const r of byIng) {
    const cur = wasteByIngredient[r.ingredient_id] ?? { reason: r.reason, cost: 0, total: 0 };
    cur.total += r.waste_cost;
    if (r.waste_cost > cur.cost) Object.assign(cur, { reason: r.reason, cost: r.waste_cost });
    wasteByIngredient[r.ingredient_id] = cur;
  }
  const eda = meta.find((m) => m.name === "eda_summary")?.data as { insights?: string[] } | undefined;
  const run = meta.find((m) => m.name === "run_info")?.data as Insights["runInfo"] | undefined;
  return {
    available: true, wasteReasons: reasons, wasteByIngredient, packCoverage: pack, validation, dictionary,
    insights: eda?.insights ?? [], runInfo: run ? { run_at: run.run_at, team_code: run.team_code } : null,
  };
}

export async function getInsights(storeId: string): Promise<Insights> {
  if (!sql) return EMPTY;
  try {
    shared ??= loadShared().catch((e) => { shared = null; throw e; });
    if (!byStore.has(storeId)) {
      byStore.set(storeId, q<Insights["weekday"][number]>(
        `SELECT weekday, avg_net_sales FROM ana_weekday_sales WHERE store_id = $1 ORDER BY weekday_order`, [storeId],
      ).catch((e) => { byStore.delete(storeId); throw e; }));
    }
    const [s, weekday] = await Promise.all([shared, byStore.get(storeId)!]);
    return { ...s, weekday };
  } catch (e) {
    console.error("[insights] 분석 표 조회 실패 — 파이프라인(run_all.py) 적재 여부 확인", e);
    return EMPTY;
  }
}
