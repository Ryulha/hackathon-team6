"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildBriefContext, fallbackBrief, validBrief, type BriefResponse } from "@/lib/briefing";
import { useApp } from "@/state/app-state";
import { won } from "./format";

type Entry = { revision: string; loading: boolean; response: BriefResponse };
const qty = (n: number, unit: string) => `${n.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}${unit}`;

/** AI를 호출하지 않아도 기본 설명은 항상 표시한다. 입력이 바뀌면 이전 AI 해설을 숨긴다. */
export function OrderBriefing() {
  const { result, snapshot, settings } = useApp();
  const context = useMemo(() => result && snapshot ? buildBriefContext(snapshot, result, settings) : null, [result, snapshot, settings]);
  const revision = JSON.stringify(context);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);

  useEffect(() => () => controller.current?.abort(), [revision]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  if (!context) return null;
  const current = entry?.revision === revision ? entry : null;
  const response: BriefResponse = current?.response ?? { source: "calculation", brief: fallbackBrief(context), message: "계산 기반 기본 설명" };
  const explanations = new Map(response.brief.items.map((i) => [i.id, i.explanation]));
  const busy = !!entry?.loading;

  async function generate() {
    if (!context || inFlight.current || cooldown > 0) return;
    const base: BriefResponse = { source: "calculation", brief: fallbackBrief(context), message: "계산 기반 기본 설명" };
    const ctl = new AbortController();
    controller.current = ctl;
    inFlight.current = true;
    setCooldown(20);
    setEntry({ revision, loading: true, response: base });
    try {
      const r = await fetch("/api/briefing", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(context), signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(14_000)]),
      });
      const data: BriefResponse = await r.json();
      if (!r.ok || !["gemini", "calculation"].includes(data.source) || !validBrief(data.brief, context)) throw new Error("Invalid briefing");
      setEntry({ revision, loading: false, response: data });
      if (data.retryAfterSeconds) setCooldown(Math.min(30, Math.max(0, data.retryAfterSeconds)));
    } catch {
      setEntry({ revision, loading: false, response: {
        ...base, message: "AI 해설을 불러오지 못해 계산 기반 기본 설명을 표시합니다. 발주 기능은 계속 사용할 수 있습니다.",
      } });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <section className="card" aria-label="발주 해설">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="section-title">발주 해설</h3>
          <p className="hint mt-1">현재 입력한 수량 기준으로 먼저 확인할 품목을 정리했습니다.</p>
        </div>
        <button className="btn" onClick={generate} disabled={busy || cooldown > 0 || context.items.length === 0}>
          {busy ? "AI 해설 정리 중…" : cooldown > 0 ? `${cooldown}초 후 다시 요청` : "AI 해설 생성"}
        </button>
      </div>
      <div className="mt-3" role="status" aria-live="polite">
        <span className="badge badge-accent">{response.source === "gemini" ? "Gemini AI 해설" : "계산 기반 기본 설명"}</span>
        <p className="mt-2 text-sm font-medium">{response.brief.overview}</p>
        {response.message !== "계산 기반 기본 설명" && response.message !== "Gemini AI 해설" && <p className="hint mt-1">{response.message}</p>}
      </div>
      {context.supplierWarnings.map((w) => <p key={w.name} className="mt-2 text-sm text-[var(--high)]">{w.name}: 최소 발주금액까지 {won(w.gap)} 부족합니다.</p>)}
      <ul className="mt-3 grid gap-2">
        {context.items.map((item) => <li key={item.id} className="rounded-md bg-[var(--surface-2)] p-3 text-sm">
          <p><b>{item.name} · {item.action}</b></p>
          <p className="hint mt-1">입력 발주량 {qty(item.orderQty, item.orderUnit)} · {won(item.amount)} · 정기 입고 {item.arrival ?? "일정 없음"}</p>
          <p className="mt-1">{explanations.get(item.id) ?? item.reason}</p>
          {(item.existingWaste > 0 || item.additionalWaste > 0) && <p className="hint mt-1">해당 입고 주기에서 기존 재고 폐기 예상 {qty(item.existingWaste, item.useUnit)} · 추가 발주로 늘어나는 폐기 예상 {qty(item.additionalWaste, item.useUnit)}</p>}
        </li>)}
      </ul>
      <p className="hint mt-3">{context.itemCount > 5 ? `우선 확인할 5개 품목을 표시합니다. 전체 ${context.itemCount}개는 아래 발주서에서 확인하세요. ` : ""}수량·금액·입고일은 계산 결과이며 AI가 변경하지 않습니다. 사용기한에 따른 예상 폐기만 다루며 보관·조리·품질 폐기를 줄였다는 뜻은 아닙니다.</p>
      <p className="hint mt-1">AI 생성 버튼을 누르면 선택 매장의 계산 요약을 Google Gemini로 전송합니다. 원본 CSV 전체와 API 키는 브라우저에 전달하지 않습니다.</p>
      {response.source === "gemini" && response.generatedAt && <p className="hint mt-1">생성: {new Date(response.generatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (한국시간){response.cached ? " · 같은 조건의 저장된 해설" : ""}</p>}
    </section>
  );
}
