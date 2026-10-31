"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_SETTINGS, runEngine, type EngineResult, type EngineSettings, type Overrides } from "@/lib/engine";
import type { Snapshot } from "@/lib/types";

type AppState = {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  /** null = 서버 기본값(데이터 마지막 날 다음 날) */
  asOf: string | null;
  /** 로그인한 관리자의 매장 (서버가 세션으로 고정) */
  storeId: string | null;
  setAsOf: (d: string | null) => void;
  settings: EngineSettings;
  setSettings: (patch: Partial<EngineSettings>) => void;
  resetSettings: () => void;
  overrides: Overrides;
  setOverride: (ingredientId: string, units: number | undefined) => void;
  result: EngineResult | null;
  /** 사용자 입력 저장 후 스냅샷 다시 받기 (화면 깜빡임 없이 교체) */
  reload: () => void;
};

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [asOf, setAsOf] = useState<string | null>(null);
  // 로그인 화면에서는 데이터를 불러오지 않는다 (세션 없음)
  const onLogin = usePathname() === "/login";
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  /** 마지막으로 응답(성공·실패)을 받은 요청 키 — 현재 키와 다르면 로딩 중 */
  const [doneKey, setDoneKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = asOf ?? "";
  const loading = doneKey !== key;
  const [settings, setSettingsRaw] = useState<EngineSettings>(DEFAULT_SETTINGS);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (onLogin) return;
    const q = new URLSearchParams();
    if (asOf) q.set("asOf", asOf);
    const ctl = new AbortController();
    const reqKey = asOf ?? "";
    fetch(`/api/snapshot?${q}`, { signal: ctl.signal })
      .then(async (r) => {
        // 세션이 만료되면 로그인 화면으로
        if (r.status === 401) {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 세션 만료: 화면 상태까지 비우려고 전체 새로고침
          window.location.href = "/login";
          return Promise.reject(new DOMException("로그인 필요", "AbortError"));
        }
        return r.ok ? r.json() : Promise.reject(new Error((await r.json()).error ?? r.statusText));
      })
      .then((s: Snapshot) => { setSnapshot(s); setError(null); setDoneKey(reqKey); })
      .catch((e) => { if (e.name !== "AbortError") { setError(String(e.message ?? e)); setDoneKey(reqKey); } });
    return () => ctl.abort();
  }, [asOf, version, onLogin]);

  // 기준일이 바뀌면 수정값 초기화 (다른 상황의 수량을 이어 쓰지 않도록)
  const setAsOfReset = useCallback((d: string | null) => { setAsOf(d); setOverrides({}); }, []);
  const setSettings = useCallback((p: Partial<EngineSettings>) => setSettingsRaw((s) => ({ ...s, ...p })), []);
  const setOverride = useCallback((id: string, units: number | undefined) => setOverrides((o) => {
    const n = { ...o };
    if (units === undefined) delete n[id]; else n[id] = units;
    return n;
  }), []);

  const result = useMemo(() => (snapshot ? runEngine(snapshot, settings, overrides) : null), [snapshot, settings, overrides]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  const value: AppState = {
    snapshot, loading, error,
    // 서버가 기준일을 판매 기록 범위로 보정할 수 있으므로, 응답을 받은 뒤에는 서버 값을 표시
    asOf: (!loading && snapshot?.meta.asOf) || asOf || snapshot?.meta.asOf || null,
    storeId: snapshot?.meta.storeId ?? null,
    setAsOf: setAsOfReset, settings, setSettings, resetSettings: () => setSettingsRaw(DEFAULT_SETTINGS),
    overrides, setOverride, result, reload,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppStateProvider");
  return v;
}
