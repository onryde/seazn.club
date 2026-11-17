import { NextResponse } from "next/server";
import { canSeeDeveloperDocs } from "@/lib/developer-docs";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";

// The contract, served from the code that implements it (doc 08 §5). The
// documents are deterministic — build once per process. `?published=1`
// returns the curated developer spec (key-scoped surface + public tag,
// v3/08 §3) that /developers renders.
let fullDoc: Record<string, unknown> | null = null;
let publishedDoc: Record<string, unknown> | null = null;

export async function GET(req: Request) {
  // Behind the same per-organisation switch as the docs that render it (owner, 2026-11-17): with the docs off by
  // default, an open route map was the one piece of them still handed to anyone who knew the address.
  if (!(await canSeeDeveloperDocs())) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  const published = new URL(req.url).searchParams.get("published") === "1";
  let doc: Record<string, unknown>;
  if (published) {
    publishedDoc = publishedDoc ?? buildOpenApiDocument({ published: true });
    doc = publishedDoc;
  } else {
    fullDoc = fullDoc ?? buildOpenApiDocument();
    doc = fullDoc;
  }
  // Never `public`: the answer depends on who is asking, and a shared cache would hand one organisation's 200 to all.
  return NextResponse.json(doc, { headers: { "Cache-Control": "private, no-store" } });
}
