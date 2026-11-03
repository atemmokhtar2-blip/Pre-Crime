import { defaultSettings, mergeSettings } from "./settings";
import type {
  AuditRow,
  GroupRow,
  GroupSettings,
  MemberRow,
  ModerationRow,
  PendingAction,
  PreCrimeRepo,
} from "./types";

// Loose structural type for the Neon tagged-template query helper. We only rely
// on its tagged-template call shape and treat every result as a row array, which
// sidesteps Neon's generic FullResults overload resolution during type-checking.
export type Sql = ((query: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>) & { tenantSchema?: string };

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toJson(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

// Idempotent DDL. Run once per warm instance (see ensureSchemaCache).
export async function ensureSchema(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      username TEXT,
      chat_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      owner_user_id BIGINT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS group_members (
      chat_id BIGINT NOT NULL,
      telegram_user_id BIGINT NOT NULL,
      username TEXT,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      message_count BIGINT NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      warned BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (chat_id, telegram_user_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS group_settings (
      chat_id BIGINT PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS telegram_updates (
      update_id BIGINT PRIMARY KEY,
      update_type TEXT NOT NULL,
      chat_id BIGINT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received','processing','processed','failed')),
      error_code TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS moderation_actions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      target_telegram_user_id BIGINT NOT NULL,
      actor_telegram_user_id BIGINT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS warnings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      target_telegram_user_id BIGINT NOT NULL,
      actor_telegram_user_id BIGINT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      chat_id BIGINT,
      actor_telegram_user_id BIGINT,
      actor_name TEXT,
      event_type TEXT NOT NULL,
      target TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS pending_actions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      group_id BIGINT NOT NULL,
      action TEXT NOT NULL,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS telegram_message_events (
      update_id BIGINT PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      telegram_user_id BIGINT NOT NULL,
      message_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS telegram_message_events_user_created_idx ON telegram_message_events(chat_id, telegram_user_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS group_members_status_idx ON group_members(chat_id, status)`;
  await sql`CREATE INDEX IF NOT EXISTS groups_owner_user_id_idx ON groups(owner_user_id, added_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS moderation_actions_group_created_idx ON moderation_actions(chat_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS audit_events_group_created_idx ON audit_events(chat_id, created_at DESC)`;
}

let messageEventPruneCounter = 0;

// Each managed bot uses its own PostgreSQL schema inside the shared Neon
// database. Existing repository queries are kept intact, but every table
// reference is qualified with the tenant schema.
export async function createTenantSql(sql: Sql, botId: number): Promise<Sql> {
  if (!Number.isSafeInteger(botId) || botId <= 0) throw new Error("invalid_managed_bot_id");
  const schema = "tenant_" + botId;
  const statement = ['CREATE SCHEMA IF NOT EXISTS "' + schema + '"'] as unknown as TemplateStringsArray;
  Object.defineProperty(statement, "raw", { value: ['CREATE SCHEMA IF NOT EXISTS "' + schema + '"'] });
  await sql(statement);

  const tables = "groups|group_members|group_settings|telegram_updates|moderation_actions|warnings|audit_events|pending_actions|telegram_message_events|bot_users|bot_admins|licenses|broadcasts|system_settings";
  const pattern = new RegExp("\\b(FROM|JOIN|INTO|UPDATE|ON)\\s+(" + tables + ")\\b", "gi");
  const createPattern = new RegExp("\\bTABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(" + tables + ")\\b", "gi");
  const tenantSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const rewrite = (part: string) => part
      .replace(pattern, (_match, keyword: string, table: string) => keyword + ' "' + schema + '".' + table)
      .replace(createPattern, (_match, table: string) => 'TABLE IF NOT EXISTS "' + schema + '".' + table)
      .replace(/pg_get_serial_sequence\('(licenses|broadcasts|audit_events)'/gi, (_match, table: string) => "pg_get_serial_sequence('" + schema + "." + table + "'");
    const cooked = Array.from(strings, rewrite) as unknown as TemplateStringsArray;
    Object.defineProperty(cooked, "raw", { value: Array.from(strings.raw, rewrite) });
    return sql(cooked, ...values);
  }) as Sql;
  tenantSql.tenantSchema = schema;
  return tenantSql;
}

export function createNeonRepo(sql: Sql): PreCrimeRepo {
  let schemaReady = false;
  async function ensure(): Promise<void> {
    if (schemaReady) return;
    await ensureSchema(sql);
    schemaReady = true;
  }

  return {
    async ensureSchema() {
      await ensure();
    },

    async upsertGroup(group) {
      await sql`
        INSERT INTO groups (chat_id, title, username, chat_type, status, timezone, owner_user_id, updated_at)
        VALUES (${group.chat_id}, ${group.title}, ${group.username ?? null}, ${group.chat_type}, ${group.status}, ${group.timezone}, ${group.owner_user_id ?? null}, NOW())
        ON CONFLICT (chat_id) DO UPDATE SET
          title = EXCLUDED.title,
          username = EXCLUDED.username,
          chat_type = EXCLUDED.chat_type,
          status = EXCLUDED.status,
          timezone = EXCLUDED.timezone,
          owner_user_id = COALESCE(groups.owner_user_id, EXCLUDED.owner_user_id),
          updated_at = NOW()
      `;
    },

    async getGroup(chatId) {
      const rows = await sql`SELECT * FROM groups WHERE chat_id = ${chatId} LIMIT 1`;
      if (!rows.length) return null;
      const r = rows[0] as Record<string, unknown>;
      return {
        chat_id: Number(r.chat_id),
        title: String(r.title),
        username: (r.username as string) ?? null,
        chat_type: String(r.chat_type),
        status: (r.status as GroupRow["status"]) ?? "active",
        timezone: String(r.timezone ?? "UTC"),
        added_at: toIsoTimestamp(r.added_at),
        owner_user_id: r.owner_user_id == null ? null : Number(r.owner_user_id),
      };
    },

    async listOwnedGroups(ownerId) {
      const rows = await sql`SELECT * FROM groups WHERE owner_user_id = ${ownerId} ORDER BY added_at DESC`;
      return rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          chat_id: Number(row.chat_id),
          title: String(row.title),
          username: (row.username as string) ?? null,
          chat_type: String(row.chat_type),
          status: (row.status as GroupRow["status"]) ?? "active",
          timezone: String(row.timezone ?? "UTC"),
          added_at: toIsoTimestamp(row.added_at),
          owner_user_id: row.owner_user_id == null ? null : Number(row.owner_user_id),
        };
      });
    },

    async getSettings(chatId) {
      const rows = await sql`SELECT settings FROM group_settings WHERE chat_id = ${chatId} LIMIT 1`;
      const raw = rows.length ? parseJson<Record<string, unknown>>(rows[0].settings, {}) : {};
      return mergeSettings(defaultSettings(), raw);
    },

    async setSettings(chatId, settings) {
      await sql`
        INSERT INTO group_settings (chat_id, settings, updated_at)
        VALUES (${chatId}, ${toJson(settings)}::jsonb, NOW())
        ON CONFLICT (chat_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()
      `;
    },

    async upsertMember(member) {
      await sql`
        INSERT INTO group_members (chat_id, telegram_user_id, username, display_name, status, joined_at, last_seen_at, message_count, warning_count, warned)
        VALUES (${member.chat_id}, ${member.telegram_user_id}, ${member.username ?? null}, ${member.display_name}, ${member.status}, ${member.joined_at ?? null}, ${member.last_seen_at ?? null}, ${member.message_count}, ${member.warning_count}, ${member.warned})
        ON CONFLICT (chat_id, telegram_user_id) DO UPDATE SET
          username = COALESCE(EXCLUDED.username, group_members.username),
          display_name = EXCLUDED.display_name,
          status = EXCLUDED.status,
          last_seen_at = COALESCE(EXCLUDED.last_seen_at, group_members.last_seen_at),
          message_count = EXCLUDED.message_count,
          warning_count = EXCLUDED.warning_count,
          warned = EXCLUDED.warned
      `;
    },

    async getMember(chatId, userId) {
      const rows = await sql`SELECT * FROM group_members WHERE chat_id = ${chatId} AND telegram_user_id = ${userId} LIMIT 1`;
      if (!rows.length) return null;
      return mapMember(rows[0] as Record<string, unknown>);
    },

    async listMembers(chatId, query) {
      const rows = query
        ? await sql`
            SELECT * FROM group_members
            WHERE chat_id = ${chatId}
              AND (display_name ILIKE ${"%" + query + "%"} OR username ILIKE ${"%" + query + "%"})
            ORDER BY message_count DESC, display_name ASC
            LIMIT 50
          `
        : await sql`
            SELECT * FROM group_members
            WHERE chat_id = ${chatId}
            ORDER BY message_count DESC, display_name ASC
            LIMIT 50
          `;
      return rows.map((r) => mapMember(r as Record<string, unknown>));
    },

    async countMembers(chatId) {
      const rows = await sql`SELECT COUNT(*)::int AS c FROM group_members WHERE chat_id = ${chatId}`;
      return Number(rows[0]?.c ?? 0);
    },

    async countActiveMembers(chatId) {
      const rows = await sql`
        SELECT COUNT(*)::int AS c FROM group_members
        WHERE chat_id = ${chatId} AND status IN ('member','administrator','creator','restricted')
      `;
      return Number(rows[0]?.c ?? 0);
    },

    async listBanned(chatId) {
      const rows = await sql`
        SELECT * FROM group_members WHERE chat_id = ${chatId} AND status = 'banned'
        ORDER BY last_seen_at DESC NULLS LAST LIMIT 50
      `;
      return rows.map((r) => mapMember(r as Record<string, unknown>));
    },

    async addWarning(chatId, targetId, actorId, reason) {
      await sql`
        INSERT INTO warnings (chat_id, target_telegram_user_id, actor_telegram_user_id, reason)
        VALUES (${chatId}, ${targetId}, ${actorId}, ${reason})
      `;
      await sql`
        UPDATE group_members SET warning_count = warning_count + 1, warned = true
        WHERE chat_id = ${chatId} AND telegram_user_id = ${targetId}
      `;
      const rows = await sql`SELECT warning_count FROM group_members WHERE chat_id = ${chatId} AND telegram_user_id = ${targetId}`;
      return Number(rows[0]?.warning_count ?? 1);
    },

    async clearWarnings(chatId, targetId) {
      await sql`UPDATE group_members SET warning_count = 0, warned = false WHERE chat_id = ${chatId} AND telegram_user_id = ${targetId}`;
    },

    async addModeration(chatId, targetId, actorId, action, reason) {
      await sql`
        INSERT INTO moderation_actions (chat_id, target_telegram_user_id, actor_telegram_user_id, action, reason)
        VALUES (${chatId}, ${targetId}, ${actorId}, ${action}, ${reason})
      `;
    },

    async addAudit(chatId, actorId, actorName, eventType, target, details) {
      await sql`
        INSERT INTO audit_events (chat_id, actor_telegram_user_id, actor_name, event_type, target, details)
        VALUES (${chatId ?? null}, ${actorId ?? null}, ${actorName ?? null}, ${eventType}, ${target ?? null}, ${toJson(details)}::jsonb)
      `;
    },

    async listAudit(chatId, eventType, limit) {
      const rows = eventType
        ? await sql`
            SELECT id, chat_id, actor_telegram_user_id, actor_name, event_type, target, details::text AS details, created_at
            FROM audit_events WHERE chat_id = ${chatId} AND event_type = ${eventType}
            ORDER BY created_at DESC LIMIT ${limit ?? 30}
          `
        : await sql`
            SELECT id, chat_id, actor_telegram_user_id, actor_name, event_type, target, details::text AS details, created_at
            FROM audit_events WHERE chat_id = ${chatId}
            ORDER BY created_at DESC LIMIT ${limit ?? 30}
          `;
      return rows.map((r) => mapAudit(r as Record<string, unknown>));
    },

    async countAudit(chatId, eventType) {
      const rows = eventType
        ? await sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE chat_id = ${chatId} AND event_type = ${eventType}`
        : await sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE chat_id = ${chatId}`;
      return Number(rows[0]?.c ?? 0);
    },

    async totalMessages(chatId) {
      const rows = await sql`SELECT COALESCE(SUM(message_count),0)::bigint AS c FROM group_members WHERE chat_id = ${chatId}`;
      return Number(rows[0]?.c ?? 0);
    },

    async recordMessageEvent(chatId, userId, updateId, text, at, windowMs) {
      const rows = await sql`
        WITH inserted AS (
          INSERT INTO telegram_message_events (update_id, chat_id, telegram_user_id, message_text, created_at)
          VALUES (${updateId}, ${chatId}, ${userId}, ${text}, to_timestamp(${at} / 1000.0))
          ON CONFLICT (update_id) DO NOTHING
          RETURNING update_id
        )
        SELECT
          (EXTRACT(EPOCH FROM created_at) * 1000)::double precision AS at,
          message_text AS text
        FROM telegram_message_events
        WHERE chat_id = ${chatId}
          AND telegram_user_id = ${userId}
          AND update_id <> ${updateId}
          AND created_at >= to_timestamp(${at - windowMs} / 1000.0)
        ORDER BY created_at DESC
        LIMIT 59
      `;
      messageEventPruneCounter += 1;
      if (messageEventPruneCounter >= 1000) {
        messageEventPruneCounter = 0;
        try {
          await sql`DELETE FROM telegram_message_events WHERE created_at < NOW() - INTERVAL '24 hours'`;
        } catch (error) {
          console.error("telegram_message_event_prune_failed", error instanceof Error ? error.message : String(error));
        }
      }
      return rows.map((row) => ({ at: Number(row.at), text: String(row.text ?? "") }));
    },

    async totalWarnings(chatId) {
      const rows = await sql`SELECT COALESCE(SUM(warning_count),0)::int AS c FROM group_members WHERE chat_id = ${chatId}`;
      return Number(rows[0]?.c ?? 0);
    },

    async totalBans(chatId) {
      const rows = await sql`SELECT COUNT(*)::int AS c FROM moderation_actions WHERE chat_id = ${chatId} AND action = 'ban'`;
      return Number(rows[0]?.c ?? 0);
    },

    async totalMutes(chatId) {
      const rows = await sql`SELECT COUNT(*)::int AS c FROM moderation_actions WHERE chat_id = ${chatId} AND action = 'mute'`;
      return Number(rows[0]?.c ?? 0);
    },

    async setPending(action) {
      await sql`
        INSERT INTO pending_actions (chat_id, group_id, action, context)
        VALUES (${action.chat_id}, ${action.group_id}, ${action.action}, ${toJson(action.context)}::jsonb)
      `;
    },

    async getPending(chatId) {
      const rows = await sql`
        SELECT * FROM pending_actions WHERE chat_id = ${chatId} ORDER BY created_at DESC LIMIT 1
      `;
      if (!rows.length) return null;
      const r = rows[0] as Record<string, unknown>;
      return {
        chat_id: Number(r.chat_id),
        group_id: Number(r.group_id),
        action: String(r.action),
        context: parseJson<Record<string, string | number | undefined>>(r.context, {}),
      };
    },

    async clearPending(chatId) {
      await sql`DELETE FROM pending_actions WHERE chat_id = ${chatId}`;
    },
  };
}

function toIsoTimestamp(value: unknown): string {
  if (value == null || value === "") return "";
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function mapMember(r: Record<string, unknown>): MemberRow {
  return {
    chat_id: Number(r.chat_id),
    telegram_user_id: Number(r.telegram_user_id),
    username: (r.username as string) ?? null,
    display_name: String(r.display_name ?? ""),
    status: (r.status as MemberRow["status"]) ?? "member",
    joined_at: r.joined_at ? toIsoTimestamp(r.joined_at) : null,
    last_seen_at: r.last_seen_at ? toIsoTimestamp(r.last_seen_at) : null,
    message_count: Number(r.message_count ?? 0),
    warning_count: Number(r.warning_count ?? 0),
    warned: Boolean(r.warned),
  };
}

function mapAudit(r: Record<string, unknown>): AuditRow {
  return {
    id: Number(r.id),
    chat_id: r.chat_id == null ? null : Number(r.chat_id),
    actor_telegram_user_id: r.actor_telegram_user_id == null ? null : Number(r.actor_telegram_user_id),
    actor_name: r.actor_name ? String(r.actor_name) : null,
    event_type: String(r.event_type),
    target: r.target ? String(r.target) : null,
    details: String(r.details ?? "{}"),
    created_at: toIsoTimestamp(r.created_at),
  };
}

export function mapModerationRow(r: Record<string, unknown>): ModerationRow {
  return {
    id: Number(r.id),
    chat_id: Number(r.chat_id),
    target_telegram_user_id: Number(r.target_telegram_user_id),
    actor_telegram_user_id: Number(r.actor_telegram_user_id),
    action: String(r.action),
    reason: String(r.reason ?? ""),
    created_at: String(r.created_at ?? ""),
  };
}
