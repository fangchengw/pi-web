/**
 * Notification model + source projections (pure, client-safe, unit-tested).
 *
 * Notifications are *projected* from source-of-truth state files at request
 * time; pi-web never stores the notifications themselves. The only persisted
 * state is the dismiss set (see notification-dismiss.ts, server-side).
 */

export type NotificationLevel = "error" | "warning" | "info";

/** Where clicking a notification jumps to. Source-specific: each source's
 * adapter decides which interface owns its errors ("errors" = the standalone
 * ErrorDetails top-bar panel; future sources may return e.g. "cron"). */
export type NotificationAction = "errors";

/** Cross-component jump request: NotificationModal dispatches this, AppShell
 * listens and opens the ErrorDetails panel focused on `errorId`. */
export const NOTIFICATION_JUMP_EVENT = "pi-web:notification-jump";
export interface NotificationJumpDetail {
  target: NotificationAction;
  errorId?: string;
}

/** One projected notification. `id` embeds the generation: same issue recurring
 * after its source entry expired produces a different `first_seen`, hence a new
 * id, hence an automatic re-alert even if the old id was dismissed. */
export interface NotificationItem {
  /** `${source}:${fingerprint}:${firstSeenSeconds}` */
  id: string;
  /** Full source fingerprint, e.g. "OV server.log/VLM/LLM调用失败" */
  source: string;
  /** Display prefix before the last "/" (e.g. "OV server.log/VLM") */
  origin: string;
  /** Display suffix after the last "/" (e.g. "LLM调用失败") */
  kind: string;
  level: NotificationLevel;
  title: string;
  /** Full detail text — may be long; the list clamps, the detail view shows all. */
  body: string;
  /** Unix ms */
  createdAt: number;
  /** Unix ms */
  updatedAt: number;
  /** How often the source saw this issue in its retention window. */
  count: number;
  /** Click target for this notification (which interface owns it). */
  action: NotificationAction;
}

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

export function notificationId(source: string, firstSeenSeconds: number): string {
  return `watchdog:${source}:${firstSeenSeconds}`;
}

/** API DTO: a projected notification plus its UI-only dismiss flag. */
export type NotificationDto = NotificationItem & { dismissed: boolean };

export interface NotificationsResponse {
  status: "ready" | "unavailable";
  message?: string;
  /** Source last run (Unix ms) — drives the stale hint. */
  lastRun: number;
  /** Undismissed count (the bell badge). */
  badge: number;
  items: NotificationDto[];
}

/** Split a fingerprint for display: everything before the last "/" is the
 * origin (which service/log), after it the error kind. No "/" → whole string
 * is the kind, origin stays empty. */
export function splitSource(source: string): { origin: string; kind: string } {
  const idx = source.lastIndexOf("/");
  if (idx <= 0) return { origin: "", kind: source };
  return { origin: source.slice(0, idx), kind: source.slice(idx + 1) };
}

function inferLevel(source: string, detail: string): NotificationLevel {
  if (source.startsWith("健康检查/")) return "error";
  return detail.includes(" ERROR -") ? "error" : "warning";
}

/** Project watchdog state into notifications, newest activity first. */
export function projectWatchdog(state: WatchdogState): NotificationItem[] {
  const issues = state.recent_issues ?? {};
  return Object.values(issues)
    .map((issue): NotificationItem => {
      const { origin, kind } = splitSource(issue.source);
      return {
        id: notificationId(issue.source, issue.first_seen),
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
