import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// `vercel env pull .env.local` 결과를 사용
if (!process.env.DATABASE_URL && existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  // raw_*/agg_* 는 pipeline 소유 → push 시 건드리지 않도록 app_* 만 관리
  tablesFilter: ["app_*"],
});
