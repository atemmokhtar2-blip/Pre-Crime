import { parseCallback, encodeCallback } from "./callbacks";
import {
  screenHome,
  screenGuide,
  screenPanel,
  screenSettings,
  screenGeneral,
  screenProtection,
  screenMemberList,
  screenMemberDetail,
  screenBanned,
  screenStats,
  screenMessagesSettings,
  screenMessageEditor,
  screenTemplates,
  screenWordFilter,
  screenWhitelist,
  screenNotifications,
  screenNotificationTargets,
  screenPermissions,
  screenLogs,
  screenLogList,
  screenLogDetail,
  screenReset,
  screenResetConfirm,
  screenHelp,
  screenMembersSettings,
  formatDateTime,
  type GroupStats,
} from "./screens";
import { toggleByKey, findToggle } from "./toggles";
import { defaultSettings, resetSection, type ResetSectionKey } from "./settings";
import { resolveRole, canOpenPanel, buildPermissionChecks, type PermissionChecks } from "./permissions";
import { evaluateProtection, extractSignal, VIOLATION_LABELS, type ViolationKind } from "./protection";
import { buildGoodbyeMessage, buildWelcomeMessage, memberLabel } from "./messages";
import { BRAND, DEFAULT_REASON } from "./constants";
import type {
  BotApi,
  GroupRow,
  GroupSettings,
  MemberRow,
  MemberStatus,
  PreCrimeRepo,
  TelegramUpdate,
  TelegramMessage,
  TelegramFrom,
  InlineKeyboardButton,
} from "./types";

export interface WebhookDeps {
  repo: PreCrimeRepo;
  bot: BotApi;
  now?: () => number;
}

export interface WebhookResult {
  ok: boolean;
  processed?: boolean;
}

export function createWebhookHandler(deps: WebhookDeps) {
  const { repo, bot } = deps;
  const now = deps.now ?? (() => Date.now());

  async function sendSafe(chatId: number, text: string, keyboard?: InlineKeyboardButton[][]): Promise<void> {
    try {
      await bot.sendMessage(chatId, text, keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : undefined);
    } catch (error) {
      console.error("telegram_send_message_failed", { chatId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function richLayout(text: string): string {
    // Normalize real line breaks before converting plain screen copy to Rich Markdown.
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const first = (lines.shift() ?? "").trim();
    const output: string[] = first ? ["# " + first, ""] : [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (output[output.length - 1] !== "") output.push("");
        continue;
      }
      if (/^[━─—-]{3,}$/.test(line)) {
        if (output[output.length - 1] !== "") output.push("");
        output.push("---", "");
        continue;
      }
      if (/^•\s+/.test(line)) {
        output.push("- " + line.replace(/^•\s+/, ""));
        continue;
      }
      if (/^(?:📊|🛡️|👥|💬|⚠️|🔔|📨|🔗|🔤|📝|⚙️|🌐|🚫|📋|👮|🤖)\s/.test(line)) {
        output.push("## " + line);
        continue;
      }
      output.push(rawLine);
    }
    return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function styledKeyboard(keyboard: InlineKeyboardButton[][]): InlineKeyboardButton[][] {
    return keyboard.map((row) => row.map((button) => {
      if (button.style) return button;
      const label = button.text;
      const danger = /حظر|حذف|طرد|إزالة|إعادة ضبط|مسح|إلغاء تفعيل/.test(label);
      const success = /مفعّل|تشغيل|تفعيل|إضافة البوت|تأكيد|نعم، تنفيذ/.test(label);
      return { ...button, style: danger ? "danger" as const : success ? "success" as const : "primary" as const };
    }));
  }

  async function sendRichScreen(chatId: number, screen: { text: string; keyboard: InlineKeyboardButton[][] }): Promise<void> {
    const keyboard = styledKeyboard(screen.keyboard);
    const markup = keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : undefined;
    try {
      await bot.sendRichMessage(chatId, richLayout(screen.text), markup);
    } catch (error) {
      console.error("telegram_rich_send_fallback", { chatId, error: error instanceof Error ? error.message : String(error) });
      await bot.sendMessage(chatId, screen.text, markup);
    }
  }

  async function editScreen(chatId: number, messageId: number, screen: { text: string; keyboard: InlineKeyboardButton[][] }): Promise<void> {
    const keyboard = styledKeyboard(screen.keyboard);
    const markup = keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : undefined;
    try {
      await bot.editMessageText(chatId, messageId, undefined, {
        rich_message: { markdown: richLayout(screen.text), is_rtl: true },
        ...(markup ?? {}),
      });
    } catch (error) {
      console.error("telegram_rich_edit_fallback", { chatId, messageId, error: error instanceof Error ? error.message : String(error) });
      try {
        await bot.editMessageText(chatId, messageId, screen.text, markup);
      } catch {
        try {
          await sendRichScreen(chatId, screen);
        } catch (sendError) {
          console.error("telegram_fallback_message_failed", { chatId, error: sendError instanceof Error ? sendError.message : String(sendError) });
        }
      }
    }
  }

  const answeredCallbackIds = new Set<string>();

  async function ack(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
    if (answeredCallbackIds.has(callbackQueryId)) return;
    try {
      await bot.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert });
      answeredCallbackIds.add(callbackQueryId);
    } catch (error) {
      console.error("telegram_callback_ack_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function loadGroup(gid: number): Promise<GroupRow | null> {
    return repo.getGroup(gid);
  }

  async function ensureGroup(gid: number, title: string | undefined, type: string, ownerUserId?: number): Promise<void> {
    const existing = await repo.getGroup(gid);
    await repo.upsertGroup({
      chat_id: gid,
      title: title || existing?.title || "مجموعة",
      username: existing?.username ?? null,
      chat_type: type || existing?.chat_type || "supergroup",
      status: existing?.status ?? "active",
      timezone: existing?.timezone ?? "UTC",
      added_at: existing?.added_at ?? new Date().toISOString(),
      owner_user_id: ownerUserId ?? existing?.owner_user_id ?? null,
    });
  }

  async function authorize(gid: number, actorId: number | undefined) {
    const settings = await repo.getSettings(gid);
    let status: MemberStatus | undefined;
    if (actorId != null) {
      try {
        status = (await bot.getChatMember(gid, actorId)).status;
      } catch {
        status = undefined;
      }
    }
    const group = await repo.getGroup(gid);
    const role = resolveRole({
      actorId,
      actorStatus: status,
      botAdmins: settings.permissions.botAdmins,
      moderators: settings.permissions.moderators,
      ownerUserId: group?.owner_user_id,
    });
    if (!canOpenPanel(role)) return null;
    return { settings, role, checks: buildPermissionChecks(role, settings) };
  }

  async function checkReady(gid: number): Promise<boolean> {
    try {
      const me = await bot.getMe();
      const m = await bot.getChatMember(gid, me.id);
      const admin = m.status === "administrator" || m.status === "creator";
      return admin && m.can_delete_messages === true && m.can_restrict_members === true && m.can_invite_users === true;
    } catch {
      return false;
    }
  }

  async function groupOwners(gid: number): Promise<number[]> {
    const ids = new Set<number>();
    try {
      const admins = await bot.getChatAdministrators(gid);
      for (const a of admins) if (a.status === "creator") ids.add(a.user.id);
    } catch {
      /* ignore */
    }
    const group = await repo.getGroup(gid);
    if (group?.owner_user_id != null) ids.add(group.owner_user_id);
    return [...ids];
  }

  async function deliverNotification(gid: number, ruleKey: keyof GroupSettings["notifications"], text: string): Promise<void> {
    try {
      const settings = await repo.getSettings(gid);
      const rule = settings.notifications[ruleKey];
      if (!rule?.enabled) return;
      if (rule.target === "group") {
        await sendSafe(gid, text);
        return;
      }
      const owners = await groupOwners(gid);
      const targets = rule.target === "admins" ? [...new Set([...owners, ...settings.permissions.botAdmins])] : owners;
      for (const id of targets) await sendSafe(id, text);
    } catch {
      /* ignore notification delivery failures */
    }
  }

  async function applyPunishment(gid: number, userId: number, actorLabel: string, targetName: string, violations: ViolationKind[]) {
    const settings = await repo.getSettings(gid);
    const action = settings.protection.punishment.action;
    const base = violations.map((v) => VIOLATION_LABELS[v]).join("، ");

    if (action === "warn") {
      const count = await repo.addWarning(gid, userId, 0, base);
      await repo.addAudit(gid, 0, actorLabel, "warn", targetName, { reason: base, automatic: true, count });
      // Compact, vertical warning card: only the four requested fields.
      try {
        const safe = (value: string) => value.replace(/[\\*_\\[\\]()~`>#+=|{}.!-]/g, "\\$&");
        const safeName = safe(targetName);
        const reasonLabel = violations.includes("word") ? "كلمات مسيئة" : base;
        const safeReason = safe(reasonLabel);
        const warningMarkdown =
          `**⌯︙ تحذير المستخدم**\\n\\n` +
          `**👤 العضو**\\n${safeName}\\n\\n` +
          `**📌 السبب**\\n${safeReason}\\n\\n` +
          `**🔢 عدد التحذيرات**\\n${count}`;
        await bot.sendRichMessage(gid, warningMarkdown);
      } catch (richError) {
        console.error("telegram_group_warning_rich_fallback", {
          chatId: gid,
          error: richError instanceof Error ? richError.message : String(richError),
        });
        try {
          await bot.sendMessage(
            gid,
            `**⌯︙ تحذير المستخدم**\\n\\n👤 العضو\\n${targetName}\\n\\n📌 السبب\\n${violations.includes("word") ? "كلمات مسيئة" : base}\\n\\n🔢 عدد التحذيرات\\n${count}`,
          );
        } catch (error) {
          console.error("telegram_group_warning_failed", {
            chatId: gid,
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const limit = settings.protection.punishment.warningsBeforeAction;
      if (count >= limit && limit > 0) {
        try {
          await bot.restrictChatMember(gid, userId, false);
          await repo.upsertMember({ chat_id: gid, telegram_user_id: userId, username: null, display_name: targetName, status: "restricted", joined_at: null, last_seen_at: new Date().toISOString(), message_count: 0, warning_count: count, warned: true });
          await repo.addModeration(gid, userId, 0, "mute", `تجاوز عدد التحذيرات (${count})`);
        } catch {
          await repo.addAudit(gid, 0, actorLabel, "error", targetName, { reason: "فشل الكتم التلقائي" });
        }
      }
      return;
    }

    if (action === "mute") {
      try {
        await bot.restrictChatMember(gid, userId, false);
        await repo.addModeration(gid, userId, 0, "mute", base);
        await repo.upsertMember({ chat_id: gid, telegram_user_id: userId, username: null, display_name: targetName, status: "restricted", joined_at: null, last_seen_at: new Date().toISOString(), message_count: 0, warning_count: 0, warned: false });
        await repo.addAudit(gid, 0, actorLabel, "mute", targetName, { reason: base, automatic: true });
        await deliverNotification(gid, "violations", `🔇 تم كتم ${targetName} آليًا بسبب: ${base}`);
      } catch {
        await repo.addAudit(gid, 0, actorLabel, "error", targetName, { reason: "فشل الكتم التلقائي" });
      }
      return;
    }

    if (action === "ban") {
      try {
        await bot.banChatMember(gid, userId);
        await repo.addModeration(gid, userId, 0, "ban", base);
        await repo.upsertMember({ chat_id: gid, telegram_user_id: userId, username: null, display_name: targetName, status: "banned", joined_at: null, last_seen_at: new Date().toISOString(), message_count: 0, warning_count: 0, warned: false });
        await repo.addAudit(gid, 0, actorLabel, "ban", targetName, { reason: base, automatic: true });
        await deliverNotification(gid, "violations", `🚫 تم حظر ${targetName} آليًا بسبب: ${base}`);
      } catch {
        await repo.addAudit(gid, 0, actorLabel, "error", targetName, { reason: "فشل الحظر التلقائي" });
      }
      return;
    }

    if (action === "kick") {
      try {
        await bot.banChatMember(gid, userId);
        await bot.unbanChatMember(gid, userId);
        await repo.addModeration(gid, userId, 0, "kick", base);
        await repo.upsertMember({ chat_id: gid, telegram_user_id: userId, username: null, display_name: targetName, status: "kicked", joined_at: null, last_seen_at: new Date().toISOString(), message_count: 0, warning_count: 0, warned: false });
        await repo.addAudit(gid, 0, actorLabel, "kick", targetName, { reason: base, automatic: true });
        await deliverNotification(gid, "violations", `👢 تم طرد ${targetName} آليًا بسبب: ${base}`);
      } catch {
        await repo.addAudit(gid, 0, actorLabel, "error", targetName, { reason: "فشل الطرد التلقائي" });
      }
      return;
    }
  }

  // ---------- message handling (protection + member tracking + events) ----------

  async function handleGroupMessage(message: TelegramMessage, updateId: number): Promise<void> {
    const chat = message.chat;
    const gid = chat.id;
    await ensureGroup(gid, chat.title, chat.type);

    const from = message.from;
    if (!from || from.is_bot) return;

    const userId = from.id;
    const name = from.first_name || from.username || String(userId);

    // New members welcome
    if (message.new_chat_members?.length) {
      const settings = await repo.getSettings(gid);
      for (const member of message.new_chat_members) {
        const label = memberLabel(member.first_name || null, member.username || null, member.id);
        await repo.upsertMember({
          chat_id: gid,
          telegram_user_id: member.id,
          username: member.username ?? null,
          display_name: member.first_name ?? "",
          status: member.id === from.id ? "member" : "member",
          joined_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          message_count: 0,
          warning_count: 0,
          warned: false,
        });
        await repo.addAudit(gid, from.id, name, "member_joined", label, {});
        if (settings.members.welcomeEnabled) {
          const welcome = buildWelcomeMessage(settings.messages.welcomeText, chat.title ?? "المجموعة", label, member.username ?? null);
          await sendSafe(gid, welcome);
        }
        await deliverNotification(gid, "memberJoined", `👋 انضم ${label} إلى المجموعة.`);
      }
      return;
    }

    // Left member goodbye
    if (message.left_chat_member) {
      const member = message.left_chat_member;
      const label = memberLabel(member.first_name || null, member.username || null, member.id);
      await repo.upsertMember({ chat_id: gid, telegram_user_id: member.id, username: member.username ?? null, display_name: member.first_name ?? "", status: "left", joined_at: null, last_seen_at: new Date().toISOString(), message_count: 0, warning_count: 0, warned: false });
      await repo.addAudit(gid, member.id, label, "member_left", label, {});
      const settings = await repo.getSettings(gid);
      if (settings.members.goodbyeEnabled) {
        await sendSafe(gid, buildGoodbyeMessage(settings.messages.goodbyeText, chat.title ?? "المجموعة", label));
      }
      await deliverNotification(gid, "memberLeft", `👋 غادر ${label} المجموعة.`);
      return;
    }

    // Track membership + activity
    const existing = await repo.getMember(gid, userId);
    await repo.upsertMember({
      chat_id: gid,
      telegram_user_id: userId,
      username: from.username ?? existing?.username ?? null,
      display_name: from.first_name ?? existing?.display_name ?? "",
      status: existing?.status === "banned" ? "banned" : existing?.status === "restricted" ? "restricted" : "member",
      joined_at: existing?.joined_at ?? new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      message_count: (existing?.message_count ?? 0) + 1,
      warning_count: existing?.warning_count ?? 0,
      warned: existing?.warned ?? false,
    });

    // Protection pipeline
    const settings = await repo.getSettings(gid);
    const signal = extractSignal(message);

    // Content cleanup filter (explicit, independent of anti-* toggles)
    const cf = settings.messages.contentFilter;
    let deleteNow = false;
    if (cf.media && signal.hasMedia) deleteNow = true;
    if (cf.files && signal.hasDocument) deleteNow = true;
    if (cf.text && signal.text.trim().length > 0 && !signal.hasUrl && !signal.hasMedia && !signal.hasDocument) {
      // "text" filter removes text-only junk when enabled (opt-in rule)
      deleteNow = false;
    }
    if (settings.messages.cleanup === "links" && signal.hasUrl) deleteNow = true;
    if (settings.messages.cleanup === "media" && signal.hasMedia) deleteNow = true;
    if (settings.messages.cleanup === "files" && signal.hasDocument) deleteNow = true;

    if (deleteNow) {
      try {
        await bot.deleteMessage(gid, message.message_id);
        await repo.addAudit(gid, 0, "PRE CRIME", "message_deleted", name, { reason: "فلتر المحتوى" });
      } catch {
        /* ignore */
      }
      return;
    }

    const windowMs = Math.max(settings.protection.antiFlood.windowSeconds, settings.protection.antiSpam.windowSeconds, 1) * 1000;
    const eventTime = now();
    const recents = await repo.recordMessageEvent(gid, userId, updateId, signal.text, eventTime, windowMs);
    const violations = evaluateProtection(settings.protection, signal, recents, eventTime);

    if (violations.length > 0) {
      let actorStatus: MemberStatus | undefined;
      try {
        actorStatus = (await bot.getChatMember(gid, userId)).status;
      } catch {
        actorStatus = undefined;
      }
      const isAdmin = actorStatus === "creator" || actorStatus === "administrator";
      // Admins are exempt from general moderation, but not from the configured word filter.
      const enforcedViolations = isAdmin ? violations.filter((v) => v === "word") : violations;
      if (enforcedViolations.length > 0) {
        try {
          await bot.deleteMessage(gid, message.message_id);
        } catch (error) {
          console.error("telegram_violation_delete_failed", {
            chatId: gid,
            messageId: message.message_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const label = memberLabel(name, from.username || null, userId);
        await repo.addAudit(gid, 0, "PRE CRIME", "violation", label, {
          violations: enforcedViolations.map((v) => VIOLATION_LABELS[v]),
          ...(isAdmin ? { detected: "admin-word-filter" } : {}),
        });
        if (!isAdmin) await applyPunishment(gid, userId, "PRE CRIME", label, enforcedViolations);
      } else if (isAdmin) {
        await repo.addAudit(gid, 0, "PRE CRIME", "violation", name, { violations, detected: "admin-exempt" });
      }
    }
  }

  async function executeMemberAction(
    gid: number,
    chatId: number,
    targetId: number,
    action: string,
    reason: string,
    actorId: number,
    actorName: string,
  ): Promise<void> {
    const member = await repo.getMember(gid, targetId);
    const targetName = memberLabel(member?.display_name || null, member?.username ?? null, targetId);
    const r = reason || DEFAULT_REASON;

    if (action === "warn") {
      const count = await repo.addWarning(gid, targetId, actorId, r);
      await repo.addAudit(gid, actorId, actorName, "warn", targetName, { reason: r, count });
      await sendSafe(chatId, `⚠️ تم تحذير ${targetName} (إجمالي ${count}).\nالسبب: ${r}`);
      return;
    }
    if (action === "mute") {
      try {
        await bot.restrictChatMember(gid, targetId, false);
        await repo.upsertMember({ chat_id: gid, telegram_user_id: targetId, username: member?.username ?? null, display_name: member?.display_name ?? targetName, status: "restricted", joined_at: member?.joined_at ?? null, last_seen_at: new Date().toISOString(), message_count: member?.message_count ?? 0, warning_count: member?.warning_count ?? 0, warned: member?.warned ?? false });
        await repo.addModeration(gid, targetId, actorId, "mute", r);
        await repo.addAudit(gid, actorId, actorName, "mute", targetName, { reason: r });
        await sendSafe(chatId, `🔇 تم كتم ${targetName}.\nالسبب: ${r}`);
      } catch {
        await sendSafe(chatId, "⚠️ تعذر الكتم (تأكد من صلاحيات البوت).");
      }
      return;
    }
    if (action === "unmute") {
      try {
        await bot.restrictChatMember(gid, targetId, true);
        await repo.upsertMember({ chat_id: gid, telegram_user_id: targetId, username: member?.username ?? null, display_name: member?.display_name ?? targetName, status: "member", joined_at: member?.joined_at ?? null, last_seen_at: new Date().toISOString(), message_count: member?.message_count ?? 0, warning_count: member?.warning_count ?? 0, warned: member?.warned ?? false });
        await repo.addModeration(gid, targetId, actorId, "unmute", r);
        await repo.addAudit(gid, actorId, actorName, "unmute", targetName, {});
        await sendSafe(chatId, `🔊 تم إلغاء كتم ${targetName}.`);
      } catch {
        await sendSafe(chatId, "⚠️ تعذر إلغاء الكتم.");
      }
      return;
    }
    if (action === "ban") {
      try {
        await bot.banChatMember(gid, targetId);
        await repo.upsertMember({ chat_id: gid, telegram_user_id: targetId, username: member?.username ?? null, display_name: member?.display_name ?? targetName, status: "banned", joined_at: member?.joined_at ?? null, last_seen_at: new Date().toISOString(), message_count: member?.message_count ?? 0, warning_count: member?.warning_count ?? 0, warned: member?.warned ?? false });
        await repo.addModeration(gid, targetId, actorId, "ban", r);
        await repo.addAudit(gid, actorId, actorName, "ban", targetName, { reason: r });
        await sendSafe(chatId, `🚫 تم حظر ${targetName}.\nالسبب: ${r}`);
        await deliverNotification(gid, "bans", `🚫 حظر ${actorName} العضو ${targetName}.\nالسبب: ${r}`);
      } catch {
        await sendSafe(chatId, "⚠️ تعذر الحظر (تأكد من صلاحيات البوت).");
      }
      return;
    }
    if (action === "kick") {
      try {
        await bot.banChatMember(gid, targetId);
        await bot.unbanChatMember(gid, targetId);
        await repo.upsertMember({ chat_id: gid, telegram_user_id: targetId, username: member?.username ?? null, display_name: member?.display_name ?? targetName, status: "kicked", joined_at: member?.joined_at ?? null, last_seen_at: new Date().toISOString(), message_count: member?.message_count ?? 0, warning_count: member?.warning_count ?? 0, warned: member?.warned ?? false });
        await repo.addModeration(gid, targetId, actorId, "kick", r);
        await repo.addAudit(gid, actorId, actorName, "kick", targetName, { reason: r });
        await sendSafe(chatId, `👢 تم طرد ${targetName}.\nالسبب: ${r}`);
      } catch {
        await sendSafe(chatId, "⚠️ تعذر الطرد.");
      }
      return;
    }
    if (action === "unban") {
      try {
        await bot.unbanChatMember(gid, targetId);
        await repo.upsertMember({ chat_id: gid, telegram_user_id: targetId, username: member?.username ?? null, display_name: member?.display_name ?? targetName, status: "member", joined_at: member?.joined_at ?? null, last_seen_at: new Date().toISOString(), message_count: member?.message_count ?? 0, warning_count: member?.warning_count ?? 0, warned: member?.warned ?? false });
        await repo.addModeration(gid, targetId, actorId, "unban", r);
        await repo.addAudit(gid, actorId, actorName, "unban", targetName, {});
        await sendSafe(chatId, `✅ تم فك حظر ${targetName}.`);
      } catch {
        await sendSafe(chatId, "⚠️ تعذر فك الحظر.");
      }
      return;
    }
    if (action === "unwarn") {
      await repo.clearWarnings(gid, targetId);
      await repo.addAudit(gid, actorId, actorName, "warn", targetName, { cleared: true });
      await sendSafe(chatId, `🧹 تمت إزالة تحذيرات ${targetName}.`);
      return;
    }
  }

  // ---------- start / help ----------

  async function handleStart(message: TelegramMessage): Promise<void> {
    const me = await bot.getMe();
    const chatId = message.chat.id;
    if (message.chat.type === "private") {
      const home = screenHome(me.username ?? "precrime_bot");
      const keyboard: InlineKeyboardButton[][] = [...home.keyboard];
      if (message.from?.id) {
        const owned = await repo.listOwnedGroups(message.from.id);
        for (const g of owned) {
          keyboard.push([{ text: `🛡️ لوحة تحكم: ${g.title}`, callback_data: encodeCallback("panel", g.chat_id) }]);
        }
      }
      await sendRichScreen(chatId, { ...home, keyboard });
      return;
    }
    // In a group, offer the readiness check.
    await bot.sendMessage(chatId, "🛡️ PRE CRIME متصل بهذه المجموعة.\nاضغط «فحص الجاهزية» للتأكد من صلاحياتي، أو ارفعني مشرفًا أولًا.", {
      reply_markup: { inline_keyboard: [[{ text: "🔎 فحص الجاهزية", callback_data: encodeCallback("check", chatId) }]] },
    });
  }

  // ---------- callback router ----------

  async function handleCallback(update: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const message = update.message;
    const data = update.data ?? "";
    // Acknowledge immediately so Telegram stops the button spinner before any DB/API work.
    await ack(update.id);
    if (!message) {
      await ack(update.id, "افتح البوت من جديد وجرب مرة أخرى.");
      return;
    }
    const parsed = parseCallback(data);
    if (!parsed) {
      await ack(update.id, "الزر غير معروف.");
      return;
    }

    const chat = message.chat;
    const chatId = chat.id;
    const messageId = message.message_id;
    const actorId = update.from.id;
    const actorName = update.from.username || update.from.first_name || String(actorId);

    // gid: prefer explicit group id from the callback; fall back to the chat when it's a group.
    const explicitGid = parsed.groupId;
    const chatIsGroup = chat.type === "group" || chat.type === "supergroup";
    const gid = explicitGid ?? (chatIsGroup ? chatId : null);

    const section = parsed.section;
    console.info("telegram_callback_received", {
      section,
      groupId: gid,
      actorId,
      chatType: chat.type,
    });

    // Non-group sections
    if (section === "home") {
      const home = screenHome((await bot.getMe()).username ?? "precrime_bot");
      await editScreen(chatId, messageId, home);
      await ack(update.id);
      return;
    }
    if (section === "guide") {
      await editScreen(chatId, messageId, screenGuide((await bot.getMe()).username ?? "precrime_bot"));
      await ack(update.id);
      return;
    }

    if (section === "check") {
      if (!gid || !chatIsGroup) {
        await ack(update.id, "فحص الجاهزية متاح من داخل المجموعة.", true);
        return;
      }
      await handleCheckScreen(gid, actorId, chatId, messageId, update.id);
      return;
    }

    // From here everything is group-scoped and requires authorization.
    if (gid == null) {
      await ack(update.id, "لا يمكن تحديد المجموعة. افتح لوحة التحكم من رسالة التفعيل.", true);
      return;
    }

    const access = await authorize(gid, actorId);
    if (!access) {
      await ack(update.id, "غير مصرح لك بإدارة هذه المجموعة.", true);
      return;
    }
    const { settings, role, checks } = access;
    const group = await loadGroup(gid);

    switch (section) {
      case "panel": {
        await editScreen(chatId, messageId, screenPanel(group?.title ?? "المجموعة", gid));
        await ack(update.id);
        return;
      }
      case "settings": {
        await editScreen(chatId, messageId, screenSettings(gid));
        await ack(update.id);
        return;
      }
      case "general": {
        await editScreen(chatId, messageId, screenGeneral(settings, (await bot.getMe()).first_name ?? "PRE CRIME", gid));
        await ack(update.id);
        return;
      }
      case "lang": {
        if (!checks.canSettings) { await ack(update.id, "غير مصرح لك بهذا الإجراء.", true); return; }
        settings.general.language = settings.general.language === "ar" ? "en" : "ar";
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, actorId, actorName, "settings_changed", "language", { value: settings.general.language });
        await editScreen(chatId, messageId, screenGeneral(settings, (await bot.getMe()).first_name ?? "PRE CRIME", gid));
        await ack(update.id, "تم تغيير اللغة.");
        return;
      }
      case "protection": {
        if (!checks.canProtection) { await ack(update.id, "غير مصرح لك بتعديل الحماية.", true); return; }
        await editScreen(chatId, messageId, screenProtection(settings, gid));
        await ack(update.id);
        return;
      }
      case "toggle": {
        const key = parsed.args[0];
        if (!key || !findToggle(key)) { await ack(update.id, "الإعداد غير معروف.", true); return; }
        if (!mayToggle(key, checks)) { await ack(update.id, "غير مصرح لك بتغيير هذا الإعداد.", true); return; }
        const next = toggleByKey(settings, key);
        await repo.setSettings(gid, next);
        await repo.addAudit(gid, actorId, actorName, "settings_changed", key, {});
        const screen = await renderScreenAfterToggle(key, next, gid, chatId, messageId, actorId);
        await editScreen(chatId, messageId, screen);
        await ack(update.id, "تم الحفظ ✅");
        return;
      }
      case "words": {
        if (!checks.canProtection) { await ack(update.id, "غير مصرح لك بتعديل الحماية.", true); return; }
        await editScreen(chatId, messageId, screenWordFilter(settings, gid));
        await ack(update.id);
        return;
      }
      case "words_add": {
        if (!checks.canProtection) { await ack(update.id, "غير مصرح لك بتعديل الحماية.", true); return; }
        await repo.setPending({ chat_id: chatId, group_id: gid, action: "add_words", context: {} });
        await bot.sendMessage(chatId, "📝 أرسل الكلمات المحظورة الآن (افصل بينها بفواصل):", { reply_markup: { force_reply: true, input_field_placeholder: "كلمة1, كلمة2" } });
        await ack(update.id);
        return;
      }
      case "words_clear": {
        if (!checks.canProtection) { await ack(update.id, "غير مصرح لك بتعديل الحماية.", true); return; }
        settings.protection.wordFilter.words = [];
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, actorId, actorName, "settings_changed", "wordFilter", { cleared: true });
        await editScreen(chatId, messageId, screenWordFilter(settings, gid));
        await ack(update.id, "تم مسح الكلمات.");
        return;
      }
      case "whitelist": {
        if (!checks.canProtection) { await ack(update.id, "غير مصرح لك بتعديل الحماية.", true); return; }
        await editScreen(chatId, messageId, screenWhitelist(settings, gid));
        await ack(update.id);
        return;
      }
      case "whitelist_add": {
        if (!checks.canProtection) { await ack(update.id, "غير مصرح لك بتعديل الحماية.", true); return; }
        await repo.setPending({ chat_id: chatId, group_id: gid, action: "add_whitelist", context: {} });
        await bot.sendMessage(chatId, "🔗 أرسل النطاق المسموح (مثل example.com):", { reply_markup: { force_reply: true, input_field_placeholder: "example.com" } });
        await ack(update.id);
        return;
      }
      case "whitelist_clear": {
        if (!checks.canProtection) { await ack(update.id, "غير مصرح لك بتعديل الحماية.", true); return; }
        settings.protection.antiLinks.whitelist = [];
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, actorId, actorName, "settings_changed", "antiLinks", { cleared: true });
        await editScreen(chatId, messageId, screenWhitelist(settings, gid));
        await ack(update.id, "تم مسح القائمة.");
        return;
      }
      case "members": {
        if (!checks.canSettings) { await ack(update.id, "غير مصرح لك بتعديل إعدادات الأعضاء.", true); return; }
        await editScreen(chatId, messageId, screenMembersSettings(settings, gid));
        await ack(update.id);
        return;
      }
      case "memberlist": {
        const list = await repo.listMembers(gid);
        await editScreen(chatId, messageId, screenMemberList(list, gid));
        await ack(update.id);
        return;
      }
      case "member": {
        const targetId = Number(parsed.args[0]);
        if (!Number.isSafeInteger(targetId)) { await ack(update.id, "تعذر تحديد العضو.", true); return; }
        const member = await repo.getMember(gid, targetId);
        const fallback: MemberRow = {
          chat_id: gid, telegram_user_id: targetId, username: null, display_name: String(targetId), status: "member",
          joined_at: null, last_seen_at: null, message_count: 0, warning_count: 0, warned: false,
        };
        await editScreen(chatId, messageId, screenMemberDetail(member ?? fallback, gid, role, checks, false));
        await ack(update.id);
        return;
      }
      case "act": {
        const action = parsed.args[0];
        const targetId = Number(parsed.args[1]);
        const origin = parsed.args[2] ?? "";
        if (!Number.isSafeInteger(targetId) || !action) { await ack(update.id, "تعذر تحديد العضو أو الإجراء.", true); return; }
        if (action === "warn" && !checks.canMute) { await ack(update.id, "غير مصرح لك بهذا الإجراء.", true); return; }
        if (!["ban", "kick", "unban", "mute", "unmute", "unwarn", "warn"].includes(action)) { await ack(update.id, "الإجراء غير معروف.", true); return; }
        if (action === "ban" || action === "kick" || action === "unban") {
          if (!checks.canBan) { await ack(update.id, "غير مصرح لك بهذا الإجراء.", true); return; }
        }
        if (action === "mute" || action === "unmute" || action === "unwarn") {
          if (!checks.canMute) { await ack(update.id, "غير مصرح لك بهذا الإجراء.", true); return; }
        }
        const member = await repo.getMember(gid, targetId);
        const targetName = memberLabel(member?.display_name || null, member?.username ?? null, targetId);
        const needsReason = action === "warn" || action === "ban" || action === "kick";
        if (needsReason) {
          await repo.setPending({ chat_id: chatId, group_id: gid, action: "member_action", context: { targetId, action } });
          const verb = action === "warn" ? "التحذير" : action === "ban" ? "الحظر" : "الطرد";
          await bot.sendMessage(chatId, `اكتب سبب ${verb} للعضو ${targetName} ثم أرسله:`, {
            reply_markup: { force_reply: true, input_field_placeholder: "السبب..." },
            reply_to_message_id: messageId,
          });
          await ack(update.id);
          return;
        }
        await executeMemberAction(gid, chatId, targetId, action, DEFAULT_REASON, actorId, actorName);
        if (origin === "banned") {
          const banned = await repo.listBanned(gid);
          await editScreen(chatId, messageId, screenBanned(banned, gid));
        } else {
          const refreshed = await repo.getMember(gid, targetId) ?? member;
          const fallback: MemberRow = { chat_id: gid, telegram_user_id: targetId, username: null, display_name: targetName, status: "member", joined_at: null, last_seen_at: null, message_count: 0, warning_count: 0, warned: false };
          await editScreen(chatId, messageId, screenMemberDetail(refreshed ?? fallback, gid, role, checks, false));
        }
        await ack(update.id, "تم التنفيذ ✅");
        return;
      }
      case "banned": {
        if (!checks.canBan) { await ack(update.id, "غير مصرح لك بمشاهدة المحظورين.", true); return; }
        const banned = await repo.listBanned(gid);
        await editScreen(chatId, messageId, screenBanned(banned, gid));
        await ack(update.id);
        return;
      }
      case "stats": {
        const [memberCount, activeCount, messageCount, warningCount, banCount, muteCount, auditCount] = await Promise.all([
          repo.countMembers(gid), repo.countActiveMembers(gid), repo.totalMessages(gid), repo.totalWarnings(gid),
          repo.totalBans(gid), repo.totalMutes(gid), repo.countAudit(gid),
        ]);
        const p = settings.protection;
        const enabled = [p.antiSpam.enabled, p.antiLinks.enabled, p.antiForward.enabled, p.antiDuplicate.enabled, p.wordFilter.enabled, p.antiFlood.enabled].filter(Boolean).length;
        const stats: GroupStats = {
          memberCount, activeCount, messageCount, warningCount, banCount, muteCount, auditCount,
          groupTitle: group?.title ?? "المجموعة", botReady: await checkReady(gid), enabledProtection: enabled,
        };
        await editScreen(chatId, messageId, screenStats(stats, gid));
        await ack(update.id);
        return;
      }
      case "messages": {
        if (!checks.canMessages) { await ack(update.id, "غير مصرح لك بتعديل الرسائل.", true); return; }
        await editScreen(chatId, messageId, screenMessagesSettings(settings, gid));
        await ack(update.id);
        return;
      }
      case "editwelcome":
      case "editgoodbye": {
        if (!checks.canMessages) { await ack(update.id, "غير مصرح.", true); return; }
        const kind = section === "editwelcome" ? "welcome" : "goodbye";
        const current = kind === "welcome" ? settings.messages.welcomeText : settings.messages.goodbyeText;
        await editScreen(chatId, messageId, screenMessageEditor(kind, current, gid));
        await ack(update.id);
        return;
      }
      case "edittext": {
        if (!checks.canMessages) { await ack(update.id, "غير مصرح.", true); return; }
        const kind = parsed.args[0] === "goodbye" ? "goodbye" : "welcome";
        await repo.setPending({ chat_id: chatId, group_id: gid, action: kind === "welcome" ? "edit_welcome" : "edit_goodbye", context: {} });
        await bot.sendMessage(chatId, "✏️ أرسل النص الجديد (يمكنك استخدام {name} و {group_name}):", { reply_markup: { force_reply: true, input_field_placeholder: "نص الرسالة..." } });
        await ack(update.id);
        return;
      }
      case "preview": {
        if (!checks.canMessages) { await ack(update.id, "غير مصرح لك بمعاينة الرسائل.", true); return; }
        const kind = parsed.args[0] === "goodbye" ? "goodbye" : "welcome";
        const template = kind === "welcome" ? settings.messages.welcomeText : settings.messages.goodbyeText;
        const preview = kind === "welcome"
          ? buildWelcomeMessage(template, group?.title ?? "مجموعتي التجريبية", "عضو جديد", "username")
          : buildGoodbyeMessage(template, group?.title ?? "مجموعتي التجريبية", "عضو");
        await bot.sendMessage(chatId, `👁 معاينة:\n\n${preview}`);
        await ack(update.id);
        return;
      }
      case "cleanup": {
        if (!checks.canMessages) { await ack(update.id, "غير مصرح لك بتعديل الرسائل.", true); return; }
        const order = ["none", "links", "media", "files"];
        const idx = order.indexOf(settings.messages.cleanup);
        settings.messages.cleanup = order[(idx + 1) % order.length] as GroupSettings["messages"]["cleanup"];
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, actorId, actorName, "settings_changed", "cleanup", { value: settings.messages.cleanup });
        await editScreen(chatId, messageId, screenMessagesSettings(settings, gid));
        await ack(update.id, "تم الحفظ ✅");
        return;
      }
      case "contentfilter": {
        if (!checks.canMessages) { await ack(update.id, "غير مصرح لك بتعديل الرسائل.", true); return; }
        const target = parsed.args[0];
        if (target === "media") settings.messages.contentFilter.media = !settings.messages.contentFilter.media;
        else if (target === "files") settings.messages.contentFilter.files = !settings.messages.contentFilter.files;
        else { await ack(update.id, "هذا الفلتر غير متاح حاليًا.", true); return; }
        await repo.setSettings(gid, settings);
        await editScreen(chatId, messageId, screenMessagesSettings(settings, gid));
        await ack(update.id, "تم الحفظ ✅");
        return;
      }
      case "templates": {
        if (!checks.canMessages) { await ack(update.id, "غير مصرح لك بإدارة القوالب.", true); return; }
        await editScreen(chatId, messageId, screenTemplates(settings, gid));
        await ack(update.id);
        return;
      }
      case "tpl_add": {
        if (!checks.canMessages) { await ack(update.id, "غير مصرح لك بتعديل الرسائل.", true); return; }
        await repo.setPending({ chat_id: chatId, group_id: gid, action: "add_template", context: {} });
        await bot.sendMessage(chatId, "📝 أرسل النص الجديد للقالب:", { reply_markup: { force_reply: true, input_field_placeholder: "نص القالب..." } });
        await ack(update.id);
        return;
      }
      case "tpl_del": {
        if (!checks.canMessages) { await ack(update.id, "غير مصرح لك بتعديل الرسائل.", true); return; }
        const index = Number(parsed.args[0]);
        if (Number.isInteger(index) && settings.messages.templates[index]) {
          settings.messages.templates.splice(index, 1);
          await repo.setSettings(gid, settings);
          await repo.addAudit(gid, actorId, actorName, "settings_changed", "templates", { removed: index });
        }
        await editScreen(chatId, messageId, screenTemplates(settings, gid));
        await ack(update.id, "تم الحذف.");
        return;
      }
      case "notifications": {
        if (!checks.canSettings) { await ack(update.id, "غير مصرح لك بإدارة التنبيهات.", true); return; }
        await editScreen(chatId, messageId, screenNotifications(settings, gid));
        await ack(update.id);
        return;
      }
      case "notif_target": {
        if (!checks.canSettings) { await ack(update.id, "غير مصرح لك بهذا الإجراء.", true); return; }
        await editScreen(chatId, messageId, screenNotificationTargets(settings, gid));
        await ack(update.id);
        return;
      }
      case "notif_target_cycle": {
        if (!checks.canSettings) { await ack(update.id, "غير مصرح لك بهذا الإجراء.", true); return; }
        const key = parsed.args[0] as keyof GroupSettings["notifications"];
        const order = ["group", "owner_pm", "admins"] as const;
        if (settings.notifications[key]) {
          const rule = settings.notifications[key];
          const idx = order.indexOf(rule.target);
          rule.target = order[(idx + 1) % order.length];
          await repo.setSettings(gid, settings);
        }
        await editScreen(chatId, messageId, screenNotificationTargets(settings, gid));
        await ack(update.id, "تم التغيير ✅");
        return;
      }
      case "permissions": {
        if (!checks.canSettings) { await ack(update.id, "غير مصرح.", true); return; }
        let admins: Array<{ id: number; status: string }> = [];
        try {
          const raw = await bot.getChatAdministrators(gid);
          admins = raw.map((a) => ({ id: a.user.id, status: a.status }));
        } catch {
          admins = [];
        }
        await editScreen(chatId, messageId, screenPermissions(settings, gid, admins));
        await ack(update.id);
        return;
      }
      case "add_admin": {
        if (!checks.canSettings) { await ack(update.id, "غير مصرح لك بهذا الإجراء.", true); return; }
        await repo.setPending({ chat_id: chatId, group_id: gid, action: "add_admin", context: {} });
        await bot.sendMessage(chatId, "➕ أرسل المعرّف الرقمي (ID) للشخص الذي تريد تعيينه مديرًا للبوت:", { reply_markup: { force_reply: true, input_field_placeholder: "123456789" } });
        await ack(update.id);
        return;
      }
      case "remove_admin": {
        if (!checks.canSettings) { await ack(update.id, "غير مصرح لك بهذا الإجراء.", true); return; }
        if (!settings.permissions.botAdmins.length) {
          await ack(update.id, "لا يوجد مديرو بوت مسجلون.", true);
          return;
        }
        const target = Number(parsed.args[0]);
        if (!Number.isSafeInteger(target) || !settings.permissions.botAdmins.includes(target)) {
          await ack(update.id, "اختر مديرًا مسجلًا لإزالته.", true);
          return;
        }
        settings.permissions.botAdmins = settings.permissions.botAdmins.filter((id) => id !== target);
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, actorId, actorName, "settings_changed", "botAdmins", { removed: target });
        await ack(update.id, "تمت إزالة أحد مديري البوت.");
        let admins: Array<{ id: number; status: string }> = [];
        try {
          const raw = await bot.getChatAdministrators(gid);
          admins = raw.map((a) => ({ id: a.user.id, status: a.status }));
        } catch { /* ignore */ }
        await editScreen(chatId, messageId, screenPermissions(settings, gid, admins));
        return;
      }
      case "logs": {
        if (!checks.canLogs) { await ack(update.id, "غير مصرح.", true); return; }
        await editScreen(chatId, messageId, screenLogs(gid));
        await ack(update.id);
        return;
      }
      case "loglist": {
        if (!checks.canLogs) { await ack(update.id, "غير مصرح لك بمشاهدة السجلات.", true); return; }
        const kind = parsed.args[0] ?? "all";
        const events = await repo.listAudit(gid, undefined, 100);
        await editScreen(chatId, messageId, screenLogList(events, gid, kind));
        await ack(update.id);
        return;
      }
      case "logdetail": {
        if (!checks.canLogs) { await ack(update.id, "غير مصرح لك بمشاهدة السجلات.", true); return; }
        const id = Number(parsed.args[0]);
        const events = await repo.listAudit(gid, undefined, 200);
        const row = events.find((e) => e.id === id);
        if (row) await editScreen(chatId, messageId, screenLogDetail(row, gid));
        await ack(update.id);
        return;
      }
      case "reset": {
        if (role !== "owner" && role !== "bot_admin") { await ack(update.id, "إعادة الضبط متاحة للمالك/مدير البوت فقط.", true); return; }
        await editScreen(chatId, messageId, screenReset(gid));
        await ack(update.id);
        return;
      }
      case "reset_confirm": {
        if (role !== "owner" && role !== "bot_admin") { await ack(update.id, "غير مصرح.", true); return; }
        await editScreen(chatId, messageId, screenResetConfirm(parsed.args[0] ?? "all", gid));
        await ack(update.id);
        return;
      }
      case "reset_do": {
        if (role !== "owner" && role !== "bot_admin") { await ack(update.id, "غير مصرح.", true); return; }
        const rawKey = parsed.args[0] ?? "all";
        const validKeys: ResetSectionKey[] = ["protection", "members", "messages", "notifications", "permissions", "all"];
        if (!validKeys.includes(rawKey as ResetSectionKey)) { await ack(update.id, "قسم إعادة الضبط غير معروف.", true); return; }
        const key = rawKey as ResetSectionKey;
        const next = resetSection(settings, key);
        await repo.setSettings(gid, next);
        await repo.addAudit(gid, actorId, actorName, "settings_reset", key, {});
        await bot.sendMessage(chatId, `♻️ تمت إعادة ضبط «${key === "all" ? "جميع الإعدادات" : key}» بنجاح.`);
        await editScreen(chatId, messageId, screenPanel(group?.title ?? "المجموعة", gid));
        await ack(update.id);
        return;
      }
      case "help": {
        await editScreen(chatId, messageId, screenHelp(gid));
        await ack(update.id);
        return;
      }
      default: {
        await ack(update.id, "الزر غير معروف.");
      }
    }
  }

  // Restricts which toggles an actor may flip. Owners and bot admins change
  // everything; moderators only what their delegated capabilities allow.
  function mayToggle(key: string, checks: PermissionChecks): boolean {
    if (key.startsWith("pm_") || key.startsWith("n_")) return checks.canSettings;
    if (["welcome", "goodbye", "verify", "blockuntrusted", "newmember"].includes(key)) return checks.canSettings;
    return checks.canProtection;
  }

  // Renders the right screen after a toggle, routing back to the originating section.
  async function renderScreenAfterToggle(
    key: string,
    settings: GroupSettings,
    gid: number,
    _chatId: number,
    _messageId: number,
    _actorId: number,
  ): Promise<{ text: string; keyboard: InlineKeyboardButton[][] }> {
    if (key.startsWith("n_")) return screenNotifications(settings, gid);
    if (key.startsWith("pm_")) {
      let admins: Array<{ id: number; status: string }> = [];
      try {
        const raw = await bot.getChatAdministrators(gid);
        admins = raw.map((a) => ({ id: a.user.id, status: a.status }));
      } catch { /* ignore */ }
      return screenPermissions(settings, gid, admins);
    }
    if (["welcome", "goodbye", "verify", "blockuntrusted", "newmember"].includes(key)) {
      return screenMembersSettings(settings, gid);
    }
    return screenProtection(settings, gid);
  }

  async function handleCheckScreen(gid: number, actorId: number, chatId: number, messageId: number, callbackId: string): Promise<void> {
    const actor = await safeChatMember(gid, actorId);
    if (actor && actor.status !== "creator" && actor.status !== "administrator") {
      await ack(callbackId, "الفحص متاح لمشرفي المجموعة فقط.", true);
      return;
    }
    const me = await bot.getMe();
    const botMember = await safeChatMember(gid, me.id);
    const isAdmin = botMember?.status === "administrator" || botMember?.status === "creator";
    const missing: string[] = [];
    if (botMember?.can_delete_messages !== true) missing.push("حذف الرسائل");
    if (botMember?.can_restrict_members !== true) missing.push("حظر وتقييد الأعضاء");
    if (botMember?.can_invite_users !== true) missing.push("دعوة المستخدمين");
    const ready = isAdmin && missing.length === 0;
    const report = ready
      ? "✅ البوت مشرف ولديه الصلاحيات الأساسية المطلوبة.\n\nيمكنك الآن فتح لوحة التحكم من الخاص وإدارة الحماية والأعضاء."
      : "⚠️ البوت غير جاهز بالكامل.\n" +
        (!isAdmin ? "• ارفع PRE CRIME إلى مشرف.\n" : "") +
        (missing.length ? `• فعّل الصلاحيات: ${missing.join("، ")}.\n` : "");
    const screen = {
      text: `🛡️ تقرير جاهزية PRE CRIME\n\n${report}`,
      keyboard: [
        [{ text: "🔄 إعادة الفحص", callback_data: encodeCallback("check", gid) }],
        [{ text: "📘 طريقة التفعيل", callback_data: encodeCallback("guide") }],
      ],
    };
    await editScreen(chatId, messageId, screen);
    await ack(callbackId, ready ? "الفحص اكتمل ✅" : "البوت يحتاج استكمال الإعدادات.");
  }

  async function safeChatMember(gid: number, userId: number) {
    try {
      return await bot.getChatMember(gid, userId);
    } catch {
      return null;
    }
  }

  // ---------- membership status events (chat_member / my_chat_member) ----------

  async function handleMyChatMember(update: TelegramUpdate): Promise<void> {
    const my = update.my_chat_member;
    if (!my?.chat) return;
    const chat = my.chat;
    const isGroup = chat.type === "group" || chat.type === "supergroup";
    if (!isGroup) return;

    const newStatus = my.new_chat_member?.status;
    const oldStatus = my.old_chat_member?.status;
    const added = (newStatus === "member" || newStatus === "administrator") && (oldStatus === "left" || oldStatus === "kicked" || oldStatus === "member");
    const promoted = newStatus === "administrator" && oldStatus === "member";
    const removed = newStatus === "left" || newStatus === "kicked";

    if (removed) {
      await ensureGroup(chat.id, chat.title, chat.type);
      const existing = await repo.getGroup(chat.id);
      await repo.upsertGroup({ ...(existing as GroupRow), status: "left" });
      await repo.addAudit(chat.id, my.from?.id ?? null, my.from?.username ?? my.from?.first_name ?? null, "settings_changed", "bot_removed", {});
      return;
    }

    if (added || promoted) {
      const adder = my.from;
      await ensureGroup(chat.id, chat.title, chat.type, adder?.id);
      await repo.addAudit(chat.id, adder?.id ?? null, adder?.username ?? adder?.first_name ?? null, "member_joined", "PRE CRIME", { promoted });

      // Group greeting
      await sendSafe(chat.id, `أهلاً بأعضاء مجموعة ${chat.title ?? ""} 👋\n\nأنا PRE CRIME، مساعدكم لإدارة وحماية المجموعة 🤖\nتمت إضافتي بنجاح. ارفعوني مشرفًا وفعّلوا صلاحيات حذف الرسائل وحظر الأعضاء ودعوة المستخدمين، ثم افتحوا لوحة التحكم من الخاص.`, [
        [{ text: "🔎 فحص جاهزية الحماية", callback_data: encodeCallback("check", chat.id) }],
      ]);

      // Private confirmation + full control panel to the person who added/promoted the bot.
      if (adder && !adder.is_bot) {
        await sendSafe(adder.id, `✅ تمت إضافة PRE CRIME إلى مجموعتك «${chat.title ?? ""}» بنجاح! 🛡️\n\nلحماية المجموعة بشكل كامل، ارفع البوت إلى مشرف وامنحه الصلاحيات المطلوبة.\n\n⬇️ لوحة التحكم تظهر بالأسفل.`, [
          [{ text: "📘 شرح تفعيل الحماية", callback_data: encodeCallback("guide") }],
        ]);
        // Make sure the owner id is recorded so /start can later re-open the panel.
        await repo.upsertGroup({ chat_id: chat.id, title: chat.title ?? "مجموعة", username: null, chat_type: chat.type, status: "active", timezone: "UTC", added_at: new Date().toISOString(), owner_user_id: adder.id });
        const panel = screenPanel(chat.title ?? "المجموعة", chat.id);
        await sendSafe(adder.id, panel.text, panel.keyboard);
      }
      return;
    }
  }

  async function handleChatMember(update: TelegramUpdate): Promise<void> {
    const cm = update.chat_member;
    if (!cm?.chat) return;
    const chat = cm.chat;
    if (chat.type !== "group" && chat.type !== "supergroup") return;

    const member = cm.new_chat_member?.user;
    if (!member?.id) return;
    const oldStatus = cm.old_chat_member?.status;
    const newStatus = cm.new_chat_member?.status;

    await ensureGroup(chat.id, chat.title, chat.type);

    const label = member.id ? String(member.id) : "عضو";
    if (newStatus === "member" && (oldStatus === "left" || oldStatus === "kicked")) {
      await repo.upsertMember({ chat_id: chat.id, telegram_user_id: member.id, username: null, display_name: label, status: "member", joined_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), message_count: 0, warning_count: 0, warned: false });
      const settings = await repo.getSettings(chat.id);
      await deliverNotification(chat.id, "memberJoined", `👋 عاد ${label} إلى المجموعة.`);
      if (settings.members.welcomeEnabled) {
        await sendSafe(chat.id, buildWelcomeMessage(settings.messages.welcomeText, chat.title ?? "المجموعة", label, null));
      }
    } else if (newStatus === "left" || newStatus === "kicked") {
      await repo.upsertMember({ chat_id: chat.id, telegram_user_id: member.id, username: null, display_name: label, status: newStatus, joined_at: null, last_seen_at: new Date().toISOString(), message_count: 0, warning_count: 0, warned: false });
      await repo.addAudit(chat.id, cm.from?.id ?? null, cm.from?.username ?? null, "member_left", label, {});
    } else if (newStatus === "administrator") {
      await repo.upsertMember({ chat_id: chat.id, telegram_user_id: member.id, username: null, display_name: label, status: "administrator", joined_at: null, last_seen_at: new Date().toISOString(), message_count: 0, warning_count: 0, warned: false });
      await repo.addAudit(chat.id, cm.from?.id ?? null, cm.from?.username ?? null, "admin_promoted", label, {});
      await deliverNotification(chat.id, "promotions", `👮 تمت ترقية ${label} إلى مشرف.`);
    } else if (newStatus === "restricted") {
      await repo.upsertMember({ chat_id: chat.id, telegram_user_id: member.id, username: null, display_name: label, status: "restricted", joined_at: null, last_seen_at: new Date().toISOString(), message_count: 0, warning_count: 0, warned: false });
    }
  }

  // ---------- pending reply processing (private chat text inputs) ----------

  async function handlePendingReply(chatId: number, text: string, from?: TelegramFrom): Promise<boolean> {
    const pending = await repo.getPending(chatId);
    if (!pending) return false;
    const gid = pending.group_id;
    const access = await authorize(gid, from?.id);
    const pendingAction = pending.action;
    const memberAction = String(pending.context.action ?? "");
    const allowed = Boolean(access) && (
      (pendingAction === "member_action" && (
        (["ban", "kick"].includes(memberAction) && access!.checks.canBan) ||
        (["warn", "mute", "unmute", "unwarn"].includes(memberAction) && access!.checks.canMute)
      )) ||
      (["edit_welcome", "edit_goodbye", "add_template"].includes(pendingAction) && access!.checks.canMessages) ||
      (["add_words", "add_whitelist"].includes(pendingAction) && access!.checks.canProtection) ||
      (pendingAction === "add_admin" && access!.checks.canSettings)
    );
    if (!allowed) {
      await repo.clearPending(chatId);
      await sendSafe(chatId, "⚠️ لم تعد تملك صلاحية إكمال هذا التعديل.");
      return true;
    }
    await repo.clearPending(chatId);

    switch (pending.action) {
      case "member_action": {
        // The actor is the user typing the reason in the private chat.
        const actorId = from?.id ?? 0;
        const actorName = from?.username || from?.first_name || String(actorId || chatId);
        const targetId = Number(pending.context.targetId);
        const action = String(pending.context.action);
        if (!Number.isSafeInteger(targetId) || !action) {
          await sendSafe(chatId, "⚠️ تعذر تحديد العضو أو الإجراء. أعد المحاولة من قائمة الأعضاء.");
          return true;
        }
        await executeMemberAction(gid, chatId, targetId, action, text.trim(), actorId, actorName);
        return true;
      }
      case "edit_welcome": {
        const settings = await repo.getSettings(gid);
        settings.messages.welcomeText = text.trim();
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, pending.chat_id, String(chatId), "settings_changed", "welcomeText", {});
        await sendSafe(chatId, "✅ تم حفظ رسالة الترحيب الجديدة.");
        return true;
      }
      case "edit_goodbye": {
        const settings = await repo.getSettings(gid);
        settings.messages.goodbyeText = text.trim();
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, pending.chat_id, String(chatId), "settings_changed", "goodbyeText", {});
        await sendSafe(chatId, "✅ تم حفظ رسالة الوداع الجديدة.");
        return true;
      }
      case "add_words": {
        const settings = await repo.getSettings(gid);
        const words = text.split(/[,،\n]/).map((w) => w.trim()).filter(Boolean);
        settings.protection.wordFilter.words = [...new Set([...settings.protection.wordFilter.words, ...words])];
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, pending.chat_id, String(chatId), "settings_changed", "wordFilter", { added: words });
        await sendSafe(chatId, `✅ تمت إضافة ${words.length} كلمة إلى فلتر الكلمات.`);
        return true;
      }
      case "add_whitelist": {
        const settings = await repo.getSettings(gid);
        const domain = text.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        if (domain) settings.protection.antiLinks.whitelist = [...new Set([...settings.protection.antiLinks.whitelist, domain])];
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, pending.chat_id, String(chatId), "settings_changed", "antiLinks", { added: domain });
        await sendSafe(chatId, `✅ تمت إضافة «${domain}» إلى القائمة البيضاء.`);
        return true;
      }
      case "add_admin": {
        const settings = await repo.getSettings(gid);
        const id = Number(text.trim());
        if (!Number.isSafeInteger(id) || id <= 0) {
          await sendSafe(chatId, "⚠️ معرّف غير صالح، أعد المحاولة.");
          return true;
        }
        if (!settings.permissions.botAdmins.includes(id)) settings.permissions.botAdmins.push(id);
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, pending.chat_id, String(chatId), "settings_changed", "botAdmins", { added: id });
        await sendSafe(chatId, `✅ تم تعيين ${id} مديرًا للبوت.`);
        return true;
      }
      case "add_template": {
        const settings = await repo.getSettings(gid);
        settings.messages.templates.push({ name: `قالب ${settings.messages.templates.length + 1}`, body: text.trim() });
        await repo.setSettings(gid, settings);
        await repo.addAudit(gid, pending.chat_id, String(chatId), "settings_changed", "templates", { added: true });
        await sendSafe(chatId, "✅ تم حفظ القالب الجديد.");
        return true;
      }
      default:
        return false;
    }
  }

  // ---------- main dispatcher ----------

  return {
    async handleUpdate(update: TelegramUpdate): Promise<WebhookResult> {
      if (update.message) {
        const text = (update.message.text ?? "").trim();
        if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
          await handleStart(update.message);
          return { ok: true, processed: true };
        }
        if (update.message.chat.type === "private") {
          if (text && (await handlePendingReply(update.message.chat.id, text, update.message.from))) {
            return { ok: true, processed: true };
          }
          return { ok: true, processed: false };
        }
        if (update.message.chat.type === "group" || update.message.chat.type === "supergroup") {
          await handleGroupMessage(update.message, update.update_id);
          return { ok: true, processed: true };
        }
        return { ok: true, processed: false };
      }

      if (update.callback_query) {
        await handleCallback(update.callback_query);
        return { ok: true, processed: true };
      }

      if (update.my_chat_member) {
        await handleMyChatMember(update);
        return { ok: true, processed: true };
      }

      if (update.chat_member) {
        await handleChatMember(update);
        return { ok: true, processed: true };
      }

      if (update.chat_join_request) {
        // Join-request support: approval flow requires chat-level approval rights.
        await repo.addAudit(update.chat_join_request.chat.id, update.chat_join_request.from.id, update.chat_join_request.from.username ?? update.chat_join_request.from.first_name ?? null, "member_joined", "join_request", {});
        return { ok: true, processed: true };
      }

      return { ok: true, processed: false };
    },
  };
}
