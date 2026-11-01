const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateBotPermissions } = require("../.test-build/onboarding.js");

test("creator with all required permissions is ready", () => {
  assert.deepEqual(
    evaluateBotPermissions({
      status: "creator",
      can_delete_messages: true,
      can_restrict_members: true,
      can_invite_users: true,
    }),
    { isAdmin: true, missing: [], ready: true },
  );
});

test("administrator missing delete permission is not ready", () => {
  const result = evaluateBotPermissions({
    status: "administrator",
    can_delete_messages: false,
    can_restrict_members: true,
    can_invite_users: true,
  });
  assert.equal(result.isAdmin, true);
  assert.deepEqual(result.missing, ["حذف الرسائل"]);
  assert.equal(result.ready, false);
});

test("each required permission is checked independently", () => {
  const cases = [
    { can_delete_messages: false, can_restrict_members: true, can_invite_users: true, missing: ["حذف الرسائل"] },
    { can_delete_messages: true, can_restrict_members: false, can_invite_users: true, missing: ["حظر وتقييد الأعضاء"] },
    { can_delete_messages: true, can_restrict_members: true, can_invite_users: false, missing: ["دعوة المستخدمين"] },
  ];
  for (const item of cases) {
    const result = evaluateBotPermissions({ status: "administrator", ...item });
    assert.deepEqual(result.missing, item.missing);
    assert.equal(result.ready, false);
  }
});

test("ordinary member is never considered ready even with permission flags", () => {
  const result = evaluateBotPermissions({
    status: "member",
    can_delete_messages: true,
    can_restrict_members: true,
    can_invite_users: true,
  });
  assert.equal(result.isAdmin, false);
  assert.equal(result.ready, false);
});

test("left and kicked bot statuses are not ready", () => {
  for (const status of ["left", "kicked"]) {
    assert.equal(evaluateBotPermissions({ status }).ready, false);
  }
});
