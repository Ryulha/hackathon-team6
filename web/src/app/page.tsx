"use client";

import Link from "next/link";
import { SEVERITY_LABEL, fmt, won } from "@/components/format";
import { useApp } from "@/state/app-state";

export default function Dashboard() {
  const { result, snapshot } = useApp();
  if (!result || !snapshot) return null;
  const { alerts, orders, plans } = result;
  const today = orders.filter((o) => o.isToday);
  const count = (k: string) => alerts.filter((a) => a.kind === k).length;

  return (
    <>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="부족 예상(긴급)" value={count("shortage")} color="var(--high)" />
        <Stat label="오늘 발주할 공급사" value={today.length} color="var(--accent)" />
        <Stat label="사용기한 임박" value={count("expiry")} color="var(--medium)" />
        <Stat label="과잉 재고" value={count("overstock")} color="var(--low)" />
      </section>

      <section className="card">
        <h2 className="section-title mb-3">알림 <span className="hint">{alerts.length}</span></h2>
        {!alerts.length && <p className="text-sm text-[var(--muted)]">현재 조건에서 알림이 없습니다.</p>}
        <ul className="flex flex-col gap-3">
          {alerts.map((a, i) => (
            <li key={i} className="flex gap-3 text-sm">
              <span className={`badge badge-${a.severity} mt-0.5 shrink-0`}>{SEVERITY_LABEL[a.severity]}</span>
              <div><b>{a.title}</b><div className="text-[var(--muted)]">{a.detail}</div></div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="section-title">다가오는 발주</h2>
          <Link href="/orders" className="btn-ghost !text-[var(--accent)]">발주 추천 상세 →</Link>
        </div>
        <table className="tbl">
          <thead><tr><th>공급사</th><th>발주일</th><th>마감</th><th>입고 예정</th><th className="num">품목</th><th className="num">금액</th><th>최소금액</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.supplier.supplier_id + o.orderDate}>
                <td>{o.supplier.supplier_name}</td>
                <td>{o.orderDate}{o.isToday && <span className="badge badge-accent ml-1.5">오늘</span>}</td>
                <td>{o.cutoff}</td><td>{o.arrivalDate}</td>
                <td className="num">{o.lines.length}</td><td className="num">{won(o.amount)}</td>
                <td>{o.belowMin ? <span className="badge badge-high">미달 {won(o.minGap)}</span> : <span className="badge badge-muted">충족</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-[var(--muted)]">전체 {plans.length}개 식자재 중 발주 필요 {plans.filter((p) => p.finalUnits > 0).length}개 · 총 {fmt(orders.reduce((a, o) => a + o.amount, 0))}원</p>
      </section>
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card">
      <div className="hint">{label}</div>
      <div className="mt-1 text-[28px] leading-none font-bold tabular-nums tracking-[-0.02em]" style={{ color: value ? color : "var(--muted)" }}>{value}</div>
    </div>
  );
}
