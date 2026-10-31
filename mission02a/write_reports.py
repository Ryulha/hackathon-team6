"""Generate local diagnostic reports from executed outputs; no data publication."""
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import pandas as pd
from mission02a.diagnostics import ROOT,OUT,PART1

R=ROOT/'mission02a/reports'


def table(df,percent=(),decimals=2):
    headers=list(df.columns)
    lines=['| '+' | '.join(headers)+' |','|'+'|'.join(['---']*len(headers))+'|']
    for _,row in df.iterrows():
        vals=[]
        for col,v in row.items():
            if pd.isna(v):s='N/A'
            elif col in percent:s=f'{float(v):+.2%}' if 'Bias' in col else f'{float(v):.2%}'
            elif isinstance(v,float):s=f'{v:,.{decimals}f}'
            else:s=str(v)
            vals.append(s.replace('|','/'))
        lines.append('| '+' | '.join(vals)+' |')
    return '\n'.join(lines)


def put(name,text):
    (R/name).write_text(text.strip()+'\n',encoding='utf-8')


def main():
    R.mkdir(exist_ok=True)
    summary=json.loads((OUT/'summary.json').read_text())
    audit=json.loads((ROOT/'mission02a/evidence/part1_audit.json').read_text())
    names=pd.read_csv(next(ROOT.glob('*/data/03_ingredients.csv')))[['ingredient_id','ingredient_name']]
    daily=pd.read_csv(OUT/'daily_store_ingredient_metrics.csv')
    base=daily.loc[daily.split.eq('test') & daily.truth.eq('no_stockout_proxy')]
    focus=base.loc[base.model.eq('catboost') & base.ingredient_id.isin(['I009','I020','I017'])]
    macro=pd.read_csv(OUT/'daily_macro_metrics.csv')
    macro=macro.loc[macro.split.eq('test')]
    cover=pd.read_csv(OUT/'coverage_macro_metrics.csv')
    cover=cover.loc[cover.split.eq('test') & cover.origin_cohort.eq('common_7day_origins') & cover.truth.eq('no_stockout_proxy')]
    overall=pd.read_csv(OUT/'daily_ingredient_metrics.csv')
    overall=overall.loc[overall.split.eq('test') & overall.truth.eq('no_stockout_proxy') & overall.model.eq('catboost')].merge(names,on='ingredient_id')
    store=pd.read_csv(OUT/'daily_store_macro_metrics.csv')
    store=store.loc[store.split.eq('test') & store.truth.eq('no_stockout_proxy')]
    truth_table=macro[['truth','model','macro_WAPE','macro_Bias','defined_series']]
    put('00_RESULT.md',f'''# Mission 02A 운영분석 연계 수요예측 진단

**COMPLETE — 요청된 로컬 진단·재현·비교·통합 제안 완료.** 제공 자료는 합성 데이터이며 금액은 가상이다. 실제 매장 성능·절감액 검증이나 팀 통합 완료를 의미하지 않는다. GitHub 최신 버전과 운영 일정의 사전 공지 이력은 UNVERIFIED다.

Mission 01의 기존 코드·테스트·모델·산출물과 원본을 보존했다. 기존 테스트 31개 통과, 전체 원본 데이터 파이프라인의 주요 7개 출력은 바이트 단위로 재현됐다. 추가 진단을 포함한 **44개 테스트 통과**, Part 1의 관련 테스트 **10개 통과, 8개 범위 밖 제외**다. Part 1 전처리 117개 검사는 **116 PASS, 1 WARN, 0 FAIL**이며 경고는 데이터 종료 이후 도착 예정 발주 25건이다.

주된 발견은 다음과 같다.

- Test 일간 식자재 WAPE의 매장×품목 동일가중 평균은 CatBoost **33.39%**, Mission 01 Baseline **37.03%**, Part 1 엔진 **33.47%**다. 실제 소진량 기준 CatBoost는 **33.34%**다. CatBoost와 Part 1의 일간 차이는 **0.08%p**로 작고 통계적 우월성을 검증하지 않았다.
- 같은 55개 origin에서 CatBoost의 1·2·3·7일 누적 WAPE는 **33.04% → 25.39% → 21.97% → 18.14%**다. 일간 전체 61개 origin 점수와 공통 55개 origin 점수를 구별해야 한다.
- S02 식빵은 일간 WAPE **70.69%**, Bias **+17.42%**, S03 양상추는 WAPE **19.34%**, Bias **−6.33%**다. S02 코울슬로의 전체 Bias **+0.94%**는 8월 **+49.29%**와 9월 **−20.13%**를 상쇄해 변화를 숨긴다.
- 다음 실험의 우선순위는 **기존 점예측을 기준으로 한 커버 기간별 확률 예측·잔차 보정**이다. 이는 발주 판단에 필요한 부족·과잉 양쪽 불확실성을 측정하기 위한 탐색적 제안이다. 점예측 WAPE 개선이나 폐기 절감을 이미 검증했다는 뜻은 아니다.

![동일 origin의 커버 기간별 WAPE](coverage.png)

평가는 2026-08-01~09-30 Test의 고정 모형과 origin 이전 기록만 갱신한 예측을 사용한다. 기본 진단 정답은 `no_stockout_proxy`이며 실제 소진량에 품절 손실의 예상 회복분을 더한 가정값이다. 핵심 3개 품목은 Test에서 손실 회복분이 0이어서 실제 소진량과 이 가정값이 동일하다. 3개 품목은 전체 기간 사후 EDA로 선정되어 탐색적으로만 해석한다.

## 전체 22개 품목 일간 성능

같은 품목 안에서 3개 매장의 예측 사례를 모은 CatBoost 결과다. MAE와 mean_error는 각 행의 use_unit, WAPE와 Bias는 비율이다. 서로 다른 식자재의 MAE·수량을 합산하지 않는다.

{table(overall[['ingredient_id','ingredient_name','use_unit','n','MAE','mean_error','Bias','WAPE']],['Bias','WAPE'])}

## 매장별 비교

서로 다른 단위의 수량 대신 매장×품목별 WAPE/Bias의 산술평균이다. S01/S03 22개, S02 19개 유효 시계열을 포함한다. S02의 I004·I015·I016은 연결 메뉴 미취급으로 Test 전체에서 제외되며, 0점으로 평균에 넣지 않는다. 총 66개 조합을 파일에 유지하고 이 중 63개의 비율이 정의된다. BOM이 겹치는 품목도 있어 63개를 독립 표본으로 해석하지 않는다.

{table(store[['store_id','model','macro_WAPE','macro_Bias','defined_series']],['macro_WAPE','macro_Bias'])}

## 상세 결과

- [Mission 01 재현과 누수 감사](01_REPRO_LEAKAGE.md)
- [Part 1 데이터 처리·엔진 비교와 통합 위험](02_PART1_COMPARISON.md)
- [커버 기간과 핵심 품목 오차 분석](03_COVERAGE_ERRORS.md)
- [Mission 02B 실험 우선순위와 미승인 통합 제안](04_02B_INTEGRATION_PROPOSED.md)
- [전체 매장×22개 식자재 성능표](05_FULL_METRICS.md)
- [실행 명령·파일 사전·검증 근거](06_RUN_GUIDE.md)

제공 폴더의 48개 파일과 Mission 01·원본 71개 파일의 해시를 따로 기록했다. 최종 보존 검사는 [preservation_check.json](../evidence/preservation_check.json), [part1_audit.json](../evidence/part1_audit.json)에 있다. 원본·모델·파생 상세 데이터의 push·배포·외부 전송은 수행하지 않았다.
''')
    s=summary['mission01'];scores=[]
    for split in ['validation','test']:
        for model in ['baseline','catboost']:scores.append({'split':split,'model':model,**s[split][model]})
    put('01_REPRO_LEAKAGE.md',f'''# Mission 01 재현과 누수 감사

**재현 PASS, 판매 이력의 미래 의존성 검사 PASS. 운영 일정의 사전 관측 가능성은 조건부이며 UNVERIFIED.** 원본 데이터와 Mission 01을 수정하지 않았다. 기존 CLI의 `all`은 문서와 모델 경로를 덮어쓰므로 별도 작업 디렉터리 `mission02a/reproduction/`에서 원래 코드를 호출했다. 신규 모델 실험은 없고 동일 설정의 재현 학습만 수행했다.

## 재현 결과

{table(pd.DataFrame(scores)[['split','model','n','MAE','WAPE','Bias']],['WAPE','Bias'],4)}

선정 모델 CatBoost, **122 trees**, Train 46,480행, Validation 9,212행, Test 18,270행, Test 재학습 56,679행을 재현했다. 모델링 데이터 75,894행, 백테스트 예측 27,482행, metrics 114행, summary JSON, 데모 메뉴 336행, 식자재 462행, 메뉴 실제 비교 336행이 모두 원래 파일과 바이트 단위로 일치한다. 모형 바이너리의 생성 메타데이터는 실행마다 달라질 수 있어 신규 바이너리의 byte equality를 성능 재현 조건으로 사용하지 않았다. **기존 저장 모형의 바이트는 해시로 보존**했다.

## 기준 시점과 분할

- origin은 Asia/Seoul 해당 날짜 **00:00**. 판매 `date < origin`만 이력으로 사용한다. horizon=0은 당일이다.
- 28일 warmup, target 날짜 기준 Train ≤06-30, Validation 07-01~07-31, Test 08-01~09-30. split 시작 이전 origin 제외, split 끝을 넘는 target 제외.
- 7월로 tree 수와 모델을 선택한 뒤 7월 말까지 다시 학습한다. 8~9월의 정답은 학습·조기종료·모델선정에 쓰지 않았다.
- **Validation은 튜닝 점수**다. 7월 전체를 보고 조기종료 tree 수를 선택하므로 7월 origin의 완전한 실시간 배치 성능으로 주장하지 않는다. 기존 validation 코드가 provenance 검사를 우회해 estimator로 평가하는 이유도 이 때문이다.
- Test는 이미 공개된 진단 자료다. 이번 탐색 이후 새 실험의 독립 Test로 반복 활용할 수 없다.

## 누수와 의미 감사

| 항목 | 확인 결과 | 판정·영향 |
|---|---|---|
| 판매 지연 Feature | 최근 7/14/28일 평균, 동일 요일 4회, 추세 모두 날짜 < origin | PASS |
| 취소율 | origin 이전 56일 sum(cancel)/sum(qty), 매장·메뉴→메뉴→전체 fallback | PASS; 품절 손실에는 같은 취소율을 가정 |
| 미래 판매 변조 | 08-01·08-31·09-24 이후 판매 19배 및 운영 이력 제거에도 저장 CatBoost 예측·BOM 불변 | PASS; 기존 09-24의 11배 변조 테스트도 보존 |
| 모델 가중치·선정 | Test artifact의 train/selection target max=07-31, 이후 정답 artifact는 origin 검사로 거부 | PASS |
| 원본 당일 재고 평균 | avg_consumption_7d는 당일 포함 | 사용하지 않음; 모델에 연결하면 누수 |
| 07시 입고·실사 | 현재 날짜 received/adjust/counted는 00시에는 미관측 | 사용하지 않음; Part 1과 시점 합의 필요 |
| 당일 마감·품절·로트·폐기 | 마감 후 값 | 정답·사후 진단에만 사용 |
| 초기재고 | 첫 7일 미래 수요로 생성된 합성 초기 상태 | 재고 Feature를 쓰지 않고 28일 warmup 사용 |
| 1~9월 EDA | 품목 선정·포장당 일수·폐기비용은 사후 정보 | 진단 문서만 사용, 모델 입력·취소율에 미유입 |
| 취급 달력 | 원자료는 판매가 없던 매장·월을 미취급으로 설정 | **HIGH / UNVERIFIED**: 사전에 알았다는 공지 이력 없음. 제공 스케줄이 origin에 알려졌다는 조건부 평가 |
| 행사·BOM·마스터 | 정적 파일, 게시·적용 시점 이력 없음 | **UNVERIFIED**: 과거 당시 버전임을 증명할 스냅샷 필요 |
| Part 1 엔진 미래 변조 | 3개 origin×3매장×행사 on/off 18건, 미래 y를 37배 변경해 메뉴/BOM 불변 | PASS; 입력 y 자체는 합성 잠재수요 기반 |

따라서 “운영 환경에서 모든 Feature가 당시 실제로 관측됐음”을 무조건 보증하지 않는다. 이번 진단은 기존 예측 재현과 코드상 시간 차단 검증을 완료한 것이며, 실운영 누수 없음의 확정에는 일정 `known_at`과 마스터 버전 이력이 필요하다. 기존 모형을 임의로 수정하거나 새로운 가용성 모형으로 대체하지 않았다.

## 타깃과 단위

원본 `qty=demand_qty-lost_qty`, 판매 확정량 `qty-cancel_qty`, `consumed_qty=Σ(판매 확정량×메뉴 자체 BOM)`을 재확인했다. 세트는 세트 BOM만 한 번 적용한다. 13,104 메뉴 일 패널의 미취급 1,053행은 Mission 01에서 target NaN이고 취급 12,051행 중 원본 판매 행이 없는 1,155행은 0이다.

진단은 매장×식자재×origin×target의 39,732행(Validation+Test, 모든 horizon)을 만든다. Test h=0은 4,026행 중 미취급 식자재 183행을 명시적으로 제외한 3,843행이다. 활동 중 실제 수요 0은 유지한다. Part 1과 동일 availability인지를 13,104행 전체에서 검증했고 불일치 0건이다.

지표는 `MAE=mean(abs(p-y))`, `mean_error=mean(p-y)`, `Bias=sum(p-y)/sum(abs(y))`, `WAPE=sum(abs(p-y))/sum(abs(y))`다. Bias 양수는 과대예측. 분모 0이면 비율 N/A, 원단위 MAE는 유지한다. 미취급뿐인 조합은 n=0이며 MAE도 N/A다. 일별 1개 사례의 WAPE는 abs(error)/actual이므로 actual=0에서 N/A다. 평균 APE를 전체 WAPE로 사용하지 않는다.

근거: [재현 비교 JSON](../evidence/reproduction_comparison.json), [원본·기존 파일 해시](../evidence/preserved_manifest.json), [테스트 XML](../evidence/all_tests.xml), [Mission 01 features.py]({ROOT}/src/forecast/features.py:39), [model.py]({ROOT}/src/forecast/model.py:29), [evaluation.py]({ROOT}/src/forecast/evaluation.py:46).
''')
    put('02_PART1_COMPARISON.md',f'''# Part 1과 Mission 01 데이터 처리 비교

제공된 로컬 `hackathon-team6-main`의 CSV 17개가 Mission 01과 **SHA-256 일치**한다. `pipeline.py`를 `mission02a/part1_reproduction/`에 재실행했고 CSV 산출물 12개는 기존 Part 1 `analysis/`와 값·바이트가 모두 일치했다. 117개 검사 중 116 PASS, 1 WARN, 0 FAIL이다. WARN은 09-30 이후 입고 예정 25개 발주 라인이며 오류나 입고 사고가 아니다. 로컬 스냅샷에 `.git`과 원격 주소가 없어 **GitHub HEAD·commit·배포본 일치 여부는 UNVERIFIED**다.

## 의미와 전처리 비교표

| 항목 | 원본·명세·Part 1 | Mission 01 | 진단·통합 제안 |
|---|---|---|---|
| 원자료·행 grain | 동일 CSV 17개, 판매는 날짜×시간×매장×메뉴×채널 | 같은 원자료 | 소스 내용 충돌 없음 |
| 일별 메뉴 패널 | 13,104행, 모든 qty 계열 0 fill, available 별도 | 같은 패널, 미취급 target NaN | **1,053행 표현 차이**. available로 필터 후 값 비교는 일치 |
| active zero | 주문 없는 취급일 0 | 동일 | 보존; 결측과 구별 |
| 수요·확정량 | demand_qty / qty / net_sales_qty를 분리 | demand_qty target, net_qty는 qty-cancel | active 수요·확정량 불일치 0 |
| 엔진 학습값 | y=demand_qty-cancel_qty; 품절이 없을 때 확정량의 합성 proxy | gross demand_qty 예측 후 과거 취소율 차감 | 같은 값 이름으로 교체 금지; engine f에 취소율 재차감 금지 |
| 품절 | synthetic_need=consumed+lost×BOM | demand 기반 예상 소요는 무품절 가정 | 잃은 주문의 취소는 관측되지 않음. Part 1 proxy는 lost 전량 회복 가정 |
| BOM | 메뉴 자체 BOM 한 번, 세트 재전개 없음 | 동일 | 실제 consumed와 일치 |
| 사용·포장 단위 | use_unit, order_unit, 환산계수 분리 | use_unit 소수 기대량 출력 | pack 반올림·재고 차감은 Part 3 책임 |
| 예측 이력 | 엔진은 메뉴 28일 수준, 매장 56일 요일지수·과거 공휴일 배수 | Baseline/글로벌 CatBoost, direct h=0..6 | 기존 엔진은 참고 후보로만 동등 평가 |
| 행사 | pipeline은 target_menu 구별, 엔진 promo_on은 과거 비율 시나리오 | 알려진 기간/대상 flag | 비교는 promo_on=False, demand_adj=0. 자동 행사 예측으로 해석 금지 |
| 파생 평균 | consumed_avg_7d/28d_past는 shift(1), 당일 제외 | origin에서 판매 이력을 동결 | Part 1 값을 target 날짜로 join하면 h>0에서 미래 이력 유입. 반드시 origin row 또는 origin 스냅샷 |
| 제공 avg_consumption_7d | 당일 포함, 사전 입력 금지로 명시 | 미사용 | raw 칼럼을 past 평균과 혼동 금지 |
| 기준 시각 | D 아침 07시 입고+실사 직후 | D 00:00 | **HIGH 통합 차이**. 받은 수량·실사조정·counted_qty는 00시 사용 불가 |
| 로트·재고 | ingredient_daily는 당일 마감값 포함; decision_features는 당일 아침값 포함 | 모델은 재고·로트 미사용 | 사후 패널 통째로 ML Feature에 연결 금지 |
| 예측 기간 | 엔진 기본 10일, 일부 폐기 비교 14일 | 저장 모델 최대 7일 | 7일 뒤를 0으로 채우면 부족 예측 왜곡. 기간 합의 전 연결 보류 |
| 데이터 끝 | 엔진은 09-30 취급 종료를 계속 판매로 연장, 10월 공휴일 수동 추가 | 제공 달력 밖 요청 거부 | 10-01 Streamlit 기본 화면과 Mission 01 직접 호환 안 됨 |
| 단가 | 날짜 이하 최신 valid_from, 원/order_unit | 예측 Feature 미사용 | 비용 지표 필요 시 시점·가상 단가·환산 별도 명시 |
| 품절 대비 sigma | 엔진은 최근 56일 실현 소요에서 같은 기간 요일 평균 제거 후 std | 예측 구간 없음 | **실제 out-of-sample 예측 잔차가 아님**. z·sqrt(기간) 정책이 서비스수준을 실증했다는 해석 금지 |
| 전체기간 EDA | 포장당 소진일수·폐기순위는 273일 사후 집계 | 모델에 미사용 | 탐색적 중요 품목·진단 설명에만 사용 |

## 실제 소진량과 무품절 소요량의 네 가지 평가

`r`은 각 origin 이전 56일 accepted qty 대비 취소율, `d`는 target의 잠재 주문, `q`는 accepted qty, `c`는 관측 취소, `l`은 lost qty, `b`는 해당 메뉴 BOM이다.

| 평가 정답 | 산식 | 의미·제약 |
|---|---|---|
| consumed_qty | Σ(q-c)b | 관측된 판매 소진. 품절 제약으로 작아질 수 있음 |
| no_stockout_proxy | consumed + Σl(1-r)b | 주 진단용. 잃은 주문에도 과거 취소율 적용; 관측된 반사실 정답이 아님 |
| rate_adjusted_demand | Σd(1-r)b | 취소율이 고정됐다고 가정한 oracle 변환. 수요모형 오차를 따로 보기 위한 값 |
| part1_synthetic_need | Σ(d-c)b = consumed+Σlb | Part 1 산식과 정확히 일치. lost 주문 취소 0 가정 |

CatBoost/Baseline은 `Σpred_demand×(1-r)×b`, Part 1은 이미 순수요인 `Σf×b`를 사용한다. 진단 정답을 만들 때만 target의 consumed/cancel/lost에 접근한다. 예측 생성에는 이 값이 유입되지 않는다.

{table(truth_table,['macro_WAPE','macro_Bias'])}

Test h=0에서 lost 회복분은 S01 09-10의 I015·I016에만 있다. I009·I020·I017은 이 기간 consumed와 no_stockout_proxy가 같다. 따라서 세 품목의 큰 오차를 Test 품절로 설명할 근거는 없다. no_stockout_proxy와 실제 소진량의 작은 전체 차이는 품절이 드문 이 합성 자료의 특성이지 실매장 일반화 근거가 아니다.

## 보고서와 원본 수치 대조

운영분석보고서의 18,018행, 폐기비용 2,494,848원, 품절 손실 74개, 소비기한 경과 379,545원(15.21%)를 원본에서 재계산했다. 사유별 합계, 매장별 수치, 양상추 포장일수 및 폐기비용은 Part 1 재생산 CSV와도 일치한다. 소비기한 경과 폐기는 양상추 168,326원, 식빵 71,499원, 코울슬로 32,479원이며 전액을 발주로 절감할 수 있다고 해석하지 않는다.

Streamlit의 `app.get_rec` → `engine.recommend` → `store_state` → `forecast_menus` → `forecast_ingredients` 호출 관계는 코드를 읽어 확인했다. 이번 작업에서 Streamlit 서버·LLM API·발주 추천 최적화는 실행하지 않았다. 엔진의 예측·BOM 함수와 시점 관련 테스트만 사용했다. 다른 담당자의 코드 수정은 없다.

근거: [Part 1 코드 감사 JSON](../evidence/part1_audit.json), [소스 비교](../evidence/part1_source_comparison.json), [pipeline 메뉴패널]({PART1}/pipeline.py:43), [파생 평균]({PART1}/pipeline.py:113), [decision_features 구성]({PART1}/pipeline.py:392), [engine 타깃]({PART1}/engine.py:50), [예측]({PART1}/engine.py:130), [sigma]({PART1}/engine.py:197), [앱 기준시각]({PART1}/app.py:77).
''')
    cc=pd.read_csv(OUT/'coverage_store_ingredient_metrics.csv')
    cc=cc.loc[cc.split.eq('test') & cc.truth.eq('no_stockout_proxy') & cc.origin_cohort.eq('common_7day_origins') & cc.model.eq('catboost') & cc.ingredient_id.isin(['I009','I020','I017'])]
    op=pd.read_csv(OUT/'operating_constraints.csv');op=op.loc[op.ingredient_id.isin(['I009','I020','I017'])]
    comp=pd.read_csv(OUT/'error_components.csv');comp=comp.loc[comp.split.eq('test') & comp.ingredient_id.isin(['I009','I020','I017'])]
    put('03_COVERAGE_ERRORS.md',f'''# 발주 커버 기간별 정확도와 주요 오차 원인

## 동일 origin으로 1·2·3·7일 비교

모든 후보는 동일한 origin/target/매장/메뉴 취급 달력과 정답을 사용한다. 각 origin의 예측 h=0..H-1을 합치며, 다음날 갱신된 h=0 예측들을 이어 붙이지 않는다. 주 비교는 **Test 08-01~09-24의 55개 origin**, Validation 07-01~07-25의 25개 origin을 모든 커버 기간에 고정한다. 끝부분을 0으로 채우지 않고 완전한 연속 7일이 있는 origin만 사용한다. 후보 내 target 집합은 완전히 같고 H 사이에는 의도적으로 길이가 다른 중첩 구간을 사용한다.

{table(cover[['cover_days','model','macro_WAPE','macro_Bias','defined_series']],['macro_WAPE','macro_Bias'])}

![커버 기간 비교](coverage.png)

1일 전체 비교(61 origin)와 공통 origin 비교(55)의 차이는 표본 차이다. 모든 완전한 origin을 이용한 보조표도 제공하며 Test H=1/2/3/7의 origin은 61/60/59/55개다. 동일 target이 여러 origin에 중복되며 7일 창도 겹치므로 n=55를 독립 관측 55개로 해석하지 않는다. 유의성·미래 개선폭은 추정하지 않았다.

원단위 누적 MAE는 H와 함께 커질 수 있다. S02 식빵의 공통-origin MAE는 1일 **3.62장**에서 7일 **13.95장**으로 커지지만 WAPE는 **68.23%→37.29%**로 낮아진다. 오차 상쇄와 분모 증가가 포함되므로 “7일 예측이 발주 폐기를 줄였다”는 뜻이 아니다.

이 커버 기간은 **origin 당일부터**다. 실제 발주의 입고일~다음 입고 직전 구간과는 다르다. 두 공급사 모두 리드타임 1일이며 발주 불가 요일이 있어 2~3일 검토가 중요하다. 7일은 장기 누적 진단이며 양상추의 사용기한 5일을 넘는 7일치를 발주하라는 제안이 아니다. 입고 후 7일(h=1..7)은 기존 최대 h=6 모델로 완전히 평가할 수 없다.

## 핵심 품목의 일간 성능

{table(focus[['store_id','ingredient_id','use_unit','n','MAE','mean_error','Bias','WAPE','zero_actual_days']],['Bias','WAPE'])}

![품목과 매장별 오차](focus.png)

### I009 양상추

다수 버거·세트의 BOM을 합치므로 단품 수요의 오차가 일부 상쇄된다. 세 매장의 일간 WAPE는 12.71%, 17.22%, 19.34%다. S03은 Bias −6.33%이고 9월 −9.25%로 음의 방향이 커진다. S03 M004와 M005의 누적 양상추 오차 기여는 각각 **−12,692.53g, −9,464.30g**이다. S01 M005 기여 −62,302.15g는 M004 등의 양의 오차와 일부 상쇄된다. 이는 산술적 오차 기여이지 메뉴 자체의 인과적 수요 변화 원인을 확인한 것은 아니다.

origin 이전 28일 평균의 1.5배보다 실제 소진이 컸던 S03 양상추 6일의 Bias는 **−35.99%**, 나머지 55일은 **−1.04%**다. 실제 결과로 나눈 사후 구간이므로 극단일 구분을 예측 Feature로 사용할 수 없고, 평균 수준으로 회귀하는 점예측의 한계를 보여주는 탐색적 결과다.

### I020 토스트 식빵

M014 단일 메뉴에 연결된다. 따라서 식자재 직접예측으로 이름만 바꾸면 추가 정보가 생기지 않는다. S02는 Test 61일 중 소진 0이 **11일**, S03은 **6일**이다. 1~7월 active 수요 CV는 S02 **0.79**, S03 **0.63**으로 양상추 **0.25 안팎**보다 크다. 소량·0수요와 변동성이 큰 수요를 점예측으로 표현하면서 상대오차가 커진다.

S02 14개 높은 소진일의 Bias는 **−45.80%**, S03 10일은 **−51.39%**다. 전체 Bias는 각각 +17.42%, +12.76%여도 수요 급증일 부족 방향 오차가 남는다. 7일 누적도 S02 WAPE 37.29%, S03 35.10%다. S01과 S03의 7일 WAPE는 CatBoost가 Baseline보다 높으므로 CatBoost가 모든 품목·기간에서 우월하다고 주장하지 않는다.

### I017 코울슬로

S02의 전체 Bias +0.94%는 **8월 +49.29%, 9월 −20.13%**를 숨긴다. S02 M007·M008은 07-31 종료이고 그 이후 타깃에서 제외했다. 다른 코울슬로 연결 메뉴의 수요도 변화했다. M009 일평균 잠재수요는 7월 **4.81개 → 8월 1.39개 → 9월 4.47개**, M010은 **5.65→2.35→6.30개**다. 변화 이후의 이력 이동평균과 고정 모형이 적응하는 데 시간이 걸리는 것이 가능한 원인이다. 행사 종료·메뉴 구성·합성 월별 패턴 중 어느 요인이 인과적으로 얼마를 설명하는지는 검증하지 않았다.

S03은 Bias +8.69%이고, M009에서 +2,554.37g, M014에서 +1,526.18g가 누적 과대예측에 기여했다. S03 코울슬로 7일 WAPE는 CatBoost **16.13%**, Baseline **13.53%**다. 양의 체계오차는 누적만으로 제거되지 않는다.

![S02와 S03 일별 실제 소진과 예측](focus_daily.png)

## 수요·취소·품절 오차 분해

`예측−no_stockout_proxy = (pred_demand−demand)(1-r)×BOM + (cancel−qty×r)×BOM`이 행마다 일치하는지 검사했다. 아래 MAE들은 성분 크기이며, 절댓값 MAE끼리 합쳐 총 MAE가 되지는 않는다.

{table(comp[['store_id','ingredient_id','use_unit','demand_component_MAE','cancellation_component_MAE','lost_recovery_mean','total_proxy_MAE']])}

세 품목은 품절 회복분 0이고 취소 성분보다 수요예측 성분의 MAE가 훨씬 크다. 우선 조사 대상은 BOM 단위 오류나 Test 품절 보정보다 수요 수준 변화·저빈도 주문·극단일 오차다. 기록된 BOM/consumed 불일치는 0이며, 과거 운영 폐기를 현재 모형 오차가 발생시켰다는 인과 주장은 할 수 없다.

## 포장·사용기한·공급사 표시

{table(op[['store_id','ingredient_id','use_unit','use_qty_per_order_unit','mean_consumed_273d','pack_days_posthoc','shelf_life_days','expiry_cost','expiry_events']])}

포장일수는 273일 전체 실제 consumed의 사후 평균이다. S02 식빵 한 포장 24장은 **4.49일치**, S03은 **3.17일치**, 코울슬로 1,000g은 각각 **1.79/1.80일치**다. 이 숫자를 과거 origin의 Feature로 쓰지 않았다. 세 품목은 SUP_A로 일~금 17시 전 발주, 다음날 월~토 입고, 가상 최소금액 120,000원 조건이 있다. 양상추 8,000g/5일, 식빵 24장/7일, 코울슬로 1,000g/7일의 포장·사용기한을 재고 로트와 함께 검토해야 한다.

전체 22개 품목×3매장의 short shelf, 포장>1일, 포장>사용기한, 공급사 최소금액 flag와 요일·마감·최소수량은 [operating_constraints.csv](../outputs/operating_constraints.csv)에 있다. `min_order_qty`는 모두 포장 1단위이며 예상 소요량을 발주량으로 반올림·최적화하지 않았다.

## 핵심 품목의 모든 커버 기간 수치

{table(cc[['store_id','ingredient_id','use_unit','cover_days','n','MAE','mean_error','Bias','WAPE']],['Bias','WAPE'])}

원인별 상세: [메뉴 오차 기여](../outputs/menu_error_attribution.csv), [월별](../outputs/error_by_month.csv), [요일별](../outputs/error_by_weekday.csv), [실현 수요 수준별](../outputs/error_by_realized_band.csv), [Test 이전 분포](../outputs/pretest_distribution.csv). 실제 결과 기반 slice는 탐색적이며 데이터 선택 편향이 있다.
''')
    full=base.merge(names,on='ingredient_id').pivot(index=['store_id','ingredient_id','ingredient_name','use_unit'],columns='model',values='WAPE').reset_index()
    details=base.loc[base.model.eq('catboost'),['store_id','ingredient_id','n','MAE','mean_error','Bias']]
    full=full.merge(details,on=['store_id','ingredient_id'])
    put('05_FULL_METRICS.md',f'''# 전체 22개 식자재와 3개 매장의 예측 성능

제공 합성 데이터 Test 2026-08-01~09-30, 일간 h=0, 기본 `no_stockout_proxy` 정답. WAPE 열은 같은 origin의 각 후보, MAE/mean_error/Bias는 CatBoost다. MAE 단위는 행의 use_unit이다. n=0은 연결 메뉴 미취급으로 평가 제외한 조합이며 0 오차를 뜻하지 않는다.

{table(full,['baseline','catboost','part1_engine','Bias'])}

4개 정답 정의와 Validation/Test의 모든 모델 MAE·mean_error·Bias·WAPE·n은 [daily_store_ingredient_metrics.csv](../outputs/daily_store_ingredient_metrics.csv), 날짜별 값은 [daily_date_metrics.csv](../outputs/daily_date_metrics.csv), h=0..6은 [horizon_metrics.csv](../outputs/horizon_metrics.csv), 1·2·3·7일 누적은 [coverage_store_ingredient_metrics.csv](../outputs/coverage_store_ingredient_metrics.csv)에 있다. 날짜별 n=1의 actual=0에서는 WAPE/Bias N/A이며 abs_error는 MAE에 보존된다.
''')
    print('Wrote 5 data-backed reports')


if __name__=='__main__':main()
