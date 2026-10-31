"""Read-only source loading, validation, and daily demand panel."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import hashlib

import numpy as np
import pandas as pd

FILES = {
    "stores": "01_stores.csv", "menus": "02_menus.csv",
    "ingredients": "03_ingredients.csv", "bom": "04_bom.csv",
    "suppliers": "05_suppliers.csv", "prices": "06_ingredient_price_history.csv",
    "calendar": "07_calendar.csv", "promotions": "08_promotions.csv",
    "sales": "09_sales.csv", "inventory": "10_inventory_daily.csv",
    "orders": "11_purchase_orders.csv", "receipts": "12_receipts.csv",
    "waste": "13_waste.csv", "transfers": "14_transfers.csv",
    "availability": "15_menu_availability.csv", "lots": "16_inventory_lots_daily.csv",
    "stockouts": "17_stockouts.csv",
}
DATE_COLUMNS = {"date", "start_date", "end_date", "valid_from", "order_date",
                "expected_date", "receipt_date", "last_use_date"}
KEYS = {
    "stores": ["store_id"], "menus": ["menu_id"], "ingredients": ["ingredient_id"],
    "bom": ["menu_id", "ingredient_id"], "suppliers": ["supplier_id"],
    "prices": ["ingredient_id", "valid_from"], "calendar": ["date"],
    "promotions": ["promo_id"], "sales": ["date", "hour", "store_id", "menu_id", "channel"],
    "inventory": ["date", "store_id", "ingredient_id"], "orders": ["po_line_id"],
    "receipts": ["receipt_id"], "transfers": ["transfer_id"],
    "availability": ["store_id", "menu_id", "start_date"],
    "lots": ["date", "store_id", "ingredient_id", "lot_id"],
    "stockouts": ["date", "store_id", "ingredient_id"],
}


def discover_data_dir(root: str | Path = ".") -> Path:
    candidates = list(Path(root).resolve().rglob("09_sales.csv"))
    candidates = [p for p in candidates if ".venv" not in p.parts]
    if len(candidates) != 1:
        raise ValueError("Specify data_dir explicitly: expected exactly one 09_sales.csv")
    return candidates[0].parent


def day(value) -> pd.Timestamp:
    result = pd.Timestamp(value)
    if result.tz is not None:
        result = result.tz_convert("Asia/Seoul").tz_localize(None)
    if result != result.normalize():
        raise ValueError("as_of_date must identify a start-of-day date (Asia/Seoul)")
    return result


@dataclass
class DataBundle:
    tables: dict[str, pd.DataFrame]
    data_dir: Path

    def __getitem__(self, name):
        return self.tables[name]

    def before(self, as_of_date) -> "DataBundle":
        """Remove unavailable sales before any aggregation or feature calculation."""
        cutoff = day(as_of_date)
        tables = dict(self.tables)
        tables["sales"] = self["sales"].loc[self["sales"].date < cutoff].copy()
        return DataBundle(tables, self.data_dir)


def load_data(data_dir: str | Path | None = None, *, validate: bool = True) -> DataBundle:
    directory = Path(data_dir) if data_dir is not None else discover_data_dir()
    tables = {}
    for name, filename in FILES.items():
        frame = pd.read_csv(directory / filename, encoding="utf-8-sig")
        for col in DATE_COLUMNS.intersection(frame.columns):
            frame[col] = pd.to_datetime(frame[col], format="%Y-%m-%d", errors="raise")
        tables[name] = frame
    data = DataBundle(tables, directory)
    if validate:
        validate_data(data)
    return data


def validate_data(data: DataBundle) -> None:
    for name, keys in KEYS.items():
        frame = data[name]
        required = ["store_id", "menu_id"] if name == "availability" else keys
        if frame[required].isna().any().any() or frame.duplicated(keys).any():
            raise ValueError(f"Missing or duplicate key in {name}: {keys}")
    for name, frame in data.tables.items():
        for col, master in [("store_id", "stores"), ("from_store_id", "stores"),
                            ("to_store_id", "stores"), ("menu_id", "menus"),
                            ("ingredient_id", "ingredients"), ("supplier_id", "suppliers")]:
            if col in frame:
                refcol = "store_id" if col in {"from_store_id", "to_store_id"} else col
                if not frame[col].isin(data[master][refcol]).all():
                    raise ValueError(f"Unknown identifier: {name}.{col}")
    sales = data["sales"]
    numeric = ["demand_qty", "qty", "cancel_qty", "lost_qty"]
    if not np.isfinite(sales[numeric].to_numpy()).all() or (sales[numeric] < 0).any().any():
        raise ValueError("Sales quantities must be finite and nonnegative")
    if not (sales.qty == sales.demand_qty - sales.lost_qty).all():
        raise ValueError("qty != demand_qty - lost_qty")
    if (sales.cancel_qty > sales.qty).any():
        raise ValueError("cancel_qty exceeds qty")
    priced = sales.merge(data["menus"][["menu_id", "virtual_price"]], on="menu_id", validate="many_to_one")
    if not np.allclose(priced.sales_amount, (priced.qty - priced.cancel_qty) * priced.virtual_price):
        raise ValueError("Net sales amount violates specification")
    bom = data["bom"]
    units = bom.merge(data["ingredients"][["ingredient_id", "use_unit"]], on="ingredient_id", suffixes=("", "_master"))
    if not units.use_unit.eq(units.use_unit_master).all():
        raise ValueError("BOM use_unit mismatch")
    if (bom.qty_per_menu <= 0).any() or not np.isfinite(bom.qty_per_menu).all():
        raise ValueError("Invalid BOM quantities")
    if not set(data["menus"].menu_id).issubset(set(bom.menu_id)):
        raise ValueError("Menu missing BOM")
    calendar = data["calendar"]
    if len(calendar) != (calendar.date.max() - calendar.date.min()).days + 1:
        raise ValueError("Calendar must cover consecutive days")
    if not sales.date.isin(calendar.date).all():
        raise ValueError("Sales date missing calendar")
    av = data["availability"]
    if av.loc[av.status.eq("취급"), ["start_date", "end_date"]].isna().any().any():
        raise ValueError("Active availability interval missing dates")
    if (av.start_date.isna() != av.end_date.isna()).any():
        raise ValueError("Availability interval has only one date boundary")
    if (av.start_date > av.end_date).any() or not av.status.isin(["취급", "미취급"]).all():
        raise ValueError("Invalid availability interval")
    for _, group in av.groupby(["store_id", "menu_id"]):
        group = group.sort_values("start_date")
        if (group.start_date.iloc[1:].to_numpy() <= group.end_date.iloc[:-1].to_numpy()).any():
            raise ValueError("Overlapping availability intervals")
    covered = np.zeros(len(sales), dtype=bool)
    for row in av.loc[av.status.eq("취급")].itertuples():
        covered |= (sales.store_id.eq(row.store_id) & sales.menu_id.eq(row.menu_id)
                    & sales.date.between(row.start_date, row.end_date)).to_numpy()
    if not covered.all():
        raise ValueError("Sales outside active menu periods")
    for row in data["promotions"].itertuples():
        if not set(str(row.target_menu).split(",")).issubset(set(data["menus"].menu_id)):
            raise ValueError("Promotion contains unknown menu")


def build_daily_panel(data: DataBundle, end_date=None) -> pd.DataFrame:
    """Inactive days have NaN demand; missing sales on active days have zero demand."""
    cal = data["calendar"]
    dates = cal.date if end_date is None else cal.loc[cal.date <= day(end_date), "date"]
    index = pd.MultiIndex.from_product([dates, data["stores"].store_id, data["menus"].menu_id],
                                       names=["date", "store_id", "menu_id"])
    panel = index.to_frame(index=False)
    panel["is_available"] = False
    panel["available_since"] = pd.NaT
    for row in data["availability"].loc[lambda x: x.status.eq("취급")].itertuples():
        mask = (panel.store_id.eq(row.store_id) & panel.menu_id.eq(row.menu_id)
                & panel.date.between(row.start_date, row.end_date))
        panel.loc[mask, "is_available"] = True
        panel.loc[mask, "available_since"] = row.start_date
    totals = data["sales"].groupby(["date", "store_id", "menu_id"], as_index=False)[
        ["demand_qty", "qty", "cancel_qty", "lost_qty"]].sum()
    panel = panel.merge(totals, how="left", on=["date", "store_id", "menu_id"], validate="one_to_one")
    for col in ["demand_qty", "qty", "cancel_qty", "lost_qty"]:
        panel.loc[panel.is_available, col] = panel.loc[panel.is_available, col].fillna(0)
        panel.loc[~panel.is_available, col] = np.nan
    panel["net_qty"] = panel.qty - panel.cancel_qty
    return panel.merge(data["menus"][["menu_id", "category"]], on="menu_id", validate="many_to_one")


def source_hashes(directory: str | Path) -> dict[str, str]:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path(directory).iterdir()) if p.is_file()}
