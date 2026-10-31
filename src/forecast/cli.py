"""Local-only commands; never deploy or push source data."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from .adapters import save_forecast
from .audit import run_audit
from .data import build_daily_panel, day, load_data
from .evaluation import evaluate, metrics
from .features import FeatureBuilder
from .model import DemandModel
from .pipeline import Predictor


def demo(data, artifact_dir="models/evaluated", output_dir="outputs/demo", as_of_date="2026-09-24", forecast_days=7):
    predictor = Predictor.from_artifacts(data.data_dir, artifact_dir)
    result = predictor.predict_demand(as_of_date, forecast_days)
    save_forecast(result, output_dir)
    truth = build_daily_panel(data)[["date", "store_id", "menu_id", "demand_qty", "net_qty"]].rename(columns={"date": "target_date", "demand_qty": "actual_demand_qty", "net_qty": "actual_net_qty"})
    comparison = result.menus.merge(truth, on=["target_date", "store_id", "menu_id"], how="left", validate="one_to_one")
    comparison["error"] = comparison.pred_demand_qty - comparison.actual_demand_qty
    comparison["abs_error"] = comparison.error.abs()
    comparison.to_csv(Path(output_dir) / "menu_actual_comparison.csv", index=False, encoding="utf-8-sig", date_format="%Y-%m-%d")
    active = comparison.loc[comparison.is_available.eq(1)]
    score = metrics(active.actual_demand_qty, active.pred_demand_qty)
    provenance = result.metadata["model_provenance"]
    model_summary = (f"학습 target {provenance['train_target_min']}~{provenance['train_target_max']}, "
                     f"학습/선정 정답 상한 {provenance['selection_target_max']}, trees={provenance['iterations']}") if result.metadata["model"] == "catboost" else "기준일 이전 이력만 사용하는 동일 요일 평균"
    lines = ["# 실제 실행 데모", "", f"기준일 {as_of_date} 영업 전, 기준일 포함 {forecast_days}일. 합성 데이터 검증 데모.", "",
             f"모델: {result.metadata['model']}. {model_summary}. 전체 provenance는 `outputs/demo/forecast_metadata.json`에 저장한다.", "",
             f"취급 메뉴 {len(active):,} 예측 사례: MAE {score['MAE']:.4f}, WAPE {score['WAPE']:.2%}, Bias {score['Bias']:+.2%}.", "",
             "## 7일 매장별 수요", "", "| 매장 | 예측 잠재수요 | 실제 잠재수요 | 예상 판매 확정량 |", "|---|---:|---:|---:|"]
    for store, group in comparison.groupby("store_id"):
        lines.append(f"| {store} | {group.pred_demand_qty.sum():.2f} | {group.actual_demand_qty.sum():.0f} | {group.pred_net_qty.sum():.2f} |")
    lines += ["", "## 첫날 매장·메뉴 예시", "", "| 날짜 | 매장 | 메뉴 | 예측 수요 | 실제 수요 | 오차 |", "|---|---|---|---:|---:|---:|"]
    for row in comparison.head(8).itertuples():
        lines.append(f"| {row.target_date.date()} | {row.store_id} | {row.menu_id} | {row.pred_demand_qty:.2f} | {row.actual_demand_qty:.0f} | {row.error:+.2f} |")
    lines += ["", "## 7일 S01 식자재 소요량 예시", "", "| 식자재 | 예상 사용량 | 사용 단위 |", "|---|---:|---|"]
    usage = result.ingredients.loc[result.ingredients.store_id.eq("S01")].groupby(["ingredient_id", "use_unit"], as_index=False).pred_use_qty.sum()
    usage = usage.merge(data["ingredients"][["ingredient_id", "ingredient_name"]], on="ingredient_id")
    for row in usage.head(8).itertuples():
        lines.append(f"| {row.ingredient_id} {row.ingredient_name} | {row.pred_use_qty:.2f} | {row.use_unit} |")
    lines += ["", "전체 메뉴별 예측·실제·오차: `outputs/demo/menu_actual_comparison.csv`. 일별 식자재 소요량: `outputs/demo/ingredient_forecast.csv`.",
              "취소율은 origin 이전 56일의 accepted qty 대비 취소 수량이다. 전 수요를 품절 없이 충족한다는 가정 아래 예상 확정량과 BOM을 계산했다. 반올림/재고 차감/안전재고/발주량 계산은 하지 않는다.",
              "모델은 7월 말까지의 정답만 사용한 평가용 artifact를 재사용한다. 9월 24일 이후 정답은 이 비교표 작성 단계에서만 결합한다."]
    Path("docs/DEMO_RESULTS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"demo": score, "menu_rows": len(result.menus), "ingredient_rows": len(result.ingredients)}, indent=2), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description="Independent forecast MVP; internal schemas are provisional")
    parser.add_argument("--data-dir", default=None)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("audit")
    p = sub.add_parser("evaluate")
    p.add_argument("--forecast-days", type=int, default=7)
    p.add_argument("--artifact-dir", default="models/evaluated")
    p = sub.add_parser("train")
    p.add_argument("--as-of-date", required=True, help="Only labels strictly before this day")
    p.add_argument("--forecast-days", type=int, default=7)
    p.add_argument("--iterations", type=int, default=400)
    p.add_argument("--artifact-dir", default="models/custom")
    for name in ["predict", "demo"]:
        p = sub.add_parser(name)
        p.add_argument("--as-of-date", default="2026-09-24")
        p.add_argument("--forecast-days", type=int, default=7)
        p.add_argument("--artifact-dir", default="models/evaluated")
        p.add_argument("--output-dir", default="outputs/" + name)
        if name == "predict":
            p.add_argument("--store-ids", nargs="+")
            p.add_argument("--demand-multiplier", type=float, default=1.0)
    sub.add_parser("all")
    args = parser.parse_args()
    data = load_data(args.data_dir)
    if args.command in {"audit", "all"}:
        result = run_audit(data)
        print(json.dumps(result["checks"], indent=2), flush=True)
    if args.command in {"evaluate", "all"}:
        evaluate(data, artifact_dir=getattr(args, "artifact_dir", "models/evaluated"), forecast_days=getattr(args, "forecast_days", 7))
    if args.command == "train":
        cutoff = day(args.as_of_date)
        history = data.before(cutoff)
        dataset = FeatureBuilder(history).supervised(origin_end=cutoff - pd.Timedelta(days=1), max_horizon=args.forecast_days)
        dataset = dataset.loc[dataset.target_date < cutoff]
        model = DemandModel.fit(dataset, iterations=args.iterations, max_horizon=args.forecast_days)
        model.save(Path(args.artifact_dir) / "catboost")
        Path(args.artifact_dir, "selection.json").write_text(json.dumps({"selected_model": "catboost", "selection_target_max": model.metadata["selection_target_max"], "selection_rule": "Explicit standalone training; not validation selected"}, indent=2), encoding="utf-8")
        print(json.dumps(model.metadata, ensure_ascii=False, indent=2), flush=True)
    if args.command in {"demo", "all"}:
        demo(data, artifact_dir=getattr(args, "artifact_dir", "models/evaluated"), output_dir=getattr(args, "output_dir", "outputs/demo"), as_of_date=getattr(args, "as_of_date", "2026-09-24"), forecast_days=getattr(args, "forecast_days", 7))
    if args.command == "predict":
        predictor = Predictor.from_artifacts(data.data_dir, args.artifact_dir)
        result = predictor.predict_demand(args.as_of_date, args.forecast_days, args.store_ids, args.demand_multiplier)
        print(json.dumps(save_forecast(result, args.output_dir), ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
