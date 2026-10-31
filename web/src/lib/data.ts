import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { asc, eq, max } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { masterEdits, orderDrafts, priceEntries, salesDaily, stockCounts } from "@/db/schema";
import { addDays } from "./engine/dates";
import { dailyTotals } from "./engine/forecast";
import { holidaysFor } from "./holidays";
import {
  applyMasterEdits, draftArrivals, mergePrices, projectStartStock,
  type DraftLine, type MasterEdit, type PriceEntry, type StockCount, type SubmittedDraft,
} from "./overlays";
import type {
  BomRow, CalendarRow, DailyDemand, DailyWaste, Ingredient, InventoryDaily, LotRow, Menu, MenuAvailability,
  OpenOrder, PriceRow, Promotion, PurchaseOrder, Receipt, Snapshot, Stockout, Store, Supplier,
} from "./types";

/** 과거 수요 조회 범위 — 설정의 lookbackWeeks 최대값과 맞출 것 */
export const MAX_LOOKBACK_WEEKS = 12;
const RECENT_DAYS = 28;

type Filter = { store?: string; dateCol?: string; from?: string; to?: string };

/** 같은 테이블명·같은 행 구조로 DB/JSON 어느 쪽에서든 읽는다 */
type Source = {
  name: "db" | "json";
  rows<T>(table: string, f?: Filter): Promise<T[]>;
  dataRange(): Promise<{ start: string; end: string; fixture: boolean }>;
};

const GEN_DIR = path.join(process.cwd(), "src", "data", "generated");
const jsonCache = new Map<string, unknown[]>();

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(GEN_DIR, `${name}.json`), "utf-8"));
}

const jsonSource: Source = {
  name: "json",
  async rows<T>(table: string, f: Filter = {}) {
    if (!jsonCache.has(table)) jsonCache.set(table, await readJson<unknown[]>(table).catch(() => []));
    const all = jsonCache.get(table) as Record<string, string>[];
    return all.filter((r) =>
      (!f.store || r.store_id === f.store)
      && (!f.dateCol || ((!f.from || r[f.dateCol] >= f.from) && (!f.to || r[f.dateCol] < f.to)))) as T[];
  },
  async dataRange() {
    const m = await readJson<{ data_start?: string; data_end?: string; source?: string }>("meta");
    return { start: m.data_start ?? "", end: m.data_end ?? "", fixture: /fixtures/.test(m.source ?? "") };
  },
};

const RAW = new Set(["stores", "menus", "ingredients", "bom", "suppliers", "ingredient_price_history", "calendar",
  "promotions", "menu_availability", "purchase_orders", "receipts", "transfers", "stockouts", "inventory_daily",
  "inventory_lots_daily", "sales", "waste"]);
const ident = (t: string) => (RAW.has(t) ? `raw_${t}` : t).replace(/[^a-z0-9_]/g, "");

/**
 * DB date 컬럼이 Date 로 오는 경우 'YYYY-MM-DD' 로 통일.
 * 드라이버는 date 를 '로컬 자정'으로 만들기 때문에 toISOString(UTC) 을 쓰면 KST 에서 하루 밀린다 → 로컬 값 사용.
 */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const normalize = (r: Record<string, unknown>) => {
  for (const k in r) if (r[k] instanceof Date) r[k] = ymd(r[k] as Date);
  return r;
};

/**
 * 제공 데이터(raw_ 및 agg_ 테이블)는 실행 중에 바뀌지 않으므로, 필터 없는 마스터 조회와 기간 조회는 서버 인스턴스에 캐시해
 * DB 왕복을 줄인다 (DB↔함수 왕복 1회 ≈ 수백 ms). load_db.py 로 다시 적재하면 재배포해 캐시를 비울 것.
 */
const dbCache = new Map<string, Promise<unknown>>();
const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
  if (!dbCache.has(key)) dbCache.set(key, load().catch((e) => { dbCache.delete(key); throw e; }));
  return dbCache.get(key) as Promise<T>;
};

const dbSource: Source | null = sql && {
  name: "db",
  async rows<T>(table: string, f: Filter = {}) {
    if (!f.store && !f.dateCol) return cached(`rows:${table}`, () => dbRows<T>(table, f));
    return dbRows<T>(table, f);
  },
  async dataRange() {
    return cached("range", async () => {
      const [r] = (await sql!.query(`SELECT min(date)::text AS start, max(date)::text AS "end" FROM raw_inventory_daily`)) as { start: string; end: string }[];
      return { ...r, fixture: process.env.DATA_IS_FIXTURE === "1" };
    });
  },
};

async function dbRows<T>(table: string, f: Filter): Promise<T[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (f.store) { params.push(f.store); where.push(`store_id = $${params.length}`); }
  const col = f.dateCol?.replace(/[^a-z_]/g, "");
  if (col && f.from) { params.push(f.from); where.push(`"${col}" >= $${params.length}::date`); }
  if (col && f.to) { params.push(f.to); where.push(`"${col}" < $${params.length}::date`); }
  const q = `SELECT * FROM "${ident(table)}"${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = (await sql!.query(q, params)) as Record<string, unknown>[];
  return rows.map(normalize) as T[];
}

/** 사용자 입력(앱 테이블). DB 가 없으면 비어 있음 */
export type Overlays = {
  counts: StockCount[];
  masterEdits: MasterEdit[];
  priceEntries: PriceEntry[];
  uploaded: DailyDemand[];
  drafts: SubmittedDraft[];
};
const NO_OVERLAYS: Overlays = { counts: [], masterEdits: [], priceEntries: [], uploaded: [], drafts: [] };

async function buildSnapshot(src: Source, asOfIn: string | null, storeIn: string | null, ovIn: Overlays | Promise<Overlays>): Promise<Snapshot> {
  const [range, stores, ov] = await Promise.all([src.dataRange(), src.rows<Store>("stores"), ovIn]);
  const providedEnd = range.end;
  const storeId = storeIn && stores.some((s) => s.store_id === storeIn) ? storeIn : stores[0]?.store_id ?? "";
  const uploaded = ov.uploaded.filter((u) => u.store_id === storeId);
  const dataEnd = uploaded.reduce((m, u) => (u.date > m ? u.date : m), providedEnd);
  // 기준일은 판매 기록 다음 날까지만 — 그 이후는 재고를 이어 계산할 근거가 없음. 기본값도 이 날(= 실제 발주 판단 시점)
  const maxAsOf = addDays(dataEnd, 1);
  const asOf = asOfIn && asOfIn <= maxAsOf ? asOfIn : maxAsOf;
  // 제공 데이터의 재고 확정일: 기준일 전날과 제공 마지막 날 중 이른 날
  const baseDay = addDays(asOf, -1) < providedEnd ? addDays(asOf, -1) : providedEnd;
  const st = { store: storeId };
  const recentFrom = addDays(asOf, -RECENT_DAYS);
  const histFrom = addDays(asOf, -7 * MAX_LOOKBACK_WEEKS);

  const [menus, rawIngredients, bom, rawSuppliers, rawPrices, calendar, promotions, menuAvailability,
    providedDemand, inventoryHistory, baseLots, pos, receipts, recentStockouts, recentWaste] = await Promise.all([
    src.rows<Menu>("menus"), src.rows<Ingredient>("ingredients"), src.rows<BomRow>("bom"),
    src.rows<Supplier>("suppliers"), src.rows<PriceRow>("ingredient_price_history"), src.rows<CalendarRow>("calendar"),
    src.rows<Promotion>("promotions", st), src.rows<MenuAvailability>("menu_availability", st),
    src.rows<DailyDemand>("agg_daily_demand", { ...st, dateCol: "date", to: asOf }),
    src.rows<InventoryDaily>("inventory_daily", { ...st, dateCol: "date", from: recentFrom, to: asOf }),
    src.rows<LotRow>("inventory_lots_daily", { ...st, dateCol: "date", from: baseDay, to: addDays(baseDay, 1) }),
    src.rows<PurchaseOrder>("purchase_orders", { ...st, dateCol: "order_date", from: addDays(baseDay, -30), to: addDays(baseDay, 1) }),
    src.rows<Receipt>("receipts", { ...st, dateCol: "receipt_date", from: addDays(baseDay, -30), to: addDays(baseDay, 1) }),
    src.rows<Stockout>("stockouts", { ...st, dateCol: "date", from: recentFrom, to: asOf }),
    src.rows<DailyWaste>("agg_daily_waste", { ...st, dateCol: "date", from: recentFrom, to: asOf }),
  ]);

  const allDemand = [...providedDemand, ...uploaded.filter((u) => u.date < asOf)];
  const holidays = await holidaysFor(calendar, providedEnd);
  const { suppliers, ingredients, applied } = applyMasterEdits(rawSuppliers, rawIngredients, ov.masterEdits);
  const prices = mergePrices(rawPrices, ov.priceEntries);
  const appOrders = draftArrivals(ov.drafts, providedEnd, asOf);
  const projected = projectStartStock({
    // 제공 발주는 발주 당시 포장 단위로 환산 (사용자가 포장 단위를 바꿔도 이미 발주된 물량은 그대로)
    ingredients, bom, baseLots, open: [...openOrders(pos, receipts, rawIngredients), ...appOrders],
    uploaded, counts: ov.counts, baseDay, asOf, storeId,
  });

  return {
    meta: {
      asOf, storeId, dataStart: range.start, dataEnd, providedEnd, source: src.name, fixture: range.fixture,
      overlay: {
        countedToday: projected.countedToday, estimated: asOf > addDays(providedEnd, 1),
        uploadedThrough: dataEnd > providedEnd ? dataEnd : null,
        masterEdits: applied.map(({ entity, entity_id, field, value }) => ({ entity, entity_id, field, value })),
        priceEntries: ov.priceEntries.length, appOrders: appOrders.length,
      },
    },
    stores, menus, ingredients, bom, suppliers, prices, calendar, holidays, promotions, menuAvailability,
    demandHistory: allDemand.filter((r) => r.date >= histFrom),
    dailyTotals: [...dailyTotals(allDemand, storeId)].map(([date, y]) => ({ date, y })).sort((a, b) => a.date.localeCompare(b.date)),
    inventoryHistory: inventoryHistory.sort((a, b) => a.date.localeCompare(b.date)),
    lots: projected.lots, openOrders: projected.openOrders, recentStockouts, recentWaste,
  };
}

/**
 * 제공 데이터 기준 미입고 발주 = 발주 − 입고(부분 입고는 잔량만).
 * receipts.status 는 정상/긴급입고뿐이고 부분·지연입고는 없음(명세서) → 9/30 이후 도착분만 남는다.
 */
export function openOrders(pos: PurchaseOrder[], receipts: Receipt[], ingredients: Ingredient[]): OpenOrder[] {
  const got = new Map<string, number>();
  for (const r of receipts) got.set(r.po_line_id, (got.get(r.po_line_id) ?? 0) + r.received_qty);
  const conv = new Map(ingredients.map((i) => [i.ingredient_id, i.use_qty_per_order_unit]));
  return pos.flatMap((p) => {
    const left = p.order_qty - (got.get(p.po_line_id) ?? 0);
    if (left <= 1e-9) return [];
    return [{
      po_line_id: p.po_line_id, ingredient_id: p.ingredient_id, supplier_id: p.supplier_id, order_date: p.order_date,
      expected_date: p.expected_date, order_qty: left, use_qty: left * (conv.get(p.ingredient_id) ?? 1), order_type: p.order_type,
    }];
  });
}

/** 앱 테이블에서 사용자 입력을 읽는다 (DB 없으면 빈 값) */
export async function loadOverlays(storeId: string | null): Promise<Overlays> {
  if (!db) return NO_OVERLAYS;
  const [counts, edits, prices, uploaded, drafts] = await Promise.all([
    storeId ? db.select().from(stockCounts).where(eq(stockCounts.storeId, storeId)) : Promise.resolve([]),
    db.select().from(masterEdits).orderBy(asc(masterEdits.id)),
    db.select().from(priceEntries).orderBy(asc(priceEntries.id)),
    db.select().from(salesDaily),
    storeId ? db.select().from(orderDrafts).where(eq(orderDrafts.storeId, storeId)) : Promise.resolve([]),
  ]);
  return {
    counts: counts.map((c) => ({ id: c.id, date: c.date, ingredient_id: c.ingredientId, counted_qty: c.countedQty })),
    masterEdits: edits.map((e) => ({ id: e.id, entity: e.entity as MasterEdit["entity"], entity_id: e.entityId, field: e.field, value: e.value })),
    priceEntries: prices.map((p) => ({ id: p.id, ingredient_id: p.ingredientId, valid_from: p.validFrom, unit_price: p.unitPrice })),
    uploaded: uploaded.map((u) => ({
      date: u.date, store_id: u.storeId, menu_id: u.menuId, demand_qty: u.demandQty, qty: u.qty,
      cancel_qty: u.cancelQty, lost_qty: u.lostQty, sales_amount: u.salesAmount, promo_flag: u.promoFlag,
    })),
    drafts: drafts.filter((d) => d.status === "submitted").map((d) => ({ id: d.id, as_of: d.asOf, lines: d.lines as DraftLine[] })),
  };
}

/** 매장별 마지막 판매 기록일 (업로드 연속성·실사일 검증용) */
export async function storeDataEnds(): Promise<{ providedEnd: string; ends: Record<string, string> }> {
  const src = dbSource ?? jsonSource;
  const { end } = await src.dataRange();
  const stores = await src.rows<Store>("stores");
  const ends: Record<string, string> = Object.fromEntries(stores.map((s) => [s.store_id, end]));
  if (db) {
    const rows = await db.select({ storeId: salesDaily.storeId, last: max(salesDaily.date) }).from(salesDaily).groupBy(salesDaily.storeId);
    for (const r of rows) if (r.last && r.last > (ends[r.storeId] ?? "")) ends[r.storeId] = r.last;
  }
  return { providedEnd: end, ends };
}

/** 기준정보 원본 — 입력 검증용 */
export async function masters() {
  const src = dbSource ?? jsonSource;
  const [stores, menus, ingredients, suppliers] = await Promise.all([
    src.rows<Store>("stores"), src.rows<Menu>("menus"), src.rows<Ingredient>("ingredients"), src.rows<Supplier>("suppliers"),
  ]);
  return { stores, menus, ingredients, suppliers };
}

/**
 * DB 우선, 실패 시 번들 JSON 으로 폴백 (심사 기간 DB 장애 대비).
 * 폴백은 사용자 입력 없이 제공 데이터만 보여준다(읽기 전용).
 */
export async function getSnapshot(asOf: string | null, storeId: string | null): Promise<Snapshot> {
  if (dbSource) {
    try {
      // 사용자 입력 조회는 제공 데이터 조회와 동시에 (직렬 왕복 줄이기)
      return await buildSnapshot(dbSource, asOf, storeId, loadOverlays(storeId));
    } catch (e) {
      console.error("[data] DB 조회 실패 → JSON 폴백", e);
    }
  }
  return buildSnapshot(jsonSource, asOf, storeId, NO_OVERLAYS);
}
