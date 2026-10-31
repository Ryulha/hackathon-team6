import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { orderDrafts } from "@/db/schema";

const NO_DB = Response.json({ error: "DB 미연결 — 읽기 전용 모드에서는 저장할 수 없습니다." }, { status: 503 });

export async function GET(req: Request) {
  if (!db) return NO_DB.clone();
  const store = new URL(req.url).searchParams.get("store");
  const rows = await db.select().from(orderDrafts)
    .where(store ? eq(orderDrafts.storeId, store) : undefined)
    .orderBy(desc(orderDrafts.createdAt)).limit(50);
  return Response.json(rows);
}

/** 발주안 저장 / 확정(모의 전송 — 실제 공급사 시스템 연동 없음) */
export async function POST(req: Request) {
  if (!db) return NO_DB.clone();
  const b = await req.json();
  if (!b?.storeId || !b?.asOf || !Array.isArray(b?.lines)) {
    return Response.json({ error: "storeId, asOf, lines 필요" }, { status: 400 });
  }
  const [row] = await db.insert(orderDrafts).values({
    storeId: String(b.storeId), asOf: String(b.asOf),
    status: b.status === "submitted" ? "submitted" : "draft",
    settings: b.settings ?? {}, lines: b.lines,
    totalAmount: Math.round(Number(b.totalAmount) || 0), note: b.note ?? null,
  }).returning();
  return Response.json(row, { status: 201 });
}
