import { createHmac } from "node:crypto";

/**
 * Derive a distinct Telegram webhook secret for each managed bot.
 * Telegram accepts 1-256 characters from A-Z, a-z, 0-9, "_" and "-";
 * a SHA-256 HMAC hex digest satisfies that contract.
 */
export function deriveManagedWebhookSecret(masterSecret: string, botId: number): string {
  if (typeof masterSecret !== "string" || masterSecret.length < 32) {
    throw new Error("telegram_webhook_secret_missing_or_too_short");
  }
  if (!Number.isSafeInteger(botId) || botId <= 0) {
    throw new Error("invalid_managed_bot_id");
  }
  return createHmac("sha256", masterSecret)
    .update("pre-crime:managed-webhook:v1:")
    .update(String(botId))
    .digest("hex");
}
