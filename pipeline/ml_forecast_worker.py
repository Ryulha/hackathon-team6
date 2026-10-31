"""팀 CatBoost 수요예측(data_cry 브랜치 src/forecast) 실행 — ml_forecast.py 가 전용 가상환경에서 부른다.

인자: <확장 데이터 폴더> <모델 폴더> <출력 CSV>
- 모델 2개를 팀 코드의 train 과 같은 방식으로 학습(122 trees = 팀이 7월 검증으로 고른 tree 수)
    · 7/31까지 정답 → 8/1~9/30 기준일 예측 (팀 Test 모형과 같은 학습 범위, 미래 정답 미사용)
    · 9/30까지 정답 → 10/1 기준일 예측 (실제 운영 시점)
- 기준일마다 그날부터 7일(horizon 0~6) 메뉴별 예측: 잠재 수요, 취소율 반영 판매 확정량
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd
from forecast.data import day, load_data
from forecast.features import FeatureBuilder
from forecast.model import DemandModel
from forecast.pipeline import Predictor

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ITERATIONS = 122
DAYS = 7
MODELS = [
    # (이름, 학습 정답 상한(이 날 미만), 예측 기준일 범위)
    ("upto_0731", "2026-08-01", pd.date_range("2026-08-01", "2026-09-30")),
    ("upto_0930", "2026-10-01", pd.date_range("2026-10-01", "2026-10-01")),
]


def train(data, cutoff: str, out: Path) -> DemandModel:
    """팀 cli.py train 과 같은 절차"""
    if (out / "catboost").exists():
        return DemandModel.load(out / "catboost")
    c = day(cutoff)
    ds = FeatureBuilder(data.before(c)).supervised(origin_end=c - pd.Timedelta(days=1), max_horizon=DAYS)
    ds = ds.loc[ds.target_date < c]
    model = DemandModel.fit(ds, iterations=ITERATIONS, max_horizon=DAYS)
    model.save(out / "catboost")
    (out / "selection.json").write_text(json.dumps({
        "selected_model": "catboost", "selection_target_max": model.metadata["selection_target_max"],
        "selection_rule": "team train procedure, 122 trees (July-selected count)"}), encoding="utf-8")
    return model


def main() -> None:
    data_dir, model_dir, out_csv = (Path(a) for a in sys.argv[1:4])
    data = load_data(data_dir)
    frames = []
    for name, cutoff, origins in MODELS:
        model = train(data, cutoff, model_dir / name)
        meta = json.loads((model_dir / name / "selection.json").read_text(encoding="utf-8"))
        pred = Predictor(data, model, "catboost", meta)
        print(f"  {name}: 학습 정답 ~{model.metadata['selection_target_max']}, trees {model.metadata['iterations']}, 기준일 {len(origins)}개", flush=True)
        for o in origins:
            m = pred.predict_demand(o.strftime("%Y-%m-%d"), DAYS).menus
            m["model"] = name
            frames.append(m)
    out = pd.concat(frames, ignore_index=True)
    out = out.rename(columns={"as_of_date": "origin", "target_date": "date"})
    out["is_available"] = out.is_available.astype(int)
    cols = ["origin", "date", "store_id", "menu_id", "horizon", "is_available", "pred_demand_qty", "cancel_rate", "pred_net_qty", "model"]
    out[cols].to_csv(out_csv, index=False, date_format="%Y-%m-%d")
    print(f"  → {len(out):,}행 {out_csv}", flush=True)


if __name__ == "__main__":
    main()
