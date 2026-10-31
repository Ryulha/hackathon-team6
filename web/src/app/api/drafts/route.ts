import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { orderDrafts } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";

const NO_DB = Response.json({ error: "DB 미연결 — 읽기 전용 모드에서는 저장할 수 없습니다." }, { status: 503 });

/** 로그인한 매장의 발주안만 */
export async function GET(req: Request) {
  const s = requireSession(req);
  if (s instanceof Response) return s;
  if (!db) return NO_DB.clone();
  const rows = await db.select().from(orderDrafts)
    .where(eq(orderDrafts.storeId, s.storeId))
    .orderBy(desc(orderDrafts.createdAt)).limit(50);
  return Response.json(rows);
}

/** 발주안 저장 / 확정(모의 전송 — 실제 공급사 시스템 연동 없음). 매장은 로그인 매장으로 고정 */
export async function POST(req: Request) {
  const s = requireSession(req);
  if (s instanceof Response) return s;
  if (!db) return NO_DB.clone();
  const b = await req.json();
  if (!b?.asOf || !Array.isArray(b?.lines)) {
    return Response.json({ error: "asOf, lines 필요" }, { status: 400 });
  }
  const [row] = await db.insert(orderDrafts).values({
    storeId: s.storeId, asOf: String(b.asOf),
    status: b.status === "submitted" ? "submitted" : "draft",
    settings: b.settings ?? {}, lines: b.lines,
    totalAmount: Math.round(Number(b.totalAmount) || 0), note: b.note ?? null,
  }).returning();
  return Response.json(row, { status: 201 });
}
