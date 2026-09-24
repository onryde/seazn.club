// Shared inputs for the scorer-sheet renderer's test files. Their own
// file, not exported from a test file: importing a test file collects its
// describes a second time.
import { resolve } from "node:path";
import type { DocModel } from "@seazn/engine/exports";
import type { SheetModel, SheetRow } from "../scorer-sheet-pdf";

export const header: DocModel = {
  kind: "scoresheet",
  title: "Cup",
  description: "Wednesday 23 September",
  meta: { printedAt: "2026-09-23 08:00" },
  sections: [],
  pageBreaks: "auto",
};

export const labels: SheetModel["labels"] = {
  eyebrow: "SCORER SHEETS",
  checkNames: "Scan to score. Check names on screen before you start.",
};

/** A realistic token: `dl_` + 32 random bytes as base64url (device-links.ts). */
export const token = (i: number) => `dl_${String(i).padStart(3, "0")}Qx7vN2mK8pL4rT6wY9zB1cD3fG5hJ0kS-_aEuIoP`;

export const row = (i: number, over: Partial<SheetRow> = {}): SheetRow => ({
  fixtureId: `f${i}`,
  url: `https://example.test/score/${token(i)}`,
  time: "10:30",
  matchRef: `QF·${i}`,
  division: "Open Singles",
  home: `Home ${i}`,
  away: `Away ${i}`,
  homeTbd: false,
  awayTbd: false,
  homePair: [],
  awayPair: [],
  ...over,
});

/** A page's worth of rows: row(from) … row(from + n - 1). */
export const rows = (n: number, from = 1): SheetRow[] => Array.from({ length: n }, (_, i) => row(from + i));

export const model = (pages: SheetRow[][], over: Partial<SheetModel> = {}): SheetModel => ({
  header,
  labels,
  pages: pages.map((rows, i) => ({ heading: `Court ${i + 1} · page 1 of 1`, rows })),
  ...over,
});

/** Pin the fonts to the real directory whatever the runner's cwd: a miss makes
 *  registerFonts SILENTLY fall back to Helvetica, and a font test would then
 *  prove the wrong fonts. The UNSET default (`brandFontDir`, what production
 *  uses) is pinned on its own in doc-theme-font-dir.test.ts. */
export function useBrandFonts(): void {
  process.env.DOC_FONT_DIR = resolve(import.meta.dirname, "../../../assets/fonts");
}
