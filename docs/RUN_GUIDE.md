# 독립 실행 가이드

현재 작업 디렉터리 `/Users/sanghyun/data_cry`에서 실행한다. Python 3.12 가상환경을 구성했다. 원본 README와 CSV/명세/PDF는 보존했고 Git 초기화·push·배포는 수행하지 않았다. 외부 유료 API는 사용하지 않는다.

## 환경 재구성

```bash
uv --cache-dir .cache/uv venv --python 3.12 .venv
uv --cache-dir .cache/uv pip install --python .venv/bin/python -r requirements.lock.txt
uv --cache-dir .cache/uv pip install --python .venv/bin/python --no-deps -e .
```

lock 파일은 이번 실제 설치 버전을 고정한다. 일반 호환 범위는 requirements.txt다. 제공 데이터 폴더는 재배포하지 않으므로 별도로 로컬에 보관해야 한다. 기본값은 현재 폴더 아래 유일한 `09_sales.csv`의 상위 data 폴더를 찾는다. 명시하려면 `python -m forecast --data-dir '/path/to/data' COMMAND`를 사용한다.

## 전체 작업 재실행

```bash
.venv/bin/python -m forecast all
.venv/bin/python -m pytest -q
```

all은 17개 데이터 감사 → 일별 데이터셋 → Baseline/글로벌 CatBoost 평가 → 모형 저장 → 09-24~09-30 데모 CSV/실제 오차를 생성한다. 고정 평가 날짜는 evaluation.py에 있으며 평가 정책 변경 시 재검증해야 한다.

## 개별 명령

```bash
.venv/bin/python -m forecast audit
.venv/bin/python -m forecast evaluate --forecast-days 7
.venv/bin/python -m forecast predict --as-of-date 2026-09-24 --forecast-days 7 --store-ids S01 S02 --demand-multiplier 1.10 --output-dir outputs/scenario
.venv/bin/python -m forecast demo --as-of-date 2026-09-24
```

predict는 저장된 모형/선정 기록을 읽어 추론만 실행한다. CSV 저장은 CLI가 Adapter로 수행한다. Python 함수 자체에는 디스크 저장 부작용이 없다.

```python
from forecast import predict_demand, Predictor
from forecast.adapters import save_forecast

result = predict_demand("2026-09-24", forecast_days=7)
print(result.menus.head())
print(result.ingredients.head())
save_forecast(result, "outputs/custom")

# 여러 시나리오에 동일 모형 재사용
predictor = Predictor.from_artifacts(artifact_dir="models/evaluated")
scenario = predictor.predict_demand("2026-09-24", store_ids=["S01"], demand_multiplier=1.15)
```

## 독립 재학습

```bash
.venv/bin/python -m forecast train --as-of-date 2026-09-24 --forecast-days 7 --iterations 400 --artifact-dir models/custom
.venv/bin/python -m forecast predict --as-of-date 2026-09-24 --artifact-dir models/custom --output-dir outputs/custom_model
```

train은 정답 날짜가 as_of_date 미만인 행만 사용한다. 명시적 CatBoost 재학습이며 검증 선정된 모형이라는 뜻은 아니다. 기본 데모는 custom 재학습 대신 7월까지의 평가 모형을 재사용해 Test 비교를 보존한다. 별도 실제 배치용 모형을 9월 30일까지 재학습할 수 있지만, 그것으로 9월 24일 데모를 실행하면 provenance 검사에 의해 거부된다.

## 산출물

| 경로 | 내용 |
|---|---|
| docs/DATA_AUDIT.md | 17개 파일, 결측/수량/연결 검증과 전처리 가정 |
| docs/MODEL_EVALUATION.md | 실제 평가, horizon/매장 지표, 선정 이유 |
| docs/DEMO_RESULTS.md | 7일 데모, 실제 수요 오차, 식자재 예시 |
| docs/PROPOSED_DATA_CONTRACT.md | 팀 미승인 내부 형식 및 9개 협의 항목 |
| outputs/audit/audit.json | 모든 컬럼별 dtype/결측/중복/검증 수치 |
| outputs/audit/source_manifest.json | 원본 SHA-256 보존 증거 |
| outputs/evaluation/modeling_dataset.csv | origin/target/horizon 및 Feature/정답 |
| outputs/evaluation/metrics.csv | 전체·horizon·매장·메뉴·월별 MAE/WAPE/Bias |
| outputs/evaluation/backtest_predictions.csv | 매일 origin별 두 모델 예측과 실제 정답 |
| outputs/evaluation/test_metrics.png | Test horizon/매장 성능 그림 |
| models/evaluated/catboost/ | Test/데모용 7월까지 재학습한 CatBoost 및 provenance |
| models/evaluated/validation_catboost/ | 6월까지 학습/7월 조기종료한 검증 모형 |
| models/evaluated/selection.json | 7월 기준 최종 모델 선택 기록 |
| outputs/demo/menu_forecast.csv | 메뉴별 7일 잠재 수요/예상 확정량 |
| outputs/demo/menu_actual_comparison.csv | 실제 잠재 수요와 오차 |
| outputs/demo/ingredient_forecast.csv | 매장·날짜·식자재·use_unit별 예상 소요량 |
| outputs/demo/forecast_metadata.json | 기준일, 학습 범위, 취소율/시나리오 가정 |

## 운영 한계

제공 달력/취급 일정/판매는 2026-09-30까지만 있다. 이번 완료는 데이터 안에서 검증 가능한 7일 데모다. 실제 현재 날짜 이후 예측을 위해서는 전일까지 판매와 대상일까지의 정확한 일정이 필요하다. 날짜 밖을 임의로 연장하지 않는다.

CatBoost는 학습된 최대 horizon(기본 7일)을 초과하면 오류를 반환한다. 1/3일은 재학습 없이 가능하며 14일 같은 확장은 그 horizon으로 재학습·평가해야 한다. 신메뉴 수요, 프로모션 인과효과, 예측 구간, 발주량과 실매장 절감 효과는 검증하지 않았다. 모든 인터페이스는 팀 미승인 제안이다.
