import { NextResponse, type NextRequest } from "next/server";
import { getTodayData } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const data = await getTodayData(req.nextUrl.searchParams.get("force") === "1");
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
