/**
 * Notification model + view (pure, client-safe, unit-tested).
 *
 * Notifications are *projected* from source adapters at request time (see
 * lib/notification-sources.ts for the registry); pi-web never stores the
 * notifications themselves. Two independent state maps live in
 * lib/notification-state.ts (server-side):
 *
 * - hidden    (reminder layer): occurrence id -> hiddenAt, managed ONLY by the
 *             notification list (trash / Clear all).
 * - alertOff  (error layer):    namespace:source -> mutedAt, managed ONLY by
 *             the Errors panel switch — a durable "don't tell me about this
 *             error again" preference.
 */

export type NotificationLevel = "error" | "warning" | "info";

/** Where clicking a notification jumps to. Source-specific: each source's
 * adapter decides which interface owns its errors ("errors" = the standalone
 * Errors panel; future sources may return e.g. "cron"). */
export type NotificationAction = "errors" | "cron";

/** Cross-component jump request: NotificationModal dispatches this, AppShell
 * listens and opens the owning interface focused on `errorId`. */
export const NOTIFICATION_JUMP_EVENT = "pi-web:notification-jump";
export interface NotificationJumpDetail {
  target: NotificationAction;
  errorId?: string;
}

export interface NotificationItem {
  /** `${namespace}:${fingerprint}:${firstSeenSeconds}` — generation in the id:
   * the same issue re-occurring after its source entry expired gets a fresh id. */
  id: string;
  /** Id of the registered source that produced this item (e.g. "watchdog"). */
  namespace: string;
  /** Source-specific fingerprint (unique within its namespace). */
  source: string;
  /** Display prefix before the last "/" (e.g. "OV server.log/VLM") */
  origin: string;
  /** Display suffix after the last "/" (e.g. "LLM调用失败") */
  kind: string;
  level: NotificationLevel;
  title: string;
  /** Full detail text — may be long; the list clamps, details show it all. */
  body: string;
  /** Unix ms */
  createdAt: number;
  /** Unix ms */
  updatedAt: number;
  /** How often the source saw this issue in its retention window. */
  count: number;
  /** Click target for this notification. */
  action: NotificationAction;
}

/** API DTO: an item plus its two-layer flags. */
export type NotificationDto = NotificationItem & {
  /** Not in the reminder layer (hidden by trash/Clear all, or suppressed on
   * arrival because its line was muted). */
  dismissed: boolean;
  /** This error line's future policy is muted (Errors-panel switch off). */
  alertOff: boolean;
};

/** The two independent state maps (see module header). */
export interface NotificationStateMap {
  /** occurrence id -> hiddenAt (Unix ms) */
  hidden: Record<string, number>;
  /** `${namespace}:${source}` -> mutedAt (Unix ms) */
  alertOff: Record<string, number>;
}

/** Stable key for the per-error-line alert policy. Construction-only — never
 * split back apart (fingerprints may contain ":" — e.g. 健康检查/ov:1933). */
export function alertPolicyKey(namespace: string, source: string): string {
  return `${namespace}:${source}`;
}

/** Generation-scoped id: `${namespace}:${fingerprint}:${firstSeenSeconds}`.
 * The namespace prefix keeps ids from different sources collision-free. */
export function notificationId(
  namespace: string,
  source: string,
  firstSeenSeconds: number,
): string {
  return `${namespace}:${source}:${firstSeenSeconds}`;
}

/**
 * Merge projections with the two state maps into view DTOs + badge count.
 * Pure — the API route and the unit tests share this implementation.
 *
 * Invariants:
 * 1. A fresh id whose line is NOT muted always counts → new errors re-alert.
 * 2. An occurrence that arrived while its line was muted (createdAt after
 *    muting) is suppressed AT ARRIVAL and reported in `newlyHidden` so the
 *    caller persists it — a later restore therefore can never resurrect it.
 *    Restore only arms FUTURE arrivals.
 * 3. Muting never hides pre-existing notifications (suppression requires
 *    createdAt > alertOff): the error layer manages the future, the reminder
 *    layer manages the present.
 * 4. Dismissed items stay in `dtos` — dismiss hides a reminder, never data.
 */
export function buildNotificationView(
  items: NotificationItem[],
  state: NotificationStateMap,
): { dtos: NotificationDto[]; badge: number; newlyHidden: string[] } {
  const newlyHidden: string[] = [];
  const dtos = items.map((item) => {
    const mutedAt = state.alertOff[alertPolicyKey(item.namespace, item.source)];
    const suppressed =
      mutedAt !== undefined && item.createdAt > mutedAt && !Object.hasOwn(state.hidden, item.id);
    if (suppressed) newlyHidden.push(item.id);
    const dismissed = suppressed || Object.hasOwn(state.hidden, item.id);
    return { ...item, dismissed, alertOff: mutedAt !== undefined };
  });
  return { dtos, badge: dtos.filter((dto) => !dto.dismissed).length, newlyHidden };
}

export interface NotificationsResponse {
  status: "ready" | "unavailable";
  message?: string;
  /** Source last update (Unix ms) — drives the stale hint. */
  lastRun: number;
  /** Undismissed count (the bell badge). */
  badge: number;
  items: NotificationDto[];
  /** Sources that failed to load (partial degradation; status stays "ready"). */
  failures?: { id: string; message: string }[];
}

/** Split a fingerprint for display: everything before the last "/" is the
 * origin (which service/log), after it the error kind. No "/" → whole string
 * is the kind, origin stays empty. */
export function splitSource(source: string): { origin: string; kind: string } {
  const idx = source.lastIndexOf("/");
  if (idx <= 0) return { origin: "", kind: source };
  return { origin: source.slice(0, idx), kind: source.slice(idx + 1) };
}
