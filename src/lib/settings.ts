import type { GroupSettings } from "./types";

export function defaultSettings(): GroupSettings {
  return {
    general: {
      language: "ar",
      timezone: "Africa/Cairo",
    },
    protection: {
      antiSpam: { enabled: true, threshold: 4, windowSeconds: 10 },
      antiLinks: { enabled: true, whitelist: [] },
      antiForward: { enabled: false },
      antiDuplicate: { enabled: true },
      wordFilter: { enabled: true, words: [] },
      antiFlood: { enabled: true, maxMessages: 8, windowSeconds: 5 },
      punishment: { action: "warn", warningsBeforeAction: 3 },
    },
    members: {
      welcomeEnabled: true,
      goodbyeEnabled: false,
      verifyEnabled: false,
      blockUntrusted: false,
      newMemberMode: "none",
    },
    messages: {
      welcomeText: "أهلًا بك {name} في مجموعة {group_name} 🛡️\nنتمنى لك وقتًا ممتعًا!",
      goodbyeText: "نأسف لمغادرتك {name} 👋\nنتمنى أن نراك قريبًا.",
      autoReplies: [],
      cleanup: "none",
      contentFilter: { text: true, media: false, files: false },
      templates: [
        { name: "ترحيب قصير", body: "أهلًا {name} 👋" },
        { name: "قاعدة المجموعة", body: "ممنوع السبام والروابط المخالفة في {group_name}." },
      ],
    },
    notifications: {
      memberJoined: { enabled: true, target: "group" },
      memberLeft: { enabled: false, target: "group" },
      violations: { enabled: true, target: "admins" },
      bans: { enabled: true, target: "admins" },
      promotions: { enabled: true, target: "group" },
      dailyReport: { enabled: false, target: "admins" },
    },
    permissions: {
      botAdmins: [],
      moderators: [],
      allowModeratorBan: true,
      allowModeratorMute: true,
      allowModeratorProtection: false,
      allowModeratorLogs: true,
      allowModeratorMessages: false,
    },
  };
}

// Deep-merge only the known branches; protects against stale/missing keys that
// older, already-persisted JSON blobs may not contain.
export function mergeSettings(base: GroupSettings, patch: Record<string, unknown> | null | undefined): GroupSettings {
  const merged = structuredClone(base);
  if (!patch || typeof patch !== "object") return merged;

  const set = (source: unknown, target: Record<string, unknown>) => {
    if (!source || typeof source !== "object") return;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const existing = target[key];
        if (existing && typeof existing === "object" && !Array.isArray(existing)) {
          set(value, existing as Record<string, unknown>);
          continue;
        }
      }
      if (value !== undefined) target[key] = value;
    }
  };

  set(patch, merged as unknown as Record<string, unknown>);
  return merged;
}

export type ResetSectionKey =
  | "protection"
  | "members"
  | "messages"
  | "notifications"
  | "permissions"
  | "all";

export const RESET_SECTION_LABELS: Record<ResetSectionKey, string> = {
  protection: "الحماية",
  members: "الأعضاء",
  messages: "الرسائل",
  notifications: "التنبيهات",
  permissions: "الصلاحيات",
  all: "جميع الإعدادات",
};

export function resetSection(settings: GroupSettings, key: ResetSectionKey): GroupSettings {
  const defaults = defaultSettings();
  if (key === "all") return defaults;
  const next = structuredClone(settings);
  (next as unknown as Record<string, unknown>)[key] = (defaults as unknown as Record<string, unknown>)[key];
  return next;
}
