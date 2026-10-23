import { NextResponse } from "next/server";
import { requireBillingPage } from "@/server/page-auth";
import { listAllStreamCreditHistory } from "@/server/usecases/stream-credit-history";
import { streamHistoryCsv } from "@/server/usecases/stream-credit-history-csv";

export const dynamic = "force-dynamic";

/**
 * GET /o/[orgSlug]/settings/credits/stream.csv — the org's match-credit history as CSV (Settings → Credits →
 * Streaming → Export). The streaming twin of settings/billing/credits.csv: the same ledger the tab lists, every row
 * (paged through the reader, so the audience gate, tenancy guards and order are the tab's own), newest first.
 *
 * Session-authed through `requireBillingPage` — the SAME gate as the tab that renders the link, so members and the
 * group's payer get the file and everyone else 404s. The reader then holds the audience (a signed-in person of this
 * org) a second time; neither door is relaxed because the other exists.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const { auth, org } = await requireBillingPage(orgSlug, { tail: "/settings/credits" });
  const rows = await listAllStreamCreditHistory(auth, org.id);
  return new NextResponse(streamHistoryCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="stream-credits.csv"',
    },
  });
}
