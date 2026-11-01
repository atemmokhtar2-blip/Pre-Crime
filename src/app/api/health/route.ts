import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Check = "ok" | "missing" | "failed" | "schema_missing";

async function telegramCall(token: string, method: string, body?: object) {
  const response = await fetch(\`https://api.telegram.org/bot\${token}/\${method}\`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json() as { ok?: boolean; result?: any };
  if (!response.ok || result.ok !== true) throw new Error("telegram_api_failed");
  return result.result;
}

export async function GET() {
  const checks: Record<string, Check> = {
    app: "ok",
    database: "missing",
    database_schema: "missing",
    telegram: "missing",
    webhook: "missing",
  };

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    try {
      const sql = neon(databaseUrl);
      await sql\`SELECT 1 AS healthy\`;
      checks.database = "ok";
      await sql\`
        CREATE TABLE IF NOT EXISTS telegram_updates (
          update_id BIGINT PRIMARY KEY,
          update_type TEXT NOT NULL,
          chat_id BIGINT,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          processed_at TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'received'
            CHECK (status IN ('received','processing','processed','failed')),
          error_code TEXT
        )
      \`;
      const rows = await sql\`
        SELECT to_regclass('public.telegram_updates') IS NOT NULL AS present
      \`;
      checks.database_schema = rows[0]?.present === true ? "ok" : "schema_missing";
    } catch {
      checks.database = "failed";
    }
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    try {
      const me = await telegramCall(botToken, "getMe");
      checks.telegram = me?.username ? "ok" : "failed";

      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      const appUrl = process.env.APP_URL;
      if (webhookSecret && appUrl && appUrl.startsWith("https://")) {
        const webhookUrl = new URL("/api/telegram/webhook", appUrl).toString();
        await telegramCall(botToken, "setWebhook", {
          url: webhookUrl,
          secret_token: webhookSecret,
          allowed_updates: ["message"],
          drop_pending_updates: false,
        });
        const info = await telegramCall(botToken, "getWebhookInfo");
        checks.webhook = info?.url === webhookUrl ? "ok" : "failed";
      } else {
        checks.webhook = "missing";
      }
    } catch {
      checks.webhook = "failed";
    }
  }

  const ok = Object.values(checks).every((value) => value === "ok");
  return Response.json(
    { ok, service: "pre-crime", runtime: "vercel-nodejs", checks },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
