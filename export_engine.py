"""
export_engine.py — engine.py 추천 결과를 웹(Next.js)용 JSON으로 내보내기 (3번 파트)

원본 CSV는 깃·배포에 올리지 않으므로, 로컬에서 엔진을 돌려 계산 결과만 JSON으로 만든다.
웹은 이 JSON을 읽어 매장·기준일·위험 수준을 바꿀 때마다 해당 결과를 보여 준다.

실행 (engine.py와 data/가 있는 폴더에서):
    python export_engine.py --out ../hackathon-team6/web/src/data/generated/engine
    python export_engine.py --start 2026-09-01 --end 2026-10-01 --extra 2026-01-27 --out <경로>

출력:
    <out>/index.json        매장 목록, 기준일 목록, 위험 수준, 생성 정보
    <out>/S01.json …        매장별 { "날짜": { "normal": {meta, items, suppliers}, "loose": …, "tight": … } }
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd

import engine as E

RISKS = {"loose": "넉넉하게", "normal": "보통", "tight": "타이트하게"}

# 화면에 필요한 품목 컬럼만 (용량 절감). 필요하면 추가
ITEM_COLS = [
    "ingredient_id", "품목", "supplier_id", "공급사", "보관", "use_unit", "order_unit", "pack", "shelf",
    "can_order", "arrival", "next_arrival", "on_hand", "avg", "days_left", "stockout_date",
    "lost_before_arrival", "lost_window", "ss", "need", "rec", "amount", "price", "status",
    "waste3", "expiring_qty", "expiring_date",
    "stockout_28d", "stockout_hour", "z_used", "rec_before", "waste_cut", "waste_before", "waste_after",
    "adj_reason", "surge_ratio", "surge_mult",
]


def _clean(v):
    if v is None:
        return None
    if isinstance(v, pd.Timestamp):
        return None if pd.isna(v) else v.strftime("%Y-%m-%d")
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, (float, np.floating)):
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else round(f, 2)
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v


def z_of(risk_key: str) -> float:
    for name, z in E.RISK_LEVELS.items():
        if name.startswith(RISKS[risk_key]):
            return float(z)
    raise KeyError(risk_key)


def one(D, store, day, z):
    df, st = E.recommend(D, store, day, z=z)
    sup_idx = D.sup.set_index("supplier_id")
    suppliers = []
    for sid, sub in df.groupby("supplier_id"):
        total = float((sub.rec * sub.price).sum())
        gap, urgent, plan = E.min_amount_fix(D, df, sid)
        if total == 0:
            gap = 0
        suppliers.append({k: _clean(v) for k, v in dict(
            supplier_id=sid, supplier_name=sub["공급사"].iloc[0],
            order_cutoff=sup_idx.loc[sid].get("order_cutoff") if "order_cutoff" in sup_idx.columns else None,
            can_order=bool(sub.can_order.iloc[0]), arrival=sub.arrival.iloc[0], next_arrival=sub.next_arrival.iloc[0],
            item_count=int((sub.rec > 0).sum()), total_amount=total,
            min_order_amount=float(sup_idx.loc[sid, "min_order_amount"]), gap=float(gap), urgent=bool(urgent),
        ).items()} | {"fill_plan": [{k: _clean(v) for k, v in r.items()} for r in plan.to_dict("records")]
                      if len(plan) else []})
    fm = st["fm"]
    cols = [c for c in ITEM_COLS if c in df.columns]
    return dict(
        meta=dict(store_id=store, date=day.strftime("%Y-%m-%d"), z=z,
                  surge_ratio=_clean(fm.attrs.get("surge_ratio", 1.0)),
                  surge_mult=_clean(fm.attrs.get("surge_mult", 1.0))),
        items=[{k: _clean(v) for k, v in r.items()} for r in df[cols].to_dict("records")],
        suppliers=suppliers,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-09-01")
    ap.add_argument("--end", default="2026-10-01")
    ap.add_argument("--extra", nargs="*", default=["2026-01-27"], help="추가로 포함할 날짜 (시연 장면 등)")
    ap.add_argument("--stores", nargs="*", default=None)
    ap.add_argument("--out", default="engine_json")
    a = ap.parse_args()

    D = E.load()
    stores = a.stores or D.stores.store_id.tolist()
    dates = sorted(set(pd.date_range(a.start, a.end)) | {pd.Timestamp(x) for x in a.extra})
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    for s in stores:
        res = {}
        for d in dates:
            res[d.strftime("%Y-%m-%d")] = {rk: one(D, s, d, z_of(rk)) for rk in RISKS}
        p = out / f"{s}.json"
        p.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  {s}: {len(dates)}일 × 위험 수준 3 → {p} ({p.stat().st_size / 1e6:.1f}MB, {time.time() - t0:.0f}s)")

    index = dict(
        stores=[dict(store_id=r.store_id, store_name=getattr(r, "store_name", r.store_id))
                for r in D.stores.itertuples() if r.store_id in stores],
        dates=[d.strftime("%Y-%m-%d") for d in dates],
        risk_levels={rk: dict(label=RISKS[rk], z=z_of(rk)) for rk in RISKS},
        engine=dict(recent_weight=E.RECENT_WEIGHT, surge_gain=E.SURGE_GAIN, waste_cut_ratio=E.WASTE_CUT_RATIO),
        generated_at=pd.Timestamp.now().strftime("%Y-%m-%d %H:%M"),
        note="합성 데이터·가상 금액. engine.py 추천 결과를 미리 계산한 값",
    )
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"완료: {out}/index.json")


if __name__ == "__main__":
    main()
