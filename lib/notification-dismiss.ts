/**
 * Two-layer notification state (server-side only — uses fs).
 *
 * Layer separation (2026-09-26 requirement: 错误管错误,通知管通知):
 * - `hidden`   — reminder layer: occurrence id -> hiddenAt. Written ONLY by the
 *   notification list (trash / Clear all) and by arrival-suppression (see
 *   buildNotificationView). Never deleted by the Errors panel: restore arms the
 *   future, it does not resurrect the present.
 * - `alertOff` — error layer: `${namespace}:${source}` -> mutedAt. Written ONLY
 *   by the Errors-panel switch; a durable "don't alert me about this error"
 *   preference that outlives the current occurrence.
 *
 * GC: hidden ids are dropped once their source issue no longer exists (the id
 * embeds first_seen, so a recurrence gets a fresh id and re-alerts). alertOff
 * entries are user preferences and are NOT garbage-collected. Pruning runs
 * only after a *successful* source read — a transient read failure must never
 * wipe state.
 *
 * File format is v2; v1 (`{dismissed}`) migrates on load.
 */

import { existsSync, readFileSync } from "fs";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { NotificationStateMap } from "./notifications";

export const DISMISS_STATE_PATH = `${process.env.HOME ?? ""}/.pi/agent/pi-web-notification-state.json`;

interface StateFile {
  version: 2;
  hidden: Record<string, number>;
  alertOff: Record<string, number>;
}

/** Pure: keep only hidden entries whose occurrence id still exists. */
export function pruneHidden(
  hidden: Record<string, number>,
  activeIds: Iterable<string>,
): Record<string, number> {
  const active = new Set(activeIds);
  const pruned: Record<string, number> = {};
  for (const [id, at] of Object.entries(hidden)) {
    if (active.has(id)) pruned[id] = at;
  }
  return pruned;
}

/**
 * Pure: hide the given occurrence ids (batch — notification layer only).
 *
 * Only the listed ids are touched. Callers must send the id snapshot they
 * rendered, NOT "all active": an error created after the snapshot is absent
 * from the list, so it stays visible — Clear all can never swallow a
 * brand-new error.
 */
export function hideIds(
  hidden: Record<string, number>,
  ids: readonly string[],
  now: number,
): Record<string, number> {
  const next = { ...hidden };
  for (const id of ids) {
    if (id) next[id] = now;
  }
  return next;
}

/** Pure: toggle the per-error-line alert policy (error layer). */
export function setAlertOff(
  alertOff: Record<string, number>,
  key: string,
  off: boolean,
  now: number,
): Record<string, number> {
  const next = { ...alertOff };
  if (off) next[key] = now;
  else delete next[key];
  return next;
}

export function loadDismissState(path: string = DISMISS_STATE_PATH): NotificationStateMap {
  if (!existsSync(path)) return { hidden: {}, alertOff: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile> & {
      dismissed?: Record<string, number>;
    };
    if (!parsed || typeof parsed !== "object") return { hidden: {}, alertOff: {} };
    // v1 → v2 migration: {version:1, dismissed} → {version:2, hidden}.
    const hidden =
      typeof parsed.hidden === "object" && parsed.hidden !== null
        ? parsed.hidden
        : typeof parsed.dismissed === "object" && parsed.dismissed !== null
          ? parsed.dismissed
          : {};
    const alertOff =
      typeof parsed.alertOff === "object" && parsed.alertOff !== null ? parsed.alertOff : {};
    return { hidden, alertOff };
  } catch {
    // Malformed state must not take the notification center down.
    return { hidden: {}, alertOff: {} };
  }
}

export function saveDismissState(
  state: NotificationStateMap,
  path: string = DISMISS_STATE_PATH,
): void {
  const file: StateFile = {
    version: 2,
    hidden: state.hidden,
    alertOff: state.alertOff,
  };
  writePrivateFileAtomicSync(path, `${JSON.stringify(file, null, 1)}\n`);
}
