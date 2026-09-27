// Owner decision 2026-09-27: a draft competition is unlisted until published.
// The organiser learns it where they set the status — competition settings —
// in one sentence under the Status select: reachable by link, not listed on
// their page or in search until they publish.
//
// Shown ONLY for a PUBLIC draft. For a private draft the "with the link"
// sentence is false (a private competition shows nobody anything), and for an
// unlisted one "until you publish" is false (publishing never lists it). The
// sentence follows the FORM's status, so choosing "published" in the select
// takes it away before the save.
//
// vitest runs `environment: "node"` with no jsdom, so the island is driven
// through the shared hook harness (see _hook-harness.tsx).
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { CompetitionSettings } from "../competition-settings";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});

// The REAL English catalog: `t()` returns the KEY on a miss, so this also
// fails if the key was never added to en/ui.json.
const HINT = t(uiEn as unknown as Dict, "compset.draftUnlisted");

const mount = (competition: { visibility: string; status: string }) =>
  renderIsland(CompetitionSettings, {
    competition: {
      id: "c1",
      name: "Summer Cup",
      slug: "summer-cup",
      description: null,
      starts_on: "2026-06-01",
      ends_on: "2026-08-31",
      frozen: false,
      discoverable: false,
      discovery: {},
      branding: {},
      ...competition,
    },
    orgId: "o1",
    canEdit: true,
    discoveryBranding: false,
    viewerPlan: "community",
  });

const statusSelect = (tree: ReactElement[]) =>
  tree.find((el) => el.type === "select" && propsOf(el).value !== undefined && [
    "draft", "published", "live", "completed", "archived",
  ].includes(propsOf(el).value as string))!;

describe("CompetitionSettings — the draft's listing hint", () => {
  it("premise: the hint is real copy, not a missing key", () => {
    expect(HINT).not.toBe("compset.draftUnlisted");
    expect(HINT).toContain("link");
  });

  it("a PUBLIC DRAFT says it is link-only and not listed until published", () => {
    expect(mount({ visibility: "public", status: "draft" }).text()).toContain(HINT);
  });

  it("a PUBLISHED public competition does not (the positive pair's other half)", () => {
    expect(mount({ visibility: "public", status: "published" }).text()).not.toContain(HINT);
  });

  it("a PRIVATE or UNLISTED draft does not — the sentence would be false for both", () => {
    expect(mount({ visibility: "private", status: "draft" }).text()).not.toContain(HINT);
    expect(mount({ visibility: "unlisted", status: "draft" }).text()).not.toContain(HINT);
  });

  it("follows the form: choosing 'published' in the Status select takes the hint away before any save", () => {
    const island = mount({ visibility: "public", status: "draft" });
    expect(island.text()).toContain(HINT);
    (propsOf(statusSelect(island.tree())).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "published" },
    });
    expect(island.text()).not.toContain(HINT);
  });
});

// Review 2026-09-27 (m2): the hint sat INSIDE the Status <label>, so a screen
// reader announced it as part of the select's NAME. It is a description, so it
// lives outside the label and the select points at it with aria-describedby —
// and points at nothing when the hint is not rendered (a dangling id reference
// is its own a11y defect).
describe("CompetitionSettings — the hint DESCRIBES the Status select, it is not part of its name", () => {
  const hintEl = (tree: ReactElement[]) =>
    tree.find((el) => propsOf(el)["data-testid"] === "compset-draft-unlisted");
  const statusLabel = (tree: ReactElement[]) =>
    tree.find((el) => el.type === "label" && walk(el).some((c) => c === statusSelect(tree)))!;

  it("a public draft: the select's aria-describedby names the hint's id", () => {
    const tree = mount({ visibility: "public", status: "draft" }).tree();
    const hint = hintEl(tree)!;
    const id = propsOf(hint).id as string;
    expect(id, "the hint carries an id").toBeTruthy();
    expect(propsOf(statusSelect(tree))["aria-describedby"]).toBe(id);
  });

  it("the hint is NOT inside the select's <label>, which still reads 'Status' first", () => {
    const tree = mount({ visibility: "public", status: "draft" }).tree();
    const label = statusLabel(tree);
    expect(label, "the select still has its own label").toBeDefined();
    expect(textOf(label)).toMatch(new RegExp(`^${t(uiEn as unknown as Dict, "compset.status")}`));
    expect(textOf(label)).not.toContain(HINT);
    expect(walk(label).some((el) => propsOf(el)["data-testid"] === "compset-draft-unlisted")).toBe(false);
  });

  it("a published competition: no hint, and no dangling aria-describedby", () => {
    const tree = mount({ visibility: "public", status: "published" }).tree();
    expect(hintEl(tree)).toBeUndefined();
    expect(propsOf(statusSelect(tree))["aria-describedby"]).toBeUndefined();
  });
});
