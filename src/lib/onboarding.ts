export type BotPermissionSnapshot = {
  status: string;
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
  can_invite_users?: boolean;
};

export function evaluateBotPermissions(member: BotPermissionSnapshot) {
  const isAdmin = member.status === "administrator" || member.status === "creator";
  const missing = [
    ["حذف الرسائل", member.can_delete_messages === true],
    ["حظر وتقييد الأعضاء", member.can_restrict_members === true],
    ["دعوة المستخدمين", member.can_invite_users === true],
  ].filter(([, granted]) => !granted).map(([label]) => label as string);

  return { isAdmin, missing, ready: isAdmin && missing.length === 0 };
}
