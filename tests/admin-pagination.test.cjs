const test = require("node:test");
const assert = require("node:assert/strict");
const { screenUserGroups } = require("../.test-build/admin/screens.js");

test("user-owned group list paginates every result instead of stopping at ten", () => {
  const user = {
    telegram_user_id: 12345,
    username: "member",
    display_name: "Test User",
    status: "active",
    note: "",
    first_seen_at: "",
    last_seen_at: "",
  };
  const groups = Array.from({ length: 19 }, (_, index) => ({
    chat_id: -1000000000000 - index,
    title: `Group ${index + 1}`,
    username: null,
    status: "active",
    added_at: new Date(0).toISOString(),
    owner_user_id: user.telegram_user_id,
  }));

  const first = screenUserGroups(user, groups, 0);
  const second = screenUserGroups(user, groups, 1);
  const third = screenUserGroups(user, groups, 2);
  const groupButtons = (screen) => screen.keyboard.flat().filter((button) => button.callback_data.startsWith("adm:g_view:"));

  assert.ok(first.text.includes("(19)"));
  assert.equal(groupButtons(first).length, 8);
  assert.equal(groupButtons(second).length, 8);
  assert.equal(groupButtons(third).length, 3);
  assert.ok(first.keyboard.flat().some((button) => button.callback_data === "adm:u_gpage:1:12345"));
  assert.ok(second.keyboard.flat().some((button) => button.callback_data === "adm:u_gpage:2:12345"));
  assert.ok(groupButtons(third).some((button) => button.callback_data === "adm:g_view:-1000000000018"));
  assert.match(first.text, /المجموعات التي يمتلكها/);
});
