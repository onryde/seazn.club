// Scorer sheets §4.4 — the brand fonts, in their own file with no mocks, so
// it sees the real registerFonts.
import { beforeAll, expect, it } from "vitest";
import { renderScorerSheetPdf } from "../scorer-sheet-pdf";
import { pdfTextRuns } from "../../../e2e/pdf-uris";
import { model, row, useBrandFonts } from "./_sheet-fixtures";

beforeAll(useBrandFonts);

it("is set in the brand fonts (doc-theme), not the Helvetica fallback", async () => {
  const bytes = (await renderScorerSheetPdf(model([[row(1)]]))).toString("latin1");
  expect(bytes).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter/);
  expect(bytes).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+BarlowCondensed/);
  expect(bytes).not.toMatch(/\/BaseFont\s*\/Helvetica/);
});

it("sets every person name in Inter, never Barlow (Barlow has no Cyrillic or Greek)", async () => {
  const home = "Зоя Петрова";
  const away = "Νίκος Παπαδόπουλος / Άννα Λάμπρου";
  const tbd = "Winner of QF·2";
  const runs = pdfTextRuns(
    await renderScorerSheetPdf(model([[row(1, { home, away }), row(2, { home: tbd, homeTbd: true })]])),
  );
  const fontOf = (text: string) => runs.filter((r) => r.text === text).map((r) => r.font);
  for (const name of [home, away, tbd]) {
    expect(fontOf(name)).toHaveLength(1);
    expect(fontOf(name)[0]).toMatch(/^[A-Z]{6}\+Inter-/);
  }
  // …while the court heading stays in the display face (our own Latin chrome).
  expect(fontOf("COURT 1 · PAGE 1 OF 1")[0]).toMatch(/^[A-Z]{6}\+BarlowCondensed-/);
});
