import {
  BRAND,
  SECTION_TITLES,
  EM,
  FOOTER,
} from "./constants";
import { encodeCallback } from "./callbacks";
import {
  PROTECTION_TOGGLES,
  MEMBER_TOGGLES,
  NOTIFICATION_TOGGLES,
  PERMISSION_TOGGLES,
  toggleStateEmoji,
  toggleStateLabel,
} from "./toggles";
import { defaultSettings } from "./settings";
import type {
  AuditRow,
  GroupSettings,
  InlineKeyboardButton,
  MemberRow,
  ProtectionPolicy,
} from "./types";
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  type ActorRole,
  type PermissionChecks,
} from "./permissions";
import { memberLabel } from "./messages";

export interface Screen {
  text: string;
  keyboard: InlineKeyboardButton[][];
}

function back(section: string, gid?: number | null, label = `${EM.back} رجوع`): InlineKeyboardButton {
  return { text: label, callback_data: encodeCallback(section, gid) };
}

function groupBack(gid: number, label = `${EM.back} رجوع للوحة التحكم`): InlineKeyboardButton {
  return back("panel", gid, label);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleDateString("ar-EG", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleString("ar-EG", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ---------- Start ----------

export function screenHome(botUsername: string): Screen {
  return {
    text:
      `${BRAND}\n` +
      `حماية وإدارة المجموعات\n\n` +
      `متصل ✅\n\n` +
      `أهلاً بك في ${BRAND} 🛡️\n\n` +
      `منصتك المتكاملة لحماية مجموعتك وإدارة أعضائها ومراقبة النشاط بسهولة.\n\n` +
      `ماذا يمكنك أن تفعل؟\n` +
      `• حماية المجموعة من السبام والتخريب\n` +
      `• إدارة الأعضاء والمخالفات\n` +
      `• متابعة الإحصائيات والنشاط\n` +
      `• تخصيص إعدادات الحماية\n\n` +
      FOOTER,
    keyboard: [
      [{ text: "➕ إضافة البوت إلى مجموعتي", url: `https://t.me/${botUsername}?startgroup=true` }],
      [{ text: "📘 شرح طريقة الاستخدام", callback_data: encodeCallback("guide") }],
    ],
  };
}

export function screenGuide(username: string): Screen {
  return {
    text:
      `📘 طريقة تفعيل ${BRAND}\n\n` +
      `1) أضف البوت إلى مجموعتك.\n` +
      `2) ارفعه إلى مشرف من إعدادات المجموعة.\n` +
      `3) فعّل صلاحيات: حذف الرسائل، حظر وتقييد الأعضاء، دعوة المستخدمين.\n` +
      `4) بعد التفعيل ستصل رسالة «تمت إضافة البوت» تلقائيًا ومعها لوحة التحكم الكاملة.\n\n` +
      `من لوحة التحكم يمكنك:\n` +
      `• ضبط الحماية (السبام، الروابط، الكلمات).\n` +
      `• إدارة الأعضاء والتحذيرات والحظر.\n` +
      `• متابعة الإحصائيات والسجل.\n` +
      `• تخصيص الرسائل والتنبيهات والصلاحيات.\n\n` +
      FOOTER,
    keyboard: [
      [{ text: "➕ إضافة البوت إلى مجموعتي", url: `https://t.me/${username}?startgroup=true` }],
      [{ text: "↩️ رجوع", callback_data: encodeCallback("home") }],
    ],
  };
}

// ---------- Panel ----------

export function screenPanel(groupTitle: string, gid: number): Screen {
  return {
    text:
      `🛡️ ${BRAND}  •  مركز التحكم\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🏷️ ${groupTitle}\n` +
      `🟢 لوحة الإدارة جاهزة\n\n` +
      `اختر وحدة الإدارة التي تريد فتحها من الأقسام التالية:`,
    keyboard: [
      [
        { text: `👥 الأعضاء`, callback_data: encodeCallback("memberlist", gid) },
        { text: `🛡️ الحماية`, callback_data: encodeCallback("protection", gid) },
      ],
      [
        { text: `📊 الإحصائيات`, callback_data: encodeCallback("stats", gid) },
        { text: `💬 الرسائل`, callback_data: encodeCallback("messages", gid) },
      ],
      [
        { text: `🚫 المحظورون`, callback_data: encodeCallback("banned", gid) },
        { text: `⚙️ الإعدادات`, callback_data: encodeCallback("settings", gid) },
      ],
      [{ text: `❓ المساعدة`, callback_data: encodeCallback("help", gid) }],
    ],
  };
}

// ---------- Settings ----------

export function screenSettings(gid: number): Screen {
  return {
    text: `⚙️ ${SECTION_TITLES.settings}\n\nاختر القسم الذي تريد تخصيصه:`,
    keyboard: [
      [{ text: "🌐 الإعدادات العامة", callback_data: encodeCallback("general", gid) }],
      [{ text: "🛡️ إعدادات الحماية", callback_data: encodeCallback("protection", gid) }],
      [{ text: "👥 إعدادات الأعضاء", callback_data: encodeCallback("members", gid) }],
      [{ text: "💬 إعدادات الرسائل", callback_data: encodeCallback("messages", gid) }],
      [{ text: "🔔 التنبيهات والإشعارات", callback_data: encodeCallback("notifications", gid) }],
      [{ text: "👮 صلاحيات الإدارة", callback_data: encodeCallback("permissions", gid) }],
      [{ text: "📋 السجل وسجل الأحداث", callback_data: encodeCallback("logs", gid) }],
      [{ text: "♻️ إعادة ضبط الإعدادات", callback_data: encodeCallback("reset", gid) }],
      [groupBack(gid)],
    ],
  };
}

export function screenGeneral(settings: GroupSettings, botName: string, gid: number): Screen {
  return {
    text:
      `🌐 ${SECTION_TITLES.general}\n\n` +
      `اسم البوت: ${botName}\n` +
      `لغة الواجهة: العربية\n` +
      `المنطقة الزمنية: ${settings.general.timezone}\n\n` +
      `إعداد تغيير اللغة غير متاح بعد.`,
    keyboard: [[groupBack(gid)]],
  };
}
// ---------- Protection ----------

function toggleButton(defKey: string, gid: number, emoji: string, name: string, hint: string, state: string): InlineKeyboardButton {
  return {
    text: `${emoji} ${name}\n${hint}\n(${state})`,
    callback_data: encodeCallback("toggle", gid, [defKey]),
  };
}

export function screenProtection(settings: GroupSettings, gid: number): Screen {
  const rows: InlineKeyboardButton[][] = PROTECTION_TOGGLES.map((t) => [
    toggleButton(t.key, gid, toggleStateEmoji(settings, t.key), t.name, t.hint, toggleStateLabel(settings, t.key)),
  ]);
  rows.push([
    { text: "🔤 إدارة الكلمات المحظورة", callback_data: encodeCallback("words", gid) },
    { text: "🔗 القائمة البيضاء للروابط", callback_data: encodeCallback("whitelist", gid) },
  ]);
  rows.push([groupBack(gid)]);
  return {
    text: `🛡️ مركز الحماية\n━━━━━━━━━━━━━━━━━━\nكل نظام حماية مستقل ويمكن تشغيله أو إيقافه مباشرة من الزر الخاص به.\n\n🟢 يعمل النظام عند ظهور «مفعّل»\n⚪ متوقف عند ظهور «متوقف»`,
    keyboard: rows,
  };
}

export function screenWordFilter(settings: GroupSettings, gid: number): Screen {
  const words = settings.protection.wordFilter.words;
  const list = words.length ? words.map((w) => `• ${w}`).join("\n") : "لا توجد كلمات محظورة بعد.";
  return {
    text: `🔤 فلتر الكلمات\n\nالكلمات المحظورة حاليًا:\n${list}\n\nأضف كلمات مفصولة بفواصل عبر الزر بالأسفل:`,
    keyboard: [
      [{ text: "➕ إضافة كلمات", callback_data: encodeCallback("words_add", gid) }],
      [{ text: "🧹 مسح كل الكلمات", callback_data: encodeCallback("words_clear", gid) }],
      [back("protection", gid)],
    ],
  };
}

export function screenWhitelist(settings: GroupSettings, gid: number): Screen {
  const list = settings.protection.antiLinks.whitelist;
  const rendered = list.length ? list.map((d) => `• ${d}`).join("\n") : "لا توجد نطاقات مسموحة بعد.";
  return {
    text: `🔗 القائمة البيضاء للروابط\n\nالنطاقات المسموح بها رغم تفعيل منع الروابط:\n${rendered}\n\nأضف نطاقًا واحدًا (مثل example.com):`,
    keyboard: [
      [{ text: "➕ إضافة نطاق", callback_data: encodeCallback("whitelist_add", gid) }],
      [{ text: "🧹 مسح القائمة", callback_data: encodeCallback("whitelist_clear", gid) }],
      [back("protection", gid)],
    ],
  };
}

// ---------- Members ----------

export function screenMembersSettings(settings: GroupSettings, gid: number): Screen {
  const rows: InlineKeyboardButton[][] = MEMBER_TOGGLES.map((t) => [
    toggleButton(t.key, gid, toggleStateEmoji(settings, t.key), t.name, t.hint, toggleStateLabel(settings, t.key)),
  ]);
  rows.push([{ text: "👥 قائمة الأعضاء", callback_data: encodeCallback("memberlist", gid) }]);
  rows.push([groupBack(gid)]);
  return {
    text: `👥 ${SECTION_TITLES.members}\n\nالتحكم الكامل في الأعضاء داخل المجموعة:`,
    keyboard: rows,
  };
}

export function screenMemberList(members: MemberRow[], gid: number, note?: string): Screen {
  const rows: InlineKeyboardButton[][] = [];
  if (members.length === 0) {
    rows.push([{ text: "لا يوجد أعضاء مسجلون بعد", callback_data: encodeCallback("panel", gid) }]);
  } else {
    for (const m of members) {
      const label = `${memberLabel(m.display_name || null, m.username, m.telegram_user_id)}${m.status === "banned" ? " (محظور)" : ""}`;
      rows.push([{ text: label, callback_data: encodeCallback("member", gid, [m.telegram_user_id]) }]);
    }
  }
  rows.push([groupBack(gid)]);
  return {
    text:
      `👥 إدارة الأعضاء\n━━━━━━━━━━━━━━━━━━\n` +
      `📌 نتائج القائمة: ${members.length} عضو\n` +
      (note ? `ℹ️ ${note}\n` : "") +
      `\nاختر عضوًا لفتح ملفه ومراجعة نشاطه وإجراءاته:`,
    keyboard: rows,
  };
}

export function screenMemberDetail(
  member: MemberRow,
  gid: number,
  role: ActorRole,
  checks: PermissionChecks,
  pendingReason: boolean,
): Screen {
  const statusMap: Record<string, string> = {
    creator: "مالك المجموعة",
    administrator: "مشرف",
    member: "عضو",
    restricted: "مقيد / مكتوم",
    left: "غادر",
    kicked: "مطرود",
    banned: "محظور",
  };
  const rows: InlineKeyboardButton[][] = [];
  const name = memberLabel(member.display_name || null, member.username, member.telegram_user_id);

  if (checks.canMute) {
    if (member.status === "restricted") {
      rows.push([{ text: "🔊 إلغاء الكتم", callback_data: encodeCallback("act", gid, ["unmute", member.telegram_user_id]) }]);
    } else {
      rows.push([{ text: "🔇 كتم", callback_data: encodeCallback("act", gid, ["mute", member.telegram_user_id]) }]);
    }
  }

  if (member.status === "banned") {
    if (checks.canBan) rows.push([{ text: "✅ فك الحظر", callback_data: encodeCallback("act", gid, ["unban", member.telegram_user_id]) }]);
  } else {
    if (checks.canBan) {
      rows.push([{ text: "🚫 حظر", callback_data: encodeCallback("act", gid, ["ban", member.telegram_user_id]) }]);
      rows.push([{ text: "👢 طرد", callback_data: encodeCallback("act", gid, ["kick", member.telegram_user_id]) }]);
    }
    if (checks.canMute) rows.push([{ text: "⚠️ تحذير", callback_data: encodeCallback("act", gid, ["warn", member.telegram_user_id]) }]);
  }

  if (member.warning_count > 0 && checks.canMute) {
    rows.push([{ text: "🧹 إزالة التحذيرات", callback_data: encodeCallback("act", gid, ["unwarn", member.telegram_user_id]) }]);
  }
  rows.push([back("memberlist", gid)]);
  rows.push([groupBack(gid)]);

  return {
    text:
      `👤 ${SECTION_TITLES.memberDetail}\n\n` +
      `الاسم: ${name}\n` +
      `المعرف: ${member.username ? "@" + member.username : "—"}\n` +
      `الأيدي الرقمي: ${member.telegram_user_id}\n` +
      `تاريخ الانضمام: ${formatDate(member.joined_at)}\n` +
      `الحالة: ${statusMap[member.status] ?? member.status}\n` +
      `عدد الرسائل: ${member.message_count}\n` +
      `التحذيرات: ${member.warning_count}\n\n` +
      `دورك: ${ROLE_LABELS[role]}${pendingReason ? "\n(عند اختيار إجراء سيُطلب منك كتابة السبب)" : ""}`,
    keyboard: rows,
  };
}

export function screenBanned(members: MemberRow[], gid: number): Screen {
  const rows: InlineKeyboardButton[][] = members.map((m) => [
    { text: `${memberLabel(m.display_name || null, m.username, m.telegram_user_id)} — فك الحظر`, callback_data: encodeCallback("act", gid, ["unban", m.telegram_user_id, "banned"]) },
  ]);
  if (!members.length) rows.push([{ text: "لا يوجد أعضاء محظورون 🎉", callback_data: encodeCallback("panel", gid) }]);
  rows.push([groupBack(gid)]);
  return {
    text: `🚫 ${SECTION_TITLES.banned}\n\nاضغط على عضو لفك الحظر عنه:`,
    keyboard: rows,
  };
}

// ---------- Messages ----------

export function screenMessagesSettings(settings: GroupSettings, gid: number): Screen {
  const cleanupMap: Record<string, string> = {
    none: "معطّل",
    links: "حذف الروابط",
    media: "حذف الوسائط",
    files: "حذف الملفات",
  };
  const cf = settings.messages.contentFilter;
  return {
    text: `💬 مركز الرسائل\n━━━━━━━━━━━━━━━━━━\nإدارة رسائل الترحيب والوداع، وتنظيف المحتوى، وقوالب الرسائل الجاهزة.\n\nاختر الأداة التي تريد تخصيصها:`,
    keyboard: [
      [{ text: "👋 رسالة الترحيب", callback_data: encodeCallback("editwelcome", gid) }],
      [{ text: "👋 رسالة الوداع", callback_data: encodeCallback("editgoodbye", gid) }],
      [{ text: `🧹 تنظيف الرسائل: ${cleanupMap[settings.messages.cleanup]}`, callback_data: encodeCallback("cleanup", gid) }],
      [
        { text: `🔤 فلتر النصوص: ${cf.text ? "مفعّل" : "متوقف"}`, callback_data: encodeCallback("contentfilter", gid, ["text"]) },
        { text: `🖼 فلتر الوسائط: ${cf.media ? "مفعّل" : "متوقف"}`, callback_data: encodeCallback("contentfilter", gid, ["media"]) },
      ],
      [{ text: `📎 فلتر الملفات: ${cf.files ? "مفعّل" : "متوقف"}`, callback_data: encodeCallback("contentfilter", gid, ["files"]) }],
      [{ text: "📝 قوالب الرسائل", callback_data: encodeCallback("templates", gid) }],
      [groupBack(gid)],
    ],
  };
}

export function screenMessageEditor(kind: "welcome" | "goodbye", current: string, gid: number): Screen {
  const title = kind === "welcome" ? "محرر رسالة الترحيب" : "محرر رسالة الوداع";
  return {
    text:
      `✏️ ${title}\n\n` +
      `النص الحالي:\n${current}\n\n` +
      `المتغيرات المتاحة:\n{name} اسم العضو — {group_name} اسم المجموعة — {username} اسم المستخدم\n\n` +
      `اضغط «تعديل النص» ثم أرسل النص الجديد:`,
    keyboard: [
      [{ text: "✏️ تعديل النص", callback_data: encodeCallback("edittext", gid, [kind]) }],
      [{ text: "👁 معاينة", callback_data: encodeCallback("preview", gid, [kind]) }],
      [back("messages", gid)],
    ],
  };
}

export function screenTemplates(settings: GroupSettings, gid: number): Screen {
  const templates = settings.messages.templates;
  const list = templates.length ? templates.map((t, i) => `${i + 1}. ${t.name}`).join("\n") : "لا توجد قوالب محفوظة.";
  const rows: InlineKeyboardButton[][] = templates.map((t, i) => [
    { text: `🗑 حذف: ${t.name}`, callback_data: encodeCallback("tpl_del", gid, [i]) },
  ]);
  rows.push([{ text: "➕ حفظ قالب جديد", callback_data: encodeCallback("tpl_add", gid) }]);
  rows.push([back("messages", gid)]);
  return {
    text: `📝 قوالب الرسائل\n\n${list}\n\nاضغط قالبًا لحذفه، أو أضف قالبًا جديدًا (سأطلب منك الاسم ثم النص):`,
    keyboard: rows,
  };
}

export function screenHelp(gid: number | null): Screen {
  return {
    text:
      `❓ ${SECTION_TITLES.help}\n\n` +
      `كيف يعمل ${BRAND}؟\n` +
      `1) أضف البوت إلى مجموعتك وارفعه مشرفًا.\n` +
      `2) افتح البوت في الخاص لتصلك رسالة «تمت إضافة البوت» مع لوحة التحكم.\n` +
      `3) اضبط الحماية والأعضاء والرسائل والتنبيهات من الأقسام.\n\n` +
      `ملاحظات:\n` +
      `• كل إجراء يُسجَّل في سجل الأحداث.\n` +
      `• إعدادات كل مجموعة مستقلة تمامًا.\n` +
      `• الإجراءات الحساسة (الحظر/الطرد) تتطلب تأكيدًا.\n\n` +
      FOOTER,
    keyboard: gid != null ? [[groupBack(gid)]] : [[{ text: "↩️ رجوع", callback_data: encodeCallback("home") }]],
  };
}

// ---------- Notifications ----------

const TARGET_LABELS: Record<string, string> = {
  group: "داخل المجموعة",
  owner_pm: "في الخاص مع المالك",
  admins: "للمشرفين",
};

export function screenNotifications(settings: GroupSettings, gid: number): Screen {
  const rules: Array<{ key: string; label: string; hint: string; toggleKey: string; targetKey: string }> = [
    { key: "memberJoined", label: "تنبيه دخول عضو", hint: "إشعار عند انضمام عضو جديد", toggleKey: "n_join", targetKey: "memberJoined" },
    { key: "memberLeft", label: "تنبيه مغادرة عضو", hint: "إشعار عند خروج عضو", toggleKey: "n_left", targetKey: "memberLeft" },
    { key: "violations", label: "تنبيه المخالفات", hint: "إشعار عند اكتشاف مخالفة", toggleKey: "n_violation", targetKey: "violations" },
    { key: "bans", label: "تنبيه الحظر", hint: "إشعار عند حظر عضو", toggleKey: "n_ban", targetKey: "bans" },
    { key: "promotions", label: "تنبيه الترقية لمشرف", hint: "إشعار عند تغيير الصلاحيات", toggleKey: "n_promote", targetKey: "promotions" },
  ];
  const ruleByKey: Record<string, keyof GroupSettings["notifications"]> = {
    memberJoined: "memberJoined",
    memberLeft: "memberLeft",
    violations: "violations",
    bans: "bans",
    promotions: "promotions",
  };
  const rows: InlineKeyboardButton[][] = rules.map((r) => {
    const rule = settings.notifications[ruleByKey[r.key]];
    const state = rule.enabled ? "مفعّل" : "متوقف";
    return [{
      text: `${rule.enabled ? "✅" : "⛔️"} ${r.label}\n${r.hint}\n(${state} • ${TARGET_LABELS[rule.target] ?? rule.target})`,
      callback_data: encodeCallback("toggle", gid, [r.toggleKey]),
    }];
  });
  rows.push([
    { text: "📨 وجهة التنبيهات", callback_data: encodeCallback("notif_target", gid) },
  ]);
  rows.push([groupBack(gid)]);
  return {
    text: `🔔 مركز التنبيهات\n━━━━━━━━━━━━━━━━━━\nتحكم في الأحداث التي تريد متابعتها، وحدد أين تصل كل رسالة تنبيه.\n\nاضغط على نوع التنبيه لتشغيله أو إيقافه:`,
    keyboard: rows,
  };
}

export function screenNotificationTargets(settings: GroupSettings, gid: number): Screen {
  const items: Array<{ key: keyof GroupSettings["notifications"]; label: string }> = [
    { key: "memberJoined", label: "دخول عضو" },
    { key: "memberLeft", label: "مغادرة عضو" },
    { key: "violations", label: "المخالفات" },
    { key: "bans", label: "الحظر" },
    { key: "promotions", label: "الترقية" },
  ];
  const rows: InlineKeyboardButton[][] = items.map((it) => {
    const rule = settings.notifications[it.key];
    return [{
      text: `${it.label}: ${TARGET_LABELS[rule.target] ?? rule.target}`,
      callback_data: encodeCallback("notif_target_cycle", gid, [it.key]),
    }];
  });
  rows.push([back("notifications", gid)]);
  return {
    text: `📨 وجهة التنبيهات\n\nاضغط على كل نوع لتغيير وجهته (داخل المجموعة / الخاص مع المالك / للمشرفين):`,
    keyboard: rows,
  };
}

// ---------- Permissions ----------

export function screenPermissions(settings: GroupSettings, gid: number, admins: Array<{ id: number; status: string }>): Screen {
  const rows: InlineKeyboardButton[][] = PERMISSION_TOGGLES.map((t) => [
    toggleButton(t.key, gid, toggleStateEmoji(settings, t.key), t.name, t.hint, toggleStateLabel(settings, t.key)),
  ]);

  const adminNames = admins.length
    ? admins.map((a) => `• ${a.id} (${a.status === "creator" ? "مالك" : "مشرف"})`).join("\n")
    : "لا يمكن جلب قائمة المشرفين الآن.";

  const botAdminRows = settings.permissions.botAdmins.map((id) => [{
    text: `🗑 إزالة مدير البوت: ${id}`,
    callback_data: encodeCallback("remove_admin", gid, [id]),
  }]);
  rows.push(...botAdminRows);
  rows.push([{ text: "➕ إضافة مدير بوت", callback_data: encodeCallback("add_admin", gid) }]);
  rows.push([groupBack(gid)]);

  return {
    text:
      `👮 ${SECTION_TITLES.permissions}\n\n` +
      `مستويات الإدارة:\n` +
      `👑 مالك المجموعة — ${ROLE_DESCRIPTIONS.owner}\n` +
      `🧑‍💼 مدير البوت — ${ROLE_DESCRIPTIONS.bot_admin}\n` +
      `🛡️ مشرف — ${ROLE_DESCRIPTIONS.moderator}\n` +
      `👁 مراقب — ${ROLE_DESCRIPTIONS.watcher}\n\n` +
      `مديرو البوت المسجلون: ${settings.permissions.botAdmins.length ? settings.permissions.botAdmins.join("، ") : "لا يوجد"}\n\n` +
      `مشرفو المجموعة الحاليون:\n${adminNames}\n\n` +
      `صلاحيات مستقلة للمشرفين:`,
    keyboard: rows,
  };
}

// ---------- Logs ----------

const EVENT_TYPE_LABELS: Record<string, string> = {
  member_joined: "سجل الأعضاء",
  member_left: "سجل الأعضاء",
  ban: "سجل الحظر",
  unban: "سجل الحظر",
  kick: "سجل الحظر",
  mute: "سجل التحذيرات",
  unmute: "سجل التحذيرات",
  warn: "سجل التحذيرات",
  violation: "سجل الرسائل",
  message_deleted: "سجل الرسائل",
  admin_promoted: "سجل المشرفين",
  settings_changed: "سجل إعدادات البوت",
  settings_reset: "سجل إعدادات البوت",
  error: "سجل الأخطاء",
};

export function screenLogs(gid: number): Screen {
  return {
    text: `📋 مركز سجل الأحداث\n━━━━━━━━━━━━━━━━━━\nكل إجراء مهم داخل المجموعة يُسجّل هنا للمراجعة والرجوع إليه.\n\nاختر نوع السجل لعرض الأحداث المرتبطة به:`,
    keyboard: [
      [{ text: "👥 سجل الأعضاء", callback_data: encodeCallback("loglist", gid, ["member"]) }],
      [{ text: "🚫 سجل الحظر", callback_data: encodeCallback("loglist", gid, ["ban"]) }],
      [{ text: "⚠️ سجل التحذيرات", callback_data: encodeCallback("loglist", gid, ["warn"]) }],
      [{ text: "💬 سجل الرسائل", callback_data: encodeCallback("loglist", gid, ["message"]) }],
      [{ text: "👮 سجل المشرفين", callback_data: encodeCallback("loglist", gid, ["admin"]) }],
      [{ text: "⚙️ سجل إعدادات البوت", callback_data: encodeCallback("loglist", gid, ["settings"]) }],
      [{ text: "🧭 كل الأحداث", callback_data: encodeCallback("loglist", gid, ["all"]) }],
      [groupBack(gid)],
    ],
  };
}

function auditTypeFilter(kind: string): string | undefined {
  switch (kind) {
    case "member": return "member_joined";
    case "ban": return undefined; // handled by multiple types
    case "warn": return undefined;
    case "message": return undefined;
    case "admin": return undefined;
    case "settings": return undefined;
    default: return undefined;
  }
}

export function screenLogList(events: AuditRow[], gid: number, kind: string): Screen {
  const rows: InlineKeyboardButton[][] = [];
  if (events.length === 0) {
    rows.push([{ text: "لا توجد أحداث مسجلة بعد", callback_data: encodeCallback("logs", gid) }]);
  } else {
    const filtered = filterAudit(events, kind);
    for (const e of filtered.slice(0, 15)) {
      const label = `${formatDate(e.created_at)} • ${EVENT_TYPE_LABELS[e.event_type] ?? e.event_type}${e.target ? " • " + e.target : ""}`;
      rows.push([{ text: label, callback_data: encodeCallback("logdetail", gid, [e.id]) }]);
    }
  }
  rows.push([back("logs", gid)]);
  return {
    text: `📋 عرض: ${SECTION_TITLES.logs}\n\nاختر حدثًا لعرض تفاصيله:`,
    keyboard: rows,
  };
}

function filterAudit(events: AuditRow[], kind: string): AuditRow[] {
  const map: Record<string, string[]> = {
    member: ["member_joined", "member_left"],
    ban: ["ban", "unban", "kick"],
    warn: ["warn", "mute", "unmute"],
    message: ["violation", "message_deleted"],
    admin: ["admin_promoted"],
    settings: ["settings_changed", "settings_reset"],
  };
  const allowed = map[kind];
  if (!allowed) return events;
  return events.filter((e) => allowed.includes(e.event_type));
}

export function screenLogDetail(row: AuditRow, gid: number): Screen {
  let detailsText = "";
  try {
    const parsed = JSON.parse(row.details || "{}") as Record<string, unknown>;
    detailsText = Object.entries(parsed)
      .map(([k, v]) => `• ${k}: ${String(v)}`)
      .join("\n");
  } catch {
    detailsText = row.details || "—";
  }
  return {
    text:
      `📋 تفاصيل الحدث\n\n` +
      `النوع: ${EVENT_TYPE_LABELS[row.event_type] ?? row.event_type}\n` +
      `بواسطة: ${row.actor_name ?? (row.actor_telegram_user_id ? String(row.actor_telegram_user_id) : "النظام")}\n` +
      `الهدف: ${row.target ?? "—"}\n` +
      `التاريخ: ${formatDateTime(row.created_at)}\n\n` +
      `${detailsText}`,
    keyboard: [[back("logs", gid)], [groupBack(gid)]],
  };
}

// ---------- Reset ----------

export function screenReset(gid: number): Screen {
  return {
    text: `♻️ ${SECTION_TITLES.reset}\n\nقسم حساس — يمكنك إعادة الإعدادات إلى الوضع الافتراضي. لن تُحذف سجلات الأحداث أو بيانات الأعضاء:`,
    keyboard: [
      [{ text: "♻️ إعادة ضبط الحماية", callback_data: encodeCallback("reset_confirm", gid, ["protection"]) }],
      [{ text: "♻️ إعادة ضبط الأعضاء", callback_data: encodeCallback("reset_confirm", gid, ["members"]) }],
      [{ text: "♻️ إعادة ضبط الرسائل", callback_data: encodeCallback("reset_confirm", gid, ["messages"]) }],
      [{ text: "♻️ إعادة ضبط التنبيهات", callback_data: encodeCallback("reset_confirm", gid, ["notifications"]) }],
      [{ text: "♻️ إعادة ضبط الصلاحيات", callback_data: encodeCallback("reset_confirm", gid, ["permissions"]) }],
      [{ text: "♻️ إعادة ضبط جميع الإعدادات", callback_data: encodeCallback("reset_confirm", gid, ["all"]) }],
      [groupBack(gid)],
    ],
  };
}

export function screenResetConfirm(sectionKey: string, gid: number): Screen {
  const labelMap: Record<string, string> = {
    protection: "الحماية",
    members: "الأعضاء",
    messages: "الرسائل",
    notifications: "التنبيهات",
    permissions: "الصلاحيات",
    all: "جميع الإعدادات",
  };
  return {
    text: `⚠️ تأكيد إعادة الضبط\n\nسيتم إرجاع إعدادات «${labelMap[sectionKey] ?? sectionKey}» إلى الوضع الافتراضي.\nلن تُحذف السجلات أو بيانات الأعضاء.\n\nهل تريد المتابعة؟`,
    keyboard: [
      [{ text: "✅ نعم، إعادة الضبط", callback_data: encodeCallback("reset_do", gid, [sectionKey]) }],
      [{ text: "↩️ إلغاء", callback_data: encodeCallback("reset", gid) }],
    ],
  };
}

// ---------- Stats ----------

export interface GroupStats {
  memberCount: number;
  activeCount: number;
  messageCount: number;
  warningCount: number;
  banCount: number;
  muteCount: number;
  auditCount: number;
  groupTitle: string;
  botReady: boolean;
  enabledProtection: number;
}

export function screenStats(stats: GroupStats, gid: number): Screen {
  const protection = defaultSettings().protection;
  return {
    text:
      `📊 تقرير المجموعة\n━━━━━━━━━━━━━━━━━━\n` +
      `🏷️ ${stats.groupTitle}\n\n` +
      `👥 الأعضاء: ${stats.memberCount}   •   🟢 النشطون: ${stats.activeCount}\n` +
      `💬 الرسائل المسجلة: ${stats.messageCount}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `⚠️ التحذيرات: ${stats.warningCount}\n` +
      `🚫 الحظر: ${stats.banCount}   •   🔇 الكتم: ${stats.muteCount}\n` +
      `📋 أحداث السجل: ${stats.auditCount}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🛡️ الحماية المفعّلة: ${stats.enabledProtection}/${PROTECTION_TOGGLES.filter((t) => t.kind === "boolean").length}\n` +
      `🤖 حالة البوت: ${stats.botReady ? "جاهز ويعمل ✅" : "يحتاج مراجعة ⚠️"}\n\n` +
      `📌 الأرقام المعروضة من بيانات المجموعة المسجلة.\n` + FOOTER,
    keyboard: [[{ text: "🔄 تحديث", callback_data: encodeCallback("stats", gid) }], [groupBack(gid)]],
  };
}

// ---------- Confirmation (destructive actions) ----------

export function screenConfirm(action: string, targetLabel: string, gid: number, targetId: number, reasonLabel: string): Screen {
  return {
    text: `⚠️ تأكيد العملية\n\nأنت على وشك ${action} العضو «${targetLabel}».\nالسبب: ${reasonLabel}\n\nهل تريد المتابعة؟`,
    keyboard: [
      [{ text: "⚠️ نعم، تنفيذ", callback_data: encodeCallback("docall", gid, [action, targetId]) }],
      [{ text: "↩️ إلغاء", callback_data: encodeCallback("member", gid, [targetId]) }],
    ],
  };
}
