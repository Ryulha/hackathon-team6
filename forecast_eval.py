"""
forecast_eval.py — 수요 예측 정확도 비교 (3번 파트)
최근 7일 추세 가중치(RECENT_WEIGHT)별로 '그날 아침 예측 vs 실제 수요' 오차를 비교한다.

실행: python forecast_eval.py [--start 2026-07-01 --end 2026-09-30]
지표: 매장 일 수요 기준 MAPE(평균 절대 백분율 오차), 과소예측률(실제가 예측보다 20% 이상 많았던 날 비율)
"""
import argparse

import pandas as pd

import engine as E

ap = argparse.ArgumentParser()
ap.add_argument("--start", default="2026-08-01")
ap.add_argument("--end", default="2026-09-30")
ap.add_argument("--weights", nargs="*", type=float, default=[0.5])
ap.add_argument("--sources", nargs="*", default=["engine", "catboost"], help="engine / catboost(2번 모델)")
ap.add_argument("--artifact-dir", default="models/evaluated")
a = ap.parse_args()
E.FORECAST_ARTIFACT_DIR = a.artifact_dir

D = E.load()
days = pd.date_range(a.start, a.end)
actual = D.daily.groupby(["store_id", "date"]).y.sum()
rows = []
for src in a.sources:
    E.FORECAST_SOURCE = src
    for w in a.weights:
        E.RECENT_WEIGHT = w
        for s in D.stores.store_id:
            for day in days:
                fm = E.forecast_menus(D, s, day, 1)
                if src == "catboost" and not fm.attrs.get("forecast_source", "").startswith("catboost"):
                    continue  # 2번 모델을 쓸 수 없는 날은 비교에서 제외
                f = fm.f.sum()
                y = actual.get((s, day), 0.0)
                if f > 0:
                    rows.append(dict(source=src, w=w, store=s, month=day.month,
                                     ape=abs(y - f) / max(y, 1), under=y > 1.2 * f))
x = pd.DataFrame(rows)
# 공정 비교: 두 출처 모두 예측이 있는 (매장, 날짜)만
key = ["store", "month"]
t = x.groupby(["source", "w"]).agg(MAPE=("ape", "mean"), 과소예측률=("under", "mean"), 일수=("ape", "size"))
m = x.pivot_table(index=["source", "w"], columns="month", values="ape", aggfunc="mean").add_prefix("MAPE_")
print(f"[예측 정확도 {a.start} ~ {a.end}, 매장 일 수요 기준] ※ catboost는 2번 모델 사용 가능일(8월 이후)만")
print(pd.concat([t, m], axis=1).round(3).to_string())