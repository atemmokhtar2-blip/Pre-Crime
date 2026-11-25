const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSafeGroupChatId } = require("../.test-build/admin/store.js");

test("parses valid Telegram chat IDs exactly", () => {
  assert.equal(parseSafeGroupChatId("-1002143414728"), -1002143414728);
  assert.equal(parseSafeGroupChatId("123456"), 123456);
});

test("rejects numeric strings outside JavaScript safe integer range", () => {
  assert.equal(parseSafeGroupChatId("9007199254740992"), null);
  assert.equal(parseSafeGroupChatId("-9007199254740993"), null);
});

test("non-numeric and empty queries remain text searches", () => {
  assert.equal(parseSafeGroupChatId("group-123"), null);
  assert.equal(parseSafeGroupChatId(""), null);
  assert.equal(parseSafeGroupChatId("   "), null);
});
