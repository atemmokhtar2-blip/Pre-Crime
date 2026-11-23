const test = require("node:test");
const assert = require("node:assert/strict");
const { isTelegramMessageNotModifiedError, shouldFallbackAfterTelegramEditError } = require("../.test-build/telegram-errors.js");

test("Telegram unchanged-message response is treated as an idempotent edit", () => {
  const error = new Error(
    "telegram_editMessageText_failed: Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
  );
  assert.equal(isTelegramMessageNotModifiedError(error), true);
  assert.equal(shouldFallbackAfterTelegramEditError(error), false);
});

test("real Telegram edit failures still trigger the fallback path", () => {
  for (const message of [
    "telegram_editMessageText_failed: Bad Request: message to edit not found",
    "telegram_editMessageText_failed: Bad Request: message can't be edited",
    "network timeout",
  ]) {
    const error = new Error(message);
    assert.equal(isTelegramMessageNotModifiedError(error), false);
    assert.equal(shouldFallbackAfterTelegramEditError(error), true);
  }
});

test("non-Error thrown values are handled safely", () => {
  assert.equal(isTelegramMessageNotModifiedError("Bad Request: message is not modified"), true);
  assert.equal(isTelegramMessageNotModifiedError(null), false);
  assert.equal(shouldFallbackAfterTelegramEditError(null), true);
});
