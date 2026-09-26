import { NextResponse } from "next/server";
import { parseBody, v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ScorerSheetsRequest } from "@/server/api-v1/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { baseUrl } from "@/lib/oauth";
import { resolveLocale } from "@/lib/resolve-locale";
import { buildScorerSheet } from "@/server/usecases/scorer-sheets";
import { renderScorerSheetPdf } from "@/server/scorer-sheet-pdf";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";

type Ctx = { params: Promise<{ id: string }> };

/** Six prints a minute per organiser: each one takes a link lock per match. */
const SHEETS_LIMIT = { max: 6, windowSeconds: 60 };

/** POST /competitions/{id}/exports/scorer-sheets — a day's scorer sheets: one
 *  A4 page of cut-out cards per court, a scan-to-score QR per match (scorer
 *  sheets §4.4). POST, not GET like its timetable/tickets siblings: printing
 *  ENSURES scoring links (a prefetch or crawler must not), and the bytes are
 *  live credentials, so never cached. Session editors only — ensureDeviceLinks
 *  refuses API keys. Under /api so proxy.ts's CSRF Origin check covers it
 *  (P13). Raw file response; errors keep the v1 envelope. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "write");
    await rateLimit(`sheets:${auth.userId}`, SHEETS_LIMIT);
    const { date, divisionId } = await parseBody(req, ScorerSheetsRequest);
    const model = await buildScorerSheet(auth, id, date, new URL(baseUrl(req)).origin, await resolveLocale(), {
      printedAt: new Date().toISOString(),
      divisionId,
    });
    const bytes = await renderScorerSheetPdf(model);
    // Counted only once the PDF exists: every refusal above (403, 429, 400,
    // 402, 422, 500) prints nothing and counts nothing. Fire-and-forget like
    // scoring.ts's post_auto_drafted: captureServer never throws, and the
    // download must not wait on PostHog. Counts and ids only; the model's
    // URLs are live scoring credentials.
    void captureServer({
      event: EVENTS.SCORER_SHEETS_PRINTED,
      distinctId: auth.userId ?? `org:${auth.orgId}`,
      orgId: auth.orgId,
      properties: {
        competition_id: id,
        date,
        fixture_count: model.summary.fixtureCount,
        court_count: model.summary.courtCount,
        courtless_count: model.summary.courtlessCount,
      },
    });
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="scorer-sheets-${divisionId ? `${divisionId}-` : ""}${date}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
