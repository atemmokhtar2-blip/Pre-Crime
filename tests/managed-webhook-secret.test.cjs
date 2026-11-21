const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveManagedWebhookSecret, deriveManagedWebhookSecretCandidates, getManagedWebhookMasterSecrets, getPreferredManagedWebhookMasterSecret } = require("../.test-build/managed-webhook-secret.js");

test("managed webhook secrets are deterministic for one bot", () => {
  const a = deriveManagedWebhookSecret("x".repeat(48), 123456);
  const b = deriveManagedWebhookSecret("x".repeat(48), 123456);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("managed webhook secrets are isolated across bot IDs", () => {
  const master = "x".repeat(48);
  assert.notEqual(deriveManagedWebhookSecret(master, 111), deriveManagedWebhookSecret(master, 222));
});

test("managed webhook secrets change when the master secret changes", () => {
  assert.notEqual(deriveManagedWebhookSecret("a".repeat(48), 111), deriveManagedWebhookSecret("b".repeat(48), 111));
});

test("invalid bot IDs and weak master secrets fail closed", () => {
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => deriveManagedWebhookSecret("x".repeat(48), id));
  }
  assert.throws(() => deriveManagedWebhookSecret("short", 111));
});

test("dedicated managed webhook master secret is preferred", () => {
  const managed = "m".repeat(48);
  const telegram = "t".repeat(48);
  assert.equal(getPreferredManagedWebhookMasterSecret(managed, telegram), managed);
});

test("primary Telegram webhook secret remains a fallback for managed bots", () => {
  const telegram = "t".repeat(48);
  assert.equal(getPreferredManagedWebhookMasterSecret(null, telegram), telegram);
  assert.equal(getPreferredManagedWebhookMasterSecret("", telegram), telegram);
});

test("managed webhook accepts derived secrets from both configured master keys", () => {
  const managed = "m".repeat(48);
  const telegram = "t".repeat(48);
  const secrets = getManagedWebhookMasterSecrets(managed, telegram);
  const candidates = deriveManagedWebhookSecretCandidates(8513638463, secrets);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.includes(deriveManagedWebhookSecret(managed, 8513638463)));
  assert.ok(candidates.includes(deriveManagedWebhookSecret(telegram, 8513638463)));
});

test("duplicate and weak managed webhook master secrets are excluded", () => {
  const shared = "s".repeat(48);
  assert.deepEqual(getManagedWebhookMasterSecrets(shared, shared), [shared]);
  assert.deepEqual(getManagedWebhookMasterSecrets("short", null), []);
});
