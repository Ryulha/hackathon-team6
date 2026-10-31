"""Target-date splits and daily-origin direct multi-horizon rolling backtest."""
from __future__ import annotations

import json
from pathlib import Path
import platform
import importlib.metadata

import numpy as np
import pandas as pd

from .features import FeatureBuilder
from .model import DemandModel


def metrics(actual, predicted):
    y, p = np.asarray(actual, dtype=float), np.asarray(predicted, dtype=float)
    if not len(y) or not np.isfinite(y).all() or not np.isfinite(p).all():
        raise ValueError("Metrics require nonempty finite values")
    error = p - y
    denominator = np.abs(y).sum()
    return {"n": len(y), "MAE": float(np.abs(error).mean()),
            "WAPE": float(np.abs(error).sum() / denominator) if denominator else None,
            "Bias": float(error.sum() / denominator) if denominator else None,
            "mean_error": float(error.mean())}


def score_frame(frame, split):
    result = []
    for model_name in ["baseline", "catboost"]:
        for dimension in [None, "horizon", "store_id", "menu_id", "target_month"]:
            groups = [("all", frame)] if dimension is None else frame.groupby(dimension)
            for label, group in groups:
                result.append({"split": split, "model": model_name, "dimension": dimension or "overall",
                               "group": str(label), **metrics(group.demand_qty, group[f"pred_{model_name}"])})
    return pd.DataFrame(result)


def evaluate(data, output_dir="outputs/evaluation", artifact_dir="models/evaluated", forecast_days=7):
    directory, artifacts = Path(output_dir), Path(artifact_dir)
    directory.mkdir(parents=True, exist_ok=True)
    artifacts.mkdir(parents=True, exist_ok=True)
    print("Building frozen-origin direct-horizon dataset...", flush=True)
    dataset = FeatureBuilder(data).supervised(max_horizon=forecast_days)
    dataset.to_csv(directory / "modeling_dataset.csv", index=False, date_format="%Y-%m-%d")
    train = dataset.loc[dataset.target_date <= "2026-06-30"]
    validation = dataset.loc[dataset.as_of_date.ge("2026-07-01") & dataset.target_date.between("2026-07-01", "2026-07-31")].copy()
    test = dataset.loc[dataset.as_of_date.ge("2026-08-01") & dataset.target_date.between("2026-08-01", "2026-09-30")].copy()
    if train.empty or validation.empty or test.empty:
        raise ValueError("Supplied data do not cover configured evaluation splits")
    print(f"Train={len(train):,}, validation={len(validation):,}, test={len(test):,}", flush=True)
    tuned = DemandModel.fit(train, validation, max_horizon=forecast_days)
    tuned.save(artifacts / "validation_catboost")
    # Validation predicts with its selected tree count; it is a tuning score, not held-out test evidence.
    validation["pred_catboost"] = np.maximum(tuned.estimator.predict(validation[tuned.metadata["features"]]), 0)
    validation["pred_baseline"] = validation.baseline_qty
    val_base = metrics(validation.demand_qty, validation.pred_baseline)
    val_cat = metrics(validation.demand_qty, validation.pred_catboost)
    selected = "catboost" if val_cat["WAPE"] < val_base["WAPE"] else "baseline"
    # Refit before the test period, fixing tree count using July only; test labels are untouched.
    refit_train = dataset.loc[dataset.target_date.le("2026-07-31")]
    fitted = DemandModel.fit(refit_train, iterations=tuned.metadata["iterations"], max_horizon=forecast_days)
    fitted.save(artifacts / "catboost")
    test["pred_catboost"] = fitted.predict(test)
    test["pred_baseline"] = test.baseline_qty
    for frame in [validation, test]:
        frame["target_month"] = frame.target_date.dt.strftime("%Y-%m")
    scores = pd.concat([score_frame(validation, "validation"), score_frame(test, "test")], ignore_index=True)
    scores.to_csv(directory / "metrics.csv", index=False)
    keys = ["as_of_date", "target_date", "horizon", "store_id", "menu_id", "demand_qty", "pred_baseline", "pred_catboost"]
    pd.concat([validation[keys].assign(split="validation"), test[keys].assign(split="test")]).to_csv(directory / "backtest_predictions.csv", index=False, date_format="%Y-%m-%d")
    selection = {"selected_model": selected, "selection_rule": "Lowest July validation WAPE; test never used for model selection",
                 "selection_target_max": "2026-07-31",
                 "validation": {"baseline": val_base, "catboost": val_cat},
                 "test": {name: metrics(test.demand_qty, test[f"pred_{name}"]) for name in ["baseline", "catboost"]},
                 "iterations": tuned.metadata["iterations"], "forecast_days": forecast_days,
                 "split_rows": {"train": len(train), "validation": len(validation), "test": len(test), "test_model_refit": len(refit_train)},
                 "test_origin_count": int(test.as_of_date.nunique()), "test_target_max": str(test.target_date.max().date()),
                 "status": "PROPOSED — NOT TEAM APPROVED"}
    (artifacts / "selection.json").write_text(json.dumps(selection, ensure_ascii=False, indent=2), encoding="utf-8")
    (directory / "summary.json").write_text(json.dumps(selection, ensure_ascii=False, indent=2), encoding="utf-8")
    versions = {package: importlib.metadata.version(package) for package in ["pandas", "numpy", "catboost", "scikit-learn", "matplotlib", "pytest"]}
    (directory / "environment.json").write_text(json.dumps({"python": platform.python_version(), "packages": versions}, indent=2), encoding="utf-8")
    _plot(scores, directory)
    _write_report(selection, scores)
    print(json.dumps(selection, ensure_ascii=False, indent=2), flush=True)
    return selection


def _plot(scores, directory):
    import os
    os.environ.setdefault("MPLCONFIGDIR", str(Path(".cache/matplotlib").resolve()))
    os.environ.setdefault("XDG_CACHE_HOME", str(Path(".cache").resolve()))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    for name in ["baseline", "catboost"]:
        frame = scores.loc[scores.split.eq("test") & scores.model.eq(name) & scores.dimension.eq("horizon")]
        axes[0].plot(frame.group.astype(int) + 1, frame.MAE, marker="o", label=name)
        frame = scores.loc[scores.split.eq("test") & scores.model.eq(name) & scores.dimension.eq("store_id")]
        axes[1].plot(frame.group, frame.WAPE * 100, marker="o", label=name)
    axes[0].set(xlabel="Forecast day (origin included)", ylabel="MAE (menu units)", title="Test error by horizon")
    axes[1].set(xlabel="Synthetic store", ylabel="WAPE (%)", title="Test error by store")
    axes[0].legend()
    axes[1].legend()
    fig.tight_layout()
    fig.savefig(directory / "test_metrics.png", dpi=160)
    plt.close(fig)


def _write_report(selection, scores):
    lines = ["# 모델 평가", "", "제공 합성 데이터의 실제 학습·실행 결과. 실제 매장 성과로 해석하지 않는다.", "",
             "## 평가 설계", "",
             "- Target 날짜 기준 Train 2026-01-29~06-30(1월 1일부터 28일 warmup), Validation 07-01~07-31, Test 08-01~09-30.",
             "- 매일 영업 시작 전을 origin으로 0~6일 direct horizon을 생성한다. 각 origin의 모든 과거 수요 Feature는 origin 미만 날짜만 사용한다. horizon=0은 기준일 당일이다.",
             "- Split 시작일 이전 origin은 평가에서 제외하고, split 마지막 날짜 이후 target도 제외한다. 따라서 우측 경계는 일부 horizon만 있고 horizon별 n이 다르다.",
             "- 동일 target이 여러 origin/horizon에서 반복되므로 전체 지표는 매장×메뉴×origin×horizon 예측 사례를 동일 가중한다. 일별 origin rolling backtest이며 모형 가중치는 test 시작 전 고정한다. 과거 관측 Feature만 매일 갱신한다.",
             "- Baseline은 최근 동일 요일 4회의 평균. 부족하면 관측 가능한 동일 매장·메뉴 28일 평균 → 매장·카테고리 평균 → 매장 메뉴 평균 → 0. 0 수요는 포함하고 미취급은 평균에서 제외한다.",
             "- CatBoost 글로벌 direct multi-horizon: iterations=400, depth=6, learning_rate=0.05, l2_leaf_reg=5, early_stopping_rounds=50, seed=42, CPU threads=4. RMSE 학습/MAE 조기종료, 음수는 0으로 제한한다.",
             "- 1~6월 학습 + 7월 조기종료로 tree 수를 결정한다. 7월 WAPE만으로 모델을 선택한다. Validation은 튜닝에 사용한 점수이므로 낙관 편향 가능성이 있다.",
             "- Test용 CatBoost는 선택한 tree 수로 7월 31일까지의 target을 재학습한다. 8~9월 정답은 가중치 학습·조기종료·선정에 사용하지 않는다. Test 평가 후 설정을 재튜닝하지 않는다.", "",
             "## 비교", "", "| 구간 | 모델 | 예측 사례 수 | MAE | WAPE | Bias |", "|---|---|---:|---:|---:|---:|"]
    for split in ["validation", "test"]:
        for name in ["baseline", "catboost"]:
            v = selection[split][name]
            lines.append(f"| {split} | {name} | {v['n']:,} | {v['MAE']:.4f} | {v['WAPE']:.2%} | {v['Bias']:+.2%} |")
    lines += ["", f"선정: **{selection['selected_model']}**. 선정 규칙: 7월 WAPE가 더 낮은 모델(동률 Baseline). 선택된 CatBoost tree 수: {selection['iterations']}.", "",
              "MAE=mean(|p−y|), WAPE=sum(|p−y|)/sum(|y|), Bias=sum(p−y)/sum(|y|). Bias 양수는 과대예측. 분모 0이면 WAPE/Bias는 null이며 MAE와 mean_error를 함께 제공한다.", "",
              "## Test horizon별 MAE", "", "| horizon(0=당일) | 모델 | n | MAE |", "|---:|---|---:|---:|"]
    for row in scores.loc[scores.split.eq("test") & scores.dimension.eq("horizon")].itertuples():
        lines.append(f"| {row.group} | {row.model} | {row.n:,} | {row.MAE:.4f} |")
    lines += ["", "## Test 매장별 WAPE", "", "| 매장 | 모델 | MAE | WAPE | Bias |", "|---|---|---:|---:|---:|"]
    for row in scores.loc[scores.split.eq("test") & scores.dimension.eq("store_id")].itertuples():
        lines.append(f"| {row.group} | {row.model} | {row.MAE:.4f} | {row.WAPE:.2%} | {row.Bias:+.2%} |")
    lines += ["", "메뉴별/월별 성능 및 전체 n은 `outputs/evaluation/metrics.csv`, 모든 origin별 예측/정답은 `backtest_predictions.csv`, 모델링 데이터셋은 `modeling_dataset.csv`에 저장한다.",
              "", "## 한계와 재현성", "",
              "- 행사 1건이 validation에만 존재하고 train에 사례가 없다. 행사 효과를 검증했다고 주장하지 않는다.",
              "- 합성 잠재 수요 정답이 제공되는 문제이며, 실매장에서 잠재 수요는 직접 관측되지 않을 수 있다.",
              "- 신메뉴와 향후 패턴 변화에 대한 일반화, 확률 예측 및 발주 비용 최적화는 검증 범위 밖이다. 모델 오차의 식자재 환산은 BOM으로 전파되며 안전재고는 Part 3에서 협의한다.",
              "- 환경은 `outputs/evaluation/environment.json`, 고정 버전은 `requirements.lock.txt`에 기록한다. 동일 환경·입력·seed를 사용한다. 하드웨어/라이브러리 차이의 비트 단위 일치는 보장하지 않는다.",
              "- 기준일 이후 판매 변조에 대한 Feature/추론/취소율 불변성, 저장·재사용, 시나리오 선형 반영을 pytest로 검증한다.",
              "- 참고: [CatBoost fit](https://catboost.ai/docs/en/concepts/python-reference_catboostregressor_fit), [model persistence](https://catboost.ai/docs/en/concepts/python-reference_catboost_save_model)."]
    Path("docs").mkdir(exist_ok=True)
    Path("docs/MODEL_EVALUATION.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
