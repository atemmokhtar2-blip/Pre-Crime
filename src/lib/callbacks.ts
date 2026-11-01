// Callback payload codec. The full navigation tree is encoded as
// `pc:<section>:<groupId>:<args...>` so the private control panel can always
// resolve WHICH group an action targets (private chat has no group context).

export type ParsedCallback = {
  section: string;
  groupId: number | null;
  args: string[];
};

export function encodeCallback(section: string, groupId?: number | null, args: (string | number)[] = []): string {
  const parts = ["pc", section];
  if (groupId != null) parts.push(String(groupId));
  for (const arg of args) parts.push(String(arg));
  return parts.join(":");
}

export function parseCallback(data: string): ParsedCallback | null {
  if (!data || !data.startsWith("pc")) return null;
  const parts = data.split(":");
  if (parts[0] !== "pc") return null;
  const section = parts[1] ?? "";
  let groupId: number | null = null;
  let args: string[] = [];

  if (parts.length > 2) {
    const maybeGroup = Number(parts[2]);
    if (Number.isSafeInteger(maybeGroup)) {
      groupId = maybeGroup;
      args = parts.slice(3);
    } else {
      args = parts.slice(2);
    }
  }

  return { section, groupId, args };
}

// Reads a numeric group id from args; falls back to the parsed groupId.
export function groupFromCallback(parsed: ParsedCallback): number | null {
  if (parsed.groupId != null) return parsed.groupId;
  const first = Number(parsed.args[0]);
  return Number.isSafeInteger(first) ? first : null;
}

export function argAsUserId(args: string[], index: number): number | null {
  const value = Number(args[index]);
  return Number.isSafeInteger(value) ? value : null;
}
