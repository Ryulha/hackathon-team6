# 모델 평가

제공 합성 데이터의 실제 학습·실행 결과. 실제 매장 성과로 해석하지 않는다.

## 평가 설계

- Target 날짜 기준 Train 2026-01-29~06-30(1월 1일부터 28일 warmup), Validation 07-01~07-31, Test 08-01~09-30.
- 매일 영업 시작 전을 origin으로 0~6일 direct horizon을 생성한다. 각 origin의 모든 과거 수요 Feature는 origin 미만 날짜만 사용한다. horizon=0은 기준일 당일이다.
- Split 시작일 이전 origin은 평가에서 제외하고, split 마지막 날짜 이후 target도 제외한다. 따라서 우측 경계는 일부 horizon만 있고 horizon별 n이 다르다.
- 동일 target이 여러 origin/horizon에서 반복되므로 전체 지표는 매장×메뉴×origin×horizon 예측 사례를 동일 가중한다. 일별 origin rolling backtest이며 모형 가중치는 test 시작 전 고정한다. 과거 관측 Feature만 매일 갱신한다.
- Baseline은 최근 동일 요일 4회의 평균. 부족하면 관측 가능한 동일 매장·메뉴 28일 평균 → 매장·카테고리 평균 → 매장 메뉴 평균 → 0. 0 수요는 포함하고 미취급은 평균에서 제외한다.
- CatBoost 글로벌 direct multi-horizon: iterations=400, depth=6, learning_rate=0.05, l2_leaf_reg=5, early_stopping_rounds=50, seed=42, CPU threads=4. RMSE 학습/MAE 조기종료, 음수는 0으로 제한한다.
- 1~6월 학습 + 7월 조기종료로 tree 수를 결정한다. 7월 WAPE만으로 모델을 선택한다. Validation은 튜닝에 사용한 점수이므로 낙관 편향 가능성이 있다.
- Test용 CatBoost는 선택한 tree 수로 7월 31일까지의 target을 재학습한다. 8~9월 정답은 가중치 학습·조기종료·선정에 사용하지 않는다. Test 평가 후 설정을 재튜닝하지 않는다.

## 비교

| 구간 | 모델 | 예측 사례 수 | MAE | WAPE | Bias |
|---|---|---:|---:|---:|---:|
| validation | baseline | 9,212 | 4.7697 | 28.95% | -0.28% |
| validation | catboost | 9,212 | 4.3560 | 26.44% | +0.15% |
| test | baseline | 18,270 | 5.0113 | 28.74% | -2.06% |
| test | catboost | 18,270 | 4.6031 | 26.40% | -2.49% |

선정: **catboost**. 선정 규칙: 7월 WAPE가 더 낮은 모델(동률 Baseline). 선택된 CatBoost tree 수: 122.

MAE=mean(|p−y|), WAPE=sum(|p−y|)/sum(|y|), Bias=sum(p−y)/sum(|y|). Bias 양수는 과대예측. 분모 0이면 WAPE/Bias는 null이며 MAE와 mean_error를 함께 제공한다.

## Test horizon별 MAE

| horizon(0=당일) | 모델 | n | MAE |
|---:|---|---:|---:|
| 0 | baseline | 2,745 | 4.9734 |
| 1 | baseline | 2,700 | 5.0028 |
| 2 | baseline | 2,655 | 5.0217 |
| 3 | baseline | 2,610 | 5.0358 |
| 4 | baseline | 2,565 | 5.0328 |
| 5 | baseline | 2,520 | 5.0044 |
| 6 | baseline | 2,475 | 5.0103 |
| 0 | catboost | 2,745 | 4.5473 |
| 1 | catboost | 2,700 | 4.5535 |
| 2 | catboost | 2,655 | 4.6077 |
| 3 | catboost | 2,610 | 4.6389 |
| 4 | catboost | 2,565 | 4.6244 |
| 5 | catboost | 2,520 | 4.6108 |
| 6 | catboost | 2,475 | 4.6462 |

## Test 매장별 WAPE

| 매장 | 모델 | MAE | WAPE | Bias |
|---|---|---:|---:|---:|
| S01 | baseline | 6.8579 | 26.19% | -0.10% |
| S02 | baseline | 4.5520 | 29.10% | -0.62% |
| S03 | baseline | 3.5378 | 34.86% | -8.95% |
| S01 | catboost | 6.1516 | 23.50% | -1.81% |
| S02 | catboost | 4.2623 | 27.25% | -1.96% |
| S03 | catboost | 3.3314 | 32.83% | -4.93% |

메뉴별/월별 성능 및 전체 n은 `outputs/evaluation/metrics.csv`, 모든 origin별 예측/정답은 `backtest_predictions.csv`, 모델링 데이터셋은 `modeling_dataset.csv`에 저장한다.

## 한계와 재현성

- 행사 1건이 validation에만 존재하고 train에 사례가 없다. 행사 효과를 검증했다고 주장하지 않는다.
- 합성 잠재 수요 정답이 제공되는 문제이며, 실매장에서 잠재 수요는 직접 관측되지 않을 수 있다.
- 신메뉴와 향후 패턴 변화에 대한 일반화, 확률 예측 및 발주 비용 최적화는 검증 범위 밖이다. 모델 오차의 식자재 환산은 BOM으로 전파되며 안전재고는 Part 3에서 협의한다.
- 환경은 `outputs/evaluation/environment.json`, 고정 버전은 `requirements.lock.txt`에 기록한다. 동일 환경·입력·seed를 사용한다. 하드웨어/라이브러리 차이의 비트 단위 일치는 보장하지 않는다.
- 기준일 이후 판매 변조에 대한 Feature/추론/취소율 불변성, 저장·재사용, 시나리오 선형 반영을 pytest로 검증한다.
- 참고: [CatBoost fit](https://catboost.ai/docs/en/concepts/python-reference_catboostregressor_fit), [model persistence](https://catboost.ai/docs/en/concepts/python-reference_catboost_save_model).
