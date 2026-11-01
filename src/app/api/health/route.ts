import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Check = "ok" | "missing" | "failed" | "schema_missing";

export async function GET() {
  const checks: Record<string, Check> = {
    app: "ok",
    database: "missing",
    database_schema: "missing",
    telegram: "missing",
  };

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    try {
      const sql = neon(databaseUrl);
      await sql`SELECT 1 AS healthy`;
      checks.database = "ok";
      const rows = await sql`
        SELECT to_regclass('public.telegram_updates') IS NOT NULL AS present
      `;
      checks.database_schema = rows[0]?.present === true ? "ok" : "schema_missing";
    } catch {
      checks.database = "failed";
    }
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      const result = await response.json() as { ok?: boolean };
      checks.telegram = response.ok && result.ok === true ? "ok" : "failed";
    } catch {
      checks.telegram = "failed";
    }
  }

  const ok = Object.values(checks).every((value) => value === "ok");
  return Response.json(
    { ok, service: "pre-crime", runtime: "vercel-nodejs", checks },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
