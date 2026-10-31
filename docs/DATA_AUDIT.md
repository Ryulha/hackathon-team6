# 데이터 감사

근거: 제공 `데이터명세서.md`와 실제 CSV 17개. 합성 데이터이며 실제 매장 성과가 아니다.

날짜: 2026-01-01 ~ 2026-09-30; 매장 3, 메뉴 16, 식자재 22.

Git: 시작 시 저장소가 없었으므로 추적된 원본도 없음. 원격 push/배포 미수행. .gitignore에 원본 폴더, CSV, PDF, outputs, models 제외.

## 개별 파일 검사

| 파일 | 행 | 컬럼 | 전체행 중복 | 키 중복 | 결측 컬럼(개수) |
|---|---:|---:|---:|---:|---|
| 01_stores.csv | 3 | 9 | 0 | 0 | 없음 |
| 02_menus.csv | 16 | 6 | 0 | 0 | set_components(11) |
| 03_ingredients.csv | 22 | 9 | 0 | 0 | 없음 |
| 04_bom.csv | 105 | 4 | 0 | 0 | 없음 |
| 05_suppliers.csv | 2 | 8 | 0 | 0 | 없음 |
| 06_ingredient_price_history.csv | 38 | 3 | 0 | 0 | 없음 |
| 07_calendar.csv | 273 | 4 | 0 | 0 | holiday_name(257) |
| 08_promotions.csv | 1 | 6 | 0 | 0 | 없음 |
| 09_sales.csv | 98,910 | 11 | 0 | 0 | 없음 |
| 10_inventory_daily.csv | 18,018 | 19 | 0 | 0 | 없음 |
| 11_purchase_orders.csv | 7,284 | 13 | 0 | 0 | 없음 |
| 12_receipts.csv | 7,259 | 11 | 0 | 0 | 없음 |
| 13_waste.csv | 647 | 7 | 0 | 이벤트; 키 미지정 | 없음 |
| 14_transfers.csv | 81 | 9 | 0 | 0 | 없음 |
| 15_menu_availability.csv | 48 | 6 | 0 | 0 | start_date(1), end_date(1) |
| 16_inventory_lots_daily.csv | 26,615 | 8 | 0 | 0 | 없음 |
| 17_stockouts.csv | 15 | 6 | 0 | 0 | 없음 |

컬럼별 자료형·결측 수·키 전체는 `outputs/audit/audit.json`에 보존한다.

## 수량·관계 검증

- `qty_identity_errors`: 0
- `negative_net_qty_rows`: 0
- `bom_consumption_errors`: 0
- `inventory_balance_errors`: 0
- `promo_period_flag_errors`: 0
- `receipt_unknown_po_line`: 0
- `inactive_panel_days`: 1,053
- `active_panel_days`: 12,051
- `active_zero_demand_days`: 1,155
- `active_days_without_sales_rows`: 1,155
- `demand_qty_total`: 208,758
- `accepted_qty_total`: 208,684
- `lost_qty_total`: 74
- `cancel_qty_total`: 1,290
- `net_qty_total`: 207,394

매장/메뉴/식자재/공급사 외래키, 판매 키, 취급 구간 중첩, 취급 외 판매, 달력 연속성, BOM 단위·양수량·메뉴 커버리지 모두 로더에서 검증하며 위반 시 중단한다.
영수증 연결은 po_line_id를 확인했다. 발주·로트의 생성 정책 전체 재생은 본 예측 범위에 포함하지 않는다.

## 전처리 정책과 근거

- Target = 시간대·채널별 demand_qty의 일별 합. qty = demand_qty − lost_qty, 판매 확정량 = qty − cancel_qty. 확정량 × 메뉴 자체 BOM을 재고 consumed_qty와 비교했다.
- 3×16×273 전체 일별 패널에서 취급 중 판매 행이 없는 날만 0으로 보충한다. 미취급 기간은 demand_qty=NaN으로 유지하고 학습/평가에서 제외한다. 추론에는 is_available=0 및 0 예측을 명시한다.
- 각 메뉴의 취급 기간을 그대로 사용한다. M007의 취급 시점을 M008에 전파하지 않는다. 취급 달력은 미래에 이미 알려진 일정이라고 가정한다.
- 세트는 04_bom의 세트 BOM만 1회 연결한다. set_components를 펼치지 않는다. ingredient_id × use_unit별 합계만 생성하며 다른 품목·단위의 총합은 계산하지 않는다.
- 행사 기간 표시와 실제 대상 메뉴는 별도 Feature. P01은 S02, 2026-07-07~07-31, M004/M005. 1개 행사뿐이며 학습 기간 1~6월에는 사례가 없어 효과 추정/인과 해석을 하지 않는다.
- 비어 있는 holiday_name은 공휴일 아님, set_components는 단품에 해당 없음으로 문서 정의에 따라 허용한다. S02/M015는 전체 미취급이며 start_date/end_date가 모두 비어 있다. 이를 잘못된 날짜로 삭제하거나 0 수요로 학습하지 않는다. 취급 상태의 날짜 누락은 오류로 처리한다.
- 학습은 28일 이력 확보 후 2026-01-29부터 시작. Target 기준 Train ≤06-30, Validation 07-01~07-31, Test 08-01~09-30. 원본의 1월 초기재고 미래 참조 문제를 피하도록 재고/로트/발주/당일 품절 필드를 Feature에 사용하지 않는다.

## 개발자가 추가한 가정 / 한계

- 기준 시점은 한국시간 영업 시작 전 00:00 경계. 당일 판매는 전부 미관측으로 취급한다.
- 공휴일·행사·취급 일정은 기준 시점에 알려졌다고 가정하지만 공지 시점 이력이 없어 사실상 검증할 수 없다. 미래 운영 일정 변경 시 입력 스냅샷 관리가 필요하다.
- 최근 56일 취소율은 sum(cancel_qty)/sum(qty). 매장·메뉴 분모 0이면 메뉴 전체 → 전체 → 0 순 fallback. 전 수요 충족 시에도 같은 취소율이라는 가정을 사용한다.
- 제공 달력/취급 일정은 9월 30일까지다. 범위 밖 예측은 임의 공휴일/취급 가정 대신 오류를 반환한다. 이후 예측은 새 일정과 최신 판매를 공급해야 한다.
- 명세에 알려진 발주 경계 2건, 로트 전개 3건은 원본을 보정하지 않는다. 본 모델에 해당 데이터를 사용하지 않는다.
- 원본 파일은 변경하지 않는다. `outputs/audit/source_manifest.json`의 SHA-256으로 완료 시 다시 검증한다.
