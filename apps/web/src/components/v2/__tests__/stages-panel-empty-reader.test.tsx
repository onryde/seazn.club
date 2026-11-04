import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";
import en from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// FMT5 fix round 1 (review m9): a division with no stage yet says so on the Fixtures tab. The editor's line points at the
// Format button on the Division rules card ("pick its format with Format…"); a reader has no Format button
// (`DivisionFormatButton` renders nothing without `canEdit`), so the pointer would send them to a control they do not
// have. Copy is read from the English dictionary, never typed here.
const baseProps = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  stages: [],
  fixtures: [],
  entrantNames: {},
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
};

/** The text of the panel's empty line, unescaped. */
function emptyLine(html: string): string | null {
  const m = /data-testid="stages-empty"[^>]*>([^<]*)</.exec(html);
  return m === null ? null : m[1]!.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

describe("StagesPanel — the empty line (no stage yet)", () => {
  it("an editor is pointed at the Format button", () => {
    const line = emptyLine(renderToStaticMarkup(<StagesPanel {...baseProps} canEdit />));
    expect(line).toBe(en["schedule.noStages"]);
  });

  it("a reader is told there is no stage yet, with no pointer at a button they do not have", () => {
    const line = emptyLine(renderToStaticMarkup(<StagesPanel {...baseProps} canEdit={false} />));
    expect(line).toBe(en["schedule.noStagesReader"]);
    expect(line, "the reader's line differs from the editor's").not.toBe(en["schedule.noStages"]);
    expect(line).not.toContain("Format");
  });
});
