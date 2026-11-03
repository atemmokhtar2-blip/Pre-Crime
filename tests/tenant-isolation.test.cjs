const test = require("node:test");
const assert = require("node:assert/strict");
const { createTenantSql } = require("../.test-build/db.js");

function captureSql() {
  const statements = [];
  const sql = async (strings, ...values) => {
    const text = Array.from(strings).join("?");
    statements.push({ text, values });
    return [];
  };
  return { sql, statements };
}

test("tenant SQL qualifies reads and writes with only the selected tenant schema", async () => {
  const { sql, statements } = captureSql();
  const tenantA = await createTenantSql(sql, 10101);
  const tenantB = await createTenantSql(sql, 20202);

  await tenantA`SELECT * FROM groups WHERE chat_id = ${-1001}`;
  await tenantA`UPDATE group_settings SET settings = ${"{}"} WHERE chat_id = ${-1001}`;
  await tenantB`SELECT * FROM groups WHERE chat_id = ${-2002}`;
  await tenantB`INSERT INTO bot_users (telegram_user_id) VALUES (${42})`;

  const queries = statements.slice(2).map((entry) => entry.text);
  assert.match(queries[0], /FROM "tenant_10101"\.groups/);
  assert.match(queries[1], /UPDATE "tenant_10101"\.group_settings/);
  assert.match(queries[2], /FROM "tenant_20202"\.groups/);
  assert.match(queries[3], /INTO "tenant_20202"\.bot_users/);
  assert.equal(queries.some((query) => query.includes('"tenant_10101".groups') && query.includes('"tenant_20202".')), false);
  assert.equal(queries.some((query) => query.includes('"tenant_20202".groups') && query.includes('"tenant_10101".')), false);
});

test("tenant SQL rejects malformed or unsafe bot identifiers before issuing schema SQL", async () => {
  const { sql, statements } = captureSql();
  for (const id of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    await assert.rejects(() => createTenantSql(sql, id), /invalid_managed_bot_id/);
  }
  assert.equal(statements.length, 0);
});
