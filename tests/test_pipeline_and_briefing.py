from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import urllib.error

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pipeline as P
import engine as E
import briefing as B


@pytest.fixture(scope="module")
def prepared():
    t, _ = P.read_sources(P.ROOT / "data")
    menus = P.menu_panel(t)
    panel = P.ingredient_panel(t, menus)
    return t, menus, panel


@pytest.fixture(scope="module")
def D():
    return E.load()


@pytest.fixture(scope="module")
def current(D):
    day = pd.Timestamp("2026-09-15")
    df, state = E.recommend(D, "S03", day)
    df["qty"] = df.rec
    return df, state, day


def test_source_integrity(prepared):
    t, menus, panel = prepared
    checks = P.validate(t, menus, panel)
    assert not checks.status.eq("FAIL").any(), checks[checks.status.eq("FAIL")].to_dict("records")
    assert len(panel) == 273 * 3 * 22
    assert len(menus) == 273 * 3 * 16
    assert menus.lost_qty.sum() == t[9].lost_qty.sum() == 74
    assert panel.waste_cost.sum() == t[13].waste_cost.sum() == 2494848


def test_expiry_scope_and_pack_coverage(prepared):
    t, menus, panel = prepared
    eda, summary = P.eda_tables(t, menus, panel)
    reasons = eda["waste_reason_summary"].set_index("reason")
    assert reasons.waste_cost.sum() == 2494848
    assert reasons.loc["소비기한 경과", "waste_cost"] == 379545
    assert reasons.cost_share.sum() == pytest.approx(1)
    expiry = eda["waste_by_reason"].query("reason == '소비기한 경과'").set_index("ingredient_name")
    assert expiry.loc["양상추", "waste_cost"] == 168326
    assert "슬라이스 치즈" not in expiry.index
    assert "토마토" not in expiry.index
    coverage = eda["lettuce_pack_coverage"].set_index("store_id")
    assert coverage.observed_days.eq(273).all()
    assert coverage.loc["S01", "one_pack_days"] == pytest.approx(8000 / (4850560 / 273))
    assert coverage.loc["S03", "one_pack_days"] == pytest.approx(8000 / (1686995 / 273))
    assert summary["expiry_waste_cost"] == 379545


def test_unavailable_and_zero_sale_are_distinct(prepared):
    _, m, _ = prepared
    assert m[(m.store_id == "S02") & (m.menu_id == "M015")].observation_state.eq("미취급").all()
    # 단품 미출시 기간에도 세트는 취급.
    jan = m[(m.store_id == "S02") & (m.date < "2026-03-01")]
    assert not jan[jan.menu_id == "M007"].available.any()
    assert jan[jan.menu_id == "M008"].available.all()
    assert ((m.observation_state == "취급 중 판매 없음") & m.available).any()


def test_rolling_features_exclude_today(prepared):
    _, _, p = prepared
    g = p[(p.store_id == "S01") & (p.ingredient_id == "I001")].sort_values("date")
    assert pd.isna(g.consumed_avg_7d_past.iloc[0])
    assert g.consumed_avg_7d_past.iloc[7] == pytest.approx(g.consumed_qty.iloc[:7].mean())
    changed = g.consumed_qty.copy()
    changed.iloc[7:] = 999999
    assert changed.shift(1).rolling(7).mean().iloc[7] == pytest.approx(g.consumed_avg_7d_past.iloc[7])


def test_validation_detects_corrupted_balance(prepared):
    t, menus, panel = prepared
    broken = panel.copy()
    broken.loc[0, "inventory_balance_diff"] = 1
    checks = P.validate(t, menus, broken)
    assert checks.set_index("check").loc["기말 재고 수지", "status"] == "FAIL"


def test_duplicate_availability_rejected(prepared):
    t, _, _ = prepared
    broken = dict(t)
    broken[15] = pd.concat([t[15], t[15].iloc[[0]]], ignore_index=True)
    with pytest.raises(ValueError, match="중복"):
        P.menu_panel(broken)


@pytest.mark.parametrize("store,day", [("S01", "2026-02-01"), ("S02", "2026-09-03"), ("S03", "2026-09-15")])
def test_morning_inventory_matches_actual_count(D, store, day):
    day = pd.Timestamp(day)
    lots = E.morning_lots(D, store, day).groupby("ingredient_id").qty.sum()
    actual = D.inv[(D.inv.store_id == store) & (D.inv.date == day)].set_index("ingredient_id").counted_qty
    assert np.allclose(lots.reindex(actual.index, fill_value=0), actual)


def test_promo_multiplier_does_not_read_future(D):
    day = pd.Timestamp("2026-06-01")
    original = E.forecast_menus(D, "S02", day, 3, promo_on=True)
    changed = deepcopy(D)
    changed.daily.loc[changed.daily.date >= day, "y"] = 999999
    after = E.forecast_menus(changed, "S02", day, 3, promo_on=True)
    pd.testing.assert_frame_equal(original, after)
    assert original.attrs["promo_mult"] == 1


def test_modified_qty_changes_briefing_and_fingerprint(D, current):
    df, state, day = current
    context = B.build_context(D, df, state, "S03", day, "보통")
    modified = df.copy()
    index = modified[modified.can_order].index[0]
    modified.loc[index, "qty"] += 1
    after = B.build_context(D, modified, state, "S03", day, "보통")
    assert B.context_hash(context) != B.context_hash(after)
    assert after["total_amount"] == context["total_amount"] + modified.loc[index, "price"]
    assert len(after["items"]) == 22


def test_zero_qty_recalculates_shortage(D, current):
    df, state, day = current
    modified = df.copy()
    modified["qty"] = 0
    context = B.build_context(D, modified, state, "S03", day, "보통")
    assert context["total_amount"] == 0
    assert any(x["shortage_after_arrival"] > 0 for x in context["items"])


def valid_result(context):
    return {"overview": "입고 전 부족과 공급사 조건부터 확인하세요.", "items": [{"ingredient_id": x["ingredient_id"], "explanation": x["explanation"]} for x in context["items"]]}


def test_openai_request_and_response_parsing(D, current):
    df, state, day = current
    context = B.build_context(D, df, state, "S03", day, "보통")
    def transport(req, timeout):
        body = json.loads(req.data)
        assert body["store"] is False
        assert body["text"]["format"]["strict"] is True
        assert req.full_url == "https://api.openai.com/v1/responses"
        assert timeout == 45
        return io.BytesIO(json.dumps({"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps(valid_result(context))}]}]}).encode())
    brief = B.generate_brief(context, "test-key", transport=transport)
    assert brief["source"].startswith("OpenAI")
    assert len(brief["items"]) == 22
    assert "test-key" not in B.markdown_report(context, brief)


@pytest.mark.parametrize("corruption", ["number", "unknown_id", "duplicate", "missing"])
def test_bad_ai_response_rejected(D, current, corruption):
    df, state, day = current
    context = B.build_context(D, df, state, "S03", day, "보통")
    bad = valid_result(context)
    if corruption == "number":
        bad["items"][0]["explanation"] = "추가로 999박스 시키세요."
    elif corruption == "unknown_id":
        bad["items"][0]["ingredient_id"] = "I999"
    elif corruption == "duplicate":
        bad["items"][1] = bad["items"][0]
    else:
        bad["items"].pop()
    with pytest.raises(B.BriefingError):
        B.validate_brief(bad, context)


def test_network_failure_and_missing_key_fallback(D, current):
    df, state, day = current
    context = B.build_context(D, df, state, "S03", day, "보통")
    with pytest.raises(B.BriefingError, match="API 키"):
        B.generate_brief(context, "")
    def broken(req, timeout):
        raise urllib.error.URLError("private network details")
    with pytest.raises(B.BriefingError) as info:
        B.generate_brief(context, "test-key", transport=broken)
    assert "private" not in str(info.value)
    assert B.default_brief(context)["source"] == "계산 기반 기본 브리핑"
