// 앱 테이블(app_*)만 Drizzle이 관리한다. raw_*/agg_* 는 pipeline/load_db.py 가 적재.
// 사용자 입력은 제공 원본을 고치지 않고 별도 테이블에 쌓아 스냅샷 생성 시 덮어 반영한다(삭제하면 원상복구).
import { boolean, doublePrecision, integer, jsonb, pgTable, serial, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** 사용자가 저장·확정한 발주안 (추천 vs 확정 비교, 재방문 시 복원) */
export const orderDrafts = pgTable("app_order_drafts", {
  id: serial("id").primaryKey(),
  storeId: text("store_id").notNull(),
  asOf: text("as_of").notNull(),
  /** draft | submitted(모의 전송) */
  status: text("status").notNull().default("draft"),
  /** 계산 당시 조건(EngineSettings) */
  settings: jsonb("settings").notNull(),
  /** [{ingredient_id, supplier_id, order_date, arrival_date, recommended_units, final_units, unit_price, amount}] */
  lines: jsonb("lines").notNull(),
  totalAmount: integer("total_amount").notNull().default(0),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** (a) 영업 전 실사 재고 — 같은 매장·날짜·품목은 최신 값으로 덮어씀 */
export const stockCounts = pgTable("app_stock_counts", {
  id: serial("id").primaryKey(),
  storeId: text("store_id").notNull(),
  date: text("date").notNull(),
  ingredientId: text("ingredient_id").notNull(),
  /** use_unit */
  countedQty: doublePrecision("counted_qty").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("app_stock_counts_key").on(t.storeId, t.date, t.ingredientId)]);

/** (d) 공급사·식자재 기준정보 수정 — 같은 항목은 최신 값이 적용, 이력은 남김 */
export const masterEdits = pgTable("app_master_edits", {
  id: serial("id").primaryKey(),
  /** supplier | ingredient */
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  field: text("field").notNull(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** (d) 단가 변경 — 06번 이력에 줄을 추가하는 것과 같음 */
export const priceEntries = pgTable("app_price_entries", {
  id: serial("id").primaryKey(),
  ingredientId: text("ingredient_id").notNull(),
  validFrom: text("valid_from").notNull(),
  /** 원/발주단위 */
  unitPrice: doublePrecision("unit_price").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** (e) 판매 CSV 업로드 단위 — 삭제 시 해당 행 전체 삭제 */
export const salesUploads = pgTable("app_sales_uploads", {
  id: serial("id").primaryKey(),
  fileName: text("file_name").notNull(),
  dateFrom: text("date_from").notNull(),
  dateTo: text("date_to").notNull(),
  storeIds: text("store_ids").notNull(),
  rowCount: integer("row_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** (e) 업로드 판매를 날짜×매장×메뉴로 합산한 행 (agg_daily_demand 와 같은 구조) */
export const salesDaily = pgTable("app_sales_daily", {
  id: serial("id").primaryKey(),
  uploadId: integer("upload_id").notNull().references(() => salesUploads.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  storeId: text("store_id").notNull(),
  menuId: text("menu_id").notNull(),
  demandQty: doublePrecision("demand_qty").notNull(),
  qty: doublePrecision("qty").notNull(),
  cancelQty: doublePrecision("cancel_qty").notNull(),
  lostQty: doublePrecision("lost_qty").notNull(),
  salesAmount: doublePrecision("sales_amount").notNull(),
  promoFlag: smallint("promo_flag").notNull(),
});

export type OrderDraft = typeof orderDrafts.$inferSelect;
export type NewOrderDraft = typeof orderDrafts.$inferInsert;

/** 매장 점검 항목 (냉장고 온도·입고 검수 등) — 매장마다 기본 항목을 자동으로 만들고 점장이 추가·끄기 */
export const checkItems = pgTable("app_check_items", {
  id: serial("id").primaryKey(),
  storeId: text("store_id").notNull(),
  name: text("name").notNull(),
  /** check(확인만) | temp(온도 숫자) | expiry(사용기한 임박 확인) | count(재고 세기) */
  kind: text("kind").notNull(),
  /** open(오픈 전) | lunch(점심 후) | close(마감) */
  slot: text("slot").notNull(),
  minValue: doublePrecision("min_value"),
  maxValue: doublePrecision("max_value"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** 점검 기록 — (매장·날짜·항목) 하나에 한 번만: 먼저 기록한 사람만 남아 중복 점검을 막는다 */
export const checkLogs = pgTable("app_check_logs", {
  id: serial("id").primaryKey(),
  storeId: text("store_id").notNull(),
  date: text("date").notNull(),
  itemId: integer("item_id").notNull().references(() => checkItems.id, { onDelete: "cascade" }),
  value: doublePrecision("value"),
  byName: text("by_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("app_check_logs_once").on(t.storeId, t.date, t.itemId)]);
