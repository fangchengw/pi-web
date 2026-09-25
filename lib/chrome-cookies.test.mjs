import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./chrome-cookies.ts");
}

const { decryptChromeValue, scanCookiesFromDb, readChromeCookieHeader } = await loadSubject();

const PASSWORD = "peanuts";
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
/** Chrome stores cookie expiry as microseconds since 1601 — always > 2^53. */
const chromeMicros = (ms) => BigInt(Math.round(ms + CHROME_EPOCH_OFFSET_MS)) * 1000n;

// Mirror Chrome's os_crypt format: 3-byte version prefix + base64 payload.
// This locks the wire format against silent refactors; compatibility with real
// Chrome data is covered by the live E2E, not here.
function encV10(value, password = PASSWORD) {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), Buffer.from(data.toString("base64"), "latin1")]);
}

function encV11(value, password = PASSWORD) {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 32, "sha1");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const blob = Buffer.concat([nonce, data, cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from("v11", "latin1"), Buffer.from(blob.toString("base64"), "latin1")]);
}

function makeProfileDb(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "Cookies");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT, encrypted_value BLOB, expires_utc INTEGER NOT NULL)"
  );
  const stmt = db.prepare(
    "INSERT INTO cookies (host_key, name, value, encrypted_value, expires_utc) VALUES (?, ?, ?, ?, ?)"
  );
  for (const row of rows) stmt.run(row.host, row.name, row.value ?? null, row.encrypted ?? null, row.expires);
  db.close();
  return dbPath;
}

const tomorrow = () => chromeMicros(Date.now() + 86_400_000);
const yesterday = () => chromeMicros(Date.now() - 86_400_000);

test("decryptChromeValue round-trips v10 and v11 blobs", () => {
  assert.equal(decryptChromeValue(encV10("serviceToken=abc123"), PASSWORD), "serviceToken=abc123");
  assert.equal(decryptChromeValue(encV11("ünïcode ✓ 套餐"), PASSWORD), "ünïcode ✓ 套餐");
});

test("decryptChromeValue rejects wrong passwords and malformed blobs", () => {
  assert.equal(decryptChromeValue(encV11("secret"), "not-the-password"), null); // GCM auth is deterministic
  assert.equal(decryptChromeValue(Buffer.from("v99bG9jYWw=", "latin1"), PASSWORD), null); // unknown version
  assert.equal(decryptChromeValue(Buffer.from("v1", "latin1"), PASSWORD), null); // truncated prefix
  assert.equal(decryptChromeValue(Buffer.from("v10!!!not-base64-junk!!!", "latin1"), PASSWORD), null);
});

test("scanCookiesFromDb filters by host and expiry while surviving BigInt timestamps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-fixture-"));
  const dbPath = path.join(dir, "Cookies");
  try {
    makeProfileDb(dir, [
      { host: ".xiaomimimo.com", name: "serviceToken", encrypted: encV10("live-token"), expires: tomorrow() },
      { host: "platform.xiaomimimo.com", name: "userId", value: "42", expires: tomorrow() },
      { host: ".xiaomimimo.com", name: "old", encrypted: encV10("stale"), expires: yesterday() },
      { host: ".example.com", name: "serviceToken", encrypted: encV10("other-site"), expires: tomorrow() },
      { host: ".xiaomimimo.com", name: "sid", encrypted: encV11("session-cookie"), expires: 0n },
    ]);

    const scan = scanCookiesFromDb(dbPath, "xiaomimimo.com", PASSWORD);
    assert.match(scan.header, /serviceToken=live-token/);
    assert.match(scan.header, /userId=42/);
    assert.match(scan.header, /sid=session-cookie/); // expires_utc = 0 is a session cookie: keep it
    assert.doesNotMatch(scan.header, /stale/); // expired
    assert.doesNotMatch(scan.header, /other-site/); // wrong host
    assert.equal(scan.matched, 4); // LIKE excludes .example.com
    assert.equal(scan.decrypted, 3); // expired row skipped before decrypt
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scanCookiesFromDb degrades to plaintext when decryption fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-fixture-"));
  const dbPath = path.join(dir, "Cookies");
  try {
    makeProfileDb(dir, [
      { host: ".xiaomimimo.com", name: "serviceToken", encrypted: encV10("locked"), expires: tomorrow() },
      { host: ".xiaomimimo.com", name: "userId", value: "42", expires: tomorrow() },
    ]);
    const scan = scanCookiesFromDb(dbPath, "xiaomimimo.com", "wrong-password");
    assert.match(scan.header, /userId=42/);
    assert.doesNotMatch(scan.header, /locked/);
    assert.equal(scan.matched, 2);
    assert.equal(scan.decrypted, 1); // the signal that triggers a Keychain retry
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readChromeCookieHeader walks profiles in order and returns the first hit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-root-"));
  try {
    makeProfileDb(path.join(root, "Profile 10"), [
      { host: ".xiaomimimo.com", name: "serviceToken", encrypted: encV10("profile-ten"), expires: tomorrow() },
    ]);
    makeProfileDb(path.join(root, "Profile 1"), [
      { host: ".xiaomimimo.com", name: "serviceToken", encrypted: encV10("profile-one"), expires: tomorrow() },
    ]);
    makeProfileDb(path.join(root, "Default"), [
      { host: ".xiaomimimo.com", name: "serviceToken", encrypted: encV10("profile-default"), expires: tomorrow() },
    ]);

    assert.match(await readChromeCookieHeader("xiaomimimo.com", { root }), /profile-default/);

    // Remove Default: numeric ordering must put Profile 1 before Profile 10.
    fs.rmSync(path.join(root, "Default"), { recursive: true });
    assert.match(await readChromeCookieHeader("xiaomimimo.com", { root }), /profile-one/);

    fs.rmSync(path.join(root, "Profile 1"), { recursive: true });
    assert.match(await readChromeCookieHeader("xiaomimimo.com", { root }), /profile-ten/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readChromeCookieHeader returns null for missing roots and cookie-less profiles", async () => {
  assert.equal(await readChromeCookieHeader("xiaomimimo.com", { root: path.join(os.tmpdir(), "no-such-chrome") }), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-root-"));
  try {
    makeProfileDb(path.join(root, "Default"), [
      { host: ".example.com", name: "other", encrypted: encV10("x"), expires: tomorrow() },
    ]);
    assert.equal(await readChromeCookieHeader("xiaomimimo.com", { root }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readChromeCookieHeader degrades to null when the root is unreadable (TCC-style EPERM)", async () => {
  // TCC lets stat succeed but denies readdir — chmod reproduces the same throw path.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-denied-"));
  const saved = fs.statSync(root).mode;
  try {
    fs.chmodSync(root, 0);
    assert.equal(await readChromeCookieHeader("xiaomimimo.com", { root }), null);
  } finally {
    fs.chmodSync(root, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readChromeCookieHeader retries the Keychain password once when peanuts fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-root-"));
  try {
    makeProfileDb(path.join(root, "Default"), [
      { host: ".xiaomimimo.com", name: "serviceToken", encrypted: encV10("keychain-token", "rotated-pass"), expires: tomorrow() },
    ]);

    // Keychain offers nothing: the undecryptable cookie is simply dropped.
    assert.equal(
      await readChromeCookieHeader("xiaomimimo.com", { root, getKeychainPassword: async () => null }),
      null
    );
    // A Keychain password identical to the default would be a pointless retry.
    assert.equal(
      await readChromeCookieHeader("xiaomimimo.com", { root, getKeychainPassword: async () => PASSWORD }),
      null
    );
    // The real rotation case: one Keychain read unlocks the header.
    assert.match(
      await readChromeCookieHeader("xiaomimimo.com", { root, getKeychainPassword: async () => "rotated-pass" }),
      /serviceToken=keychain-token/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
