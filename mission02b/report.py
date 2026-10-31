"""Generate the requested local Markdown report from verified saved metrics."""
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

from forecast.data import load_data, build_daily_panel
from forecast.features import FEATURES
from .models import SPECS
from .features import ADAPTIVE

ROOT=Path(__file__).resolve().parents[1]
HOME=ROOT/"mission02b"
OUT=HOME/"runs/main"
SHORT={s.name:s.name.split("_")[0] for s in SPECS}
SHORT["legacy122"]="기존122"
DESCRIPTION={"A0_RMSE":"기존 Feature / RMSE / 400 trees", "A1_MAE":"손실만 MAE", "A2_Poisson":"손실만 Poisson",
             "B1_features":"신규 Feature만", "B2_decay28":"기존 Feature + 반감기28일", "B3_decay56":"기존 Feature + 반감기56일",
             "B4_features_decay28":"신규 Feature + 반감기28일", "B5_features_decay56":"신규 Feature + 반감기56일",
             "C_hierarchy":"매장 총수요 × 학습·평활화 메뉴비중"}


def pct(x):
    return "NA" if pd.isna(x) else f"{x*100:.2f}%"


def signed(x):
    return "NA" if pd.isna(x) else f"{x*100:+.2f}%"


def table(headers,rows):
    return "\n".join(["| "+" | ".join(headers)+" |","| "+" | ".join(["---"]*len(headers))+" |"]+
                     ["| "+" | ".join(map(str,r))+" |" for r in rows])+"\n"


def link(path,label=None):
    path=Path(path).resolve()
    return f"[{label or path.name}]({path})"


def read(scope,name):
    return pd.read_csv(OUT/scope/f"{name}.csv")


def chart(cmp):
    os.environ.setdefault("MPLCONFIGDIR",str(HOME/"audit/matplotlib"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig,ax=plt.subplots(figsize=(10,6.4))
    names=[s.name for s in SPECS[1:]]
    y=np.arange(len(names))
    for fold,offset,color,hatch in [("A",-.18,"#2962A3",None),("B",.18,"#D18B24","//")]:
        f=cmp.loc[cmp.fold.eq(fold)].set_index("model")
        delta=(f.loc[names,"WAPE"]-f.loc["A0_RMSE","WAPE"])*100
        bars=ax.barh(y+offset,delta,height=.32,color=color,label=f"Fold {fold} ({'June' if fold=='A' else 'July'})",hatch=hatch)
        for bar,value in zip(bars,delta):
            ax.text(value+(.04 if value>=0 else -.04),bar.get_y()+bar.get_height()/2,f"{value:+.2f}",
                    va="center",ha="left" if value>=0 else "right",fontsize=9)
    ax.set_yticks(y,[SHORT[n]+"  "+{"A1":"MAE","A2":"Poisson","B1":"Features","B2":"Decay 28d","B3":"Decay 56d","B4":"Features + 28d","B5":"Features + 56d","C":"Hierarchy"}[SHORT[n]] for n in names])
    ax.invert_yaxis();ax.axvline(0,color="#333333",lw=1)
    ax.set_xlim(-1.15,2.8)
    ax.set_xlabel("Menu WAPE change vs A0 (percentage points); negative = better")
    ax.set_title("No candidate improved menu WAPE in both development folds",loc="left",pad=22,fontweight="bold")
    ax.legend(loc="upper right",frameon=False)
    ax.spines[["top","right"]].set_visible(False)
    ax.grid(axis="x",alpha=.16);ax.set_axisbelow(True)
    fig.text(.02,.015,"Supplied synthetic data | Same active targets per model | A: 8,883 cases; B: 9,212 cases",fontsize=9,color="#444444")
    fig.tight_layout(rect=[0,.04,1,1])
    path=HOME/"validation_deltas.png"
    fig.savefig(path,dpi=170,facecolor="white")
    plt.close(fig)
    return path


def main():
    verified=json.loads((HOME/"audit/verification.json").read_text())
    selection=json.loads((OUT/"selection.json").read_text())
    condition=json.loads((OUT/"conditional_decision.json").read_text())
    data=load_data(next(ROOT.glob("*/data/09_sales.csv")).parent)
    panel=build_daily_panel(data)
    cmp=pd.read_csv(OUT/"validation_comparison.csv")
    chart_path=chart(cmp)
    models=[s.name for s in SPECS]
    named={r.ingredient_id:f"{r.ingredient_id} {r.ingredient_name} ({r.use_unit})" for r in data["ingredients"].itertuples()}
    menus={r.menu_id:f"{r.menu_id} {r.menu_name}" for r in data["menus"].itertuples()}
    text=["# Mission 02B — 일관된 정확도 개선이 없어 기존 CatBoost를 유지한다","",
          "STATUS: PROPOSED — NOT TEAM APPROVED","",
          "작성일: 2026-10-31 (Asia/Seoul). 평가 자료: 2026-01-01~09-30 제공 **합성 데이터**. 실제 매장 성능·비용 절감 효과를 뜻하지 않는다.","",
          "## 결론","",
          "실제로 9개 모델 설정을 두 Fold에서 학습·백테스트했다. 개발 평균 WAPE 1위는 A1(MAE)이지만 A0 대비 개선은 **0.245%p**이고, Fold B가 악화돼 사전 채택 기준을 충족하지 못했다. 기본 모델은 기존 122-tree CatBoost 그대로 유지한다. A0 400-tree도 배포 모델로 교체하지 않는다.","",
          "고정 후 한 번 비교한 8~9월 Historical Holdout에서 A1 메뉴 WAPE는 **26.88%**, 기존 모델은 **26.40%**였다. A1이 **0.477%p 악화(오차율 상대 1.81% 증가)**했다. A1의 식자재 일간 Macro WAPE는 **34.04% vs 기존 33.39%**, 7일 누적은 **18.80% vs 기존 18.14%**로 모두 악화됐다. 이 구간은 기존 Mission에서 이미 분석했으므로 새로운 독립 Test가 아니다.","",
          "전체 테스트 **70개 통과**, 실패·건너뜀 0. 기존 주요 산출물 7개 재현 일치, 보호 대상 174개 파일 SHA-256 변경 0. 신규 구현·모델·결과는 모두 `mission02b/` 내부에만 저장했다.","",
          "## 1. 평가 프로토콜과 공정성","",
          f"신규 점수를 보기 전에 {link(HOME/'PROTOCOL.md')}와 {link(HOME/'audit/protocol_lock.json')}을 기록했다. 선정 시점은 {pd.Timestamp(selection['locked_at']).tz_convert('Asia/Seoul').strftime('%Y-%m-%d %H:%M:%S')} (Asia/Seoul)이며 Holdout 실행 전에 후보·설정·코드 해시를 고정했다.","",
          table(["구간","학습 Target","평가 origin / Target","학습 행","평가 행","공통 7일 origin"],
                [["Fold A","01-29~05-31","06-01~06-30",36610,8883,24],
                 ["Fold B","01-29~06-30","07-01~07-31",46480,9212,25],
                 ["Historical Holdout","01-29~07-31","08-01~09-30",56679,18270,55]]),
          "- 01-01 이후 28일 Warmup. Asia/Seoul 당일 시작을 origin으로 0~6일을 직접 예측한다. 모든 실제 관측 Feature·취소율은 날짜 < origin만 사용한다.",
          "- 학습/검증 분리는 Target 날짜 기준이다. 검증 origin은 해당 월 시작 이후이며 월말 이후 Target은 제외한다. 월말 일부 origin은 7일보다 짧으므로 커버 기간 지표에는 별도 공통 완전 origin 집합을 쓴다.",
          "- 모델마다 동일한 매장·메뉴·취급 일정·origin·horizon·Target을 사용한다. 취급 중 0수요는 포함하고 미취급은 제외한다. 메뉴 전체 WAPE는 반복 Target이 포함된 origin×horizon 예측 사례 기준이다.",
          "- 개발 데이터의 판매는 08-01 이전으로 절단했다. 8~9월은 개발 선정·추가 실험 판단에 쓰지 않았다. 달력·취급·프로모션 일정은 origin에 알려져 있다는 기존 가정을 유지한다.",
          "- 기존 배포 모델의 122 trees는 이전 Mission의 7월 조기종료 결과다. 이를 Fold A에 가져오지 않고, A0~B5는 원래 설정 상한인 **400 trees 고정**, depth=6, learning_rate=.05, l2_leaf_reg=5, seed=42, threads=4로 통일했다. 조기종료·추가 탐색은 하지 않았다. C는 총수요/비중 각각 400 trees이므로 총 학습량은 더 크다.",
          "- 따라서 개발 A0는 **기존 구조의 고정 예산 재학습 기준선**이며, 기존 July-tuned 122-tree 모델 그 자체의 재검증 점수로 부르면 안 된다. 최종 Holdout에서 기존122 예측을 동일 행으로 직접 비교·원본과 대조했다.","",
          "채택 조건: 두 Fold 모두 A0보다 낮은 메뉴 WAPE, Fold 평균 최소 0.50%p 개선. 각 Fold에서 식자재 일간 및 각 커버 Macro WAPE 악화 ≤1.00%p, 절대 전체 Bias 악화 ≤2.00%p, 사후 선정 주요 식자재 각각 절대 Bias 악화 ≤3.00%p. 실용적 기준이며 통계적 유의성 주장에 쓰지 않는다.","",
          "## 2. 모델별 Validation 비교","",
          "WAPE는 낮을수록 좋다. 평균은 Fold A/B에 동일 가중치를 둔다. Δ는 후보−A0이므로 음수가 개선이다.",""]
    rows=[]
    pivot=cmp.pivot(index="model",columns="fold",values="WAPE")
    for n in models:
        v=pivot.loc[n];base=pivot.loc["A0_RMSE"]
        rows.append([SHORT[n],DESCRIPTION[n],pct(v.A),pct(v.B),pct(v.mean()),f"{(v.mean()-base.mean())*100:+.3f}%p","기준선" if n=="A0_RMSE" else "미채택"])
    text += [table(["ID","변경사항","Fold A WAPE","Fold B WAPE","평균","평균 Δ","판정"],rows),
             f"![Fold별 WAPE 변화 비교]({chart_path})","",
             "MAE는 6월 WAPE를 0.545%p 낮췄지만 7월에는 0.055%p 높였다. 신규 Feature만 추가한 B1은 7월 0.837%p 개선됐으나 6월 0.453%p 악화됐다. 계층형 C는 6월 0.638%p 개선, 7월 2.465%p 악화로 안정성이 부족하다.","",
             "### MAE, Bias, 과소·과대 예측량","",
             "Bias 양수는 과대, 음수는 과소예측이다. 아래 수량은 메뉴 단위의 예측 사례 합계이며 실제 기간 판매 합계와 다르다.",""]
    rows=[]
    for fold in ["A","B"]:
        t=read(f"validation/{fold}","menu_metrics").query("dimension == 'overall'").set_index("model")
        for n in models:
            r=t.loc[n];rows.append([fold,SHORT[n],f"{r.MAE:.3f}",signed(r.Bias),f"{r.under_qty:.1f}",f"{r.over_qty:.1f}"])
    text += [table(["Fold","모델","MAE","Bias","과소량","과대량"],rows),
             "A1의 전체 Bias는 6월 +3.33%, 7월 −3.39%다. 7월 A0의 −0.39%에서 과소예측이 커졌고 Bias 보조 기준을 통과하지 못했다.","",
             "## 3. Feature와 시간 감쇠 Ablation","",
             f"기존 Feature {len(FEATURES)}개를 보존했다. 신규 {len(ADAPTIVE)}개: `"+'`, `'.join(ADAPTIVE)+"`. 기존 `store_trend=(store_mean7−store_mean28)/store_mean28`이 최근 매장 총수요 변화율을 이미 담으므로 중복 Feature를 만들지 않았다.","",
             "EWMA는 origin 이전 56일 이력에 7/28일 반감기를 적용한다. 메뉴 비중은 해당 매장의 일별 전체 수요 대비 비중의 최근 7/28일 평균이다. 동일 요일 변화는 직전 동일 요일 수요와 그 앞 3회의 평균을 비교한다. 0수요 비율의 분모는 실제 취급일이며 미취급일을 0으로 세지 않는다.","",
             "시간 가중치는 `2**(-(마지막 학습 Target−행 Target).days/반감기)`다. 손실은 B 전체에서 RMSE로 고정해 Feature 효과와 가중치 효과를 분리했다.",""]
    ablations=[("Feature 단독","B1_features","A0_RMSE"),("감쇠28 단독","B2_decay28","A0_RMSE"),("감쇠56 단독","B3_decay56","A0_RMSE"),
               ("감쇠28 조건의 Feature 추가","B4_features_decay28","B2_decay28"),("감쇠56 조건의 Feature 추가","B5_features_decay56","B3_decay56"),
               ("Feature 조건의 감쇠28 추가","B4_features_decay28","B1_features"),("Feature 조건의 감쇠56 추가","B5_features_decay56","B1_features")]
    pd.DataFrame([dict(comparison=label,fold=fold,candidate=a,reference=b,
                       candidate_WAPE=pivot.loc[a,fold],reference_WAPE=pivot.loc[b,fold],
                       delta_percentage_points=(pivot.loc[a,fold]-pivot.loc[b,fold])*100)
                  for label,a,b in ablations for fold in ["A","B"]]).to_csv(OUT/"feature_ablation.csv",index=False)
    text += [table(["비교","차이","Fold A Δ WAPE","Fold B Δ WAPE"],[[label,f"{SHORT[a]}−{SHORT[b]}",f"{(pivot.loc[a,'A']-pivot.loc[b,'A'])*100:+.3f}%p",f"{(pivot.loc[a,'B']-pivot.loc[b,'B'])*100:+.3f}%p"] for label,a,b in ablations]),
             "이번 Feature 묶음 및 감쇠 조합에서는 일관된 개선이 없었다. 각 Feature의 개별 효과나 모든 반감기·모델 구조의 가능성을 부정하는 결과는 아니다.","",
             "계층형 C는 매장 총수요 회귀와 메뉴 비중 회귀를 분리했다. 비중 이력은 매장 내 카테고리 비중과 여러 매장의 카테고리 내 메뉴 비중을 사전값으로 삼아 7 pseudo-days로 평활화하며, 요일 비중에는 3 pseudo-observations를 적용한다. 비중 모델은 요일·매장·메뉴·카테고리·최근 비중 변화를 함께 사용한다. 음수 비중을 0으로 제한하고 현재 취급 메뉴에만 정규화한다. 모든 예측 메뉴 합계와 매장 총수요의 일치를 학습 후 추론 및 테스트에서 검증했다.","",
             "## 4. 저수요 메뉴와 조건부 실험","",
             "규모는 각 Fold 시작 이전의 매장×메뉴 평균 수요로 고정했다: 저수요 <5, 중간 5~20 미만, 고수요 ≥20. 평가 기간 실현 수요로 규모를 정하지 않았다.",""]
    rows=[]
    for fold in ["A","B"]:
        t=read(f"validation/{fold}","menu_metrics").query("dimension == 'size_band'").set_index(["model","group"])
        for n in models:
            lo=t.loc[(n,"low")];rows.append([fold,SHORT[n],pct(lo.WAPE),f"{lo.MAE:.3f}",signed(lo.Bias),pct(t.loc[(n,"medium"),"WAPE"]),pct(t.loc[(n,"high"),"WAPE"])])
    text += [table(["Fold","모델","저수요 WAPE","저수요 MAE","저수요 Bias","중간 WAPE","고수요 WAPE"],rows),
             "Poisson 저수요 WAPE는 6월 **68.82%→63.88%**, 7월 **63.88%→62.52%**로 각각 상대 7.18%, 2.14% 개선했다. 하지만 전체 메뉴 WAPE는 두 Fold에서 일관되게 개선되지 않았다. A1 저수요 Bias는 7월 **−14.83%**로, 낮은 절대오차만 보고 재고 소요량용 후보로 채택하기 어렵다.","",
             f"사전 조건 판정: Hurdle={condition['hurdle']}, Residual Correction={condition['residual']}. 저수요에서 Poisson의 개선이 이미 두 Fold 모두 상대 2% 이상이므로 Hurdle 추가 학습을 실행하지 않았다. 최상위 A1 Bias의 부호가 바뀌므로 지속적 같은 방향 Bias 조건도 성립하지 않았다. 구현된 Hurdle/잔차 보정 코드와 동작 테스트는 제공하되, 이 두 방법의 전체 Validation 성능이 검증됐다고 주장하지 않는다. Negative Binomial이나 대규모 탐색도 실행하지 않았다.","",
             "## 5. 식자재별·커버 기간별 성능","",
             "소요량은 `use_unit`을 유지하고 각 메뉴의 BOM을 한 번만 적용한다. 세트 구성품을 추가 전개하지 않는다. Macro WAPE는 분모가 0이 아닌 **매장×식자재 WAPE의 동등 평균**이며 서로 다른 단위의 수량을 합하지 않는다. 평가 가능한 시계열은 Fold A/B 64개, Holdout 63개다.","",
             "주 비교는 `no_stockout_proxy=net_qty+lost_qty*(1-r_hat)`다. `r_hat`은 origin 이전 56일 취소량/실제 주문량이며 메뉴→전체 비율 fallback은 기존 구현을 재사용했다. 실제 소진량 `consumed_qty`, 취소율을 양쪽에 동일 적용한 `demand*(1-r_hat)`, 원래 잠재수요 BOM도 따로 저장했다.","",
             "일간은 모든 origin의 horizon0을 사용한다. 1/2/3/7일 누적은 동일 origin에서 예측한 horizon0부터의 합이며, 7일이 완전한 공통 origin만 사용한다. 따라서 일간과 1일 커버 열의 차이는 서로 다른 origin 집합 때문이며 모델 간 비교는 각 열 내부에서만 한다.",""]
    rows=[]
    for r in cmp.itertuples():
        rows.append([r.fold,SHORT[r.model],pct(r.ingredient_daily_macro),pct(r.cover_1),pct(r.cover_2),pct(r.cover_3),pct(r.cover_7)])
    text += [table(["Fold","모델","일간 Macro","1일","2일","3일","7일"],rows),
             "### 주요 품목 진단 — 사후 선정된 탐색적 분석","",
             "양상추(I009), 토스트 식빵(I020), 코울슬로(I017)는 전체 기간 EDA에서 이미 선택된 대상이다. 새로운 독립 하위집단 검증이나 발주 비용 효과로 해석하지 않는다. 아래는 식자재별 동일 단위 내 매장을 합친 WAPE/Bias다.",""]
    rows=[]
    for scope,label,ns in [("validation/A","A",["A0_RMSE","A1_MAE"]),("validation/B","B",["A0_RMSE","A1_MAE"]),("holdout","Holdout",["legacy122","A1_MAE"])]:
        t=read(scope,"daily_ingredient_metrics").query("truth == 'no_stockout_proxy'").set_index(["model","ingredient_id"])
        for item in ["I009","I020","I017"]:
            for n in ns:
                r=t.loc[(n,item)];rows.append([label,named[item],SHORT[n],pct(r.WAPE),signed(r.Bias),f"{r.MAE:.2f}"])
    text += [table(["구간","품목·단위","모델","WAPE","Bias","MAE(use_unit)"],rows),
             "코울슬로의 7월 A1 Bias는 **−21.96%**로 A0의 −13.62%보다 과소예측이 커졌다. 양상추는 6월 A1이 개선됐지만 7월과 Holdout에서는 WAPE가 악화됐다. 토스트 식빵도 Holdout에서 A1 54.99% vs 기존 52.75%로 악화됐다. 작은 품목 수요에서 상대오차가 커지는 양상은 남아 있다.","",
             "### 수요 예측 오류와 취소율 오류의 분리","",
             "식자재 단위의 signed error는 `예측−무품절proxy = (예측수요−실제수요)*(1-r_hat)*BOM + (cancel_qty−qty*r_hat)*BOM`로 정확히 분해된다. 실제 소진량과의 차이는 여기에 `lost_qty*(1-r_hat)*BOM`을 더한다. 절대오차/MAE는 서로 상쇄될 수 있어 단순 합으로 분해하지 않는다.",""]
    # Report one store to keep component MAEs at an unambiguous single-series grain.
    comp=read("holdout","error_components")
    rows=[]
    for r in comp.loc[comp.store_id.eq("S01") & comp.ingredient_id.isin(["I009","I020","I017"]) & comp.model.isin(["legacy122","A1_MAE"])].itertuples():
        rows.append([named[r.ingredient_id],SHORT[r.model],f"{r.demand_component_MAE:.3f}",f"{r.cancellation_component_MAE:.3f}",f"{r.proxy_MAE:.3f}"])
    text += ["S01 Holdout 예시. 각 행의 단위는 해당 식자재 use_unit이다.","",table(["품목","모델","수요 성분 MAE","취소율 성분 MAE","최종 proxy MAE"],rows),
             "모든 매장×식자재의 성분 및 signed 합계는 각 구간의 `error_components.csv`에 저장했다. 취소율 추정법을 모델별로 바꾸지 않았으므로 여기의 후보 차이는 수요모델 차이에서 온다. 잠재수요가 직접 제공되는 합성 문제라는 한계와 실매장 잠재수요의 관측 가능성은 별도 검토가 필요하다.","",
             "## 6. 매장별·주요 메뉴 Bias","",
             "각 매장의 전체 메뉴 WAPE/Bias를 확인했다. 전체 평균만 좋아지는 경우에도 매장별 악화는 그대로 보고한다.",""]
    rows=[]
    for fold in ["A","B"]:
        t=read(f"validation/{fold}","menu_metrics").query("dimension == 'store_id'").set_index(["model","group"])
        for store in data["stores"].store_id:
            for n in ["A0_RMSE","A1_MAE","B1_features","C_hierarchy"]:
                r=t.loc[(n,store)];rows.append([fold,store,SHORT[n],pct(r.WAPE),signed(r.Bias)])
    text += [table(["Fold","매장","모델","WAPE","Bias"],rows),
             "주요 매장·메뉴는 각 Fold 학습기간 평균 수요 상위 2개 메뉴씩 선정했다. 미래 실현 수요로 고르지 않았다.",""]
    rows=[]
    for fold,start in [("A","2026-06-01"),("B","2026-07-01")]:
        top=panel.loc[panel.date.lt(start) & panel.is_available].groupby(["store_id","menu_id"]).demand_qty.mean().reset_index().sort_values("demand_qty",ascending=False).groupby("store_id").head(2)
        t=read(f"validation/{fold}","menu_metrics").query("dimension == 'store_menu'").set_index(["model","group"])
        for r in top.sort_values(["store_id","menu_id"]).itertuples():
            key=f"{r.store_id}/{r.menu_id}";a=t.loc[("A0_RMSE",key)];b=t.loc[("A1_MAE",key)]
            rows.append([fold,r.store_id,menus[r.menu_id],pct(a.WAPE),pct(b.WAPE),signed(a.Bias),signed(b.Bias)])
    text += [table(["Fold","매장","메뉴","A0 WAPE","A1 WAPE","A0 Bias","A1 Bias"],rows),
             "전체 9개 모델의 모든 매장·메뉴·매장×메뉴·horizon·월·규모별 WAPE, MAE, Bias, 과소·과대량은 아래 상세 CSV에서 확인할 수 있다.","",
             "## 7. 고정된 Historical Holdout 결과","",
             "개발 선정은 A0 유지, 연구 후보는 A1로 고정한 뒤 A0(400), A1(400)을 7월까지 재학습했다. 기존122는 원래 저장 모델을 그대로 읽었다. 기존 예측 18,270개와 키·예측량의 일치를 검증했다. 이 결과를 본 후 모델·Feature·하이퍼파라미터를 변경하거나 후보를 교체하지 않았다.",""]
    overall=read("holdout","menu_metrics").query("dimension == 'overall'").set_index("model")
    dm=read("holdout","daily_macro").query("truth == 'no_stockout_proxy'").set_index("model")
    cm=read("holdout","coverage_macro").query("truth == 'no_stockout_proxy'").set_index(["model","cover_days"])
    rows=[]
    for n in ["legacy122","A0_RMSE","A1_MAE"]:
        r=overall.loc[n];rows.append([SHORT[n],pct(r.WAPE),f"{r.MAE:.3f}",signed(r.Bias),pct(dm.loc[n,"macro_WAPE"]),*[pct(cm.loc[(n,d),"macro_WAPE"]) for d in [1,2,3,7]]])
    text += [table(["모델","메뉴 WAPE","메뉴 MAE","메뉴 Bias","식자재 일간","1일","2일","3일","7일"],rows),
             "A1은 400-tree A0보다 메뉴 WAPE가 0.095%p 낮지만, 실제 유지 대상인 기존122보다 0.477%p 높다. A0(400)의 7일 식자재 WAPE 17.90%는 기존18.14%보다 0.243%p 낮지만 메뉴·일간 오차는 악화됐다. Holdout 일부 지표만 보고 A0(400)를 새로 채택하지 않는다.","",
             "실제 소진량 기준 일간 Macro WAPE와 무품절 가정 기준은 구분한다.","",
             table(["정답 정의","기존122","A0","A1"],[[truth,*[pct(read("holdout","daily_macro").set_index(["truth","model"]).loc[(truth,n),"macro_WAPE"]) for n in ["legacy122","A0_RMSE","A1_MAE"]]] for truth in ["consumed_qty","no_stockout_proxy","rate_adjusted_demand","latent_demand"]]),
             "## 8. 학습·추론 시간","",
             "동일 로컬 CPU에서 관측한 wall time이다. 모델 추론은 Feature 생성 제외, 전체 API는 08-01 origin·7일·3매장·336 메뉴행의 Feature/취소율/BOM 포함이며 모델 로딩은 제외했다. 일부 실행이 테스트와 겹쳤고 1회 측정이므로 엄밀한 속도 우열을 주장하지 않는다.",""]
    timing=pd.read_csv(OUT/"timings.csv").set_index(["model","fold"])
    api=pd.read_csv(OUT/"api_timings.csv").set_index("model")
    text += [table(["모델","학습 A(s)","학습 B(s)","추론 A(ms)","추론 B(ms)","전체 API(ms)"],
                   [[SHORT[n],f"{timing.loc[(n,'A'),'fit_seconds']:.3f}",f"{timing.loc[(n,'B'),'fit_seconds']:.3f}",f"{timing.loc[(n,'A'),'predict_seconds']*1000:.2f}",f"{timing.loc[(n,'B'),'predict_seconds']*1000:.2f}",f"{api.loc[n,'api_seconds']*1000:.2f}"] for n in models]),
             "## 9. 구현·재현·테스트 및 보존","",
             f"신규 코드: {link(HOME/'features.py')}, {link(HOME/'models.py')}, {link(HOME/'evaluation.py')}, {link(HOME/'run.py')}, {link(HOME/'pipeline.py')}, {link(HOME/'correction.py')}. 기존 공개 함수와 `ForecastResult(menus, ingredients, metadata)` 구조는 변경하지 않았다.","",
             f"재현 명령과 저장모델 사용 예시는 {link(HOME/'RUN_GUIDE.md')}, 팀 연결 제안은 {link(HOME/'INTEGRATION_PROPOSED.md')}에 있다. 경로·계약은 팀 승인 전까지 잠정 제안이다.","",
             table(["검증","결과"],[["기본 .venv/bin/python -m pytest","31 passed"],["신규 사전 Holdout 테스트","26 passed"],["Mission01 + Mission02A + Mission02B","70 passed (31 + 13 + 26), failed/skipped 0"],["기존 파이프라인 재실행","주요 산출물 7개 바이트 일치"],["원본·코드·모델·결과 보존","174개 SHA-256 모두 일치"],["평가 수치 독립 재계산","메뉴 WAPE/MAE/Bias, 일간 Macro, 커버 합계/Macro 일치"],["Holdout 이후 설정 보존","선정 JSON 및 모델/평가 코드 해시 일치"]]),
             "미래 판매·운영정보 변조, 학습 Target 상한, 기존 Feature 완전 일치, Poisson 변환 1회, 모든 A~C 저장·재사용, 계층 합계, 미취급 제외/활성 0, BOM/단위/세트, 시나리오 배수, 누적 origin 정합성, 잔차 관측 시점 등을 테스트했다. 검증 중 원래 Mission02A 테스트 하나가 자체 보존 JSON을 쓰는 동작은 새 테스트 플러그인에서 출력 경로만 임시 경로로 바꿔 원본 테스트 파일을 보존했다.","",
             "시작 시 `.git`이 없어 Git status는 exit128이었다. Git clean/commit 보존을 주장할 수 없다. 대신 기존 실질 파일의 SHA-256을 전후 비교했다. 캐시·가상환경·pycache·OS 메타파일은 해시 대상에서 제외했으며 원본 CSV/PDF/README/명세서·코드·모델·테스트·보고서는 포함했다. Push·업로드·배포 및 팀원 코드 수정은 수행하지 않았다.","",
             f"검증 근거: {link(HOME/'audit/verification.json')}, {link(HOME/'audit/all_tests.log')}, {link(HOME/'audit/real_pipeline.log')}, {link(HOME/'audit/reproduction_comparison.json')}, {link(HOME/'audit/before.json')}, {link(HOME/'audit/preservation_check.json')}.","",
             "## 10. 팀 통합 잠정 권장사항","",
             "기본 예측 경로·모델은 기존122를 유지한다. 신규 API는 별도 실험 인터페이스로만 제공하고 계약 승인 전 기본 경로에 연결하지 않는다. 향후 별도 실험을 시작한다면 더 이른 내부 학습 구간에서 트리 수를 정하는 중첩 검증을 사전 설계하고, 이번에 이미 본 8~9월을 다시 독립 Test처럼 쓰지 않아야 한다. 이번 결과는 고정400 예산에 한정되며 모든 가능한 모델의 개선 가능성을 배제하지 않는다.","",
             "실제 발주 최적화, 안전재고·포장 반올림, 재고 차감, 폐기비용 절감 계산은 범위 밖이다. 현재 제공 달력/판매가 09-30까지만 있어 실제 현재일 이후 운용 가능하다고 주장하지 않는다. 검증 범위 내 재현성은 확인됐지만 실매장 일반화·인과효과·통계적 유의성은 확인하지 않았다.","",
             "## 부록: 전체 메뉴별·식자재별 Validation WAPE","",
             "단위가 다른 식자재는 열별 비율만 비교한다. 식자재 표는 각 식자재 내 매장을 풀링한 일간 WAPE이며 앞의 매장×식자재 Macro와 집계 방식이 다르다. 메뉴 MAE·Bias와 식자재 커버별 상세는 CSV에 모두 보존했다.",""]
    for fold in ["A","B"]:
        text += [f"### Fold {fold}: 메뉴별 WAPE","",
                 table(["메뉴"]+[SHORT[n] for n in models],[[menus[menu],*[pct(read(f"validation/{fold}","menu_metrics").query("dimension == 'menu_id'").set_index(["group","model"]).loc[(menu,n),"WAPE"]) for n in models]] for menu in data["menus"].menu_id]),
                 f"### Fold {fold}: 식자재별 일간 WAPE (무품절 proxy)",""]
        ing=read(f"validation/{fold}","daily_ingredient_metrics").query("truth == 'no_stockout_proxy'").set_index(["ingredient_id","model"])
        text += [table(["식자재(use_unit)"]+[SHORT[n] for n in models],[[named[item],*[pct(ing.loc[(item,n),"WAPE"]) for n in models]] for item in data["ingredients"].ingredient_id]),
                 "상세: "+", ".join(link(OUT/f"validation/{fold}"/f"{file}.csv") for file in ["menu_metrics","daily_series_metrics","daily_ingredient_metrics","coverage_series_metrics","coverage_ingredient_metrics","error_components"])+".",""]
    text += ["## 출처와 계산 정의","",
             f"데이터 및 의미: {link(data.data_dir.parent/'README.md')}와 제공 데이터명세서, 변경하지 않은 Mission01/02A 코드. 실험 입력은 해시 명세의 CSV 17개다.","",
             "CatBoost Poisson은 `predict(..., prediction_type='Exponent')`로 수요량 스케일을 명시했다. 공식 문서상 Poisson 기본 출력도 Exponent이므로 여기에 다시 exp를 취하지 않는다. `exp(RawFormulaVal)`와의 일치를 테스트했다. [CatBoost 공식 predict 문서](https://catboost.ai/docs/en/concepts/python-reference_catboostregressor_predict).","",
             "WAPE=Σ|p−y|/Σ|y|, MAE=mean|p−y|, Bias=Σ(p−y)/Σ|y|. 분모 0은 NA로 남기고 MAE·수량은 기록한다. 취소율 오차와 수요오차는 signed 성분으로 대조했으며 서로 다른 use_unit을 합산하지 않았다. 모든 행별 출력과 학습 모델은 로컬에만 보관한다."]
    (HOME/"MISSION02B_FINAL_REPORT.md").write_text("\n".join(text)+"\n")
    print(f"Wrote report: {HOME/'MISSION02B_FINAL_REPORT.md'}")


if __name__=="__main__":
    main()
