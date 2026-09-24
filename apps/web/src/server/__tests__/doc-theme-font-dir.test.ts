// Where the brand fonts are found when nobody sets DOC_FONT_DIR — i.e. in
// production. The standalone server.js does `process.chdir(__dirname)`, so the
// image's server runs with cwd /app/apps/web; vitest and `next dev` run from
// apps/web too; scripts run from the repo root. A miss is SILENT (registerFonts
// aliases every face to Helvetica, pdfkit's WinAnsi, and "Ł"/"Đ" garble), so
// every other font test pins DOC_FONT_DIR and none of them can see this one.
// process.cwd() is spied, not chdir'd: vitest runs this pool on threads.
import os from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocModel } from "@seazn/engine/exports";
import { renderScorerSheetPdf } from "../scorer-sheet-pdf";
import { docModelToPdf } from "../doc-render";
import { pdfTextRuns } from "../../../e2e/pdf-uris";
import { model, row } from "./_sheet-fixtures";

const WEB = resolve(import.meta.dirname, "../../..");
const ROOT = resolve(WEB, "../..");
const NAME = "Łukasz Đorđević";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.DOC_FONT_DIR;
  delete process.env.DOC_FONT_DIR;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.DOC_FONT_DIR;
  else process.env.DOC_FONT_DIR = saved;
});

const at = (cwd: string) => vi.spyOn(process, "cwd").mockReturnValue(cwd);
const sheet = () => renderScorerSheetPdf(model([[row(1, { home: NAME })]]));
const embedded = (pdf: Buffer) => [...pdf.toString("latin1").matchAll(/\/BaseFont\s*\/([A-Za-z+-]+)/g)].map((m) => m[1]!);

describe("brand fonts with DOC_FONT_DIR unset", () => {
  it.each([
    ["apps/web (the standalone server chdirs here; vitest and next dev run here)", WEB],
    ["the repo root (scripts)", ROOT],
  ])("cwd = %s → the sheet embeds Inter and Barlow, and a Central-European name survives", async (_where, cwd) => {
    at(cwd);
    const pdf = await sheet();
    const fonts = embedded(pdf);
    expect(fonts.some((f) => /^[A-Z]{6}\+Inter-/.test(f))).toBe(true);
    expect(fonts.some((f) => /^[A-Z]{6}\+BarlowCondensed-/.test(f))).toBe(true);
    expect(fonts.filter((f) => f.startsWith("Helvetica"))).toEqual([]);
    const run = pdfTextRuns(pdf).find((r) => r.text === NAME);
    expect(run?.font).toMatch(/^[A-Z]{6}\+Inter-/);
  });

  it("control: a cwd with no fonts falls back to Helvetica, and the name no longer reads back (what production printed)", async () => {
    at(os.tmpdir());
    const pdf = await sheet();
    expect(embedded(pdf).some((f) => f.startsWith("Helvetica"))).toBe(true);
    expect(pdfTextRuns(pdf).some((r) => r.text === NAME)).toBe(false);
  });

  it("DOC_FONT_DIR still wins over a cwd that has the fonts (a packaging step's override is obeyed)", async () => {
    at(WEB);
    process.env.DOC_FONT_DIR = os.tmpdir();
    expect(embedded(await sheet()).some((f) => f.startsWith("Helvetica"))).toBe(true);
  });

  it("every other export (doc-render's docModelToPdf) finds them from apps/web too", async () => {
    at(WEB);
    const doc: DocModel = {
      kind: "timetable",
      title: "Cup",
      description: NAME,
      meta: { printedAt: "2026-09-23 08:00" },
      sections: [],
      pageBreaks: "auto",
    };
    const fonts = embedded(await docModelToPdf(doc));
    expect(fonts.some((f) => /^[A-Z]{6}\+Inter-/.test(f))).toBe(true);
    expect(fonts.filter((f) => f.startsWith("Helvetica"))).toEqual([]);
  });

  it("the match poster's satori fonts load from apps/web too (same directory, same rule)", async () => {
    at(WEB);
    vi.resetModules(); // posterFonts caches per module instance
    const { posterFonts } = await import("../og/match-poster");
    expect((await posterFonts()).map((f) => f.name).sort()).toEqual([
      "Barlow Condensed",
      "Barlow Condensed",
      "Geist",
      "Geist",
    ]);
  });
});
