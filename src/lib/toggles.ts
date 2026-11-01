import type { GroupSettings, PunishmentAction, NewMemberMode } from "./types";

// Data-driven control registry: every toggle/counter in the protection, members,
// notifications and permissions screens is described once here so the renderer
// and the mutator can never drift apart.

export type ToggleDefinition = {
  key: string;
  name: string;
  hint: string;
  kind: "boolean" | "cycle";
  cycle?: string[];
  get: (s: GroupSettings) => number | string | boolean;
  set: (s: GroupSettings, value: number | string | boolean) => void;
  valueOf: (s: GroupSettings) => string;
};

const PUNISH_LABELS: Record<PunishmentAction, string> = {
  warn: "تحذير",
  mute: "كتم",
  kick: "طرد",
  ban: "حظر",
};

const NEW_MEMBER_LABELS: Record<NewMemberMode, string> = {
  none: "بدون قيود",
  mute: "كتم تلقائي",
  restrict: "تقييد كامل",
};

export const PROTECTION_TOGGLES: ToggleDefinition[] = [
  {
    key: "antispam",
    name: "منع السبام",
    hint: "منع تكرار الرسائل بشكل مزعج",
    kind: "boolean",
    get: (s) => s.protection.antiSpam.enabled,
    set: (s, v) => { s.protection.antiSpam.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "antilinks",
    name: "منع الروابط",
    hint: "التحكم في إرسال الروابط",
    kind: "boolean",
    get: (s) => s.protection.antiLinks.enabled,
    set: (s, v) => { s.protection.antiLinks.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "antiforward",
    name: "منع إعادة التوجيه",
    hint: "منع الرسائل المحولة",
    kind: "boolean",
    get: (s) => s.protection.antiForward.enabled,
    set: (s, v) => { s.protection.antiForward.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "antidup",
    name: "منع الرسائل المتكررة",
    hint: "كشف التكرار التلقائي",
    kind: "boolean",
    get: (s) => s.protection.antiDuplicate.enabled,
    set: (s, v) => { s.protection.antiDuplicate.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "wordfilter",
    name: "فلتر الكلمات",
    hint: "حذف الرسائل التي تحتوي على كلمات ممنوعة",
    kind: "boolean",
    get: (s) => s.protection.wordFilter.enabled,
    set: (s, v) => { s.protection.wordFilter.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "antiflood",
    name: "الحماية من الإغراق",
    hint: "التعامل مع إرسال رسائل كثيرة بسرعة",
    kind: "boolean",
    get: (s) => s.protection.antiFlood.enabled,
    set: (s, v) => { s.protection.antiFlood.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "punish",
    name: "الإجراء عند المخالفة",
    hint: "اختيار الإجراء عند اكتشاف مخالفة",
    kind: "cycle",
    cycle: ["warn", "mute", "kick", "ban"],
    get: (s) => s.protection.punishment.action,
    set: (s, v) => { s.protection.punishment.action = v as PunishmentAction; },
    valueOf: (s) => PUNISH_LABELS[s.protection.punishment.action],
  },
];

export const MEMBER_TOGGLES: ToggleDefinition[] = ([
  {
    key: "welcome",
    name: "رسالة ترحيب الأعضاء",
    hint: "إرسال رسالة تلقائية عند دخول عضو جديد",
    kind: "boolean",
    get: (s) => s.members.welcomeEnabled,
    set: (s, v) => { s.members.welcomeEnabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "goodbye",
    name: "رسالة مغادرة الأعضاء",
    hint: "إشعار عند مغادرة عضو للمجموعة",
    kind: "boolean",
    get: (s) => s.members.goodbyeEnabled,
    set: (s, v) => { s.members.goodbyeEnabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "verify",
    name: "التحقق من الأعضاء الجدد",
    hint: "طلب إثبات قبل السماح بالمشاركة",
    kind: "boolean",
    get: (s) => s.members.verifyEnabled,
    set: (s, v) => { s.members.verifyEnabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "blockuntrusted",
    name: "منع الحسابات غير الموثوقة",
    hint: "قواعد التعامل مع الحسابات المشبوهة",
    kind: "boolean",
    get: (s) => s.members.blockUntrusted,
    set: (s, v) => { s.members.blockUntrusted = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "newmember",
    name: "وضع الأعضاء الجدد",
    hint: "تحديد صلاحيات الأعضاء عند الدخول",
    kind: "cycle",
    cycle: ["none", "mute", "restrict"],
    get: (s) => s.members.newMemberMode,
    set: (s, v) => { s.members.newMemberMode = v as NewMemberMode; },
    valueOf: (s) => NEW_MEMBER_LABELS[s.members.newMemberMode],
  },
] as ToggleDefinition[]).filter((toggle) => ["welcome", "goodbye"].includes(toggle.key));

export const NOTIFICATION_TOGGLES: ToggleDefinition[] = ([
  {
    key: "n_join",
    name: "تنبيه دخول عضو",
    hint: "إشعار عند انضمام عضو جديد",
    kind: "boolean",
    get: (s) => s.notifications.memberJoined.enabled,
    set: (s, v) => { s.notifications.memberJoined.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "n_left",
    name: "تنبيه مغادرة عضو",
    hint: "إشعار عند خروج عضو",
    kind: "boolean",
    get: (s) => s.notifications.memberLeft.enabled,
    set: (s, v) => { s.notifications.memberLeft.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "n_violation",
    name: "تنبيه المخالفات",
    hint: "إشعار عند اكتشاف مخالفة",
    kind: "boolean",
    get: (s) => s.notifications.violations.enabled,
    set: (s, v) => { s.notifications.violations.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "n_ban",
    name: "تنبيه الحظر",
    hint: "إشعار عند حظر عضو",
    kind: "boolean",
    get: (s) => s.notifications.bans.enabled,
    set: (s, v) => { s.notifications.bans.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "n_promote",
    name: "تنبيه الترقية لمشرف",
    hint: "إشعار عند تغيير صلاحيات الإدارة",
    kind: "boolean",
    get: (s) => s.notifications.promotions.enabled,
    set: (s, v) => { s.notifications.promotions.enabled = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "n_daily",
    name: "التقارير اليومية",
    hint: "ملخص نشاط المجموعة كل يوم",
    kind: "boolean",
    get: (s) => s.notifications.dailyReport.enabled,
    set: (s, v) => { s.notifications.dailyReport.enabled = Boolean(v); },
    valueOf: () => "",
  },
] as ToggleDefinition[]).filter((toggle) => toggle.key !== "n_daily");

export const PERMISSION_TOGGLES: ToggleDefinition[] = [
  {
    key: "pm_ban",
    name: "السماح بالحظر وفك الحظر",
    hint: "للمشرفين (غير مالك/مدير)",
    kind: "boolean",
    get: (s) => s.permissions.allowModeratorBan,
    set: (s, v) => { s.permissions.allowModeratorBan = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "pm_mute",
    name: "السماح بكتم الأعضاء",
    hint: "للمشرفين",
    kind: "boolean",
    get: (s) => s.permissions.allowModeratorMute,
    set: (s, v) => { s.permissions.allowModeratorMute = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "pm_prot",
    name: "التحكم في إعدادات الحماية",
    hint: "للمشرفين",
    kind: "boolean",
    get: (s) => s.permissions.allowModeratorProtection,
    set: (s, v) => { s.permissions.allowModeratorProtection = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "pm_logs",
    name: "مشاهدة سجل الأحداث",
    hint: "للمشرفين",
    kind: "boolean",
    get: (s) => s.permissions.allowModeratorLogs,
    set: (s, v) => { s.permissions.allowModeratorLogs = Boolean(v); },
    valueOf: () => "",
  },
  {
    key: "pm_msg",
    name: "تعديل الرسائل والتنبيهات",
    hint: "للمشرفين",
    kind: "boolean",
    get: (s) => s.permissions.allowModeratorMessages,
    set: (s, v) => { s.permissions.allowModeratorMessages = Boolean(v); },
    valueOf: () => "",
  },
];

export const ALL_TOGGLES: ToggleDefinition[] = [
  ...PROTECTION_TOGGLES,
  ...MEMBER_TOGGLES,
  ...NOTIFICATION_TOGGLES,
  ...PERMISSION_TOGGLES,
];

export function findToggle(key: string): ToggleDefinition | undefined {
  return ALL_TOGGLES.find((t) => t.key === key);
}

export function toggleByKey(settings: GroupSettings, key: string): GroupSettings {
  const next = structuredClone(settings);
  const def = findToggle(key);
  if (!def) return next;

  if (def.kind === "boolean") {
    def.set(next, !def.get(settings));
  } else if (def.cycle && def.cycle.length) {
    const current = String(def.get(settings));
    const index = def.cycle.indexOf(current);
    const target = def.cycle[(index + 1) % def.cycle.length];
    def.set(next, target);
  }
  return next;
}

export function toggleStateLabel(settings: GroupSettings, key: string): string {
  const def = findToggle(key);
  if (!def) return "";
  if (def.kind === "boolean") return def.get(settings) ? "مفعّل" : "متوقف";
  return def.valueOf(settings);
}

export function toggleStateEmoji(settings: GroupSettings, key: string): string {
  const def = findToggle(key);
  if (!def) return "";
  if (def.kind === "boolean") return def.get(settings) ? "✅" : "⛔️";
  return "🎛";
}
