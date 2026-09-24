import { NextResponse } from "next/server";
import { fetchMimoUsage } from "@/lib/mimo-usage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await fetchMimoUsage());
  } catch (error) {
    return NextResponse.json({
      status: "query-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
