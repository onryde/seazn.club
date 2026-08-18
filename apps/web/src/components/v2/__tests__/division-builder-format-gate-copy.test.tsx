// Bug fix follow-up (2026-08-18, gate-copy): the template-gallery fix closed
// the catalog-template path (creating a competition from "League +
// Playoffs"), but an organiser can reach the SAME wrong copy by hand, from
// this wizard's own "Group + Playoffs (IPL style)" format card
// (format-templates.ts's group_playoffs -> a page_playoff stage) — the
// wizard's Pro gate read "Double-elimination brackets are a Pro format."
// for a page_playoff stage here too, because `<UpgradeGate feature=
// {paywallFeature} />` only ever had the bare feature key to go on.
//
// Unlike template-gallery.tsx (no jsdom, so its wiring is proven through a
// pure `paywallFromError` function plus a static UpgradeGate render),
// division-builder.tsx already has a working interactive-harness precedent
// for this exact submit-and-402 shape
// (division-builder-archived-slot-note.test.tsx): drive the real wizard
// through the real submit() with a mocked transport, and read what actually
// renders. This file follows that precedent for the end-to-end proof, and
// additionally pins the pure per-kind derivation
// (`paywallReasonForStages`) directly, the same way template-gallery's
// `paywallFromError` is pinned in template-gallery-paywall.test.tsx.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { featureReason } from "@/lib/feature-copy";
import { DivisionBuilder, paywallReasonForStages, type SportOption } from "@/components/v2/division-builder";
import type { StageDraft } from "@/components/v2/format-templates";
import uiEn from "@/dictionaries/en/ui.json";

const LEAGUE_STAGE: StageDraft = { kind: "league", name: "League", config: {}, progression: null };
const PAGE_PLAYOFF_STAGE: StageDraft = {
  kind: "page_playoff",
  name: "Playoffs",
  config: {},
  progression: {
    sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
    placement: "rank_order",
    timing: "on_complete",
  },
};
const DOUBLE_ELIM_STAGE: StageDraft = {
  kind: "double_elim",
  name: "Double elimination",
  config: {},
  progression: null,
};

describe("paywallReasonForStages — pure per-kind derivation", () => {
  it("names the Page playoff format when the submitted stages include a page_playoff stage", () => {
    const reason = paywallReasonForStages("formats.double_elim", [LEAGUE_STAGE, PAGE_PLAYOFF_STAGE]);
    expect(reason).toMatch(/page playoff/i);
    expect(reason).not.toMatch(/double-elimination/i);
  });

  it("keeps the existing double-elimination wording, byte-for-byte, for a real double_elim stage", () => {
    expect(paywallReasonForStages("formats.double_elim", [DOUBLE_ELIM_STAGE])).toBe(
      featureReason("formats.double_elim"),
    );
  });

  it("returns undefined for any other feature key — UpgradeGate's own default still applies", () => {
    expect(paywallReasonForStages("divisions.per_competition.max", [PAGE_PLAYOFF_STAGE])).toBeUndefined();
  });

  it("falls back to the double-elimination wording, defensively, if no stage was submitted yet", () => {
    expect(paywallReasonForStages("formats.double_elim", [])).toBe(featureReason("formats.double_elim"));
  });
});

// --- Interactive wiring proof, mirroring division-builder-archived-slot-note.test.tsx ---

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

function paymentRequired(featureKey: string) {
  return new ApiV1Error("Upgrade required", 402, "PAYMENT_REQUIRED", { feature_key: featureKey });
}

function mount() {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: SPORTS,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
  });
}

function button(h: ReturnType<typeof mount>, label: string) {
  const el = h.tree().find((e) => e.type === "button" && textOf(e) === label);
  if (!el) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  return el;
}

/** The format radio is a hidden (`sr-only`) input inside a clickable
 *  `<label>` — found by locating the LABEL by its visible text, then
 *  walking just that label's own subtree for its radio input, rather than
 *  guessing position in the fully-flattened tree. */
function templateRadio(h: ReturnType<typeof mount>, label: string) {
  const labelEl = h.tree().find((e) => e.type === "label" && textOf(e).includes(label));
  if (!labelEl) throw new Error(`no template option labelled ${JSON.stringify(label)}`);
  const radio = walk(labelEl).find((e) => e.type === "input" && propsOf(e).type === "radio");
  if (!radio) throw new Error(`no radio input inside the ${JSON.stringify(label)} label`);
  return radio;
}

/** `<UpgradeGate>` is itself a stateful function component, so the harness
 *  renders it one level deep and no further (component-ui-i18n /
 *  hook-harness memory: a nested stateful component stays OPAQUE to
 *  `tree()`) — its own "Double-elimination brackets…" text never appears in
 *  `h.text()`. Read the PROPS it was actually given instead, exactly like
 *  division-builder-archived-slot-note.test.tsx's "still renders the
 *  upgrade gate for the refused key" case does. */
function gates(h: ReturnType<typeof mount>) {
  return h.tree().filter((el) => propsOf(el).feature === "formats.double_elim");
}

/** Name -> pick a format -> Scheduling tab -> Create. */
async function submitFromWizard(h: ReturnType<typeof mount>, formatLabel: string) {
  const nameInput = h
    .tree()
    .find((e) => e.type === "input" && propsOf(e).placeholder === uiEn["wizard.divisionNamePlaceholder"]);
  if (!nameInput) throw new Error("name input not found");
  (propsOf(nameInput).onChange as (e: unknown) => void)({ target: { value: "Open" } });

  (propsOf(button(h, uiEn["wizard.tab.format"])).onClick as () => void)();
  (propsOf(templateRadio(h, formatLabel)).onChange as () => void)();

  (propsOf(button(h, uiEn["wizard.tab.scheduling"])).onClick as () => void)();
  (propsOf(button(h, uiEn["wizard.create"])).onClick as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("division-builder's Pro gate names the actual gated format (hand-built stages, not a template)", () => {
  it("names the Page playoff format for the Group + Playoffs (IPL style) card, never double-elimination", async () => {
    apiV1Mock.mockReset();
    // First call: create the division (succeeds). Second call: create its
    // stages — this is the one that 402s on formats.double_elim, exactly as
    // createStages (usecases/stages.ts) does for a real page_playoff stage.
    apiV1Mock
      .mockResolvedValueOnce({ id: "d1", slug: "open" })
      .mockRejectedValueOnce(paymentRequired("formats.double_elim"));

    const h = mount();
    await submitFromWizard(h, "Group + Playoffs (IPL style)");

    expect(gates(h)).toHaveLength(1);
    const reason = propsOf(gates(h)[0]!).reason;
    expect(reason).toMatch(/page playoff/i);
    expect(reason).not.toMatch(/double-elimination/i);
  });

  it("keeps the double-elimination wording, byte-for-byte, for the Double elimination card itself", async () => {
    apiV1Mock.mockReset();
    apiV1Mock
      .mockResolvedValueOnce({ id: "d1", slug: "open" })
      .mockRejectedValueOnce(paymentRequired("formats.double_elim"));

    const h = mount();
    await submitFromWizard(h, "Double elimination");

    expect(gates(h)).toHaveLength(1);
    expect(propsOf(gates(h)[0]!).reason).toBe(featureReason("formats.double_elim"));
  });

  it("still renders the plain gate, with no reason override, for a 402 on an unrelated feature key", async () => {
    apiV1Mock.mockReset();
    apiV1Mock
      .mockResolvedValueOnce({ id: "d1", slug: "open" })
      .mockRejectedValueOnce(paymentRequired("divisions.per_competition.max"));

    const h = mount();
    await submitFromWizard(h, "Group + Playoffs (IPL style)");

    const limitGates = h.tree().filter((el) => propsOf(el).feature === "divisions.per_competition.max");
    expect(limitGates).toHaveLength(1);
    // Untouched — <UpgradeGate> falls back to its own featureReason(feature).
    expect(propsOf(limitGates[0]!).reason).toBeUndefined();
    expect(gates(h)).toHaveLength(0);
  });
});
