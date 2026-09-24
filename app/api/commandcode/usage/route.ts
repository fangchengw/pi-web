import { NextResponse } from "next/server";
import { fetchCommandCodeUsage } from "@/lib/commandcode-usage";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await fetchCommandCodeUsage());
  } catch (error) {
    return NextResponse.json({
      status: "query-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
