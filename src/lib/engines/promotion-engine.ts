// Independent promotion/ad detection engine. Conservative by design: it only flags
// explicit promotional language combined with a contact/link signal.
const PROMO_TERMS = /(?:اعلان|إعلان|ترويج|للترويج|اشترك|تابع(?:ونا)?|قناة(?:نا)?|جروب|جروبنا|خصم|عرض حصري|للطلب|تواصل(?:وا)?|واتساب|whatsapp|telegram|انضم(?:وا)?|subscribe|follow|promo|discount|sale)/iu;
const CONTACT_SIGNAL = /(?:https?:\/\/|www\.|t\.me\/|@[\p{L}\p{N}_]{4,}|\+?\d[\d\s-]{7,})/iu;
export function inspectPromotion(text: string, links: string[] = []): boolean {
  const value = text.trim();
  return Boolean(value && PROMO_TERMS.test(value) && (CONTACT_SIGNAL.test(value) || links.length > 0));
}
