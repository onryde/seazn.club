// Printable A4 QR poster as a PDF (v3/10 #3): comp name, org logo, dates,
// a big QR to the public dashboard, "follow live" line. pdfkit directly
// (Jul3/06's DocModel is table-shaped and has no image vocabulary — the
// poster is one designed page, so it owns its layout the way doc-render
// owns tables). `?division=<slug>` scopes the QR to one division.
//
// Group D (owner ruling, 2026-08-24): page 2 onward is the draw — every
// fixture the scoped division(s) have, grouped by stage/pool/round and
// listed (never drawn as bracket geometry — a 128-draw has no legible A4
// tree), paginated across as many pages as it needs. This poster's audience
// is the least likely of any export to read English, so both the pre-
// existing page-1 copy (the two strings below that used to be hardcoded)
// and every string the draw prints now resolve through the org's own
// default_locale — the same pattern the public calendar route already uses
// (calendar.ics/route.ts).
import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import { notFound } from "next/navigation";
import { getPublicCompetition, getPublicDivision } from "@/server/public-site/data";
import { toLocale } from "@/lib/i18n-constants";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { msgFor } from "@/lib/messages-i18n";
import { buildDrawModel, type DrawStageGroup } from "@/lib/poster-draw";

export const revalidate = 300;

const VIOLET = "#7c3aed";
const INK = "#18181b";
const MUTED = "#52525b";
const MARGIN = 48;

type Ctx = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

/** One division's draw, ready to print — a name to head the section (when
 *  more than one division is in scope) plus the stage/pool/round tree
 *  buildDrawModel already resolved into print-ready text. */
interface DrawDivision {
  name: string;
  stages: DrawStageGroup[];
}

export async function GET(req: Request, { params }: Ctx) {
  const { orgSlug, competitionSlug } = await params;
  const data = await getPublicCompetition(orgSlug, competitionSlug);
  if (!data) notFound();
  const { org, competition, divisions } = data;

  // Spectator-facing locale (v5 i18n §4), resolved the same way every other
  // public surface does (data.ts:502-503 / calendar.ics/route.ts) — a poster
  // handed out at the venue has no single viewer/request to read a cookie
  // from, so the org's own default is what every string on it resolves
  // through.
  const locale = toLocale(org.default_locale);
  const lookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) =>
    msgFor(locale, k, v);

  const divisionSlug = new URL(req.url).searchParams.get("division");
  const division = divisionSlug
    ? (divisions.find((d) => d.slug === divisionSlug) ?? null)
    : null;

  const path = division
    ? `/shared/${org.slug}/${competition.slug}/${division.slug}`
    : `/shared/${org.slug}/${competition.slug}`;
  const url = `https://seazn.club${path}`;
  const qr = await QRCode.toBuffer(url, { width: 900, margin: 1 });

  // IN UTC, and that is load-bearing. `starts_on`/`ends_on` are pg `date`
  // columns — CALENDAR days, not instants — so `new Date("2026-09-01")` is UTC
  // midnight, and formatting it in any zone behind UTC prints the day before
  // (in this route's French locale, "31 août 2026" — wrong day AND wrong
  // month). This is the printed handout. Reasoning in full on
  // matches-hub/info-tab.tsx.
  //
  // NOT `lib/format.ts`'s `fmtDate`: that helper pins `LOCALE = "en-GB"`
  // internally and takes no locale parameter, so adopting it here would
  // silently drop the org-locale month names this route exists to render.
  //
  // `intlLocaleFor`: an English org's handout reads "1 September 2026", not the
  // US "September 1, 2026" bare "en" gives `Intl` (owner ruling 2026-09-16).
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString(intlLocaleFor(locale), {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  const dates = [
    competition.starts_on ? fmt(competition.starts_on) : null,
    competition.ends_on ? fmt(competition.ends_on) : null,
  ]
    .filter(Boolean)
    .join(" – ");

  // The draw: the QR's own scope (one division, or every division in the
  // competition) — `?division=` narrows the poster to one division's page,
  // so it narrows the printed draw the same way, rather than printing every
  // other division's fixtures onto someone's single-division handout.
  const drawDivisions = division ? [division] : divisions;
  const details = await Promise.all(
    drawDivisions.map((d) => getPublicDivision(orgSlug, competitionSlug, d.slug)),
  );
  const draw: DrawDivision[] = [];
  for (const detail of details) {
    if (!detail) continue;
    const entrantNames = Object.fromEntries(detail.entrants.map((e) => [e.id, e.display_name]));
    const stages = buildDrawModel(
      { stages: detail.stages, pools: detail.pools, fixtures: detail.fixtures, entrantNames },
      lookup,
    );
    if (stages.length > 0) draw.push({ name: detail.division.name, stages });
  }

  // bufferPages: true — REQUIRED, not an optimisation. pdfkit flushes a page
  // out of its internal buffer the moment the NEXT one is added unless this
  // is set (its own addPage(): `if (!this.options.bufferPages)
  // this.flushPages()`), so `drawDrawPages`' own page-number footer loop
  // below — which switchToPage()s across every draw page only after the
  // whole draw is laid out — throws `switchToPage(N) out of bounds` on any
  // draw big enough to span 3+ physical pages (verified live against a real
  // 91-fixture Postgres round-robin, and reproduced deterministically in
  // route.test.ts's "spans 3+ physical pages" case). A small draw (one page
  // 2) never surfaces this, which is why it shipped unnoticed.
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const W = doc.page.width; // 595pt
  const H = doc.page.height; // 842pt

  // Accent keel top + bottom — the courtside signature in print.
  doc.rect(0, 0, W, 16).fill(VIOLET);
  doc.rect(0, H - 16, W, 16).fill(VIOLET);

  doc
    .font("Helvetica-Bold").fontSize(15).fillColor(MUTED)
    .text(org.name.toUpperCase(), 0, 64, { align: "center", characterSpacing: 3 });

  doc
    .font("Helvetica-Bold").fontSize(38).fillColor(INK)
    .text(competition.name.toUpperCase(), 48, 92, { align: "center", width: W - 96 });

  let y = doc.y + 6;
  if (division) {
    doc
      .font("Helvetica-Bold").fontSize(20).fillColor(VIOLET)
      .text(division.name, 48, y, { align: "center", width: W - 96 });
    y = doc.y + 4;
  }
  if (dates) {
    doc
      .font("Helvetica").fontSize(15).fillColor(MUTED)
      .text(dates, 48, y, { align: "center", width: W - 96 });
    y = doc.y;
  }

  // Big QR, centered, framed.
  const qrSize = 320;
  const qrX = (W - qrSize) / 2;
  const qrY = Math.max(y + 28, 250);
  doc
    .roundedRect(qrX - 14, qrY - 14, qrSize + 28, qrSize + 28, 18)
    .lineWidth(2).strokeColor("#e4e4e7").stroke();
  doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });

  doc
    .font("Helvetica-Bold").fontSize(24).fillColor(INK)
    .text(lookup("poster.scanToFollow"), 48, qrY + qrSize + 42, { align: "center", width: W - 96 });
  doc
    .font("Helvetica").fontSize(15).fillColor(MUTED)
    .text(lookup("poster.liveSubtitle"), 48, doc.y + 6, {
      align: "center",
      width: W - 96,
    });
  doc
    .font("Helvetica-Bold").fontSize(13).fillColor(VIOLET)
    .text(url.replace("https://", ""), 48, doc.y + 18, { align: "center", width: W - 96 });

  doc
    .font("Helvetica").fontSize(9).fillColor("#a1a1aa")
    .text("seazn.club", 48, H - 48, { align: "center", width: W - 96 });

  if (draw.length > 0) {
    drawDrawPages(doc, { competitionName: competition.name, draw, lookup });
  }

  doc.end();
  const pdf = await done;

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${competition.slug}-poster.pdf"`,
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}

/**
 * Page 2 onward: the draw, as a round-by-round LIST (never bracket tree
 * geometry — considered and rejected, a 128-draw has no legible A4 tree),
 * paginated across as many A4 pages as it needs.
 *
 * Manual flow layout in the same style as page 1 above (this file owns its
 * whole layout rather than routing through doc-render.ts's DocModel, which
 * is table-shaped) — `ensureSpace` mirrors doc-render.ts's own
 * `if (doc.y + rowHeight > doc.page.height - MARGIN) doc.addPage()` guard.
 * A page break mid-round reprints a compact "division · stage · round"
 * breadcrumb (`context`) so a page that gets separated from the one before
 * it (the whole point of planning for a 128-draw) never strands a reader on
 * a page of "TeamX vs TeamY" lines with no idea which round they belong to.
 */
function drawDrawPages(
  doc: PDFKit.PDFDocument,
  opts: {
    competitionName: string;
    draw: DrawDivision[];
    lookup: (key: Parameters<typeof msgFor>[1], vars?: Record<string, string | number>) => string;
  },
): void {
  const { lookup } = opts;
  const W = doc.page.width;
  const H = doc.page.height;
  const contentW = W - MARGIN * 2;
  const bottom = H - 40;

  let pagesAdded = 0;
  const newPage = () => {
    pagesAdded += 1;
    doc.addPage();
    doc.rect(0, 0, W, 16).fill(VIOLET);
    doc.rect(0, H - 16, W, 16).fill(VIOLET);
    doc.y = 40;
  };

  let context = "";
  const ensureSpace = (h: number) => {
    if (doc.y + h > bottom) {
      newPage();
      if (context) {
        doc
          .font("Helvetica-Bold").fontSize(9).fillColor(MUTED)
          .text(context.toUpperCase(), MARGIN, doc.y, { width: contentW, characterSpacing: 1 });
        doc.moveDown(0.5);
      }
    }
  };

  newPage();
  doc
    .font("Helvetica-Bold").fontSize(11).fillColor(MUTED)
    .text(opts.competitionName.toUpperCase(), MARGIN, doc.y, { characterSpacing: 2 });
  doc.moveDown(0.25);
  doc
    .font("Helvetica-Bold").fontSize(26).fillColor(INK)
    .text(lookup("poster.drawTitle"), MARGIN, doc.y);
  doc.moveDown(0.9);

  const multiDivision = opts.draw.length > 1;

  for (const division of opts.draw) {
    if (multiDivision) {
      ensureSpace(34);
      doc
        .font("Helvetica-Bold").fontSize(17).fillColor(VIOLET)
        .text(division.name, MARGIN, doc.y, { width: contentW });
      doc.moveDown(0.4);
    }
    for (const stage of division.stages) {
      for (const pool of stage.pools) {
        const stageHeading = pool.poolName ? `${stage.stageName} · ${pool.poolName}` : stage.stageName;
        ensureSpace(26);
        doc
          .font("Helvetica-Bold").fontSize(13).fillColor(INK)
          .text(stageHeading, MARGIN, doc.y, { width: contentW });
        doc.moveDown(0.3);

        for (const round of pool.rounds) {
          context = [multiDivision ? division.name : null, stageHeading, round.label]
            .filter((s): s is string => !!s)
            .join(" · ");

          ensureSpace(20);
          doc
            .font("Helvetica-Bold").fontSize(9).fillColor(MUTED)
            .text(round.label.toUpperCase(), MARGIN, doc.y, { characterSpacing: 1 });
          doc.moveDown(0.2);

          for (const fixture of round.fixtures) {
            ensureSpace(18);
            doc
              .font("Helvetica").fontSize(11).fillColor(INK)
              .text(`${fixture.home}   ${lookup("schedule.vs")}   ${fixture.away}`, MARGIN, doc.y, {
                width: contentW,
              });
            doc.moveDown(0.18);
          }
          doc.moveDown(0.35);
        }
      }
    }
    doc.moveDown(0.6);
  }

  // Numeric-only page footer ("2 / 5") on the draw pages this call created —
  // never page 1, which stays exactly as it renders without this function.
  // No words are drawn, so no i18n key is owed for it.
  const range = doc.bufferedPageRange();
  const start = range.start + range.count - pagesAdded;
  for (let i = start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc
      .font("Helvetica").fontSize(9).fillColor(MUTED)
      .text(`${i - start + 1} / ${pagesAdded}`, MARGIN, H - 34, { width: contentW, align: "right" });
  }
}
