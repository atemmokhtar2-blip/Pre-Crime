import { neon } from "@neondatabase/serverless";
import { createNeonRepo, type Sql } from "../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Check = "ok" | "missing" | "failed" | "schema_missing";

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
      const sql = neon(databaseUrl) as unknown as Sql;
      await sql`SELECT 1 AS healthy`;
      checks.database = "ok";
      await createNeonRepo(sql).ensureSchema();
      checks.database_schema = "ok";
    } catch {
      checks.database = "failed";
    }
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    const telegramCall = async (method: string, body?: object) => {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      const result = (await response.json()) as { ok?: boolean; result?: any };
      if (!response.ok || result.ok !== true) throw new Error("telegram_api_failed");
      return result.result;
    };

    try {
      const me = await telegramCall("getMe");
      checks.telegram = me?.username ? "ok" : "failed";

      const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
      // Vercel exposes the deployment URL as VERCEL_URL (no scheme); Netlify
      // exposes the full URL via process.env.URL. Prefer an explicit APP_URL,
      // then fall back to the platform-provided values so the webhook registers
      // automatically right after deploy without extra manual config.
      const appUrl =
        process.env.APP_URL ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "") ||
        process.env.URL ||
        "";
      if (webhookSecret && appUrl && appUrl.startsWith("https://")) {
        const webhookUrl = new URL("/api/telegram/webhook", appUrl).toString();
        await telegramCall("setWebhook", {
          url: webhookUrl,
          secret_token: webhookSecret,
          allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "chat_member", "chat_join_request"],
          drop_pending_updates: false,
        });
        const info = await telegramCall("getWebhookInfo");
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
