import type { TelegramMessage } from "./types";

export type LinkSignal = { text: string; hasUrl: boolean; links: string[]; };

function normalizeLinkText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/[。．｡]/g, ".")
    .replace(/\s*(?:\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*dot\s*\}|\s+dot\s+)\s*/gi, ".")
    .replace(/hxxps?:\/\//gi, (scheme) => scheme.toLowerCase().startsWith("hxxps") ? "https://" : "http://");
}

export function inspectLinks(message: TelegramMessage): LinkSignal {
  const text = message.text ?? message.caption ?? "";
  const normalizedText = normalizeLinkText(text);
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  const entityLinks = entities.flatMap((entity) => {
    if (entity.type === "text_link" && typeof entity.url === "string") return [entity.url];
    if (entity.type === "url" && typeof entity.offset === "number" && typeof entity.length === "number") {
      return [text.slice(entity.offset, entity.offset + entity.length)];
    }
    return [];
  });
  const rawLinks = normalizedText.match(
    /(?:https?:\/\/|tg:\/\/|www\.)[^\s<>()\[\]{}"']+|(?:t\.me|telegram\.me)\/[^\s<>()\[\]{}"']+|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,}(?::\d{1,5})?(?:\/[^\s<>()\[\]{}"']*)?/giu,
  ) ?? [];
  const links = [...new Set([...entityLinks, ...rawLinks]
    .map((url) => normalizeLinkText(url).replace(/[.,!?;:،؛)\]}]+$/g, "").toLowerCase())
    .filter(Boolean))];
  return { text, hasUrl: links.length > 0, links };
}
