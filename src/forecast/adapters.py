"""Provisional output adapters, isolated from model training and inference."""
import json
from pathlib import Path

from .pipeline import ForecastResult


def save_forecast(result: ForecastResult, output_dir):
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, frame in [("menu_forecast", result.menus), ("ingredient_forecast", result.ingredients)]:
        path = directory / f"{name}.csv"
        frame.to_csv(path, index=False, encoding="utf-8-sig", date_format="%Y-%m-%d")
        paths[name] = str(path)
    path = directory / "forecast_metadata.json"
    path.write_text(json.dumps(result.metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    paths["metadata"] = str(path)
    return paths
