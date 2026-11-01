const test = require("node:test");
const assert = require("node:assert/strict");
const { createNeonRepo } = require("../.test-build/db.js");

test("message history writes idempotently and returns prior events", async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const query = Array.from(strings).join("?");
    calls.push({ query, values });
    if (query.includes("WITH inserted")) {
      return [{ at: 9_000, text: "previous message" }];
    }
    return [];
  };

  const repo = createNeonRepo(sql);
  const recent = await repo.recordMessageEvent(-100123, 456, 789, "current message", 10_000, 5_000);

  assert.deepEqual(recent, [{ at: 9_000, text: "previous message" }]);
  assert.match(calls[0].query, /ON CONFLICT \(update_id\) DO NOTHING/);
  assert.match(calls[0].query, /update_id <> \?/);
  assert.equal(calls[0].values[0], 789);
  assert.equal(calls[0].values[1], -100123);
  assert.equal(calls[0].values[2], 456);
});
