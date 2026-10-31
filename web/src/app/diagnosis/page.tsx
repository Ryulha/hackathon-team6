"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { RULES, type StoreDiagnosis } from "@/lib/diagnosis";
import { shortDate } from "@/lib/engine/dates";
import { useApp } from "@/state/app-state";

type Store = StoreDiagnosis & { weekly: { week: string; sales: number; foodRatio: number }[]; checks: { done: number; total: number } | null };
type Summary = { weeks: number; cur: { from: string; to: string }; prev: { from: string; to: string }; stores: Store[] };

const eok = (v: number) => (v >= 1e8 ? `${(v / 1e8).toFixed(2)}억` : `${Math.round(v / 1e4).toLocaleString("ko-KR")}만`);
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

/** 슈퍼바이저 첫 화면 — 매장 방문 전 손익 파악·문제 진단 */
export default function DiagnosisPage() {
  const { setViewStore } = useApp();
  const router = useRouter();
  const [weeks, setWeeks] = useState(4);
  const [data, setData] = useState<{ weeks: number; value: Summary } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(`/api/supervisor/summary?weeks=${weeks}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error ?? r.statusText))))
      .then((v: Summary) => { if (alive) { setData({ weeks, value: v }); setErr(""); } })
      .catch((e) => { if (alive) setErr(String(e.message ?? e)); });
    return () => { alive = false; };
  }, [weeks]);

  const d = data?.value;
  const loading = data?.weeks !== weeks;
  const stores = d ? [...d.stores].sort((a, b) => b.flags.length - a.flags.length || b.foodOverTarget - a.foodOverTarget) : [];
  const flagged = stores.filter((s) => s.flags.length).length;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="hint">{d ? `${shortDate(d.cur.from)} ~ ${shortDate(d.cur.to)} · 직전 ${weeks}주와 비교` : "불러오는 중"}</p>
          <h2 className="text-2xl font-bold tracking-[-0.02em]">매장 진단</h2>
        </div>
        <div className="tabs" role="radiogroup" aria-label="기간">
          {[2, 4, 8].map((w) => (
            <button key={w} role="radio" aria-checked={weeks === w} className="tab" onClick={() => setWeeks(w)}>{w}주</button>
          ))}
        </div>
      </header>

      {err && <div className="status status-err">{err}</div>}
      {d && (
        <p className="text-sm">
          {flagged ? <><b className="text-[var(--high)]">{flagged}개 매장</b>에 방문 전 확인할 것이 있어요.</> : "모든 매장이 평소 수준이에요."}
          <span className="hint ml-1">경고 기준: 식자재비율이 관리 기준 {RULES.foodRatioTarget * 100}%를 넘거나 다른 매장 평균·직전 기간보다 {RULES.foodRatioPp * 100}%p 이상 높을 때, 폐기율이 {RULES.wasteTimes}배 이상, 긴급발주·품절이 있을 때</span>
        </p>
      )}
      {!d && !err && <div className="card h-40 animate-pulse" style={{ background: "var(--surface-2)" }} />}

      <div className={`grid gap-3 lg:grid-cols-3 ${loading && d ? "opacity-60" : ""}`}>
        {stores.map((s) => (
          <article key={s.storeId} className="card flex flex-col gap-3" style={{ borderTop: `3px solid ${s.flags.length ? "var(--high)" : "var(--brand)"}` }}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-lg font-bold">{s.storeName}</h3>
              {s.flags.length ? <span className="badge badge-high">확인 필요 {s.flags.length}</span> : <span className="badge badge-accent">양호</span>}
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <Metric label="매출" value={eok(s.cur.sales)} sub={s.prev.sales ? `직전 대비 ${s.cur.sales >= s.prev.sales ? "+" : ""}${pct(s.cur.sales / s.prev.sales - 1, 0)}` : ""} />
              <Metric label={`식자재비율 (기준 ${RULES.foodRatioTarget * 100}%)`} value={pct(s.foodRatio)} warn={s.flags.some((f) => f.key === "food")}
                sub={`직전 ${pct(s.prevFoodRatio)} · 타매장 ${pct(s.othersFoodRatio)}`} />
              <Metric label={`인건비율 (기준 ${RULES.laborRatioTarget * 100}%)`} value="자료 없음" sub="인건비 데이터가 제공되지 않음" />
              <Metric label="폐기율" value={pct(s.wasteRatio, 2)} warn={s.flags.some((f) => f.key === "waste")}
                sub={`${Math.round(s.cur.waste).toLocaleString("ko-KR")}원 · 기한경과 ${s.cur.waste ? pct(s.cur.expiryWaste / s.cur.waste, 0) : "0%"}`} />
              <Metric label="품절·긴급발주" value={`${s.cur.lostQty}개 · ${s.cur.emergencyCount}회`} warn={s.flags.some((f) => f.key === "lost" || f.key === "emergency")}
                sub={`${s.cur.lostAmount ? `못 판 금액 약 ${Math.round(s.cur.lostAmount).toLocaleString("ko-KR")}원` : "품절 없음"}${s.transfersIn ? ` · 다른 매장서 ${s.transfersIn}번 빌려 옴` : ""}`} />
            </dl>

            {s.weekly.length > 1 && (
              <div>
                <p className="hint">주별 식자재비율</p>
                <div className="h-14">
                  <ResponsiveContainer>
                    <LineChart data={s.weekly.map((w) => ({ ...w, r: +(w.foodRatio * 100).toFixed(2) }))} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                      <YAxis hide domain={["dataMin - 0.5", "dataMax + 0.5"]} />
                      <Tooltip formatter={(v) => `${v}%`} labelFormatter={(_, p) => (p?.[0] ? `${shortDate(String(p[0].payload.week))} 주` : "")}
                        contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
                      <Line dataKey="r" stroke="var(--foreground)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {s.flags.length > 0 && (
              <div className="rounded-md p-3 text-sm" style={{ background: "var(--high-soft)" }}>
                <p className="font-semibold text-[var(--high)]">방문 전 확인할 것</p>
                <ul className="mt-1 ml-4 list-disc space-y-0.5">{s.flags.map((f, i) => <li key={i}>{f.text}</li>)}</ul>
                {s.actions.length > 0 && (
                  <>
                    <p className="mt-2 font-semibold">준비할 해결책</p>
                    <ul className="mt-1 ml-4 list-disc space-y-0.5">{s.actions.map((a, i) => <li key={i}>{a}</li>)}</ul>
                  </>
                )}
              </div>
            )}

            <div className="mt-auto flex items-center justify-between gap-2 text-sm">
              <span className="hint">{s.checks ? `오늘 점검 ${s.checks.done}/${s.checks.total}` : "오늘 점검 기록 없음"}</span>
              <button className="btn !rounded-full" onClick={() => { setViewStore(s.storeId); router.push("/overview"); }}>매장 자세히 →</button>
            </div>
          </article>
        ))}
      </div>
      <p className="hint">식자재비 = 실제 소진량 × 단가(팀 분석 결과), 식자재비율 = 식자재비 ÷ 매출. 관리 기준(식자재비율 30%, 인건비율 20%)은 현장 인터뷰 기준이며, 인건비는 제공 데이터에 없어 계산하지 않았습니다. 합성 데이터 기준이라 실제 매장 성과와 무관합니다.</p>
    </>
  );
}

function Metric({ label, value, sub, warn = false }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div>
      <dt className="hint">{label}</dt>
      <dd className="text-base font-bold tabular-nums" style={{ color: warn ? "var(--high)" : undefined }}>{warn && "⚠ "}{value}</dd>
      {sub && <dd className="hint tabular-nums">{sub}</dd>}
    </div>
  );
}
