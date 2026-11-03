// Independent text moderation engine: normalization, Arabizi folding and blocked phrase matching.
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
  return value.replace(/(.)\1+/gu, "$1");
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

export function inspectWords(text: string, customWords: string[]): boolean {
  return containsBlockedWord(text, customWords);
}
