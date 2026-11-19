const test = require("node:test");
const assert = require("node:assert/strict");
const { isTelegramMessageNotModifiedError } = require("../.test-build/telegram-errors.js");

test("Telegram unchanged-message response is treated as an idempotent edit", () => {
  const error = new Error(
    "telegram_editMessageText_failed: Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
  );
  assert.equal(isTelegramMessageNotModifiedError(error), true);
});

test("real Telegram edit failures still trigger the fallback path", () => {
  for (const message of [
    "telegram_editMessageText_failed: Bad Request: message to edit not found",
    "telegram_editMessageText_failed: Bad Request: message can't be edited",
    "network timeout",
  ]) {
    assert.equal(isTelegramMessageNotModifiedError(new Error(message)), false);
  }
});

test("non-Error thrown values are handled safely", () => {
  assert.equal(isTelegramMessageNotModifiedError("Bad Request: message is not modified"), true);
  assert.equal(isTelegramMessageNotModifiedError(null), false);
});
