import { NextResponse } from "next/server";
import { buildNotificationView, type NotificationsResponse } from "@/lib/notifications";
import { aggregateSources } from "@/lib/notification-sources";
import { loadDismissState, pruneHidden, saveDismissState } from "@/lib/notification-dismiss";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  // Registry-driven: no source is hardcoded here. A dead source degrades to a
  // failure entry; the others keep serving.
  const { items, lastRun, failures } = aggregateSources();

  if (failures.length > 0 && items.length === 0 && lastRun === 0) {
    // Every source is down — nothing to serve.
    return NextResponse.json({
      status: "unavailable",
      message: failures.map((f) => `${f.id}: ${f.message}`).join("; "),
      lastRun: 0,
      badge: 0,
      items: [],
      failures,
    } satisfies NotificationsResponse);
  }

  const state = loadDismissState();
  const activeIds = items.map((item) => item.id);
  const { dtos, badge, newlyHidden } = buildNotificationView(items, state);

  let changed = newlyHidden.length > 0;
  const hidden = { ...state.hidden };
  for (const id of newlyHidden) hidden[id] = Date.now();

  // GC only when EVERY source loaded: a failed source contributes zero items,
  // and pruning against that partial view would wipe its dismissals.
  if (failures.length === 0) {
    const pruned = pruneHidden(hidden, activeIds);
    if (Object.keys(pruned).length !== Object.keys(hidden).length) changed = true;
    state.hidden = pruned; // note: pruned ⊆ hidden (newlyHidden ids are active by construction)
  } else {
    state.hidden = hidden;
  }
  if (changed) {
    try {
      saveDismissState(state);
    } catch {
      // State persistence failure only delays bookkeeping; serve the response.
    }
  }

  return NextResponse.json({
    status: "ready",
    lastRun,
    badge,
    items: dtos,
    failures: failures.length > 0 ? failures : undefined,
  } satisfies NotificationsResponse);
}
