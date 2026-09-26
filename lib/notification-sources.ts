/**
 * Notification source registry (server-side — reads fs).
 *
 * The API route iterates NOTIFICATION_SOURCES and never hardcodes a source.
 * Adding a source = append one entry (see docs/notifications.md).
 *
 * Contract:
 * - `load()` MUST NOT throw: a dead source degrades to `error` and contributes
 *   zero items; other sources keep serving (one dead source never takes down
 *   the endpoint or wipes another source's dismissals).
 * - `lastRun` is the source's own last update (Unix ms), 0 if unknown.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  notificationId,
  splitSource,
  type NotificationItem,
  type NotificationLevel,
} from "./notifications";

/** Shape of ~/.openviking/watchdog-state.json fields we consume. */
export interface WatchdogIssue {
  source: string;
  error: string;
  first_seen: number;
  last_seen: number;
  count: number;
}

export interface WatchdogState {
  last_run?: number;
  last_notify?: number;
  recent_issues?: Record<string, WatchdogIssue>;
}

export interface SourceResult {
  items: NotificationItem[];
  /** Source's own last update (Unix ms); 0 = unknown. */
  lastRun: number;
  /** Set when this source failed to load; items will be empty. */
  error?: string;
}

export interface NotificationSource {
  /** Registry id → also the id namespace of its items. */
  id: string;
  load(): SourceResult;
}

/* ------------------------- watchdog (first source) ----------------------- */

export const WATCHDOG_STATE_PATH = join(
  homedir(),
  ".openviking",
  "watchdog-state.json",
);

function inferLevel(source: string, detail: string): NotificationLevel {
  if (source.startsWith("健康检查/")) return "error";
  return detail.includes(" ERROR -") ? "error" : "warning";
}

/** Project raw watchdog recent_issues into generic notification items. */
export function projectWatchdog(state: WatchdogState): NotificationItem[] {
  const issues = state.recent_issues ?? {};
  return Object.values(issues)
    .map((issue): NotificationItem => {
      const { origin, kind } = splitSource(issue.source);
      return {
        id: notificationId("watchdog", issue.source, issue.first_seen),
        namespace: "watchdog",
        source: issue.source,
        origin,
        kind,
        level: inferLevel(issue.source, issue.error),
        title: origin ? `${origin} · ${kind}` : kind,
        body: issue.error,
        createdAt: issue.first_seen * 1000,
        updatedAt: issue.last_seen * 1000,
        count: issue.count,
        action: "errors",
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export const watchdogSource: NotificationSource = {
  id: "watchdog",
  load(): SourceResult {
    try {
      const raw = readFileSync(WATCHDOG_STATE_PATH, "utf8");
      const state = JSON.parse(raw) as WatchdogState;
      if (typeof state !== "object" || state === null) throw new Error("malformed watchdog state");
      return {
        items: projectWatchdog(state),
        lastRun: typeof state.last_run === "number" ? state.last_run * 1000 : 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        items: [],
        lastRun: 0,
        error: message.startsWith("ENOENT") ? "watchdog 未运行" : message,
      };
    }
  },
};

/* -------------------------------- registry ------------------------------- */

export const NOTIFICATION_SOURCES: readonly NotificationSource[] = [watchdogSource];

export interface AggregatedSources {
  items: NotificationItem[];
  lastRun: number;
  failures: { id: string; message: string }[];
}

/** Load every registered source, merge, and sort by last activity.
 * Never throws; per-source failures land in `failures`. */
export function aggregateSources(
  sources: readonly NotificationSource[] = NOTIFICATION_SOURCES,
): AggregatedSources {
  const items: NotificationItem[] = [];
  const failures: { id: string; message: string }[] = [];
  let lastRun = 0;
  for (const source of sources) {
    let result: SourceResult;
    try {
      result = source.load();
    } catch (error) {
      // Defensive: load() is contractually non-throwing, but a broken source
      // must still not take down the others.
      result = {
        items: [],
        lastRun: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.error) {
      failures.push({ id: source.id, message: result.error });
    } else {
      items.push(...result.items);
      lastRun = Math.max(lastRun, result.lastRun);
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return { items, lastRun, failures };
}
