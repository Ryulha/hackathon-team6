import { getInsights } from "@/lib/insights";

export async function GET(req: Request) {
  const store = new URL(req.url).searchParams.get("store") ?? "";
  return Response.json(await getInsights(store.replace(/[^A-Za-z0-9_]/g, "")));
}
