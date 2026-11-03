// Pre-Crime super-admin panel — shared types, callback codec, and pure helpers.
// Kept dependency-free (no neon, no fetch) so it compiles straight into the
// CommonJS unit-test build like the rest of the domain modules.

import type { InlineKeyboardButton } from "../types";

// ---- Admin roles & permissions ----

export const ADMIN_PERMISSIONS = [
  "users",
  "groups",
  "licenses",
  "broadcast",
  "stats",
  "logs",
  "settings",
  "admins",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<AdminPermission, string> = {
  users: "إدارة المستخدمين",
  groups: "إدارة المجموعات",
  licenses: "إدارة الاشتراكات",
  broadcast: "الإذاعة",
  stats: "الإحصائيات",
  logs: "السجلات",
  settings: "إعدادات النظام",
  admins: "إدارة المديرين",
};

export interface BotAdminRow {
  telegram_user_id: number;
  display_name: string;
  status: "active" | "suspended";
  permissions: AdminPermission[];
  added_by: number | null;
  last_active_at: string | null;
  ops_count: number;
  created_at: string;
}

export interface BotUserRow {
  telegram_user_id: number;
  username: string | null;
  display_name: string;
  status: "active" | "banned" | "disabled";
  note: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface LicenseRow {
  id: number;
  code: string;
  kind: string;
  duration_days: number;
  status: "unused" | "active" | "expired" | "suspended" | "cancelled";
  linked_group_id: number | null;
  linked_user_id: number | null;
  created_at: string;
  activated_at: string | null;
  expires_at: string | null;
}

export interface BroadcastRow {
  id: number;
  actor_id: number;
  audience: string;
  content_text: string;
  status: "sending" | "done" | "stopped" | "failed";
  total: number;
  sent: number;
  failed: number;
  created_at: string;
  finished_at: string | null;
}

export type Screen = { text: string; keyboard: InlineKeyboardButton[][] };

// ---- Global system settings (key/value store) ----

export interface GlobalProtectionConfig {
  engines: {
    antiSpam: boolean;
    antiLinks: boolean;
    antiForward: boolean;
    antiDuplicate: boolean;
    wordFilter: boolean;
    antiFlood: boolean;
  };
  antiSpamThreshold: number;
  antiSpamWindowSeconds: number;
  antiFloodMaxMessages: number;
  antiFloodWindowSeconds: number;
  globalWords: string[];
  blockedDomains: string[];
}

export interface SystemConfig {
  botName: string;
  startMessage: string;
  language: "ar" | "en";
  maintenanceMode: boolean;
  acceptActivations: boolean;
  broadcastStopped: boolean;
  notifyGroupAdded: boolean;
  notifyGroupRemoved: boolean;
  notifyUserBanned: boolean;
  notifyBotDown: boolean;
  notifyErrors: boolean;
  notificationTarget: number | null;
  /** Additional public channels required by this tenant's cloned bot. */
  subscriptionChannels?: string[];
  protection: GlobalProtectionConfig;
}

export function defaultSystemConfig(): SystemConfig {
  return {
    botName: "Pre Crime",
    startMessage: "",
    language: "ar",
    maintenanceMode: false,
    acceptActivations: true,
    broadcastStopped: false,
    notifyGroupAdded: true,
    notifyGroupRemoved: true,
    notifyUserBanned: true,
    notifyBotDown: true,
    notifyErrors: true,
    notificationTarget: null,
    subscriptionChannels: [],
    protection: {
      engines: {
        antiSpam: true,
        antiLinks: true,
        antiForward: true,
        antiDuplicate: true,
        wordFilter: true,
        antiFlood: true,
      },
      antiSpamThreshold: 4,
      antiSpamWindowSeconds: 10,
      antiFloodMaxMessages: 8,
      antiFloodWindowSeconds: 5,
      globalWords: [],
      blockedDomains: [],
    },
  };
}

export const ENGINE_LABELS: Record<keyof GlobalProtectionConfig["engines"], string> = {
  antiSpam: "مكافحة السبام Anti-Spam",
  antiLinks: "مكافحة الروابط Anti-Links",
  antiForward: "مكافحة التوجيه Anti-Forward",
  antiDuplicate: "مكافحة التكرار Anti-Duplicate",
  wordFilter: "فلتر الكلمات المحظورة",
  antiFlood: "مكافحة الفلود Anti-Flood",
};

// ---- Callback codec: adm:<key>:<arg1>:<arg2>... (Telegram's 64-byte limit) ----

export function ac(key: string, ...args: (string | number)[]): string {
  const data = ["adm", key, ...args.map(String)].join(":");
  if (data.length > 64) throw new Error(`admin_callback_too_long: ${data}`);
  return data;
}

export function parseAdminCallback(data: string): { key: string; args: string[] } | null {
  if (!data.startsWith("adm:")) return null;
  const parts = data.split(":");
  return { key: parts[1] ?? "", args: parts.slice(2) };
}

export function num(value: string | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// ---- Formatting helpers ----

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar-EG-u-nu-latn", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
}

export function fmtAgo(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "—";
  const diff = nowMs - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 0) return "—";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "الآن";
  if (min < 60) return `منذ ${min} دقيقة`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;
  const days = Math.floor(hours / 24);
  return `منذ ${days} يوم`;
}

export function trunc(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

export function esc(value: string): string {
  return value.replace(/[<>]/g, "");
}

export function userLabel(u: { display_name?: string | null; username?: string | null; telegram_user_id: number }): string {
  const name = u.display_name?.trim() || (u.username ? `@${u.username}` : "") || String(u.telegram_user_id);
  return trunc(name, 24);
}

// ---- Pagination ----

export const PAGE_SIZE = 8;

export function paginate<T>(items: T[], page: number, pageSize = PAGE_SIZE): { items: T[]; page: number; pages: number; total: number } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(clamped * pageSize, clamped * pageSize + pageSize), page: clamped, pages, total };
}

export function pagerRow(listKey: string, page: number, pages: number, extraArg?: string | number): InlineKeyboardButton[] {
  const suffix = extraArg != null ? [extraArg] : [];
  const row: InlineKeyboardButton[] = [];
  if (page > 0) row.push({ text: "◀️ السابق", callback_data: ac(listKey, page - 1, ...suffix) });
  row.push({ text: `${page + 1}/${pages}`, callback_data: ac("noop") });
  if (page < pages - 1) row.push({ text: "التالي ▶️", callback_data: ac(listKey, page + 1, ...suffix) });
  return row;
}

// ---- License code generator (deterministic-friendly for tests) ----

export function generateLicenseCode(rand: () => number = Math.random): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const block = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
  return `PC-${block()}-${block()}-${block()}`;
}

export function licenseStatusLabel(status: LicenseRow["status"]): string {
  switch (status) {
    case "unused": return "غير مستخدم";
    case "active": return "نشط";
    case "expired": return "منتهي";
    case "suspended": return "موقوف";
    case "cancelled": return "ملغي";
  }
}

export function broadcastAudienceLabel(audience: string): string {
  switch (audience) {
    case "all_users": return "جميع المستخدمين";
    case "selected_users": return "مستخدمون محددون";
    case "all_groups": return "جميع المجموعات";
    case "active_groups": return "المجموعات النشطة";
    case "admins": return "المديرون";
    case "notice": return "إشعار إداري";
    default: return audience;
  }
}

// ---- Global protection overrides ----
// Merges the fleet-wide master switches and default blocklists into a group's
// own protection policy WITHOUT overwriting per-group customization: a global
// engine switch can only turn an engine OFF fleet-wide, and global word/domain
// lists are APPENDED to the group's own lists.

import type { ProtectionPolicy } from "../types";

export function applyGlobalProtection(
  policy: ProtectionPolicy,
  cfg: GlobalProtectionConfig,
  signalLinks: string[],
): { policy: ProtectionPolicy; blockedDomainHit: boolean } {
  const next = structuredClone(policy);
  const engines = cfg.engines;
  if (!engines.antiSpam) next.antiSpam.enabled = false;
  if (!engines.antiLinks) next.antiLinks.enabled = false;
  if (!engines.antiForward) next.antiForward.enabled = false;
  if (!engines.antiDuplicate) next.antiDuplicate.enabled = false;
  if (!engines.wordFilter) next.wordFilter.enabled = false;
  if (!engines.antiFlood) next.antiFlood.enabled = false;

  if (engines.wordFilter && cfg.globalWords.length) {
    next.wordFilter.enabled = true;
    next.wordFilter.words = [...new Set([...next.wordFilter.words, ...cfg.globalWords])];
  }

  const blockedDomainHit = engines.antiLinks && cfg.blockedDomains.length > 0 && signalLinks.some((link) => {
    try {
      const host = new URL(link.includes("://") ? link : "https://" + link).hostname.toLowerCase().replace(/^www\./, "");
      return cfg.blockedDomains.some((d) => {
        const dom = d.trim().toLowerCase().replace(/^www\./, "");
        return dom.length > 0 && (host === dom || host.endsWith("." + dom));
      });
    } catch {
      return false;
    }
  });

  // A globally blocked domain is a violation even if the group's whitelist
  // would have allowed it: remove matching whitelist allowance upstream.
  if (blockedDomainHit) {
    next.antiLinks.enabled = true;
    next.antiLinks.whitelist = [];
  }

  return { policy: next, blockedDomainHit };
}
