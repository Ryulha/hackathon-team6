// 사용자 입력 API — counts(실사) / master(기준정보) / prices(단가) / sales(판매 CSV)
// 제공 원본은 건드리지 않고 app_* 테이블에만 쓴다. 삭제하면 원래 값으로 돌아간다.
// 실사·판매 업로드는 로그인한 매장 것만, 기준정보·단가는 공급사·식자재 공통 조건이라 모든 매장 관리자가 함께 관리.
import { and, asc, desc, eq, gt, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { masterEdits, priceEntries, salesDaily, salesUploads, stockCounts } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";
import { masters, storeDataEnds } from "@/lib/data";
import { addDays } from "@/lib/engine/dates";
import { validateCount, validateMasterEdit, validatePriceEntry, validateSalesCsv } from "@/lib/overlays";

const KINDS = ["counts", "master", "prices", "sales"] as const;
type Kind = (typeof KINDS)[number];

const bad = (error: string, status = 400, extra: object = {}) => Response.json({ error, ...extra }, { status });
const noDb = () => bad("DB 미연결 — 읽기 전용 모드에서는 입력할 수 없습니다.", 503);

async function kindOf(ctx: RouteContext<"/api/inputs/[kind]">): Promise<Kind | null> {
  const { kind } = await ctx.params;
  return (KINDS as readonly string[]).includes(kind) ? (kind as Kind) : null;
}

export async function GET(req: Request, ctx: RouteContext<"/api/inputs/[kind]">) {
  const kind = await kindOf(ctx);
  if (!kind) return bad("알 수 없는 입력 종류", 404);
  const sess = requireSession(req, ["manager"]);
  if (sess instanceof Response) return sess;
  if (!db) return noDb();
  switch (kind) {
    case "counts":
      return Response.json(await db.select().from(stockCounts)
        .where(eq(stockCounts.storeId, sess.storeId)).orderBy(desc(stockCounts.date), asc(stockCounts.ingredientId)));
    case "master":
      return Response.json(await db.select().from(masterEdits).orderBy(desc(masterEdits.id)));
    case "prices":
      return Response.json(await db.select().from(priceEntries).orderBy(desc(priceEntries.id)));
    case "sales":
      return Response.json(await db.select().from(salesUploads).where(eq(salesUploads.storeIds, sess.storeId)).orderBy(desc(salesUploads.id)));
  }
}

export async function POST(req: Request, ctx: RouteContext<"/api/inputs/[kind]">) {
  const kind = await kindOf(ctx);
  if (!kind) return bad("알 수 없는 입력 종류", 404);
  // 재고 세기(실사)는 직원도, 나머지 입력은 점장만
  const sess = requireSession(req, kind === "counts" ? ["manager", "staff"] : ["manager"]);
  if (sess instanceof Response) return sess;
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  if (!db && !dryRun) return noDb();
  const m = await masters();

  if (kind === "sales") {
    const text = await req.text();
    const fileName = decodeURIComponent(req.headers.get("x-file-name") ?? "upload.csv").slice(0, 200);
    const { ends } = await storeDataEnds();
    const check = validateSalesCsv(text, m.stores, m.menus, ends);
    const summary = { ...check, daily: undefined, dailyRows: check.daily.length };
    if (check.ok && check.storeIds.some((x) => x !== sess.storeId)) {
      check.ok = false;
      check.errorCount += 1;
      check.errors.unshift(`다른 매장(${check.storeIds.filter((x) => x !== sess.storeId).join(", ")}) 판매가 들어 있습니다. 로그인한 매장(${sess.storeId}) 판매만 올릴 수 있습니다.`);
      return bad("검증 실패", 422, { check: { ...summary, ok: false, errors: check.errors, errorCount: check.errorCount } });
    }
    if (!check.ok) return bad("검증 실패", 422, { check: summary });
    if (dryRun) return Response.json({ check: summary });
    const [up] = await db!.insert(salesUploads).values({
      fileName, dateFrom: check.dateFrom, dateTo: check.dateTo, storeIds: check.storeIds.join(","), rowCount: check.rowCount,
    }).returning();
    try {
      for (let i = 0; i < check.daily.length; i += 1000) {
        await db!.insert(salesDaily).values(check.daily.slice(i, i + 1000).map((d) => ({
          uploadId: up.id, date: d.date, storeId: d.store_id, menuId: d.menu_id, demandQty: d.demand_qty, qty: d.qty,
          cancelQty: d.cancel_qty, lostQty: d.lost_qty, salesAmount: d.sales_amount, promoFlag: d.promo_flag,
        })));
      }
    } catch (e) {
      await db!.delete(salesUploads).where(eq(salesUploads.id, up.id)); // 일부만 들어가지 않도록 되돌림(행은 cascade 삭제)
      throw e;
    }
    return Response.json({ upload: up, check: summary }, { status: 201 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return bad("JSON 본문이 필요합니다");

  if (kind === "counts") {
    const storeId = sess.storeId;
    const { providedEnd, ends } = await storeDataEnds();
    const maxDate = addDays(ends[storeId] ?? providedEnd, 1);
    const items: unknown[] = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return bad("입력할 품목이 없습니다");
    const parsed = items.map((it) => validateCount({ ...(it as object), date: body.date } as never, m.ingredients, providedEnd, maxDate));
    const errors = parsed.flatMap((p, i) => (p.ok ? [] : [`${(items[i] as { ingredient_id?: string }).ingredient_id ?? i}: ${p.error}`]));
    if (errors.length) return bad(errors[0], 422, { errors });
    if (dryRun) return Response.json({ ok: true });
    const rows = parsed.map((p) => (p as Extract<typeof p, { ok: true }>).value);
    const saved = await db!.insert(stockCounts)
      .values(rows.map((r) => ({ storeId, date: r.date, ingredientId: r.ingredient_id, countedQty: r.counted_qty })))
      .onConflictDoUpdate({ target: [stockCounts.storeId, stockCounts.date, stockCounts.ingredientId], set: { countedQty: sql`excluded.counted_qty`, createdAt: new Date() } })
      .returning();
    return Response.json(saved, { status: 201 });
  }

  if (kind === "master") {
    const r = validateMasterEdit(body, m.suppliers, m.ingredients);
    if (!r.ok) return bad(r.error, 422);
    if (dryRun) return Response.json({ ok: true, value: r.value });
    const [row] = await db!.insert(masterEdits)
      .values({ entity: r.value.entity, entityId: r.value.entity_id, field: r.value.field, value: r.value.value }).returning();
    return Response.json(row, { status: 201 });
  }

  // prices
  const r = validatePriceEntry(body, m.ingredients);
  if (!r.ok) return bad(r.error, 422);
  if (dryRun) return Response.json({ ok: true, value: r.value });
  const [row] = await db!.insert(priceEntries)
    .values({ ingredientId: r.value.ingredient_id, validFrom: r.value.valid_from, unitPrice: r.value.unit_price }).returning();
  return Response.json(row, { status: 201 });
}

export async function DELETE(req: Request, ctx: RouteContext<"/api/inputs/[kind]">) {
  const kind = await kindOf(ctx);
  if (!kind) return bad("알 수 없는 입력 종류", 404);
  const sess = requireSession(req, ["manager"]);
  if (sess instanceof Response) return sess;
  if (!db) return noDb();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return bad("id 가 필요합니다");
  switch (kind) {
    case "counts":
      await db.delete(stockCounts).where(and(eq(stockCounts.id, id), eq(stockCounts.storeId, sess.storeId)));
      break;
    case "master":
      await db.delete(masterEdits).where(eq(masterEdits.id, id));
      break;
    case "prices":
      await db.delete(priceEntries).where(eq(priceEntries.id, id));
      break;
    case "sales": {
      // 중간 업로드를 지우면 판매 기록에 빈 날이 생겨 재고를 이어 계산할 수 없다 → 가장 최근 것부터만 삭제
      const [up] = await db.select().from(salesUploads).where(eq(salesUploads.id, id));
      if (!up || up.storeIds !== sess.storeId) return bad("없는 업로드", 404);
      const later = await db.select({ id: salesUploads.id, storeIds: salesUploads.storeIds }).from(salesUploads)
        .where(and(ne(salesUploads.id, id), gt(salesUploads.dateFrom, up.dateTo)));
      const mine = new Set(up.storeIds.split(","));
      if (later.some((l) => l.storeIds.split(",").some((s) => mine.has(s)))) {
        return bad("이후 기간 업로드가 있어 삭제할 수 없습니다. 최근 업로드부터 지워 주세요.", 409);
      }
      await db.delete(salesUploads).where(eq(salesUploads.id, id));
      break;
    }
  }
  return new Response(null, { status: 204 });
}
