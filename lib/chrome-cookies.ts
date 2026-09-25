import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Read cookies straight out of Chrome's on-disk Cookies database so quota
 * queries can run as plain HTTP without the opencli browser relay.
 *
 * Chrome stores values as "v10" (AES-128-CBC) or "v11" (AES-256-GCM) blobs
 * keyed by the "Chrome Safe Storage" Keychain password — which defaults to
 * "peanuts" and is rarely rotated, so that is tried first and never prompts;
 * a Keychain read (one GUI approval, then cached) is the fallback.
 *
 * Every failure degrades to `null`, which sends the caller back to the
 * browser relay: reading Chrome is an optimization, never a requirement.
 *
 * macOS TCC guards ~/Library/Application Support/Google, so the node binary
 * needs Full Disk Access or every read here fails closed.
 */

const CHROME_ROOT = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
/** Keychain password Chrome creates the Safe Storage item with by default. */
const DEFAULT_KEYCHAIN_PASSWORD = "peanuts";
const KEYCHAIN_PROMPT_TIMEOUT_MS = 15_000;
/** Chrome epoch: cookie timestamps are microseconds since 1601-01-01. */
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

export interface DbCookieScan {
  /** "name=value; ..." for matching hosts, or null when nothing usable. */
  header: string | null;
  matched: number;
  decrypted: number;
}

interface CookieRow {
  name: string;
  value: string | null;
  encrypted_value: Uint8Array | null;
  expires_utc: number | bigint;
}

/** PBKDF2-SHA1 derivation Chrome's os_crypt uses on macOS. */
function deriveKey(password: string, bytes: number): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, bytes, "sha1");
}

/** Decrypt one Chrome encrypted_value ("v10"/"v11" + base64). Null if undecodable. */
export function decryptChromeValue(blob: Uint8Array, password: string): string | null {
  const buf = Buffer.from(blob);
  if (buf.length <= 3) return null;
  const prefix = buf.subarray(0, 3).toString("latin1");
  const data = Buffer.from(buf.subarray(3).toString("latin1"), "base64");
  try {
    if (prefix === "v10") {
      const decipher = createDecipheriv("aes-128-cbc", deriveKey(password, 16), Buffer.alloc(16));
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    }
    if (prefix === "v11") {
      if (data.length < 29) return null; // 12-byte nonce + tag + at least one block
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(password, 32), data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(data.length - 16));
      return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
    }
  } catch {
    // Wrong password or truncated blob — treat as undecodable, not fatal.
  }
  return null;
}

/** null means a session cookie (keep it); otherwise an absolute expiry in ms. */
function chromeExpiryMs(expiresUtc: number | bigint): number | null {
  const micros = Number(expiresUtc);
  return micros <= 0 ? null : micros / 1000 - CHROME_EPOCH_OFFSET_MS;
}

/**
 * Scan one Cookies DB for `hostSuffix` domains. Expired cookies are dropped
 * and undecryptable values skipped, so a partial header still gets a chance —
 * `matched`/`decrypted` let the caller decide whether a Keychain retry is
 * worth prompting for.
 */
export function scanCookiesFromDb(dbPath: string, hostSuffix: string, password: string, now = Date.now()): DbCookieScan {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare("SELECT name, value, encrypted_value, expires_utc FROM cookies WHERE host_key LIKE ?1");
    // expires_utc is microseconds since 1601 — beyond 2^53, so node:sqlite
    // throws "Value is too large" unless integers are read as BigInt.
    stmt.setReadBigInts(true);
    const rows = stmt.all(`%${hostSuffix}`) as unknown as CookieRow[];
    let matched = 0;
    let decrypted = 0;
    const pairs: string[] = [];
    for (const row of rows) {
      matched += 1;
      const expiry = chromeExpiryMs(row.expires_utc);
      if (expiry !== null && expiry <= now) continue;
      let value = row.value ?? "";
      if (row.encrypted_value && row.encrypted_value.byteLength > 3) {
        const plain = decryptChromeValue(row.encrypted_value, password);
        if (plain === null) continue;
        value = plain;
      }
      if (value) {
        decrypted += 1;
        pairs.push(`${row.name}=${value}`);
      }
    }
    return { header: pairs.length > 0 ? pairs.join("; ") : null, matched, decrypted };
  } finally {
    db.close();
  }
}

/** Cookies live at Chrome/<Profile>/Cookies — Default first, then Profile N.
 * readdir can throw EPERM under TCC even when stat succeeds, so a denied
 * root degrades to "no profiles" instead of propagating. */
function profileDbPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // TCC denial: stat passed, scandir did not.
  }
  const profiles = entries.filter((entry) => entry === "Default" || /^Profile \d+$/.test(entry));
  profiles.sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : a.localeCompare(b, undefined, { numeric: true })));
  return profiles.map((entry) => path.join(root, entry, "Cookies")).filter(existsSync);
}

/**
 * A live WAL database sometimes refuses a direct readonly open — fall back to
 * copying the WAL triad into /tmp (never the repo: file events there retrigger
 * the dev server) and reading the snapshot.
 */
function withDbCopy<T>(dbPath: string, run: (dbPath: string) => T): T | null {
  try {
    return run(dbPath);
  } catch {
    try {
      const dir = mkdtempSync(path.join(os.tmpdir(), "chrome-cookies-"));
      try {
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, path.join(dir, "Cookies" + suffix));
        }
        return run(path.join(dir, "Cookies"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      return null;
    }
  }
}

let keychainQuery: Promise<string | null> | null = null;

/** Resolves the Safe Storage password once per process; a timed-out or
 * declined prompt is cached too, so a missing approval can never stall
 * every later quota refresh. */
function defaultKeychainPassword(): Promise<string | null> {
  keychainQuery ??= new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
      { timeout: KEYCHAIN_PROMPT_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    );
  });
  return keychainQuery;
}

export interface ChromeCookieOptions {
  /** Chrome data dir — fixtures/tests point this elsewhere. */
  root?: string;
  /** Keychain password source; defaults to one cached `security` call. */
  getKeychainPassword?: () => Promise<string | null>;
}

/**
 * Cookie header for `hostSuffix` hosts from the first Chrome profile that has
 * one, or null (no profile, TCC denial, undecodable, nothing matched). Callers
 * must treat null as "use the fallback path", never as an error.
 */
export async function readChromeCookieHeader(
  hostSuffix: string,
  options: ChromeCookieOptions = {}
): Promise<string | null> {
  const root = options.root ?? CHROME_ROOT;
  const getKeychainPassword = options.getKeychainPassword ?? defaultKeychainPassword;
  for (const dbPath of profileDbPaths(root)) {
    const scan = withDbCopy(dbPath, (db) => scanCookiesFromDb(db, hostSuffix, DEFAULT_KEYCHAIN_PASSWORD));
    if (scan === null) continue;
    if (scan.header !== null) return scan.header;
    if (scan.matched === 0 || scan.decrypted > 0) continue;
    // Cookies exist but "peanuts" opened none of them: ask the Keychain once.
    const password = await getKeychainPassword();
    if (password === null || password === DEFAULT_KEYCHAIN_PASSWORD) continue;
    const retry = withDbCopy(dbPath, (db) => scanCookiesFromDb(db, hostSuffix, password));
    if (retry !== null && retry.header !== null) return retry.header;
  }
  return null;
}
