// 매장 점검표 — 직원 누구나 기록, 같은 날 같은 항목은 먼저 기록한 사람만 남는다(중복 점검 방지)
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { checkItems, checkLogs } from "@/db/schema";
import { requireSession, storeOf } from "@/lib/auth/session";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const noDb = () => Response.json({ error: "DB 미연결 — 점검 기록은 DB가 있어야 합니다." }, { status: 503 });

/** 매장에 점검 항목이 하나도 없을 때 넣는 기본 항목 (식자재 관리에 필요한 것만) */
const DEFAULT_ITEMS = [
  { slot: "open", kind: "check", name: "입고 검수 (수량·상태)", minValue: null, maxValue: null },
  { slot: "open", kind: "temp", name: "냉장고 온도", minValue: 0, maxValue: 5 },
  { slot: "open", kind: "temp", name: "냉동고 온도", minValue: null, maxValue: -18 },
  { slot: "open", kind: "expiry", name: "사용기한 임박 품목 먼저 꺼내기", minValue: null, maxValue: null },
  { slot: "lunch", kind: "count", name: "재고 세기", minValue: null, maxValue: null },
  { slot: "close", kind: "temp", name: "냉장고 온도", minValue: 0, maxValue: 5 },
  { slot: "close", kind: "temp", name: "냉동고 온도", minValue: null, maxValue: -18 },
  { slot: "close", kind: "check", name: "마감 폐기 확인·기록", minValue: null, maxValue: null },
] as const;

async function itemsOf(storeId: string) {
  let rows = await db!.select().from(checkItems).where(eq(checkItems.storeId, storeId)).orderBy(asc(checkItems.sort), asc(checkItems.id));
  if (!rows.length) {
    await db!.insert(checkItems).values(DEFAULT_ITEMS.map((d, i) => ({ ...d, storeId, sort: i })));
    rows = await db!.select().from(checkItems).where(eq(checkItems.storeId, storeId)).orderBy(asc(checkItems.sort), asc(checkItems.id));
  }
  return rows;
}

/** 오늘 점검 항목과 기록 (다른 직원이 한 것 포함) */
export async function GET(req: Request) {
  const s = requireSession(req);
  if (s instanceof Response) return s;
  if (!db) return noDb();
  const date = new URL(req.url).searchParams.get("date") ?? "";
  if (!DATE.test(date)) return Response.json({ error: "date 가 필요합니다" }, { status: 400 });
  const storeId = storeOf(req, s);
  const [items, logs] = await Promise.all([
    itemsOf(storeId),
    db.select().from(checkLogs).where(and(eq(checkLogs.storeId, storeId), eq(checkLogs.date, date))),
  ]);
  return Response.json({ items, logs });
}

/** 기록하기: { itemId, date, value?, byName } — 이미 누가 했으면 409 와 그 기록을 돌려준다 */
export async function POST(req: Request) {
  const s = requireSession(req, ["staff", "manager"]);
  if (s instanceof Response) return s;
  if (!db) return noDb();
  const b = await req.json().catch(() => null);
  const date = String(b?.date ?? "");
  const byName = String(b?.byName ?? "").trim().slice(0, 20);
  if (!DATE.test(date) || !byName) return Response.json({ error: "날짜와 이름이 필요합니다" }, { status: 400 });
  const [item] = await db.select().from(checkItems).where(and(eq(checkItems.id, Number(b?.itemId)), eq(checkItems.storeId, s.storeId)));
  if (!item || !item.active) return Response.json({ error: "없는 점검 항목입니다" }, { status: 404 });
  // 이미 누가 했으면 값 검사보다 먼저 알려준다 (중복 점검 방지가 목적)
  const already = async () => (await db!.select().from(checkLogs)
    .where(and(eq(checkLogs.storeId, s.storeId), eq(checkLogs.date, date), eq(checkLogs.itemId, item.id))))[0];
  const prev = await already();
  if (prev) return Response.json({ error: "이미 기록된 점검입니다", log: prev }, { status: 409 });
  let value: number | null = null;
  if (item.kind === "temp") {
    value = Number(b?.value);
    if (b?.value === "" || b?.value == null || !Number.isFinite(value) || value < -50 || value > 50) {
      return Response.json({ error: "온도를 숫자로 넣어 주세요 (−50~50℃)" }, { status: 422 });
    }
  }
  const [row] = await db.insert(checkLogs).values({ storeId: s.storeId, date, itemId: item.id, value, byName })
    .onConflictDoNothing().returning();
  // 거의 동시에 두 명이 누른 경우: 유일 인덱스가 늦은 쪽을 막는다
  if (!row) return Response.json({ error: "이미 기록된 점검입니다", log: await already() }, { status: 409 });
  return Response.json(row, { status: 201 });
}

/** 잘못 누른 기록 되돌리기 (같은 매장 기록만) */
export async function DELETE(req: Request) {
  const s = requireSession(req, ["staff", "manager"]);
  if (s instanceof Response) return s;
  if (!db) return noDb();
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "id 가 필요합니다" }, { status: 400 });
  await db.delete(checkLogs).where(and(eq(checkLogs.id, id), eq(checkLogs.storeId, s.storeId)));
  return new Response(null, { status: 204 });
}
