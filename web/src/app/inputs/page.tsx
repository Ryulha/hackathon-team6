"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fmt, won } from "@/components/format";
import { addDays } from "@/lib/engine/dates";
import { priceAt } from "@/lib/engine/units";
import { EDITABLE, SALES_COLUMNS } from "@/lib/overlays";
import { useApp } from "@/state/app-state";

type Tab = "counts" | "master" | "sales";
type Msg = { ok: boolean; text: string } | null;

/** 입력 API 호출 — 실패 시 서버 메시지를 그대로 던진다 */
async function api<T = unknown>(kind: string, init?: RequestInit & { query?: string }): Promise<T> {
  const r = await fetch(`/api/inputs/${kind}${init?.query ? `?${init.query}` : ""}`, init);
  if (r.status === 204) return undefined as T;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error ?? r.statusText), { body });
  return body as T;
}
const json = (method: string, data: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

export default function InputsPage() {
  const { snapshot } = useApp();
  const [tab, setTab] = useState<Tab>("counts");
  if (!snapshot) return null;
  const readOnly = snapshot.meta.source !== "db";

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-[-0.01em]">데이터 입력</h2>
          <p className="hint">입력값은 제공 데이터를 고치지 않고 따로 저장되어 계산에 덮어 반영됩니다. 지우면 원래 값으로 돌아갑니다.</p>
        </div>
        <div className="tabs" role="tablist">
          {([["counts", "실사 재고"], ["master", "기준정보"], ["sales", "판매 업로드"]] as const).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className="tab" onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
      </div>
      {readOnly && <div className="status status-err">DB에 연결되지 않아 읽기 전용입니다. 입력·저장은 DB 연결 시에만 가능합니다.</div>}
      {tab === "counts" && <CountsTab disabled={readOnly} />}
      {tab === "master" && <MasterTab disabled={readOnly} />}
      {tab === "sales" && <SalesTab disabled={readOnly} />}
    </>
  );
}

function Status({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <div role="status" className={`status ${msg.ok ? "status-ok" : "status-err"}`}>{msg.text}</div>;
}

function Section({ title, hint, children, aside }: { title: string; hint?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="section-title">{title}</h3>{hint && <p className="hint mt-0.5">{hint}</p>}</div>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ---------------- (a) 실사 재고 ----------------

type CountRow = { id: number; date: string; ingredientId: string; countedQty: number };

function CountsTab({ disabled }: { disabled: boolean }) {
  const { snapshot, setAsOf, reload } = useApp();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<CountRow[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const meta = snapshot!.meta;
  const storeId = meta.storeId;
  const asOf = meta.asOf;
  const allowed = asOf > meta.providedEnd;

  const load = useCallback(() => {
    if (disabled) return;
    api<CountRow[]>("counts", { query: `store=${storeId}` }).then(setSaved).catch(() => setSaved([]));
  }, [disabled, storeId]);
  useEffect(load, [load]);

  // 장부 재고 = 전날 마감 묶음 + 오늘 07시 입고 예정 (실사 입력이 이미 있으면 그 값)
  const book = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of snapshot!.lots) m.set(l.ingredient_id, (m.get(l.ingredient_id) ?? 0) + l.remaining_qty);
    for (const o of snapshot!.openOrders) if (o.expected_date === asOf) m.set(o.ingredient_id, (m.get(o.ingredient_id) ?? 0) + o.use_qty);
    return m;
  }, [snapshot, asOf]);
  const todays = new Map(saved.filter((c) => c.date === asOf).map((c) => [c.ingredientId, c]));
  const filled = Object.entries(values).filter(([, v]) => v.trim() !== "");
  const invalid = new Set(filled.filter(([, v]) => !(Number(v) >= 0)).map(([k]) => k));

  async function submit() {
    setBusy(true); setMsg(null);
    try {
      await api("counts", json("POST", { storeId, date: asOf, items: filled.map(([ingredient_id, v]) => ({ ingredient_id, counted_qty: Number(v) })) }));
      setMsg({ ok: true, text: `${filled.length}개 품목 실사 저장 — 발주 추천에 반영했습니다.` });
      setValues({}); load(); reload();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function remove(id: number) {
    try { await api("counts", { method: "DELETE", query: `id=${id}` }); load(); reload(); setMsg({ ok: true, text: "실사 입력을 지웠습니다." }); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }

  if (!allowed) {
    return (
      <Section title="영업 전 실사 재고" hint="제공 기간은 데이터의 실사 기록을 그대로 씁니다.">
        <p className="text-sm">실사 입력은 제공 데이터 이후 기준일({addDays(meta.dataEnd, 1)})에서 할 수 있습니다. 현재 기준일은 {asOf}입니다.</p>
        <div><button className="btn" onClick={() => setAsOf(null)}>최신 기준일로 이동</button></div>
      </Section>
    );
  }

  const ingName = (id: string) => snapshot!.ingredients.find((i) => i.ingredient_id === id)?.ingredient_name ?? id;
  return (
    <>
      <Section
        title={`${asOf} 영업 전 실사`}
        hint={<>07시 입고 후 센 수량을 사용단위로 입력하세요. 차이는 명세서 규칙대로 감소분은 오래된 입고 묶음부터, 증가분은 가장 최근 묶음에 반영합니다.
          {meta.overlay.estimated && <> 장부 재고는 업로드한 판매로 이어 계산한 <b>추정치</b>입니다.</>}</>}
        aside={<button className="btn-primary" disabled={disabled || busy || !filled.length || invalid.size > 0} onClick={submit}>
          {busy ? "저장 중…" : `실사 저장${filled.length ? ` (${filled.length})` : ""}`}</button>}
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>식자재</th><th>보관</th><th className="num">장부 재고</th><th>실사 수량</th><th className="num">차이</th></tr></thead>
            <tbody>
              {snapshot!.ingredients.map((ing) => {
                const id = ing.ingredient_id;
                const v = values[id] ?? "";
                const b = book.get(id) ?? 0;
                const diff = v.trim() !== "" && Number(v) >= 0 ? Number(v) - b : null;
                const done = todays.get(id);
                return (
                  <tr key={id} className="row-hover">
                    <td>{ing.ingredient_name} <span className="hint">{id}</span>{done && <span className="badge badge-accent ml-1.5">입력됨</span>}</td>
                    <td className="hint">{ing.storage}</td>
                    <td className="num">{fmt(b)}{ing.use_unit}</td>
                    <td>
                      <input inputMode="decimal" className="input w-28 text-right tabular-nums" placeholder={done ? fmt(done.countedQty) : "—"}
                        aria-invalid={invalid.has(id)} disabled={disabled} value={v}
                        onChange={(e) => setValues((s) => ({ ...s, [id]: e.target.value.replace(/,/g, "") }))} />
                      <span className="hint ml-1">{ing.use_unit}</span>
                    </td>
                    <td className="num" style={{ color: diff && diff < 0 ? "var(--high)" : diff ? "var(--low)" : undefined }}>
                      {diff === null ? "" : `${diff > 0 ? "+" : ""}${fmt(diff)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Status msg={msg} />
      </Section>

      <Section title="저장된 실사" hint="같은 날짜·품목을 다시 저장하면 최신 값으로 바뀝니다.">
        {!saved.length ? <p className="hint">아직 없습니다.</p> : (
          <table className="tbl">
            <thead><tr><th>실사일</th><th>식자재</th><th className="num">수량</th><th /></tr></thead>
            <tbody>{saved.map((c) => (
              <tr key={c.id} className="row-hover"><td>{c.date}</td><td>{ingName(c.ingredientId)}</td><td className="num">{fmt(c.countedQty)}</td>
                <td className="text-right"><button className="btn-danger" onClick={() => remove(c.id)}>삭제</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </Section>
    </>
  );
}

// ---------------- (d) 기준정보 ----------------

type EditRow = { id: number; entity: string; entityId: string; field: string; value: string; createdAt: string };
type PriceRowDb = { id: number; ingredientId: string; validFrom: string; unitPrice: number; createdAt: string };

function MasterTab({ disabled }: { disabled: boolean }) {
  const { snapshot, reload } = useApp();
  const snap = snapshot!;
  const [target, setTarget] = useState(`supplier|${snap.suppliers[0]?.supplier_id ?? ""}`);
  const [entity, entityId] = target.split("|") as ["supplier" | "ingredient", string];
  const fields = Object.entries(EDITABLE[entity]);
  const [field, setField] = useState(fields[0][0]);
  const [value, setValue] = useState("");
  const [price, setPrice] = useState({ ingredient_id: snap.ingredients[0]?.ingredient_id ?? "", valid_from: snap.meta.asOf, unit_price: "" });
  const [edits, setEdits] = useState<EditRow[]>([]);
  const [prices, setPrices] = useState<PriceRowDb[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(() => {
    if (disabled) return;
    api<EditRow[]>("master").then(setEdits).catch(() => setEdits([]));
    api<PriceRowDb[]>("prices").then(setPrices).catch(() => setPrices([]));
  }, [disabled]);
  useEffect(load, [load]);

  const row = entity === "supplier"
    ? snap.suppliers.find((s) => s.supplier_id === entityId) : snap.ingredients.find((i) => i.ingredient_id === entityId);
  const activeField = EDITABLE[entity][field] ? field : fields[0][0];
  const current = row ? String((row as Record<string, unknown>)[activeField] ?? "") : "";
  const label = (e: string, id: string) => (e === "supplier"
    ? snap.suppliers.find((s) => s.supplier_id === id)?.supplier_name : snap.ingredients.find((i) => i.ingredient_id === id)?.ingredient_name) ?? id;
  const curPrice = priceAt(snap.prices, price.ingredient_id, price.valid_from);
  const priceIng = snap.ingredients.find((i) => i.ingredient_id === price.ingredient_id);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); load(); reload(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }

  return (
    <>
      <Section title="공급사·식자재 조건 수정" hint="발주 요일·마감·리드타임·최소금액, 포장 단위·최소 발주수량·사용 가능 일수를 바꿀 수 있습니다. 바꾸면 모든 화면의 계산에 바로 반영됩니다.">
        <div className="grid gap-3 md:grid-cols-[1.3fr_1fr_1fr_auto] md:items-end">
          <label className="flex flex-col gap-1 text-sm"><span className="hint">대상</span>
            <select className="input" value={target} onChange={(e) => { setTarget(e.target.value); setField(Object.keys(EDITABLE[e.target.value.split("|")[0] as "supplier"])[0]); setValue(""); }}>
              <optgroup label="공급사">{snap.suppliers.map((s) => <option key={s.supplier_id} value={`supplier|${s.supplier_id}`}>{s.supplier_name}</option>)}</optgroup>
              <optgroup label="식자재">{snap.ingredients.map((i) => <option key={i.ingredient_id} value={`ingredient|${i.ingredient_id}`}>{i.ingredient_name} ({i.ingredient_id})</option>)}</optgroup>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="hint">항목</span>
            <select className="input" value={activeField} onChange={(e) => { setField(e.target.value); setValue(""); }}>
              {fields.map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="hint">새 값 (현재 {current || "—"})</span>
            <input className="input" value={value} placeholder={current} disabled={disabled} onChange={(e) => setValue(e.target.value)} />
          </label>
          <button className="btn-primary" disabled={disabled || !value.trim()}
            onClick={() => run(async () => { await api("master", json("POST", { entity, entity_id: entityId, field: activeField, value })); setValue(""); },
              `${label(entity, entityId)} · ${EDITABLE[entity][activeField].label} → ${value}`)}>저장</button>
        </div>
        {entity === "ingredient" && activeField === "use_qty_per_order_unit" && (
          <p className="hint">이미 발주된 물량(입고 예정)은 발주 당시 포장 단위로 계산합니다.</p>
        )}
      </Section>

      <Section title="단가 변경" hint="적용 시작일부터 새 단가로 발주 금액을 계산합니다. 같은 시작일의 기존 단가는 입력값이 우선합니다.">
        <div className="grid gap-3 md:grid-cols-[1.3fr_1fr_1fr_auto] md:items-end">
          <label className="flex flex-col gap-1 text-sm"><span className="hint">식자재</span>
            <select className="input" value={price.ingredient_id} onChange={(e) => setPrice((p) => ({ ...p, ingredient_id: e.target.value }))}>
              {snap.ingredients.map((i) => <option key={i.ingredient_id} value={i.ingredient_id}>{i.ingredient_name} ({i.order_unit})</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="hint">적용 시작일</span>
            <input type="date" className="input" value={price.valid_from} onChange={(e) => setPrice((p) => ({ ...p, valid_from: e.target.value }))} />
          </label>
          <label className="flex flex-col gap-1 text-sm"><span className="hint">단가 (원/{priceIng?.order_unit}, 현재 {curPrice ? won(curPrice.unit_price) : "—"})</span>
            <input inputMode="numeric" className="input text-right tabular-nums" value={price.unit_price} disabled={disabled}
              onChange={(e) => setPrice((p) => ({ ...p, unit_price: e.target.value.replace(/,/g, "") }))} />
          </label>
          <button className="btn-primary" disabled={disabled || !price.unit_price || !price.valid_from}
            onClick={() => run(async () => { await api("prices", json("POST", { ...price, unit_price: Number(price.unit_price) })); setPrice((p) => ({ ...p, unit_price: "" })); },
              `${priceIng?.ingredient_name} 단가 ${won(Number(price.unit_price))} (${price.valid_from}부터)`)}>저장</button>
        </div>
      </Section>

      <Status msg={msg} />

      <Section title="변경 이력" hint="같은 항목을 여러 번 바꾸면 가장 최근 값이 적용됩니다. 삭제하면 이전 값(또는 제공 데이터 값)으로 돌아갑니다.">
        {!edits.length && !prices.length ? <p className="hint">아직 없습니다.</p> : (
          <table className="tbl">
            <thead><tr><th>대상</th><th>항목</th><th>값</th><th>저장 시각</th><th /></tr></thead>
            <tbody>
              {edits.map((e) => (
                <tr key={`m${e.id}`} className="row-hover">
                  <td>{label(e.entity, e.entityId)}</td>
                  <td>{EDITABLE[e.entity as "supplier"]?.[e.field]?.label ?? e.field}</td>
                  <td>{e.value}</td><td className="hint">{new Date(e.createdAt).toLocaleString("ko-KR")}</td>
                  <td className="text-right"><button className="btn-danger" onClick={() => run(() => api("master", { method: "DELETE", query: `id=${e.id}` }), "변경을 되돌렸습니다.")}>되돌리기</button></td>
                </tr>
              ))}
              {prices.map((p) => (
                <tr key={`p${p.id}`} className="row-hover">
                  <td>{label("ingredient", p.ingredientId)}</td><td>단가 ({p.validFrom}부터)</td><td>{won(p.unitPrice)}</td>
                  <td className="hint">{new Date(p.createdAt).toLocaleString("ko-KR")}</td>
                  <td className="text-right"><button className="btn-danger" onClick={() => run(() => api("prices", { method: "DELETE", query: `id=${p.id}` }), "단가 변경을 되돌렸습니다.")}>되돌리기</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

// ---------------- (e) 판매 업로드 ----------------

type Check = { ok: boolean; errors: string[]; errorCount: number; warnings: string[]; rowCount: number; dailyRows: number; dateFrom: string; dateTo: string; storeIds: string[] };
type Upload = { id: number; fileName: string; dateFrom: string; dateTo: string; storeIds: string; rowCount: number; createdAt: string };
const MAX_BYTES = 4 * 1024 * 1024; // Vercel 함수 요청 본문 한도(4.5MB) 아래로

function SalesTab({ disabled }: { disabled: boolean }) {
  const { snapshot, reload } = useApp();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(() => {
    if (disabled) return;
    api<Upload[]>("sales").then(setUploads).catch(() => setUploads([]));
  }, [disabled]);
  useEffect(load, [load]);

  async function pick(f: File | undefined) {
    setMsg(null); setCheck(null); setFile(null);
    if (!f) return;
    if (f.size > MAX_BYTES) { setMsg({ ok: false, text: `파일이 너무 큽니다 (${(f.size / 1048576).toFixed(1)}MB). 4MB 이하로 기간을 나눠 올려 주세요.` }); return; }
    const text = await f.text();
    setFile({ name: f.name, text });
    setBusy(true);
    try {
      const r = await api<{ check: Check }>("sales", { method: "POST", query: "dryRun=1", body: text, headers: { "content-type": "text/csv", "x-file-name": encodeURIComponent(f.name) } });
      setCheck(r.check);
    } catch (e) {
      const c = (e as { body?: { check?: Check } }).body?.check;
      if (c) setCheck(c); else setMsg({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  }
  async function upload() {
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      await api("sales", { method: "POST", body: file.text, headers: { "content-type": "text/csv", "x-file-name": encodeURIComponent(file.name) } });
      setMsg({ ok: true, text: `${check?.dateFrom} ~ ${check?.dateTo} 판매를 반영했습니다. 기준일이 판매 다음 날로 이동합니다.` });
      setFile(null); setCheck(null); load(); reload();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function remove(id: number) {
    setMsg(null);
    try { await api("sales", { method: "DELETE", query: `id=${id}` }); load(); reload(); setMsg({ ok: true, text: "업로드를 지웠습니다." }); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  function template() {
    const d = addDays(snapshot!.meta.dataEnd, 1);
    const m = snapshot!.menus[0]?.menu_id ?? "M001";
    const csv = `﻿${SALES_COLUMNS.join(",")}\n${d},12,${snapshot!.meta.storeId},${m},매장,3,3,0,0,0,0\n`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "sales_template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <Section
        title="판매 기록 올리기"
        hint={<>09_sales.csv와 같은 형식(UTF-8)입니다. 각 매장의 마지막 판매일 다음 날부터 빈 날 없이 이어져야 합니다. 현재 이 매장의 마지막 판매일은 <b>{snapshot!.meta.dataEnd}</b>입니다.</>}
        aside={<button className="btn" onClick={template}>양식 받기</button>}
      >
        <label className="dropzone cursor-pointer" data-over={over}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) pick(e.dataTransfer.files[0]); }}>
          <input type="file" accept=".csv,text/csv" className="sr-only" disabled={disabled} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="font-medium text-[var(--foreground)]">{file ? file.name : "CSV 파일을 끌어다 놓거나 눌러서 선택"}</span>
          <span>{busy ? "검사 중…" : "올리기 전에 형식·기간·수량 관계를 먼저 검사합니다"}</span>
        </label>

        {check && (
          <div className="flex flex-col gap-2 rounded-md border p-3 text-sm" style={{ borderColor: check.ok ? "var(--accent)" : "var(--high)" }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge ${check.ok ? "badge-accent" : "badge-high"}`}>{check.ok ? "검사 통과" : `오류 ${check.errorCount}건`}</span>
              <span>{fmt(check.rowCount)}행{check.dateFrom && ` · ${check.dateFrom} ~ ${check.dateTo}`}{check.storeIds.length > 0 && ` · 매장 ${check.storeIds.join(", ")}`}</span>
            </div>
            {check.warnings.map((w, i) => <p key={i} className="hint">{w}</p>)}
            {check.errors.length > 0 && (
              <ul className="ml-4 list-disc text-[var(--high)]">
                {check.errors.map((e, i) => <li key={i}>{e}</li>)}
                {check.errorCount > check.errors.length && <li>외 {check.errorCount - check.errors.length}건</li>}
              </ul>
            )}
            {check.ok && <div><button className="btn-primary" disabled={disabled || busy} onClick={upload}>{busy ? "올리는 중…" : "이 내용으로 반영"}</button></div>}
          </div>
        )}
        <Status msg={msg} />
        <p className="hint">판매만 올리면 그 사이 재고는 {snapshot!.meta.providedEnd} 재고에서 판매(확정 수량 × BOM)만큼 소진하고 입고 예정분을 더해 <b>추정</b>합니다. 실사 재고를 입력하면 그 값으로 바로잡습니다.</p>
      </Section>

      <Section title="올린 판매 기록" hint="중간 기간을 지우면 빈 날이 생기므로, 가장 최근 업로드부터 지울 수 있습니다.">
        {!uploads.length ? <p className="hint">아직 없습니다.</p> : (
          <table className="tbl">
            <thead><tr><th>파일</th><th>기간</th><th>매장</th><th className="num">행</th><th>올린 시각</th><th /></tr></thead>
            <tbody>{uploads.map((u) => (
              <tr key={u.id} className="row-hover">
                <td>{u.fileName}</td><td>{u.dateFrom} ~ {u.dateTo}</td><td>{u.storeIds}</td><td className="num">{fmt(u.rowCount)}</td>
                <td className="hint">{new Date(u.createdAt).toLocaleString("ko-KR")}</td>
                <td className="text-right"><button className="btn-danger" onClick={() => remove(u.id)}>삭제</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
    </>
  );
}
