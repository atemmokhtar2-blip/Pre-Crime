const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ensureSingleManagedBotPerOwner,
  findLiveManagedBot,
  findLiveManagedBotByBotId,
  isManagedBotLimitViolation,
} = require("../.test-build/managed-bot-limit.js");

function fakeSql(rows = []) {
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ text: Array.from(strings).join("?"), values });
    return rows;
  };
  return { sql, calls };
}

test("single-bot enforcement disables legacy duplicate live rows before creating a unique partial index", async () => {
  const { sql, calls } = fakeSql();
  await ensureSingleManagedBotPerOwner(sql);
  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /ROW_NUMBER\(\) OVER/);
  assert.match(calls[0].text, /SET status = 'failed'/);
  assert.match(calls[1].text, /CREATE UNIQUE INDEX IF NOT EXISTS managed_bots_one_live_bot_per_owner/);
  assert.match(calls[1].text, /WHERE status IN/);
});

test("owner lookup is scoped to live statuses and validates the Telegram owner ID", async () => {
  const { sql, calls } = fakeSql([{ bot_id: "123", status: "active" }]);
  assert.deepEqual(await findLiveManagedBot(sql, 77), { bot_id: 123, status: "active" });
  assert.match(calls[0].text, /owner_telegram_id = \?/);
  assert.match(calls[0].text, /pending_isolation.*active.*suspended_subscription/);
  await assert.rejects(() => findLiveManagedBot(sql, -1), /invalid_managed_bot_owner_id/);
});

test("database unique violations are recognized only for the one-live-bot constraint", () => {
  assert.equal(isManagedBotLimitViolation({ code: "23505", constraint: "managed_bots_one_live_bot_per_owner" }), true);
  assert.equal(isManagedBotLimitViolation({ code: "23505", constraint: "managed_bots_pkey" }), false);
  assert.equal(isManagedBotLimitViolation(new Error("duplicate")), false);
});

test("bot identity lookup rejects an already live Telegram bot token identity", async () => {
  const { sql, calls } = fakeSql([{ bot_id: "456", owner_telegram_id: "88", status: "active" }]);
  assert.deepEqual(await findLiveManagedBotByBotId(sql, 456), {
    bot_id: 456,
    owner_telegram_id: 88,
    status: "active",
  });
  assert.match(calls[0].text, /WHERE bot_id = \?/);
  assert.match(calls[0].text, /pending_isolation.*active.*suspended_subscription/);
  await assert.rejects(() => findLiveManagedBotByBotId(sql, 0), /invalid_managed_bot_id/);
});
