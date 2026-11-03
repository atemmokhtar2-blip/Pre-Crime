import { timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createNeonRepo, type Sql } from "../../../../lib/db";
import { createAdminStore } from "../../../../lib/admin/store";
import { createAdminPanel } from "../../../../lib/admin/handlers";
import { createTelegramApi } from "../../../../lib/telegram-api";
import { createWebhookHandler } from "../../../../lib/webhook-core";
import type { TelegramUpdate } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeSecretMatch(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret || !safeSecretMatch(request.headers.get("x-telegram-bot-api-secret-token"), expectedSecret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
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

  console.info("telegram_webhook_received", {
    updateId: update.update_id,
    updateType: updateType(update),
    hasCallbackData: Boolean(update.callback_query?.data),
    callbackSection: update.callback_query?.data?.split(":")[1] ?? null,
  });

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const databaseUrl = process.env.DATABASE_URL;
  if (!token || !databaseUrl) {
    return Response.json({ ok: false, error: "server_configuration_missing" }, { status: 503 });
  }

  try {
    const sql = neon(databaseUrl) as unknown as Sql;
    const repo = createNeonRepo(sql);

    await repo.ensureSchema();

    // Idempotent update claim. Failed deliveries may be retried; successful ones
    // return early without duplicating side effects.
    const claimed = await sql`
      INSERT INTO telegram_updates (update_id, update_type, chat_id, status)
      VALUES (${update.update_id}, ${updateType(update)}, ${chatIdOf(update)}, 'processing')
      ON CONFLICT (update_id) DO UPDATE
        SET status = 'processing', received_at = NOW(), error_code = NULL
        WHERE telegram_updates.status = 'failed'
           OR (telegram_updates.status = 'processing' AND telegram_updates.received_at < NOW() - INTERVAL '2 minutes')
      RETURNING update_id
    `;

    if (claimed.length === 0) {
      return Response.json({ ok: true, duplicate: true });
    }

    try {
      const bot = createTelegramApi(token);
      const ownerIds = (process.env.BOT_OWNER_IDS ?? "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isSafeInteger(value) && value > 0);
      const admin = createAdminPanel({
        store: createAdminStore(sql),
        repo,
        bot,
        ownerIds,
        webhookUrl: process.env.APP_URL ? new URL("/api/telegram/webhook", process.env.APP_URL).toString() : undefined,
        webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
      });
      const handler = createWebhookHandler({ repo, bot, admin });
      await handler.handleUpdate(update);

      await sql`
        UPDATE telegram_updates
        SET status = 'processed', processed_at = NOW(), error_code = NULL
        WHERE update_id = ${update.update_id}
      `;
      return Response.json({ ok: true, processed: true });
    } catch (error) {
      console.error("telegram_update_handler_failed", {
        updateId: update.update_id,
        updateType: updateType(update),
        error: error instanceof Error ? error.message : String(error),
      });
      await sql`
        UPDATE telegram_updates
        SET status = 'failed', error_code = 'handler_failed'
        WHERE update_id = ${update.update_id}
      `;
      return Response.json({ ok: false, error: "update_processing_failed" }, { status: 503 });
    }
  } catch (error) {
    console.error("telegram_webhook_persistence_failed", {
      updateId: update.update_id,
      updateType: updateType(update),
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ ok: false, error: "temporary_persistence_failure" }, { status: 503 });
  }
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
