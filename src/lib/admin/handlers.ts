// Pre-Crime super-admin panel — command/callback/pending-input handlers.
// Every button in the panel routes through handleCallback here; every text
// input the panel asks for routes through handlePending. Nothing is stubbed:
// each action reads/writes the database and/or calls the Telegram Bot API.

import type {
  BotApi,
  InlineKeyboardButton,
  PreCrimeRepo,
  TelegramFrom,
  TelegramMessage,
  TelegramUpdate,
} from "../types";
import type { AdminStore } from "./store";
import { restoreBackup, runBackup } from "./backup";
import {
  ADMIN_PERMISSIONS,
  ENGINE_LABELS,
  PERMISSION_LABELS,
  ac,
  broadcastAudienceLabel,
  fmtAgo,
  fmtDate,
  generateLicenseCode,
  defaultSystemConfig,
  parseAdminCallback,
  trunc,
  userLabel,
  type AdminPermission,
  type BotAdminRow,
  type Screen,
  type SystemConfig,
} from "./core";
import {
  screenAdminDetail,
  screenAdminList,
  screenAdminsMenu,
  screenAnalyticsMenu,
  screenBroadcastLog,
  screenBroadcastMenu,
  screenBroadcastPreview,
  screenBroadcastStats,
  screenConfirm,
  screenDenied,
  screenDomainList,
  screenEmergency,
  screenEmergencyEngines,
  screenRecovery,
  screenGroupDetail,
  screenGroupList,
  screenGroupMembers,
  screenGroupsMenu,
  screenHome,
  screenInfra,
  screenLicenseDetail,
  screenLicenseList,
  screenLicenseNew,
  screenLicensesMenu,
  screenLogDetail,
  screenLogList,
  screenLogsMenu,
  screenNotificationsSettings,
  screenProtectionMenu,
  screenReport,
  screenSystemMenu,
  screenUserDetail,
  screenUserGroups,
  screenUserList,
  screenUsersMenu,
  screenWordList,
  type InfraData,
  screenInfo,
  screenManagedBotList,
  screenManagedBotDetail,
  screenManagedBotDeleteConfirm,
  type ManagedBotAdminRow,
} from "./screens";

export interface AdminPanelDeps {
  store: AdminStore;
  repo: PreCrimeRepo;
  bot: BotApi;
  ownerIds: number[];
  webhookUrl?: string;
  webhookSecret?: string;
  startedAt?: number;
  tenantMode?: boolean;
  managedBotAdmin?: {
    pause(botId: number): Promise<void>;
    resume(botId: number): Promise<void>;
    deletePermanently(botId: number): Promise<void>;
  };
}

// Which panel permission gates each callback-key prefix. "emerg" is owner-only.
const KEY_PERMISSIONS: Array<[RegExp, AdminPermission]> = [
  [/^(users|u_)/, "users"],
  [/^(groups|g_)/, "groups"],
  [/^(admins|a_)/, "admins"],
  [/^(licenses|l_)/, "licenses"],
  [/^(bcast|bc_)/, "broadcast"],
  [/^(prot|pe_)/, "settings"],
  [/^(analytics|an_)/, "stats"],
  [/^(logs|log_)/, "logs"],
  [/^(sys|infra)/, "settings"],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createAdminPanel(deps: AdminPanelDeps) {
  const { store, repo, bot, ownerIds } = deps;
  const tenantMode = deps.tenantMode ?? false;
  const startedAt = deps.startedAt ?? Date.now();

  // ---------- auth ----------

  function isOwner(userId: number): boolean {
    return ownerIds.includes(userId);
  }

  async function getAdmin(userId: number): Promise<BotAdminRow | null> {
    if (isOwner(userId)) {
      return {
        telegram_user_id: userId,
        display_name: "المالك",
        status: "active",
        permissions: [...ADMIN_PERMISSIONS],
        added_by: null,
        last_active_at: null,
        ops_count: 0,
        created_at: "",
      };
    }
    return store.getAdmin(userId);
  }

  async function isAdmin(userId: number): Promise<boolean> {
    if (isOwner(userId)) return true;
    const admin = await store.getAdmin(userId);
    return admin?.status === "active";
  }

  async function hasPermission(userId: number, perm: AdminPermission): Promise<boolean> {
    if (isOwner(userId)) return true;
    const admin = await store.getAdmin(userId);
    return admin?.status === "active" && admin.permissions.includes(perm);
  }

  function permissionForKey(key: string): AdminPermission | null {
    if (key === "emerg" || key.startsWith("em_")) return null; // owner-only, checked separately
    for (const [re, perm] of KEY_PERMISSIONS) if (re.test(key)) return perm;
    return null; // home/noop/etc. — any admin
  }

  async function recordOp(userId: number, name: string, eventType: string, target: string | null, details: Record<string, unknown>): Promise<void> {
    await store.audit(userId, name, eventType, target, details);
    if (!isOwner(userId)) await store.touchAdmin(userId);
  }

  // ---------- message rendering helpers ----------

  async function show(chatId: number, messageId: number | null, screen: Screen): Promise<void> {
    const markup = screen.keyboard.length ? { reply_markup: { inline_keyboard: screen.keyboard } } : undefined;
    if (messageId != null) {
      try {
        await bot.editMessageText(chatId, messageId, screen.text, markup ? { reply_markup: markup.reply_markup } : undefined);
        return;
      } catch {
        // fall through to a fresh message (message may be too old to edit)
      }
    }
    await bot.sendMessage(chatId, screen.text, markup);
  }

  async function ack(cbId: string, text?: string, alert = false): Promise<void> {
    try {
      await bot.answerCallbackQuery(cbId, { text, show_alert: alert });
    } catch { /* callback may already be answered */ }
  }

  // ---------- global gates (wired into the main webhook dispatcher) ----------

  async function track(from: TelegramFrom | undefined): Promise<void> {
    if (!from || from.is_bot) return;
    try {
      await store.trackUser(from.id, from.username ?? null, from.first_name ?? "");
    } catch (error) {
      console.error("admin_track_user_failed", error instanceof Error ? error.message : String(error));
    }
  }

  async function gate(update: TelegramUpdate): Promise<boolean> {
    let cfg: SystemConfig;
    try {
      cfg = await store.getConfig();
    } catch {
      return false; // DB hiccup must never block the whole bot
    }
    const from = update.message?.from ?? update.callback_query?.from ?? update.my_chat_member?.from;
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (!from || from.is_bot) return false;

    // Disabled/banned users are cut off from the bot entirely (owners excepted).
    if (!isOwner(from.id)) {
      try {
        const user = await store.getUser(from.id);
        if (user && user.status !== "active") {
          if (chatId != null && update.message?.chat.type === "private") {
            await bot.sendMessage(chatId, "⛔ تم تقييد وصولك إلى هذا البوت من قبل الإدارة.");
          }
          if (update.callback_query) await ack(update.callback_query.id, "⛔ وصولك مقيد.", true);
          return true;
        }
      } catch { /* ignore */ }

      // Maintenance mode: only the owner team keeps access. Group messages are
      // never blocked here — protection must keep running during maintenance.
      if (cfg.maintenanceMode && !(await isAdmin(from.id))) {
        const isPrivateMessage = update.message?.chat.type === "private";
        if (isPrivateMessage && chatId != null) {
          await bot.sendMessage(chatId, "🛠️ البوت في وضع الصيانة حاليًا.\nنعود للعمل قريبًا، شكرًا لصبرك.");
          return true;
        }
        if (update.callback_query) {
          await ack(update.callback_query.id, "🛠️ وضع الصيانة مفعّل.", true);
          return true;
        }
        return false;
      }
    }
    return false;
  }

  async function acceptingActivations(): Promise<boolean> {
    try {
      return (await store.getConfig()).acceptActivations;
    } catch {
      return true;
    }
  }

  async function notifyOwners(text: string): Promise<void> {
    let cfg: SystemConfig | null = null;
    try { cfg = await store.getConfig(); } catch { /* ignore */ }
    const targets = new Set<number>(ownerIds);
    if (cfg?.notificationTarget) targets.add(cfg.notificationTarget);
    for (const id of targets) {
      try { await bot.sendMessage(id, text); } catch { /* ignore */ }
    }
  }

  // ---------- /admin command ----------

  async function handleCommand(message: TelegramMessage): Promise<boolean> {
    const text = (message.text ?? "").trim();
    if (!/^\/(admin|panel|owner)(@\w+)?$/i.test(text) && text !== "👑 لوحة الأدمن") return false;
    if (message.chat.type !== "private") return true;
    const from = message.from;
    if (!from || !(await isAdmin(from.id))) {
      await store.audit(from?.id ?? null, from?.username ?? from?.first_name ?? null, "unauthorized_access", "/admin", {});
      await bot.sendMessage(message.chat.id, "⛔ هذه اللوحة مخصصة لفريق إدارة البوت فقط.");
      return true;
    }
    await store.touchAdmin(from.id);
    await show(message.chat.id, null, screenHome(tenantMode));
    return true;
  }

  // ---------- callback router ----------

  async function handleCallback(update: NonNullable<TelegramUpdate["callback_query"]>): Promise<boolean> {
    const data = update.data ?? "";
    const parsed = parseAdminCallback(data);
    if (!parsed) return false;

    const message = update.message;
    const from = update.from;
    if (!message) {
      await ack(update.id, "افتح اللوحة من جديد بأمر /admin", true);
      return true;
    }
    const chatId = message.chat.id;
    const messageId = message.message_id;
    const key = parsed.key;
    const args = parsed.args;

    // Tenant panels use a strict allowlist. Unknown/future callback keys are
    // denied by default, including manually forged callbacks sent to Telegram.
    const tenantAllowedCallback =
      key === "home" || key === "noop" ||
      /^(users|u_|groups|g_|admins|a_|licenses|l_|bcast|bc_|prot|pe_|analytics|an_|logs|log_)/.test(key);
    if (tenantMode && !tenantAllowedCallback) {
      await ack(update.id, "⛔ هذا الأمر غير متاح في النسخ الخاصة.", true);
      await store.audit(from.id, from.username ?? from.first_name ?? null, "tenant_restricted_control_blocked", key, {});
      return true;
    }

    if (key === "noop") {
      await ack(update.id);
      return true;
    }

    // Authorization: any panel key requires admin; specific sections check their permission.
    if (!(await isAdmin(from.id))) {
      await ack(update.id, "⛔ غير مصرح لك.", true);
      await store.audit(from.id, from.username ?? from.first_name ?? null, "unauthorized_access", `adm:${key}`, {});
      await show(chatId, messageId, screenDenied());
      return true;
    }
    if (key === "managed_bots" || key.startsWith("mb_")) {
      if (!isOwner(from.id)) {
        await ack(update.id, "⛔ إدارة النسخ للمالك الأساسي فقط.", true);
        await store.audit(from.id, from.username ?? from.first_name ?? null, "unauthorized_access", `adm:${key}`, {});
        return true;
      }
    } else if (key === "emerg" || key.startsWith("em_")) {
      if (!isOwner(from.id)) {
        await ack(update.id, "⛔ أدوات الطوارئ للمالك فقط.", true);
        await store.audit(from.id, from.username ?? from.first_name ?? null, "unauthorized_access", `adm:${key}`, {});
        return true;
      }
    } else {
      const perm = permissionForKey(key);
      if (perm && !(await hasPermission(from.id, perm))) {
        await ack(update.id, `⛔ تحتاج صلاحية «${PERMISSION_LABELS[perm]}».`, true);
        await store.audit(from.id, from.username ?? from.first_name ?? null, "unauthorized_access", `adm:${key}`, {});
        return true;
      }
    }

    const actorName = from.username ? `@${from.username}` : from.first_name ?? String(from.id);
    await store.touchAdmin(from.id);
    const showScreen = (s: Screen | Promise<Screen>) => Promise.resolve(s).then((sc) => show(chatId, messageId, sc));
    const numArg = (i: number) => {
      const n = Number(args[i]);
      return Number.isSafeInteger(n) ? n : null;
    };

    switch (key) {
      case "home":
        await ack(update.id);
        await showScreen(screenHome(tenantMode));
        return true;

      // ============ إدارة النسخ (المالك الأساسي فقط) ============
      case "managed_bots":
      case "mb_page": {
        const page = key === "mb_page" ? (numArg(0) ?? 0) : 0;
        await ack(update.id);
        await showScreen(screenManagedBotList(await store.listManagedBots(), page));
        return true;
      }
      case "mb_page": {
        const page = numArg(0) ?? 0;
        await ack(update.id);
        await showScreen(screenManagedBotList(await store.listManagedBots(), page));
        return true;
      }
      case "mb_view": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "معرّف النسخة غير صالح.", true); return true; }
        const item = (await store.listManagedBots()).find((b) => b.bot_id === id) as ManagedBotAdminRow | undefined;
        await ack(update.id);
        await showScreen(item
          ? screenManagedBotDetail(item)
          : screenInfo("🧩 إدارة النسخ", "لم يتم العثور على النسخة.", "managed_bots"));
        return true;
      }
      case "mb_pause":
      case "mb_resume": {
        const id = numArg(0);
        if (id == null || !deps.managedBotAdmin) { await ack(update.id, "تعذر تنفيذ الإجراء.", true); return true; }
        await ack(update.id, "⏳ جارٍ تنفيذ الإجراء...");
        try {
          if (key === "mb_pause") {
            await deps.managedBotAdmin.pause(id);
            await recordOp(from.id, actorName, "managed_bot_admin_paused", String(id), { sensitive: true });
          } else {
            await deps.managedBotAdmin.resume(id);
            await recordOp(from.id, actorName, "managed_bot_admin_resumed", String(id), { sensitive: true });
          }
          const item = (await store.listManagedBots()).find((b) => b.bot_id === id) as ManagedBotAdminRow | undefined;
          await showScreen(item
            ? screenManagedBotDetail(item)
            : screenInfo("🧩 إدارة النسخ", "تم تحديث حالة النسخة.", "managed_bots"));
        } catch (error) {
          await showScreen(screenInfo("🧩 إدارة النسخ", `⚠️ فشل تنفيذ الإجراء: ${trunc(error instanceof Error ? error.message : String(error), 180)}`, "mb_view", id));
        }
        return true;
      }
      case "mb_del": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "معرّف النسخة غير صالح.", true); return true; }
        const item = (await store.listManagedBots()).find((b) => b.bot_id === id) as ManagedBotAdminRow | undefined;
        await ack(update.id);
        await showScreen(item
          ? screenManagedBotDeleteConfirm(item)
          : screenInfo("🧩 إدارة النسخ", "لم يتم العثور على النسخة.", "managed_bots"));
        return true;
      }
      case "mb_del_c": {
        const id = numArg(0);
        if (id == null || !deps.managedBotAdmin) { await ack(update.id, "تعذر تنفيذ الحذف.", true); return true; }
        await ack(update.id, "⏳ جارٍ حذف النسخة وبياناتها نهائيًا...");
        try {
          await deps.managedBotAdmin.deletePermanently(id);
          await recordOp(from.id, actorName, "managed_bot_permanently_deleted", String(id), { sensitive: true, tenant_schema_dropped: true });
          await showScreen(screenManagedBotList(await store.listManagedBots()));
        } catch (error) {
          await recordOp(from.id, actorName, "managed_bot_permanent_delete_failed", String(id), { error: trunc(error instanceof Error ? error.message : String(error), 180), sensitive: true });
          await showScreen(screenInfo("🧩 تعذر إكمال الحذف", "تم وضع النسخة في حالة حذف آمنة ومنع استقبال تحديثاتها. أعد فتح النسخة وحاول الحذف مرة أخرى لإكمال إزالة البيانات.\n\n" + trunc(error instanceof Error ? error.message : String(error), 180), "mb_view", id));
        }
        return true;
      }

      // ============ المستخدمون ============
      case "users":
        await ack(update.id);
        await showScreen(screenUsersMenu());
        return true;
      case "u_list":
      case "u_page": {
        const filter = key === "u_list" ? args[0] ?? "all" : args[1] ?? "all";
        const page = key === "u_list" ? numArg(1) ?? 0 : numArg(0) ?? 0;
        await ack(update.id);
        await showScreen(screenUserList(await store.listUsers(filter), filter, page));
        return true;
      }
      case "u_search":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_search_user", context: { panelMessageId: messageId } });
        await ack(update.id);
        await show(chatId, messageId, { text: "🔎 البحث عن مستخدم\\n━━━━━━━━━━━━━━━\\nأرسل الاسم أو Username أو Telegram ID:", keyboard: [] });
        return true;
      case "u_view": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مستخدم غير معروف.", true); return true; }
        await ack(update.id);
        const user = await store.getUser(id);
        if (!user) { await showScreen(screenInfo("👤 ملف المستخدم", "لم يتم العثور على هذا المستخدم في سجلات البوت.", "users")); return true; }
        const [counts, messages, ops] = await Promise.all([
          store.countUserGroups(id),
          store.countUserMessages(id),
          store.countAuditGlobal(),
        ]);
        const opsOnUser = (await store.listGlobalAudit()).filter((e) => e.target === String(id) || e.actor_telegram_user_id === id).length;
        await showScreen(screenUserDetail({ user, ownedGroups: counts.owned, botGroups: counts.botAdded, messageCount: messages, opsCount: ops + opsOnUser - ops }));
        return true;
      }
      case "u_groups": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مستخدم غير معروف.", true); return true; }
        await ack(update.id);
        const user = await store.getUser(id);
        const owned = (await store.listGroups("all")).filter((g) => g.owner_user_id === id);
        await showScreen(screenUserGroups(user ?? { telegram_user_id: id, username: null, display_name: String(id), status: "active", note: "", first_seen_at: "", last_seen_at: "" }, owned));
        return true;
      }
      case "u_gstats": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مستخدم غير معروف.", true); return true; }
        await ack(update.id);
        const [counts, messages] = await Promise.all([store.countUserGroups(id), store.countUserMessages(id)]);
        await showScreen(screenReport(`إحصائيات المستخدم ${id}`, [
          `مجموعات يمتلكها: ${counts.owned}`,
          `مجموعات يتواجد بها مع البوت: ${counts.botAdded}`,
          `إجمالي الرسائل المسجلة: ${messages}`,
        ], "u_gstats"));
        return true;
      }
      case "u_log": {
        const id = numArg(0);
        const page = numArg(1) ?? 0;
        if (id == null) { await ack(update.id, "مستخدم غير معروف.", true); return true; }
        await ack(update.id);
        const events = await store.listGlobalAudit(undefined, id);
        await showScreen(screenLogList(events, "all", page));
        return true;
      }
      case "u_pm": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مستخدم غير معروف.", true); return true; }
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_pm", context: { targetId: id } });
        await ack(update.id);
        await bot.sendMessage(chatId, `💬 اكتب الرسالة الخاصة التي تريد إرسالها إلى المستخدم ${id}:`, { reply_markup: { force_reply: true, input_field_placeholder: "نص الرسالة..." } });
        return true;
      }
      case "u_ban":
      case "u_unban": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مستخدم غير معروف.", true); return true; }
        const banning = key === "u_ban";
        await store.setUserStatus(id, banning ? "banned" : "active");
        await recordOp(from.id, actorName, banning ? "user_banned" : "user_unbanned", String(id), {});
        const cfg = await store.getConfig();
        if (banning && cfg.notifyUserBanned) await notifyOwners(`🚫 ${actorName} حظر المستخدم ${id} من النظام.`);
        await ack(update.id, banning ? "تم حظر المستخدم 🚫" : "تم فك الحظر 🔓");
        const user = await store.getUser(id);
        if (user) {
          const counts = await store.countUserGroups(id);
          await showScreen(screenUserDetail({ user, ownedGroups: counts.owned, botGroups: counts.botAdded, messageCount: await store.countUserMessages(id), opsCount: 0 }));
        }
        return true;
      }
      case "u_note": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مستخدم غير معروف.", true); return true; }
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_note", context: { targetId: id } });
        await ack(update.id);
        await bot.sendMessage(chatId, `📝 اكتب الملاحظة الإدارية للمستخدم ${id}:`, { reply_markup: { force_reply: true, input_field_placeholder: "الملاحظة..." } });
        return true;
      }
      case "u_activity": {
        await ack(update.id);
        await showScreen(screenLogList(await store.listGlobalAudit(), "all", 0));
        return true;
      }
      case "u_stats": {
        await ack(update.id);
        const [all, active, banned, fresh24] = await Promise.all([
          store.countUsers(),
          store.countUsers("active"),
          store.countUsers("banned"),
          store.countActiveUsers24h(),
        ]);
        await showScreen(screenReport("إحصائيات المستخدمين", [
          `الإجمالي: ${all}`,
          `النشطون: ${active}`,
          `المحظورون/المعطلون: ${banned}`,
          `نشط خلال 24 ساعة: ${fresh24}`,
        ], "u_stats"));
        return true;
      }

      // ============ المجموعات ============
      case "groups":
        await ack(update.id);
        await showScreen(screenGroupsMenu());
        return true;
      case "g_list":
      case "g_page": {
        const filter = key === "g_list" ? args[0] ?? "all" : args[1] ?? "all";
        const page = key === "g_list" ? numArg(1) ?? 0 : numArg(0) ?? 0;
        await ack(update.id);
        await showScreen(screenGroupList(await store.listGroups(filter), filter, page));
        return true;
      }
      case "g_search":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_search_group", context: {} });
        await ack(update.id);
        await bot.sendMessage(chatId, "🔎 أرسل اسم المجموعة أو Group ID للبحث:", { reply_markup: { force_reply: true, input_field_placeholder: "الاسم / -100..." } });
        return true;
      case "g_view": {
        const gid = numArg(0);
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        await ack(update.id);
        const screen = await buildGroupDetail(gid);
        await showScreen(screen ?? screenInfo("🛡️ بيانات المجموعة", "لم يتم العثور على هذه المجموعة في السجلات.", "groups"));
        return true;
      }
      case "g_owner": {
        const gid = numArg(0);
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        await ack(update.id);
        const groups = await store.listGroups("all");
        const g = groups.find((x) => x.chat_id === gid);
        if (!g?.owner_user_id) { await showScreen(screenInfo("👑 صاحب المجموعة", "لا يوجد مالك مسجل لهذه المجموعة.", "g_view", gid)); return true; }
        const owner = await store.getUser(g.owner_user_id);
        const counts = await store.countUserGroups(g.owner_user_id);
        await showScreen(owner
          ? screenUserDetail({ user: owner, ownedGroups: counts.owned, botGroups: counts.botAdded, messageCount: await store.countUserMessages(g.owner_user_id), opsCount: 0 })
          : screenInfo("👑 صاحب المجموعة", `ID المالك: ${g.owner_user_id}\nلم يتفاعل مع البوت بعد.`, "g_view", gid));
        return true;
      }
      case "g_members":
      case "g_mpage": {
        const gid = key === "g_members" ? numArg(0) : numArg(1);
        const page = key === "g_members" ? numArg(1) ?? 0 : numArg(0) ?? 0;
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        await ack(update.id);
        const members = await repo.listMembers(gid);
        await showScreen(screenGroupMembers(gid, members, page));
        return true;
      }
      case "g_stats": {
        const gid = numArg(0);
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        await ack(update.id);
        const o = await store.groupOverview(gid);
        const [warnings, bans, mutes] = await Promise.all([repo.totalWarnings(gid), repo.totalBans(gid), repo.totalMutes(gid)]);
        await showScreen(screenReport(`إحصائيات المجموعة ${gid}`, [
          `الأعضاء: ${o.memberCount}`,
          `الرسائل: ${o.messageCount}`,
          `المخالفات: ${o.violationCount}`,
          `التحذيرات: ${warnings}`,
          `الحظر: ${bans} • الكتم: ${mutes}`,
        ], "g_stats"));
        return true;
      }
      case "g_log": {
        const gid = numArg(0);
        const page = numArg(1) ?? 0;
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        await ack(update.id);
        await showScreen(screenLogList(await repo.listAudit(gid, undefined, 100), "all", page));
        return true;
      }
      case "g_prot": {
        const gid = numArg(0);
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        await ack(update.id);
        const settings = await repo.getSettings(gid);
        const p = settings.protection;
        await showScreen(screenInfo("⚙️ إعدادات الحماية الحالية", [
          `Anti-Spam: ${p.antiSpam.enabled ? "✅" : "⛔"} (${p.antiSpam.threshold}/${p.antiSpam.windowSeconds}ث)`,
          `Anti-Links: ${p.antiLinks.enabled ? "✅" : "⛔"} — قائمة بيضاء: ${p.antiLinks.whitelist.length}`,
          `Anti-Forward: ${p.antiForward.enabled ? "✅" : "⛔"}`,
          `Anti-Duplicate: ${p.antiDuplicate.enabled ? "✅" : "⛔"}`,
          `فلتر الكلمات: ${p.wordFilter.enabled ? "✅" : "⛔"} — ${p.wordFilter.words.length} كلمة`,
          `Anti-Flood: ${p.antiFlood.enabled ? "✅" : "⛔"} (${p.antiFlood.maxMessages}/${p.antiFlood.windowSeconds}ث)`,
          `العقوبة: ${p.punishment.action} بعد ${p.punishment.warningsBeforeAction} تحذيرات`,
        ].join("\n"), "g_view", gid));
        return true;
      }
      case "g_msg": {
        const gid = numArg(0);
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_g_msg", context: { targetId: gid } });
        await ack(update.id);
        await bot.sendMessage(chatId, `💬 اكتب الرسالة التي تريد إرسالها إلى المجموعة ${gid}:`, { reply_markup: { force_reply: true, input_field_placeholder: "نص الرسالة..." } });
        return true;
      }
      case "g_disable":
      case "g_enable": {
        const gid = numArg(0);
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        const disabling = key === "g_disable";
        await store.setGroupStatus(gid, disabling ? "paused" : "active");
        await recordOp(from.id, actorName, disabling ? "group_disabled" : "group_enabled", String(gid), {});
        await ack(update.id, disabling ? "تم تعطيل المجموعة 🔴" : "تم تفعيل المجموعة 🟢");
        const screen = await buildGroupDetail(gid);
        if (screen) await showScreen(screen);
        return true;
      }
      case "g_del": {
        const gid = numArg(0);
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        await ack(update.id);
        await showScreen({
          text: `⚠️ تأكيد حذف بيانات المجموعة\n━━━━━━━━━━━━━━━\nأنت على وشك حذف جميع بيانات المجموعة ${gid} نهائيًا (الأعضاء، الإعدادات، السجلات).\nهذا الإجراء لا يمكن التراجع عنه.`,
          keyboard: [
            [{ text: "✅ نعم، حذف نهائي", callback_data: ac("g_del_c", gid) }],
            [{ text: "❌ إلغاء", callback_data: ac("g_view", gid) }],
          ],
        });
        return true;
      }
      case "g_del_c": {
        const gid = numArg(0);
        if (gid == null) { await ack(update.id, "مجموعة غير معروفة.", true); return true; }
        await store.deleteGroupData(gid);
        await recordOp(from.id, actorName, "group_data_deleted", String(gid), { sensitive: true });
        await ack(update.id, "تم حذف بيانات المجموعة 🗑️");
        await showScreen(screenGroupList(await store.listGroups("all"), "all", 0));
        return true;
      }

      // ============ المديرون ============
      case "admins": {
        await ack(update.id);
        const all = await store.listAdmins();
        await showScreen(screenAdminsMenu({
          all: all.length,
          active: all.filter((a) => a.status === "active").length,
          suspended: all.filter((a) => a.status === "suspended").length,
        }));
        return true;
      }
      case "a_list":
      case "a_page": {
        const filter = key === "a_list" ? args[0] ?? "all" : args[1] ?? "all";
        const page = key === "a_list" ? numArg(1) ?? 0 : numArg(0) ?? 0;
        await ack(update.id);
        await showScreen(screenAdminList(await store.listAdmins(filter === "all" ? undefined : filter), filter, page, ownerIds));
        return true;
      }
      case "a_add":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_add_admin", context: {} });
        await ack(update.id);
        await bot.sendMessage(chatId, "➕ أرسل Telegram ID للمدير الجديد (يمكن إرفاق الاسم بعده بمسافة):", { reply_markup: { force_reply: true, input_field_placeholder: "123456789 اسم المدير" } });
        return true;
      case "a_view": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مدير غير معروف.", true); return true; }
        await ack(update.id);
        const admin = await getAdmin(id);
        if (!admin) { await showScreen(screenInfo("👑 ملف المدير", "لم يتم العثور على هذا المدير.", "a_list", "all", 0)); return true; }
        await showScreen(screenAdminDetail(admin, isOwner(id)));
        return true;
      }
      case "a_perm": {
        const id = numArg(0);
        const perm = args[1] as AdminPermission;
        if (id == null || !ADMIN_PERMISSIONS.includes(perm)) { await ack(update.id, "طلب غير صالح.", true); return true; }
        if (isOwner(id)) { await ack(update.id, "لا يمكن تعديل صلاحيات المالك.", true); return true; }
        const admin = await store.getAdmin(id);
        if (!admin) { await ack(update.id, "مدير غير معروف.", true); return true; }
        const next = admin.permissions.includes(perm)
          ? admin.permissions.filter((p) => p !== perm)
          : [...admin.permissions, perm];
        await store.setAdminPermissions(id, next);
        await recordOp(from.id, actorName, "admin_permissions_changed", String(id), { permission: perm, granted: next.includes(perm) });
        await ack(update.id, "تم تحديث الصلاحيات ✅");
        await showScreen(screenAdminDetail((await store.getAdmin(id))!, false));
        return true;
      }
      case "a_suspend":
      case "a_resume": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مدير غير معروف.", true); return true; }
        if (isOwner(id)) { await ack(update.id, "لا يمكن إيقاف المالك.", true); return true; }
        const suspend = key === "a_suspend";
        await store.setAdminStatus(id, suspend ? "suspended" : "active");
        await recordOp(from.id, actorName, suspend ? "admin_suspended" : "admin_resumed", String(id), { sensitive: suspend });
        await ack(update.id, suspend ? "تم إيقاف المدير ⛔" : "تم تفعيل المدير 🟢");
        await showScreen(screenAdminDetail((await store.getAdmin(id))!, false));
        return true;
      }
      case "a_del": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مدير غير معروف.", true); return true; }
        if (isOwner(id)) { await ack(update.id, "لا يمكن إزالة المالك.", true); return true; }
        await ack(update.id);
        await showScreen({
          text: `⚠️ تأكيد إزالة المدير\n━━━━━━━━━━━━━━━\nسيتم إزالة المدير ${id} وسحب جميع صلاحياته فورًا.`,
          keyboard: [
            [{ text: "✅ نعم، إزالة", callback_data: ac("a_del_c", id) }],
            [{ text: "❌ إلغاء", callback_data: ac("a_view", id) }],
          ],
        });
        return true;
      }
      case "a_del_c": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "مدير غير معروف.", true); return true; }
        await store.deleteAdmin(id);
        await recordOp(from.id, actorName, "admin_removed", String(id), { sensitive: true });
        await ack(update.id, "تمت إزالة المدير 🗑️");
        await showScreen(screenAdminList(await store.listAdmins(), "all", 0, ownerIds));
        return true;
      }
      case "a_ops": {
        const page = numArg(0) ?? 0;
        await ack(update.id);
        const admins = await store.listAdmins();
        const ids = new Set(admins.map((a) => a.telegram_user_id));
        const events = (await store.listGlobalAudit()).filter((e) => e.actor_telegram_user_id != null && ids.has(e.actor_telegram_user_id));
        await showScreen(screenLogList(events, "admins", page));
        return true;
      }

      // ============ التراخيص ============
      case "licenses": {
        await ack(update.id);
        const [all, active, expired, suspended, unused] = await Promise.all([
          store.countLicenses(), store.countLicenses("active"), store.countLicenses("expired"),
          store.countLicenses("suspended"), store.countLicenses("unused"),
        ]);
        await showScreen(screenLicensesMenu({ all, active, expired, suspended, unused }));
        return true;
      }
      case "l_list":
      case "l_page": {
        const filter = key === "l_list" ? args[0] ?? "all" : args[1] ?? "all";
        const page = key === "l_list" ? numArg(1) ?? 0 : numArg(0) ?? 0;
        await ack(update.id);
        await showScreen(screenLicenseList(await store.listLicenses(filter), filter, page));
        return true;
      }
      case "l_new":
        await ack(update.id);
        await showScreen(screenLicenseNew("group", 30));
        return true;
      case "l_cfg": {
        const kind = args[0] ?? "group";
        const days = numArg(1) ?? 30;
        await ack(update.id);
        await showScreen(screenLicenseNew(kind, days));
        return true;
      }
      case "l_gen": {
        const kind = args[0] ?? "group";
        const days = numArg(1) ?? 30;
        const code = generateLicenseCode();
        await store.createLicense({ code, kind, duration_days: days, created_by: from.id });
        await recordOp(from.id, actorName, "license_created", code, { kind, days });
        await ack(update.id, "تم توليد الكود ✅");
        const license = await store.getLicense(code);
        if (license) await showScreen(screenLicenseDetail(license, null));
        return true;
      }
      case "l_view": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "ترخيص غير معروف.", true); return true; }
        await ack(update.id);
        const license = await store.getLicense(id);
        if (!license) { await showScreen(screenInfo("🔑 تفاصيل الترخيص", "لم يتم العثور على هذا الترخيص.", "licenses")); return true; }
        const linked = await linkedName(license);
        await showScreen(screenLicenseDetail(license, linked));
        return true;
      }
      case "l_search":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_search_license", context: {} });
        await ack(update.id);
        await bot.sendMessage(chatId, "🔎 أرسل كود التفعيل أو جزءًا منه:", { reply_markup: { force_reply: true, input_field_placeholder: "PC-XXXX-XXXX-XXXX" } });
        return true;
      case "l_log": {
        const page = numArg(0) ?? 0;
        await ack(update.id);
        const events = (await store.listGlobalAudit()).filter((e) => e.event_type.startsWith("license"));
        await showScreen(screenLogList(events, "license", page));
        return true;
      }
      case "l_linkg":
      case "l_linku": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "ترخيص غير معروف.", true); return true; }
        await repo.setPending({ chat_id: chatId, group_id: 0, action: key === "l_linkg" ? "adm_linkg" : "adm_linku", context: { licenseId: id } });
        await ack(update.id);
        await bot.sendMessage(chatId, key === "l_linkg" ? "🔗 أرسل Group ID للربط بالترخيص:" : "🔗 أرسل Telegram ID للمستخدم للربط بالترخيص:", { reply_markup: { force_reply: true } });
        return true;
      }
      case "l_renew": {
        const id = numArg(0);
        if (id == null) { await ack(update.id, "ترخيص غير معروف.", true); return true; }
        const license = await store.getLicense(id);
        if (!license) { await ack(update.id, "ترخيص غير معروف.", true); return true; }
        const base = license.expires_at && new Date(license.expires_at).getTime() > Date.now() ? new Date(license.expires_at).getTime() : Date.now();
        const expires = new Date(base + license.duration_days * 86400000).toISOString();
        await store.updateLicense(id, { status: "active", expires_at: expires, activated_at: license.activated_at ?? new Date().toISOString() });
        await recordOp(from.id, actorName, "license_renewed", license.code, { expires });
        await ack(update.id, "تم تجديد الترخيص ♻️");
        const updated = await store.getLicense(id);
        if (updated) await showScreen(screenLicenseDetail(updated, await linkedName(updated)));
        return true;
      }
      case "l_status": {
        const id = numArg(0);
        const status = args[1];
        if (id == null || !["active", "suspended", "cancelled"].includes(status)) { await ack(update.id, "طلب غير صالح.", true); return true; }
        const license = await store.getLicense(id);
        if (!license) { await ack(update.id, "ترخيص غير معروف.", true); return true; }
        await store.updateLicense(id, { status });
        await recordOp(from.id, actorName, `license_${status}`, license.code, {});
        await ack(update.id, "تم تحديث حالة الترخيص ✅");
        const updated = await store.getLicense(id);
        if (updated) await showScreen(screenLicenseDetail(updated, await linkedName(updated)));
        return true;
      }

      // ============ الإذاعة ============
      case "bcast":
        await ack(update.id);
        await showScreen(screenBroadcastMenu());
        return true;
      case "bc_start": {
        const audience = args[0] ?? "all_users";
        if (audience === "selected_users") {
          await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_bc_ids", context: { audience } });
          await ack(update.id);
          await bot.sendMessage(chatId, "🎯 أرسل قائمة Telegram IDs مفصولة بفواصل:", { reply_markup: { force_reply: true, input_field_placeholder: "123, 456, 789" } });
          return true;
        }
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_bc_text", context: { audience } });
        await ack(update.id);
        await bot.sendMessage(chatId, `📣 اكتب نص الرسالة الموجهة إلى «${broadcastAudienceLabel(audience)}»:`, { reply_markup: { force_reply: true, input_field_placeholder: "نص الإذاعة..." } });
        return true;
      }
      case "bc_edit":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_bc_edit_keep", context: {} });
        await ack(update.id);
        await bot.sendMessage(chatId, "✏️ أرسل النص المعدل للإذاعة:", { reply_markup: { force_reply: true, input_field_placeholder: "النص الجديد..." } });
        return true;
      case "bc_confirm": {
        const pending = await repo.getPending(chatId);
        if (!pending || pending.action !== "adm_bc_confirm") {
          await ack(update.id, "انتهت صلاحية المسودة، ابدأ إذاعة جديدة.", true);
          return true;
        }
        await repo.clearPending(chatId);
        const audience = String(pending.context.audience ?? "all_users");
        const text = String(pending.context.text ?? "");
        const selected = String(pending.context.selected ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n !== 0);
        await ack(update.id, "🚀 بدأت الإذاعة...");
        await showScreen(screenInfo("📣 الإذاعة", "جارٍ الإرسال الآن... ستصلك رسالة بالنتيجة النهائية.", "bcast"));
        await runBroadcast(from.id, actorName, audience, text, selected, chatId);
        return true;
      }
      case "bc_stop": {
        const running = await store.getRunningBroadcast();
        const cfg = await store.getConfig();
        if (!running && cfg.broadcastStopped) {
          await ack(update.id, "لا توجد إذاعة جارية.", true);
          return true;
        }
        cfg.broadcastStopped = true;
        await store.setConfig(cfg);
        if (running) await store.updateBroadcastProgress(running.id, running.sent, running.failed, "stopped");
        await recordOp(from.id, actorName, "broadcast_stopped", running ? `#${running.id}` : null, { sensitive: true });
        await ack(update.id, "تم إيقاف الإذاعة ⏹️");
        await showScreen(screenBroadcastMenu());
        return true;
      }
      case "bc_log":
      case "bc_page": {
        const page = numArg(0) ?? 0;
        await ack(update.id);
        await showScreen(screenBroadcastLog(await store.listBroadcasts(), page));
        return true;
      }
      case "bc_stats": {
        await ack(update.id);
        const list = await store.listBroadcasts();
        await showScreen(screenBroadcastStats({
          total: list.length,
          sent: list.reduce((s, b) => s + b.sent, 0),
          failed: list.reduce((s, b) => s + b.failed, 0),
          running: list.filter((b) => b.status === "sending").length,
        }));
        return true;
      }

      // ============ الحماية العامة ============
      case "prot": {
        await ack(update.id);
        await showScreen(screenProtectionMenu(await store.getConfig(), await store.violations24h()));
        return true;
      }
      case "pe_tgl": {
        const engine = args[0] as keyof SystemConfig["protection"]["engines"];
        const cfg = await store.getConfig();
        if (!(engine in cfg.protection.engines)) { await ack(update.id, "محرك غير معروف.", true); return true; }
        cfg.protection.engines[engine] = !cfg.protection.engines[engine];
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", `engine:${engine}`, { enabled: cfg.protection.engines[engine] });
        await ack(update.id, cfg.protection.engines[engine] ? "تم تفعيل المحرك ✅" : "تم تعطيل المحرك ⛔");
        await showScreen(screenProtectionMenu(cfg, await store.violations24h()));
        return true;
      }
      case "pe_words": {
        await ack(update.id);
        await showScreen(screenWordList((await store.getConfig()).protection.globalWords));
        return true;
      }
      case "pe_words_add":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_pe_words", context: {} });
        await ack(update.id);
        await bot.sendMessage(chatId, "🚫 أرسل الكلمات المحظورة الافتراضية (افصل بينها بفواصل):", { reply_markup: { force_reply: true } });
        return true;
      case "pe_words_clear": {
        const cfg = await store.getConfig();
        cfg.protection.globalWords = [];
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", "globalWords", { cleared: true });
        await ack(update.id, "تم مسح القائمة 🧹");
        await showScreen(screenWordList([]));
        return true;
      }
      case "pe_domains": {
        await ack(update.id);
        await showScreen(screenDomainList((await store.getConfig()).protection.blockedDomains));
        return true;
      }
      case "pe_dom_add":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_pe_dom", context: {} });
        await ack(update.id);
        await bot.sendMessage(chatId, "🔗 أرسل النطاقات المحظورة (افصل بينها بفواصل):", { reply_markup: { force_reply: true, input_field_placeholder: "spam.com, scam.net" } });
        return true;
      case "pe_dom_clear": {
        const cfg = await store.getConfig();
        cfg.protection.blockedDomains = [];
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", "blockedDomains", { cleared: true });
        await ack(update.id, "تم مسح القائمة 🧹");
        await showScreen(screenDomainList([]));
        return true;
      }
      case "pe_stats": {
        await ack(update.id);
        const [violations, v24, spamLike] = await Promise.all([
          store.countAuditGlobal("violation"),
          store.violations24h(),
          store.listGlobalAudit("violation"),
        ]);
        const byType = new Map<string, number>();
        for (const e of spamLike) {
          try {
            const d = JSON.parse(e.details) as { violations?: string[] };
            for (const v of d.violations ?? []) byType.set(String(v), (byType.get(String(v)) ?? 0) + 1);
          } catch { /* ignore */ }
        }
        await showScreen(screenReport("إحصائيات اكتشاف المخالفات", [
          `إجمالي المخالفات: ${violations}`,
          `آخر 24 ساعة: ${v24}`,
          "",
          "أكثر الأنواع تكرارًا:",
          ...([...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `• ${k}: ${v}`)),
        ], "pe_stats"));
        return true;
      }
      case "pe_attacks": {
        const page = numArg(0) ?? 0;
        await ack(update.id);
        await showScreen(screenLogList(await store.listGlobalAudit("violation"), "violation", page));
        return true;
      }

      // ============ الإحصائيات ============
      case "analytics":
        await ack(update.id);
        await showScreen(screenAnalyticsMenu());
        return true;
      case "an_users": {
        await ack(update.id);
        const [all, active, banned, fresh24] = await Promise.all([store.countUsers(), store.countUsers("active"), store.countUsers("banned"), store.countActiveUsers24h()]);
        await showScreen(screenReport("إحصائيات المستخدمين", [`الإجمالي: ${all}`, `النشطون: ${active}`, `المحظورون: ${banned}`, `نشط 24 ساعة: ${fresh24}`], "an_users"));
        return true;
      }
      case "an_groups": {
        await ack(update.id);
        const [all, active, paused, left, fresh] = await Promise.all([
          store.countGroups(), store.countGroups("active"), store.countGroups("paused"), store.countGroups("left"),
          store.listGroups("new"),
        ]);
        await showScreen(screenReport("إحصائيات المجموعات", [`الإجمالي: ${all}`, `النشطة: ${active}`, `المعطلة: ${paused}`, `غادرها البوت: ${left}`, `جديدة هذا الأسبوع: ${fresh.length}`], "an_groups"));
        return true;
      }
      case "an_licenses": {
        await ack(update.id);
        const [all, active, expired, unused] = await Promise.all([store.countLicenses(), store.countLicenses("active"), store.countLicenses("expired"), store.countLicenses("unused")]);
        await showScreen(screenReport("إحصائيات التفعيلات", [`الإجمالي: ${all}`, `النشطة: ${active}`, `المنتهية: ${expired}`, `غير المستخدمة: ${unused}`], "an_licenses"));
        return true;
      }
      case "an_prot": {
        await ack(update.id);
        const [violations, v24] = await Promise.all([store.countAuditGlobal("violation"), store.violations24h()]);
        await showScreen(screenReport("إحصائيات الحماية", [`إجمالي المخالفات المكتشفة: ${violations}`, `آخر 24 ساعة: ${v24}`], "an_prot"));
        return true;
      }
      case "an_msgs": {
        await ack(update.id);
        const tables = await store.dbTableCounts();
        const msgs = tables.find((t) => t.table === "telegram_message_events")?.count ?? 0;
        const updates = tables.find((t) => t.table === "telegram_updates")?.count ?? 0;
        await showScreen(screenReport("إحصائيات الرسائل", [`أحداث الرسائل المسجلة: ${msgs}`, `تحديثات تيليجرام المعالجة: ${updates}`], "an_msgs"));
        return true;
      }
      case "an_admins": {
        await ack(update.id);
        const admins = await store.listAdmins();
        await showScreen(screenReport("إحصائيات المديرين", [
          `المالكون: ${ownerIds.length}`,
          `المديرون المعينون: ${admins.length}`,
          `النشطون: ${admins.filter((a) => a.status === "active").length}`,
          `إجمالي عملياتهم: ${admins.reduce((s, a) => s + a.ops_count, 0)}`,
        ], "an_admins"));
        return true;
      }
      case "an_report": {
        const kind = args[0] ?? "daily";
        const days = kind === "monthly" ? 30 : kind === "weekly" ? 7 : 1;
        await ack(update.id);
        const events = (await store.listGlobalAudit()).filter((e) => Date.now() - new Date(e.created_at).getTime() <= days * 86400000);
        const groups = await store.listGroups("new");
        const users = await store.listUsers("new");
        const title = kind === "monthly" ? "التقرير الشهري" : kind === "weekly" ? "التقرير الأسبوعي" : "التقرير اليومي";
        await showScreen(screenReport(title, [
          `الفترة: آخر ${days} يوم`,
          `العمليات المسجلة: ${events.length}`,
          `مخالفات: ${events.filter((e) => e.event_type === "violation").length}`,
          `تغييرات إعدادات: ${events.filter((e) => e.event_type === "settings_changed").length}`,
          `عمليات حظر: ${events.filter((e) => e.event_type.includes("ban")).length}`,
          `مجموعات جديدة (أسبوع): ${groups.length}`,
          `مستخدمون جدد (أسبوع): ${users.length}`,
        ], "an_report"));
        return true;
      }

      // ============ سجل العمليات ============
      case "logs":
        await ack(update.id);
        await showScreen(screenLogsMenu());
        return true;
      case "log_list":
      case "log_page": {
        const filter = key === "log_list" ? args[0] ?? "all" : args[1] ?? "all";
        const page = key === "log_list" ? numArg(1) ?? 0 : numArg(0) ?? 0;
        await ack(update.id);
        let events;
        if (filter === "owner") {
          const owners = new Set(ownerIds);
          events = (await store.listGlobalAudit()).filter((e) => e.actor_telegram_user_id != null && owners.has(e.actor_telegram_user_id));
        } else if (filter === "admins") {
          const ids = new Set((await store.listAdmins()).map((a) => a.telegram_user_id));
          events = (await store.listGlobalAudit()).filter((e) => e.actor_telegram_user_id != null && ids.has(e.actor_telegram_user_id));
        } else if (filter === "users") {
          events = (await store.listGlobalAudit()).filter((e) => ["member_joined", "member_left"].includes(e.event_type));
        } else if (filter === "ban") {
          events = (await store.listGlobalAudit()).filter((e) => e.event_type.includes("ban"));
        } else if (filter === "license") {
          events = (await store.listGlobalAudit()).filter((e) => e.event_type.startsWith("license"));
        } else if (filter === "broadcast") {
          events = (await store.listGlobalAudit()).filter((e) => e.event_type.startsWith("broadcast"));
        } else if (filter === "sensitive") {
          events = (await store.listGlobalAudit()).filter((e) => {
            try { return Boolean((JSON.parse(e.details) as { sensitive?: boolean }).sensitive) || e.event_type === "unauthorized_access"; } catch { return false; }
          });
        } else if (filter === "all") {
          events = await store.listGlobalAudit();
        } else {
          events = await store.listGlobalAudit(filter);
        }
        await showScreen(screenLogList(events, filter, page));
        return true;
      }
      case "log_view": {
        const id = numArg(0);
        const filter = args[1] ?? "all";
        const page = numArg(2) ?? 0;
        if (id == null) { await ack(update.id, "عملية غير معروفة.", true); return true; }
        await ack(update.id);
        const events = await store.listGlobalAudit();
        const e = events.find((x) => x.id === id);
        if (!e) { await showScreen(screenInfo("📜 تفاصيل العملية", "لم يتم العثور على العملية (ربما قُدّمت الصفحة).", "logs")); return true; }
        await showScreen(screenLogDetail(e, filter, page));
        return true;
      }

      // ============ إعدادات النظام ============
      case "sys":
        await ack(update.id);
        await showScreen(screenSystemMenu(await store.getConfig()));
        return true;
      case "sys_name":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_sys_name", context: {} });
        await ack(update.id);
        await bot.sendMessage(chatId, "✏️ أرسل اسم البوت الجديد:", { reply_markup: { force_reply: true } });
        return true;
      case "sys_startmsg":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_sys_startmsg", context: {} });
        await ack(update.id);
        await bot.sendMessage(chatId, "💬 أرسل رسالة /start الجديدة (اتركها فارغة بإرسال «-» للرجوع للافتراضية):", { reply_markup: { force_reply: true } });
        return true;
      case "sys_lang": {
        const cfg = await store.getConfig();
        cfg.language = cfg.language === "ar" ? "en" : "ar";
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", "language", { value: cfg.language });
        await ack(update.id, "تم تبديل اللغة 🌐");
        await showScreen(screenSystemMenu(cfg));
        return true;
      }
      case "sys_notif":
        await ack(update.id);
        await showScreen(screenNotificationsSettings(await store.getConfig()));
        return true;
      case "sys_notif_tgl": {
        const key2 = args[0] as keyof SystemConfig;
        const cfg = await store.getConfig();
        if (typeof cfg[key2] !== "boolean") { await ack(update.id, "إعداد غير معروف.", true); return true; }
        (cfg[key2] as boolean) = !cfg[key2];
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", String(key2), { value: cfg[key2] });
        await ack(update.id, "تم التبديل ✅");
        await showScreen(screenNotificationsSettings(cfg));
        return true;
      }
      case "sys_notif_target":
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_notif_target", context: {} });
        await ack(update.id);
        await bot.sendMessage(chatId, "🎯 أرسل Telegram ID لجهة استقبال الإشعارات (أو «-» للمالكين فقط):", { reply_markup: { force_reply: true } });
        return true;
      case "sys_security": {
        const page = numArg(0) ?? 0;
        await ack(update.id);
        await showScreen(screenLogList(await store.listGlobalAudit("unauthorized_access"), "sensitive", page));
        return true;
      }
      case "sys_tg": {
        await ack(update.id);
        const me = await bot.getMe().catch(() => null);
        const hook = await bot.getWebhookInfo().catch(() => null);
        const keyboard: InlineKeyboardButton[][] = [];
        if (deps.webhookUrl) keyboard.push([{ text: "🔁 إعادة تسجيل Webhook", callback_data: ac("sys_tg_hook") }]);
        keyboard.push([{ text: "↩️ رجوع", callback_data: ac("sys") }]);
        await showScreen({
          text: [
            "🤖 إعدادات تيليجرام",
            "━━━━━━━━━━━━━━━",
            `البوت: ${me ? `@${me.username ?? "?"} (${me.first_name ?? ""})` : "⚠️ تعذر الاتصال بـ Telegram API"}`,
            `معرّف البوت: ${me?.id ?? "—"}`,
            `Webhook: ${hook?.url ? "🟢 " + hook.url : "🔴 غير مسجل"}`,
            `تحديثات معلقة: ${hook?.pending_update_count ?? "—"}`,
            hook?.last_error_message ? `آخر خطأ: ${trunc(hook.last_error_message, 150)}` : "لا أخطاء مسجلة.",
          ].join("\n"),
          keyboard,
        });
        return true;
      }
      case "sys_tg_hook": {
        if (!deps.webhookUrl) { await ack(update.id, "رابط Webhook غير مهيأ في الخادم.", true); return true; }
        try {
          await bot.setWebhook(deps.webhookUrl, deps.webhookSecret);
          await recordOp(from.id, actorName, "settings_changed", "webhook", { url: deps.webhookUrl });
          await ack(update.id, "تمت إعادة تسجيل Webhook ✅");
        } catch (error) {
          await ack(update.id, "فشل التسجيل: " + trunc(error instanceof Error ? error.message : String(error), 100), true);
        }
        return true;
      }
      case "sys_db": {
        await ack(update.id, "جارٍ فحص قاعدة البيانات...");
        let ok = true;
        let tables: Array<{ table: string; count: number }> = [];
        try { tables = await store.dbTableCounts(); } catch { ok = false; }
        await showScreen(screenInfo("🗄️ حالة قاعدة البيانات", [
          `الاتصال: ${ok ? "🟢 متصل (PostgreSQL)" : "🔴 فشل الاتصال"}`,
          "",
          "فحص الجداول وعدد السجلات:",
          ...tables.map((t) => `• ${t.table}: ${t.count >= 0 ? t.count : "⚠️ خطأ"}`),
        ].join("\n"), "sys"));
        return true;
      }
      case "sys_reload":
        await store.getConfig();
        await recordOp(from.id, actorName, "settings_changed", "reload", {});
        await ack(update.id, "تمت إعادة تحميل الإعدادات 🔄");
        await showScreen(screenSystemMenu(await store.getConfig()));
        return true;

      // ============ السيرفر ============
      case "infra": {
        await ack(update.id, "جارٍ جمع بيانات النظام...");
        await showScreen(screenInfra(await buildInfra()));
        return true;
      }
      case "infra_check": {
        await ack(update.id, "جارٍ فحص الخدمات...");
        const d = await buildInfra();
        const results = [
          `قاعدة البيانات: ${d.dbOk ? "🟢" : "🔴"}`,
          `Telegram API: ${d.webhook.ok ? "🟢" : "🔴"}`,
          `Webhook: ${d.webhook.url ? "🟢 مسجل" : "🔴 غير مسجل"}`,
          `الذاكرة: ${d.memoryMb < 400 ? "🟢" : "🟡"} (${d.memoryMb} MB)`,
          `تحديثات فاشلة: ${d.failedUpdates === 0 ? "🟢 0" : `🟡 ${d.failedUpdates}`}`,
        ];
        await showScreen(screenInfo("🔍 فحص الخدمات", results.join("\n"), "infra"));
        return true;
      }

      // ============ الطوارئ (مالك فقط) ============
      case "emerg":
        await ack(update.id);
        await showScreen(screenEmergency(await store.getConfig()));
        return true;
      case "em_ask": {
        const action = args[0] ?? "";
        const cfg = await store.getConfig();
        if (action === "user" || action === "group" || action === "admin") {
          await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_em_target", context: { emAction: action } });
          await ack(update.id);
          const prompt = action === "user"
            ? "👤 أرسل Telegram ID للمستخدم المراد تعطيله:"
            : action === "group"
              ? "🛡️ أرسل Group ID للمجموعة المراد تعطيلها:"
              : "⛔ أرسل Telegram ID للمدير المراد إيقافه:";
          await bot.sendMessage(chatId, prompt, { reply_markup: { force_reply: true } });
          return true;
        }
        if (action === "engine") {
          await ack(update.id);
          await showScreen(screenEmergencyEngines(cfg));
          return true;
        }
        if (action.startsWith("engine:")) {
          const key = action.slice("engine:".length) as keyof typeof ENGINE_LABELS;
          if (!(key in ENGINE_LABELS)) { await ack(update.id, "محرك غير معروف.", true); return true; }
          const on = cfg.protection.engines[key] !== false;
          await ack(update.id);
          await showScreen(screenConfirm(action, `${on ? "⏸️ إيقاف" : "▶️ تشغيل"} محرك ${ENGINE_LABELS[key]}`, ""));
          return true;
        }
        if (action === "recovery") {
          await ack(update.id);
          await showScreen(screenRecovery());
          return true;
        }
        if (action === "backup") {
          await ack(update.id, "⏳ جارٍ تجهيز النسخة الاحتياطية...");
          try {
            const filename = await runBackup(store, bot, chatId);
            await recordOp(from.id, actorName, "emergency_backup", null, { filename, sensitive: true });
            await showScreen(screenInfo("🧰 استرداد النظام", `تم إنشاء النسخة الاحتياطية وإرسالها إليك كملف:\n${filename}\n\nاحتفظ به في مكان آمن — ستحتاجه عند الاستعادة.`, "em_ask:recovery"));
          } catch {
            await showScreen(screenInfo("🧰 استرداد النظام", "⚠️ فشل إنشاء النسخة الاحتياطية. تحقق من اتصال قاعدة البيانات وأعد المحاولة.", "em_ask:recovery"));
          }
          return true;
        }
        if (action === "restore") {
          await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_em_restore", context: {} });
          await ack(update.id);
          await showScreen(screenInfo(
            "🧰 استعادة نسخة احتياطية",
            "📤 أرسل الآن ملف النسخة الاحتياطية (JSON) الذي حصلت عليه من أمر «تنزيل نسخة احتياطية» كمستند في هذه المحادثة.\n\n⚠️ سيتم استبدال البيانات الحالية للجداول الموجودة في الملف، وسيُطلب تأكيد نهائي قبل التنفيذ.\n\nلإلغاء العملية أرسل /cancel",
            "em_ask:recovery",
          ));
          return true;
        }
        const labels: Record<string, string> = {
          maintenance: cfg.maintenanceMode ? "إلغاء وضع الصيانة" : "تفعيل وضع الصيانة",
          activations: cfg.acceptActivations ? "إيقاف استقبال التفعيلات الجديدة" : "فتح استقبال التفعيلات",
          broadcast: cfg.broadcastStopped ? "استئناف الإذاعة" : "إيقاف الإذاعة فورًا",
          check: "فحص شامل للنظام",
          defaults: "استعادة الإعدادات الافتراضية بالكامل",
        };
        if (!labels[action]) { await ack(update.id, "إجراء غير معروف.", true); return true; }
        await ack(update.id);
        await showScreen(screenConfirm(action, labels[action], ""));
        return true;
      }
      case "em_do": {
        const action = args[0] ?? "";
        await ack(update.id, "جارٍ التنفيذ...");
        const cfg = await store.getConfig();
        if (action === "maintenance") {
          cfg.maintenanceMode = !cfg.maintenanceMode;
          await store.setConfig(cfg);
          await recordOp(from.id, actorName, "emergency_maintenance", null, { enabled: cfg.maintenanceMode, sensitive: true });
          if (cfg.maintenanceMode && cfg.notifyBotDown) await notifyOwners("🛠️ تم تفعيل وضع الصيانة.");
          await showScreen(screenInfo("🚨 أدوات الطوارئ", cfg.maintenanceMode ? "تم تفعيل وضع الصيانة. المستخدمون العاديون محجوبون الآن." : "تم إلغاء وضع الصيانة وعاد البوت للعمل.", "emerg"));
        } else if (action === "activations") {
          cfg.acceptActivations = !cfg.acceptActivations;
          await store.setConfig(cfg);
          await recordOp(from.id, actorName, "emergency_activations", null, { enabled: cfg.acceptActivations, sensitive: true });
          await showScreen(screenInfo("🚨 أدوات الطوارئ", cfg.acceptActivations ? "تم فتح استقبال التفعيلات الجديدة." : "تم إيقاف استقبال التفعيلات الجديدة.", "emerg"));
        } else if (action === "broadcast") {
          cfg.broadcastStopped = !cfg.broadcastStopped;
          await store.setConfig(cfg);
          if (cfg.broadcastStopped) {
            const running = await store.getRunningBroadcast();
            if (running) await store.updateBroadcastProgress(running.id, running.sent, running.failed, "stopped");
          }
          await recordOp(from.id, actorName, "emergency_broadcast", null, { stopped: cfg.broadcastStopped, sensitive: true });
          await showScreen(screenInfo("🚨 أدوات الطوارئ", cfg.broadcastStopped ? "تم إيقاف الإذاعة. أي إذاعة جارية ستتوقف." : "تم استئناف الإذاعة.", "emerg"));
        } else if (action === "check") {
          const d = await buildInfra();
          await recordOp(from.id, actorName, "emergency_check", null, {});
          await showScreen(screenInfra(d));
        } else if (action === "defaults") {
          const fresh = defaultSystemConfig();
          await store.setConfig(fresh);
          await recordOp(from.id, actorName, "emergency_defaults_reset", null, { sensitive: true });
          await showScreen(screenInfo("🚨 أدوات الطوارئ", "تمت استعادة إعدادات النظام الافتراضية بالكامل.", "emerg"));
        } else if (action === "user" || action === "group") {
          const pending = await repo.getPending(chatId);
          if (!pending || pending.action !== "adm_em_confirm") { await ack(update.id, "انتهت الجلسة، أعد المحاولة.", true); return true; }
          await repo.clearPending(chatId);
          const target = Number(pending.context.targetId);
          if (action === "user") {
            await store.setUserStatus(target, "disabled");
            await recordOp(from.id, actorName, "user_disabled", String(target), { sensitive: true });
            await showScreen(screenInfo("🚨 أدوات الطوارئ", `تم تعطيل المستخدم ${target} من النظام.`, "emerg"));
          } else {
            await store.setGroupStatus(target, "paused");
            await recordOp(from.id, actorName, "group_disabled", String(target), { sensitive: true });
            await showScreen(screenInfo("🚨 أدوات الطوارئ", `تم تعطيل المجموعة ${target}.`, "emerg"));
          }
        } else if (action === "admin") {
          const pending = await repo.getPending(chatId);
          if (!pending || pending.action !== "adm_em_confirm") { await ack(update.id, "انتهت الجلسة، أعد المحاولة.", true); return true; }
          await repo.clearPending(chatId);
          const target = Number(pending.context.targetId);
          if (isOwner(target)) { await showScreen(screenInfo("🚨 أدوات الطوارئ", "⚠️ لا يمكن إيقاف المالك.", "emerg")); return true; }
          await store.setAdminStatus(target, "suspended");
          await recordOp(from.id, actorName, "admin_suspended", String(target), { sensitive: true });
          await showScreen(screenInfo("🚨 أدوات الطوارئ", `تم إيقاف المدير ${target} فورًا. يمكن إعادة تفعيله من إدارة المديرين.`, "emerg"));
        } else if (action.startsWith("engine:")) {
          const key = action.slice("engine:".length) as keyof typeof ENGINE_LABELS;
          if (!(key in ENGINE_LABELS)) { await ack(update.id, "محرك غير معروف.", true); return true; }
          const current = cfg.protection.engines[key] !== false;
          cfg.protection.engines[key] = !current;
          await store.setConfig(cfg);
          await recordOp(from.id, actorName, "emergency_engine_toggle", key, { engine: key, enabled: !current, sensitive: true });
          await showScreen(screenInfo("🚨 أدوات الطوارئ", !current ? `تم تشغيل محرك ${ENGINE_LABELS[key]}.` : `تم إيقاف محرك ${ENGINE_LABELS[key]} على مستوى النظام كله.`, "em_ask:engine"));
        } else if (action === "restore") {
          const pending = await repo.getPending(chatId);
          if (!pending || pending.action !== "adm_em_restore_confirm") { await ack(update.id, "انتهت الجلسة، أعد المحاولة.", true); return true; }
          await repo.clearPending(chatId);
          const fileId = String(pending.context.fileId ?? "");
          if (!fileId) { await showScreen(screenInfo("🧰 استرداد النظام", "⚠️ لم يتم العثور على الملف. أعد العملية من البداية.", "em_ask:recovery")); return true; }
          try {
            const result = await restoreBackup(store, bot, {
              file_id: fileId,
              file_name: String(pending.context.fileName ?? "backup.json"),
            });
            if (!result.ok) {
              await recordOp(from.id, actorName, "emergency_restore_failed", null, { error: result.error ?? "unknown", sensitive: true });
              await showScreen(screenInfo("🧰 استرداد النظام", `⚠️ فشلت الاستعادة: ${result.error ?? "خطأ غير معروف"}\nلم يتم تغيير البيانات الحالية.`, "em_ask:recovery"));
              return true;
            }
            const summary = result.restored.length > 0 ? `الجداول المستعادة: ${result.restored.join("، ")}` : "لم يتضمن الملف جداول قابلة للاستعادة.";
            await recordOp(from.id, actorName, "emergency_restore", null, { restored: result.restored, sensitive: true });
            await notifyOwners(`🧰 تم تنفيذ استعادة نسخة احتياطية بواسطة ${actorName}.\n${summary}`);
            await showScreen(screenInfo("🧰 استرداد النظام", `✅ تمت الاستعادة بنجاح.\n\n${summary}`, "em_ask:recovery"));
          } catch (err) {
            await recordOp(from.id, actorName, "emergency_restore_failed", null, { error: err instanceof Error ? err.message : String(err), sensitive: true });
            await showScreen(screenInfo("🧰 استرداد النظام", "⚠️ فشلت الاستعادة بسبب خطأ غير متوقع. لم يتم تغيير البيانات الحالية.", "em_ask:recovery"));
          }
        } else {
          await ack(update.id, "إجراء غير معروف.", true);
        }
        return true;
      }

      default:
        await ack(update.id, "الزر غير معروف.", true);
        return true;
    }
  }

  async function buildGroupDetail(gid: number) {
    const groups = await store.listGroups("all");
    const g = groups.find((x) => x.chat_id === gid);
    if (!g) return null;
    const overview = await store.groupOverview(gid);
    let botStatus = "غير معروفة";
    try {
      const me = await bot.getMe();
      const member = await bot.getChatMember(gid, me.id);
      botStatus = member.status === "administrator"
        ? `🟢 مشرف (حذف: ${member.can_delete_messages ? "✅" : "⛔"} / تقييد: ${member.can_restrict_members ? "✅" : "⛔"})`
        : member.status === "member" ? "🟡 عضو فقط — بدون صلاحيات" : "🔴 غير موجود";
    } catch {
      botStatus = "🔴 لا يمكن الوصول للمجموعة";
    }
    const owner = g.owner_user_id != null ? await store.getUser(g.owner_user_id) : null;
    return screenGroupDetail({
      group: g,
      ownerName: owner ? userLabel(owner) : null,
      memberCount: overview.memberCount,
      messageCount: overview.messageCount,
      violationCount: overview.violationCount,
      botStatus,
    });
  }

  async function linkedName(license: { linked_group_id: number | null; linked_user_id: number | null }): Promise<string | null> {
    if (license.linked_group_id != null) {
      const g = (await store.listGroups("all")).find((x) => x.chat_id === license.linked_group_id);
      return `مجموعة: ${g?.title ?? license.linked_group_id}`;
    }
    if (license.linked_user_id != null) {
      const u = await store.getUser(license.linked_user_id);
      return `مستخدم: ${u ? userLabel(u) : license.linked_user_id}`;
    }
    return null;
  }

  async function buildInfra(): Promise<InfraData> {
    const proc = (globalThis as { process?: { uptime?: () => number; memoryUsage?: () => { rss: number }; versions?: { node?: string } } }).process;
    let dbOk = true;
    let tableCounts: Array<{ table: string; count: number }> = [];
    try { tableCounts = await store.dbTableCounts(); } catch { dbOk = false; }
    let webhook: InfraData["webhook"] = { ok: false, url: "", pending: 0, lastError: null };
    try {
      const info = await bot.getWebhookInfo();
      webhook = { ok: true, url: info.url, pending: info.pending_update_count, lastError: info.last_error_message ?? null };
    } catch { /* keep default */ }
    const failedUpdates = await store.failedUpdates().catch(() => 0);
    return {
      uptimeSeconds: Math.max(0, Math.floor(proc?.uptime ? proc.uptime() : (Date.now() - startedAt) / 1000)),
      memoryMb: Math.round((proc?.memoryUsage ? proc.memoryUsage().rss : 0) / 1048576),
      dbOk,
      tableCounts,
      webhook,
      failedUpdates,
      nodeVersion: proc?.versions?.node ?? "—",
    };
  }

  // ---------- broadcast engine ----------

  async function runBroadcast(actorId: number, actorName: string, audience: string, text: string, selected: number[], replyTo: number): Promise<void> {
    let recipients: number[] = [];
    if (audience === "all_users" || audience === "notice") recipients = await store.listAllUserIds();
    else if (audience === "selected_users") recipients = selected;
    else if (audience === "all_groups") recipients = (await store.listGroups("all")).filter((g) => g.status !== "left").map((g) => g.chat_id);
    else if (audience === "active_groups") recipients = (await store.listGroups("active")).map((g) => g.chat_id);
    else if (audience === "admins") recipients = [...new Set([...ownerIds, ...(await store.listAdmins("active")).map((a) => a.telegram_user_id)])];
    recipients = [...new Set(recipients)].slice(0, 2000);

    const id = await store.createBroadcast({ actor_id: actorId, audience, content_text: trunc(text, 500), total: recipients.length });
    await store.audit(actorId, actorName, "broadcast_started", `#${id}`, { audience, total: recipients.length });

    let sent = 0;
    let failed = 0;
    let stopped = false;
    for (let i = 0; i < recipients.length; i++) {
      if (i % 10 === 0) {
        try {
          if ((await store.getConfig()).broadcastStopped) { stopped = true; break; }
        } catch { /* continue */ }
      }
      try {
        await bot.sendMessage(recipients[i], audience === "notice" ? `🔔 إشعار إداري\n━━━━━━━━━━━━━━━\n${text}` : text);
        sent++;
      } catch {
        failed++;
      }
      if ((i + 1) % 25 === 0) {
        await store.updateBroadcastProgress(id, sent, failed).catch(() => undefined);
        await sleep(1000); // stay well under Telegram flood limits
      }
    }
    const status = stopped ? "stopped" : "done";
    await store.updateBroadcastProgress(id, sent, failed, status);
    await store.audit(actorId, actorName, `broadcast_${status}`, `#${id}`, { sent, failed, total: recipients.length });
    try {
      await bot.sendMessage(replyTo, `📣 اكتملت الإذاعة #${id}\n━━━━━━━━━━━━━━━\nالجمهور: ${broadcastAudienceLabel(audience)}\n✅ نجح: ${sent}\n❌ فشل: ${failed}${stopped ? "\n⏹️ أوقفت يدويًا" : ""}`);
    } catch { /* ignore */ }
  }

  // ---------- pending text inputs ----------

  async function handlePending(chatId: number, text: string, from?: TelegramFrom): Promise<boolean> {
    const pending = await repo.getPending(chatId);
    if (!pending || !pending.action.startsWith("adm_")) return false;
    const tenantAllowedPending = new Set([
      "adm_search_user", "adm_pm", "adm_note", "adm_add_admin",
      "adm_search_license", "adm_linkg", "adm_linku",
      "adm_bc_ids", "adm_bc_text", "adm_bc_edit_keep",
      "adm_g_msg", "adm_pe_words", "adm_pe_dom",
    ]);
    if (tenantMode && !tenantAllowedPending.has(pending.action)) {
      await repo.clearPending(chatId);
      if (from) await store.audit(from.id, from.username ?? from.first_name ?? null, "tenant_restricted_pending_blocked", pending.action, {});
      await bot.sendMessage(chatId, "⛔ هذا الإجراء غير متاح في النسخ الخاصة.");
      return true;
    }
    if (!from || !(await isAdmin(from.id))) {
      await repo.clearPending(chatId);
      return true;
    }
    const actorName = from.username ? `@${from.username}` : from.first_name ?? String(from.id);
    const input = text.trim();
    const ctx = pending.context;

    switch (pending.action) {
      case "adm_search_user": {
        await repo.clearPending(chatId);
        const users = await store.listUsers("search", input);
        const panelMessageId = Number(ctx.panelMessageId);
        await show(chatId, Number.isSafeInteger(panelMessageId) ? panelMessageId : null, screenUserList(users, "search", 0));
        return true;
      }
      case "adm_search_group": {
        await repo.clearPending(chatId);
        const groups = await store.listGroups("search", input);
        await show(chatId, null, screenGroupList(groups, "search", 0));
        return true;
      }
      case "adm_pm": {
        await repo.clearPending(chatId);
        const target = Number(ctx.targetId);
        try {
          await bot.sendMessage(target, `💬 رسالة من إدارة البوت\n━━━━━━━━━━━━━━━\n${input}`);
          await recordOp(from.id, actorName, "user_pm_sent", String(target), {});
          await bot.sendMessage(chatId, "✅ تم إرسال الرسالة الخاصة.");
        } catch {
          await bot.sendMessage(chatId, "⚠️ تعذر الإرسال (ربما حظر المستخدم البوت).");
        }
        return true;
      }
      case "adm_note": {
        await repo.clearPending(chatId);
        const target = Number(ctx.targetId);
        await store.setUserNote(target, input);
        await recordOp(from.id, actorName, "user_note_added", String(target), { note: trunc(input, 200) });
        await bot.sendMessage(chatId, "✅ تم حفظ الملاحظة الإدارية.");
        return true;
      }
      case "adm_add_admin": {
        await repo.clearPending(chatId);
        const match = input.match(/^(\d{3,})(?:\s+(.+))?$/);
        if (!match) {
          await bot.sendMessage(chatId, "⚠️ صيغة غير صالحة. أرسل ID رقميًا (واسمًا اختياريًا بعده).");
          return true;
        }
        const id = Number(match[1]);
        const name = match[2]?.trim() || String(id);
        if (isOwner(id)) {
          await bot.sendMessage(chatId, "⚠️ هذا المستخدم مالك بالفعل ويملك كل الصلاحيات.");
          return true;
        }
        await store.upsertAdmin({ telegram_user_id: id, display_name: name, permissions: [], added_by: from.id });
        await recordOp(from.id, actorName, "admin_added", String(id), { name });
        await bot.sendMessage(chatId, `✅ تمت إضافة المدير «${name}».\nالآن حدّد صلاحياته:`, {
          reply_markup: { inline_keyboard: [[{ text: "🔐 ضبط الصلاحيات", callback_data: ac("a_view", id) }]] },
        });
        try { await bot.sendMessage(id, "👑 تم تعيينك مديرًا في بوت Pre Crime.\nأرسل /admin لفتح لوحة الإدارة."); } catch { /* user may not have started the bot */ }
        return true;
      }
      case "adm_search_license": {
        await repo.clearPending(chatId);
        const direct = await store.getLicense(input.toUpperCase());
        if (direct) {
          await show(chatId, null, screenLicenseDetail(direct, await linkedName(direct)));
          return true;
        }
        const results = await store.listLicenses("all", input);
        await show(chatId, null, screenLicenseList(results, "search", 0));
        return true;
      }
      case "adm_linkg":
      case "adm_linku": {
        await repo.clearPending(chatId);
        const licenseId = Number(ctx.licenseId);
        const target = Number(input);
        if (!Number.isSafeInteger(target)) {
          await bot.sendMessage(chatId, "⚠️ معرّف غير صالح.");
          return true;
        }
        const license = await store.getLicense(licenseId);
        if (!license) {
          await bot.sendMessage(chatId, "⚠️ الترخيص لم يعد موجودًا.");
          return true;
        }
        const patch = pending.action === "adm_linkg" ? { linked_group_id: target } : { linked_user_id: target };
        await store.updateLicense(licenseId, patch);
        await recordOp(from.id, actorName, "license_linked", license.code, { ...patch });
        await bot.sendMessage(chatId, "✅ تم ربط الترخيص بنجاح.");
        return true;
      }
      case "adm_bc_ids": {
        const ids = input.split(/[,،\s]+/).map((s) => Number(s)).filter((n) => Number.isSafeInteger(n) && n > 0);
        if (!ids.length) {
          await repo.clearPending(chatId);
          await bot.sendMessage(chatId, "⚠️ لم يتم التعرف على أي ID صالح.");
          return true;
        }
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_bc_text", context: { audience: "selected_users", selected: ids.join(",") } });
        await bot.sendMessage(chatId, `📣 تم تسجيل ${ids.length} مستلمًا. الآن اكتب نص الرسالة:`, { reply_markup: { force_reply: true } });
        return true;
      }
      case "adm_bc_text": {
        const audience = String(ctx.audience ?? "all_users");
        const selected = String(ctx.selected ?? "");
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_bc_confirm", context: { audience, text: input, selected } });
        let count = 0;
        try {
          if (audience === "all_users" || audience === "notice") count = (await store.listAllUserIds()).length;
          else if (audience === "selected_users") count = selected.split(",").filter(Boolean).length;
          else if (audience === "all_groups") count = (await store.listGroups("all")).filter((g) => g.status !== "left").length;
          else if (audience === "active_groups") count = (await store.listGroups("active")).length;
          else if (audience === "admins") count = (await store.listAdmins("active")).length + ownerIds.length;
        } catch { /* preview shows 0 */ }
        await show(chatId, null, screenBroadcastPreview(audience, input, count));
        return true;
      }
      case "adm_bc_edit_keep": {
        const previous = await repo.getPending(chatId);
        // Re-arm the confirm draft with the edited text, keeping the audience.
        const audience = String(previous?.context.audience ?? ctx.audience ?? "all_users");
        const selected = String(previous?.context.selected ?? "");
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_bc_confirm", context: { audience, text: input, selected } });
        await show(chatId, null, screenBroadcastPreview(audience, input, 0));
        return true;
      }
      case "adm_g_msg": {
        await repo.clearPending(chatId);
        const gid = Number(ctx.targetId);
        try {
          await bot.sendMessage(gid, `📢 رسالة الإدارة\n━━━━━━━━━━━━━━━\n${input}`);
          await recordOp(from.id, actorName, "group_message_sent", String(gid), {});
          await bot.sendMessage(chatId, "✅ تم إرسال الرسالة للمجموعة.");
        } catch {
          await bot.sendMessage(chatId, "⚠️ تعذر الإرسال (تأكد أن البوت ما زال داخل المجموعة).");
        }
        return true;
      }
      case "adm_pe_words": {
        await repo.clearPending(chatId);
        const words = input.split(/[,،\n]/).map((w) => w.trim()).filter(Boolean);
        const cfg = await store.getConfig();
        cfg.protection.globalWords = [...new Set([...cfg.protection.globalWords, ...words])];
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", "globalWords", { added: words });
        await show(chatId, null, screenWordList(cfg.protection.globalWords));
        return true;
      }
      case "adm_pe_dom": {
        await repo.clearPending(chatId);
        const domains = input.split(/[,،\n]/).map((d) => d.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
        const cfg = await store.getConfig();
        cfg.protection.blockedDomains = [...new Set([...cfg.protection.blockedDomains, ...domains])];
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", "blockedDomains", { added: domains });
        await show(chatId, null, screenDomainList(cfg.protection.blockedDomains));
        return true;
      }
      case "adm_sys_name": {
        await repo.clearPending(chatId);
        const cfg = await store.getConfig();
        cfg.botName = trunc(input, 60);
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", "botName", { value: cfg.botName });
        await show(chatId, null, screenSystemMenu(cfg));
        return true;
      }
      case "adm_sys_startmsg": {
        await repo.clearPending(chatId);
        const cfg = await store.getConfig();
        cfg.startMessage = input === "-" ? "" : trunc(input, 1500);
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", "startMessage", { changed: true });
        await bot.sendMessage(chatId, "✅ تم حفظ رسالة /start الجديدة.");
        return true;
      }
      case "adm_notif_target": {
        await repo.clearPending(chatId);
        const cfg = await store.getConfig();
        cfg.notificationTarget = input === "-" ? null : Number(input);
        await store.setConfig(cfg);
        await recordOp(from.id, actorName, "settings_changed", "notificationTarget", { value: cfg.notificationTarget });
        await show(chatId, null, screenNotificationsSettings(cfg));
        return true;
      }
      case "adm_em_target": {
        const target = Number(input);
        if (!Number.isSafeInteger(target)) {
          await repo.clearPending(chatId);
          await bot.sendMessage(chatId, "⚠️ معرّف غير صالح.");
          return true;
        }
        const emAction = String(ctx.emAction ?? "user");
        await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_em_confirm", context: { emAction, targetId: target } });
        const emLabels: Record<string, string> = { user: "تعطيل مستخدم من النظام", group: "تعطيل مجموعة من النظام", admin: "إيقاف مدير من النظام" };
        await show(chatId, null, screenConfirm(emAction, emLabels[emAction] ?? "إجراء طارئ", String(target)));
        return true;
      }
      default:
        return false;
    }
  }

  // Receives a document upload (admin restore flow). Returns true when handled.
  async function handleDocument(chatId: number, userId: number, document: { file_id: string; file_name?: string; file_size?: number }): Promise<boolean> {
    if (tenantMode || !isOwner(userId)) return false;
    const pending = await repo.getPending(chatId);
    if (!pending || pending.action !== "adm_em_restore") return false;
    const name = document.file_name ?? "backup.json";
    if (document.file_size && document.file_size > 20 * 1024 * 1024) {
      await repo.clearPending(chatId);
      await bot.sendMessage(chatId, "⚠️ الملف أكبر من 20MB.");
      return true;
    }
    try {
      const file = await bot.getFile(document.file_id);
      if (!file.file_path) throw new Error("no file_path");
      const content = await bot.downloadFile(file.file_path);
      const parsed = JSON.parse(content) as { app?: string; tables?: Record<string, unknown> };
      if (parsed.app !== "pre-crime" || !parsed.tables || typeof parsed.tables !== "object") {
        await repo.clearPending(chatId);
        await bot.sendMessage(chatId, "⚠️ هذا الملف ليس نسخة احتياطية صالحة لـ Pre Crime.");
        return true;
      }
      const tableCount = Object.keys(parsed.tables).length;
      await repo.setPending({ chat_id: chatId, group_id: 0, action: "adm_em_restore_confirm", context: { fileId: document.file_id, fileName: name } });
      await show(chatId, null, screenConfirm("restore", `استعادة نسخة احتياطية من ملف (${tableCount} جدولًا)`, name));
    } catch {
      await repo.clearPending(chatId);
      await bot.sendMessage(chatId, "⚠️ تعذّر قراءة الملف. تأكد أنه ملف JSON ناتج عن نسخة احتياطية سابقة.");
    }
    return true;
  }

  return {
    isAdmin,
    isOwner,
    hasPermission,
    track,
    gate,
    acceptingActivations,
    notifyOwners,
    getConfig: () => store.getConfig(),
    handleCommand,
    handleCallback,
    handlePending,
    handleDocument,
  };
}

export type AdminPanel = ReturnType<typeof createAdminPanel>;
