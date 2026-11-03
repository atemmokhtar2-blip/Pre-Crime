// Safe variable substitution for welcome/goodbye and template bodies.
// Only the documented placeholders are replaced; unknown braces are left intact
// so user text is never corrupted or interpreted as code.

export type MessageVars = {
  name?: string;
  firstName?: string | null;
  groupName?: string;
  username?: string | null;
  count?: number;
};

export function renderTemplate(template: string, vars: MessageVars): string {
  const values: Record<string, string> = {
    name: vars.name ?? "",
    first_name: vars.firstName ?? vars.name ?? "",
    username: vars.username ?? "",
    group_name: vars.groupName ?? "",
    count: String(vars.count ?? 0),
  };

  return template
    .replace(/\{name\}/g, values.name)
    .replace(/\{first_name\}/g, values.first_name)
    .replace(/\{username\}/g, values.username)
    .replace(/\{group_name\}/g, values.group_name)
    .replace(/\{count\}/g, values.count);
}

// Builds the final welcome message for a new member using the configured policy.
export function buildWelcomeMessage(template: string, groupName: string, memberName: string, username: string | null): string {
  return renderTemplate(template, {
    name: memberName,
    firstName: memberName,
    groupName,
    username,
  });
}

export function buildGoodbyeMessage(template: string, groupName: string, memberName: string): string {
  return renderTemplate(template, { name: memberName, firstName: memberName, groupName });
}

export function labelForMember(name: string | null, username: string | null, userId: number): string {
  if (name && name.trim()) return name.trim();
  if (username) return `@${username}`;
  return String(userId);
}

export function mentionForMember(name: string | null, userId: number): string {
  // Plain text link so the bot never depends on parse_mode for mentions.
  return `tg://user?id=${userId}`;
}

// Telegram does not render raw `tg://` links in plain messages, so we produce a
// human-readable label instead of an actual mention for portability.
export function memberLabel(name: string | null, username: string | null, userId: number): string {
  if (username) return `@${username}`;
  if (name && name.trim()) return name.trim();
  return `ID ${userId}`;
}
