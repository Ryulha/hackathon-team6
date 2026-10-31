// 사용자 입력(실사·기준정보·판매 업로드) 검증과 반영 — 순수 함수 (DB 없이 테스트)
import { WEEKDAYS, addDays, range } from "./engine/dates";
import { rollForward, startOfDay, type LotState, type SimArrival } from "./engine/lots";
import type { BomRow, DailyDemand, Ingredient, LotRow, Menu, OpenOrder, PriceRow, Store, Supplier } from "./types";

export type MasterEdit = { id?: number; entity: "supplier" | "ingredient"; entity_id: string; field: string; value: string; created_at?: string };
export type PriceEntry = { id?: number; ingredient_id: string; valid_from: string; unit_price: number };
export type StockCount = { id?: number; date: string; ingredient_id: string; counted_qty: number };

type Ok<T> = { ok: true; value: T } | { ok: false; error: string };

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** '월,수,금' / '월수금' / '월 수 금' → '월,수,금' (일~토 순). 요일이 아닌 글자가 섞이면 오류 */
export function normalizeWeekdays(s: string): Ok<string> {
  const chars = s.replace(/요일/g, "").replace(/[\s,|;/·]+/g, "");
  if (!chars) return { ok: false, error: "요일을 하나 이상 입력하세요 (예: 월,수,금)" };
  const set = new Set<string>();
  for (const ch of chars) {
    if (!(WEEKDAYS as readonly string[]).includes(ch)) return { ok: false, error: `'${ch}'는 요일이 아닙니다 (일~토)` };
    set.add(ch);
  }
  return { ok: true, value: WEEKDAYS.filter((w) => set.has(w)).join(",") };
}

const num = (min: number, max: number, int: boolean, label: string) => (v: string): Ok<string> => {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) return { ok: false, error: `${label}: 숫자를 입력하세요` };
  if (int && !Number.isInteger(n)) return { ok: false, error: `${label}: 정수여야 합니다` };
  if (n < min || n > max) return { ok: false, error: `${label}: ${min}~${max} 범위여야 합니다` };
  return { ok: true, value: String(n) };
};

/** 수정 허용 항목 — 화면 라벨과 검증 규칙 */
export const EDITABLE: Record<"supplier" | "ingredient", Record<string, { label: string; check: (v: string) => Ok<string> }>> = {
  supplier: {
    order_days: { label: "발주 가능 요일", check: normalizeWeekdays },
    order_cutoff: {
      label: "발주 마감 시각",
      check: (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? { ok: true, value: v.trim() } : { ok: false, error: "마감 시각은 HH:MM (00:00~23:59)" }),
    },
    lead_time_days: { label: "리드타임(일)", check: num(0, 14, true, "리드타임") },
    delivery_days: { label: "입고 가능 요일", check: normalizeWeekdays },
    min_order_amount: { label: "최소 발주금액(원)", check: num(0, 100_000_000, true, "최소 발주금액") },
  },
  ingredient: {
    use_qty_per_order_unit: { label: "발주단위당 사용량", check: num(0.000001, 1_000_000, false, "발주단위당 사용량") },
    min_order_qty: { label: "최소 발주수량(발주단위)", check: num(0, 10_000, true, "최소 발주수량") },
    shelf_life_days: { label: "사용 가능 일수", check: num(1, 3650, true, "사용 가능 일수") },
  },
};

export function validateMasterEdit(e: { entity: string; entity_id: string; field: string; value: string },
  suppliers: Supplier[], ingredients: Ingredient[]): Ok<MasterEdit> {
  if (e.entity !== "supplier" && e.entity !== "ingredient") return { ok: false, error: "대상은 supplier 또는 ingredient" };
  const rule = EDITABLE[e.entity][e.field];
  if (!rule) return { ok: false, error: `수정할 수 없는 항목: ${e.field}` };
  const exists = e.entity === "supplier"
    ? suppliers.some((s) => s.supplier_id === e.entity_id) : ingredients.some((i) => i.ingredient_id === e.entity_id);
  if (!exists) return { ok: false, error: `없는 ID: ${e.entity_id}` };
  const r = rule.check(String(e.value ?? ""));
  return r.ok ? { ok: true, value: { entity: e.entity, entity_id: e.entity_id, field: e.field, value: r.value } } : r;
}

const NUMERIC = new Set(["lead_time_days", "min_order_amount", "use_qty_per_order_unit", "min_order_qty", "shelf_life_days"]);

/** 같은 대상·항목은 마지막(최신) 수정만 적용. edits 는 생성 순 정렬 가정 */
export function applyMasterEdits(suppliers: Supplier[], ingredients: Ingredient[], edits: MasterEdit[]) {
  const latest = new Map<string, MasterEdit>();
  for (const e of edits) latest.set(`${e.entity}|${e.entity_id}|${e.field}`, e);
  const val = (e: MasterEdit) => (NUMERIC.has(e.field) ? Number(e.value) : e.value);
  const patch = <T extends object>(row: T, entity: string, id: string): T => {
    let out = row;
    for (const e of latest.values()) {
      if (e.entity === entity && e.entity_id === id && e.field in row) out = { ...out, [e.field]: val(e) };
    }
    return out;
  };
  return {
    suppliers: suppliers.map((s) => patch(s, "supplier", s.supplier_id)),
    ingredients: ingredients.map((i) => patch(i, "ingredient", i.ingredient_id)),
    applied: [...latest.values()],
  };
}

export function validatePriceEntry(p: { ingredient_id: string; valid_from: string; unit_price: number | string },
  ingredients: Ingredient[]): Ok<PriceEntry> {
  if (!ingredients.some((i) => i.ingredient_id === p.ingredient_id)) return { ok: false, error: `없는 식자재: ${p.ingredient_id}` };
  if (!isDate(String(p.valid_from))) return { ok: false, error: "적용 시작일은 YYYY-MM-DD" };
  const price = Number(p.unit_price);
  if (!Number.isFinite(price) || price < 0) return { ok: false, error: "단가는 0 이상 숫자" };
  return { ok: true, value: { ingredient_id: p.ingredient_id, valid_from: String(p.valid_from), unit_price: price } };
}

/** 같은 품목·시작일이면 사용자 입력이 우선 */
export function mergePrices(prices: PriceRow[], entries: PriceEntry[]): PriceRow[] {
  const key = (r: { ingredient_id: string; valid_from: string }) => `${r.ingredient_id}|${r.valid_from}`;
  const map = new Map(prices.map((p) => [key(p), p]));
  for (const e of entries) map.set(key(e), { ingredient_id: e.ingredient_id, valid_from: e.valid_from, unit_price: e.unit_price });
  return [...map.values()];
}

/**
 * 실사 입력 검증. 제공 기간(≤ providedEnd)은 제공 실사가 있으므로 그 이후 날짜만 허용.
 * 수량은 use_unit 기준 0 이상.
 */
export function validateCount(c: { date: string; ingredient_id: string; counted_qty: number | string },
  ingredients: Ingredient[], providedEnd: string, maxDate: string): Ok<StockCount> {
  if (!isDate(String(c.date))) return { ok: false, error: "실사일은 YYYY-MM-DD" };
  if (c.date <= providedEnd) return { ok: false, error: `${providedEnd} 이전은 제공 데이터의 실사 기록을 사용합니다` };
  if (c.date > maxDate) return { ok: false, error: `실사일은 ${maxDate} 이전이어야 합니다 (판매 기록 다음 날까지)` };
  if (!ingredients.some((i) => i.ingredient_id === c.ingredient_id)) return { ok: false, error: `없는 식자재: ${c.ingredient_id}` };
  const q = Number(c.counted_qty);
  if (String(c.counted_qty).trim() === "" || !Number.isFinite(q) || q < 0) return { ok: false, error: "실사 수량은 0 이상 숫자" };
  return { ok: true, value: { date: c.date, ingredient_id: c.ingredient_id, counted_qty: q } };
}

// ---------- (e) 판매 CSV ----------

export const SALES_COLUMNS = ["date", "hour", "store_id", "menu_id", "channel", "demand_qty", "qty", "cancel_qty", "lost_qty", "sales_amount", "promo_flag"] as const;
const CHANNELS = new Set(["매장", "포장", "배달"]);

/** 따옴표 필드를 지원하는 최소 CSV 파서 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

export type SalesCheck = {
  ok: boolean;
  errors: string[];
  errorCount: number;
  warnings: string[];
  daily: DailyDemand[];
  rowCount: number;
  dateFrom: string;
  dateTo: string;
  storeIds: string[];
};

/**
 * 09_sales.csv 와 같은 형식만 받는다.
 * storeEnds: 매장별 현재 마지막 판매일(제공 데이터 또는 이전 업로드). 업로드는 그 다음 날부터 빈 날짜 없이 이어져야 한다
 * — 재고를 판매 기록으로 이어 계산하기 때문에 빈 날이 있으면 소진량을 알 수 없다.
 */
export function validateSalesCsv(text: string, stores: Store[], menus: Menu[], storeEnds: Record<string, string>): SalesCheck {
  const errors: string[] = [];
  let errorCount = 0;
  const warnings: string[] = [];
  const err = (m: string) => { errorCount++; if (errors.length < 20) errors.push(m); };
  const empty = (): SalesCheck => ({ ok: false, errors, errorCount, warnings, daily: [], rowCount: 0, dateFrom: "", dateTo: "", storeIds: [] });

  const rows = parseCsv(text);
  if (rows.length < 2) { err("데이터 행이 없습니다"); return empty(); }
  const header = rows[0].map((h) => h.trim());
  const missing = SALES_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) { err(`필수 컬럼 누락: ${missing.join(", ")} (09_sales.csv 와 같은 형식)`); return empty(); }
  const extra = header.filter((h) => !(SALES_COLUMNS as readonly string[]).includes(h));
  if (extra.length) warnings.push(`사용하지 않는 컬럼 무시: ${extra.join(", ")}`);
  const ix = Object.fromEntries(SALES_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<(typeof SALES_COLUMNS)[number], number>;

  const storeSet = new Set(stores.map((s) => s.store_id));
  const menuSet = new Set(menus.map((m) => m.menu_id));
  const seen = new Set<string>();
  const agg = new Map<string, DailyDemand>();
  const datesByStore = new Map<string, Set<string>>();

  for (let r = 1; r < rows.length; r++) {
    const line = r + 1;
    const c = rows[r];
    const g = (k: keyof typeof ix) => (c[ix[k]] ?? "").trim();
    const date = g("date"), store = g("store_id"), menu = g("menu_id"), channel = g("channel");
    const n = (k: keyof typeof ix) => Number(g(k));
    const hour = n("hour"), demand = n("demand_qty"), qty = n("qty"), cancel = n("cancel_qty"), lost = n("lost_qty");
    const amount = n("sales_amount"), promo = n("promo_flag");
    const before = errorCount;
    if (!isDate(date)) err(`${line}행: 날짜 형식 오류 '${date}'`);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || g("hour") === "") err(`${line}행: hour 는 0~23 정수`);
    if (!storeSet.has(store)) err(`${line}행: 없는 매장 '${store}'`);
    if (!menuSet.has(menu)) err(`${line}행: 없는 메뉴 '${menu}'`);
    if (!CHANNELS.has(channel)) err(`${line}행: channel 은 매장/포장/배달`);
    for (const [k, v] of [["demand_qty", demand], ["qty", qty], ["cancel_qty", cancel], ["lost_qty", lost]] as const) {
      if (g(k) === "" || !Number.isInteger(v) || v < 0) err(`${line}행: ${k} 는 0 이상 정수`);
    }
    if (g("sales_amount") === "" || !Number.isFinite(amount) || amount < 0) err(`${line}행: sales_amount 는 0 이상 숫자`);
    if (promo !== 0 && promo !== 1) err(`${line}행: promo_flag 는 0/1`);
    if (errorCount > before) continue;
    if (qty !== demand - lost) err(`${line}행: qty(${qty}) ≠ demand_qty(${demand}) − lost_qty(${lost})`);
    if (cancel > qty) err(`${line}행: cancel_qty 가 qty 보다 큼`);
    const key = `${date}|${hour}|${store}|${menu}|${channel}`;
    if (seen.has(key)) err(`${line}행: 같은 날짜·시간·매장·메뉴·채널 중복`);
    seen.add(key);
    if (errorCount > before) continue;

    (datesByStore.get(store) ?? datesByStore.set(store, new Set()).get(store)!).add(date);
    const k = `${date}|${store}|${menu}`;
    const a = agg.get(k) ?? agg.set(k, { date, store_id: store, menu_id: menu, demand_qty: 0, qty: 0, cancel_qty: 0, lost_qty: 0, sales_amount: 0, promo_flag: 0 }).get(k)!;
    a.demand_qty += demand; a.qty += qty; a.cancel_qty += cancel; a.lost_qty += lost; a.sales_amount += amount;
    a.promo_flag = Math.max(a.promo_flag, promo);
  }

  // 기간 연속성: 매장별 (현재 마지막 판매일 + 1) 부터 빈 날 없이
  for (const [store, ds] of datesByStore) {
    const sorted = [...ds].sort();
    const expectStart = addDays(storeEnds[store] ?? "", 1);
    if (sorted[0] !== expectStart) {
      err(`${store}: 판매 기록은 ${expectStart}부터 이어져야 합니다 (파일 시작 ${sorted[0]}). 이미 있는 기간은 다시 올릴 수 없습니다`);
      continue;
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] !== addDays(sorted[i - 1], 1)) { err(`${store}: ${addDays(sorted[i - 1], 1)} 판매 기록이 비어 있습니다 (판매가 없던 날도 다른 시간대 행이 있어야 합니다)`); break; }
    }
  }

  const daily = [...agg.values()];
  const all = daily.map((d) => d.date).sort();
  return {
    ok: errorCount === 0 && daily.length > 0, errors, errorCount, warnings, daily, rowCount: rows.length - 1,
    dateFrom: all[0] ?? "", dateTo: all.at(-1) ?? "", storeIds: [...datesByStore.keys()].sort(),
  };
}

// ---------- 기준일 시작 재고 (제공 기간 이후로 넘어갈 때) ----------

/** 앱에서 '발주 확정(모의)'한 발주안 1줄 */
export type DraftLine = { ingredient_id: string; supplier_id?: string; order_date?: string; arrival_date?: string; final_units: number; use_qty?: number };
export type SubmittedDraft = { id: number; as_of: string; lines: DraftLine[] };

/**
 * 확정 발주안 → 입고 예정. 같은 기준일·같은 공급사를 여러 번 확정하면 마지막 것만 유효.
 * 제공 기간 안의 기준일로 확정한 것은 과거 모의 실험이므로 제외(제공 입고 기록과 중복 방지).
 */
export function draftArrivals(drafts: SubmittedDraft[], providedEnd: string, asOf: string): OpenOrder[] {
  // 공급사별로 따로 '주문 완료'할 수 있으므로 같은 기준일·같은 공급사의 마지막 확정만 유효
  const latest = new Map<string, { id: number; as_of: string; lines: DraftLine[] }>();
  for (const d of [...drafts].sort((a, b) => a.id - b.id)) {
    if (d.as_of <= providedEnd || d.as_of >= asOf) continue;
    for (const sup of new Set(d.lines.map((l) => l.supplier_id ?? ""))) {
      latest.set(`${d.as_of}|${sup}`, { id: d.id, as_of: d.as_of, lines: d.lines.filter((l) => (l.supplier_id ?? "") === sup) });
    }
  }
  return [...latest.values()].flatMap((d) => d.lines
    .filter((l) => l.final_units > 0 && l.arrival_date && l.use_qty !== undefined)
    .map((l) => ({
      po_line_id: `앱발주#${d.id}-${l.ingredient_id}`, ingredient_id: l.ingredient_id, supplier_id: l.supplier_id ?? "",
      order_date: l.order_date ?? d.as_of, expected_date: l.arrival_date!, order_qty: l.final_units, use_qty: l.use_qty!, order_type: "앱 확정",
    })));
}

/**
 * 기준일 영업 시작 재고(묶음별)와 남은 입고 예정을 계산한다.
 *  - baseLots: 제공 데이터의 마지막 확정일(baseDay) 영업 종료 후 묶음
 *  - baseDay+1 ~ 기준일-1: 업로드 판매(확정 수량 = qty − cancel_qty) × BOM 으로 소진, 입고 예정 반영, 실사 입력 반영 → '추정 재고'
 *  - 기준일 실사 입력이 있으면 07시 입고 후 실사값으로 맞추고, 그날 입고분은 재고에 포함(입고 예정에서 제외)
 */
export function projectStartStock(p: {
  ingredients: Ingredient[]; bom: BomRow[]; baseLots: LotRow[]; open: OpenOrder[]; uploaded: DailyDemand[];
  counts: StockCount[]; baseDay: string; asOf: string; storeId: string;
}): { lots: LotRow[]; openOrders: OpenOrder[]; countedToday: string[] } {
  const gap = range(addDays(p.baseDay, 1), p.asOf);
  const sold = new Map<string, number>(); // date|menu → 판매 확정 수량
  for (const u of p.uploaded) if (u.store_id === p.storeId) sold.set(`${u.date}|${u.menu_id}`, (sold.get(`${u.date}|${u.menu_id}`) ?? 0) + u.qty - u.cancel_qty);

  const lots: LotRow[] = [];
  const openOrders: OpenOrder[] = [];
  const countedToday: string[] = [];
  for (const ing of p.ingredients) {
    const id = ing.ingredient_id;
    const shelf = ing.shelf_life_days;
    const start: LotState[] = p.baseLots.filter((l) => l.ingredient_id === id)
      .map((l) => ({ qty: l.remaining_qty, lastUse: l.last_use_date, receiptDate: l.receipt_date, label: l.lot_id }));
    const open = p.open.filter((o) => o.ingredient_id === id);
    const arrivals: SimArrival[] = open.map((o) => ({ date: o.expected_date, qty: o.use_qty, lastUse: addDays(o.expected_date, shelf - 1), label: o.po_line_id }));
    const consumption = new Map<string, number>();
    for (const b of p.bom.filter((x) => x.ingredient_id === id)) {
      for (const d of gap) consumption.set(d, (consumption.get(d) ?? 0) + (sold.get(`${d}|${b.menu_id}`) ?? 0) * b.qty_per_menu);
    }
    const counts = new Map(p.counts.filter((c) => c.ingredient_id === id).map((c) => [c.date, c.counted_qty]));
    let state = rollForward(start, arrivals, consumption, counts, gap, shelf);
    let remaining = open.filter((o) => o.expected_date >= p.asOf);
    if (counts.has(p.asOf)) {
      state = startOfDay(state, arrivals, counts.get(p.asOf), p.asOf, shelf);
      remaining = remaining.filter((o) => o.expected_date > p.asOf);
      countedToday.push(id);
    }
    openOrders.push(...remaining);
    for (const l of state) {
      lots.push({ date: addDays(p.asOf, -1), store_id: p.storeId, ingredient_id: id, lot_id: l.label, receipt_date: l.receiptDate,
        last_use_date: l.lastUse, remaining_qty: l.qty, use_unit: ing.use_unit });
    }
  }
  return { lots, openOrders, countedToday };
}
