// Pre-Crime shared domain types. Kept free of external imports so the module
// stays unit-testable (compiled straight into CommonJS for `node --test`).

export type ChatType = "private" | "group" | "supergroup" | "channel";

export type MemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked" | "banned";

export type PunishmentAction = "warn" | "mute" | "kick" | "ban";
export type NewMemberMode = "none" | "mute" | "restrict";
export type NotificationTarget = "group" | "owner_pm" | "admins";

export interface ProtectionPolicy {
  antiSpam: { enabled: boolean; threshold: number; windowSeconds: number };
  antiLinks: { enabled: boolean; whitelist: string[] };
  antiForward: { enabled: boolean };
  antiDuplicate: { enabled: boolean };
  wordFilter: { enabled: boolean; words: string[] };
  antiFlood: { enabled: boolean; maxMessages: number; windowSeconds: number };
  punishment: { action: PunishmentAction; warningsBeforeAction: number };
}

export interface MembersPolicy {
  welcomeEnabled: boolean;
  goodbyeEnabled: boolean;
  verifyEnabled: boolean;
  blockUntrusted: boolean;
  newMemberMode: NewMemberMode;
}

export interface MessagesPolicy {
  welcomeText: string;
  goodbyeText: string;
  autoReplies: Array<{ trigger: string; response: string }>;
  cleanup: "none" | "links" | "media" | "files";
  contentFilter: { text: boolean; media: boolean; files: boolean };
  templates: Array<{ name: string; body: string }>;
}

export interface NotificationRule {
  enabled: boolean;
  target: NotificationTarget;
}

export interface NotificationsPolicy {
  memberJoined: NotificationRule;
  memberLeft: NotificationRule;
  violations: NotificationRule;
  bans: NotificationRule;
  promotions: NotificationRule;
  dailyReport: NotificationRule;
}

export interface PermissionsPolicy {
  botAdmins: number[];
  moderators: number[];
  allowModeratorBan: boolean;
  allowModeratorMute: boolean;
  allowModeratorProtection: boolean;
  allowModeratorLogs: boolean;
  allowModeratorMessages: boolean;
}

export interface GroupSettings {
  general: {
    language: "ar" | "en";
    timezone: string;
  };
  protection: ProtectionPolicy;
  members: MembersPolicy;
  messages: MessagesPolicy;
  notifications: NotificationsPolicy;
  permissions: PermissionsPolicy;
}

// ---- Database row shapes (subset used across the domain) ----

export interface GroupRow {
  chat_id: number;
  title: string;
  username: string | null;
  chat_type: string;
  status: "active" | "paused" | "left";
  timezone: string;
  added_at: string;
  owner_user_id: number | null;
}

export interface MemberRow {
  chat_id: number;
  telegram_user_id: number;
  username: string | null;
  display_name: string;
  status: MemberStatus;
  joined_at: string | null;
  last_seen_at: string | null;
  message_count: number;
  warning_count: number;
  warned: boolean;
}

export interface AuditRow {
  id: number;
  chat_id: number | null;
  actor_telegram_user_id: number | null;
  actor_name: string | null;
  event_type: string;
  target: string | null;
  details: string;
  created_at: string;
}

export interface ModerationRow {
  id: number;
  chat_id: number;
  target_telegram_user_id: number;
  actor_telegram_user_id: number;
  action: string;
  reason: string;
  created_at: string;
}

// ---- Injected boundaries (dependency injection for testability) ----

export interface BotApi {
  getMe(): Promise<{ id: number; username?: string; first_name?: string }>;
  sendMessage(
    chatId: number,
    text: string,
    opts?: { reply_markup?: InlineKeyboardMarkup | ForceReplyMarkup; reply_to_message_id?: number },
  ): Promise<{ message_id: number }>;
  sendRichMessage(
    chatId: number,
    markdown: string,
    opts?: { reply_markup?: InlineKeyboardMarkup },
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string | undefined,
    opts?: { reply_markup?: InlineKeyboardMarkup; rich_message?: { markdown: string; is_rtl?: boolean } },
  ): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, opts?: { text?: string; show_alert?: boolean }): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
  getChat(chatId: number): Promise<{ id: number; title?: string; username?: string; type: string }>;
  getChatMember(chatId: number, userId: number): Promise<ChatMemberInfo>;
  getChatMemberCount(chatId: number): Promise<number>;
  getChatAdministrators(chatId: number): Promise<Array<{ user: { id: number }; status: string }>>;
  restrictChatMember(
    chatId: number,
    userId: number,
    canSendMessages: boolean,
    opts?: { until_date?: number },
  ): Promise<unknown>;
  banChatMember(chatId: number, userId: number): Promise<unknown>;
  unbanChatMember(chatId: number, userId: number): Promise<unknown>;
}

export type InlineKeyboardButton =
  | { text: string; callback_data: string; style?: "primary" | "success" | "danger"; icon_custom_emoji_id?: string }
  | { text: string; url: string; style?: "primary" | "success" | "danger"; icon_custom_emoji_id?: string }
  | { text: string; switch_inline_query_current_chat: string; style?: "primary" | "success" | "danger"; icon_custom_emoji_id?: string };

export type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };
export type ForceReplyMarkup = { force_reply: true; input_field_placeholder?: string };

export interface ChatMemberInfo {
  status: MemberStatus;
  user: { id: number; username?: string; first_name?: string };
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
  can_invite_users?: boolean;
  can_promote_members?: boolean;
}

export interface PendingAction {
  chat_id: number; // private chat where the follow-up reply is expected
  group_id: number; // group being configured
  action: string; // e.g. "edit_welcome", "edit_goodbye", "add_words", "add_admin", "reason"
  context: Record<string, string | number | undefined>;
}

// ---- Repository boundary ----

export interface PreCrimeRepo {
  ensureSchema(): Promise<void>;
  upsertGroup(group: GroupRow): Promise<void>;
  getGroup(chatId: number): Promise<GroupRow | null>;
  listOwnedGroups(ownerId: number): Promise<GroupRow[]>;
  getSettings(chatId: number): Promise<GroupSettings>;
  setSettings(chatId: number, settings: GroupSettings): Promise<void>;
  upsertMember(member: MemberRow): Promise<void>;
  getMember(chatId: number, userId: number): Promise<MemberRow | null>;
  listMembers(chatId: number, query?: string): Promise<MemberRow[]>;
  countMembers(chatId: number): Promise<number>;
  countActiveMembers(chatId: number): Promise<number>;
  listBanned(chatId: number): Promise<MemberRow[]>;
  addWarning(chatId: number, targetId: number, actorId: number, reason: string): Promise<number>;
  clearWarnings(chatId: number, targetId: number): Promise<void>;
  addModeration(
    chatId: number,
    targetId: number,
    actorId: number,
    action: string,
    reason: string,
  ): Promise<void>;
  addAudit(
    chatId: number | null,
    actorId: number | null,
    actorName: string | null,
    eventType: string,
    target: string | null,
    details: Record<string, unknown>,
  ): Promise<void>;
  listAudit(chatId: number, eventType?: string, limit?: number): Promise<AuditRow[]>;
  countAudit(chatId: number, eventType?: string): Promise<number>;
  totalMessages(chatId: number): Promise<number>;
  recordMessageEvent(chatId: number, userId: number, updateId: number, text: string, at: number, windowMs: number): Promise<Array<{ at: number; text: string }>>;
  totalWarnings(chatId: number): Promise<number>;
  totalBans(chatId: number): Promise<number>;
  totalMutes(chatId: number): Promise<number>;
  setPending(action: PendingAction): Promise<void>;
  getPending(chatId: number): Promise<PendingAction | null>;
  clearPending(chatId: number): Promise<void>;
}

// ---- Telegram update envelope (normalized subset) ----

export interface TelegramFrom {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramFrom;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  left_chat_member?: { id: number; username?: string; first_name?: string };
  new_chat_members?: Array<{ id: number; username?: string; first_name?: string }>;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_origin?: unknown;
  entities?: Array<{ type: string }>;
  caption_entities?: Array<{ type: string }>;
  sticker?: unknown;
  animation?: unknown;
  video?: unknown;
  document?: unknown;
  photo?: unknown;
  audio?: unknown;
  voice?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  my_chat_member?: {
    chat: TelegramChat;
    from?: TelegramFrom;
    old_chat_member?: { status: string };
    new_chat_member?: { status: string };
  };
  chat_member?: {
    chat: TelegramChat;
    from?: TelegramFrom;
    old_chat_member?: { status: string; user?: { id: number } };
    new_chat_member?: { status: string; user?: { id: number } };
  };
  chat_join_request?: {
    chat: TelegramChat;
    from: TelegramFrom;
  };
  callback_query?: {
    id: string;
    from: TelegramFrom;
    message?: TelegramMessage;
    data?: string;
  };
}
