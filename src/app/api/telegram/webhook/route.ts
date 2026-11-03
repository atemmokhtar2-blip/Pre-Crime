import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createNeonRepo, createTenantSql, type Sql } from "../../../../lib/db";
import { createAdminStore } from "../../../../lib/admin/store";
import { createAdminPanel } from "../../../../lib/admin/handlers";
import { createTelegramApi } from "../../../../lib/telegram-api";
import { deriveManagedWebhookSecret } from "../../../../lib/managed-webhook-secret";
import { readJsonBody } from "../../../../lib/http-security";
import { ensureSingleManagedBotPerOwner, findLiveManagedBot, findLiveManagedBotByBotId, isManagedBotLimitViolation } from "../../../../lib/managed-bot-limit";
import { createWebhookHandler } from "../../../../lib/webhook-core";
import type { TelegramUpdate } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function decryptManagedBotToken(payload: string): string {
  const keyHex = process.env.MANAGED_BOT_TOKEN_ENCRYPTION_KEY_V2 ?? '';
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error('managed_bot_encryption_key_missing_or_invalid');
  const packed = Buffer.from(payload, 'base64');
  if (packed.length < 29) throw new Error('managed_bot_token_payload_invalid');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}

async function ensureManagedBotsSchema(sql: Sql): Promise<void> {
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
  await ensureSingleManagedBotPerOwner(sql);
}

async function activatePendingManagedBots(sql: Sql, managerBot: ReturnType<typeof createTelegramApi>, ownerId: number, origin: string): Promise<void> {
  await ensureManagedBotsSchema(sql);
  const pending = await sql`SELECT bot_id, encrypted_token FROM managed_bots WHERE owner_telegram_id = ${ownerId} AND status IN ('pending_isolation','suspended_subscription') ORDER BY created_at ASC`;
  console.info("managed_bot_reconcile_started", { ownerId, pendingCount: pending.length });
  if (!pending.length) return;
  const membership = await managerBot.getChatMember("@K_J6k", ownerId).catch((error) => {
    console.error("managed_bot_subscription_check_failed", { ownerId, error: error instanceof Error ? error.message : String(error) });
    return null;
  });
  const subscribed = Boolean(membership && ['member', 'administrator', 'creator'].includes(membership.status));
  console.info("managed_bot_subscription_check", { ownerId, membershipStatus: membership?.status ?? null, subscribed });
  if (!subscribed) {
    await sql`UPDATE managed_bots SET status = 'suspended_subscription', updated_at = NOW() WHERE owner_telegram_id = ${ownerId} AND status IN ('pending_isolation','suspended_subscription')`;
    return;
  }
  for (const row of pending) {
    const botId = Number(row.bot_id);
    try {
      console.info("managed_bot_activation_started", { botId, ownerId });
      const childBot = createTelegramApi(decryptManagedBotToken(String(row.encrypted_token)));
      const identity = await childBot.getMe();
      console.info("managed_bot_activation_identity_verified", { botId, actualBotId: identity.id, username: identity.username ?? null });
      if (identity.id !== botId) throw new Error('managed_bot_identity_mismatch');
      const tenantSql = await createTenantSql(sql, botId);
      await createNeonRepo(tenantSql).ensureSchema();
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (!secret) throw new Error('telegram_webhook_secret_missing');
      const webhookUrl = new URL('/api/telegram/managed/' + botId + '/webhook', origin).toString();
      await childBot.setWebhook(webhookUrl, deriveManagedWebhookSecret(secret, botId));
      const webhookInfo = await childBot.getWebhookInfo();
      console.info("managed_bot_activation_webhook_set", {
        botId, webhookUrlMatches: webhookInfo.url === webhookUrl,
        pendingUpdateCount: webhookInfo.pending_update_count,
        hasLastError: Boolean(webhookInfo.last_error_message),
        lastErrorMessage: webhookInfo.last_error_message ?? null,
      });
      await sql`UPDATE managed_bots SET status = 'active', updated_at = NOW() WHERE bot_id = ${botId} AND owner_telegram_id = ${ownerId}`;
      console.info("managed_bot_activation_completed", { botId, ownerId });
      await managerBot.sendMessage(ownerId, 'تم تفعيل نسختك @' + (identity.username ?? botId) + ' بنجاح. افتحها وأرسل /start.');
    } catch (error) {
      console.error('managed_bot_pending_activation_failed', { botId, ownerId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
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

  const parsedBody = await readJsonBody<TelegramUpdate>(request, 1024 * 1024);
  if (!parsedBody.ok) {
    return Response.json(
      { ok: false, error: parsedBody.status === 413 ? "payload_too_large" : "invalid_json" },
      { status: parsedBody.status },
    );
  }
  const update = parsedBody.value;

  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    return Response.json({ ok: false, error: "invalid_update_id" }, { status: 400 });
  }

  console.info("telegram_webhook_received", {
    updateId: update.update_id,
    updateType: updateType(update),
    updateKeys: Object.keys(update),
    hasManagedBot: Boolean(update.managed_bot),
    managedBotId: update.managed_bot?.bot.id ?? null,
    managedBotOwnerId: update.managed_bot?.user.id ?? null,
    managedBotUsername: update.managed_bot?.bot.username ?? null,
    hasCallbackData: Boolean(update.callback_query?.data),
    callbackActorId: update.callback_query?.from.id ?? null,
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
      console.warn("telegram_update_duplicate_or_already_processing", { updateId: update.update_id, updateType: updateType(update) });
      return Response.json({ ok: true, duplicate: true });
    }
    console.info("telegram_update_claimed", { updateId: update.update_id, updateType: updateType(update) });

    try {
      const bot = createTelegramApi(token);
      if (update.managed_bot) {
        console.info("managed_bot_update_received_on_manager", {
          botId: update.managed_bot.bot.id, ownerId: update.managed_bot.user.id,
          botUsername: update.managed_bot.bot.username ?? null,
        });
        // Clone provisioning is isolated: it must never interrupt primary bot traffic.
        try {
          const encryptionKey = process.env.MANAGED_BOT_TOKEN_ENCRYPTION_KEY_V2 ?? "";
          if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) {
            throw new Error("managed_bot_encryption_key_missing_or_invalid");
          }
          const managed = update.managed_bot;
          await ensureManagedBotsSchema(sql);
          const existingTokenBot = await findLiveManagedBotByBotId(sql, managed.bot.id);
          if (existingTokenBot) {
            throw new Error("managed_bot_token_already_in_use");
          }
          const existingOwnerBot = await findLiveManagedBot(sql, managed.user.id);
          if (existingOwnerBot && existingOwnerBot.bot_id !== managed.bot.id) {
            await bot.sendMessage(managed.user.id, "⛔ مسموح لك بنسخة واحدة فقط. لديك نسخة مسجلة بالفعل؛ لا يمكن تفعيل نسخة ثانية.");
            throw new Error("owner_already_has_managed_bot");
          }
          console.info("managed_bot_provisioning_step", { updateId: update.update_id, step: "token_fetch_started", botId: managed.bot.id, ownerId: managed.user.id });
          const childToken = await bot.getManagedBotToken(managed.bot.id);
          console.info("managed_bot_provisioning_step", { updateId: update.update_id, step: "token_fetch_completed", botId: managed.bot.id, tokenReceived: Boolean(childToken), tokenLength: childToken.length });
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), iv);
          const encrypted = Buffer.concat([cipher.update(childToken, "utf8"), cipher.final()]);
          const tokenCiphertext = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
          console.info("managed_bot_token_encrypted", { botId: managed.bot.id, encryptionKeyConfigured: true });
          const membership = await bot.getChatMember("@K_J6k", managed.user.id).catch((error) => {
            console.error("managed_bot_subscription_check_failed", { botId: managed.bot.id, ownerId: managed.user.id, error: error instanceof Error ? error.message : String(error) });
            return null;
          });
          const subscribed = Boolean(membership && ["member", "administrator", "creator"].includes(membership.status));
          console.info("managed_bot_subscription_check", { botId: managed.bot.id, ownerId: managed.user.id, membershipStatus: membership?.status ?? null, subscribed });
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
          const managedSaved = await sql`
            INSERT INTO managed_bots
              (bot_id, owner_telegram_id, owner_username, bot_username, bot_display_name, encrypted_token, status)
            VALUES
              (${managed.bot.id}, ${managed.user.id}, ${managed.user.username ?? null},
               ${managed.bot.username ?? null}, ${managed.bot.first_name ?? ""}, ${tokenCiphertext},
               ${subscribed ? "pending_isolation" : "suspended_subscription"})
            ON CONFLICT (bot_id) DO UPDATE SET
              owner_username = EXCLUDED.owner_username,
              bot_username = EXCLUDED.bot_username,
              bot_display_name = EXCLUDED.bot_display_name,
              encrypted_token = EXCLUDED.encrypted_token,
              status = EXCLUDED.status,
              updated_at = NOW()
            WHERE managed_bots.owner_telegram_id = EXCLUDED.owner_telegram_id
            RETURNING bot_id
          `;
          if (!managedSaved.length) throw new Error("managed_bot_already_owned_by_another_user");
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
            await childBot.setWebhook(webhookUrl, deriveManagedWebhookSecret(webhookSecret, managed.bot.id));
            const webhookInfo = await childBot.getWebhookInfo();
            console.info("managed_bot_provisioning_webhook_set", {
              botId: managed.bot.id, webhookUrlMatches: webhookInfo.url === webhookUrl,
              pendingUpdateCount: webhookInfo.pending_update_count,
              hasLastError: Boolean(webhookInfo.last_error_message),
              lastErrorMessage: webhookInfo.last_error_message ?? null,
            });
            await sql`
              UPDATE managed_bots SET status = 'active', updated_at = NOW()
              WHERE bot_id = ${managed.bot.id} AND owner_telegram_id = ${managed.user.id}
            `;
            console.info("managed_bot_provisioning_completed", { botId: managed.bot.id, ownerId: managed.user.id });
          }
  
          try {
            await bot.sendMessage(managed.user.id, subscribed
              ? "🎉 تم تشغيل نسختك الخاصة بنجاح! افتح البوت وابدأ بـ /start. بيانات مجموعاتك محفوظة في مساحة مستقلة داخل قاعدة Neon."
              : "⚠️ تم إنشاء البوت، لكن اشتراك قناة Pre Crime غير ظاهر حاليًا؛ اشترك في القناة ثم تواصل مع الدعم لاستكمال التفعيل.");
          } catch { /* the owner may not have opened the manager bot */ }
        
        } catch (error) {
          if (isManagedBotLimitViolation(error)) { try { await bot.sendMessage(update.managed_bot.user.id, "⛔ مسموح لك بنسخة واحدة فقط. تم رفض إنشاء النسخة الإضافية."); } catch {} }
          const tokenAlreadyInUse = error instanceof Error && error.message === "managed_bot_token_already_in_use";
          if (tokenAlreadyInUse) { try { await bot.sendMessage(update.managed_bot.user.id, "⛔ فشل التفعيل: توكن هذا البوت مسجل بالفعل في نسخة موجودة أو قيد التفعيل. لم يتم إنشاء نسخة جديدة."); } catch {} }
          console.error("managed_bot_provisioning_failed", {
            updateId: update.update_id,
            stage: "managed_bot_provisioning",
            botId: update.managed_bot.bot.id,
            ownerId: update.managed_bot.user.id,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!tokenAlreadyInUse) {
            try {
              await bot.sendMessage(update.managed_bot.user.id, "⚠️ تعذر تجهيز النسخة الآن، لكن البوت الأساسي ما زال يعمل. حاول مرة أخرى لاحقًا أو تواصل مع الدعم.");
            } catch { /* owner may not have opened the primary bot */ }
          }
        }
      }
      if (update.message?.chat.type === 'private' && update.message.from && /^\/start(?:@\w+)?(?:\s|$)/i.test((update.message.text ?? '').trim())) {
        const appOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : new URL(request.url).origin;
        // Clone reconciliation is optional and cannot block the primary bot.
        try {
          await activatePendingManagedBots(sql, bot, update.message.from.id, appOrigin);
        } catch (error) {
          console.error("managed_bot_reconcile_failed", {
            ownerId: update.message.from.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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

      // Manual clone-token onboarding. Never log or retain the plaintext token.
      if (update.message?.chat.type === "private" && update.message.from && update.message.text) {
        const pending = await repo.getPending(update.message.chat.id);
        if (pending?.action === "clone_token" && pending.context.ownerId === update.message.from.id) {
          const ownerId = update.message.from.id;
          const rawToken = update.message.text.trim();
          try {
            await bot.deleteMessage(update.message.chat.id, update.message.message_id);
          } catch {
            await repo.clearPending(ownerId);
            await bot.sendMessage(ownerId, "⛔ تعذر حذف رسالة التوكن، لذلك أوقفنا التفعيل لحماية حسابك. ألغِ هذا التوكن من BotFather وأنشئ توكنًا جديدًا قبل إعادة المحاولة.");
            await sql`UPDATE telegram_updates SET status = 'processed', processed_at = NOW(), error_code = 'token_message_delete_failed' WHERE update_id = ${update.update_id}`;
            return Response.json({ ok: true, processed: true });
          }
          if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(rawToken)) {
            await bot.sendMessage(ownerId, "⚠️ صيغة التوكن غير صحيحة. أرسل التوكن كما نسخته من BotFather.");
            await sql`UPDATE pending_actions SET created_at = NOW() WHERE chat_id = ${ownerId} AND action = 'clone_token'`;
            await sql`UPDATE telegram_updates SET status = 'processed', processed_at = NOW() WHERE update_id = ${update.update_id}`;
            return Response.json({ ok: true, processed: true });
          }
          try {
            const membership = await bot.getChatMember("@K_J6k", ownerId);
            if (!["member", "administrator", "creator"].includes(membership.status)) {
              await repo.clearPending(ownerId);
              await bot.sendMessage(ownerId, "🔒 اشترك في قناة Pre Crime أولًا ثم ابدأ طلب إنشاء النسخة من جديد.");
              await sql`UPDATE telegram_updates SET status = 'processed', processed_at = NOW() WHERE update_id = ${update.update_id}`;
              return Response.json({ ok: true, processed: true });
            }
            const encryptionKey = process.env.MANAGED_BOT_TOKEN_ENCRYPTION_KEY_V2 ?? "";
            if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) throw new Error("managed_bot_encryption_key_missing_or_invalid");
            const childBot = createTelegramApi(rawToken);
            const identity = await childBot.getMe();
            if (!identity.username) throw new Error("bot_username_unavailable");
            await ensureManagedBotsSchema(sql);
            const existingTokenBot = await findLiveManagedBotByBotId(sql, identity.id);
            if (existingTokenBot) {
              await repo.clearPending(ownerId);
              await bot.sendMessage(ownerId, "⛔ فشل التفعيل: توكن هذا البوت مستخدم بالفعل في نسخة مسجلة أو قيد التفعيل. استخدم توكن بوت جديدًا غير مرتبط بأي نسخة.");
              await sql`UPDATE telegram_updates SET status = 'processed', processed_at = NOW(), error_code = 'bot_token_already_in_use' WHERE update_id = ${update.update_id}`;
              return Response.json({ ok: true, processed: true, error: "bot_token_already_in_use" });
            }
            const existingOwnerBot = await findLiveManagedBot(sql, ownerId);
            if (existingOwnerBot && existingOwnerBot.bot_id !== identity.id) {
              await repo.clearPending(ownerId);
              await bot.sendMessage(ownerId, "⛔ مسموح لك بنسخة واحدة فقط. لديك نسخة مسجلة بالفعل؛ لا يمكن تفعيل نسخة ثانية.");
              return Response.json({ ok: true, processed: true, error: "one_managed_bot_limit" });
            }
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", Buffer.from(encryptionKey, "hex"), iv);
            const encrypted = Buffer.concat([cipher.update(rawToken, "utf8"), cipher.final()]);
            const tokenCiphertext = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
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
            await ensureSingleManagedBotPerOwner(sql);
            const saved = await sql`
              INSERT INTO managed_bots
                (bot_id, owner_telegram_id, owner_username, bot_username, bot_display_name, encrypted_token, status)
              VALUES
                (${identity.id}, ${ownerId}, ${update.message.from.username ?? null},
                 ${identity.username}, ${identity.first_name ?? ""}, ${tokenCiphertext}, 'pending_isolation')
              ON CONFLICT (bot_id) DO UPDATE SET
                owner_username = EXCLUDED.owner_username,
                bot_username = EXCLUDED.bot_username,
                bot_display_name = EXCLUDED.bot_display_name,
                encrypted_token = EXCLUDED.encrypted_token,
                status = 'pending_isolation',
                updated_at = NOW()
              WHERE managed_bots.owner_telegram_id = EXCLUDED.owner_telegram_id
              RETURNING bot_id
            `;
            if (!saved.length) throw new Error("bot_already_registered_to_another_owner");
            const tenantSql = await createTenantSql(sql, identity.id);
            await createNeonRepo(tenantSql).ensureSchema();
            const appOrigin = process.env.APP_URL
              ? new URL(process.env.APP_URL).origin
              : process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : new URL(request.url).origin;
            const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
            if (!webhookSecret) throw new Error("telegram_webhook_secret_missing");
            const webhookUrl = new URL("/api/telegram/managed/" + identity.id + "/webhook", appOrigin).toString();
            await childBot.setWebhook(webhookUrl, deriveManagedWebhookSecret(webhookSecret, identity.id));
            const info = await childBot.getWebhookInfo();
            if (info.url !== webhookUrl || info.last_error_message) throw new Error("child_webhook_verification_failed");
            await sql`UPDATE managed_bots SET status = 'active', updated_at = NOW() WHERE bot_id = ${identity.id} AND owner_telegram_id = ${ownerId}`;
            await repo.clearPending(ownerId);
            await bot.sendMessage(ownerId, "🎉 تم تفعيل نسختك @" + identity.username + " بنجاح! افتح البوت وأرسل /start.");
          } catch (error) {
            if (isManagedBotLimitViolation(error)) { try { await bot.sendMessage(ownerId, "⛔ مسموح لك بنسخة واحدة فقط. تم رفض إنشاء النسخة الإضافية."); } catch {} }
            const tokenAlreadyInUse = error instanceof Error && error.message === "bot_already_registered_to_another_owner";
            console.error("manual_clone_token_provisioning_failed", {
              ownerId, error: error instanceof Error ? error.message : "unknown_error",
            });
            await repo.clearPending(ownerId);
            await bot.sendMessage(ownerId, tokenAlreadyInUse
              ? "⛔ فشل التفعيل: هذا التوكن مرتبط بالفعل بنسخة أخرى أو بحساب آخر. لم يتم تشغيل نسخة مكررة. استخدم توكن بوت جديدًا."
              : "⚠️ فشل تفعيل النسخة: تأكد من صحة التوكن وأن البوت غير مربوط بحساب آخر، ثم أعد المحاولة. لم يتم تسجيل التوكن كنص مكشوف.");
          }
          await sql`UPDATE telegram_updates SET status = 'processed', processed_at = NOW(), error_code = NULL WHERE update_id = ${update.update_id}`;
          return Response.json({ ok: true, processed: true });
        }
      }
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
