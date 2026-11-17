import { createCipheriv, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createTelegramApi } from "@/lib/telegram-api";
import { deriveManagedWebhookSecret } from "@/lib/managed-webhook-secret";
import type { Sql } from "@/lib/db";
import { readTextBody } from "@/lib/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProvisionPayload = {
  request_id: string;
  owner_telegram_id: number;
  template: string;
  bot_token: string;
};

function safeEqualHex(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function encryptToken(token: string): string {
  const key = process.env.MANAGED_BOT_TOKEN_ENCRYPTION_KEY_V2 ?? "";
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("managed_bot_encryption_key_missing");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function authenticate(timestamp: string, signature: string, path: string, body: string): boolean {
  const secret = process.env.FACTORY_SERVICE_SECRET ?? "";
  if (secret.length < 32 || !/^\d{10,13}$/.test(timestamp)) return false;
  const millis = timestamp.length === 13 ? Number(timestamp) : Number(timestamp) * 1000;
  if (!Number.isFinite(millis) || Math.abs(Date.now() - millis) > 5 * 60_000) return false;
  const expected = createHmac("sha256", secret)
    .update(timestamp).update("\nPOST\n").update(path).update("\n").update(body).digest("hex");
  return safeEqualHex(signature, expected);
}

async function ensureFactorySchema(sql: Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS managed_bots (
      bot_id BIGINT PRIMARY KEY,
      owner_telegram_id BIGINT NOT NULL,
      owner_username TEXT,
      encrypted_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      admin_suspended BOOLEAN NOT NULL DEFAULT FALSE,
      request_id UUID UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS admin_suspended BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS owner_username TEXT`;
  await sql`ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS request_id UUID`;
  await sql`ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS managed_bots_one_live_bot_per_owner ON managed_bots(owner_telegram_id) WHERE status IN ('pending_isolation','active','suspended_subscription','paused')`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS managed_bots_request_id_unique ON managed_bots(request_id) WHERE request_id IS NOT NULL`;
}

export async function POST(request: Request) {
  const body = await readTextBody(request, 8192);
  if (!body.ok) {
    return Response.json(
      { ok: false, error: body.status === 413 ? "payload_too_large" : "invalid_request_body" },
      { status: body.status },
    );
  }
  const raw = body.value;
  const path = new URL(request.url).pathname;
  const timestamp = request.headers.get("x-factory-timestamp") ?? "";
  const signature = request.headers.get("x-factory-signature") ?? "";
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!authenticate(timestamp, signature, path, raw)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let payload: ProvisionPayload;
  try {
    payload = JSON.parse(raw) as ProvisionPayload;
    if (!/^[0-9a-f-]{36}$/i.test(payload.request_id) ||
        !Number.isSafeInteger(payload.owner_telegram_id) || payload.owner_telegram_id <= 0 ||
        payload.template !== "pre-crime" ||
        typeof payload.bot_token !== "string" || payload.bot_token.length < 30 ||
        payload.bot_token.length > 200 || idempotencyKey !== payload.request_id) {
      throw new Error("invalid_payload");
    }
  } catch {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const databaseUrl = process.env.DATABASE_URL;
  const masterWebhookSecret = (process.env.MANAGED_BOT_WEBHOOK_MASTER_SECRET ?? process.env.TELEGRAM_WEBHOOK_SECRET);
  const encryptionKey = process.env.MANAGED_BOT_TOKEN_ENCRYPTION_KEY_V2 ?? "";
  const vercelUrl = process.env.VERCEL_URL;
  const webhookBaseUrl = (process.env.MANAGED_BOT_WEBHOOK_BASE_URL ||
    (vercelUrl ? `https://${vercelUrl}` : "")).replace(/\/+$/, "");
  if (!databaseUrl || !masterWebhookSecret || masterWebhookSecret.length < 32 ||
      !/^[a-f0-9]{64}$/i.test(encryptionKey) || !webhookBaseUrl) {
    return Response.json({ ok: false, error: "source_configuration_missing" }, { status: 503 });
  }

  try {
    const sql = neon(databaseUrl) as unknown as Sql;
    await ensureFactorySchema(sql);

    const prior = await sql`SELECT bot_id, owner_telegram_id, status FROM managed_bots WHERE request_id = ${payload.request_id} LIMIT 1`;
    if (prior.length && Number(prior[0].owner_telegram_id) !== payload.owner_telegram_id) {
      return Response.json({ ok: false, error: "request_owner_mismatch" }, { status: 409 });
    }
    if (prior.length && prior[0].status === "active") {
      return Response.json({
        request_id: payload.request_id, instance_id: String(prior[0].bot_id),
        bot_id: Number(prior[0].bot_id), status: "active",
      });
    }

    const live = await sql`
      SELECT bot_id, status FROM managed_bots
      WHERE owner_telegram_id = ${payload.owner_telegram_id}
        AND status IN ('pending_isolation','active','suspended_subscription','paused')
      LIMIT 1
    `;
    if (live.length && (!prior.length || Number(live[0].bot_id) !== Number(prior[0].bot_id))) {
      return Response.json({ ok: false, error: "owner_already_has_precrime_bot" }, { status: 409 });
    }

    const identity = await createTelegramApi(payload.bot_token).getMe();
    if (!identity.id || identity.id <= 0) return Response.json({ ok: false, error: "invalid_bot_token" }, { status: 422 });

    const encrypted = encryptToken(payload.bot_token);
    if (prior.length) {
      await sql`
        UPDATE managed_bots SET bot_id = ${identity.id}, encrypted_token = ${encrypted}, status = 'pending_isolation',
          owner_telegram_id = ${payload.owner_telegram_id}, owner_username = ${null},
          admin_suspended = FALSE, updated_at = NOW()
        WHERE request_id = ${payload.request_id}
      `;
    } else {
      await sql`
        INSERT INTO managed_bots(bot_id, owner_telegram_id, owner_username, encrypted_token, status, request_id)
        VALUES (${identity.id}, ${payload.owner_telegram_id}, NULL, ${encrypted}, 'pending_isolation', ${payload.request_id})
      `;
    }

    const webhookSecret = deriveManagedWebhookSecret(masterWebhookSecret, identity.id);
    const webhookUrl = `${webhookBaseUrl}/api/telegram/managed/${identity.id}/webhook`;
    // Activate the durable row before registering the webhook so the first
    // Telegram delivery cannot race an inactive-row check.
    await sql`UPDATE managed_bots SET status = 'active', updated_at = NOW() WHERE bot_id = ${identity.id}`;
    await createTelegramApi(payload.bot_token).setWebhook(webhookUrl, webhookSecret);
    console.info("factory_managed_bot_provisioned", { botId: identity.id, ownerId: payload.owner_telegram_id });
    return Response.json({
      request_id: payload.request_id, instance_id: String(identity.id),
      bot_id: identity.id, bot_username: identity.username ?? null, status: "active",
    });
  } catch (error) {
    try {
      const sql = neon(databaseUrl) as unknown as Sql;
      await sql`UPDATE managed_bots SET status = 'failed', updated_at = NOW() WHERE request_id = ${payload.request_id}`;
    } catch { /* Preserve the original safe failure response. */ }
    console.error("factory_precrime_provision_failed", { errorType: error instanceof Error ? error.name : "unknown" });
    return Response.json({ ok: false, error: "precrime_provision_failed" }, { status: 503 });
  }
}
