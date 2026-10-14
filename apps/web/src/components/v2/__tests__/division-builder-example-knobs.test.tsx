// The wizard's "Show example fixtures" draw against format changes (ESLint
// L3). A change to the format used to clear the shown example from an effect;
// the example now carries the knobs it was drawn for and is dropped during
// render when they differ. Sequence pinned: draw → shown; change the format →
// gone; change it BACK → still gone (a cleared example is not resurrected);
// and the case the effect got wrong — an answer still in flight when the
// format changes must not appear under the new format.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import uiEn from "@/dictionaries/en/ui.json";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

const SPORTS: SportOption[] = [
  { key: "generic", name: "Generic", variants: [{ key: "score", name: "Score", system: true }] },
];
const DE = "Double elimination";
const IPL = "Group + Playoffs (IPL style)";

function mount() {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: SPORTS,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "community",
  });
}
type H = ReturnType<typeof mount>;
const press = (h: H, label: string) => {
  const el = h.tree().find((e) => e.type === "button" && textOf(e) === label);
  if (!el) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  (propsOf(el).onClick as () => void)();
};
const pickFormat = (h: H, label: string) => {
  const labelEl = h.tree().find((e) => e.type === "label" && textOf(e).includes(label));
  if (!labelEl) throw new Error(`no template option labelled ${JSON.stringify(label)}`);
  const radio = walk(labelEl).find((e) => e.type === "input" && propsOf(e).type === "radio");
  (propsOf(radio!).onChange as () => void)();
};
const phases = (title: string) => ({ phases: [{ title, sections: [] }] });
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  apiV1Mock.mockReset();
});

describe("division builder — the example draw follows the format it was drawn for", () => {
  it("shown → format changed: gone → changed back: still gone; a fresh draw shows again", async () => {
    apiV1Mock.mockResolvedValueOnce(phases("ZqDrawOne")).mockResolvedValueOnce(phases("ZqDrawTwo"));
    const h = mount();
    pickFormat(h, DE);
    press(h, uiEn["wizard.showExample"]);
    await flush();
    expect(apiV1Mock).toHaveBeenCalledTimes(1);
    expect(h.text()).toContain("ZqDrawOne");

    pickFormat(h, IPL);
    expect(h.text()).not.toContain("ZqDrawOne");
    pickFormat(h, DE);
    expect(h.text(), "a cleared example stays cleared").not.toContain("ZqDrawOne");

    press(h, uiEn["wizard.generate"]);
    await flush();
    expect(h.text()).toContain("ZqDrawTwo");
  });

  it("an answer still in flight when the format changes never shows under the new format", async () => {
    let answer: (v: unknown) => void = () => {};
    apiV1Mock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const h = mount();
    pickFormat(h, DE);
    press(h, uiEn["wizard.showExample"]);
    pickFormat(h, IPL);
    answer(phases("ZqLateDraw"));
    await flush();
    expect(apiV1Mock).toHaveBeenCalledTimes(1);
    expect(h.text()).not.toContain("ZqLateDraw");
  });
});
