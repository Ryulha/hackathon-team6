# Mission 02B 팀 통합 제안

STATUS: PROPOSED — NOT TEAM APPROVED

이번 실험에서 기본 모델 교체를 권장하지 않는다. 기존 `forecast.predict_demand`와
`forecast.pipeline.ForecastResult`는 변경하지 않았고, 기존122 모델을 유지한다.

실험 호출은 `mission02b.pipeline.predict_demand(..., artifact_dir=...)`로 분리했다.
반환값은 기존 `ForecastResult(menus, ingredients, metadata)`다.

| 항목 | 잠정 규칙 |
| --- | --- |
| origin | Asia/Seoul 당일 시작; 판매 날짜 < origin |
| horizon | 당일 포함 1~7일; 제공 달력 밖 요청 거부 |
| menus | 기존 키, is_available, horizon, pred_demand_qty, cancel_rate, pred_net_qty |
| ingredients | 날짜·매장·ingredient_id·use_unit별 pred_use_qty |
| unavailable | 출력에는 남기되 예측은 0; 평가에서는 제외 |
| active zero | 학습·평가에서 보존 |
| BOM | 각 메뉴/세트의 BOM 한 번; 발주단위 변환·포장 반올림 없음 |
| cancellation | origin 이전 56일 accepted qty 기준; 기존 fallback 유지 |
| metadata | 팀 미승인 상태, 모델/Feature/학습 상한, 시나리오, 무품절 가정 |
| scenario | 비음수 유한 multiplier; 메뉴 및 식자재에 선형 반영 |
| persistence | 모델별 cbm + schema metadata; 로컬 전용, 저장 시 기존 경로 덮어쓰기 거부 |
| correction | 실험 D2를 사용한다면 동일 fitted model의 OOS base 예측 residual_bank를 명시해야 함; 이번에는 미선정 |

승인 전 기존 기본 모델 경로, 데이터 계약, 다른 팀원의 모듈을 바꾸지 않는다.
통합 검토 시 잠재수요의 실매장 관측 방법, 일정의 사전 가용성, 취소율의 무품절 전이 가정을
확인해야 한다. 여기서 예측된 식자재 소요량은 발주량이나 비용 절감액이 아니다.
