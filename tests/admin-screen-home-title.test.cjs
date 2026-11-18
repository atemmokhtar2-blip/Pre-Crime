const test = require("node:test");
const assert = require("node:assert/strict");
const { screenHome } = require("../.test-build/admin/screens.js");

test("factory-created tenant bots use the short admin panel title", () => {
  assert.equal(screenHome(true, false, true).text, "👑 لوحة إدارة");
});

test("self-created tenant bot copies keep the existing private-copy title", () => {
  assert.equal(screenHome(true, false, false).text, "👑 لوحة إدارة نسختك الخاصة");
});

test("the original Pre Crime admin panel title remains unchanged", () => {
  assert.equal(screenHome(false, true, false).text, "👑 PRE CRIME  /  ADMIN");
});
