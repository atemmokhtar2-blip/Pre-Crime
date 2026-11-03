import type { Sql } from "./db";

const LIVE_STATUSES = ["pending_isolation", "active", "suspended_subscription", "paused"] as const;

/**
 * Enforce one live managed bot per Telegram owner at the database layer.
 * Legacy duplicate rows are deterministically disabled (oldest row wins)
 * before the partial unique index is created. The webhook handler rejects
 * every non-active row, so disabled duplicates cannot continue operating.
 */
export async function ensureSingleManagedBotPerOwner(sql: Sql): Promise<void> {
  await sql`
    WITH ranked AS (
      SELECT bot_id,
             ROW_NUMBER() OVER (
               PARTITION BY owner_telegram_id
               ORDER BY
                 CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                 created_at ASC,
                 bot_id ASC
             ) AS owner_rank
      FROM managed_bots
      WHERE status IN ('pending_isolation', 'active', 'suspended_subscription', 'paused')
    )
    UPDATE managed_bots AS managed
    SET status = 'failed', updated_at = NOW()
    FROM ranked
    WHERE managed.bot_id = ranked.bot_id
      AND ranked.owner_rank > 1
  `;

  const indexes = await sql`SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'managed_bots_one_live_bot_per_owner' LIMIT 1`;
  if (indexes.length && !String(indexes[0].indexdef ?? "").includes("'paused'")) {
    await sql`DROP INDEX managed_bots_one_live_bot_per_owner`;
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS managed_bots_one_live_bot_per_owner
    ON managed_bots (owner_telegram_id)
    WHERE status IN ('pending_isolation', 'active', 'suspended_subscription', 'paused')
  `;
}

export async function findLiveManagedBot(sql: Sql, ownerId: number): Promise<{ bot_id: number; status: string } | null> {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new Error("invalid_managed_bot_owner_id");
  }
  const rows = await sql`
    SELECT bot_id, status
    FROM managed_bots
    WHERE owner_telegram_id = ${ownerId}
      AND status IN ('pending_isolation', 'active', 'suspended_subscription', 'paused')
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at ASC
    LIMIT 1
  `;
  return rows.length
    ? { bot_id: Number(rows[0].bot_id), status: String(rows[0].status) }
    : null;
}

export async function findLiveManagedBotByBotId(sql: Sql, botId: number): Promise<{ bot_id: number; owner_telegram_id: number; status: string } | null> {
  if (!Number.isSafeInteger(botId) || botId <= 0) {
    throw new Error("invalid_managed_bot_id");
  }
  const rows = await sql`
    SELECT bot_id, owner_telegram_id, status
    FROM managed_bots
    WHERE bot_id = ${botId}
      AND status IN ('pending_isolation', 'active', 'suspended_subscription', 'paused')
    LIMIT 1
  `;
  return rows.length
    ? { bot_id: Number(rows[0].bot_id), owner_telegram_id: Number(rows[0].owner_telegram_id), status: String(rows[0].status) }
    : null;
}

export function isManagedBotLimitViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" &&
    candidate.constraint === "managed_bots_one_live_bot_per_owner";
}
