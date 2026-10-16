// R2007 step 9b (coordinator decision G2) — the stage lays the match card out from the template's `sceneCardSafeArea`,
// and when `cardRegionFor` finds no strip big enough it renders NO card. That `null` branch is unreachable through the
// shipped registry (both shipped boxes leave a strip), so an injected entry whose box fills the canvas reaches it — and
// the shipped bug, on the same warming fixture, is the positive pair that proves the card is otherwise there.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type * as RegistryModule from "../template-registry";

vi.mock("../template-registry", async (importOriginal) => {
  const orig = await importOriginal<typeof RegistryModule>();
  return {
    ...orig,
    OVERLAY_TEMPLATES: {
      ...orig.OVERLAY_TEMPLATES,
      full: { ...orig.OVERLAY_TEMPLATES.bug, id: "full", sceneCardSafeArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    },
  };
});

const { OverlayStage } = await import("../overlay-stage");
const { cardRegionFor } = await import("../template-registry");
const { decidedOutcomeTemplates } = await import("@/lib/scoring-vocab");

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT: Record<string, string> = JSON.parse(readFileSync(join(HERE, "../../../dictionaries/en/public.json"), "utf8"));

const render = (style: string) =>
  renderToStaticMarkup(
    <OverlayStage
      fixtureId="f1"
      initial={{ status: "scheduled", summary: null, outcome: null, lastSeq: null, venueTz: "UTC" }}
      realtime={false}
      sportKey="badminton"
      style={style as RegistryModule.TemplateId}
      sides={[
        { id: "home", name: "Milton Keynes Rovers" },
        { id: "away", name: "Northbridge Athletic" },
      ]}
      startLabel={null}
      dict={DICT}
      decidedTemplates={decidedOutcomeTemplates((k) => k)}
      snapshotOnly
    />,
  );

describe("no card region ⇒ no match card", () => {
  it("premise: the injected box leaves no strip", () => {
    expect(cardRegionFor({ x: 0, y: 0, width: 1920, height: 1080 })).toBeNull();
  });

  it("a warming fixture on the shipped bug renders the card (the positive pair)", () => {
    expect(render("bug")).toContain('data-testid="ovl-slate-card"');
  });

  it("the same fixture on a template whose box fills the canvas renders NO card, and the scorebug still draws", () => {
    const html = render("full");
    expect(html).not.toContain('data-testid="ovl-slate-card"');
    expect(html).toContain('class="ovl-bug"');
  });
});
