// W2b loop H F3 — in the forfeit dialog's two-column who chips, "Maximiliano Wolfeschlegelsteinhausen" broke mid-word
// ("Wolfeschlegelsteinhause / n") at 768 and 1280: a fixed half-width column, a `min-w-0` button, and `break-words`
// doing the wrapping. The chips now wrap at WORD boundaries the way the AI instruction preview's controls do
// (`ai-instruction-preview.tsx`: `flex-1 basis-*` in a wrapping row): a chip keeps its longest word whole — no `min-w-0`,
// so its automatic minimum is that word — and a chip that cannot share the row takes the row. `max-w-full` clamps that
// minimum to the row, so a single word wider than the WHOLE dialog is the only case `break-words` still breaks.
//
// This is the markup half; e2e/forfeit-dialog.spec.ts measures the words in a browser at 1280, 768 and 320.
// single-sport: generic — the chips' layout reads no sport.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { ForfeitDialog, forfeitBaseState, forfeitDialogModel, forfeitPlayRecorded } from "@/components/v2/forfeit-dialog";
import { defaultLineupPair } from "@seazn/engine/testkit";
import { msg } from "@/lib/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const m = builtinModules.find((x) => x.key === "generic")!;
const cfg = m.configSchema.parse(Object.values(m.variants)[0] ?? {});
const model = forfeitDialogModel(m, cfg, forfeitBaseState(m, cfg, null, defaultLineupPair(m.positions)), {
  noNextMatch: false,
  playRecorded: forfeitPlayRecorded([], m),
});

function whoMarkup() {
  const html = renderToStaticMarkup(
    <ForfeitDialog
      msg={msg}
      model={model}
      home={{ id: "h", name: "Alexandria Konstantinopoulou-Vanderbilt" }}
      away={{ id: "a", name: "Maximiliano Wolfeschlegelsteinhausen" }}
      forfeit={async () => ({ ok: true })}
      onClose={() => {}}
      onRefused={() => {}}
    />,
  );
  const buttons = [...html.matchAll(/<button[^>]*data-testid="forfeit-who-(\w+)"[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/g)].map((b) => ({
    who: b[1]!,
    cls: b[2]!.split(/\s+/),
    label: /<span class="([^"]*)">/.exec(b[3]!)?.[1]?.split(/\s+/) ?? [],
  }));
  const row = /<div class="([^"]*)">(?=<button[^>]*data-testid="forfeit-who-)/.exec(html)?.[1]?.split(/\s+/) ?? [];
  return { buttons, row };
}

describe("forfeit dialog who chips wrap at word boundaries (loop H F3)", () => {
  it("the row wraps; a side's chip keeps its longest word whole, clamped to the row; Neither takes the row", () => {
    const { buttons, row } = whoMarkup();
    expect(model.who, "premise: before play the dialog offers both sides and Neither").toEqual(["home", "away", "both"]);
    expect(row, "a wrapping flex row, not fixed grid columns").toEqual(expect.arrayContaining(["flex", "flex-wrap", "min-w-0"]));
    expect(row).not.toContain("grid");
    let checked = 0;
    for (const b of buttons) {
      expect(b.cls, `${b.who}: no min-w-0 — the chip's minimum is its longest word`).not.toContain("min-w-0");
      expect(b.cls, `${b.who}: clamped to the row, so a word wider than the dialog still cannot overflow it`).toContain("max-w-full");
      expect(b.cls, b.who).toContain("flex-1");
      expect(b.cls, b.who).toContain(b.who === "both" ? "basis-full" : "basis-48");
      expect(b.label, `${b.who}: break-words is the last resort only`).toContain("break-words");
      expect(b.label, `${b.who}: never break-all`).not.toContain("break-all");
      checked++;
    }
    expect(checked, `chips checked: ${checked}`).toBe(model.who.length);
  });
});
