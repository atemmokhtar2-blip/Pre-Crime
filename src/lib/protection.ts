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
  return value.toLowerCase().normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[پ]/g, "ب").replace(/[ڤ]/g, "ف").replace(/[گک]/g, "ك")
    .replace(/[ی]/g, "ي")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

function normalizeObfuscation(value: string): string {
  return normalizeText(value)
    .replace(/3/g, "ع").replace(/7/g, "ح").replace(/8/g, "ق").replace(/9/g, "ص")
    .replace(/[|!$]/g, "");
}

function foldLatinArabizi(value: string): string {
  return normalizeObfuscation(value)
    .replace(/kh/g, "خ").replace(/sh/g, "ش").replace(/gh/g, "غ")
    .replace(/th/g, "ث").replace(/dh/g, "ذ").replace(/aa/g, "ا")
    .replace(/a/g, "ا").replace(/b/g, "ب").replace(/t/g, "ت")
    .replace(/g/g, "ج").replace(/j/g, "ج").replace(/d/g, "د")
    .replace(/r/g, "ر").replace(/z/g, "ز").replace(/s/g, "س")
    .replace(/f/g, "ف").replace(/q/g, "ق").replace(/k/g, "ك")
    .replace(/l/g, "ل").replace(/m/g, "م").replace(/n/g, "ن")
    .replace(/h/g, "ه").replace(/w/g, "و").replace(/y/g, "ي")
    .replace(/e/g, "ي").replace(/o/g, "و").replace(/u/g, "و");
}

function squeezeRepeats(value: string): string {
  return value.replace(/(.)\1{2,}/gu, "$1$1");
}

function normalizeForMatch(value: string): string {
  return squeezeRepeats(foldLatinArabizi(value))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().replace(/\s+/g, " ");
}

function tokens(value: string): string[] {
  const normalized = normalizeForMatch(value);
  return normalized ? normalized.split(" ") : [];
}

const BUILTIN_BLOCKED_WORDS = [
  "كسمك", "كسم", "كس امك", "كس ام", "كس اختك", "كسختك",
  "شرموط", "شرموطه", "شراميط", "متناك", "متناكه", "منيوك", "منيوكه",
  "خول", "خولات", "عرص", "قحبه", "قحاب", "لبوه", "طيز", "زبر",
  "نيك", "انيك", "ينك", "يا ابن الكلب", "ابن الكلب",
];

function damerauLevenshteinAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length) {
      if (i + 1 < a.length && a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; }
      else { i++; j++; }
    } else if (a.length > b.length) i++;
    else j++;
  }
  if (i < a.length || j < b.length) edits++;
  return edits <= 1;
}

function separatorObfuscationMatch(message: string, word: string): boolean {
  const chars = [...word];
  if (chars.length < 3) return false;
  const pattern = chars.map((c) => c.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"))
    .join("[\\s\\p{P}\\p{S}ـ]{0,2}");
  return new RegExp("(^|[^\\p{L}\\p{N}])" + pattern + "($|[^\\p{L}\\p{N}])", "u")
    .test(normalizeText(message));
}

function containsBlockedWord(message: string, customWords: string[]): boolean {
  const messageTokens = tokens(message);
  const candidates = [...BUILTIN_BLOCKED_WORDS, ...customWords]
    .map((word) => normalizeForMatch(word))
    .filter((word) => word.length >= 3);

  for (const candidate of candidates) {
    const candidateTokens = candidate.split(" ");
    if (candidateTokens.length > 1) {
      for (let i = 0; i <= messageTokens.length - candidateTokens.length; i++) {
        if (candidateTokens.every((part, j) => messageTokens[i + j] === part)) return true;
      }
    } else {
      if (messageTokens.includes(candidate)) return true;
      if (separatorObfuscationMatch(message, candidate)) return true;
      if (candidate.length >= 5 && messageTokens.some((token) =>
        token.length >= 5 && damerauLevenshteinAtMostOne(token, candidate))) return true;
    }
  }
  return false;
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
