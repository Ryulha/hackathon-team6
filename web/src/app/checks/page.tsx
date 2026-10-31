"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { shortDate } from "@/lib/engine/dates";
import { useApp } from "@/state/app-state";

type Item = { id: number; name: string; kind: "check" | "temp" | "expiry" | "count"; slot: "open" | "lunch" | "close"; minValue: number | null; maxValue: number | null; active: boolean };
type Log = { id: number; itemId: number; value: number | null; byName: string; createdAt: string };

const SLOTS = [
  { key: "open", label: "오픈 전", hint: "07시 입고 후 ~ 영업 시작 전" },
  { key: "lunch", label: "점심 후", hint: "한가해질 때" },
  { key: "close", label: "마감", hint: "영업 종료 후" },
] as const;
const POLL_MS = 20_000;

// ---------- 내 이름 (휴대폰에 한 번 저장) ----------
const nameKey = (store: string) => `cc-staff-name:${store}`;
const NAME_EVENT = "cc-staff-name";
const subscribeName = (cb: () => void) => {
  window.addEventListener(NAME_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => { window.removeEventListener(NAME_EVENT, cb); window.removeEventListener("storage", cb); };
};
function useMyName(store: string | null): [string, (n: string) => void] {
  const name = useSyncExternalStore(subscribeName, () => {
    try { return store ? localStorage.getItem(nameKey(store)) ?? "" : ""; } catch { return ""; }
  }, () => "");
  const set = useCallback((n: string) => {
    try { if (store) localStorage.setItem(nameKey(store), n); } catch { /* 저장 불가 환경 */ }
    window.dispatchEvent(new Event(NAME_EVENT));
  }, [store]);
  return [name, set];
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const outOfRange = (it: Item, v: number | null) => v != null && ((it.minValue != null && v < it.minValue) || (it.maxValue != null && v > it.maxValue));
const range = (it: Item) => (it.minValue != null && it.maxValue != null ? `${it.minValue}~${it.maxValue}℃` : it.maxValue != null ? `${it.maxValue}℃ 이하` : it.minValue != null ? `${it.minValue}℃ 이상` : "");

/**
 * 오늘 점검 — 점검 가능한 때 빠르게 기록하고, 다른 직원도 완료 여부를 바로 보게 해서 중복 점검을 없앤다.
 */
export default function ChecksPage() {
  const { snapshot, result, me } = useApp();
  const date = snapshot?.meta.asOf ?? null;
  const store = snapshot?.meta.storeId ?? null;
  const [name, setName] = useMyName(store);
  const [data, setData] = useState<{ items: Item[]; logs: Log[] } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // 다른 직원 기록 반영: 열 때 · 화면으로 돌아올 때 · 20초마다
  useEffect(() => {
    if (!date) return;
    let alive = true;
    fetch(`/api/checks?date=${date}`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (alive && d) { setData(d); setUpdatedAt(Date.now()); }
    }).catch(() => {});
    return () => { alive = false; };
  }, [date, tick]);
  useEffect(() => {
    const t = setInterval(refresh, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);

  if (!snapshot || !date) return null;
  if (!name) return <NamePicker onPick={setName} isManager={me?.role === "manager"} />;

  const items = (data?.items ?? []).filter((i) => i.active);
  const logOf = new Map((data?.logs ?? []).map((l) => [l.itemId, l]));
  const done = items.filter((i) => logOf.has(i.id)).length;
  const expiring = result?.alerts.filter((a) => a.kind === "expiry").map((a) => snapshot.ingredients.find((i) => i.ingredient_id === a.ingredientId)?.ingredient_name).filter(Boolean) ?? [];

  async function record(it: Item, value?: number) {
    setMsg(null);
    const r = await fetch("/api/checks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: it.id, date, value, byName: name }) }).catch(() => null);
    const body = await r?.json().catch(() => null);
    if (r?.status === 409 && body?.log) setMsg({ ok: false, text: `이미 ${body.log.byName}님이 ${hhmm(body.log.createdAt)}에 기록했어요. 다시 안 해도 돼요.` });
    else if (!r?.ok) setMsg({ ok: false, text: body?.error ?? "저장하지 못했어요. 다시 눌러 주세요." });
    else if (it.kind === "temp" && outOfRange(it, value ?? null)) setMsg({ ok: false, text: `${it.name} ${value}℃ — 기준(${range(it)})을 벗어났어요. 점장님께 알려 주세요.` });
    refresh();
  }
  async function undo(log: Log) {
    await fetch(`/api/checks?id=${log.id}`, { method: "DELETE" }).catch(() => null);
    refresh();
  }

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="hint">{shortDate(date)}{updatedAt && ` · ${hhmm(new Date(updatedAt).toISOString())} 업데이트`}</p>
          <h2 className="text-2xl font-bold tracking-[-0.02em]">오늘 점검</h2>
        </div>
        <p className="text-sm">나: <b>{name}</b> <button className="btn-ghost !px-1.5 !py-0.5 text-xs" onClick={() => setName("")}>바꾸기</button></p>
      </header>

      {items.length > 0 && (
        <div className="flex items-center gap-2" aria-label={`${items.length}개 중 ${done}개 완료`}>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div className="h-full rounded-full" style={{ width: `${(done / items.length) * 100}%`, background: "var(--brand)", transition: "width 200ms var(--ease-out)" }} />
          </div>
          <span className="text-sm whitespace-nowrap"><b>{items.length}개 중 {done}개</b> 완료</span>
        </div>
      )}
      <p className="hint -mt-2">다른 직원이 한 점검도 여기 바로 보여요. 체크된 건 다시 안 해도 됩니다.</p>
      {msg && <div role="status" className={`status ${msg.ok ? "status-ok" : "status-err"}`}>{msg.text}</div>}
      {!data && <div className="card h-24 animate-pulse" style={{ background: "var(--surface-2)" }} />}

      {SLOTS.map((slot) => {
        const list = items.filter((i) => i.slot === slot.key);
        if (!list.length) return null;
        return (
          <section key={slot.key} className="flex flex-col gap-2">
            <h3 className="flex items-baseline gap-2"><span className="section-title">{slot.label}</span><span className="hint">{slot.hint}</span>
              <span className="hint ml-auto">{list.filter((i) => logOf.has(i.id)).length}/{list.length}</span></h3>
            <ul className="flex flex-col gap-2">
              {list.map((it) => (
                <CheckRow key={it.id} it={it} log={logOf.get(it.id)} me={name} canUndoAll={me?.role === "manager"}
                  expiring={it.kind === "expiry" ? expiring as string[] : []} onRecord={record} onUndo={undo} />
              ))}
            </ul>
          </section>
        );
      })}

      {me?.role === "manager" && data && <ManageItems items={data.items} onChange={refresh} />}
    </>
  );
}

function CheckRow({ it, log, me, canUndoAll, expiring, onRecord, onUndo }: {
  it: Item; log?: Log; me: string; canUndoAll: boolean; expiring: string[];
  onRecord: (it: Item, v?: number) => void; onUndo: (l: Log) => void;
}) {
  const negative = it.kind === "temp" && it.maxValue != null && it.maxValue < 0; // 냉동: 부호 고정
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (value?: number) => { setBusy(true); await onRecord(it, value); setBusy(false); setV(""); };

  if (log) {
    const bad = it.kind === "temp" && outOfRange(it, log.value);
    return (
      <li className="card flex items-center gap-3 !py-2.5" style={{ background: "var(--surface-2)" }}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold" style={{ background: bad ? "var(--high)" : "var(--brand)", color: bad ? "#fff" : "var(--on-brand)" }}>{bad ? "!" : "✓"}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{it.name}{log.value != null && <b className={bad ? "text-[var(--high)]" : ""}> {log.value}℃</b>}</p>
          <p className="hint">{log.byName} · {hhmm(log.createdAt)}{bad && <span className="text-[var(--high)]"> · 기준 {range(it)} 벗어남</span>}</p>
        </div>
        {(log.byName === me || canUndoAll) && <button className="btn-ghost !px-2 text-xs" onClick={() => onUndo(log)}>되돌리기</button>}
      </li>
    );
  }

  return (
    <li className="card flex flex-col gap-2 !py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{it.name}</p>
          {it.kind === "temp" && <p className="hint">기준 {range(it)}</p>}
          {it.kind === "expiry" && <p className="hint">{expiring.length ? `오늘·내일 끝나는 것: ${expiring.join(", ")}` : "오늘 사용기한이 끝나는 품목은 없어요"}</p>}
        </div>
        {it.kind === "temp" ? (
          <form className="flex shrink-0 items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); const n = Number(v); if (v.trim() !== "" && Number.isFinite(n)) go(negative ? -Math.abs(n) : n); }}>
            {negative && <span className="text-lg font-bold">−</span>}
            <input inputMode="decimal" className="input w-16 !py-2 text-center text-lg font-bold tabular-nums" value={v} aria-label={`${it.name} 온도`}
              onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ""))} placeholder="—" />
            <span className="text-sm text-[var(--muted)]">℃</span>
            <button className="btn-primary !rounded-full !px-4 !py-2" disabled={busy || v.trim() === ""}>기록</button>
          </form>
        ) : it.kind === "count" ? (
          <span className="flex shrink-0 gap-1.5">
            <Link href="/count" className="btn !rounded-full">세러 가기</Link>
            <button className="btn-primary !rounded-full !px-4" disabled={busy} onClick={() => go()}>다 셌어요</button>
          </span>
        ) : (
          <button className="btn-primary shrink-0 !rounded-full !px-5 !py-2" disabled={busy} onClick={() => go()}>확인</button>
        )}
      </div>
    </li>
  );
}

function NamePicker({ onPick, isManager }: { onPick: (n: string) => void; isManager: boolean }) {
  const [v, setV] = useState(isManager ? "점장" : "");
  return (
    <section className="card mx-auto flex w-full max-w-sm flex-col gap-3 py-6">
      <h2 className="text-xl font-bold">누가 점검하나요?</h2>
      <p className="hint !text-sm">이 휴대폰에서 처음 한 번만 적으면 돼요. 점검 기록에 이름이 남아서 다른 직원이 같은 점검을 다시 하지 않게 됩니다.</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onPick(v.trim().slice(0, 20)); }}>
        <input className="input flex-1 !rounded-full !px-4 !py-2.5" value={v} onChange={(e) => setV(e.target.value)} placeholder="이름 (예: 김민수)" autoFocus aria-label="이름" />
        <button className="btn-primary !rounded-full !px-5" disabled={!v.trim()}>시작</button>
      </form>
    </section>
  );
}

/** 점장: 점검 항목 추가·끄기 */
function ManageItems({ items, onChange }: { items: Item[]; onChange: () => void }) {
  const [form, setForm] = useState({ name: "", slot: "open", kind: "check", min: "", max: "" });
  const [err, setErr] = useState("");
  const toggle = async (it: Item) => {
    await fetch("/api/checks/items", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: it.id, active: !it.active }) });
    onChange();
  };
  const add = async () => {
    setErr("");
    const r = await fetch("/api/checks/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error ?? "추가하지 못했어요"); return; }
    setForm({ name: "", slot: "open", kind: "check", min: "", max: "" });
    onChange();
  };
  return (
    <details className="card">
      <summary className="cursor-pointer font-semibold">점검 항목 관리 <span className="hint font-normal">(점장)</span></summary>
      <ul className="mt-3 flex flex-col divide-y divide-[var(--border)] text-sm">
        {items.map((it) => (
          <li key={it.id} className="flex items-center justify-between gap-2 py-2">
            <span className={it.active ? "" : "text-[var(--muted)] line-through"}>{SLOTS.find((s) => s.key === it.slot)?.label} · {it.name}{it.kind === "temp" && ` (${range(it)})`}</span>
            <button className="btn !py-1 text-xs" onClick={() => toggle(it)}>{it.active ? "끄기" : "켜기"}</button>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-[1fr_auto_auto_auto]">
        <input className="input" placeholder="새 항목 (예: 소스 냉장고 온도)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className="input" value={form.slot} onChange={(e) => setForm({ ...form, slot: e.target.value })}>{SLOTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="check">확인만</option><option value="temp">온도 기록</option></select>
        <button className="btn-primary" disabled={!form.name.trim()} onClick={add}>추가</button>
        {form.kind === "temp" && (
          <span className="flex items-center gap-1 sm:col-span-4">기준 <input className="input w-16" inputMode="decimal" placeholder="최저" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} />
            ~ <input className="input w-16" inputMode="decimal" placeholder="최고" value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} /> ℃</span>
        )}
      </div>
      {err && <p className="status status-err mt-2">{err}</p>}
    </details>
  );
}
