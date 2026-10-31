// 슈퍼바이저 매장 진단 — 최근 N주와 그 직전 N주의 매장별 손익 지표 (슈퍼바이저만)
import { sql } from "@/db/client";
import { requireSession } from "@/lib/auth/session";
import { diagnose, type Period, type StoreInput } from "@/lib/diagnosis";
import { addDays } from "@/lib/engine/dates";

type Row = Record<string, unknown>;
const q = async (text: string, params: unknown[] = []) => (await sql!.query(text, params)) as Row[];
const n = (v: unknown) => Number(v ?? 0) || 0;

export async function GET(req: Request) {
  const s = requireSession(req, ["supervisor"]);
  if (s instanceof Response) return s;
  if (!sql) return Response.json({ error: "DB 미연결 — 매장 진단은 DB가 있어야 합니다." }, { status: 503 });
  const weeks = Math.min(12, Math.max(1, Number(new URL(req.url).searchParams.get("weeks")) || 4));

  const [{ end }] = (await q(`SELECT max(date)::text AS end FROM agg_daily_demand`)) as { end: string }[];
  const curFrom = addDays(end, -7 * weeks + 1);
  const prevFrom = addDays(curFrom, -7 * weeks);
  const prevTo = addDays(curFrom, -1);
  // 기간 구분: cur(최근 N주) / prev(그 직전 N주)
  const P = `CASE WHEN {d} >= $1::date THEN 'cur' ELSE 'prev' END`;
  const W = `{d} BETWEEN $2::date AND $3::date`;
  const per = (col: string) => ({ p: P.replace("{d}", col), w: W.replace("{d}", col) });
  const args = [curFrom, prevFrom, end];

  const d = per("date"), o = per("order_date");
  const [stores, sales, food, waste, emerg, wasteTop, emergItems, weekly, checks] = await Promise.all([
    q(`SELECT store_id, store_name FROM raw_stores ORDER BY store_id`),
    q(`SELECT a.store_id, CASE WHEN a.date >= $1::date THEN 'cur' ELSE 'prev' END AS p,
              sum(a.sales_amount) AS sales, sum(a.lost_qty) AS lost_qty, sum(a.lost_qty * m.virtual_price) AS lost_amount
       FROM agg_daily_demand a JOIN raw_menus m USING (menu_id)
       WHERE a.date BETWEEN $2::date AND $3::date GROUP BY 1, 2`, args),
    q(`SELECT store_id, ${d.p} AS p, sum(consumed_cost) AS food FROM ana_ingredient_daily WHERE ${d.w} GROUP BY 1, 2`, args),
    q(`SELECT store_id, ${d.p} AS p, sum(waste_cost) AS waste, sum(waste_cost) FILTER (WHERE reason = '소비기한 경과') AS expiry
       FROM agg_daily_waste WHERE ${d.w} GROUP BY 1, 2`, args),
    q(`SELECT store_id, ${o.p} AS p, count(*) AS cnt, sum(order_amount) AS amount FROM raw_purchase_orders
       WHERE order_type = '긴급' AND ${o.w} GROUP BY 1, 2`, args),
    q(`SELECT store_id, ingredient_name, reason, cost FROM (
         SELECT w.store_id, i.ingredient_name, w.reason, sum(w.waste_cost) AS cost,
                row_number() OVER (PARTITION BY w.store_id ORDER BY sum(w.waste_cost) DESC) AS rk
         FROM agg_daily_waste w JOIN raw_ingredients i USING (ingredient_id)
         WHERE w.date BETWEEN $1::date AND $2::date GROUP BY 1, 2, 3) t WHERE rk <= 3 ORDER BY store_id, cost DESC`, [curFrom, end]),
    q(`SELECT DISTINCT p.store_id, i.ingredient_name FROM raw_purchase_orders p JOIN raw_ingredients i USING (ingredient_id)
       WHERE p.order_type = '긴급' AND p.order_date BETWEEN $1::date AND $2::date`, [curFrom, end]),
    q(`SELECT a.store_id, date_trunc('week', a.date)::date::text AS wk, sum(a.sales_amount) AS sales
       FROM agg_daily_demand a WHERE a.date BETWEEN $1::date AND $2::date GROUP BY 1, 2 ORDER BY 1, 2`, [prevFrom, end]),
    // 오늘(데이터 다음 날) 점검표 진행 — 아직 한 번도 열지 않은 매장은 항목이 없을 수 있음
    q(`SELECT i.store_id, count(*) FILTER (WHERE i.active) AS total, count(l.id) FILTER (WHERE i.active) AS done
       FROM app_check_items i LEFT JOIN app_check_logs l ON l.item_id = i.id AND l.date = $1 GROUP BY 1`, [addDays(end, 1)]).catch(() => [] as Row[]),
  ]);
  const weeklyFood = await q(`SELECT store_id, date_trunc('week', date)::date::text AS wk, sum(consumed_cost) AS food
    FROM ana_ingredient_daily WHERE date BETWEEN $1::date AND $2::date GROUP BY 1, 2`, [prevFrom, end]);

  const pick = (rows: Row[], store: string, p: string) => rows.find((r) => r.store_id === store && r.p === p) ?? {};
  const period = (store: string, p: string): Period => {
    const sa = pick(sales, store, p), f = pick(food, store, p), w = pick(waste, store, p), e = pick(emerg, store, p);
    return {
      sales: n(sa.sales), food: n(f.food), waste: n(w.waste), expiryWaste: n(w.expiry), lostQty: n(sa.lost_qty), lostAmount: n(sa.lost_amount),
      emergencyCount: n(e.cnt), emergencyAmount: n(e.amount),
    };
  };
  const inputs: StoreInput[] = stores.map((st) => {
    const id = String(st.store_id);
    return {
      storeId: id, storeName: String(st.store_name), cur: period(id, "cur"), prev: period(id, "prev"),
      wasteTop: wasteTop.filter((r) => r.store_id === id).map((r) => ({ ingredient: String(r.ingredient_name), reason: String(r.reason), cost: n(r.cost) })),
      emergencyItems: emergItems.filter((r) => r.store_id === id).map((r) => String(r.ingredient_name)),
    };
  });
  const result = diagnose(inputs).map((dg) => ({
    ...dg,
    weekly: weekly.filter((r) => r.store_id === dg.storeId).map((r) => {
      const fd = weeklyFood.find((x) => x.store_id === dg.storeId && x.wk === r.wk);
      return { week: String(r.wk), sales: n(r.sales), foodRatio: n(r.sales) > 0 ? n(fd?.food) / n(r.sales) : 0 };
    }),
    checks: (() => { const c = checks.find((r) => r.store_id === dg.storeId); return c ? { done: n(c.done), total: n(c.total) } : null; })(),
  }));
  return Response.json({ weeks, cur: { from: curFrom, to: end }, prev: { from: prevFrom, to: prevTo }, stores: result });
}
