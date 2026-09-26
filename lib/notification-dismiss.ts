/**
 * Dismiss state for the notification center (server-side only — uses fs).
 *
 * Dismiss is a pure UI-layer flag: it never touches the source state that
 * generates notifications. The error-detail view reads the projections
 * directly, so a dismissed issue stays fully visible there.
 *
 * GC: an id is dropped once its source issue no longer exists (the id embeds
 * first_seen, so a recurrence of the same problem gets a fresh id anyway and
 * re-alerts). Pruning runs only after a *successful* source read — a transient
 * read failure must never wipe dismissals.
 */

import { existsSync, readFileSync } from "fs";
import { writePrivateFileAtomicSync } from "./atomic-file";

export const DISMISS_STATE_PATH = `${process.env.HOME ?? ""}/.pi/agent/pi-web-notification-state.json`;

interface DismissStateFile {
  version: 1;
  /** id -> dismissedAt (Unix ms) */
  dismissed: Record<string, number>;
}

/** Pure: keep only dismissals whose id still exists in the active set. */
export function pruneDismissed(
  dismissed: Record<string, number>,
  activeIds: Iterable<string>,
): Record<string, number> {
  const active = new Set(activeIds);
  const pruned: Record<string, number> = {};
  for (const [id, at] of Object.entries(dismissed)) {
    if (active.has(id)) pruned[id] = at;
  }
  return pruned;
}

export function loadDismissState(path: string = DISMISS_STATE_PATH): Record<string, number> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DismissStateFile>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.dismissed !== "object") return {};
    return parsed.dismissed ?? {};
  } catch {
    // Malformed state must not take the notification center down.
    return {};
  }
}

export function saveDismissState(
  dismissed: Record<string, number>,
  path: string = DISMISS_STATE_PATH,
): void {
  const file: DismissStateFile = { version: 1, dismissed };
  writePrivateFileAtomicSync(path, `${JSON.stringify(file, null, 1)}\n`);
}
