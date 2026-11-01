import type { ProtectionPolicy, TelegramMessage } from "./types";

export type ViolationKind =
  | "spam"
  | "link"
  | "forward"
  | "duplicate"
  | "word"
  | "flood";

export type MessageSignal = {
  text: string;
  hasUrl: boolean;
  hasForward: boolean;
  hasMedia: boolean;
  hasDocument: boolean;
  links?: string[];
};

export function extractSignal(message: TelegramMessage): MessageSignal {
  const text = message.text ?? message.caption ?? "";
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  const entityLinks = entities
    .filter((entity) => entity.type === "url" || entity.type === "text_link")
    .map((entity) => "url" in entity && typeof entity.url === "string" ? entity.url : "")
    .filter(Boolean);
  // Catch ordinary domains and Telegram links even when Telegram omits URL entities.
  const rawLinks = text.match(/(?:https?:\/\/|www\.)[^\s<>()]+|(?:t\.me|telegram\.me)\/[^\s<>()]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|me|co|info|biz|app|dev|eg|xyz|site|online|store|gg|ly)(?:\/[^\s<>()]*)?/gi) ?? [];
  const links = [...new Set([...entityLinks, ...rawLinks].map((url) => url.replace(/[.,!?;:،؛)\]}]+$/g, "").toLowerCase()))];
  const hasForward = Boolean(message.forward_origin || message.forward_from || message.forward_from_chat);
  const hasMedia = Boolean(message.photo || message.video || message.animation || message.sticker || message.voice || message.audio);
  const hasDocument = Boolean(message.document);

  return { text, hasUrl: links.length > 0, links, hasForward, hasMedia, hasDocument };
}

// Pure policy evaluation: given the current signal and recent events for a user,
// return the violations the policy produces. "recent" is a rolling window of the
// user's messages plus timestamps supplied by the caller (so this stays testable
// and side-effect free).
export interface RecentEvent {
  at: number;
  text: string;
}

function normalizeText(value: string): string {
  return value.toLowerCase()
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[پ]/g, "ب")
    .replace(/[ڤ]/g, "ف")
    .replace(/[گ]/g, "ك");
}

function compactText(value: string): string {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function tokens(value: string): string[] {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Baseline Egyptian/Arabic abusive terms. Group owners can extend this list
// with their own words; the filter remains fully local and has no API cost.
const BUILTIN_BLOCKED_WORDS = [
  "كسمك", "كسمك", "كس امك", "كس اختك", "كسختك", "كسم", "كس ام",
  "شرموط", "شرموطه", "شراميط", "متناك", "متناكه", "منيوك", "منيوكه",
  "خول", "خولات", "عرص", "قحبه", "قحاب", "لبوه", "لبوه",
  "طيز", "زب", "زبر", "نيك", "انيك", "ينك", "خول",
];

function containsBlockedWord(message: string, customWords: string[]): boolean {
  const normalizedTokens = tokens(message);
  const compactMessage = compactText(message);
  const candidates = [...BUILTIN_BLOCKED_WORDS, ...customWords]
    .map((word) => ({ spaced: normalizeText(word).trim(), compact: compactText(word) }))
    .filter((word) => word.compact.length >= 2);

  for (const candidate of candidates) {
    // Exact token match avoids false positives inside harmless longer words.
    if (normalizedTokens.some((token) => token === candidate.compact)) return true;
    // Catch separators inserted between letters: ك س م ك / كـسـمـك / ك*س*م*ك.
    if (candidate.compact.length >= 3 && compactMessage.includes(candidate.compact)) return true;
  }

  // Catch character repetition used to evade matching, e.g. كــــســــمــــك.
  const squeezed = normalizeText(message).replace(/(.)\1{1,}/gu, "$1");
  const squeezedCompact = compactText(squeezed);
  return candidates.some((candidate) => candidate.compact.length >= 3 && squeezedCompact.includes(candidate.compact));
}

export function evaluateProtection(policy: ProtectionPolicy, signal: MessageSignal, recent: RecentEvent[], now: number): ViolationKind[] {
  const violations: ViolationKind[] = [];
  const spamWindowMs = Math.max(policy.antiSpam.windowSeconds, 1) * 1000;
  const floodWindowMs = Math.max(policy.antiFlood.windowSeconds, 1) * 1000;
  const spamCount = recent.filter((e) => now - e.at <= spamWindowMs).length + 1;
  const floodCount = recent.filter((e) => now - e.at <= floodWindowMs).length + 1;

  if (policy.antiSpam.enabled && policy.antiSpam.threshold > 0 && spamCount >= policy.antiSpam.threshold) {
    violations.push("spam");
  }

  if (policy.antiFlood.enabled && policy.antiFlood.maxMessages > 0 && floodCount >= policy.antiFlood.maxMessages) {
    violations.push("flood");
  }

  const allowedLink = policy.antiLinks.whitelist.some((domain) => {
    const allowedHost = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (!allowedHost) return false;
    return (signal.links ?? []).some((link) => {
      try {
        const host = new URL(link.includes("://") ? link : "https://" + link).hostname.toLowerCase().replace(/^www\./, "");
        return host === allowedHost || host.endsWith("." + allowedHost);
      } catch {
        return false;
      }
    });
  });
  if (policy.antiLinks.enabled && signal.hasUrl && !allowedLink) {
    violations.push("link");
  }

  if (policy.antiForward.enabled && signal.hasForward) {
    violations.push("forward");
  }

  if (policy.antiDuplicate.enabled && signal.text.trim().length > 0 && recent.some((e) => e.text.trim() === signal.text.trim())) {
    violations.push("duplicate");
  }

  const words = policy.wordFilter.words.filter((w) => w && w.trim().length > 0);
  if (policy.wordFilter.enabled && containsBlockedWord(signal.text, words)) {
    violations.push("word");
  }

  return violations;
}

export const VIOLATION_LABELS: Record<ViolationKind, string> = {
  spam: "منع السبام",
  link: "منع الروابط",
  forward: "منع إعادة التوجيه",
  duplicate: "منع الرسائل المتكررة",
  word: "فلتر الكلمات",
  flood: "الحماية من الإغراق",
};

// Lightweight in-memory rate limiter. On serverless this is per-instance (a
// single-warm-function approximation); swap for Redis (already planned) when
// multi-instance correctness is required.
export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();

  hit(key: string, now: number): number {
    const arr = this.buckets.get(key) ?? [];
    arr.push(now);
    this.buckets.set(key, arr);
    return arr.length;
  }

  prune(key: string, cutoffWindowMs: number, now: number): number[] {
    const arr = this.buckets.get(key) ?? [];
    const kept = arr.filter((t) => now - t <= cutoffWindowMs);
    this.buckets.set(key, kept);
    return kept;
  }
}
