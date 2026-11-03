const test = require("node:test");
const assert = require("node:assert/strict");
const { readJsonBody } = require("../.test-build/http-security.js");

test("bounded JSON reader accepts valid small JSON", async () => {
  const request = new Request("https://example.test/hook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update_id: 7 }),
  });
  assert.deepEqual(await readJsonBody(request, 100), { ok: true, value: { update_id: 7 } });
});

test("bounded JSON reader rejects declared oversized payloads before reading", async () => {
  const request = new Request("https://example.test/hook", {
    method: "POST",
    headers: { "content-length": "1000" },
    body: "{}",
  });
  assert.deepEqual(await readJsonBody(request, 100), { ok: false, status: 413 });
});

test("bounded JSON reader rejects oversized chunked payloads", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(101)));
      controller.close();
    },
  });
  const request = new Request("https://example.test/hook", { method: "POST", body, duplex: "half" });
  assert.deepEqual(await readJsonBody(request, 100), { ok: false, status: 413 });
});

test("bounded JSON reader rejects malformed JSON and invalid UTF-8", async () => {
  const malformed = new Request("https://example.test/hook", { method: "POST", body: "{" });
  assert.deepEqual(await readJsonBody(malformed), { ok: false, status: 400 });
  const invalidUtf8 = new Request("https://example.test/hook", {
    method: "POST",
    body: new Uint8Array([0xff, 0xfe]),
  });
  assert.deepEqual(await readJsonBody(invalidUtf8), { ok: false, status: 400 });
});
