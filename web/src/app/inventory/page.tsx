"use client";

import { useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt } from "@/components/format";
import { diffDays } from "@/lib/engine/dates";
import { useApp } from "@/state/app-state";

export default function InventoryPage() {
  const { result, snapshot, settings } = useApp();
  const [sel, setSel] = useState<string | null>(null);
  if (!result || !snapshot) return null;
  const plan = result.plans.find((p) => p.ingredient.ingredient_id === sel) ?? result.plans[0];
  if (!plan) return <div className="card text-sm">식자재 데이터가 없습니다.</div>;
  const id = plan.ingredient.ingredient_id;

  const history = snapshot.inventoryHistory.filter((r) => r.ingredient_id === id)
    .map((r) => ({ date: r.date, 실제기말: r.closing_qty, 소진: r.consumed_qty }));
  const future = plan.planned.slice(0, settings.horizonDays)
    .map((d) => ({ date: d.date, 예상기말: d.closing, 예측소요: d.need }));
  const lots = snapshot.lots.filter((l) => l.remaining_qty > 0).sort((a, b) => a.last_use_date.localeCompare(b.last_use_date));

  return (
    <>
      <section className="card">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">재고 추이</h2>
          <select className="input" value={id} onChange={(e) => setSel(e.target.value)}>
            {result.plans.map((p) => <option key={p.ingredient.ingredient_id} value={p.ingredient.ingredient_id}>{p.ingredient.ingredient_name}</option>)}
          </select>
          <span className="text-xs text-[var(--muted)]">단위 {plan.ingredient.use_unit} · 왼쪽 실제(최근 28일) / 오른쪽 추천 발주 반영 예상</span>
        </div>
        <div className="h-72">
          <ResponsiveContainer>
            <LineChart data={[...history, ...future]}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line dataKey="실제기말" stroke="var(--accent)" dot={false} />
              <Line dataKey="소진" stroke="var(--muted)" dot={false} />
              <Line dataKey="예상기말" stroke="var(--low)" strokeDasharray="5 3" dot={false} />
              <Line dataKey="예측소요" stroke="var(--medium)" strokeDasharray="5 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-semibold">입고 묶음별 잔량 (기준일 영업 시작 시점)</h2>
        <table className="tbl">
          <thead><tr><th>식자재</th><th>묶음</th><th>입고일</th><th>마지막 사용일</th><th className="num">남은 일수</th><th className="num">잔량</th></tr></thead>
          <tbody>
            {lots.map((l) => {
              const ing = snapshot.ingredients.find((i) => i.ingredient_id === l.ingredient_id);
              const left = diffDays(l.last_use_date, snapshot.meta.asOf);
              return (
                <tr key={l.lot_id + l.ingredient_id}>
                  <td>{ing?.ingredient_name ?? l.ingredient_id}</td><td>{l.lot_id}</td><td>{l.receipt_date}</td><td>{l.last_use_date}</td>
                  <td className="num" style={{ color: left <= settings.expiryWarnDays ? "var(--high)" : undefined }}>{left}</td>
                  <td className="num">{fmt(l.remaining_qty)}{l.use_unit}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
