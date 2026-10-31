"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_SETTINGS, runEngine, type EngineResult, type EngineSettings, type Overrides } from "@/lib/engine";
import type { Snapshot } from "@/lib/types";

type AppState = {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  /** null = 서버 기본값(데이터 마지막 날 다음 날) */
  asOf: string | null;
  storeId: string | null;
  setAsOf: (d: string | null) => void;
  setStoreId: (s: string) => void;
  settings: EngineSettings;
  setSettings: (patch: Partial<EngineSettings>) => void;
  resetSettings: () => void;
  overrides: Overrides;
  setOverride: (ingredientId: string, units: number | undefined) => void;
  result: EngineResult | null;
};

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [asOf, setAsOf] = useState<string | null>(null);
  const [storeId, setStoreIdRaw] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  /** 마지막으로 응답(성공·실패)을 받은 요청 키 — 현재 키와 다르면 로딩 중 */
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${asOf ?? ""}|${storeId ?? ""}`;
  const loading = doneKey !== key;
  const [settings, setSettingsRaw] = useState<EngineSettings>(DEFAULT_SETTINGS);
  const [overrides, setOverrides] = useState<Overrides>({});

  useEffect(() => {
    const q = new URLSearchParams();
    if (asOf) q.set("asOf", asOf);
    if (storeId) q.set("store", storeId);
    const ctl = new AbortController();
    const reqKey = `${asOf ?? ""}|${storeId ?? ""}`;
    fetch(`/api/snapshot?${q}`, { signal: ctl.signal })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error ?? r.statusText))))
      .then((s: Snapshot) => { setSnapshot(s); setError(null); setDoneKey(reqKey); })
      .catch((e) => { if (e.name !== "AbortError") { setError(String(e.message ?? e)); setDoneKey(reqKey); } });
    return () => ctl.abort();
  }, [asOf, storeId]);

  // 기준일·매장이 바뀌면 수정값 초기화 (다른 상황의 수량을 이어 쓰지 않도록)
  const setStoreId = useCallback((s: string) => { setStoreIdRaw(s); setOverrides({}); }, []);
  const setAsOfReset = useCallback((d: string | null) => { setAsOf(d); setOverrides({}); }, []);
  const setSettings = useCallback((p: Partial<EngineSettings>) => setSettingsRaw((s) => ({ ...s, ...p })), []);
  const setOverride = useCallback((id: string, units: number | undefined) => setOverrides((o) => {
    const n = { ...o };
    if (units === undefined) delete n[id]; else n[id] = units;
    return n;
  }), []);

  const result = useMemo(() => (snapshot ? runEngine(snapshot, settings, overrides) : null), [snapshot, settings, overrides]);

  const value: AppState = {
    snapshot, loading, error, asOf: asOf ?? snapshot?.meta.asOf ?? null, storeId: storeId ?? snapshot?.meta.storeId ?? null,
    setAsOf: setAsOfReset, setStoreId, settings, setSettings, resetSettings: () => setSettingsRaw(DEFAULT_SETTINGS),
    overrides, setOverride, result,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppStateProvider");
  return v;
}
