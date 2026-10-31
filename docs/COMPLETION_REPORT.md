# Mission 01 완료 보고

## 1. 개발 완료 상태

**COMPLETE** — 제공 데이터 기반 감사·모델링·시간 평가·저장 모형 재사용·7일 예측·취소율/BOM 환산·자동 테스트·통합 제안서를 실제 구현하고 실행했다. 팀 계약 승인과 Streamlit 통합은 요청한 완료 범위에 포함되지 않는다.

## 2. 데이터 감사 결과

- 원본 17개 CSV 검사: 3개 매장, 16개 메뉴, 22개 식자재, 2026-01-01~09-30. 판매 98,910행, BOM 105행, 달력 273행. 파일별 모든 행 수/컬럼/dtype/결측/중복은 DATA_AUDIT.md와 outputs/audit/audit.json에 기록했다.
- 판매 qty=demand−lost, 취소 후 확정량, BOM 소진량/재고 consumed_qty, 재고 수지, 행사 기간 flag 검증 오류는 0건. 검증한 식별자 외래키/행 키 중복 위반도 0건.
- 전체 일별 패널 13,104행 중 취급 12,051행, 미취급 1,053행. 취급 중 판매가 없는 1,155일은 0 수요로 보충하고 미취급은 NaN target으로 학습/평가에서 제외한다.
- holiday_name 257개, 단품 set_components 11개, S02/M015 전체 미취급의 시작/종료일 각 1개 결측은 의미에 맞게 허용했다. 원본을 삭제·보정하지 않았다.
- 잠재 수요 208,758개, accepted qty 208,684개, 품절 손실 74개, 취소 1,290개, 판매 확정량 207,394개. 합성 데이터 집계이며 실제 매장의 성과가 아니다.
- 원본 CSV/제공 문서 SHA-256 보존 검사 통과. 시작 시 Git 저장소가 없어 기존 추적 파일도 없었다. 원본 CSV/PDF와 모델/결과 21개 경로를 임시 Git 저장소에서 check-ignore로 확인했고 모두 제외된다. 작업 폴더에는 Git 초기화/push/배포를 하지 않았다.

## 3. 모델링 결과

영업 시작 전 origin마다 과거 기록을 고정한 direct horizon 0~6 모델이다. 28일 warmup 후 1~6월 target으로 학습, 7월 검증으로 모델/tree 수를 선택하고 Test용 CatBoost를 7월 말까지 재학습했다. 8~9월 61개 일별 origin의 rolling backtest에서 Test 정답은 학습·선정에 사용하지 않았다. 같은 target이 여러 origin/horizon에 등장하는 예측 사례 기준 지표다.

| 구간 | 모델 | 사례 수 | MAE | WAPE | Bias |
|---|---|---:|---:|---:|---:|
| Validation | Baseline | 9,212 | 4.7697 | 28.95% | −0.28% |
| Validation | CatBoost | 9,212 | 4.3560 | 26.44% | +0.15% |
| Test | Baseline | 18,270 | 5.0113 | 28.74% | −2.06% |
| Test | CatBoost | 18,270 | 4.6031 | 26.40% | −2.49% |

**최종 모델 CatBoost**, 선정 근거는 7월 WAPE 개선이다. 초기 400회에서 조기종료 후 122 trees를 선택했다. Test WAPE는 Baseline 대비 2.34%p 낮았다. 다만 Bias는 CatBoost 쪽이 더 음수이므로 과소예측 경향을 발주 정책에서 별도 고려해야 한다. Validation은 tree 수 튜닝에 사용돼 독립적인 성능 추정치가 아니다. horizon·매장·메뉴·월별 결과는 MODEL_EVALUATION.md와 outputs/evaluation/metrics.csv에 있다.

## 4. 실제 7일 예측 결과

2026-09-24 영업 전 → 09-24~09-30. 모델 학습 정답의 마지막 날짜는 07-31이며 판매 Feature/취소율은 09-23까지만 사용한다. 메뉴 336행(취급 예측 315행, 미취급 0 예측 21행), 식자재 462행을 생성했다. 취급 메뉴 데모 MAE 4.4321, WAPE 26.56%, Bias +1.01%.

| 매장 | 7일 예측 잠재 수요 | 실제 잠재 수요 | 예상 판매 확정량 |
|---|---:|---:|---:|
| S01 | 2,709.90 | 2,689 | 2,693.93 |
| S02 | 1,464.76 | 1,436 | 1,454.02 |
| S03 | 1,135.49 | 1,132 | 1,128.84 |

S01의 7일 식자재 소요량 예시: 소고기 패티 3,394.07개, 버거 번 2,290.13개, 냉동 감자 335,555.95g. 각 식자재/단위별로 계산하며 서로 다른 품목의 사용량을 합산하지 않았다. 소수는 기대 사용량이다.

최근 56일 accepted qty 대비 취소율을 적용하고, 품절 없이 전 수요를 충족한다는 가정으로 메뉴 자체 BOM을 연결했다. 세트는 세트 BOM만 사용한다. 이 값은 발주 최적화의 입력이며 포장단위 반올림/재고 차감/안전재고를 적용한 발주량은 아니다.

전체 결과: outputs/demo/menu_forecast.csv, menu_actual_comparison.csv, ingredient_forecast.csv, forecast_metadata.json. 자세한 예시는 DEMO_RESULTS.md.

## 5. 개발 산출물과 실행

- src/forecast/data.py: 읽기 전용 로더, 검증, 취급/0 수요 일별 패널.
- src/forecast/features.py: 기준일 이전 이력의 평균·동일 요일·추세·매장 추세, 행사/공휴일/취급 Feature.
- src/forecast/model.py: 글로벌 CatBoost 학습/저장/재사용, 학습·선정 정답 상한 검사.
- src/forecast/evaluation.py: 시간 분할, 일별 origin backtest, 평가/선정 및 그림.
- src/forecast/pipeline.py: 예측 함수, 취소율, 메뉴/식자재 출력.
- src/forecast/adapters.py: 모델 코드와 분리된 CSV 저장.
- src/forecast/cli.py: audit/evaluate/train/predict/demo/all 독립 실행 명령.
- models/evaluated/catboost/: 실제 저장한 Test/데모용 모형.
- tests/: 필수 행동/누수/CLI 검증. requirements.lock.txt: 실제 버전 고정.

```bash
.venv/bin/python -m forecast all
.venv/bin/python -m pytest -q
.venv/bin/python -m forecast predict --as-of-date 2026-09-24 --forecast-days 7
```

```python
from forecast import predict_demand

result = predict_demand("2026-09-24", forecast_days=7)
menu_df, ingredient_df = result.menus, result.ingredients
```

환경 재구성, 매장 선택/수요 시나리오, 별도 재학습 예시는 RUN_GUIDE.md에 있다. Python 함수 자체는 CSV를 저장하지 않으며 저장은 별도 Adapter로 호출한다.

## 6. 검증 결과

**31 PASS, 0 FAIL, 0 SKIP**, 최종 실행 5.93초, 경고 없음. 테스트 원본: tests/test_forecast.py; 실행 증거: outputs/tests/junit.xml, outputs/tests/pytest.log.

검증 범위: 판매 관계식, 취급 중 0/미취급 NaN, 신메뉴 fallback, 프로모션 구분, 7일 정상 출력, 음수/결측/유효값, 취소율 분모/fallback, 세트 BOM 1회/단위 보존, 저장·재사용 일치, 실제 CSV, 독립 train/predict CLI, 평가 파일과 보고 지표의 일치, 원본 해시.

09-24 이후 판매를 11배로 바꿔도 Feature·Baseline/CatBoost 메뉴 예측·취소율·식자재 소요량은 완전히 동일했다. 최종 저장 모형에도 동일 변조 검증을 수행했다. 미래 정답을 학습 또는 모델 선정에 쓴 artifact는 기준일 예측을 거부한다. 독립 train CLI의 정답 상한도 실제 확인했다.

Python 3.12.14 / pandas 2.3.3 / NumPy 2.3.5 / CatBoost 1.2.10, seed=42, CPU threads=4. pandas와 최신 NumPy의 호환성 경고를 발견해 NumPy<2.4로 제한하고 재학습·재평가했다. 수치는 재실행 시 동일했다. 운영체제/라이브러리 변경 시 비트 단위 일치는 보장하지 않는다.

## 7. 팀 통합 준비

PROPOSED_DATA_CONTRACT.md 첫 줄은 `STATUS: PROPOSED — NOT TEAM APPROVED`다. 현재 내부 반환은 ForecastResult(menus, ingredients, metadata)이며 일별 메뉴 수요/예상 확정량과 일별 식자재 소요량을 동시에 제공한다. 동일 Python 프로세스에서는 DataFrame, 파일 교환은 별도 CSV Adapter를 추천했다.

예측 기간, 기준 시점, 메뉴/식자재 전달 범위, 발주 계산 기준, CSV/DataFrame/JSON, 일별/커버 기간 합계, UI multiplier 재계산 범위, 데이터 최신성과 업데이트, 불확실성/안전재고의 9개 항목마다 추천안·이유·미합의 상태를 기록했다.

합의 후 출력 컬럼/직렬화는 Adapter, Part 1 데이터 공급은 로더/입력 Adapter에서 변경한다. 기준 시점·horizon·판매 확정량 정책이 바뀌면 Feature/변환 및 평가를 다시 검증한다. 타 팀 소스코드는 존재하지 않았고 수정하지 않았다. Part 3 최적화나 Part 4 UI와의 실제 통합을 임의로 확정하지 않았다.

## 8. 남은 문제 및 개선 방향

현재 미해결 실행 오류는 없다. 다음은 데이터/검증 범위의 한계다.

1. 판매·달력·취급 일정은 09-30까지다. 실제 현재 시점 이후 예측에는 전일까지 마감된 완전한 판매 데이터와 향후 일정이 필요하다. 범위 밖 날짜를 임의 보충하지 않는다.
2. 행사 1건으로 인과효과를 추정할 수 없다. 미래 일정이 기준일에 알려졌는지는 공지 시점 기록이 없어 가정으로 남는다.
3. 신메뉴·패턴 변화·실매장 잠재 수요 관측 가능성에 대한 추가 검증이 필요하다.
4. 점예측을 제공하며 예측 구간/서비스 수준/안전재고는 미구현이다. 다음 우선순위는 팀의 기준 시점·입력 의미 합의, 최신 데이터 스냅샷, 독립 구간의 quantile/잔차 보정 평가다.
5. 타 팀 코드·실매장 운영·Streamlit·배포와 연동한 성능은 검증하지 않았다. 원본 재배포나 유료 API 사용은 없다.
