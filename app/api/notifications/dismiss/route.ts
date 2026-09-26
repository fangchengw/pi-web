import { NextResponse } from "next/server";
import { loadDismissState, saveDismissState } from "@/lib/notification-dismiss";

export const dynamic = "force-dynamic";

export interface DismissRequest {
  id: string;
  dismissed: boolean;
}

/** Toggle the UI-only dismiss flag. Never touches source state, so the
 * error-detail view (which reads projections) is unaffected either way. */
export async function POST(request: Request): Promise<NextResponse> {
  let body: Partial<DismissRequest>;
  try {
    body = (await request.json()) as Partial<DismissRequest>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { id, dismissed } = body;
  if (typeof id !== "string" || !id || id.length > 512 || typeof dismissed !== "boolean") {
    return NextResponse.json({ error: "id (string) and dismissed (boolean) required" }, { status: 400 });
  }

  try {
    const state = loadDismissState();
    if (dismissed) state[id] = Date.now();
    else delete state[id];
    saveDismissState(state);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
