import { NextResponse } from "next/server";
import { helpSearchIndex } from "@/server/help-search-index";

// The help search box's index (server/help-search-index.ts is its one source): fetched by the browser on the
// box's first focus or keystroke, never shipped inside a help page. Content changes only with a deploy.
export async function GET() {
  return NextResponse.json(await helpSearchIndex(), {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
