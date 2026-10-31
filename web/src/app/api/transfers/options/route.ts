// 매장 간 이동 후보 — 부족한 품목을 여유 있게 가진 다른 매장 (점장만)
// 현장: 본사 승인 없이 매장끼리 협의, 배달대행으로 운송(운송비는 매장 배달대행 예치금)
import { sql } from "@/db/client";
import { requireSession } from "@/lib/auth/session";

/** 보내는 매장도 최소 이만큼(일)은 남긴다 */
const KEEP_DAYS = 3;

export async function GET(req: Request) {
  const s = requireSession(req, ["manager"]);
  if (s instanceof Response) return s;
  if (!sql) return Response.json({ error: "DB 미연결" }, { status: 503 });
  const ids = (new URL(req.url).searchParams.get("ingredients") ?? "").split(",").filter((x) => /^[\w-]{1,20}$/.test(x)).slice(0, 30);
  if (!ids.length) return Response.json({ asOf: null, keepDays: KEEP_DAYS, options: [] });
  const rows = (await sql.query(
    `SELECT i.date::text AS date, i.store_id, s.store_name, i.ingredient_id, i.closing_qty, i.avg_consumption_7d
     FROM raw_inventory_daily i JOIN raw_stores s USING (store_id)
     WHERE i.date = (SELECT max(date) FROM raw_inventory_daily) AND i.store_id <> $1 AND i.ingredient_id = ANY($2::text[])`,
    [s.storeId, ids],
  )) as { date: string; store_id: string; store_name: string; ingredient_id: string; closing_qty: number; avg_consumption_7d: number }[];
  const options = rows.map((r) => {
    const closing = Number(r.closing_qty) || 0;
    const daily = Number(r.avg_consumption_7d) || 0;
    return { ingredientId: r.ingredient_id, storeId: r.store_id, storeName: r.store_name, closing, daily, spare: Math.max(0, closing - daily * KEEP_DAYS) };
  }).filter((o) => o.spare > 0).sort((a, b) => b.spare - a.spare);
  return Response.json({ asOf: rows[0]?.date ?? null, keepDays: KEEP_DAYS, options });
}
