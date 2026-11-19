export function isTelegramMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\bmessage is not modified\b/i.test(message);
}
