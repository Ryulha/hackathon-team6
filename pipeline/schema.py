"""명세서(주제1_사전공개_데이터명세서) 기반 CSV 스키마.

kind: id | str | int | float | date | flag01 | yn | list
TODO(10/31): 실제 파일을 열어 list 컬럼 구분자, 요일 표기, status 코드 값을 확인하고 갱신.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
GENERATED_DIR = ROOT / "web" / "src" / "data" / "generated"
REPORT_DIR = Path(__file__).resolve().parent / "reports"

# 파일명 → (테이블명, {컬럼: kind}, 기본키 컬럼)
SCHEMA: dict[str, tuple[str, dict[str, str], list[str]]] = {
    "01_stores.csv": ("stores", {
        "store_id": "id", "store_name": "str", "trade_area": "str", "store_type": "str",
        "open_hour": "int", "close_hour": "int", "dine_in": "yn", "delivery": "yn",
        "relative_size": "float",
    }, ["store_id"]),
    "02_menus.csv": ("menus", {
        "menu_id": "id", "menu_name": "str", "category": "str", "is_set": "flag01",
        "set_components": "list", "virtual_price": "float",
    }, ["menu_id"]),
    "03_ingredients.csv": ("ingredients", {
        "ingredient_id": "id", "ingredient_name": "str", "supplier_id": "id",
        "use_unit": "str", "order_unit": "str", "use_qty_per_order_unit": "float",
        "storage": "str", "shelf_life_days": "int", "min_order_qty": "float",
    }, ["ingredient_id"]),
    "04_bom.csv": ("bom", {
        "menu_id": "id", "ingredient_id": "id", "qty_per_menu": "float", "use_unit": "str",
    }, ["menu_id", "ingredient_id"]),
    "05_suppliers.csv": ("suppliers", {
        "supplier_id": "id", "supplier_name": "str", "order_days": "list",
        "order_cutoff": "str", "lead_time_days": "int", "delivery_days": "list",
        "min_order_amount": "float", "note": "str",
    }, ["supplier_id"]),
    "06_ingredient_price_history.csv": ("ingredient_price_history", {
        "ingredient_id": "id", "valid_from": "date", "unit_price": "float",
    }, ["ingredient_id", "valid_from"]),
    "07_calendar.csv": ("calendar", {
        "date": "date", "weekday": "str", "is_holiday": "flag01", "holiday_name": "str",
    }, ["date"]),
    "08_promotions.csv": ("promotions", {
        "promo_id": "id", "store_id": "id", "start_date": "date", "end_date": "date",
        "promo_type": "str", "target_menu": "list",
    }, ["promo_id"]),
    "09_sales.csv": ("sales", {
        "date": "date", "hour": "int", "store_id": "id", "menu_id": "id", "channel": "str",
        "demand_qty": "float", "qty": "float", "cancel_qty": "float", "lost_qty": "float",
        "sales_amount": "float", "promo_flag": "flag01",
    }, ["date", "hour", "store_id", "menu_id", "channel"]),
    "10_inventory_daily.csv": ("inventory_daily", {
        "date": "date", "store_id": "id", "ingredient_id": "id", "use_unit": "str",
        "opening_qty": "float", "received_qty": "float", "adjust_qty": "float",
        "counted_qty": "float", "consumed_qty": "float", "waste_qty": "float",
        "transfer_in_qty": "float", "transfer_out_qty": "float", "closing_qty": "float",
        "closing_value": "float", "stockout_flag": "flag01", "emergency_flag": "flag01",
        "avg_consumption_7d": "float", "low_stock_flag": "flag01", "overstock_flag": "flag01",
    }, ["date", "store_id", "ingredient_id"]),
    "11_purchase_orders.csv": ("purchase_orders", {
        "po_id": "id", "po_line_id": "id", "order_date": "date", "order_time": "str",
        "store_id": "id", "supplier_id": "id", "ingredient_id": "id", "order_qty": "float",
        "order_unit": "str", "unit_price": "float", "order_amount": "float",
        "expected_date": "date", "order_type": "str",
    }, ["po_line_id"]),
    "12_receipts.csv": ("receipts", {
        "receipt_id": "id", "po_line_id": "id", "po_id": "id", "store_id": "id",
        "ingredient_id": "id", "receipt_date": "date", "received_qty": "float",
        "order_unit": "str", "received_use_qty": "float", "status": "str", "delay_days": "int",
    }, ["receipt_id"]),
    "13_waste.csv": ("waste", {
        "date": "date", "store_id": "id", "ingredient_id": "id", "waste_qty": "float",
        "use_unit": "str", "reason": "str", "waste_cost": "float",
    }, []),
    "14_transfers.csv": ("transfers", {
        "transfer_id": "id", "date": "date", "hour": "int", "from_store_id": "id",
        "to_store_id": "id", "ingredient_id": "id", "qty": "float", "use_unit": "str",
        "reason": "str",
    }, ["transfer_id"]),
    "15_menu_availability.csv": ("menu_availability", {
        "store_id": "id", "menu_id": "id", "start_date": "date", "end_date": "date",
        "status": "str", "note": "str",
    }, ["store_id", "menu_id", "start_date"]),
    "16_inventory_lots_daily.csv": ("inventory_lots_daily", {
        "date": "date", "store_id": "id", "ingredient_id": "id", "lot_id": "id",
        "receipt_date": "date", "last_use_date": "date", "remaining_qty": "float",
        "use_unit": "str",
    }, ["date", "store_id", "ingredient_id", "lot_id"]),
    "17_stockouts.csv": ("stockouts", {
        "date": "date", "store_id": "id", "ingredient_id": "id", "first_lost_hour": "int",
        "affected_menus": "list", "report": "str",
    }, ["date", "store_id", "ingredient_id"]),
}

# (테이블, 컬럼) → 참조 테이블.컬럼 : 키 무결성 검사용
FOREIGN_KEYS: list[tuple[str, str, str, str]] = [
    ("ingredients", "supplier_id", "suppliers", "supplier_id"),
    ("bom", "menu_id", "menus", "menu_id"),
    ("bom", "ingredient_id", "ingredients", "ingredient_id"),
    ("ingredient_price_history", "ingredient_id", "ingredients", "ingredient_id"),
    ("promotions", "store_id", "stores", "store_id"),
    ("sales", "store_id", "stores", "store_id"),
    ("sales", "menu_id", "menus", "menu_id"),
    ("inventory_daily", "store_id", "stores", "store_id"),
    ("inventory_daily", "ingredient_id", "ingredients", "ingredient_id"),
    ("purchase_orders", "supplier_id", "suppliers", "supplier_id"),
    ("purchase_orders", "ingredient_id", "ingredients", "ingredient_id"),
    ("receipts", "po_line_id", "purchase_orders", "po_line_id"),
    ("waste", "ingredient_id", "ingredients", "ingredient_id"),
    ("transfers", "from_store_id", "stores", "store_id"),
    ("transfers", "to_store_id", "stores", "store_id"),
    ("menu_availability", "menu_id", "menus", "menu_id"),
    ("inventory_lots_daily", "ingredient_id", "ingredients", "ingredient_id"),
    ("stockouts", "ingredient_id", "ingredients", "ingredient_id"),
]

PG_TYPES = {
    "id": "text", "str": "text", "list": "text", "int": "integer", "float": "double precision",
    "date": "date", "flag01": "smallint", "yn": "text",
}


def table_name(file_name: str) -> str:
    return SCHEMA[file_name][0]
