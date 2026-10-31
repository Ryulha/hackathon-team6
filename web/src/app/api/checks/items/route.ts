// 점검 항목 관리 — 점장만: 추가 / 켜기·끄기
import { and, eq, max } from "drizzle-orm";
import { db } from "@/db/client";
import { checkItems } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";

const SLOTS = ["open", "lunch", "close"];
const KINDS = ["check", "temp"];

export async function POST(req: Request) {
  const s = requireSession(req, ["manager"]);
  if (s instanceof Response) return s;
  if (!db) return Response.json({ error: "DB 미연결" }, { status: 503 });
  const b = await req.json().catch(() => null);
  const name = String(b?.name ?? "").trim().slice(0, 40);
  if (!name || !SLOTS.includes(b?.slot) || !KINDS.includes(b?.kind)) {
    return Response.json({ error: "이름·시간대·종류를 확인해 주세요" }, { status: 422 });
  }
  const num = (v: unknown) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const [{ m }] = await db.select({ m: max(checkItems.sort) }).from(checkItems).where(eq(checkItems.storeId, s.storeId));
  const [row] = await db.insert(checkItems).values({
    storeId: s.storeId, name, slot: b.slot, kind: b.kind, sort: (m ?? 0) + 1,
    minValue: b.kind === "temp" ? num(b.min) : null, maxValue: b.kind === "temp" ? num(b.max) : null,
  }).returning();
  return Response.json(row, { status: 201 });
}

/** { id, active } — 끈 항목은 점검표에서 숨김(기록은 남음) */
export async function PATCH(req: Request) {
  const s = requireSession(req, ["manager"]);
  if (s instanceof Response) return s;
  if (!db) return Response.json({ error: "DB 미연결" }, { status: 503 });
  const b = await req.json().catch(() => null);
  const [row] = await db.update(checkItems).set({ active: !!b?.active })
    .where(and(eq(checkItems.id, Number(b?.id)), eq(checkItems.storeId, s.storeId))).returning();
  return row ? Response.json(row) : Response.json({ error: "없는 항목" }, { status: 404 });
}
