import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickCommandCodeWindows, type CommandCodeWindow, type RawWindowLimits } from "./commandcode-windows";

const API_BASE_URL = "https://api.commandcode.ai";
const API_KEY_ENV_VAR = "COMMAND_CODE_API_KEY";
const QUERY_TIMEOUT_MS = 8_000;

/** Monthly credit totals per plan id (mirrors the command-code CLI plan table). */
export const PLAN_MONTHLY_CREDITS: Record<string, number> = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};

/** Human-readable plan names keyed by plan id. */
export const PLAN_DISPLAY_NAMES: Record<string, string> = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};

const PLAN_IDS_BY_LENGTH = Object.keys(PLAN_MONTHLY_CREDITS).sort((a, b) => b.length - a.length);

export interface CommandCodePlanInfo {
  planId: string;
  name: string;
  monthlyCredits: number;
}

export interface CommandCodeQuota {
  planName: string | null;
  planMonthlyCredits: number | null;
  monthlyRemaining: number;
  purchasedRemaining: number;
  freeRemaining: number;
  /** Total remaining credits across monthly + purchased + free pools (USD). */
  balance: number;
  /** Credits spent during the current billing period (USD). */
  spent: number;
  /** Total credit pool for the current period (USD). */
  pool: number;
  /** Percentage of the pool already consumed, 0-100. */
  percent: number;
  /** Extra (purchased + free) credits included in the balance (USD). */
  extra: number;
  /** Rolling usage windows: 5-hour / weekly / monthly. */
  windows: CommandCodeWindow[];
  daysLeft: number | null;
  periodEnd: string | null;
  orgLogin: string | null;
  capturedAt: number;
}

export type CommandCodeUsageResult =
  | { status: "ready"; quota: CommandCodeQuota }
  | { status: "auth-unavailable" | "query-failed"; message: string };

interface WhoamiBody {
  org?: { id?: string | null; login?: string | null } | null;
}

interface CreditsBody {
  credits?: {
    monthlyCredits?: number;
    purchasedCredits?: number;
    freeCredits?: number;
  } | null;
  windowLimits?: RawWindowLimits | null;
}

interface SubscriptionBody {
  data?: {
    planId?: string | null;
    status?: string | null;
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
  } | null;
}

interface SummaryBody {
  totalCost?: number;
}

/**
 * Resolve a plan id to its display name and monthly credit total using
 * prefix matching (the CLI matches plan ids such as `individual-pro-v1`).
 */
export function getPlanInfo(planId: string | null | undefined): CommandCodePlanInfo | null {
  if (!planId) return null;
  const normalized = planId.toLowerCase().replace(/_/g, "-");
  const match = PLAN_IDS_BY_LENGTH.find((id) => normalized.startsWith(id));
  if (!match) return null;
  const monthlyCredits = PLAN_MONTHLY_CREDITS[match];
  if (monthlyCredits === undefined) return null;
  return { planId: match, name: PLAN_DISPLAY_NAMES[match] ?? match, monthlyCredits };
}

function daysLeftFrom(periodEnd: string, now: number): number | null {
  const endMs = Date.parse(periodEnd);
  if (Number.isNaN(endMs)) return null;
  return Math.max(0, Math.ceil((endMs - now) / 86_400_000));
}

/**
 * Project raw Command Code API bodies into the quota view used by the UI.
 * Mirrors the CLI's `projectUsageView` math:
 * - balance = monthlyRemaining + purchasedRemaining + freeRemaining
 * - pool = active plan ? max(planTotal, monthlyRemaining) + purchased + free : spent + balance
 * - percent = (pool - balance) / pool
 */
export function projectCommandCodeQuota(input: {
  whoami?: WhoamiBody | null;
  credits?: CreditsBody | null;
  subscription?: SubscriptionBody | null;
  summary?: SummaryBody | null;
  now?: number;
}): CommandCodeQuota {
  const now = input.now ?? Date.now();
  const subscription = input.subscription?.data ?? null;
  const plan = getPlanInfo(subscription?.planId ?? "");
  const creditsInfo = input.credits?.credits ?? null;

  const monthlyRemaining = Math.max(0, creditsInfo?.monthlyCredits ?? 0);
  const purchasedRemaining = Math.max(0, creditsInfo?.purchasedCredits ?? 0);
  const freeRemaining = Math.max(0, creditsInfo?.freeCredits ?? 0);
  const balance = monthlyRemaining + purchasedRemaining + freeRemaining;
  const extra = purchasedRemaining + freeRemaining;
  const spent = Math.max(0, input.summary?.totalCost ?? 0);

  const activePlanCredits = subscription?.status === "active" ? plan?.monthlyCredits ?? null : null;
  const pool =
    activePlanCredits !== null
      ? Math.max(activePlanCredits, monthlyRemaining) + purchasedRemaining + freeRemaining
      : spent + balance;

  const hasCreditsInfo = balance > 0 || spent > 0;
  const percent = hasCreditsInfo && pool > 0 ? (Math.min(Math.max(pool - balance, 0), pool) / pool) * 100 : 0;

  const periodEnd = subscription?.currentPeriodEnd ?? null;
  const daysLeft = periodEnd ? daysLeftFrom(periodEnd, now) : null;

  // 5 小时 / 每周窗口来自 API；每月窗口在缺失时从计划月池 + 订阅期末推导。
  const windows = pickCommandCodeWindows(input.credits?.windowLimits);
  if (!windows.some((window) => window.id === "monthly") && activePlanCredits !== null && periodEnd) {
    const periodEndMs = Date.parse(periodEnd);
    if (!Number.isNaN(periodEndMs)) {
      windows.push({
        id: "monthly",
        used: Math.max(activePlanCredits, monthlyRemaining) - monthlyRemaining,
        cap: activePlanCredits,
        resetAt: periodEndMs,
        exceeded: monthlyRemaining <= 0,
      });
    }
  }

  return {
    planName: plan?.name ?? null,
    planMonthlyCredits: plan?.monthlyCredits ?? null,
    monthlyRemaining,
    purchasedRemaining,
    freeRemaining,
    balance,
    spent,
    pool,
    percent,
    extra,
    windows,
    daysLeft,
    periodEnd,
    orgLogin: input.whoami?.org?.login ?? null,
    capturedAt: now,
  };
}

/**
 * Locate the Command Code API key: `COMMAND_CODE_API_KEY` env var first,
 * otherwise `~/.commandcode/auth.json` (the file `commandcode login` writes).
 */
export function resolveCommandCodeAuthKey(
  options: { env?: Record<string, string | undefined>; authFilePath?: string } = {}
): { apiKey: string; source: "env" | "file" } | null {
  const env = options.env ?? process.env;
  const fromEnv = env[API_KEY_ENV_VAR]?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: "env" };

  const authFilePath = options.authFilePath ?? path.join(os.homedir(), ".commandcode", "auth.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(authFilePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const apiKey = (parsed as { apiKey?: unknown }).apiKey;
      if (typeof apiKey === "string" && apiKey.trim()) return { apiKey: apiKey.trim(), source: "file" };
    }
  } catch {
    // Missing or unreadable auth file simply means "not authenticated".
  }
  return null;
}

class CommandCodeAuthError extends Error {}

async function apiGet<T>(
  apiKey: string,
  endpoint: string,
  params: Record<string, string | null | undefined>
): Promise<T> {
  const url = new URL(endpoint, API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${endpoint}: ${detail}`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new CommandCodeAuthError(`${endpoint}: HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Query the Command Code API for the current plan's quota and balance.
 * Never throws; failures are reported as a status the UI can render.
 */
export async function fetchCommandCodeUsage(): Promise<CommandCodeUsageResult> {
  const auth = resolveCommandCodeAuthKey();
  if (!auth) return { status: "auth-unavailable", message: "Not authenticated" };

  try {
    const whoami = await apiGet<WhoamiBody>(auth.apiKey, "/alpha/whoami", { limits: "1" });
    const orgId = whoami?.org?.id ?? null;
    const [credits, subscription] = await Promise.all([
      apiGet<CreditsBody>(auth.apiKey, "/alpha/billing/credits", { orgId }),
      apiGet<SubscriptionBody>(auth.apiKey, "/alpha/billing/subscriptions", { orgId }),
    ]);
    const since = subscription?.data?.currentPeriodStart ?? null;
    const summary = await apiGet<SummaryBody>(auth.apiKey, "/alpha/usage/summary", { orgId, since });
    return { status: "ready", quota: projectCommandCodeQuota({ whoami, credits, subscription, summary }) };
  } catch (error) {
    if (error instanceof CommandCodeAuthError) {
      return { status: "auth-unavailable", message: "Session expired" };
    }
    return { status: "query-failed", message: error instanceof Error ? error.message : String(error) };
  }
}
