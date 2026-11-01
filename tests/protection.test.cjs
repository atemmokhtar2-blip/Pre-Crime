const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateProtection, extractSignal } = require("../.test-build/protection.js");

function policy(overrides = {}) {
  return {
    antiSpam: { enabled: true, threshold: 2, windowSeconds: 10 },
    antiLinks: { enabled: false, whitelist: [] },
    antiForward: { enabled: false },
    antiDuplicate: { enabled: false },
    wordFilter: { enabled: false, words: [] },
    antiFlood: { enabled: true, maxMessages: 2, windowSeconds: 5 },
    punishment: { action: "warn", warningsBeforeAction: 3 },
    ...overrides,
  };
}

test("anti-spam and anti-flood use their own configured windows", () => {
  const recent = [{ at: 3_000, text: "old message" }];
  const result = evaluateProtection(policy(), { text: "new message", hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false }, recent, 10_000);
  assert.deepEqual(result, ["spam"]);
});

test("modern Telegram forward_origin is detected", () => {
  const signal = extractSignal({ message_id: 1, chat: { id: -1001, type: "supergroup" }, forward_origin: { type: "hidden_user" } });
  assert.equal(signal.hasForward, true);
});

test("forward detection remains compatible with legacy fields", () => {
  const signal = extractSignal({ message_id: 1, chat: { id: -1001, type: "supergroup" }, forward_from_chat: { id: -1002 } });
  assert.equal(signal.hasForward, true);
});
