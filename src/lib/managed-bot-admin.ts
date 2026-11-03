import { createDecipheriv } from "node:crypto";
import type { Sql } from "./db";
import { createTelegramApi } from "./telegram-api";
import { deriveManagedWebhookSecret } from "./managed-webhook-secret";
import { ensureSingleManagedBotPerOwner } from "./managed-bot-limit";

export interface ManagedBotAdminRow {
  bot_id: number;
  owner_telegram_id: number;
  owner_username: string | null;
  bot_username: string | null;
  bot_display_name: string;
  status: string;
  admin_suspended: boolean;
  created_at: string;
}

function decryptToken(payload: string): string {
  const keyHex = process.env.MANAGED_BOT_TOKEN_ENCRYPTION_KEY_V2 ?? "";
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error("managed_bot_encryption_key_missing_or_invalid");
  const packed = Buffer.from(payload, "base64");
  if (packed.length < 29) throw new Error("managed_bot_token_payload_invalid");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}

export function createManagedBotAdmin(sql: Sql, options: { appOrigin: string; webhookSecret: string }) {
  async function ensureColumn(): Promise<void> {
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
    await sql`ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS admin_suspended BOOLEAN NOT NULL DEFAULT FALSE`;
  }

  async function getRecord(botId: number): Promise<Record<string, unknown> | null> {
    if (!Number.isSafeInteger(botId) || botId <= 0) throw new Error("invalid_managed_bot_id");
    await ensureColumn();
    const rows = await sql`SELECT * FROM managed_bots WHERE bot_id = ${botId} LIMIT 1`;
    return rows[0] ?? null;
  }

  function childBot(record: Record<string, unknown>) {
    return createTelegramApi(decryptToken(String(record.encrypted_token)));
  }

  return {
    async list(): Promise<ManagedBotAdminRow[]> {
      await ensureColumn();
      const rows = await sql`SELECT bot_id, owner_telegram_id, owner_username, bot_username, bot_display_name, status, admin_suspended, created_at FROM managed_bots ORDER BY created_at DESC LIMIT 500`;
      return rows.map((r) => ({
        bot_id: Number(r.bot_id),
        owner_telegram_id: Number(r.owner_telegram_id),
        owner_username: r.owner_username == null ? null : String(r.owner_username),
        bot_username: r.bot_username == null ? null : String(r.bot_username),
        bot_display_name: String(r.bot_display_name ?? ""),
        status: String(r.status ?? "unknown"),
        admin_suspended: r.admin_suspended === true,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
      }));
    },

    async suspend(botId: number): Promise<void> {
      const record = await getRecord(botId);
      if (!record) throw new Error("managed_bot_not_found");
      await sql`UPDATE managed_bots SET admin_suspended = TRUE, updated_at = NOW() WHERE bot_id = ${botId}`;
      // The webhook route blocks this bot as soon as admin_suspended is committed.
      // Telegram webhook removal is best-effort; the server-side gate is authoritative.
      try { await childBot(record).deleteWebhook(false); }
      catch (error) { console.warn("managed_bot_admin_webhook_remove_failed", { botId, error: error instanceof Error ? error.message : String(error) }); }
    },

    async resume(botId: number): Promise<void> {
      const record = await getRecord(botId);
      if (!record) throw new Error("managed_bot_not_found");
      if (String(record.status) === "deleting") throw new Error("managed_bot_deletion_in_progress");
      const bot = childBot(record);
      const identity = await bot.getMe();
      if (identity.id !== botId) throw new Error("managed_bot_identity_mismatch");
      const webhookUrl = new URL("/api/telegram/managed/" + botId + "/webhook", options.appOrigin).toString();
      await bot.setWebhook(webhookUrl, deriveManagedWebhookSecret(options.webhookSecret, botId));
      const info = await bot.getWebhookInfo();
      if (info.url !== webhookUrl || info.last_error_message) throw new Error("managed_bot_webhook_verification_failed");
      await sql`UPDATE managed_bots SET admin_suspended = FALSE, updated_at = NOW() WHERE bot_id = ${botId}`;
    },

    async deletePermanently(botId: number): Promise<void> {
      const record = await getRecord(botId);
      if (!record) throw new Error("managed_bot_not_found");
      // Disable delivery before destructive work. A leftover row in deleting state
      // remains blocked if a later database operation fails and can be retried.
      await sql`UPDATE managed_bots SET admin_suspended = TRUE, status = 'deleting', updated_at = NOW() WHERE bot_id = ${botId}`;
      try { await childBot(record).deleteWebhook(true); }
      catch (error) { console.warn("managed_bot_delete_webhook_failed", { botId, error: error instanceof Error ? error.message : String(error) }); }
      const schema = "tenant_" + botId;
      if (!/^tenant_[1-9][0-9]*$/.test(schema)) throw new Error("invalid_managed_tenant_schema");
      const statement = ['DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'] as unknown as TemplateStringsArray;
      Object.defineProperty(statement, "raw", { value: ['DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'] });
      await sql(statement);
      await sql`DELETE FROM managed_bots WHERE bot_id = ${botId} AND status = 'deleting'`;
    },
  };
}
