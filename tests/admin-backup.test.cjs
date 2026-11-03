const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdminStore } = require("../.test-build/admin/store.js");
const { restoreBackup } = require("../.test-build/admin/backup.js");

// Mock sql tagged-template that records every query + values and can be
// programmed per-query-substring responses.
function mockSql(responders = {}) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const query = Array.from(strings).join("?");
    calls.push({ query, values });
    for (const [needle, rows] of Object.entries(responders)) {
      if (query.includes(needle)) return typeof rows === "function" ? rows(query, values) : rows;
    }
    return [];
  };
  sql.calls = calls;
  return sql;
}

function mockBot(fileContent) {
  return {
    async getFile(fileId) {
      assert.equal(fileId, "FILE_1");
      return { file_path: "backups/file_1.json" };
    },
    async downloadFile(path) {
      assert.equal(path, "backups/file_1.json");
      return fileContent;
    },
  };
}

const validBackup = JSON.stringify({
  app: "pre-crime",
  version: 1,
  exported_at: "2026-01-01T00:00:00.000Z",
  tables: {
    bot_users: [
      { telegram_user_id: 11, username: "alice", display_name: "Alice", status: "active", note: "", first_seen_at: "2026-01-01T00:00:00.000Z", last_seen_at: "2026-01-02T00:00:00.000Z" },
      { telegram_user_id: 22, username: null, display_name: "Bob", status: "banned", note: "spam", first_seen_at: "2026-01-01T00:00:00.000Z", last_seen_at: "2026-01-03T00:00:00.000Z" },
    ],
    groups: [
      { chat_id: -1001, title: "G1", username: null, chat_type: "supergroup", status: "active", timezone: "UTC", owner_user_id: 11, added_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" },
    ],
  },
});

test("exportBackup dumps all operational tables under the pre-crime envelope", async () => {
  const sql = mockSql({
    "FROM bot_users": [{ telegram_user_id: 1, display_name: "U" }],
    "FROM bot_admins": [{ telegram_user_id: 2 }],
    "FROM licenses": [{ id: 3, code: "X" }],
    "FROM broadcasts": [{ id: 4 }],
    "FROM system_settings": [{ key: "k", value: {} }],
    "FROM groups": [{ chat_id: -5 }],
    "FROM audit_events": [{ id: 6 }],
  });
  const store = createAdminStore(sql);
  const dump = await store.exportBackup();

  assert.equal(dump.app, "pre-crime");
  assert.equal(dump.version, 1);
  assert.ok(typeof dump.exported_at === "string");
  const tables = dump.tables;
  for (const name of ["bot_users", "bot_admins", "licenses", "broadcasts", "system_settings", "groups", "audit_events"]) {
    assert.ok(Array.isArray(tables[name]), `missing table ${name}`);
  }
  assert.equal(tables.bot_users.length, 1);
  assert.equal(tables.audit_events.length, 1);
});

test("importBackup replaces only the tables present in the backup and re-syncs sequences", async () => {
  const sql = mockSql();
  const store = createAdminStore(sql);
  const restored = await store.importBackup(JSON.parse(validBackup));

  assert.deepEqual(restored, ["bot_users(2)", "groups(1)"]);

  const deletes = sql.calls.filter((c) => c.query.startsWith("DELETE FROM")).map((c) => c.query);
  assert.deepEqual(deletes, ["DELETE FROM bot_users", "DELETE FROM groups"]);

  const userInserts = sql.calls.filter((c) => c.query.includes("INSERT INTO bot_users"));
  assert.equal(userInserts.length, 2);
  assert.equal(userInserts[0].values[0], 11);
  assert.equal(userInserts[0].values[1], "alice");
  assert.equal(userInserts[1].values[3], "banned");
  assert.ok(userInserts[0].query.includes("ON CONFLICT (telegram_user_id) DO NOTHING"));

  const groupInserts = sql.calls.filter((c) => c.query.includes("INSERT INTO groups"));
  assert.equal(groupInserts.length, 1);
  assert.equal(groupInserts[0].values[0], -1001);

  // Tables absent from the backup must NOT be touched.
  assert.ok(!sql.calls.some((c) => c.query.includes("DELETE FROM licenses")));
  assert.ok(!sql.calls.some((c) => c.query.includes("INSERT INTO licenses")));

  // Identity sequences are always re-synced after a restore.
  const setvals = sql.calls.filter((c) => c.query.includes("setval"));
  assert.equal(setvals.length, 3);
});

test("importBackup ignores unknown tables and non-array payloads", async () => {
  const sql = mockSql();
  const store = createAdminStore(sql);
  const restored = await store.importBackup({
    app: "pre-crime",
    tables: { telegram_updates: [{ id: 1 }], bot_users: "not-an-array" },
  });
  assert.deepEqual(restored, []);
  assert.ok(!sql.calls.some((c) => c.query.startsWith("DELETE FROM")));
});

test("restoreBackup rejects a non-JSON file without touching the store", async () => {
  let importCalled = false;
  const store = { async importBackup() { importCalled = true; return []; } };
  const result = await restoreBackup(store, mockBot("not json {{{"), { file_id: "FILE_1", file_name: "x.json" });
  assert.equal(result.ok, false);
  assert.match(result.error, /JSON/);
  assert.equal(importCalled, false);
});

test("restoreBackup rejects a backup from another app", async () => {
  let importCalled = false;
  const store = { async importBackup() { importCalled = true; return []; } };
  const result = await restoreBackup(store, mockBot(JSON.stringify({ app: "other-bot", tables: {} })), { file_id: "FILE_1", file_name: "x.json" });
  assert.equal(result.ok, false);
  assert.match(result.error, /ليس نسخة احتياطية/);
  assert.equal(importCalled, false);
});

test("restoreBackup rejects files larger than 20MB before downloading", async () => {
  let downloaded = false;
  const bot = {
    async getFile() { downloaded = true; return { file_path: "x" }; },
    async downloadFile() { downloaded = true; return ""; },
  };
  const result = await restoreBackup({}, bot, { file_id: "FILE_1", file_name: "big.json", file_size: 21 * 1024 * 1024 });
  assert.equal(result.ok, false);
  assert.match(result.error, /20/);
  assert.equal(downloaded, false);
});

test("restoreBackup happy path imports a valid pre-crime backup", async () => {
  let imported = null;
  const store = { async importBackup(data) { imported = data; return ["bot_users(2)", "groups(1)"]; } };
  const result = await restoreBackup(store, mockBot(validBackup), { file_id: "FILE_1", file_name: "backup.json", file_size: validBackup.length });
  assert.equal(result.ok, true);
  assert.deepEqual(result.restored, ["bot_users(2)", "groups(1)"]);
  assert.equal(imported.app, "pre-crime");
  assert.equal(imported.tables.bot_users.length, 2);
});
