"""
tune.py — 발주 파라미터 튜닝 (3번 파트)

여러 파라미터 조합을 백테스트로 돌려 가장 좋은 조합을 찾는다.
과적합 방지: 인샘플 기간(기본 3~8월)에서 고르고, 아웃오브샘플 기간(기본 9월)에서 확인한다.
1~2월은 예측용 과거 데이터 부족·초기재고 가정 때문에 제외.

실행 (engine.py, backtest.py와 같은 폴더):
    python tune.py                         # 기본 격자, 전 매장, 4개 프로세스
    python tune.py --stores S03 --jobs 4   # 매장 하나로 빠르게
    python tune.py --quick                 # 작은 격자 (시험용)

튜닝 대상:
    z           : 기본 안전재고 수준 (단기 품목에 적용)
    z_long      : 장기 품목 최소 z  (1차 튜닝에서 2.05 포화 확인 → 2.05/2.33만)
    long_shelf  : 장기 품목 기준 사용기한(일)  (1차 튜닝에서 14일 확정)
    waste_ratio : 폐기 고려 감량 기준 (마지막 1단위 중 폐기 예상 비율)
    z_boost     : 최근 품절 품목의 z 상향폭  (2차 튜닝에서 효과 없음 확인 → 0)
    recent_w    : 수요 예측에서 최근 7일 추세 가중치 (0 = 기존 28일 평균)  (3차 튜닝 0.5)
    surge_gain  : 수요 급증 징후 대응 강도 (0 = 끔)
    ※ 기본으로 세 매장을 동시에 시뮬레이션하고 매장 간 이동을 반영 (--no-transfer로 끔)

선택 규칙 (가정표에 기재):
    총비용 = 소비기한 경과 폐기비용
             + 품절 손실(못 판 메뉴 수 × (판매가 − 재료원가), 데이터 기반, backtest.py 참고)
             + 재고 보유비용(평균 재고금액 × HOLD_RATE × 일수)  ← HOLD_RATE만 임의 가정
    → 튜닝 기간 총비용이 가장 작은 조합을 선택
출력:
    analysis/tune_results.csv  (튜닝 기간 전체 조합 결과)
    analysis/tune_best.csv     (선택된 조합의 검증 기간 결과 vs 실제 과거 발주 재생)
"""
from __future__ import annotations

import argparse
import itertools
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pandas as pd

HOLD_RATE = 0.0007  # 재고 보유비용: 평균 재고금액의 일 0.07% (연 약 25%, 임의 가정 — --hold-rate로 변경)

# 4차: 매장 간 이동 반영 후 z 재튜닝 + 급증 징후 대응 강도. 나머지는 1~3차 결과로 고정
GRID = dict(z=[2.6, 3.0, 3.5, 4.0], z_long=[2.33], long_shelf=[14],
            waste_ratio=[0.5], z_boost=[0.0], recent_w=[0.5], surge_gain=[1.0, 1.5, 2.0])
QUICK = dict(z=[2.05, 2.6], z_long=[2.33], long_shelf=[14], waste_ratio=[0.5], z_boost=[0.0],
             recent_w=[0.5], surge_gain=[0.0, 1.0])
KEYS = ["z", "z_long", "long_shelf", "waste_ratio", "z_boost", "recent_w", "surge_gain"]

_D = None


def _init():
    global _D
    import engine as E
    _D = E.load()


def _run(args):
    """한 조합 × 전 매장 × 한 기간 백테스트 (워커 프로세스에서 실행). 매장별 결과 리스트 반환"""
    params, stores, start, end, hold_rate, transfers = args
    import engine as E
    import backtest as B
    if params is None:
        cfg = None
    else:
        E.Z_LONG, E.LONG_SHELF = params["z_long"], params["long_shelf"]
        E.WASTE_CUT_RATIO, E.Z_BOOST = params["waste_ratio"], params["z_boost"]
        E.RECENT_WEIGHT, E.SURGE_GAIN = params["recent_w"], params["surge_gain"]
        cfg = dict(z=params["z"], waste_aware=True, stockout_boost=True, shelf_tier=True)
    d, _, tr = B.run_all(_D, stores, pd.Timestamp(start), pd.Timestamp(end),
                         "replay" if cfg is None else "tune", cfg, transfers=transfers)
    out = []
    for s_, g in d.groupby("store_id"):
        out.append(dict(**(params or {k: None for k in KEYS}),
                        policy="replay" if cfg is None else "engine", store_id=s_,
                        waste=float(g.expiry_waste_cost.sum()), stockout=int(g.stockout_items.sum()),
                        lost_cost=float(g.lost_sales_cost.sum()), lost_menu=float(g.lost_menu_qty.sum()),
                        avg_inv=float(g.inventory_value.mean()), order_amount=float(g.order_amount.sum()),
                        transfers=int(g.transfers_in.sum()),
                        hold_cost=float(g.inventory_value.mean()) * hold_rate * len(g)))
    return out


def evaluate(param_list, stores, start, end, jobs, hold_rate=HOLD_RATE, transfers=True):
    if transfers:   # 매장을 묶어서 한 작업으로
        tasks = [(p, stores, start, end, hold_rate, True) for p in param_list]
    else:           # 매장별로 쪼개서 병렬
        tasks = [(p, [s], start, end, hold_rate, False) for p in param_list for s in stores]
    with ProcessPoolExecutor(max_workers=jobs, initializer=_init) as ex:
        rows = [r for part in ex.map(_run, tasks) for r in part]
    df = pd.DataFrame(rows)
    keys = ["policy"] + KEYS
    g = df.groupby(keys, dropna=False).agg(waste=("waste", "sum"), stockout=("stockout", "sum"),
                                           lost_cost=("lost_cost", "sum"), lost_menu=("lost_menu", "sum"),
                                           transfers=("transfers", "sum"),
                                           avg_inv=("avg_inv", "sum"), hold_cost=("hold_cost", "sum"),
                                           order_amount=("order_amount", "sum")).reset_index()
    g["total_cost"] = g.waste + g.lost_cost + g.hold_cost
    return g


def _fmt(df):
    df = df.copy()
    for c in ["waste", "lost_menu", "lost_cost", "hold_cost", "total_cost", "avg_inv", "order_amount"]:
        if c in df:
            df[c] = df[c].round(0).astype("Int64")
    return df


def pick(res):
    rp = res[res.policy == "replay"].iloc[0]
    eng = res[res.policy == "engine"]
    return eng.sort_values(["total_cost", "stockout"]).iloc[0], rp, "튜닝 기간 총비용(폐기 + 품절 손실 + 보유비용) 최소"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tune-start", default="2026-03-01")
    ap.add_argument("--tune-end", default="2026-08-31")
    ap.add_argument("--test-start", default="2026-09-01")
    ap.add_argument("--test-end", default="2026-09-30")
    ap.add_argument("--stores", nargs="*", default=None)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--hold-rate", type=float, default=HOLD_RATE)
    ap.add_argument("--no-transfer", action="store_true", help="매장 간 이동 없이 (이전 방식)")
    ap.add_argument("--out", default="analysis")
    a = ap.parse_args()

    import engine as E
    stores = a.stores or E.load().stores.store_id.tolist()
    grid = QUICK if a.quick else GRID
    combos = [dict(zip(grid, v)) for v in itertools.product(*grid.values())]
    print(f"조합 {len(combos)}개 × 매장 {len(stores)}개 — 튜닝 기간 {a.tune_start} ~ {a.tune_end}")

    t0 = time.time()
    tr = not a.no_transfer
    print(f"매장 간 이동: {'반영' if tr else '미반영'}")
    res = evaluate([None] + combos, stores, a.tune_start, a.tune_end, a.jobs, a.hold_rate, tr)
    print(f"튜닝 완료 {time.time() - t0:.0f}s")
    best, rp, rule = pick(res)

    pd.set_option("display.width", 200)
    show = ["policy"] + KEYS + ["waste", "stockout", "lost_menu", "transfers", "lost_cost", "hold_cost", "total_cost"]
    print("\n[튜닝 기간 결과] 총비용 순 (총비용 = 소비기한 경과 폐기 + 품절 손실 + 재고 보유비용)")
    srt = res.sort_values(["policy", "total_cost"], ascending=[False, True])[show]
    print(_fmt(pd.concat([srt[srt.policy == "replay"], srt[srt.policy == "engine"].head(15)])).to_string(index=False))
    print(f"  (상위 15개만 표시, 전체 {len(res) - 1}개는 tune_results.csv)")
    print(f"\n선택 규칙: {rule}")
    print("선택 조합: " + ", ".join(f"{k}={best[k]}" for k in KEYS))

    # 검증 기간: 선택 조합 vs 현재 기본값(2차) vs 실제 발주 재생
    cur = dict(z=2.6, z_long=2.33, long_shelf=14, waste_ratio=0.5, z_boost=0.0, recent_w=0.5, surge_gain=0.0)
    sel = {k: (int(best[k]) if k == "long_shelf" else float(best[k])) for k in KEYS}
    test_list = [None, cur] + ([sel] if sel != cur else [])
    test = evaluate(test_list, stores, a.test_start, a.test_end, a.jobs, a.hold_rate, tr)
    def _label(r):
        if r.policy == "replay":
            return "실제 과거 발주 재생"
        vals = tuple(getattr(r, k) for k in KEYS)
        is_sel = vals == tuple(sel[k] for k in KEYS)
        is_cur = vals == tuple(cur[k] for k in KEYS)
        return "선택 조합 (= 현재 기본값)" if is_sel and is_cur else ("선택 조합" if is_sel else "현재 기본값(2차)")
    test["label"] = [_label(r) for r in test.itertuples()]
    print(f"\n[검증 기간 {a.test_start} ~ {a.test_end}] 튜닝에 쓰지 않은 기간")
    print(_fmt(test[["label"] + show[1:]]).to_string(index=False))

    Path(a.out).mkdir(exist_ok=True)
    res.to_csv(Path(a.out) / "tune_results.csv", index=False, encoding="utf-8-sig")
    test.to_csv(Path(a.out) / "tune_best.csv", index=False, encoding="utf-8-sig")
    print(f"\n저장: {a.out}/tune_results.csv, {a.out}/tune_best.csv")
    print("※ 선택 조합이 검증 기간에서도 현재 기본값보다 총비용이 낮으면 engine.py 상수 교체:")
    print("   RISK_LEVELS '보통'(z), Z_LONG, LONG_SHELF, WASTE_CUT_RATIO, Z_BOOST, RECENT_WEIGHT, SURGE_GAIN")


if __name__ == "__main__":
    main()