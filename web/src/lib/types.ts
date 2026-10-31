// CSV 스키마(pipeline/schema.py)와 1:1. 날짜는 'YYYY-MM-DD' 문자열, 수량 단위는 주석 참고.

export type Store = {
  store_id: string; store_name: string; trade_area: string; store_type: string;
  open_hour: number; close_hour: number; dine_in: string; delivery: string; relative_size: number;
};
export type Menu = {
  menu_id: string; menu_name: string; category: string; is_set: number;
  set_components: string; virtual_price: number;
};
export type Ingredient = {
  ingredient_id: string; ingredient_name: string; supplier_id: string;
  use_unit: string; order_unit: string; use_qty_per_order_unit: number;
  storage: string; shelf_life_days: number; /** 발주단위 */ min_order_qty: number;
};
export type BomRow = { menu_id: string; ingredient_id: string; /** use_unit/메뉴 */ qty_per_menu: number; use_unit: string };
export type Supplier = {
  supplier_id: string; supplier_name: string; order_days: string; order_cutoff: string;
  lead_time_days: number; delivery_days: string; min_order_amount: number; note: string;
};
export type PriceRow = { ingredient_id: string; valid_from: string; /** 원/발주단위 */ unit_price: number };
export type CalendarRow = { date: string; weekday: string; is_holiday: number; holiday_name: string };
export type Promotion = {
  promo_id: string; store_id: string; start_date: string; end_date: string; promo_type: string; target_menu: string;
};
export type MenuAvailability = { store_id: string; menu_id: string; start_date: string; end_date: string; status: string; note: string };
export type DailyDemand = {
  date: string; store_id: string; menu_id: string; demand_qty: number; qty: number;
  cancel_qty: number; lost_qty: number; sales_amount: number; promo_flag: number;
};
export type InventoryDaily = {
  date: string; store_id: string; ingredient_id: string; use_unit: string;
  opening_qty: number; received_qty: number; adjust_qty: number; counted_qty: number;
  consumed_qty: number; waste_qty: number; transfer_in_qty: number; transfer_out_qty: number;
  closing_qty: number; closing_value: number; stockout_flag: number; emergency_flag: number;
  avg_consumption_7d: number; low_stock_flag: number; overstock_flag: number;
};
export type LotRow = {
  date: string; store_id: string; ingredient_id: string; lot_id: string;
  receipt_date: string; last_use_date: string; /** use_unit, 영업 종료 후 */ remaining_qty: number; use_unit: string;
};
export type PurchaseOrder = {
  po_id: string; po_line_id: string; order_date: string; order_time: string; store_id: string;
  supplier_id: string; ingredient_id: string; /** order_unit */ order_qty: number; order_unit: string;
  unit_price: number; order_amount: number; expected_date: string; order_type: string;
};
export type Receipt = {
  receipt_id: string; po_line_id: string; po_id: string; store_id: string; ingredient_id: string;
  receipt_date: string; received_qty: number; order_unit: string; received_use_qty: number;
  status: string; delay_days: number;
};
export type Stockout = { date: string; store_id: string; ingredient_id: string; first_lost_hour: number; affected_menus: string; report: string };
export type DailyWaste = { date: string; store_id: string; ingredient_id: string; reason: string; waste_qty: number; waste_cost: number };

/** 입고 예정(기준일 시점 미입고 발주) — use_unit 환산 완료 */
export type OpenOrder = {
  po_line_id: string; ingredient_id: string; supplier_id: string; order_date: string;
  expected_date: string; order_qty: number; use_qty: number; order_type: string;
};

/** 서버(/api/snapshot)가 기준일·매장으로 잘라 내려주는 엔진 입력 */
export type Snapshot = {
  meta: {
    asOf: string; storeId: string; dataStart: string;
    /** 이 매장의 마지막 판매 기록일 (제공 데이터 또는 사용자 업로드) */
    dataEnd: string;
    /** 제공 데이터 마지막 날 */
    providedEnd: string;
    source: "db" | "json"; fixture: boolean;
    /** 사용자 입력 반영 현황 (근거 표시용) */
    overlay: {
      /** 기준일 실사 입력이 반영된 식자재 */
      countedToday: string[];
      /** 제공 기간 이후 재고를 업로드 판매로 이어 계산했는지 (= 추정 재고) */
      estimated: boolean;
      uploadedThrough: string | null;
      masterEdits: { entity: string; entity_id: string; field: string; value: string }[];
      priceEntries: number;
      appOrders: number;
    };
  };
  stores: Store[]; menus: Menu[]; ingredients: Ingredient[]; bom: BomRow[]; suppliers: Supplier[];
  prices: PriceRow[]; calendar: CalendarRow[]; promotions: Promotion[]; menuAvailability: MenuAvailability[];
  /** 기준일 전 lookback 기간 일별 수요 */
  demandHistory: DailyDemand[];
  /** 기준일 전 전체 기간 매장 일별 판매 합계(순수요 = 수요 − 취소) — 요일 지수·공휴일 배수 계산용 */
  dailyTotals: { date: string; y: number }[];
  /** 기준일 전 최근 재고 이력(차트·과잉 판단) */
  inventoryHistory: InventoryDaily[];
  /** 기준일 전날 영업 종료 후 lot 잔량 = 기준일 영업 시작 재고 */
  lots: LotRow[];
  openOrders: OpenOrder[];
  recentStockouts: Stockout[];
  recentWaste: DailyWaste[];
};
