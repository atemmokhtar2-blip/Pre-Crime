// Pre-Crime super-admin panel — persistence layer (Neon tagged-template SQL).
// Every read/write the admin panel needs lives here; handlers stay SQL-free.

import type { Sql } from "../db";
import type { AuditRow } from "../types";
import {
  defaultSystemConfig,
  type AdminPermission,
  type BotAdminRow,
  type BotUserRow,
  type BroadcastRow,
  type LicenseRow,
  type SystemConfig,
} from "./core";

function toIso(value: unknown): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

let adminSchemaReady = false;

export async function ensureAdminSchema(sql: Sql): Promise<void> {
  if (adminSchemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS bot_users (
      telegram_user_id BIGINT PRIMARY KEY,
      username TEXT,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned','disabled')),
      note TEXT NOT NULL DEFAULT '',
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS bot_admins (
      telegram_user_id BIGINT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
      added_by BIGINT,
      ops_count INTEGER NOT NULL DEFAULT 0,
      last_active_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS licenses (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL DEFAULT 'group',
      duration_days INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','active','expired','suspended','cancelled')),
      linked_group_id BIGINT,
      linked_user_id BIGINT,
      created_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      actor_id BIGINT NOT NULL,
      audience TEXT NOT NULL,
      content_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','done','stopped','failed')),
      total INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS bot_users_status_idx ON bot_users(status, last_seen_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS licenses_status_idx ON licenses(status, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS broadcasts_created_idx ON broadcasts(created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS audit_events_created_global_idx ON audit_events(created_at DESC)`;
  adminSchemaReady = true;
}

export function createAdminStore(sql: Sql) {
  async function ready() {
    await ensureAdminSchema(sql);
  }

  // ---- bot users ----
  async function trackUser(userId: number, username: string | null, displayName: string): Promise<void> {
    await ready();
    await sql`
      INSERT INTO bot_users (telegram_user_id, username, display_name, last_seen_at)
      VALUES (${userId}, ${username}, ${displayName}, NOW())
      ON CONFLICT (telegram_user_id) DO UPDATE SET
        username = COALESCE(EXCLUDED.username, bot_users.username),
        display_name = EXCLUDED.display_name,
        last_seen_at = NOW()
    `;
  }

  function mapUser(r: Record<string, unknown>): BotUserRow {
    return {
      telegram_user_id: Number(r.telegram_user_id),
      username: (r.username as string) ?? null,
      display_name: String(r.display_name ?? ""),
      status: (r.status as BotUserRow["status"]) ?? "active",
      note: String(r.note ?? ""),
      first_seen_at: toIso(r.first_seen_at),
      last_seen_at: toIso(r.last_seen_at),
    };
  }

  return {
    ensureReady: ready,
    trackUser,

    async getUser(userId: number): Promise<BotUserRow | null> {
      await ready();
      const rows = await sql`SELECT * FROM bot_users WHERE telegram_user_id = ${userId} LIMIT 1`;
      return rows.length ? mapUser(rows[0]) : null;
    },

    async listUsers(filter: string, query?: string): Promise<BotUserRow[]> {
      await ready();
      const q = query ? `%${query}%` : null;
      let rows: Record<string, unknown>[];
      if (q) {
        rows = await sql`
          SELECT * FROM bot_users
          WHERE display_name ILIKE ${q} OR username ILIKE ${q} OR CAST(telegram_user_id AS TEXT) LIKE ${q}
          ORDER BY last_seen_at DESC LIMIT 200`;
      } else if (filter === "active") {
        rows = await sql`SELECT * FROM bot_users WHERE status = 'active' ORDER BY last_seen_at DESC LIMIT 200`;
      } else if (filter === "banned") {
        rows = await sql`SELECT * FROM bot_users WHERE status IN ('banned','disabled') ORDER BY last_seen_at DESC LIMIT 200`;
      } else if (filter === "new") {
        rows = await sql`SELECT * FROM bot_users WHERE first_seen_at >= NOW() - INTERVAL '7 days' ORDER BY first_seen_at DESC LIMIT 200`;
      } else {
        rows = await sql`SELECT * FROM bot_users ORDER BY last_seen_at DESC LIMIT 200`;
      }
      return rows.map(mapUser);
    },

    async setUserStatus(userId: number, status: BotUserRow["status"]): Promise<void> {
      await ready();
      await sql`UPDATE bot_users SET status = ${status} WHERE telegram_user_id = ${userId}`;
    },

    async setUserNote(userId: number, note: string): Promise<void> {
      await ready();
      await sql`UPDATE bot_users SET note = ${note} WHERE telegram_user_id = ${userId}`;
    },

    async countUsers(status?: string): Promise<number> {
      await ready();
      const rows = status
        ? await sql`SELECT COUNT(*)::int AS c FROM bot_users WHERE status = ${status}`
        : await sql`SELECT COUNT(*)::int AS c FROM bot_users`;
      return Number(rows[0]?.c ?? 0);
    },

    async countActiveUsers24h(): Promise<number> {
      await ready();
      const rows = await sql`SELECT COUNT(*)::int AS c FROM bot_users WHERE last_seen_at >= NOW() - INTERVAL '24 hours'`;
      return Number(rows[0]?.c ?? 0);
    },

    async listAllUserIds(): Promise<number[]> {
      await ready();
      const rows = await sql`SELECT telegram_user_id FROM bot_users WHERE status = 'active'`;
      return rows.map((r) => Number(r.telegram_user_id));
    },

    // ---- groups (fleet-wide views over the existing groups table) ----
    async listGroups(filter: string, query?: string): Promise<Array<{ chat_id: number; title: string; username: string | null; status: string; added_at: string; owner_user_id: number | null }>> {
      await ready();
      const q = query ? `%${query}%` : null;
      let rows: Record<string, unknown>[];
      if (q) {
        const asId = /^-?\d+$/.test(query!.trim()) ? Number(query!.trim()) : null;
        if (asId != null) {
          rows = await sql`SELECT * FROM groups WHERE chat_id = ${asId} ORDER BY added_at DESC LIMIT 50`;
        } else {
          rows = await sql`SELECT * FROM groups WHERE title ILIKE ${q} OR username ILIKE ${q} ORDER BY added_at DESC LIMIT 200`;
        }
      } else if (filter === "new") {
        rows = await sql`SELECT * FROM groups WHERE added_at >= NOW() - INTERVAL '7 days' ORDER BY added_at DESC LIMIT 200`;
      } else if (filter === "active" || filter === "paused" || filter === "left") {
        rows = await sql`SELECT * FROM groups WHERE status = ${filter} ORDER BY added_at DESC LIMIT 200`;
      } else if (filter === "top") {
        rows = await sql`
          SELECT g.*, COALESCE(SUM(m.message_count),0) AS msgs
          FROM groups g LEFT JOIN group_members m ON m.chat_id = g.chat_id
          GROUP BY g.chat_id ORDER BY msgs DESC LIMIT 200`;
      } else if (filter === "problems") {
        rows = await sql`
          SELECT g.*, COUNT(a.id) AS violations
          FROM groups g JOIN audit_events a ON a.chat_id = g.chat_id AND a.event_type = 'violation'
            AND a.created_at >= NOW() - INTERVAL '7 days'
          GROUP BY g.chat_id ORDER BY violations DESC LIMIT 200`;
      } else {
        rows = await sql`SELECT * FROM groups ORDER BY added_at DESC LIMIT 200`;
      }
      return rows.map((r) => ({
        chat_id: Number(r.chat_id),
        title: String(r.title ?? ""),
        username: (r.username as string) ?? null,
        status: String(r.status ?? "active"),
        added_at: toIso(r.added_at),
        owner_user_id: r.owner_user_id == null ? null : Number(r.owner_user_id),
      }));
    },

    async countGroups(status?: string): Promise<number> {
      await ready();
      const rows = status
        ? await sql`SELECT COUNT(*)::int AS c FROM groups WHERE status = ${status}`
        : await sql`SELECT COUNT(*)::int AS c FROM groups`;
      return Number(rows[0]?.c ?? 0);
    },

    async setGroupStatus(chatId: number, status: string): Promise<void> {
      await ready();
      await sql`UPDATE groups SET status = ${status}, updated_at = NOW() WHERE chat_id = ${chatId}`;
    },

    async deleteGroupData(chatId: number): Promise<void> {
      await ready();
      await sql`DELETE FROM group_members WHERE chat_id = ${chatId}`;
      await sql`DELETE FROM group_settings WHERE chat_id = ${chatId}`;
      await sql`DELETE FROM moderation_actions WHERE chat_id = ${chatId}`;
      await sql`DELETE FROM warnings WHERE chat_id = ${chatId}`;
      await sql`DELETE FROM telegram_message_events WHERE chat_id = ${chatId}`;
      await sql`DELETE FROM audit_events WHERE chat_id = ${chatId}`;
      await sql`DELETE FROM groups WHERE chat_id = ${chatId}`;
    },

    async groupOverview(chatId: number) {
      await ready();
      const members = await sql`SELECT COUNT(*)::int AS c, COALESCE(SUM(message_count),0)::bigint AS msgs FROM group_members WHERE chat_id = ${chatId}`;
      const violations = await sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE chat_id = ${chatId} AND event_type = 'violation'`;
      return {
        memberCount: Number(members[0]?.c ?? 0),
        messageCount: Number(members[0]?.msgs ?? 0),
        violationCount: Number(violations[0]?.c ?? 0),
      };
    },

    async countUserGroups(userId: number): Promise<{ owned: number; botAdded: number }> {
      await ready();
      const owned = await sql`SELECT COUNT(*)::int AS c FROM groups WHERE owner_user_id = ${userId}`;
      const memberOf = await sql`SELECT COUNT(DISTINCT chat_id)::int AS c FROM group_members WHERE telegram_user_id = ${userId}`;
      return { owned: Number(owned[0]?.c ?? 0), botAdded: Number(memberOf[0]?.c ?? 0) };
    },

    async countUserMessages(userId: number): Promise<number> {
      await ready();
      const rows = await sql`SELECT COALESCE(SUM(message_count),0)::bigint AS c FROM group_members WHERE telegram_user_id = ${userId}`;
      return Number(rows[0]?.c ?? 0);
    },

    // ---- bot admins ----
    async listAdmins(status?: string): Promise<BotAdminRow[]> {
      await ready();
      const rows = status
        ? await sql`SELECT * FROM bot_admins WHERE status = ${status} ORDER BY created_at DESC`
        : await sql`SELECT * FROM bot_admins ORDER BY created_at DESC`;
      return rows.map((r) => ({
        telegram_user_id: Number(r.telegram_user_id),
        display_name: String(r.display_name ?? ""),
        status: (r.status as BotAdminRow["status"]) ?? "active",
        permissions: parseJson<AdminPermission[]>(r.permissions, []),
        added_by: r.added_by == null ? null : Number(r.added_by),
        last_active_at: r.last_active_at ? toIso(r.last_active_at) : null,
        ops_count: Number(r.ops_count ?? 0),
        created_at: toIso(r.created_at),
      }));
    },

    async getAdmin(userId: number): Promise<BotAdminRow | null> {
      await ready();
      const rows = await sql`SELECT * FROM bot_admins WHERE telegram_user_id = ${userId} LIMIT 1`;
      if (!rows.length) return null;
      const r = rows[0];
      return {
        telegram_user_id: Number(r.telegram_user_id),
        display_name: String(r.display_name ?? ""),
        status: (r.status as BotAdminRow["status"]) ?? "active",
        permissions: parseJson<AdminPermission[]>(r.permissions, []),
        added_by: r.added_by == null ? null : Number(r.added_by),
        last_active_at: r.last_active_at ? toIso(r.last_active_at) : null,
        ops_count: Number(r.ops_count ?? 0),
        created_at: toIso(r.created_at),
      };
    },

    async upsertAdmin(admin: { telegram_user_id: number; display_name: string; permissions: AdminPermission[]; added_by: number | null }): Promise<void> {
      await ready();
      await sql`
        INSERT INTO bot_admins (telegram_user_id, display_name, permissions, added_by)
        VALUES (${admin.telegram_user_id}, ${admin.display_name}, ${JSON.stringify(admin.permissions)}::jsonb, ${admin.added_by})
        ON CONFLICT (telegram_user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          permissions = EXCLUDED.permissions
      `;
    },

    async setAdminStatus(userId: number, status: "active" | "suspended"): Promise<void> {
      await ready();
      await sql`UPDATE bot_admins SET status = ${status} WHERE telegram_user_id = ${userId}`;
    },

    async setAdminPermissions(userId: number, permissions: AdminPermission[]): Promise<void> {
      await ready();
      await sql`UPDATE bot_admins SET permissions = ${JSON.stringify(permissions)}::jsonb WHERE telegram_user_id = ${userId}`;
    },

    async deleteAdmin(userId: number): Promise<void> {
      await ready();
      await sql`DELETE FROM bot_admins WHERE telegram_user_id = ${userId}`;
    },

    async touchAdmin(userId: number): Promise<void> {
      await ready();
      await sql`UPDATE bot_admins SET last_active_at = NOW(), ops_count = ops_count + 1 WHERE telegram_user_id = ${userId}`;
    },

    // ---- licenses ----
    async createLicense(l: { code: string; kind: string; duration_days: number; created_by: number }): Promise<void> {
      await ready();
      await sql`
        INSERT INTO licenses (code, kind, duration_days, created_by)
        VALUES (${l.code}, ${l.kind}, ${l.duration_days}, ${l.created_by})
      `;
    },

    async listLicenses(filter: string, query?: string): Promise<LicenseRow[]> {
      await ready();
      let rows: Record<string, unknown>[];
      if (query) {
        rows = await sql`SELECT * FROM licenses WHERE code ILIKE ${"%" + query + "%"} ORDER BY created_at DESC LIMIT 100`;
      } else if (filter === "used") {
        rows = await sql`SELECT * FROM licenses WHERE status IN ('active','expired') ORDER BY created_at DESC LIMIT 200`;
      } else if (filter === "unused" || filter === "active" || filter === "expired" || filter === "suspended" || filter === "cancelled") {
        rows = await sql`SELECT * FROM licenses WHERE status = ${filter} ORDER BY created_at DESC LIMIT 200`;
      } else {
        rows = await sql`SELECT * FROM licenses ORDER BY created_at DESC LIMIT 200`;
      }
      return rows.map(mapLicense);
    },

    async getLicense(idOrCode: number | string): Promise<LicenseRow | null> {
      await ready();
      const rows = typeof idOrCode === "number"
        ? await sql`SELECT * FROM licenses WHERE id = ${idOrCode} LIMIT 1`
        : await sql`SELECT * FROM licenses WHERE code = ${idOrCode} LIMIT 1`;
      return rows.length ? mapLicense(rows[0]) : null;
    },

    async updateLicense(id: number, patch: { status?: string; linked_group_id?: number | null; linked_user_id?: number | null; expires_at?: string | null; activated_at?: string | null; duration_days?: number }): Promise<void> {
      await ready();
      const current = await this.getLicense(id);
      if (!current) return;
      await sql`
        UPDATE licenses SET
          status = ${patch.status ?? current.status},
          linked_group_id = ${patch.linked_group_id !== undefined ? patch.linked_group_id : current.linked_group_id},
          linked_user_id = ${patch.linked_user_id !== undefined ? patch.linked_user_id : current.linked_user_id},
          expires_at = ${patch.expires_at !== undefined ? patch.expires_at : current.expires_at},
          activated_at = ${patch.activated_at !== undefined ? patch.activated_at : current.activated_at},
          duration_days = ${patch.duration_days ?? current.duration_days}
        WHERE id = ${id}
      `;
    },

    async countLicenses(status?: string): Promise<number> {
      await ready();
      const rows = status
        ? await sql`SELECT COUNT(*)::int AS c FROM licenses WHERE status = ${status}`
        : await sql`SELECT COUNT(*)::int AS c FROM licenses`;
      return Number(rows[0]?.c ?? 0);
    },

    // ---- broadcasts ----
    async createBroadcast(b: { actor_id: number; audience: string; content_text: string; total: number }): Promise<number> {
      await ready();
      const rows = await sql`
        INSERT INTO broadcasts (actor_id, audience, content_text, total)
        VALUES (${b.actor_id}, ${b.audience}, ${b.content_text}, ${b.total})
        RETURNING id
      `;
      return Number(rows[0].id);
    },

    async updateBroadcastProgress(id: number, sent: number, failed: number, status?: string): Promise<void> {
      await ready();
      if (status) {
        await sql`UPDATE broadcasts SET sent = ${sent}, failed = ${failed}, status = ${status}, finished_at = CASE WHEN ${status} = 'sending' THEN finished_at ELSE NOW() END WHERE id = ${id}`;
      } else {
        await sql`UPDATE broadcasts SET sent = ${sent}, failed = ${failed} WHERE id = ${id}`;
      }
    },

    async listBroadcasts(): Promise<BroadcastRow[]> {
      await ready();
      const rows = await sql`SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 100`;
      return rows.map((r) => ({
        id: Number(r.id),
        actor_id: Number(r.actor_id),
        audience: String(r.audience ?? ""),
        content_text: String(r.content_text ?? ""),
        status: (r.status as BroadcastRow["status"]) ?? "done",
        total: Number(r.total ?? 0),
        sent: Number(r.sent ?? 0),
        failed: Number(r.failed ?? 0),
        created_at: toIso(r.created_at),
        finished_at: r.finished_at ? toIso(r.finished_at) : null,
      }));
    },

    async getRunningBroadcast(): Promise<BroadcastRow | null> {
      await ready();
      const rows = await sql`SELECT * FROM broadcasts WHERE status = 'sending' ORDER BY created_at DESC LIMIT 1`;
      if (!rows.length) return null;
      const r = rows[0];
      return {
        id: Number(r.id), actor_id: Number(r.actor_id), audience: String(r.audience ?? ""),
        content_text: String(r.content_text ?? ""), status: "sending", total: Number(r.total ?? 0),
        sent: Number(r.sent ?? 0), failed: Number(r.failed ?? 0),
        created_at: toIso(r.created_at), finished_at: null,
      };
    },

    // ---- system settings (key/value) ----
    async getConfig(): Promise<SystemConfig> {
      await ready();
      const rows = await sql`SELECT value FROM system_settings WHERE key = 'config' LIMIT 1`;
      const stored = rows.length ? parseJson<Partial<SystemConfig>>(rows[0].value, {}) : {};
      const base = defaultSystemConfig();
      return {
        ...base,
        ...stored,
        protection: { ...base.protection, ...(stored.protection ?? {}), engines: { ...base.protection.engines, ...(stored.protection?.engines ?? {}) } },
      };
    },

    async setConfig(config: SystemConfig): Promise<void> {
      await ready();
      await sql`
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ('config', ${JSON.stringify(config)}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
    },

    // ---- global audit (reuses audit_events with chat_id NULL) ----
    async audit(actorId: number | null, actorName: string | null, eventType: string, target: string | null, details: Record<string, unknown>): Promise<void> {
      await ready();
      await sql`
        INSERT INTO audit_events (chat_id, actor_telegram_user_id, actor_name, event_type, target, details)
        VALUES (NULL, ${actorId}, ${actorName}, ${eventType}, ${target}, ${JSON.stringify(details)}::jsonb)
      `;
    },

    async listGlobalAudit(eventType?: string, actorId?: number): Promise<AuditRow[]> {
      await ready();
      let rows: Record<string, unknown>[];
      if (actorId != null) {
        rows = await sql`
          SELECT id, chat_id, actor_telegram_user_id, actor_name, event_type, target, details::text AS details, created_at
          FROM audit_events WHERE actor_telegram_user_id = ${actorId}
          ORDER BY created_at DESC LIMIT 100`;
      } else if (eventType) {
        rows = await sql`
          SELECT id, chat_id, actor_telegram_user_id, actor_name, event_type, target, details::text AS details, created_at
          FROM audit_events WHERE event_type = ${eventType}
          ORDER BY created_at DESC LIMIT 100`;
      } else {
        rows = await sql`
          SELECT id, chat_id, actor_telegram_user_id, actor_name, event_type, target, details::text AS details, created_at
          FROM audit_events ORDER BY created_at DESC LIMIT 100`;
      }
      return rows.map((r) => ({
        id: Number(r.id),
        chat_id: r.chat_id == null ? null : Number(r.chat_id),
        actor_telegram_user_id: r.actor_telegram_user_id == null ? null : Number(r.actor_telegram_user_id),
        actor_name: r.actor_name ? String(r.actor_name) : null,
        event_type: String(r.event_type),
        target: r.target ? String(r.target) : null,
        details: String(r.details ?? "{}"),
        created_at: toIso(r.created_at),
      }));
    },

    async countAuditGlobal(eventType?: string): Promise<number> {
      await ready();
      const rows = eventType
        ? await sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE event_type = ${eventType}`
        : await sql`SELECT COUNT(*)::int AS c FROM audit_events`;
      return Number(rows[0]?.c ?? 0);
    },

    async activity24h(): Promise<number> {
      await ready();
      const rows = await sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE created_at >= NOW() - INTERVAL '24 hours'`;
      return Number(rows[0]?.c ?? 0);
    },

    async violations24h(): Promise<number> {
      await ready();
      const rows = await sql`SELECT COUNT(*)::int AS c FROM audit_events WHERE event_type = 'violation' AND created_at >= NOW() - INTERVAL '24 hours'`;
      return Number(rows[0]?.c ?? 0);
    },

    async dbTableCounts(): Promise<Array<{ table: string; count: number }>> {
      await ready();
      async function c(query: Promise<Record<string, unknown>[]>): Promise<number> {
        const rows = await query;
        return Number(rows[0]?.c ?? 0);
      }
      return [
        { table: "groups", count: await c(sql`SELECT COUNT(*)::int AS c FROM groups`) },
        { table: "group_members", count: await c(sql`SELECT COUNT(*)::int AS c FROM group_members`) },
        { table: "bot_users", count: await c(sql`SELECT COUNT(*)::int AS c FROM bot_users`) },
        { table: "bot_admins", count: await c(sql`SELECT COUNT(*)::int AS c FROM bot_admins`) },
        { table: "licenses", count: await c(sql`SELECT COUNT(*)::int AS c FROM licenses`) },
        { table: "broadcasts", count: await c(sql`SELECT COUNT(*)::int AS c FROM broadcasts`) },
        { table: "audit_events", count: await c(sql`SELECT COUNT(*)::int AS c FROM audit_events`) },
        { table: "moderation_actions", count: await c(sql`SELECT COUNT(*)::int AS c FROM moderation_actions`) },
        { table: "telegram_updates", count: await c(sql`SELECT COUNT(*)::int AS c FROM telegram_updates`) },
      ];
    },

    async failedUpdates(): Promise<number> {
      await ready();
      const rows = await sql`SELECT COUNT(*)::int AS c FROM telegram_updates WHERE status = 'failed'`;
      return Number(rows[0]?.c ?? 0);
    },

    // ---- backup / restore (system recovery) ----
    // Logical JSON dump of the operational tables. telegram_updates and
    // message_events are transport/ephemeral and intentionally excluded.
    async exportBackup(): Promise<Record<string, unknown>> {
      await ready();
      const [botUsers, botAdmins, licenses, broadcasts, settings, groups, audit] = await Promise.all([
        sql`SELECT * FROM bot_users ORDER BY telegram_user_id`,
        sql`SELECT * FROM bot_admins ORDER BY telegram_user_id`,
        sql`SELECT * FROM licenses ORDER BY id`,
        sql`SELECT * FROM broadcasts ORDER BY id`,
        sql`SELECT * FROM system_settings ORDER BY key`,
        sql`SELECT * FROM groups ORDER BY chat_id`,
        sql`SELECT * FROM audit_events ORDER BY id DESC LIMIT 5000`,
      ]);
      return {
        app: "pre-crime",
        version: 1,
        exported_at: new Date().toISOString(),
        tables: {
          bot_users: botUsers,
          bot_admins: botAdmins,
          licenses,
          broadcasts,
          system_settings: settings,
          groups,
          audit_events: audit,
        },
      };
    },

    // Restore replaces the content of each included table with the backup rows.
    // Tables missing from the backup are left untouched.
    async importBackup(data: Record<string, unknown>): Promise<string[]> {
      await ready();
      const tables = (data.tables ?? {}) as Record<string, unknown>;
      const restored: string[] = [];

      const rows = (name: string): Array<Record<string, unknown>> =>
        Array.isArray(tables[name]) ? (tables[name] as Array<Record<string, unknown>>) : [];

      if (Array.isArray(tables.bot_users)) {
        await sql`DELETE FROM bot_users`;
        for (const r of rows("bot_users")) {
          await sql`
            INSERT INTO bot_users (telegram_user_id, username, display_name, status, note, first_seen_at, last_seen_at)
            VALUES (${Number(r.telegram_user_id)}, ${r.username == null ? null : String(r.username)}, ${String(r.display_name ?? "")}, ${String(r.status ?? "active")}, ${String(r.note ?? "")}, ${r.first_seen_at ? new Date(String(r.first_seen_at)).toISOString() : new Date().toISOString()}, ${r.last_seen_at ? new Date(String(r.last_seen_at)).toISOString() : new Date().toISOString()})
            ON CONFLICT (telegram_user_id) DO NOTHING`;
        }
        restored.push(`bot_users(${rows("bot_users").length})`);
      }

      if (Array.isArray(tables.bot_admins)) {
        await sql`DELETE FROM bot_admins`;
        for (const r of rows("bot_admins")) {
          await sql`
            INSERT INTO bot_admins (telegram_user_id, display_name, status, permissions, added_by, ops_count, last_active_at, created_at)
            VALUES (${Number(r.telegram_user_id)}, ${String(r.display_name ?? "")}, ${String(r.status ?? "active")}, ${JSON.stringify(r.permissions ?? [])}::jsonb, ${r.added_by == null ? null : Number(r.added_by)}, ${Number(r.ops_count ?? 0)}, ${r.last_active_at ? new Date(String(r.last_active_at)).toISOString() : null}, ${r.created_at ? new Date(String(r.created_at)).toISOString() : new Date().toISOString()})
            ON CONFLICT (telegram_user_id) DO NOTHING`;
        }
        restored.push(`bot_admins(${rows("bot_admins").length})`);
      }

      if (Array.isArray(tables.licenses)) {
        await sql`DELETE FROM licenses`;
        for (const r of rows("licenses")) {
          await sql`
            INSERT INTO licenses (id, code, kind, duration_days, status, linked_group_id, linked_user_id, created_by, created_at, activated_at, expires_at)
            OVERRIDING SYSTEM VALUE
            VALUES (${Number(r.id)}, ${String(r.code ?? "")}, ${String(r.kind ?? "group")}, ${Number(r.duration_days ?? 30)}, ${String(r.status ?? "unused")}, ${r.linked_group_id == null ? null : Number(r.linked_group_id)}, ${r.linked_user_id == null ? null : Number(r.linked_user_id)}, ${r.created_by == null ? null : Number(r.created_by)}, ${r.created_at ? new Date(String(r.created_at)).toISOString() : new Date().toISOString()}, ${r.activated_at ? new Date(String(r.activated_at)).toISOString() : null}, ${r.expires_at ? new Date(String(r.expires_at)).toISOString() : null})
            ON CONFLICT (id) DO NOTHING`;
        }
        restored.push(`licenses(${rows("licenses").length})`);
      }

      if (Array.isArray(tables.broadcasts)) {
        await sql`DELETE FROM broadcasts`;
        for (const r of rows("broadcasts")) {
          await sql`
            INSERT INTO broadcasts (id, actor_id, audience, content_text, status, total, sent, failed, created_at, finished_at)
            OVERRIDING SYSTEM VALUE
            VALUES (${Number(r.id)}, ${Number(r.actor_id ?? 0)}, ${String(r.audience ?? "all_users")}, ${String(r.content_text ?? "")}, ${String(r.status ?? "done")}, ${Number(r.total ?? 0)}, ${Number(r.sent ?? 0)}, ${Number(r.failed ?? 0)}, ${r.created_at ? new Date(String(r.created_at)).toISOString() : new Date().toISOString()}, ${r.finished_at ? new Date(String(r.finished_at)).toISOString() : null})
            ON CONFLICT (id) DO NOTHING`;
        }
        restored.push(`broadcasts(${rows("broadcasts").length})`);
      }

      if (Array.isArray(tables.system_settings)) {
        await sql`DELETE FROM system_settings`;
        for (const r of rows("system_settings")) {
          await sql`
            INSERT INTO system_settings (key, value, updated_at)
            VALUES (${String(r.key ?? "")}, ${JSON.stringify(r.value ?? {})}::jsonb, ${r.updated_at ? new Date(String(r.updated_at)).toISOString() : new Date().toISOString()})
            ON CONFLICT (key) DO NOTHING`;
        }
        restored.push(`system_settings(${rows("system_settings").length})`);
      }

      if (Array.isArray(tables.groups)) {
        await sql`DELETE FROM groups`;
        for (const r of rows("groups")) {
          await sql`
            INSERT INTO groups (chat_id, title, username, chat_type, status, timezone, owner_user_id, added_at, updated_at)
            VALUES (${Number(r.chat_id)}, ${String(r.title ?? "")}, ${r.username == null ? null : String(r.username)}, ${String(r.chat_type ?? "supergroup")}, ${String(r.status ?? "active")}, ${String(r.timezone ?? "UTC")}, ${r.owner_user_id == null ? null : Number(r.owner_user_id)}, ${r.added_at ? new Date(String(r.added_at)).toISOString() : new Date().toISOString()}, ${r.updated_at ? new Date(String(r.updated_at)).toISOString() : new Date().toISOString()})
            ON CONFLICT (chat_id) DO NOTHING`;
        }
        restored.push(`groups(${rows("groups").length})`);
      }

      if (Array.isArray(tables.audit_events)) {
        await sql`DELETE FROM audit_events`;
        for (const r of rows("audit_events")) {
          await sql`
            INSERT INTO audit_events (id, chat_id, actor_telegram_user_id, actor_name, event_type, target, details, created_at)
            OVERRIDING SYSTEM VALUE
            VALUES (${Number(r.id)}, ${r.chat_id == null ? null : Number(r.chat_id)}, ${r.actor_telegram_user_id == null ? null : Number(r.actor_telegram_user_id)}, ${r.actor_name == null ? null : String(r.actor_name)}, ${String(r.event_type ?? "unknown")}, ${r.target == null ? null : String(r.target)}, ${JSON.stringify(r.details ?? {})}::jsonb, ${r.created_at ? new Date(String(r.created_at)).toISOString() : new Date().toISOString()})
            ON CONFLICT (id) DO NOTHING`;
        }
        restored.push(`audit_events(${rows("audit_events").length})`);
      }

      // Re-sync identity sequences so new rows don't collide with restored ids.
      await sql`SELECT setval(pg_get_serial_sequence('licenses', 'id'), COALESCE((SELECT MAX(id) FROM licenses), 1))`;
      await sql`SELECT setval(pg_get_serial_sequence('broadcasts', 'id'), COALESCE((SELECT MAX(id) FROM broadcasts), 1))`;
      await sql`SELECT setval(pg_get_serial_sequence('audit_events', 'id'), COALESCE((SELECT MAX(id) FROM audit_events), 1))`;

      return restored;
    },
  };
}

function mapLicense(r: Record<string, unknown>): LicenseRow {
  return {
    id: Number(r.id),
    code: String(r.code ?? ""),
    kind: String(r.kind ?? "group"),
    duration_days: Number(r.duration_days ?? 30),
    status: (r.status as LicenseRow["status"]) ?? "unused",
    linked_group_id: r.linked_group_id == null ? null : Number(r.linked_group_id),
    linked_user_id: r.linked_user_id == null ? null : Number(r.linked_user_id),
    created_at: toIso(r.created_at),
    activated_at: r.activated_at ? toIso(r.activated_at) : null,
    expires_at: r.expires_at ? toIso(r.expires_at) : null,
  };
}

export type AdminStore = ReturnType<typeof createAdminStore>;
