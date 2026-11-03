import { createDecipheriv, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createTenantSql, createNeonRepo, type Sql } from "../../../../../../lib/db";
import { createAdminStore } from "../../../../../../lib/admin/store";
import { createAdminPanel } from "../../../../../../lib/admin/handlers";
import { ADMIN_PERMISSIONS } from "../../../../../../lib/admin/core";
import { createTelegramApi } from "../../../../../../lib/telegram-api";
import { deriveManagedWebhookSecret } from "../../../../../../lib/managed-webhook-secret";
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
  const startedAt = Date.now();
  const { botId: rawBotId } = await context.params;
  const botId = Number(rawBotId);
  console.info("managed_bot_webhook_request", {
    botId: Number.isSafeInteger(botId) ? botId : rawBotId,
    hasSecretHeader: Boolean(request.headers.get("x-telegram-bot-api-secret-token")),
  });
  const masterWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  const expectedSecret = masterWebhookSecret ? deriveManagedWebhookSecret(masterWebhookSecret, botId) : null;
  const isCurrentSecret = Boolean(expectedSecret && safeSecretMatch(suppliedSecret, expectedSecret));
  const isLegacySecret = Boolean(masterWebhookSecret && safeSecretMatch(suppliedSecret, masterWebhookSecret));
  if (!expectedSecret || (!isCurrentSecret && !isLegacySecret)) {
    console.error("managed_bot_webhook_auth_failed", { botId, expectedSecretConfigured: Boolean(expectedSecret) });
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
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
  if (!databaseUrl) {
    console.error("managed_bot_webhook_config_missing", { botId, databaseUrlConfigured: false });
    return Response.json({ ok: false, error: "server_configuration_missing" }, { status: 503 });
  }

  let stage = "database_lookup";
  try {
    const sql = neon(databaseUrl) as unknown as Sql;
    const rows = await sql`SELECT encrypted_token, status, owner_telegram_id FROM managed_bots WHERE bot_id = ${botId} LIMIT 1`;
    const record = rows[0];
    console.info("managed_bot_db_lookup", { botId, found: Boolean(record), status: record?.status ?? null });
    if (!record || record.status !== "active") {
      console.error("managed_bot_inactive_or_missing", { botId, found: Boolean(record), status: record?.status ?? null });
      return Response.json({ ok: false, error: "managed_bot_not_active" }, { status: 403 });
    }

    stage = "token_decryption";
    const token = decryptToken(String(record.encrypted_token));
    console.info("managed_bot_token_decrypted", { botId });
    stage = "telegram_get_me";
    const bot = createTelegramApi(token);
    const identity = await bot.getMe();
    console.info("managed_bot_identity_verified", { botId, actualBotId: identity.id, username: identity.username ?? null });
    if (identity.id !== botId) {
      console.error("managed_bot_identity_mismatch", { botId, actualBotId: identity.id });
      return Response.json({ ok: false, error: "managed_bot_identity_mismatch" }, { status: 403 });
    }

    // One-time, self-service migration for bots that still have the legacy
    // shared webhook secret. Do not process the triggering payload: ask
    // Telegram to retry it after the per-bot secret has taken effect.
    if (isLegacySecret && !isCurrentSecret && masterWebhookSecret) {
      const rotatedSecret = deriveManagedWebhookSecret(masterWebhookSecret, botId);
      const webhookUrl = new URL("/api/telegram/managed/" + botId + "/webhook", request.url).toString();
      await bot.setWebhook(webhookUrl, rotatedSecret);
      console.warn("managed_bot_legacy_webhook_secret_rotated", { botId });
      return Response.json({ ok: false, error: "webhook_secret_rotated_retry_delivery" }, { status: 503 });
    }

    stage = "tenant_schema";
    const tenantSql = await createTenantSql(sql, botId);
    const repo = createNeonRepo(tenantSql);
    await repo.ensureSchema();

    const ownerId = Number(record.owner_telegram_id);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
      throw new Error("managed_bot_owner_identity_invalid");
    }

    // Every tenant gets its own admin tables, users, settings, broadcasts and audit.
    // The owner is an admin only inside this bot's tenant schema.
    const adminStore = createAdminStore(tenantSql);
    await adminStore.ensureReady();
    await tenantSql`
      INSERT INTO bot_admins (telegram_user_id, display_name, status, permissions, added_by)
      VALUES (
        ${ownerId},
        ${record.owner_username ? "@" + String(record.owner_username) : "مالك النسخة"},
        'active',
        ${JSON.stringify(ADMIN_PERMISSIONS)}::jsonb,
        ${ownerId}
      )
      ON CONFLICT (telegram_user_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        status = 'active',
        permissions = EXCLUDED.permissions
    `;
    const appOrigin = new URL(request.url).origin;
    const admin = createAdminPanel({
      store: adminStore,
      repo,
      bot,
      ownerIds: [ownerId],
      tenantMode: true,
      webhookUrl: new URL("/api/telegram/managed/" + botId + "/webhook", appOrigin).toString(),
      webhookSecret: expectedSecret,
    });

    console.info("managed_bot_tenant_schema_ready", { botId, ownerId });

    stage = "claim_update";
    console.info("managed_bot_update_received", {
      botId, updateId: update.update_id, updateType: updateType(update),
      chatId: chatIdOf(update), isStart: Boolean(update.message?.text?.trim().match(/^\/start(?:@\w+)?(?:\s|$)/i)),
    });
    const claimed = await tenantSql`
      INSERT INTO telegram_updates (update_id, update_type, chat_id, status)
      VALUES (${update.update_id}, ${updateType(update)}, ${chatIdOf(update)}, 'processing')
      ON CONFLICT (update_id) DO UPDATE
        SET status = 'processing', received_at = NOW(), error_code = NULL
        WHERE telegram_updates.status = 'failed'
           OR (telegram_updates.status = 'processing' AND telegram_updates.received_at < NOW() - INTERVAL '2 minutes')
      RETURNING update_id
    `;
    if (claimed.length === 0) {
      console.info("managed_bot_duplicate_update", { botId, updateId: update.update_id });
      return Response.json({ ok: true, duplicate: true });
    }

    try {
      // Enforce the primary channel subscription for private bot usage.
      // Group moderation remains active even for non-subscribed group members.
      const actor = update.message?.from ?? update.edited_message?.from ?? update.callback_query?.from;
      const privateChatId =
        update.message?.chat.type === "private" ? update.message.chat.id :
        update.edited_message?.chat.type === "private" ? update.edited_message.chat.id :
        update.callback_query?.message?.chat.type === "private" ? update.callback_query.message.chat.id :
        null;

      if (actor && privateChatId != null) {
        stage = "subscription_gate";
        const managerToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!managerToken) throw new Error("primary_bot_token_missing_for_subscription_check");
        const managerBot = createTelegramApi(managerToken);
        const membership = await managerBot.getChatMember("@K_J6k", actor.id);
        const subscribed = ["member", "administrator", "creator"].includes(membership.status);

        if (update.callback_query?.data === "subscription_check" && subscribed) {
          await bot.answerCallbackQuery(update.callback_query.id, { text: "تم التحقق من اشتراكك بنجاح ✅" });
          await bot.sendMessage(privateChatId, "✅ تم تفعيل الوصول. أرسل /start لفتح البوت.");
          await tenantSql`UPDATE telegram_updates SET status = 'processed', processed_at = NOW(), error_code = NULL WHERE update_id = ${update.update_id}`;
          return Response.json({ ok: true, processed: true });
        }

        if (!subscribed) {
          const markup = {
            reply_markup: {
              inline_keyboard: [
                [{ text: "📢 الاشتراك في القناة", url: "https://t.me/K_J6k" }],
                [{ text: "🔄 تحقق من الاشتراك", callback_data: "subscription_check" }],
              ],
            },
          };
          if (update.callback_query) {
            await bot.answerCallbackQuery(update.callback_query.id, {
              text: "🔒 يجب الاشتراك في قناة Pre Crime أولًا.",
              show_alert: true,
            });
            await bot.sendMessage(privateChatId, "🔒 لاستخدام هذا البوت، اشترك أولًا في قناة Pre Crime ثم اضغط تحقق من الاشتراك.", markup);
          } else {
            await bot.sendMessage(privateChatId, "🔒 لاستخدام هذا البوت، اشترك أولًا في قناة Pre Crime ثم اضغط تحقق من الاشتراك.", markup);
          }
          await tenantSql`UPDATE telegram_updates SET status = 'processed', processed_at = NOW(), error_code = NULL WHERE update_id = ${update.update_id}`;
          return Response.json({ ok: true, processed: true, subscription_required: true });
        }

        if (update.callback_query?.data === "subscription_check") {
          await bot.answerCallbackQuery(update.callback_query.id, { text: "تم التحقق من اشتراكك بنجاح ✅" });
          await bot.sendMessage(privateChatId, "✅ تم تفعيل الوصول. أرسل /start لفتح البوت.");
          await tenantSql`UPDATE telegram_updates SET status = 'processed', processed_at = NOW(), error_code = NULL WHERE update_id = ${update.update_id}`;
          return Response.json({ ok: true, processed: true });
        }
      }

      stage = "update_handler";
      const handler = createWebhookHandler({
        repo,
        bot,
        admin,
        adminStartPanel: true,
        supportOwnerId: ownerId,
      });
      await handler.handleUpdate(update);
      await tenantSql`
        UPDATE telegram_updates
        SET status = 'processed', processed_at = NOW(), error_code = NULL
        WHERE update_id = ${update.update_id}
      `;
      console.info("managed_bot_update_processed", { botId, updateId: update.update_id, durationMs: Date.now() - startedAt });
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
      stage,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ ok: false, error: "temporary_persistence_failure" }, { status: 503 });
  }
}
