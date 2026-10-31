"use client";

import { useEffect, useState } from "react";
import type { Insights } from "@/lib/insights";

const cache = new Map<string, Insights>();

/** 팀 데이터 분석 결과 — 매장별로 한 번만 받아 둔다. 실패하거나 DB 가 없으면 null (카드 숨김) */
export function useInsights(storeId: string | undefined): Insights | null {
  const [data, setData] = useState<{ store: string; value: Insights } | null>(null);
  useEffect(() => {
    if (!storeId || cache.has(storeId)) return;
    let alive = true;
    fetch(`/api/insights?store=${encodeURIComponent(storeId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v: Insights | null) => {
        if (v) cache.set(storeId, v);
        if (alive && v) setData({ store: storeId, value: v });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [storeId]);
  const v = storeId ? cache.get(storeId) ?? (data?.store === storeId ? data.value : undefined) : undefined;
  return v?.available ? v : null;
}
