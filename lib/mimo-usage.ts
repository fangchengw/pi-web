import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * MiMo Token Plan quota (platform.xiaomimimo.com).
 *
 * The platform API only accepts the browser session cookie (httpOnly
 * `api-platform_serviceToken`), so with no cookie override configured we
 * relay the query through the user's logged-in Chrome via `opencli browser
 * mimo eval` — the page fetches the API same-origin and returns the JSON.
 */

export { formatTokens } from "./mimo-format";

const PLATFORM_ORIGIN = "https://platform.xiaomimimo.com";
const API_BASE = `${PLATFORM_ORIGIN}/api/v1`;
const COOKIE_ENV_VAR = "MIMO_PLATFORM_COOKIE";
const RELAY_SESSION = "mimo";
const RELAY_SENTINEL = "MIMOQUOTA";
/** The eval snippet reports this instead of firing a CORS-blocked fetch when
 * the bound tab is no longer on the platform origin. */
const RELAY_WRONG_PAGE = `${RELAY_SENTINEL}WRONGPAGE:`;
const RELAY_ERROR = `${RELAY_SENTINEL}ERROR:`;
const RELAY_TIMEOUT_MS = 15_000;
/** Navigating to the platform waits for a full page load — give it more room
 * than a plain eval, which only has to answer three same-origin fetches. */
const RELAY_OPEN_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 10_000;

export interface MimoQuota {
  planName: string | null;
  planCode: string | null;
  /** Overall plan usage percent, 0-100. */
  planPercent: number;
  planUsed: number;
  planLimit: number;
  /** Compensation credits (compensation_total_token), null when not granted. */
  compensation: { used: number; limit: number; percent: number } | null;
  /** Pay-as-you-go balance (separate from the token plan). */
  balance: { total: number; currency: string } | null;
  periodEnd: number | null;
  daysLeft: number | null;
  expired: boolean;
  capturedAt: number;
}

export type MimoUsageResult =
  | { status: "ready"; quota: MimoQuota }
  | { status: "auth-unavailable" | "query-failed"; message: string };

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function dig(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse platform timestamps like "2026-10-23 23:59:59".
 * The platform serves Asia/Shanghai wall time — pin the offset so the
 * countdown does not shift with the server machine's timezone.
 */
export function parseMimoPeriodEnd(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const iso = raw.trim().replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}+08:00`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : ms;
}

export function daysLeftFrom(periodEnd: number, now: number): number {
  return Math.max(0, Math.ceil((periodEnd - now) / 86_400_000));
}

function itemPercent(item: Json, used: number, limit: number): number {
  const raw = finiteNumber(item.percent);
  const fraction = raw !== null && raw <= 1 ? raw : limit > 0 ? used / limit : 0;
  return Math.min(100, Math.max(0, fraction * 100));
}

/** Project the relayed {usage, detail, balance} envelope into the quota view. */
export function projectMimoQuota(
  envelope: unknown,
  now: number = Date.now()
): { kind: "ok"; quota: MimoQuota } | { kind: "auth" } | null {
  const env = asRecord(envelope);
  if (!env) return null;
  const usage = asRecord(env.usage);
  const detail = asRecord(env.detail);
  const balancePayload = asRecord(env.balance);
  const codes = [usage, detail, balancePayload].map((payload) =>
    payload ? finiteNumber(payload.code) : null
  );
  if (codes.some((code) => code === 401)) return { kind: "auth" };
  if (!usage || codes[0] !== 0) return null;

  const items = dig(usage, "data", "usage", "items");
  const list = (Array.isArray(items) ? items : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Json => entry !== null);
  const planItem =
    list.find((entry) => entry.name === "plan_total_token") ??
    list.find((entry) => entry.name === "month_total_token") ??
    null;
  if (!planItem) return null;

  const planUsed = finiteNumber(planItem.used) ?? 0;
  const planLimit = finiteNumber(planItem.limit) ?? 0;
  const planPercent = planLimit > 0 ? itemPercent(planItem, planUsed, planLimit) : 0;

  const compItem = list.find((entry) => entry.name === "compensation_total_token") ?? null;
  const compLimit = compItem ? finiteNumber(compItem.limit) ?? 0 : 0;
  const compUsed = compItem ? finiteNumber(compItem.used) ?? 0 : 0;
  const compensation =
    compItem && compLimit > 0
      ? { used: compUsed, limit: compLimit, percent: itemPercent(compItem, compUsed, compLimit) }
      : null;

  const periodEnd = parseMimoPeriodEnd(dig(detail, "data", "currentPeriodEnd"));
  const planNameValue = dig(detail, "data", "planName");
  const planCodeValue = dig(detail, "data", "planCode");
  const expired = dig(detail, "data", "expired") === true;

  let balance: MimoQuota["balance"] = null;
  if (balancePayload && codes[2] === 0) {
    const total = Number(dig(balancePayload, "data", "balance"));
    const currencyValue = dig(balancePayload, "data", "currency");
    if (Number.isFinite(total)) {
      balance = { total, currency: typeof currencyValue === "string" && currencyValue ? currencyValue : "USD" };
    }
  }

  return {
    kind: "ok",
    quota: {
      planName: typeof planNameValue === "string" && planNameValue ? planNameValue : null,
      planCode: typeof planCodeValue === "string" && planCodeValue ? planCodeValue : null,
      planPercent,
      planUsed,
      planLimit,
      compensation,
      balance,
      periodEnd,
      daysLeft: periodEnd !== null ? daysLeftFrom(periodEnd, now) : null,
      expired,
      capturedAt: now,
    },
  };
}

/**
 * Cookie override: `MIMO_PLATFORM_COOKIE` env var, otherwise
 * `~/.pi/agent/mimo-platform-cookie.json` `{"cookie": "..."}`.
 */
export function resolveMimoCookie(
  options: { env?: Record<string, string | undefined>; cookieFilePath?: string } = {}
): string | null {
  const env = options.env ?? process.env;
  const fromEnv = env[COOKIE_ENV_VAR]?.trim();
  if (fromEnv) return fromEnv;
  const cookieFilePath = options.cookieFilePath ?? path.join(os.homedir(), ".pi", "agent", "mimo-platform-cookie.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cookieFilePath, "utf8"));
    const cookie = asRecord(parsed)?.cookie;
    if (typeof cookie === "string" && cookie.trim()) return cookie.trim();
  } catch {
    // Missing/unreadable override means "use the browser relay".
  }
  return null;
}

/**
 * Runs in the bound tab, so it must stay same-origin: a cross-origin fetch to
 * the platform API fails outright ("Failed to fetch"), which used to masquerade
 * as an expired session. Probe the origin first and report WRONGPAGE so the
 * caller can reopen the platform page instead of guessing.
 */
const RELAY_SNIPPET =
  `(location.origin==='${PLATFORM_ORIGIN}'?` +
  `Promise.all([` +
  `fetch('${API_BASE}/tokenPlan/usage',{credentials:'include'}).then(r=>r.json()),` +
  `fetch('${API_BASE}/tokenPlan/detail',{credentials:'include'}).then(r=>r.json()),` +
  `fetch('${API_BASE}/balance',{credentials:'include'}).then(r=>r.json())` +
  `]).then(([usage,detail,balance])=>'${RELAY_SENTINEL}'+JSON.stringify({usage,detail,balance}))` +
  `.catch(e=>'${RELAY_ERROR}'+e):` +
  `'${RELAY_WRONG_PAGE}'+location.href)`;

/** Extract the sentinel JSON from opencli eval stdout (banner lines tolerated). */
export function parseRelayOutput(stdout: string): unknown | null {
  const sentinelAt = stdout.indexOf(RELAY_SENTINEL);
  if (sentinelAt < 0) return null;
  const start = stdout.indexOf("{", sentinelAt);
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Extract the off-origin href reported after the WRONGPAGE marker, else null. */
export function relayWrongPageHref(stdout: string): string | null {
  const at = stdout.indexOf(RELAY_WRONG_PAGE);
  if (at < 0) return null;
  const start = at + RELAY_WRONG_PAGE.length;
  const end = stdout.indexOf("\n", start);
  return (end < 0 ? stdout.slice(start) : stdout.slice(start, end)).trim();
}

/** about:blank / fresh newtab pages carry no state worth preserving. */
function isJunkPage(href: string): boolean {
  return href === "" || /^about:/i.test(href) || /^chrome:\/\/new-?tab/i.test(href);
}

/**
 * One eval, plus one recovery attempt when the bound tab has drifted off the
 * platform (Chrome restart, expired lease, closed window → about:blank).
 * Both `open` and `tab new` resolve only after the navigation commits, so a
 * single retry suffices — no polling.
 *
 * Recovery must never navigate a real web page away: the drifted tab may be
 * the Pi Web app itself (its own panel refresh triggered this call), and
 * navigating it would make the app destroy itself in a loop — which is
 * exactly what an earlier `open`-based version did during testing. Real pages
 * get a fresh `tab new` instead (the current tab stays open and untouched); only
 * junk pages (about:blank, newtab) are reused in place.
 */
async function relayEval(relayExec: (args: string[]) => Promise<string>): Promise<string> {
  const stdout = await relayExec(["browser", RELAY_SESSION, "eval", RELAY_SNIPPET]);
  const wrongHref = relayWrongPageHref(stdout);
  if (wrongHref === null) return stdout;
  if (isJunkPage(wrongHref)) {
    await relayExec(["browser", RELAY_SESSION, "open", PLATFORM_ORIGIN]);
  } else {
    await relayExec(["browser", RELAY_SESSION, "tab", "new", PLATFORM_ORIGIN]);
  }
  return relayExec(["browser", RELAY_SESSION, "eval", RELAY_SNIPPET]);
}

async function defaultRelayExec(args: string[]): Promise<string> {
  // Both `open` and `tab new` wait for a page load, not just a response.
  const navigates = args[2] === "open" || (args[2] === "tab" && args[3] === "new");
  const timeout = navigates ? RELAY_OPEN_TIMEOUT_MS : RELAY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      "opencli",
      args,
      { timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) reject(error);
        else resolve(String(stdout));
      }
    );
  });
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function fetchDirect(cookie: string, fetchImpl: FetchLike): Promise<unknown> {
  const headers = {
    Cookie: cookie,
    Accept: "application/json",
    Origin: PLATFORM_ORIGIN,
    Referer: `${PLATFORM_ORIGIN}/`,
    "User-Agent": "pi-web/1.0",
  };
  const [usage, detail, balance] = await Promise.all(
    ["/tokenPlan/usage", "/tokenPlan/detail", "/balance"].map(async (endpoint) => {
      const response = await fetchImpl(`${API_BASE}${endpoint}`, {
        headers,
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        cache: "no-store",
      });
      return (await response.json()) as unknown;
    })
  );
  return { usage, detail, balance };
}

export async function fetchMimoUsage(
  deps: {
    env?: Record<string, string | undefined>;
    cookieFilePath?: string;
    relayExec?: (args: string[]) => Promise<string>;
    fetchImpl?: FetchLike;
    now?: number;
  } = {}
): Promise<MimoUsageResult> {
  try {
    const cookie = resolveMimoCookie({ env: deps.env, cookieFilePath: deps.cookieFilePath });
    let envelope: unknown;
    if (cookie) {
      envelope = await fetchDirect(cookie, deps.fetchImpl ?? fetch);
    } else {
      const relayExec = deps.relayExec ?? defaultRelayExec;
      const stdout = await relayEval(relayExec);
      const wrongHref = relayWrongPageHref(stdout);
      if (wrongHref !== null) {
        return {
          status: "auth-unavailable",
          message: `Browser relay tab is on ${wrongHref || "an unexpected page"} — open platform.xiaomimimo.com in Chrome.`,
        };
      }
      const errorAt = stdout.indexOf(RELAY_ERROR);
      if (errorAt >= 0) {
        const detail = stdout.slice(errorAt + RELAY_ERROR.length).split("\n")[0]?.trim() || "unknown error";
        return { status: "query-failed", message: `Browser relay fetch failed: ${detail}` };
      }
      envelope = parseRelayOutput(stdout);
      if (envelope === null) {
        return {
          status: "auth-unavailable",
          message: "Browser relay returned no data — open platform.xiaomimimo.com in Chrome.",
        };
      }
    }
    const projected = projectMimoQuota(envelope, deps.now ?? Date.now());
    if (projected === null) {
      return { status: "query-failed", message: "Unexpected MiMo usage payload." };
    }
    if (projected.kind === "auth") {
      return { status: "auth-unavailable", message: "Platform session expired." };
    }
    return { status: "ready", quota: projected.quota };
  } catch (error) {
    return { status: "query-failed", message: error instanceof Error ? error.message : String(error) };
  }
}
