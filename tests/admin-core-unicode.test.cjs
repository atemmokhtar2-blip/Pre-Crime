const test = require("node:test");
const assert = require("node:assert/strict");
const { trunc, userLabel } = require("../.test-build/admin/core.js");

test("trunc never splits a supplementary Unicode character", () => {
  const label = trunc("AB😀CD", 4);
  assert.equal(label, "AB😀…");
  assert.equal(Buffer.from(label, "utf8").toString("utf8"), label);
});

test("trunc replaces malformed lone UTF-16 surrogates before Telegram labels are built", () => {
  const malformed = "\uD800" + " user";
  const label = trunc(malformed, 24);
  assert.equal(label, "\uFFFD user");
  assert.equal(Buffer.from(label, "utf8").toString("utf8"), label);
});

test("userLabel applies the Unicode-safe truncation path to Telegram display names", () => {
  const label = userLabel({
    telegram_user_id: 123,
    username: null,
    display_name: "مرحبا 😀".repeat(5),
  });
  assert.ok(Array.from(label).length <= 24);
  assert.equal(Buffer.from(label, "utf8").toString("utf8"), label);
});
