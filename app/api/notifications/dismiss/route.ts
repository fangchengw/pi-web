import { NextResponse } from "next/server";
import { hideIds, loadDismissState, saveDismissState } from "@/lib/notification-dismiss";

export const dynamic = "force-dynamic";

export interface DismissRequest {
  /** Single id (toggle). */
  id?: string;
  /** Batch ids (Clear all) — the caller's rendered snapshot, never "all active":
   * an error created after the snapshot stays visible. */
  ids?: string[];
  dismissed: boolean;
}

const MAX_BATCH = 500;

/**
 * REMINDER LAYER only: writes `hidden`, never `alertOff`.
 *
 * Dismissing hides a reminder; it never touches source state or the
 * per-error alert policy — those belong to the Errors panel
 * (/api/notifications/alert-policy).
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: Partial<DismissRequest>;
  try {
    body = (await request.json()) as Partial<DismissRequest>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { id, ids, dismissed } = body;
  const batch = Array.isArray(ids) ? ids.filter((value) => typeof value === "string" && value) : null;
  if ((typeof id !== "string" || !id) && (!batch || batch.length === 0)) {
    return NextResponse.json({ error: "id (string) or ids (string[]) and dismissed (boolean) required" }, { status: 400 });
  }
  if (batch && batch.length > MAX_BATCH) {
    return NextResponse.json({ error: `ids exceeds ${MAX_BATCH}` }, { status: 400 });
  }
  if (typeof dismissed !== "boolean") {
    return NextResponse.json({ error: "dismissed (boolean) required" }, { status: 400 });
  }

  try {
    const state = loadDismissState();
    if (batch) {
      // Batch: only the ids the client actually rendered are hidden.
      if (dismissed) {
        state.hidden = hideIds(state.hidden, batch, Date.now());
      } else {
        for (const batchId of batch) delete state.hidden[batchId];
      }
      saveDismissState(state);
      return NextResponse.json({ ok: true, count: batch.length });
    }
    if (dismissed) state.hidden[id!] = Date.now();
    else delete state.hidden[id!];
    saveDismissState(state);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
