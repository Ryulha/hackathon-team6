import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;

/** DATABASE_URL 이 없으면 null → JSON 폴백·읽기 전용 모드 */
export const sql = url ? neon(url) : null;
export const db = sql ? drizzle(sql, { schema }) : null;
export const hasDb = () => db !== null;
