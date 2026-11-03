const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateProtection, extractSignal } = require("../.test-build/protection.js");

function policy(overrides = {}) {
  return {
    antiSpam: { enabled: true, threshold: 2, windowSeconds: 10 },
    antiLinks: { enabled: false, whitelist: [] },
    antiForward: { enabled: false },
    antiDuplicate: { enabled: false },
    wordFilter: { enabled: false, words: [] },
    antiFlood: { enabled: true, maxMessages: 2, windowSeconds: 5 },
    punishment: { action: "warn", warningsBeforeAction: 3 },
    ...overrides,
  };
}

test("anti-spam and anti-flood use their own configured windows", () => {
  const recent = [{ at: 3_000, text: "old message" }];
  const result = evaluateProtection(policy(), { text: "new message", hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false }, recent, 10_000);
  assert.deepEqual(result, ["spam"]);
});

test("modern Telegram forward_origin is detected", () => {
  const signal = extractSignal({ message_id: 1, chat: { id: -1001, type: "supergroup" }, forward_origin: { type: "hidden_user" } });
  assert.equal(signal.hasForward, true);
});

test("forward detection remains compatible with legacy fields", () => {
  const signal = extractSignal({ message_id: 1, chat: { id: -1001, type: "supergroup" }, forward_from_chat: { id: -1002 } });
  assert.equal(signal.hasForward, true);
});


test("detects naked domains and Telegram links without URL entities", () => {
  assert.equal(extractSignal({ message_id: 1, chat: { id: -1001, type: "supergroup" }, text: "join t.me/example" }).hasUrl, true);
  assert.equal(extractSignal({ message_id: 2, chat: { id: -1001, type: "supergroup" }, text: "visit example.com now" }).hasUrl, true);
});

test("detects hidden text links and allows only exact whitelisted hosts or subdomains", () => {
  const signal = extractSignal({
    message_id: 3,
    chat: { id: -1001, type: "supergroup" },
    text: "اضغط هنا",
    entities: [{ type: "text_link", url: "https://news.example.com/path" }],
  });
  assert.equal(signal.hasUrl, true);
  assert.deepEqual(evaluateProtection(policy({ antiLinks: { enabled: true, whitelist: ["example.com"] } }), signal, [], 1000), []);
  assert.deepEqual(evaluateProtection(policy({ antiLinks: { enabled: true, whitelist: ["example.com"] } }), extractSignal({ message_id: 4, chat: { id: -1001, type: "supergroup" }, text: "evil-example.com" }), [], 1000), ["link"]);
});

test("Arabic word filter ignores tashkeel and common alef variants", () => {
  const result = evaluateProtection(policy({ wordFilter: { enabled: true, words: ["إهانة"] } }), { text: "اهانة", hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false }, [], 1000);
  assert.deepEqual(result, ["word"]);
});


test("built-in Arabic profanity is detected even before custom words are added", () => {
  const result = evaluateProtection(policy({ wordFilter: { enabled: true, words: [] } }), { text: "كسمك", hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false }, [], 1000);
  assert.deepEqual(result, ["word"]);
});

test("Arabic profanity evasion using spaces, tatweel, and diacritics is detected", () => {
  for (const text of ["ك س م ك", "كـسـمـك", "كُسْمَك"]) {
    const result = evaluateProtection(policy({ wordFilter: { enabled: true, words: [] } }), { text, hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false }, [], 1000);
    assert.deepEqual(result, ["word"], text);
  }
});

test("custom phrases are normalized but harmless words are not broadly blocked", () => {
  const enabled = policy({ wordFilter: { enabled: true, words: ["إهانة"] } });
  const signal = (text) => ({ text, hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false });
  assert.deepEqual(evaluateProtection(enabled, signal("اهانة"), [], 1000), ["word"]);
  assert.deepEqual(evaluateProtection(enabled, signal("الاهتمام بالتعليم"), [], 1000), []);
});


test("detects Arabizi and digit substitutions", () => {
  const enabled = policy({ wordFilter: { enabled: true, words: [] } });
  for (const text of ["ksmk", "كسمك", "كُسْمَك"]) {
    const result = evaluateProtection(enabled, { text, hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false }, [], 1000);
    assert.deepEqual(result, ["word"], text);
  }
});

test("detects punctuation and short-separator obfuscation", () => {
  const enabled = policy({ wordFilter: { enabled: true, words: [] } });
  for (const text of ["ك س م ك", "كـسـمـك", "ك*س*م*ك"]) {
    const result = evaluateProtection(enabled, { text, hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false }, [], 1000);
    assert.deepEqual(result, ["word"], text);
  }
});

test("fuzzy matching catches one-character typo in longer custom words without broad substring blocking", () => {
  const enabled = policy({ wordFilter: { enabled: true, words: ["شرموط"] } });
  const signal = (text) => ({ text, hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false });
  assert.deepEqual(evaluateProtection(enabled, signal("شرموطه"), [], 1000), ["word"]);
  assert.deepEqual(evaluateProtection(enabled, signal("الشرموطية؟"), [], 1000), []);
});


test("detects repeated-letter evasion and adjacent transposition", () => {
  const enabled = policy({ wordFilter: { enabled: true, words: ["شرموط"] } });
  const signal = (text) => ({ text, hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false });
  assert.deepEqual(evaluateProtection(enabled, signal("شــــرررمووووط"), [], 1000), ["word"]);
  assert.deepEqual(evaluateProtection(enabled, signal("شرموت"), [], 1000), ["word"]);
});

test("matches multi-word abusive phrases as consecutive words", () => {
  const enabled = policy({ wordFilter: { enabled: true, words: ["يا ابن الكلب"] } });
  const signal = { text: "انت يا ابن الكلب اسكت", hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false };
  assert.deepEqual(evaluateProtection(enabled, signal, [], 1000), ["word"]);
});

test("does not fuzzy-match short or unrelated ordinary words", () => {
  const enabled = policy({ wordFilter: { enabled: true, words: ["كسمك"] } });
  const signal = (text) => ({ text, hasUrl: false, hasForward: false, hasMedia: false, hasDocument: false });
  assert.deepEqual(evaluateProtection(enabled, signal("مساكم جميل"), [], 1000), []);
  assert.deepEqual(evaluateProtection(enabled, signal("كلام جميل"), [], 1000), []);
});


test("detects obfuscated links with zero-width characters, dot disguises and hxxp schemes", () => {
  for (const text of [
    "hxxps://evil.example/path",
    "evil[.]example/path",
    "evil (.) example/path",
    "evil\\u200b.example/path",
    "www.example.photography",
  ]) {
    assert.equal(extractSignal({ message_id: 5, chat: { id: -1001, type: "supergroup" }, text }).hasUrl, true, text);
  }
});

test("extracts URL entities by offset and length and preserves hidden text links", () => {
  const visible = extractSignal({
    message_id: 6,
    chat: { id: -1001, type: "supergroup" },
    text: "open example.com",
    entities: [{ type: "url", offset: 5, length: 11 }],
  });
  assert.equal(visible.hasUrl, true);
  const hidden = extractSignal({
    message_id: 7,
    chat: { id: -1001, type: "supergroup" },
    text: "click here",
    entities: [{ type: "text_link", offset: 6, length: 4, url: "https://malware.example/a" }],
  });
  assert.equal(hidden.hasUrl, true);
  assert.deepEqual(evaluateProtection(policy({ antiLinks: { enabled: true, whitelist: [] } }), hidden, [], 1000), ["link"]);
});

test("recognizes Telegram video notes and paid media as media attachments", () => {
  assert.equal(extractSignal({ message_id: 8, chat: { id: -1001, type: "supergroup" }, video_note: {} }).hasMedia, true);
  assert.equal(extractSignal({ message_id: 9, chat: { id: -1001, type: "supergroup" }, paid_media: {} }).hasMedia, true);
  assert.equal(extractSignal({ message_id: 10, chat: { id: -1001, type: "supergroup" }, document: {} }).hasDocument, true);
});

const { shouldDeleteImage, inspectMedia } = require("../.test-build/engines/media-engine.js");
const { inspectFile } = require("../.test-build/engines/file-engine.js");

test("media engine classifies attachments independently", () => {
  const signal = inspectMedia({ message_id: 20, chat: { id: -1001, type: "supergroup" }, photo: [{}], caption: "صورة" });
  assert.equal(signal.hasPhoto, true);
  assert.equal(signal.hasCaption, true);
  assert.deepEqual(signal.kind, ["photo"]);
});

test("image filter never deletes captioned photos or mixed media", () => {
  const chat = { id: -1001, type: "supergroup" };
  assert.equal(shouldDeleteImage({ message_id: 21, chat, photo: [{}], caption: "وصف الصورة" }), false);
  assert.equal(shouldDeleteImage({ message_id: 22, chat, photo: [{}], video: {} }), false);
  assert.equal(shouldDeleteImage({ message_id: 23, chat, video: {} }), false);
});

test("image filter only removes a standalone photo with no caption", () => {
  assert.equal(shouldDeleteImage({ message_id: 24, chat: { id: -1001, type: "supergroup" }, photo: [{}] }), true);
});

test("file engine reads document metadata without classifying it as media", () => {
  const message = { message_id: 25, chat: { id: -1001, type: "supergroup" }, document: { file_name: "report.pdf", mime_type: "application/pdf", file_size: 1200 } };
  assert.equal(inspectFile(message).hasFile, true);
  assert.equal(inspectFile(message).fileName, "report.pdf");
  assert.equal(extractSignal(message).hasDocument, true);
  assert.equal(extractSignal(message).hasMedia, false);
});
