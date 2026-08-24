// The status stamp used to be drawn at a FIXED x on the ticket card, which
// silently assumed a short reference. Real refs are 12 characters
// (`SZ-98PJ-DYGY`, lib/ref-code.ts) and at Courier-Bold 20 they run past that
// fixed offset, so CONFIRMED was printed on top of the digits an organiser
// reads out when a QR will not scan. The sibling doc-render.test.ts could not
// see it twice over: its spy discards coordinates and returns a constant 10
// from widthOfString, and its fixture ref is 6 characters.
//
// This spy keeps x/y and gives widthOfString a real per-character metric, so
// the assertion is about geometry rather than about which strings were drawn.
import { describe, it, expect, vi } from "vitest";

interface Drawn { s: string; x: number; y: number; size: number; font: string }
const drawn: Drawn[] = [];

vi.mock("pdfkit", () => {
  class FakeDoc {
    page = { width: 595.28, height: 841.89 };
    y = 40;
    private endCb?: () => void;
    private size = 12;
    private fontName = "Helvetica";
    on(ev: string, cb: () => void) { if (ev === "end") this.endCb = cb; return this; }
    registerFont() { return this; }
    font(name?: string) { if (typeof name === "string") this.fontName = name; return this; }
    fontSize(n?: number) { if (typeof n === "number") this.size = n; return this; }
    fillColor() { return this; } strokeColor() { return this; } lineWidth() { return this; }
    text(s: unknown, x?: unknown, y?: unknown) {
      drawn.push({
        s: String(s),
        x: typeof x === "number" ? x : Number.NaN,
        y: typeof y === "number" ? y : Number.NaN,
        size: this.size,
        font: this.fontName,
      });
      return this;
    }
    // Courier is exactly 0.6em per glyph; close enough for the proportional
    // faces too, and this test only compares boxes drawn in Courier-Bold.
    widthOfString(s: string) { return s.length * this.size * 0.6; }
    image() { return this; }
    rect() { return this; } roundedRect() { return this; } circle() { return this; }
    moveTo() { return this; } lineTo() { return this; } stroke() { return this; }
    fill() { return this; }
    dash() { return this; } undash() { return this; } moveDown() { return this; }
    addPage() { return this; } switchToPage() { return this; }
    bufferedPageRange() { return { start: 0, count: 1 }; }
    end() { this.endCb?.(); }
  }
  return { default: FakeDoc };
});

import { docModelToPdf } from "../doc-render";
import type { DocModel } from "@seazn/engine/exports";

const REF = "SZ-98PJ-DYGY"; // a real generateRefCode() shape, 12 chars

const ticketModel = (ref: string): DocModel => ({
  kind: "admit_ticket",
  title: "Reg Cup",
  meta: { printedAt: "2026-08-24" },
  branding: { orgName: "Riverside SC" },
  sections: [
    {
      columnsHint: 2,
      ticket: {
        maskedName: "Alex Morgan",
        competition: "Reg Cup",
        dates: "15 Sep",
        ref,
        status: "CONFIRMED",
        qrUrl: `https://seazn.club/r/${ref}`,
        seq: 1,
      },
    },
  ],
  pageBreaks: "auto",
});

async function render(ref: string): Promise<Drawn[]> {
  drawn.length = 0;
  await docModelToPdf(ticketModel(ref));
  return drawn;
}

describe("admit ticket layout", () => {
  it("never draws the status stamp over the reference", async () => {
    const calls = await render(REF);
    const refCall = calls.find((c) => c.s === REF);
    const stampCall = calls.find((c) => c.s === "CONFIRMED");
    expect(refCall, "reference was drawn").toBeDefined();
    expect(stampCall, "status stamp was drawn").toBeDefined();

    const refRight = refCall!.x + REF.length * refCall!.size * 0.6;
    expect(stampCall!.x).toBeGreaterThanOrEqual(refRight);
  });

  it("keeps the stamp on the card, not past the stub perforation", async () => {
    const calls = await render(REF);
    const stampCall = calls.find((c) => c.s === "CONFIRMED")!;
    // The stub occupies the rightmost 150pt of the card (doc-render.ts's
    // `stubX`), and the card itself is inset by MARGIN.
    const stubLeft = 595.28 - 36 - 150;
    expect(stampCall.x).toBeLessThan(stubLeft);
  });
});
