# Mission 02B 로컬 재현 명령

STATUS: PROPOSED — NOT TEAM APPROVED

실행 위치는 `/Users/sanghyun/data_cry`다. 원본 제공 데이터와 기존 `.venv`를 사용한다.
정확한 실행 환경은 [environment.json](/Users/sanghyun/data_cry/mission02b/runs/main/environment.json)에 저장했다.
원본 파일, 기존 코드·모델·테스트·보고서를 수정하거나 업로드하지 않는다.

## 완료된 결과 확인

```bash
cd /Users/sanghyun/data_cry
.venv/bin/python -m mission02b.verify
```

독립 산술 검증과 보존 검증만 실행한다. 학습·모델 선정·Holdout 재평가를 하지 않는다.
최종 보고서는 [MISSION02B_FINAL_REPORT.md](/Users/sanghyun/data_cry/mission02b/MISSION02B_FINAL_REPORT.md)에 있다.

## 고정 설정 재현

`main` 실행 디렉터리는 이미 완료되어 덮어쓰기를 거부한다. 다른 이름의 **새 경로**에서 아래 순서대로 실행한다.
이는 이미 고정된 실험을 재현하는 명령이며, Holdout을 다시 본 후 설정을 조정하는 절차가 아니다.
재현 결과도 새로운 독립 Test가 되지 않는다.

```bash
.venv/bin/python -m mission02b.run dev --output mission02b/runs/repro_fixed
.venv/bin/python -m mission02b.run conditional --output mission02b/runs/repro_fixed
.venv/bin/python -m mission02b.run select --output mission02b/runs/repro_fixed
.venv/bin/python -m mission02b.run holdout --output mission02b/runs/repro_fixed
```

`dev`는 A~C의 9개 설정×2 Fold를 학습하고 `initial/`에 평가한다.
`conditional`은 A~C 점수만으로 사전 조건을 확인하며, 조건이 거짓이면 D1/D2 성능 실험을 생략한다.
이번 실행은 둘 다 생략됐고 최종 개발 평가표는 `validation/`에 있다.
`select`는 프로토콜과 모델/평가 코드 SHA-256을 고정한다.
`holdout`은 동일 실행 폴더에서 한 번만 허용되며, 코드/선정 기록이 달라지면 거부한다.
실패한 실행을 결과를 보고 임의로 재개하거나 marker를 삭제하지 않는다.

모델이 개선됐다는 판정은 두 Fold 메뉴 WAPE 개선 및 평균 0.50%p 이상 개선과 보조 기준 모두를 요구한다.
이번 결과는 채택 후보 없음, 기존122 유지다. `selection.json`의 `selected=A0_RMSE`는
실험 기준선 유지라는 뜻이며 기존 배포 모델을 A0(400)로 교체한다는 뜻이 아니다.
`nominated=A1_MAE`는 고정 Holdout 비교를 위한 연구 후보다.

## 저장된 실험 모델을 독립적으로 사용

모델 학습 없이 재사용한다. 아래 A1은 성능 비교용이며 기본 모델로 권장되지 않는다.

```bash
.venv/bin/python - <<'PY'
from mission02b.pipeline import predict_demand
from forecast.adapters import save_forecast

result = predict_demand(
    "2026-09-24", forecast_days=7, store_ids=["S01", "S02", "S03"],
    demand_multiplier=1.0,
    artifact_dir="mission02b/runs/main/models/holdout/A1_MAE",
)
print(result.metadata)
print(result.menus.head())
print(result.ingredients.head())
save_forecast(result, "mission02b/demo_mae")
PY
```

`forecast_days`는 1~7, 기준일은 Asia/Seoul 시작 시각이다. 제공 달력은 2026-09-30까지다.
실제 현재일 이후 운용하려면 전일까지 판매와 대상일까지의 일정이 필요하며 자동 연장하지 않는다.
`demand_multiplier`는 사용자가 정한 선형 시나리오이지 학습한 인과효과가 아니다.
추론 함수는 파일을 저장하지 않으며 저장은 기존 Adapter를 명시적으로 호출한다.

## 테스트

```bash
.venv/bin/python -m pytest -q -o cache_dir=mission02b/audit/pytest_cache
.venv/bin/python -m pytest tests mission02a/tests mission02b/tests \
  -p mission02b.test_support -q -o cache_dir=mission02b/audit/pytest_cache
```

첫 명령은 프로젝트 기본 설정에 따라 Mission01의 31개 테스트를 실행한다.
두 번째는 Mission01 31개 + Mission02A 13개 + Mission02B 26개, 총 70개를 실행한다.
`mission02b.test_support`는 기존 Mission02A 테스트 하나의 보존 검증 출력만 임시 경로로 보낸다.
기존 테스트 파일·계산·단언은 변경하지 않는다. 이 플러그인을 빼면 해당 기존 테스트가 원래 JSON을 덮어쓴다.

## 기존 실제 제공 데이터 파이프라인 재현

완료 실행은 아래 명령으로 수행했으며 `mission02b/reproduction`에 저장했다.

```bash
.venv/bin/python -m mission02b.reproduce
```

기존 디렉터리가 있으면 덮어쓰기를 거부한다. 반복 재현이 필요하면 별도 새 작업 경로에서
원래 `.venv/bin/python -m forecast --data-dir <원본 data 절대경로> all`을 실행하고,
`PYTHONPATH=/Users/sanghyun/data_cry/src`를 지정한다. 원래 작업 폴더에서 `forecast all`을
바로 실행하면 기존 산출물을 덮어쓰므로 그렇게 실행하지 않는다.

## 파일 위치

- [실행·선정 코드](/Users/sanghyun/data_cry/mission02b/run.py)
- [Validation 비교표](/Users/sanghyun/data_cry/mission02b/runs/main/validation_comparison.csv)
- [Feature Ablation](/Users/sanghyun/data_cry/mission02b/runs/main/feature_ablation.csv)
- [선정 기록](/Users/sanghyun/data_cry/mission02b/runs/main/selection.json)
- [조건부 실험 판정](/Users/sanghyun/data_cry/mission02b/runs/main/conditional_decision.json)
- [전체 테스트 로그](/Users/sanghyun/data_cry/mission02b/audit/all_tests.log)
- [독립 검증](/Users/sanghyun/data_cry/mission02b/audit/verification.json)

`runs/main/{validation/A,validation/B,holdout}/`에는 메뉴 세분화 지표, 식자재 일간/커버 지표,
오류 성분 및 압축된 행별 예측이 있다. `models/`에는 CatBoost와 metadata가 있다.
이 데이터·모델·행별 출력은 로컬 전용이며 Push·배포하지 않는다.
