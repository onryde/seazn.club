// Scorer sheets §4.4 — its own file: vi.mock hoists to the top of its FILE,
// and nulling qrBuffer beside the decode tests would null theirs too.
import { expect, it, vi } from "vitest";
vi.mock("../doc-theme", async (orig) => ({ ...(await orig<typeof import("../doc-theme")>()), qrBuffer: vi.fn(async () => null) }));
import { renderScorerSheetPdf } from "../scorer-sheet-pdf";
import { model, row } from "./_sheet-fixtures";

it("a QR that cannot be generated fails the print — never a sheet nobody can scan", async () => {
  await expect(renderScorerSheetPdf(model([[row(1)]]))).rejects.toThrow(/QR generation failed for fixture f1/);
});
