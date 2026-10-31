"""Reproducible audit of all 17 provided files, without rewriting sources."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .data import FILES, KEYS, build_daily_panel, source_hashes, validate_data


def run_audit(data, output_dir="outputs/audit", doc_path="docs/DATA_AUDIT.md"):
    validate_data(data)
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    records = []
    for name, filename in FILES.items():
        frame = data[name]
        records.append({"file": filename, "rows": len(frame), "columns": list(frame.columns),
                        "dtypes": {c: str(t) for c, t in frame.dtypes.items()},
                        "missing": {c: int(n) for c, n in frame.isna().sum().items()},
                        "duplicate_rows": int(frame.duplicated().sum()),
                        "key": KEYS.get(name, []),
                        "duplicate_keys": int(frame.duplicated(KEYS[name]).sum()) if name in KEYS else None})
    panel = build_daily_panel(data)
    sales = data["sales"]
    daily = sales.groupby(["date", "store_id", "menu_id"], as_index=False)[["qty", "cancel_qty"]].sum()
    daily["net_qty"] = daily.qty - daily.cancel_qty
    consumed = daily.merge(data["bom"], on="menu_id")
    consumed["bom_use"] = consumed.net_qty * consumed.qty_per_menu
    consumed = consumed.groupby(["date", "store_id", "ingredient_id"], as_index=False).bom_use.sum()
    inv = data["inventory"].merge(consumed, on=["date", "store_id", "ingredient_id"], how="left")
    consumption_errors = int((~np.isclose(inv.consumed_qty, inv.bom_use.fillna(0))).sum())
    inventory_errors = int((inv.closing_qty != inv.opening_qty + inv.received_qty + inv.adjust_qty + inv.transfer_in_qty - inv.transfer_out_qty - inv.consumed_qty - inv.waste_qty).sum())
    promo_expected = np.zeros(len(sales), dtype=int)
    for row in data["promotions"].itertuples():
        promo_expected[sales.store_id.eq(row.store_id) & sales.date.between(row.start_date, row.end_date)] = 1
    promo_errors = int((promo_expected != sales.promo_flag).sum())
    missing_active = panel.is_available & panel.demand_qty.eq(0)
    daily_record_keys = sales[["date", "store_id", "menu_id"]].drop_duplicates()
    active_with_records = panel.loc[panel.is_available].merge(daily_record_keys, on=["date", "store_id", "menu_id"])
    receipts = data["receipts"]
    checks = {
        "qty_identity_errors": int((sales.qty != sales.demand_qty - sales.lost_qty).sum()),
        "negative_net_qty_rows": int((sales.qty - sales.cancel_qty < 0).sum()),
        "bom_consumption_errors": consumption_errors, "inventory_balance_errors": inventory_errors,
        "promo_period_flag_errors": promo_errors,
        "receipt_unknown_po_line": int((~receipts.po_line_id.isin(data["orders"].po_line_id)).sum()),
        "inactive_panel_days": int((~panel.is_available).sum()),
        "active_panel_days": int(panel.is_available.sum()), "active_zero_demand_days": int(missing_active.sum()),
        "active_days_without_sales_rows": int(panel.is_available.sum() - len(active_with_records)),
        "demand_qty_total": int(sales.demand_qty.sum()), "accepted_qty_total": int(sales.qty.sum()),
        "lost_qty_total": int(sales.lost_qty.sum()), "cancel_qty_total": int(sales.cancel_qty.sum()),
        "net_qty_total": int((sales.qty - sales.cancel_qty).sum()),
    }
    hashes = source_hashes(data.data_dir)
    # Include original README/specification and source PDFs in the preservation manifest.
    originals = list(data.data_dir.parent.glob("*.md")) + list(data.data_dir.parent.parent.glob("*.pdf"))
    import hashlib
    for path in originals:
        hashes[str(path.resolve())] = hashlib.sha256(path.read_bytes()).hexdigest()
    (directory / "source_manifest.json").write_text(json.dumps(hashes, ensure_ascii=False, indent=2), encoding="utf-8")
    payload = {"files": records, "checks": checks}
    (directory / "audit.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# 데이터 감사", "", "근거: 제공 `데이터명세서.md`와 실제 CSV 17개. 합성 데이터이며 실제 매장 성과가 아니다.", "",
             f"날짜: {sales.date.min().date()} ~ {sales.date.max().date()}; 매장 {len(data['stores'])}, 메뉴 {len(data['menus'])}, 식자재 {len(data['ingredients'])}.", "",
             "Git: 시작 시 저장소가 없었으므로 추적된 원본도 없음. 원격 push/배포 미수행. .gitignore에 원본 폴더, CSV, PDF, outputs, models 제외.", "",
             "## 개별 파일 검사", "", "| 파일 | 행 | 컬럼 | 전체행 중복 | 키 중복 | 결측 컬럼(개수) |", "|---|---:|---:|---:|---:|---|"]
    for rec in records:
        missing = ", ".join(f"{k}({v})" for k, v in rec["missing"].items() if v) or "없음"
        dupkey = rec["duplicate_keys"] if rec["duplicate_keys"] is not None else "이벤트; 키 미지정"
        lines.append(f"| {rec['file']} | {rec['rows']:,} | {len(rec['columns'])} | {rec['duplicate_rows']} | {dupkey} | {missing} |")
    lines += ["", "컬럼별 자료형·결측 수·키 전체는 `outputs/audit/audit.json`에 보존한다.", "", "## 수량·관계 검증", ""]
    lines += [f"- `{key}`: {value:,}" for key, value in checks.items()]
    lines += ["", "매장/메뉴/식자재/공급사 외래키, 판매 키, 취급 구간 중첩, 취급 외 판매, 달력 연속성, BOM 단위·양수량·메뉴 커버리지 모두 로더에서 검증하며 위반 시 중단한다.",
              "영수증 연결은 po_line_id를 확인했다. 발주·로트의 생성 정책 전체 재생은 본 예측 범위에 포함하지 않는다.", "",
              "## 전처리 정책과 근거", "",
              "- Target = 시간대·채널별 demand_qty의 일별 합. qty = demand_qty − lost_qty, 판매 확정량 = qty − cancel_qty. 확정량 × 메뉴 자체 BOM을 재고 consumed_qty와 비교했다.",
              "- 3×16×273 전체 일별 패널에서 취급 중 판매 행이 없는 날만 0으로 보충한다. 미취급 기간은 demand_qty=NaN으로 유지하고 학습/평가에서 제외한다. 추론에는 is_available=0 및 0 예측을 명시한다.",
              "- 각 메뉴의 취급 기간을 그대로 사용한다. M007의 취급 시점을 M008에 전파하지 않는다. 취급 달력은 미래에 이미 알려진 일정이라고 가정한다.",
              "- 세트는 04_bom의 세트 BOM만 1회 연결한다. set_components를 펼치지 않는다. ingredient_id × use_unit별 합계만 생성하며 다른 품목·단위의 총합은 계산하지 않는다.",
              "- 행사 기간 표시와 실제 대상 메뉴는 별도 Feature. P01은 S02, 2026-07-07~07-31, M004/M005. 1개 행사뿐이며 학습 기간 1~6월에는 사례가 없어 효과 추정/인과 해석을 하지 않는다.",
              "- 비어 있는 holiday_name은 공휴일 아님, set_components는 단품에 해당 없음으로 문서 정의에 따라 허용한다. S02/M015는 전체 미취급이며 start_date/end_date가 모두 비어 있다. 이를 잘못된 날짜로 삭제하거나 0 수요로 학습하지 않는다. 취급 상태의 날짜 누락은 오류로 처리한다.",
              "- 학습은 28일 이력 확보 후 2026-01-29부터 시작. Target 기준 Train ≤06-30, Validation 07-01~07-31, Test 08-01~09-30. 원본의 1월 초기재고 미래 참조 문제를 피하도록 재고/로트/발주/당일 품절 필드를 Feature에 사용하지 않는다.", "",
              "## 개발자가 추가한 가정 / 한계", "",
              "- 기준 시점은 한국시간 영업 시작 전 00:00 경계. 당일 판매는 전부 미관측으로 취급한다.",
              "- 공휴일·행사·취급 일정은 기준 시점에 알려졌다고 가정하지만 공지 시점 이력이 없어 사실상 검증할 수 없다. 미래 운영 일정 변경 시 입력 스냅샷 관리가 필요하다.",
              "- 최근 56일 취소율은 sum(cancel_qty)/sum(qty). 매장·메뉴 분모 0이면 메뉴 전체 → 전체 → 0 순 fallback. 전 수요 충족 시에도 같은 취소율이라는 가정을 사용한다.",
              "- 제공 달력/취급 일정은 9월 30일까지다. 범위 밖 예측은 임의 공휴일/취급 가정 대신 오류를 반환한다. 이후 예측은 새 일정과 최신 판매를 공급해야 한다.",
              "- 명세에 알려진 발주 경계 2건, 로트 전개 3건은 원본을 보정하지 않는다. 본 모델에 해당 데이터를 사용하지 않는다.",
              "- 원본 파일은 변경하지 않는다. `outputs/audit/source_manifest.json`의 SHA-256으로 완료 시 다시 검증한다."]
    path = Path(doc_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return payload
