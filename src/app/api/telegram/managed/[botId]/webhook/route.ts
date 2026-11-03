import { createDecipheriv, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createTenantSql, createNeonRepo, type Sql } from "../../../../../../lib/db";
import { createTelegramApi } from "../../../../../../lib/telegram-api";
import { createWebhookHandler } from "../../../../../../lib/webhook-core";
import type { TelegramUpdate } from "../../../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeSecretMatch(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decryptToken(payload: string): string {
  const keyHex = process.env.MANAGED_BOT_TOKEN_ENCRYPTION_KEY_V2 ?? "";
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error("managed_bot_encryption_key_missing_or_invalid");
  const packed = Buffer.from(payload, "base64");
  if (packed.length < 29) throw new Error("managed_bot_token_payload_invalid");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function updateType(update: TelegramUpdate): string {
  if (update.message) return "message";
  if (update.edited_message) return "edited_message";
  if (update.callback_query) return "callback_query";
  if (update.my_chat_member) return "my_chat_member";
  if (update.chat_member) return "chat_member";
  if (update.chat_join_request) return "chat_join_request";
  return "unknown";
}

function chatIdOf(update: TelegramUpdate): number | null {
  if (update.message) return update.message.chat.id;
  if (update.edited_message) return update.edited_message.chat.id;
  if (update.callback_query?.message) return update.callback_query.message.chat.id;
  if (update.my_chat_member) return update.my_chat_member.chat.id;
  if (update.chat_member) return update.chat_member.chat.id;
  if (update.chat_join_request) return update.chat_join_request.chat.id;
  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ botId: string }> },
) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret || !safeSecretMatch(request.headers.get("x-telegram-bot-api-secret-token"), expectedSecret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const { botId: rawBotId } = await context.params;
  const botId = Number(rawBotId);
  if (!Number.isSafeInteger(botId) || botId <= 0) {
    return Response.json({ ok: false, error: "invalid_bot_id" }, { status: 400 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    return Response.json({ ok: false, error: "invalid_update_id" }, { status: 400 });
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return Response.json({ ok: false, error: "server_configuration_missing" }, { status: 503 });

  try {
    const sql = neon(databaseUrl) as unknown as Sql;
    const rows = await sql`SELECT encrypted_token, status, owner_telegram_id FROM managed_bots WHERE bot_id = ${botId} LIMIT 1`;
    const record = rows[0];
    if (!record || record.status !== "active") {
      return Response.json({ ok: false, error: "managed_bot_not_active" }, { status: 403 });
    }

    const token = decryptToken(String(record.encrypted_token));
    const bot = createTelegramApi(token);
    const identity = await bot.getMe();
    if (identity.id !== botId) {
      console.error("managed_bot_identity_mismatch", { botId, actualBotId: identity.id });
      return Response.json({ ok: false, error: "managed_bot_identity_mismatch" }, { status: 403 });
    }

    const tenantSql = await createTenantSql(sql, botId);
    const repo = createNeonRepo(tenantSql);
    await repo.ensureSchema();

    const claimed = await tenantSql`
      INSERT INTO telegram_updates (update_id, update_type, chat_id, status)
      VALUES (${update.update_id}, ${updateType(update)}, ${chatIdOf(update)}, 'processing')
      ON CONFLICT (update_id) DO UPDATE
        SET status = 'processing', received_at = NOW(), error_code = NULL
        WHERE telegram_updates.status = 'failed'
           OR (telegram_updates.status = 'processing' AND telegram_updates.received_at < NOW() - INTERVAL '2 minutes')
      RETURNING update_id
    `;
    if (claimed.length === 0) return Response.json({ ok: true, duplicate: true });

    try {
      const handler = createWebhookHandler({ repo, bot, supportOwnerId: Number(record.owner_telegram_id) });
      await handler.handleUpdate(update);
      await tenantSql`
        UPDATE telegram_updates
        SET status = 'processed', processed_at = NOW(), error_code = NULL
        WHERE update_id = ${update.update_id}
      `;
      return Response.json({ ok: true, processed: true });
    } catch (error) {
      console.error("managed_bot_update_failed", {
        botId,
        updateId: update.update_id,
        updateType: updateType(update),
        error: error instanceof Error ? error.message : String(error),
      });
      await tenantSql`
        UPDATE telegram_updates
        SET status = 'failed', error_code = 'handler_failed'
        WHERE update_id = ${update.update_id}
      `;
      return Response.json({ ok: false, error: "update_processing_failed" }, { status: 503 });
    }
  } catch (error) {
    console.error("managed_bot_webhook_failed", {
      botId,
      updateId: update.update_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ ok: false, error: "temporary_persistence_failure" }, { status: 503 });
  }
}
