import { createCipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createNeonRepo, createTenantSql, type Sql } from "../../../../lib/db";
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
      if (update.managed_bot) {
        const encryptionKey = process.env.MANAGED_BOT_TOKEN_ENCRYPTION_KEY ?? "";
        if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) {
          throw new Error("managed_bot_encryption_key_missing_or_invalid");
        }
        const managed = update.managed_bot;
        const childToken = await bot.getManagedBotToken(managed.bot.id);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), iv);
        const encrypted = Buffer.concat([cipher.update(childToken, "utf8"), cipher.final()]);
        const tokenCiphertext = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
        const membership = await bot.getChatMember(-1004463431688, managed.user.id).catch(() => null);
        const subscribed = Boolean(membership && ["member", "administrator", "creator"].includes(membership.status));
        await sql`
          CREATE TABLE IF NOT EXISTS managed_bots (
            bot_id BIGINT PRIMARY KEY,
            owner_telegram_id BIGINT NOT NULL,
            owner_username TEXT,
            bot_username TEXT,
            bot_display_name TEXT NOT NULL DEFAULT '',
            encrypted_token TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending_isolation'
              CHECK (status IN ('pending_isolation','active','suspended_subscription','failed','deleting')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;
        await sql`
          INSERT INTO managed_bots
            (bot_id, owner_telegram_id, owner_username, bot_username, bot_display_name, encrypted_token, status)
          VALUES
            (${managed.bot.id}, ${managed.user.id}, ${managed.user.username ?? null},
             ${managed.bot.username ?? null}, ${managed.bot.first_name ?? ""}, ${tokenCiphertext},
             ${subscribed ? "pending_isolation" : "suspended_subscription"})
          ON CONFLICT (bot_id) DO UPDATE SET
            owner_telegram_id = EXCLUDED.owner_telegram_id,
            owner_username = EXCLUDED.owner_username,
            bot_username = EXCLUDED.bot_username,
            bot_display_name = EXCLUDED.bot_display_name,
            encrypted_token = EXCLUDED.encrypted_token,
            status = EXCLUDED.status,
            updated_at = NOW()
        `;
        if (subscribed) {
          const childBot = createTelegramApi(childToken);
          const childIdentity = await childBot.getMe();
          if (childIdentity.id !== managed.bot.id) throw new Error("managed_bot_identity_mismatch");

          // Provision a private schema in the same Neon database, then attach
          // the child token to its own Telegram webhook endpoint.
          const tenantSql = await createTenantSql(sql, managed.bot.id);
          const tenantRepo = createNeonRepo(tenantSql);
          await tenantRepo.ensureSchema();

          const appOrigin = process.env.APP_URL
            ? new URL(process.env.APP_URL).origin
            : process.env.VERCEL_URL
              ? "https://" + process.env.VERCEL_URL
              : new URL(request.url).origin;
          const webhookUrl = new URL("/api/telegram/managed/" + managed.bot.id + "/webhook", appOrigin).toString();
          const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
          if (!webhookSecret) throw new Error("telegram_webhook_secret_missing");
          await childBot.setWebhook(webhookUrl, webhookSecret);
          await sql`
            UPDATE managed_bots SET status = 'active', updated_at = NOW()
            WHERE bot_id = ${managed.bot.id}
          `;
        }

        try {
          await bot.sendMessage(managed.user.id, subscribed
            ? "🎉 تم تشغيل نسختك الخاصة بنجاح! افتح البوت وابدأ بـ /start. بيانات مجموعاتك محفوظة في مساحة مستقلة داخل قاعدة Neon."
            : "⚠️ تم إنشاء البوت، لكن اشتراك قناة Pre Crime غير ظاهر حاليًا؛ اشترك في القناة ثم تواصل مع الدعم لاستكمال التفعيل.");
        } catch { /* the owner may not have opened the manager bot */ }
      }
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
  if (update.managed_bot) return "managed_bot";
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
