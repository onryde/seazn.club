// Settings C8 (owner 2026-11-11, mock set11c01 C1/C2): competition settings in the New competition form's two-column
// card. What a click does is pinned here, because a static render cannot see it:
//
//   - the Status chip is form state: a pick is listed as unsaved and rides the one Save;
//   - the save bar names what is unsaved, Discard puts the saved values back, and a save moves the baseline (so a
//     second edit lists only itself);
//   - city and country are gone from the form and never sent — `discovery` carries only the keys the form edits, and
//     only for an org entitled to them;
//   - Branding is always a tab: a plan without `dashboard.theme` is told so beside the control;
//   - leaving Private with a youth division asks first.
//
// vitest is `environment: "node"`: the island is driven through the hook harness, expanded through the C8 frame.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { CompetitionSettings } from "../competition-settings";
import { expandSettingsCard } from "./_settings-card-expand";
import { BrandColorPicker } from "@/components/brand-color-picker";
import { VisibilitySegmented } from "@/components/ui/visibility-segmented";
import { ShowcaseOptIn } from "../showcase-optin";
import { CompetitionReach } from "../competition-reach";
import { apiV1 } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});
const confirm = vi.fn();
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => confirm }));

const api = vi.mocked(apiV1);
const say = (key: string, vars?: Record<string, string | number>) => t(uiEn as unknown as Dict, key, vars);

type Over = Partial<{
  visibility: string;
  status: string;
  discoverable: boolean;
  discovery: Record<string, string | null>;
  canEdit: boolean;
  frozen: boolean;
  discoveryBranding: boolean;
  themeBranding: boolean;
  hasYouthDivisions: boolean;
}>;

const mount = (o: Over = {}) =>
  renderIsland(
    CompetitionSettings,
    {
      competition: {
        id: "c1",
        name: "Harbour Vale Winter Open",
        slug: "winter-open",
        description: "Three days by the harbour.",
        starts_on: "2026-11-14",
        ends_on: "2026-11-16",
        visibility: o.visibility ?? "public",
        status: o.status ?? "published",
        frozen: o.frozen ?? false,
        discoverable: o.discoverable ?? false,
        discovery: o.discovery ?? { city: "Harbour Vale", country: "United Kingdom", tagline: "By the harbour", hero_image_path: null },
        branding: {},
      },
      title: "Settings — Harbour Vale Winter Open",
      orgId: "o1",
      canEdit: o.canEdit ?? true,
      discoveryBranding: o.discoveryBranding ?? false,
      themeBranding: o.themeBranding ?? false,
      hasYouthDivisions: o.hasYouthDivisions ?? false,
      billingHref: "/o/harbour/billing",
      viewerPlan: "community",
    },
    expandSettingsCard,
  );
type Island = ReturnType<typeof mount>;

const STATUSES = ["draft", "published", "live", "completed", "archived"];
const statusSelect = (tree: ReactElement[]) =>
  tree.find((el) => el.type === "select" && STATUSES.includes(propsOf(el).value as string))!;
const nameInput = (tree: ReactElement[]) =>
  tree.find((el) => el.type === "input" && propsOf(el).maxLength === 200 && propsOf(el).required === true)!;
const saveMessage = (tree: ReactElement[]) =>
  textOf(tree.find((el) => propsOf(el)["data-testid"] === "settings-save-bar-message")!);
const discard = (tree: ReactElement[]) =>
  tree.find((el) => el.type === "button" && textOf(el) === say("settings.saveBar.discard"))!;
const tabNamed = (tree: ReactElement[], key: string) =>
  tree.find((el) => propsOf(el).role === "tab" && textOf(el) === say(key));

const choose = (island: Island, value: string) =>
  (propsOf(statusSelect(island.tree())).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const typeName = (island: Island, value: string) =>
  (propsOf(nameInput(island.tree())).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const submit = async (island: Island) => {
  const form = island.tree().find((el) => el.type === "form")!;
  await (propsOf(form).onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
};
const sent = (call = 0) => (api.mock.calls[call]![1] as { json: Record<string, unknown> }).json;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue({} as never);
  confirm.mockReset();
});

describe("CompetitionSettings C8 — the save bar says what is unsaved", () => {
  it("premise: every key the bar reads is real English copy", () => {
    const keys = ["settings.saveBar.unsaved", "settings.saveBar.discard", "compset.save", "compset.saved", "compset.preview", "compset.taglineHint"];
    let checked = 0;
    for (const k of keys) {
      expect(say(k), k).not.toBe(k);
      checked++;
    }
    expect(checked).toBe(keys.length);
    expect(say("compset.save")).toBe("Save changes");
  });

  it("empty case first: nothing edited — the line is empty and Discard is disabled", () => {
    const tree = mount().tree();
    expect(saveMessage(tree)).toBe("");
    expect(propsOf(discard(tree)).disabled).toBe(true);
  });

  it("names each edited field by its label, in page order, and Discard puts the saved values back", () => {
    const island = mount();
    typeName(island, "Harbour Vale Winter Open 2026");
    choose(island, "live");
    expect(saveMessage(island.tree())).toBe(
      say("settings.saveBar.unsaved", { fields: `${say("compset.status")}, ${say("compset.name")}` }),
    );
    expect(propsOf(discard(island.tree())).disabled).toBe(false);

    (propsOf(discard(island.tree())).onClick as () => void)();
    expect(propsOf(nameInput(island.tree())).value).toBe("Harbour Vale Winter Open");
    expect(propsOf(statusSelect(island.tree())).value).toBe("published");
    expect(saveMessage(island.tree())).toBe("");
    expect(api, "Discard sends nothing").not.toHaveBeenCalled();
  });

  it("a status picked back to the saved one is not a change (the empty set again)", () => {
    const island = mount();
    choose(island, "live");
    choose(island, "published");
    expect(saveMessage(island.tree())).toBe("");
  });
});

describe("CompetitionSettings C8 — the Status chip is form state, saved by the one Save", () => {
  it("a pick is unsaved (dashed chip) until Save, then PATCHes with the rest and says Saved.", async () => {
    const island = mount();
    const chip = () => island.tree().find((el) => propsOf(el)["data-testid"] === "compset-status-chip")!;
    expect(String(propsOf(chip()).className)).not.toContain("border-dashed");
    choose(island, "live");
    expect(String(propsOf(chip()).className)).toContain("border-dashed");
    expect(api, "picking alone saves nothing").not.toHaveBeenCalled();

    await submit(island);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]![0]).toBe("/api/v1/competitions/c1");
    expect(sent().status).toBe("live");
    expect(saveMessage(island.tree())).toBe(say("compset.saved"));
    expect(String(propsOf(chip()).className), "saved: no longer marked").not.toContain("border-dashed");
  });

  it("the sequence: after a save, a second edit lists only itself", async () => {
    const island = mount();
    choose(island, "live");
    await submit(island);
    typeName(island, "Renamed");
    expect(saveMessage(island.tree())).toBe(say("settings.saveBar.unsaved", { fields: say("compset.name") }));
  });

  it("a failed save keeps the edit unsaved", async () => {
    api.mockRejectedValueOnce(new Error("boom"));
    const island = mount();
    choose(island, "live");
    await submit(island);
    expect(saveMessage(island.tree())).toBe(say("settings.saveBar.unsaved", { fields: say("compset.status") }));
    expect(textOf(island.tree())).toContain("boom");
  });

  it("a viewer: the chip is disabled and there is no save bar", () => {
    const tree = mount({ canEdit: false }).tree();
    expect(propsOf(statusSelect(tree)).disabled).toBe(true);
    expect(tree.some((el) => propsOf(el)["data-testid"] === "settings-save-bar")).toBe(false);
    expect(propsOf(nameInput(tree)).disabled).toBe(true);
  });
});

describe("CompetitionSettings C8 — city and country are gone, and stay stored", () => {
  it("no city or country field is drawn — by input name, placeholder and old test id", () => {
    const tree = mount({ discoverable: true, discoveryBranding: true }).tree();
    const inputs = tree.filter((el) => el.type === "input" || el.type === "select");
    expect(inputs.length, "anti-vacuity: the form draws inputs").toBeGreaterThan(0);
    for (const el of inputs) {
      expect(String(propsOf(el).name ?? ""), "input name").not.toMatch(/city|country/i);
      expect(String(propsOf(el)["data-testid"] ?? ""), "input testid").not.toMatch(/city|country/i);
    }
    expect(tree.some((el) => /compset-(city|country)/.test(String(propsOf(el)["data-testid"] ?? "")))).toBe(false);
    expect(textOf(tree)).not.toContain("Harbour Vale, United Kingdom");
  });

  it("the dead keys are gone from the English dictionary", () => {
    const dead = ["compset.city", "compset.country", "compset.slug"];
    for (const k of dead) expect(Object.hasOwn(uiEn, k), k).toBe(false);
  });

  it("no hero image input is drawn, and a save omits hero_image_path so a stored value survives", async () => {
    const island = mount({
      discoveryBranding: true,
      discovery: { tagline: "t", hero_image_path: "heroes/o1/abc.png" },
    });
    (propsOf(tabNamed(island.tree(), "compset.tab.branding")!).onClick as () => void)();
    const tree = island.tree();
    const inputs = tree.filter((el) => el.type === "input");
    expect(inputs.length, "anti-vacuity: the Branding tab draws inputs (tagline at least)").toBeGreaterThan(0);
    expect(inputs.some((el) => propsOf(el).placeholder === "https://" || propsOf(el).type === "url")).toBe(false);
    expect(Object.hasOwn(uiEn, "compset.heroUrl")).toBe(false);
    await submit(island);
    expect(api).toHaveBeenCalledTimes(1);
    expect(sent().discovery).toEqual({ tagline: "t" });
    expect(Object.hasOwn(sent().discovery as object, "hero_image_path")).toBe(false);
  });

  it("a blank name (General's required input is unmounted on Branding) is refused with the missing-name message, nothing sent", async () => {
    const island = mount();
    typeName(island, "   ");
    (propsOf(tabNamed(island.tree(), "compset.tab.branding")!).onClick as () => void)();
    await submit(island);
    expect(api).not.toHaveBeenCalled();
    expect(textOf(island.tree())).toContain(say("comp.wizard.missing.name"));
  });

  it("an org without discovery.branding sends NO discovery key at all", async () => {
    const island = mount({ discoveryBranding: false });
    typeName(island, "Renamed");
    await submit(island);
    expect(Object.hasOwn(sent(), "discovery")).toBe(false);
  });

  it("an entitled org sends exactly the keys the form edits — never city or country", async () => {
    const island = mount({ discoveryBranding: true });
    await submit(island);
    expect(Object.keys(sent().discovery as object).sort()).toEqual(["tagline"]);
    expect(sent().discovery).toEqual({ tagline: "By the harbour" });
  });
});

describe("CompetitionSettings C8 — the New competition form's controls, wired to the form", () => {
  it("mounts the segmented visibility, the reach list (with this competition's status) and the Showcase switch", () => {
    const tree = mount({ status: "draft" }).tree();
    expect(tree.filter((el) => el.type === VisibilitySegmented)).toHaveLength(1);
    expect(tree.filter((el) => el.type === ShowcaseOptIn)).toHaveLength(1);
    const reach = tree.find((el) => el.type === CompetitionReach)!;
    expect(propsOf(reach).status, "a draft's reach says 'once you publish', not the new-form default").toBe("draft");
  });

  it("leaving Public switches Showcase off, and the save sends it off", async () => {
    const island = mount({ visibility: "public", discoverable: true });
    const seg = island.tree().find((el) => el.type === VisibilitySegmented)!;
    (propsOf(seg).onChange as (v: string) => void)("unlisted");
    await flush();
    await submit(island);
    expect(sent().visibility).toBe("unlisted");
    expect(sent().discoverable).toBe(false);
  });

  it("a frozen competition: the controls are read-only", () => {
    const tree = mount({ frozen: true }).tree();
    expect(propsOf(tree.find((el) => el.type === VisibilitySegmented)!).disabled).toBe(true);
    expect(propsOf(tree.find((el) => el.type === ShowcaseOptIn)!).disabled).toBe(true);
  });
});

describe("CompetitionSettings C8 — the youth interstitial (v3/11 gap 8)", () => {
  const pick = async (island: Island, v: string) => {
    const seg = island.tree().find((el) => el.type === VisibilitySegmented)!;
    (propsOf(seg).onChange as (v: string) => void)(v);
    await flush();
  };

  it("leaving Private with a youth division asks; declining keeps it Private", async () => {
    confirm.mockResolvedValue(false);
    const island = mount({ visibility: "private", hasYouthDivisions: true });
    await pick(island, "public");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(propsOf(island.tree().find((el) => el.type === VisibilitySegmented)!).value).toBe("private");
  });

  it("accepting applies the pick", async () => {
    confirm.mockResolvedValue(true);
    const island = mount({ visibility: "private", hasYouthDivisions: true });
    await pick(island, "unlisted");
    expect(propsOf(island.tree().find((el) => el.type === VisibilitySegmented)!).value).toBe("unlisted");
  });

  it("positive pair: no youth division, or not leaving Private — no question", async () => {
    const island = mount({ visibility: "private", hasYouthDivisions: false });
    await pick(island, "public");
    const fromPublic = mount({ visibility: "public", hasYouthDivisions: true });
    await pick(fromPublic, "unlisted");
    expect(confirm).not.toHaveBeenCalled();
    expect(propsOf(island.tree().find((el) => el.type === VisibilitySegmented)!).value).toBe("public");
  });
});

describe("CompetitionSettings C8 — Branding is always a tab", () => {
  const openBranding = (island: Island) => (propsOf(tabNamed(island.tree(), "compset.tab.branding")!).onClick as () => void)();

  it("without dashboard.theme: the tab is there, the picker is not, and the plan line says why", () => {
    const island = mount({ themeBranding: false });
    expect(tabNamed(island.tree(), "compset.tab.branding")).toBeDefined();
    openBranding(island);
    const tree = island.tree();
    expect(tree.some((el) => el.type === BrandColorPicker)).toBe(false);
    const notice = tree.find((el) => propsOf(el)["data-feature"] === "dashboard.theme");
    expect(notice).toBeDefined();
    expect(textOf(notice!)).toContain(say("settings.upgrade.brandColor"));
  });

  it("with dashboard.theme: the picker, and a pick rides the save as branding", async () => {
    const island = mount({ themeBranding: true });
    openBranding(island);
    const picker = island.tree().find((el) => el.type === BrandColorPicker)!;
    expect(island.tree().some((el) => propsOf(el)["data-feature"] === "dashboard.theme")).toBe(false);
    (propsOf(picker).onSelect as (hex: string | null) => void)("#0f766e");
    expect(saveMessage(island.tree())).toBe(say("settings.saveBar.unsaved", { fields: say("compset.brandColor") }));
    await submit(island);
    expect(sent().branding).toEqual({ colors: { primary: "#0f766e" } });
  });

  it("the preview shows the tagline only where the plan shows it", () => {
    const entitled = mount({ discoveryBranding: true });
    openBranding(entitled);
    const preview = (island: Island) => textOf(island.tree().find((el) => propsOf(el)["data-testid"] === "compset-brand-preview")!);
    expect(preview(entitled)).toContain("By the harbour");
    const community = mount({ discoveryBranding: false });
    openBranding(community);
    expect(preview(community)).not.toContain("By the harbour");
    expect(preview(community)).toContain("Harbour Vale Winter Open");
  });
});
