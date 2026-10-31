STATUS: PROPOSED — NOT TEAM APPROVED

# 팀 통합을 위한 데이터 계약 제안

이 문서는 독립 개발한 수요예측 MVP의 현재 내부 형식과 추천안을 기록한다. Part 1·3·4와 합의된 규격, 운영 API 또는 통합 완료 선언이 아니다. 날짜·컬럼·전달 방식은 협의 후 Adapter에서 바꿀 수 있다.

## 현재 생성 가능한 데이터

기준 시점은 한국시간 `as_of_date` 영업 전이며 판매 데이터는 `date < as_of_date`만 관측 가능하다. `target_date`는 예측 대상 영업일이다. 기본 7일은 기준일 당일을 포함한다. 예를 들어 2026-09-24 입력은 09-24~09-30이다.

현재 Python 반환형 `ForecastResult`는 `menus: DataFrame`, `ingredients: DataFrame`, `metadata: dict`이다. 함수 실행 중 CSV를 쓰지 않으며 `save_forecast()`가 별도 저장한다. 모델 학습 코드는 출력 컬럼명 변환에 의존하지 않는다.

| 메뉴 필드 | 현재 자료형 | 의미 / 단위 |
|---|---|---|
| as_of_date | datetime64[ns] | 한국시간 기준일, 시각 없는 날짜 |
| target_date | datetime64[ns] | 대상 영업일, 기준일 포함 |
| store_id | str | 제공 매장 식별자 |
| menu_id | str | 제공 메뉴 식별자; 세트를 별도 메뉴로 유지 |
| horizon | int | target_date − as_of_date의 일수, 기본 0~6 |
| is_available | int 0/1 | 대상일 취급 일정; 미취급은 예측 0 |
| pred_demand_qty | float | 품절이 없다면 들어올 메뉴 주문 수량의 점예측; 소수 기대값 |
| cancel_rate | float 0~1 | 기준일 이전 최근 56일 sum(cancel_qty)/sum(qty), fallback 적용 |
| pred_net_qty | float | pred_demand_qty × (1−cancel_rate), 전 수요 충족 가정의 판매 확정 수량 |

메뉴 키: `(as_of_date, target_date, store_id, menu_id)`. 현재 모든 매장×메뉴를 출력해 미취급을 명시한다. 학습·평가는 취급 대상만 포함한다. 원천 데이터가 없는 미취급 target의 실제 수요를 0 정답으로 간주하지 않는다.

| 식자재 필드 | 현재 자료형 | 의미 / 단위 |
|---|---|---|
| as_of_date, target_date, store_id | 위와 같음 | 기준일·대상일·매장 |
| ingredient_id | str | 제공 식자재 식별자 |
| pred_use_qty | float | sum(pred_net_qty × qty_per_menu); 발주량이 아닌 예상 사용량 |
| use_unit | str | 제공 BOM/식자재 마스터의 사용 단위(개/g/ml/매/캔/장) |

식자재 키: `(as_of_date, target_date, store_id, ingredient_id, use_unit)`. 동일 품목·단위 안에서만 합산한다. 세트 구성품을 재전개하지 않는다. 정수 포장단위 반올림, 재고 차감, 입고 일정, 폐기·안전재고는 포함하지 않는다.

메타데이터에는 모델명, 학습/선정 target의 최대 날짜, 실제 판매 이력 마지막 날짜, horizon 수, Feature 목록, seed, 버전, 기준 시점 규칙, 취소율 기간, multiplier, 적용 가정을 제공한다. 평가 점수는 별도 `metrics.csv`와 `summary.json`이다. 현재 예측 구간·분산은 제공하지 않는다.

## 입력 제안

현재는 제공 17개 CSV를 로컬 로더로 읽는다. 예측 Feature에는 판매·메뉴·매장 식별자·달력·프로모션·취급 일정만 사용하며 BOM/식자재 마스터는 소요량 환산에 사용한다. 재고·발주·로트·당일 품절은 Feature에 사용하지 않는다. 감사 목적으로 17개를 전부 읽는 현재 로더는 팀 데이터 소스와 분리 가능하다.

최소 향후 데이터 의미는 유지할 것을 제안한다: 일별 집계 전 `demand_qty/qty/cancel_qty/lost_qty` 정의, 매장/메뉴 ID, 메뉴 취급 일정, 날짜별 공휴일, 기간과 실제 대상 메뉴가 구분된 행사 일정, 메뉴 자체 BOM와 식자재 use_unit. Part 1이 일별 데이터를 공급한다면 합계·키·미취급 처리에 대해 별도 합의가 필요하다.

```python
from forecast import predict_demand

result = predict_demand(
    as_of_date="2026-09-24", forecast_days=7,
    store_ids=["S01"], demand_multiplier=1.10,
    artifact_dir="models/evaluated",
)
menu_df = result.menus
ingredient_df = result.ingredients
```

이 호출은 잠정 내부 함수이며 외부 HTTP API를 확정하지 않는다. 주입된 데이터와 저장 모형으로 `Predictor`를 재사용하면 Streamlit 이벤트마다 모델을 다시 학습할 필요가 없다. 라이브러리는 Streamlit을 import하지 않는다.

## Part 3 / Part 4 연결 추천

- Part 3에는 일별 매장·식자재별 `pred_use_qty/use_unit`을 기본 입력으로 전달하고, 주문 커버 기간 합산·재고·입고·사용기한·포장 반올림·불확실성 정책은 발주 최적화 쪽에서 결정하도록 제안한다.
- Part 4에는 메뉴 예측과 식자재 소요량 및 메타데이터를 함께 제공해 잠재 수요/예상 확정량/발주량을 구분해서 표시하도록 제안한다. multiplier 변경 시 예측 수요→예상 확정량→BOM을 다시 계산하며 모델 재학습은 필요 없다.
- 같은 Python 프로세스에서는 DataFrame을 우선 제안한다. 별도 프로세스/오프라인 검토에는 현재 CSV Adapter를 사용할 수 있다. JSON/HTTP 서버는 합의 전 구현하지 않았다.
- 입력 오류, 데이터 최신성 부족, 달력 밖 날짜, 학습 horizon 초과, 기준일 이후 정답을 학습/선정에 쓴 모델은 명시적 ValueError로 실패한다. 서비스 오류 표현은 Part 4와 협의한다.

## 반드시 협의할 항목

| 항목 | 추천안 | 추천 이유 | 상태 |
|---|---|---|---|
| 1. 1/3/7일 예측 | 일별 7일을 기본으로 1/3일 부분 선택 | 공급사별 커버 기간에 맞게 일별 예측을 재사용; 현재 CatBoost는 학습한 최대 horizon 안에서 변경 가능 | 미합의 |
| 2. 기준 시점 | 한국시간 영업 시작 전, 전일까지 마감 판매 사용 | 관측 가능 경계가 명확하고 당일 누수를 차단 | 미합의 |
| 3. 전달 데이터 | 메뉴·식자재 둘 다 제공; Part 3은 식자재 중심 | UI 설명과 발주 입력을 모두 충족 | 미합의 |
| 4. 발주 계산 기준 | 품절 없는 전 수요 충족 가정의 예상 판매 확정량으로 BOM 계산 | 잠재 수요를 유지하면서 취소 반영; qty 기반 취소율 가정은 팀 검토 필요 | 미합의 |
| 5. 전달 방식 | 동일 Python은 DataFrame, 경계가 생기면 CSV/JSON Adapter | 재학습 코드와 외부 표현을 분리하고 불필요한 서버 구현 방지 | 미합의 |
| 6. 일별/커버 기간 | 일별로 전달, Part 3에서 기간 합산 | 공급사·발주일·소비기한마다 커버 기간이 다름 | 미합의 |
| 7. UI 변동률 | 고정 모델 수요에 multiplier 적용 후 확정량·BOM·발주 추천 갱신 | 사용자 가정의 선형 영향; 모델의 인과 프로모션 효과로 오인 방지 | 미합의 |
| 8. 최신성/업데이트 | 전일 마감 확인 후 판매와 향후 일정 스냅샷 교체; 모형 재학습 주기는 별도 결정 | 현재 추론은 전일 판매 존재를 요구; 일정 공지 시점과 데이터 버전을 추적해야 함 | 미합의 |
| 9. 오차/불확실성 | horizon·매장·메뉴별 오차를 전달하고 Part 3에서 안전재고 정책 결정; 이후 quantile 검토 | 점예측만으로 서비스 수준을 보장할 수 없으며 Test를 안전재고 튜닝에 재사용하면 편향 발생 | 미합의 |

## 합의 후 변경 지점

- 컬럼명/형식/날짜 문자열화/미취급 출력 정책: `adapters.py` 또는 새 외부 Adapter.
- 데이터 공급: `data.py` 로더와 Part 1 집계 입력 Adapter.
- 예측 시점·최대 horizon·일정 가용성 가정 변경: Feature 생성 및 재학습/시간 평가까지 다시 검증.
- 판매 확정량 대신 다른 발주 기준을 정하면 `pipeline.py` 취소율/BOM 변환 정책과 문서 수정.
- Part 3의 재고·발주 포장 계산, Part 4의 UI는 미수정·미통합이다. 상대 팀의 승인이 없어도 현재 CLI/Python은 독립 실행된다.
