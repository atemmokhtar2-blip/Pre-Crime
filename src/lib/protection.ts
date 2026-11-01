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
};

export function extractSignal(message: TelegramMessage): MessageSignal {
  const text = message.text ?? message.caption ?? "";
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  const hasUrl = entities.some((e) => e.type === "url" || e.type === "text_link");
  // Fallback URL detection for plain-text links Telegram may not flag.
  const textHasUrl = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i.test(text);
  const hasForward = Boolean(message.forward_origin || message.forward_from || message.forward_from_chat);
  const hasMedia = Boolean(message.photo || message.video || message.animation || message.sticker || message.voice || message.audio);
  const hasDocument = Boolean(message.document);

  return { text, hasUrl: hasUrl || textHasUrl, hasForward, hasMedia, hasDocument };
}

// Pure policy evaluation: given the current signal and recent events for a user,
// return the violations the policy produces. "recent" is a rolling window of the
// user's messages plus timestamps supplied by the caller (so this stays testable
// and side-effect free).
export interface RecentEvent {
  at: number;
  text: string;
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

  const allowedLink = policy.antiLinks.whitelist.length > 0 && policy.antiLinks.whitelist.some((d) => signal.text.toLowerCase().includes(d.toLowerCase()));
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
  if (policy.wordFilter.enabled && words.length > 0) {
    const lower = signal.text.toLowerCase();
    if (words.some((w) => lower.includes(w.trim().toLowerCase()))) {
      violations.push("word");
    }
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
