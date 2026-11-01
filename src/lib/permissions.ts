import type { GroupSettings, MemberStatus } from "./types";

export type ActorRole = "owner" | "bot_admin" | "moderator" | "member" | "watcher";

export interface AccessContext {
  actorId: number | undefined;
  actorStatus: MemberStatus | undefined; // Telegram status for the actor in this chat
  botAdmins: number[];
  moderators: number[];
  // The user who added/owns the bot in this group (recorded at onboarding time).
  // Treated as a full owner even when they are not the Telegram chat creator.
  ownerUserId?: number | null;
}

// Determines the actor's effective role in a single group. The owner is the chat
// creator; "bot_admin" is an explicit Pre-Crime manager; "moderator" covers
// Telegram admins plus explicit moderators. A watcher can view but never mutate.
export function resolveRole(ctx: AccessContext): ActorRole {
  if (!ctx.actorId) return "member";
  if (ctx.actorStatus === "creator") return "owner";
  if (ctx.ownerUserId != null && ctx.actorId === ctx.ownerUserId) return "owner";
  if (ctx.botAdmins.includes(ctx.actorId)) return "bot_admin";
  if (
    ctx.actorStatus === "administrator" ||
    ctx.moderators.includes(ctx.actorId)
  ) {
    return "moderator";
  }
  return "member";
}

export function canOpenPanel(role: ActorRole): boolean {
  return role === "owner" || role === "bot_admin" || role === "moderator";
}

export function canManageGroup(role: ActorRole): boolean {
  return role === "owner" || role === "bot_admin";
}

export function canModerate(role: ActorRole): boolean {
  return role !== "member";
}

export interface PermissionChecks {
  canBan: boolean;
  canMute: boolean;
  canProtection: boolean;
  canLogs: boolean;
  canMessages: boolean;
  canSettings: boolean;
}

export function buildPermissionChecks(role: ActorRole, settings: GroupSettings): PermissionChecks {
  const owner = role === "owner";
  const botAdmin = role === "bot_admin";
  const moderator = role === "moderator";

  return {
    canBan: owner || botAdmin || (moderator && settings.permissions.allowModeratorBan),
    canMute: owner || botAdmin || (moderator && settings.permissions.allowModeratorMute),
    canProtection: owner || botAdmin || (moderator && settings.permissions.allowModeratorProtection),
    canLogs: owner || botAdmin || (moderator && settings.permissions.allowModeratorLogs),
    canMessages: owner || botAdmin || (moderator && settings.permissions.allowModeratorMessages),
    canSettings: owner || botAdmin,
  };
}

export const ROLE_LABELS: Record<ActorRole, string> = {
  owner: "مالك المجموعة",
  bot_admin: "مدير البوت",
  moderator: "مشرف",
  member: "عضو",
  watcher: "مراقب",
};

export const ROLE_DESCRIPTIONS: Record<ActorRole, string> = {
  owner: "التحكم الكامل في إعدادات المجموعة والبوت",
  bot_admin: "إدارة وظائف البوت المسموح بها",
  moderator: "تنفيذ إجراءات الإدارة اليومية",
  member: "عضو عادي بدون صلاحيات إدارية",
  watcher: "مشاهدة السجلات والإحصائيات فقط",
};
