// Pre-Crime super-admin panel — every screen (text + inline keyboard) the
// panel renders. Pure builders: no I/O, fully unit-testable.

import type { InlineKeyboardButton } from "../types";
import type { AuditRow } from "../types";
import {
  ADMIN_PERMISSIONS,
  ENGINE_LABELS,
  PERMISSION_LABELS,
  PAGE_SIZE,
  ac,
  broadcastAudienceLabel,
  esc,
  fmtAgo,
  fmtDate,
  licenseStatusLabel,
  paginate,
  pagerRow,
  trunc,
  userLabel,
  type BotAdminRow,
  type BotUserRow,
  type BroadcastRow,
  type LicenseRow,
  type Screen,
  type SystemConfig,
} from "./core";

type GroupItem = { chat_id: number; title: string; username: string | null; status: string; added_at: string; owner_user_id: number | null };

const back = (to: string, ...args: (string | number)[]): InlineKeyboardButton => ({ text: "↩️ رجوع", callback_data: ac(to, ...args) });
const refresh = (to: string, ...args: (string | number)[]): InlineKeyboardButton => ({ text: "🔄 تحديث", callback_data: ac(to, ...args) });
const btn = (text: string, key: string, ...args: (string | number)[]): InlineKeyboardButton => ({ text, callback_data: ac(key, ...args) });

// ============ 1. الرئيسية / الإحصائيات العامة ============

export interface OverviewStats {
  users: number;
  groups: number;
  activeGroups: number;
  pausedGroups: number;
  leftGroups: number;
  admins: number;
  activeLicenses: number;
  activity24h: number;
}

export function screenHome(stats: OverviewStats, recent: AuditRow[], actorName: string): Screen {
  const lines = recent.slice(0, 6).map((e) => `• ${esc(e.event_type)} — ${esc(e.target ?? "")} (${fmtAgo(e.created_at)})`);
  return {
    text: [
      "👑 لوحة أدمن Pre Crime",
      "━━━━━━━━━━━━━━━",
      `مرحبًا ${esc(actorName)}`,
      "",
      `👥 إجمالي المستخدمين: ${stats.users}`,
      `🛡️ إجمالي المجموعات: ${stats.groups}`,
      `🟢 النشطة: ${stats.activeGroups}  •  🔴 المعطلة: ${stats.pausedGroups}  •  🚪 غادرها: ${stats.leftGroups}`,
      `👑 عدد المديرين: ${stats.admins}`,
      `🔑 التراخيص النشطة: ${stats.activeLicenses}`,
      `📈 نشاط آخر 24 ساعة: ${stats.activity24h} عملية`,
      "",
      "🕒 آخر العمليات:",
      ...(lines.length ? lines : ["• لا توجد عمليات بعد"]),
    ].join("\n"),
    keyboard: [
      [btn("👥 المستخدمون", "users"), btn("🛡️ المجموعات", "groups")],
      [btn("👑 المديرون", "admins"), btn("🔑 التراخيص", "licenses")],
      [btn("📣 الإذاعة", "bcast"), btn("🛡️ الحماية العامة", "prot")],
      [btn("📊 الإحصائيات والتقارير", "analytics"), btn("📜 سجل العمليات", "logs")],
      [btn("⚙️ إعدادات النظام", "sys"), btn("🖥️ السيرفر", "infra")],
      [btn("🚨 أدوات الطوارئ", "emerg")],
      [refresh("home")],
    ],
  };
}

// ============ 2. إدارة المستخدمين ============

export function screenUsersMenu(): Screen {
  return {
    text: "👥 إدارة المستخدمين\n━━━━━━━━━━━━━━━\nاختر القسم المطلوب:",
    keyboard: [
      [btn("📋 جميع المستخدمين", "u_list", "all", 0)],
      [btn("🟢 المستخدمون النشطون", "u_list", "active", 0), btn("🚫 المحظورون", "u_list", "banned", 0)],
      [btn("🆕 المستخدمون الجدد", "u_list", "new", 0)],
      [btn("🔎 البحث عن مستخدم", "u_search")],
      [btn("📨 آخر النشاطات", "u_activity")],
      [btn("📊 إحصائيات المستخدمين", "u_stats")],
      [back("home")],
    ],
  };
}

const USER_FILTER_TITLES: Record<string, string> = {
  all: "جميع المستخدمين",
  active: "المستخدمون النشطون",
  banned: "المستخدمون المحظورون",
  new: "المستخدمون الجدد",
  search: "نتائج البحث",
};

export function screenUserList(users: BotUserRow[], filter: string, page: number): Screen {
  const p = paginate(users, page);
  const keyboard: InlineKeyboardButton[][] = p.items.map((u) => [
    { text: `${u.status === "active" ? "🟢" : "🔴"} ${userLabel(u)}`, callback_data: ac("u_view", u.telegram_user_id) },
  ]);
  if (p.pages > 1) keyboard.push(pagerRow("u_page", p.page, p.pages, filter));
  keyboard.push([btn("🔎 بحث", "u_search")], [back("users")]);
  return {
    text: `👥 ${USER_FILTER_TITLES[filter] ?? "المستخدمون"} (${p.total})\n━━━━━━━━━━━━━━━\nاختر مستخدمًا لعرض ملفه:`,
    keyboard,
  };
}

export interface UserDetailData {
  user: BotUserRow;
  ownedGroups: number;
  botGroups: number;
  messageCount: number;
  opsCount: number;
}

export function screenUserDetail(d: UserDetailData): Screen {
  const u = d.user;
  const statusLabel = u.status === "active" ? "🟢 نشط" : u.status === "banned" ? "🚫 محظور" : "⛔ معطل";
  return {
    text: [
      "👤 ملف المستخدم",
      "━━━━━━━━━━━━━━━",
      `الاسم: ${esc(u.display_name || "—")}`,
      `Username: ${u.username ? "@" + esc(u.username) : "—"}`,
      `Telegram ID: ${u.telegram_user_id}`,
      `أول تسجيل: ${fmtDate(u.first_seen_at)}`,
      `آخر نشاط: ${fmtAgo(u.last_seen_at)}`,
      `الحالة: ${statusLabel}`,
      `مجموعات يمتلكها: ${d.ownedGroups}`,
      `مجموعات أضاف البوت إليها: ${d.botGroups}`,
      `عدد الرسائل المسجلة: ${d.messageCount}`,
      `عمليات مسجلة عليه: ${d.opsCount}`,
      u.note ? `📝 ملاحظة إدارية: ${esc(u.note)}` : "",
    ].filter(Boolean).join("\n"),
    keyboard: [
      [btn("🛡️ مجموعاته", "u_groups", u.telegram_user_id)],
      [btn("📊 إحصائياته", "u_gstats", u.telegram_user_id), btn("📜 سجل نشاطه", "u_log", u.telegram_user_id, 0)],
      [btn("💬 إرسال رسالة خاصة", "u_pm", u.telegram_user_id)],
      u.status === "active"
        ? [btn("🚫 حظر المستخدم", "u_ban", u.telegram_user_id)]
        : [btn("🔓 فك الحظر", "u_unban", u.telegram_user_id)],
      [btn("📝 إضافة ملاحظة إدارية", "u_note", u.telegram_user_id)],
      [refresh("u_view", u.telegram_user_id), back("u_list", "all", 0)],
    ],
  };
}

export function screenUserGroups(user: BotUserRow, groups: GroupItem[]): Screen {
  const keyboard: InlineKeyboardButton[][] = groups.slice(0, 10).map((g) => [
    { text: `🛡️ ${trunc(g.title, 24)}`, callback_data: ac("g_view", g.chat_id) },
  ]);
  keyboard.push([back("u_view", user.telegram_user_id)]);
  return {
    text: `🛡️ مجموعات ${esc(userLabel(user))} (${groups.length})\n━━━━━━━━━━━━━━━\n${groups.length ? "المجموعات التي يمتلكها أو يتواجد بها:" : "لا توجد مجموعات مسجلة."}`,
    keyboard,
  };
}

// ============ 3. إدارة المجموعات ============

export function screenGroupsMenu(): Screen {
  return {
    text: "🛡️ إدارة المجموعات\n━━━━━━━━━━━━━━━\nاختر القسم المطلوب:",
    keyboard: [
      [btn("📋 جميع المجموعات", "g_list", "all", 0)],
      [btn("🟢 النشطة", "g_list", "active", 0), btn("🔴 المعطلة", "g_list", "paused", 0)],
      [btn("🚪 غادرها البوت", "g_list", "left", 0), btn("🆕 الجديدة", "g_list", "new", 0)],
      [btn("🔥 الأكثر نشاطًا", "g_list", "top", 0), btn("⚠️ بها مشاكل", "g_list", "problems", 0)],
      [btn("🔎 بحث بالاسم أو Group ID", "g_search")],
      [back("home")],
    ],
  };
}

const GROUP_FILTER_TITLES: Record<string, string> = {
  all: "جميع المجموعات",
  active: "المجموعات النشطة",
  paused: "المجموعات المعطلة",
  left: "المجموعات التي غادرها البوت",
  new: "المجموعات الجديدة",
  top: "المجموعات الأكثر نشاطًا",
  problems: "المجموعات التي بها مشاكل",
  search: "نتائج البحث",
};

export function screenGroupList(groups: GroupItem[], filter: string, page: number): Screen {
  const p = paginate(groups, page);
  const icon = (s: string) => (s === "active" ? "🟢" : s === "paused" ? "🔴" : "🚪");
  const keyboard: InlineKeyboardButton[][] = p.items.map((g) => [
    { text: `${icon(g.status)} ${trunc(g.title, 24)}`, callback_data: ac("g_view", g.chat_id) },
  ]);
  if (p.pages > 1) keyboard.push(pagerRow("g_page", p.page, p.pages, filter));
  keyboard.push([btn("🔎 بحث", "g_search")], [back("groups")]);
  return {
    text: `🛡️ ${GROUP_FILTER_TITLES[filter] ?? "المجموعات"} (${p.total})\n━━━━━━━━━━━━━━━\nاختر مجموعة لعرض بياناتها:`,
    keyboard,
  };
}

export interface GroupDetailData {
  group: GroupItem;
  ownerName: string | null;
  memberCount: number;
  messageCount: number;
  violationCount: number;
  botStatus: string;
}

export function screenGroupDetail(d: GroupDetailData): Screen {
  const g = d.group;
  const statusLabel = g.status === "active" ? "🟢 نشطة" : g.status === "paused" ? "🔴 معطلة" : "🚪 غادرها البوت";
  return {
    text: [
      "🛡️ بيانات المجموعة",
      "━━━━━━━━━━━━━━━",
      `الاسم: ${esc(g.title)}`,
      `Group ID: ${g.chat_id}`,
      `Username: ${g.username ? "@" + esc(g.username) : "—"}`,
      `المالك: ${d.ownerName ? esc(d.ownerName) : g.owner_user_id ?? "—"}`,
      `تاريخ إضافة البوت: ${fmtDate(g.added_at)}`,
      `حالة المجموعة: ${statusLabel}`,
      `حالة البوت داخلها: ${d.botStatus}`,
      `عدد الأعضاء: ${d.memberCount}`,
      `عدد الرسائل: ${d.messageCount}`,
      `عدد المخالفات: ${d.violationCount}`,
    ].join("\n"),
    keyboard: [
      [btn("👑 عرض صاحب المجموعة", "g_owner", g.chat_id), btn("👥 عرض الأعضاء", "g_members", g.chat_id, 0)],
      [btn("📊 الإحصائيات", "g_stats", g.chat_id), btn("📜 سجل العمليات", "g_log", g.chat_id, 0)],
      [btn("⚙️ إعدادات الحماية", "g_prot", g.chat_id)],
      [btn("💬 إرسال رسالة للمجموعة", "g_msg", g.chat_id)],
      g.status === "active"
        ? [btn("🔴 تعطيل المجموعة", "g_disable", g.chat_id)]
        : [btn("🟢 إعادة تفعيل المجموعة", "g_enable", g.chat_id)],
      [btn("🗑️ حذف بيانات المجموعة", "g_del", g.chat_id)],
      [refresh("g_view", g.chat_id), back("g_list", "all", 0)],
    ],
  };
}

export function screenGroupMembers(gid: number, members: Array<{ telegram_user_id: number; display_name: string; username: string | null; status: string; message_count: number }>, page: number): Screen {
  const p = paginate(members, page);
  const keyboard: InlineKeyboardButton[][] = p.items.map((m) => [
    { text: `${m.status === "banned" ? "🚫" : "👤"} ${trunc(m.display_name || String(m.telegram_user_id), 20)} (${m.message_count})`, callback_data: ac("u_view", m.telegram_user_id) },
  ]);
  if (p.pages > 1) keyboard.push(pagerRow("g_mpage", p.page, p.pages, gid));
  keyboard.push([back("g_view", gid)]);
  return { text: `👥 أعضاء المجموعة (${p.total})\n━━━━━━━━━━━━━━━\nالاسم (عدد الرسائل):`, keyboard };
}

// ============ 4. إدارة المديرين ============

export function screenAdminsMenu(counts: { all: number; active: number; suspended: number }): Screen {
  return {
    text: [
      "👑 إدارة مديري البوت",
      "━━━━━━━━━━━━━━━",
      `الإجمالي: ${counts.all} • النشطون: ${counts.active} • الموقوفون: ${counts.suspended}`,
    ].join("\n"),
    keyboard: [
      [btn("📋 جميع المديرين", "a_list", "all", 0)],
      [btn("🟢 النشطون", "a_list", "active", 0), btn("⛔ الموقوفون", "a_list", "suspended", 0)],
      [btn("➕ إضافة مدير جديد", "a_add")],
      [btn("📜 سجل إجراءات المديرين", "a_ops", 0)],
      [back("home")],
    ],
  };
}

export function screenAdminList(admins: BotAdminRow[], filter: string, page: number, ownerIds: number[]): Screen {
  const p = paginate(admins, page);
  const keyboard: InlineKeyboardButton[][] = p.items.map((a) => [
    { text: `${a.status === "active" ? "🟢" : "⛔"} ${trunc(a.display_name, 22)}`, callback_data: ac("a_view", a.telegram_user_id) },
  ]);
  if (p.pages > 1) keyboard.push(pagerRow("a_page", p.page, p.pages, filter));
  keyboard.push([btn("➕ إضافة مدير", "a_add")], [back("admins")]);
  const owners = ownerIds.map((id) => `• ${id} (مالك)`).join("\n");
  return {
    text: `👑 مديرو البوت (${p.total})\n━━━━━━━━━━━━━━━\nالمالكون الثابتون:\n${owners}\n\nالمديرون المعينون:`,
    keyboard,
  };
}

export function screenAdminDetail(a: BotAdminRow, isOwner: boolean): Screen {
  const permLines = ADMIN_PERMISSIONS.map((p) => `${a.permissions.includes(p) ? "✅" : "⛔"} ${PERMISSION_LABELS[p]}`);
  const keyboard: InlineKeyboardButton[][] = [];
  if (!isOwner) {
    for (let i = 0; i < ADMIN_PERMISSIONS.length; i += 2) {
      const row: InlineKeyboardButton[] = [];
      for (const p of ADMIN_PERMISSIONS.slice(i, i + 2)) {
        row.push({ text: `${a.permissions.includes(p) ? "✅" : "☐"} ${PERMISSION_LABELS[p]}`, callback_data: ac("a_perm", a.telegram_user_id, p) });
      }
      keyboard.push(row);
    }
    keyboard.push(
      a.status === "active"
        ? [btn("⛔ إيقاف المدير", "a_suspend", a.telegram_user_id)]
        : [btn("🟢 إعادة تفعيل المدير", "a_resume", a.telegram_user_id)],
      [btn("🗑️ إزالة المدير", "a_del", a.telegram_user_id)],
    );
  }
  keyboard.push([refresh("a_view", a.telegram_user_id), back("a_list", "all", 0)]);
  return {
    text: [
      `👑 ملف المدير ${isOwner ? "(مالك)" : ""}`,
      "━━━━━━━━━━━━━━━",
      `الاسم: ${esc(a.display_name || "—")}`,
      `ID: ${a.telegram_user_id}`,
      `تاريخ التعيين: ${fmtDate(a.created_at)}`,
      `الحالة: ${a.status === "active" ? "🟢 نشط" : "⛔ موقوف"}`,
      `آخر نشاط: ${fmtAgo(a.last_active_at)}`,
      `عدد العمليات المنفذة: ${a.ops_count}`,
      "",
      "الصلاحيات:",
      ...(isOwner ? ["✅ كل الصلاحيات (مالك — صلاحيات نهائية)"] : permLines),
    ].join("\n"),
    keyboard,
  };
}

// ============ 5. التراخيص والاشتراكات ============

export function screenLicensesMenu(counts: Record<string, number>): Screen {
  return {
    text: [
      "🔑 إدارة التراخيص والاشتراكات",
      "━━━━━━━━━━━━━━━",
      `الإجمالي: ${counts.all ?? 0} • نشطة: ${counts.active ?? 0} • منتهية: ${counts.expired ?? 0} • موقوفة: ${counts.suspended ?? 0} • غير مستخدمة: ${counts.unused ?? 0}`,
    ].join("\n"),
    keyboard: [
      [btn("📋 جميع التراخيص", "l_list", "all", 0)],
      [btn("✅ النشطة", "l_list", "active", 0), btn("⌛ المنتهية", "l_list", "expired", 0)],
      [btn("⛔ الموقوفة", "l_list", "suspended", 0)],
      [btn("📦 المستخدمة", "l_list", "used", 0), btn("🆕 غير المستخدمة", "l_list", "unused", 0)],
      [btn("➕ إنشاء كود تفعيل", "l_new")],
      [btn("🔎 البحث عن كود", "l_search")],
      [btn("📜 سجل عمليات التفعيل", "l_log", 0)],
      [back("home")],
    ],
  };
}

export function screenLicenseList(licenses: LicenseRow[], filter: string, page: number): Screen {
  const p = paginate(licenses, page);
  const icon = (s: LicenseRow["status"]) => (s === "active" ? "✅" : s === "unused" ? "🆕" : s === "expired" ? "⌛" : "⛔");
  const keyboard: InlineKeyboardButton[][] = p.items.map((l) => [
    { text: `${icon(l.status)} ${l.code}`, callback_data: ac("l_view", l.id) },
  ]);
  if (p.pages > 1) keyboard.push(pagerRow("l_page", p.page, p.pages, filter));
  keyboard.push([btn("➕ إنشاء كود", "l_new")], [back("licenses")]);
  return { text: `🔑 التراخيص (${p.total})\n━━━━━━━━━━━━━━━\nاختر ترخيصًا لعرض تفاصيله:`, keyboard };
}

export function screenLicenseNew(kind: string, days: number): Screen {
  const kinds = [["group", "مجموعة"], ["user", "مستخدم"], ["premium", "بريميوم"]];
  const dayOpts = [7, 30, 90, 365];
  return {
    text: [
      "➕ إنشاء كود تفعيل جديد",
      "━━━━━━━━━━━━━━━",
      `نوع الاشتراك: ${kinds.find(([k]) => k === kind)?.[1] ?? kind}`,
      `المدة: ${days} يوم`,
      "",
      "اختر النوع والمدة ثم اضغط «توليد الكود»:",
    ].join("\n"),
    keyboard: [
      kinds.map(([k, label]) => ({ text: `${k === kind ? "✅" : "☐"} ${label}`, callback_data: ac("l_cfg", k, days) })),
      dayOpts.map((d) => ({ text: `${d === days ? "✅" : ""}${d} يوم`, callback_data: ac("l_cfg", kind, d) })),
      [btn("⚡ توليد الكود", "l_gen", kind, days)],
      [back("licenses")],
    ],
  };
}

export function screenLicenseDetail(l: LicenseRow, linkedName: string | null): Screen {
  return {
    text: [
      "🔑 تفاصيل الترخيص",
      "━━━━━━━━━━━━━━━",
      `الكود: ${l.code}`,
      `النوع: ${l.kind}`,
      `المدة: ${l.duration_days} يوم`,
      `تاريخ الإنشاء: ${fmtDate(l.created_at)}`,
      `تاريخ التفعيل: ${fmtDate(l.activated_at)}`,
      `تاريخ الانتهاء: ${fmtDate(l.expires_at)}`,
      `الحالة: ${licenseStatusLabel(l.status)}`,
      `مرتبط بـ: ${linkedName ? esc(linkedName) : l.linked_group_id ?? l.linked_user_id ?? "—"}`,
    ].join("\n"),
    keyboard: [
      [btn("🔗 ربط بمجموعة", "l_linkg", l.id), btn("🔗 ربط بمستخدم", "l_linku", l.id)],
      [btn("♻️ تجديد الترخيص", "l_renew", l.id)],
      l.status === "suspended"
        ? [btn("▶️ رفع الإيقاف", "l_status", l.id, "active")]
        : [btn("⏸️ إيقاف الترخيص", "l_status", l.id, "suspended")],
      [btn("🚫 إلغاء الترخيص", "l_status", l.id, "cancelled")],
      [refresh("l_view", l.id), back("l_list", "all", 0)],
    ],
  };
}

// ============ 6. الإذاعة والرسائل ============

export function screenBroadcastMenu(): Screen {
  return {
    text: "📣 الإذاعة والرسائل\n━━━━━━━━━━━━━━━\nاختر الجمهور المستهدف للرسالة:",
    keyboard: [
      [btn("👥 جميع المستخدمين", "bc_start", "all_users")],
      [btn("🎯 مستخدمون محددون", "bc_start", "selected_users")],
      [btn("🛡️ جميع المجموعات", "bc_start", "all_groups")],
      [btn("🟢 المجموعات النشطة فقط", "bc_start", "active_groups")],
      [btn("👑 المديرون", "bc_start", "admins")],
      [btn("🔔 إشعار إداري", "bc_start", "notice")],
      [btn("📜 سجل الإذاعات", "bc_log", 0), btn("📊 إحصائيات الإرسال", "bc_stats")],
      [btn("⏹️ إيقاف إذاعة جارية", "bc_stop")],
      [back("home")],
    ],
  };
}

export function screenBroadcastPreview(audience: string, text: string, recipients: number): Screen {
  return {
    text: [
      "📣 معاينة الإذاعة قبل الإرسال",
      "━━━━━━━━━━━━━━━",
      `الجمهور: ${broadcastAudienceLabel(audience)}`,
      `عدد المستلمين التقريبي: ${recipients}`,
      "",
      "نص الرسالة:",
      esc(trunc(text, 500)),
      "",
      "⚠️ اضغط «تأكيد الإرسال» لبدء الإذاعة فورًا.",
    ].join("\n"),
    keyboard: [
      [btn("✅ تأكيد الإرسال", "bc_confirm")],
      [btn("✏️ تعديل النص", "bc_edit")],
      [btn("❌ إلغاء", "bcast")],
    ],
  };
}

export function screenBroadcastLog(list: BroadcastRow[], page: number): Screen {
  const p = paginate(list, page, 10);
  const lines = p.items.map((b) =>
    `• #${b.id} — ${broadcastAudienceLabel(b.audience)}\n  الحالة: ${b.status} • نجح: ${b.sent} • فشل: ${b.failed} • ${fmtAgo(b.created_at)}`);
  const keyboard: InlineKeyboardButton[][] = [];
  if (p.pages > 1) keyboard.push(pagerRow("bc_page", p.page, p.pages));
  keyboard.push([back("bcast")]);
  return {
    text: `📜 سجل الإذاعات (${p.total})\n━━━━━━━━━━━━━━━\n${lines.length ? lines.join("\n") : "لا توجد إذاعات بعد."}`,
    keyboard,
  };
}

export function screenBroadcastStats(totals: { total: number; sent: number; failed: number; running: number }): Screen {
  return {
    text: [
      "📊 إحصائيات الإذاعة",
      "━━━━━━━━━━━━━━━",
      `إجمالي الإذاعات: ${totals.total}`,
      `رسائل ناجحة: ${totals.sent}`,
      `رسائل فاشلة: ${totals.failed}`,
      `إذاعات جارية الآن: ${totals.running}`,
      totals.sent + totals.failed > 0 ? `نسبة النجاح: ${Math.round((totals.sent / (totals.sent + totals.failed)) * 100)}%` : "",
    ].filter(Boolean).join("\n"),
    keyboard: [[refresh("bc_stats")], [back("bcast")]],
  };
}

// ============ 7. إدارة الحماية العامة ============

export function screenProtectionMenu(cfg: SystemConfig, violations24h: number): Screen {
  const engines = Object.entries(cfg.protection.engines) as Array<[keyof typeof ENGINE_LABELS, boolean]>;
  const keyboard: InlineKeyboardButton[][] = engines.map(([key, on]) => [
    { text: `${on ? "✅" : "⛔"} ${ENGINE_LABELS[key]}`, callback_data: ac("pe_tgl", key) },
  ]);
  keyboard.push(
    [btn("🚫 الكلمات المحظورة الافتراضية", "pe_words")],
    [btn("🔗 النطاقات المحظورة", "pe_domains")],
    [btn("📊 إحصائيات المخالفات", "pe_stats"), btn("⚠️ آخر الهجمات", "pe_attacks", 0)],
    [back("home")],
  );
  return {
    text: [
      "🛡️ إدارة الحماية العامة",
      "━━━━━━━━━━━━━━━",
      `مخالفات آخر 24 ساعة: ${violations24h}`,
      "",
      "حالة محركات الحماية (اضغط للتبديل):",
      ...engines.map(([key, on]) => `${on ? "✅" : "⛔"} ${ENGINE_LABELS[key]}`),
      "",
      `إعدادات Anti-Spam: حد ${cfg.protection.antiSpamThreshold} رسائل / ${cfg.protection.antiSpamWindowSeconds} ث`,
      `إعدادات Anti-Flood: حد ${cfg.protection.antiFloodMaxMessages} رسائل / ${cfg.protection.antiFloodWindowSeconds} ث`,
      "",
      "ملاحظة: التغييرات العامة لا تلغي إعدادات المجموعات الخاصة، بل تضيف قواعد افتراضية فوقها.",
    ].join("\n"),
    keyboard,
  };
}

export function screenWordList(words: string[]): Screen {
  return {
    text: `🚫 الكلمات المحظورة الافتراضية (${words.length})\n━━━━━━━━━━━━━━━\n${words.length ? words.map((w) => `• ${esc(w)}`).join("\n") : "القائمة فارغة."}`,
    keyboard: [
      [btn("➕ إضافة كلمات", "pe_words_add")],
      [btn("🧹 مسح الكل", "pe_words_clear")],
      [back("prot")],
    ],
  };
}

export function screenDomainList(domains: string[]): Screen {
  return {
    text: `🔗 نطاقات الروابط المحظورة (${domains.length})\n━━━━━━━━━━━━━━━\n${domains.length ? domains.map((d) => `• ${esc(d)}`).join("\n") : "القائمة فارغة."}`,
    keyboard: [
      [btn("➕ إضافة نطاق", "pe_dom_add")],
      [btn("🧹 مسح الكل", "pe_dom_clear")],
      [back("prot")],
    ],
  };
}

// ============ 8. الإحصائيات والتقارير ============

export function screenAnalyticsMenu(): Screen {
  return {
    text: "📊 الإحصائيات والتقارير\n━━━━━━━━━━━━━━━\nاختر التقرير المطلوب:",
    keyboard: [
      [btn("👥 إحصائيات المستخدمين", "an_users"), btn("🛡️ إحصائيات المجموعات", "an_groups")],
      [btn("🔑 إحصائيات التفعيلات", "an_licenses"), btn("🛡️ إحصائيات الحماية", "an_prot")],
      [btn("💬 إحصائيات الرسائل", "an_msgs"), btn("👑 إحصائيات المديرين", "an_admins")],
      [btn("📣 إحصائيات الإذاعة", "bc_stats")],
      [btn("📅 التقرير اليومي", "an_report", "daily")],
      [btn("🗓️ التقرير الأسبوعي", "an_report", "weekly"), btn("📆 التقرير الشهري", "an_report", "monthly")],
      [back("home")],
    ],
  };
}

export function screenReport(title: string, lines: string[], backTo: string): Screen {
  return {
    text: `📊 ${title}\n━━━━━━━━━━━━━━━\n${lines.join("\n")}`,
    keyboard: [[refresh(backTo)], [back("analytics")]],
  };
}

// ============ 9. سجل العمليات ============

export const AUDIT_FILTERS: Array<[string, string]> = [
  ["all", "📋 جميع العمليات"],
  ["owner", "👑 عمليات صاحب البوت"],
  ["admins", "👮 عمليات المديرين"],
  ["users", "👥 عمليات المستخدمين"],
  ["ban", "🚫 الحظر وفك الحظر"],
  ["settings_changed", "⚙️ تغييرات الإعدادات"],
  ["license", "🔑 عمليات التراخيص"],
  ["broadcast", "📣 عمليات الإذاعة"],
  ["violation", "⚠️ المخالفات"],
  ["sensitive", "🔐 العمليات الحساسة"],
];

export function screenLogsMenu(): Screen {
  const keyboard: InlineKeyboardButton[][] = [];
  for (let i = 0; i < AUDIT_FILTERS.length; i += 2) {
    keyboard.push(AUDIT_FILTERS.slice(i, i + 2).map(([k, label]) => btn(label, "log_list", k, 0)));
  }
  keyboard.push([back("home")]);
  return { text: "📜 سجل العمليات (Audit Logs)\n━━━━━━━━━━━━━━━\nكل عملية إدارية مسجلة هنا. اختر التصنيف:", keyboard };
}

export function screenLogList(events: AuditRow[], filter: string, page: number): Screen {
  const p = paginate(events, page, 10);
  const title = AUDIT_FILTERS.find(([k]) => k === filter)?.[1] ?? "العمليات";
  const keyboard: InlineKeyboardButton[][] = p.items.map((e) => [
    { text: `${esc(e.event_type)} • ${trunc(esc(e.target ?? "—"), 16)} • ${fmtAgo(e.created_at)}`, callback_data: ac("log_view", e.id, filter, page) },
  ]);
  if (p.pages > 1) keyboard.push(pagerRow("log_page", p.page, p.pages, filter));
  keyboard.push([back("logs")]);
  return {
    text: `📜 ${title} (${p.total})\n━━━━━━━━━━━━━━━\n${p.items.length ? "اختر عملية لعرض تفاصيلها:" : "لا توجد عمليات مسجلة."}`,
    keyboard,
  };
}

export function screenLogDetail(e: AuditRow, filter: string, page: number): Screen {
  let detailsPretty = e.details;
  try { detailsPretty = JSON.stringify(JSON.parse(e.details), null, 2); } catch { /* keep raw */ }
  return {
    text: [
      `📜 تفاصيل العملية #${e.id}`,
      "━━━━━━━━━━━━━━━",
      `المنفذ: ${e.actor_name ? esc(e.actor_name) : e.actor_telegram_user_id ?? "النظام"}`,
      `العملية: ${esc(e.event_type)}`,
      `الهدف: ${e.target ? esc(e.target) : "—"}`,
      `المجموعة: ${e.chat_id ?? "—"}`,
      `الوقت: ${fmtDate(e.created_at)}`,
      "",
      "التفاصيل:",
      trunc(detailsPretty, 800),
    ].join("\n"),
    keyboard: [[back("log_list", filter, page)]],
  };
}

// ============ 10. إعدادات النظام ============

export function screenSystemMenu(cfg: SystemConfig): Screen {
  return {
    text: [
      "⚙️ إعدادات النظام",
      "━━━━━━━━━━━━━━━",
      `اسم البوت: ${esc(cfg.botName)}`,
      `اللغة الافتراضية: ${cfg.language === "ar" ? "العربية" : "English"}`,
      `وضع الصيانة: ${cfg.maintenanceMode ? "🔴 مفعّل" : "🟢 معطل"}`,
      `استقبال التفعيلات: ${cfg.acceptActivations ? "🟢 مفتوح" : "🔴 موقوف"}`,
      `الإذاعة: ${cfg.broadcastStopped ? "🔴 موقوفة" : "🟢 تعمل"}`,
    ].join("\n"),
    keyboard: [
      [btn("✏️ اسم البوت", "sys_name"), btn("💬 رسالة /start", "sys_startmsg")],
      [btn("🌐 تبديل اللغة", "sys_lang")],
      [btn("🔔 إعدادات الإشعارات", "sys_notif")],
      [btn("🔐 الأمان ومحاولات الدخول", "sys_security", 0)],
      [btn("🤖 إعدادات تيليجرام", "sys_tg")],
      [btn("🗄️ قاعدة البيانات", "sys_db")],
      [btn("🔄 إعادة تحميل الإعدادات", "sys_reload")],
      [back("home")],
    ],
  };
}

export function screenNotificationsSettings(cfg: SystemConfig): Screen {
  const items: Array<[keyof SystemConfig, string]> = [
    ["notifyGroupAdded", "إشعار عند إضافة مجموعة"],
    ["notifyGroupRemoved", "إشعار عند حذف مجموعة"],
    ["notifyUserBanned", "إشعار عند حظر مستخدم"],
    ["notifyBotDown", "إشعار عند توقف البوت"],
    ["notifyErrors", "إشعارات الأخطاء"],
  ];
  const keyboard: InlineKeyboardButton[][] = items.map(([key, label]) => [
    { text: `${cfg[key] ? "✅" : "⛔"} ${label}`, callback_data: ac("sys_notif_tgl", key) },
  ]);
  keyboard.push([btn("🎯 جهة استقبال الإشعارات", "sys_notif_target")], [back("sys")]);
  return {
    text: `🔔 إعدادات الإشعارات\n━━━━━━━━━━━━━━━\nجهة الاستقبال الحالية: ${cfg.notificationTarget ?? "المالكون"}\n\nاضغط لتبديل أي إشعار:`,
    keyboard,
  };
}

// ============ 11. السيرفر والنظام ============

export interface InfraData {
  uptimeSeconds: number;
  memoryMb: number;
  dbOk: boolean;
  tableCounts: Array<{ table: string; count: number }>;
  webhook: { ok: boolean; url: string; pending: number; lastError: string | null };
  failedUpdates: number;
  nodeVersion: string;
}

export function screenInfra(d: InfraData): Screen {
  const hours = Math.floor(d.uptimeSeconds / 3600);
  const mins = Math.floor((d.uptimeSeconds % 3600) / 60);
  return {
    text: [
      "🖥️ حالة السيرفر والنظام",
      "━━━━━━━━━━━━━━━",
      `الحالة: 🟢 يعمل (Node ${d.nodeVersion})`,
      `وقت التشغيل: ${hours} ساعة و ${mins} دقيقة`,
      `استهلاك الذاكرة: ${d.memoryMb} MB`,
      `قاعدة البيانات: ${d.dbOk ? "🟢 متصلة" : "🔴 خطأ"}`,
      `Webhook: ${d.webhook.ok ? "🟢" : "🔴"} ${d.webhook.url || "غير مسجل"}`,
      `تحديثات معلقة: ${d.webhook.pending}`,
      d.webhook.lastError ? `آخر خطأ Webhook: ${esc(trunc(d.webhook.lastError, 120))}` : "",
      `تحديثات فاشلة: ${d.failedUpdates}`,
      "",
      "عدد السجلات:",
      ...d.tableCounts.map((t) => `• ${t.table}: ${t.count}`),
    ].filter(Boolean).join("\n"),
    keyboard: [
      [btn("🔍 فحص الخدمات", "infra_check")],
      [refresh("infra"), back("home")],
    ],
  };
}

// ============ 12. أدوات الطوارئ ============

export function screenEmergency(cfg: SystemConfig): Screen {
  return {
    text: [
      "🚨 أدوات الطوارئ",
      "━━━━━━━━━━━━━━━",
      "⚠️ كل إجراء هنا خطير ويتطلب تأكيدًا مستقلًا ويتم تسجيله باسم منفذه.",
      "",
      `وضع الصيانة: ${cfg.maintenanceMode ? "🔴 مفعّل" : "🟢 معطل"}`,
      `استقبال التفعيلات: ${cfg.acceptActivations ? "🟢 مفتوح" : "🔴 موقوف"}`,
      `الإذاعة: ${cfg.broadcastStopped ? "🔴 موقوفة" : "🟢 تعمل"}`,
    ].join("\n"),
    keyboard: [
      [btn(cfg.maintenanceMode ? "🟢 إلغاء وضع الصيانة" : "🔴 تفعيل وضع الصيانة", "em_ask", "maintenance")],
      [btn(cfg.acceptActivations ? "⏹️ إيقاف التفعيلات الجديدة" : "▶️ فتح التفعيلات", "em_ask", "activations")],
      [btn(cfg.broadcastStopped ? "▶️ استئناف الإذاعة" : "⏹️ إيقاف الإذاعة", "em_ask", "broadcast")],
      [btn("👤 تعطيل مستخدم", "em_ask", "user")],
      [btn("🛡️ تعطيل مجموعة", "em_ask", "group")],
      [btn("⛔ إيقاف مدير", "em_ask", "admin")],
      [btn("🧯 إيقاف محرك حماية محدد", "em_ask", "engine")],
      [btn("🔍 فحص شامل للنظام", "em_ask", "check")],
      [btn("♻️ استعادة الإعدادات الافتراضية", "em_ask", "defaults")],
      [btn("🧰 إجراءات استرداد النظام", "em_ask", "recovery")],
      [back("home")],
    ],
  };
}

export function screenEmergencyEngines(cfg: SystemConfig): Screen {
  const engines = Object.entries(cfg.protection.engines) as Array<[keyof typeof ENGINE_LABELS, boolean]>;
  return {
    text: [
      "🧯 إيقاف محرك حماية محدد",
      "━━━━━━━━━━━━━━━",
      "اختر المحرك المراد تبديل حالته. كل تبديل يتطلب تأكيدًا ويتم تسجيله.",
      "",
      ...engines.map(([key, on]) => `${on ? "✅" : "⛔"} ${ENGINE_LABELS[key]}`),
    ].join("\n"),
    keyboard: [
      ...engines.map(([key, on]) => [
        btn(`${on ? "⏸️ إيقاف" : "▶️ تشغيل"} ${ENGINE_LABELS[key]}`, "em_ask", `engine:${String(key)}`),
      ]),
      [back("emerg")],
    ],
  };
}

export function screenRecovery(): Screen {
  return {
    text: [
      "🧰 إجراءات استرداد النظام",
      "━━━━━━━━━━━━━━━",
      "📥 النسخ الاحتياطي: تنزيل ملف JSON يحتوي كل بيانات النظام (المستخدمون، المديرون، المجموعات، التراخيص، الإذاعات، الإعدادات، السجلات).",
      "",
      "📤 الاستعادة: رفع ملف نسخة احتياطية سابقة لاستبدال البيانات الحالية بمحتواه. إجراء خطير يتطلب تأكيدًا.",
      "",
      "⚠️ الاستعادة تستبدل البيانات الحالية للجداول الموجودة في الملف.",
    ].join("\n"),
    keyboard: [
      [btn("📥 تنزيل نسخة احتياطية الآن", "em_ask", "backup")],
      [btn("📤 استعادة من ملف نسخة احتياطية", "em_ask", "restore")],
      [back("emerg")],
    ],
  };
}

export function screenConfirm(action: string, label: string, payload: string): Screen {
  return {
    text: [
      "⚠️ تأكيد إجراء خطير",
      "━━━━━━━━━━━━━━━",
      `أنت على وشك تنفيذ: ${label}`,
      payload ? `الهدف: ${esc(payload)}` : "",
      "",
      "سيتم تسجيل هذا الإجراء باسمك في سجل العمليات الحساسة.",
      "هل أنت متأكد؟",
    ].filter(Boolean).join("\n"),
    keyboard: [
      [btn("✅ نعم، تنفيذ", "em_do", action)],
      [btn("❌ إلغاء", "emerg")],
    ],
  };
}

export function screenDenied(): Screen {
  return {
    text: "⛔ غير مصرح\n━━━━━━━━━━━━━━━\nلا تملك الصلاحية المطلوبة لهذا الإجراء.\nتم تسجيل محاولة الوصول.",
    keyboard: [[back("home")]],
  };
}

export function screenInfo(title: string, body: string, backTo = "home", ...backArgs: (string | number)[]): Screen {
  return { text: `${title}\n━━━━━━━━━━━━━━━\n${body}`, keyboard: [[back(backTo, ...backArgs)]] };
}

export { PAGE_SIZE };
