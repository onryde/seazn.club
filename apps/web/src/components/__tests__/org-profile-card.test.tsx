// Settings C8 (owner 2026-11-11, mock set11c01 O1): the Organisation tab's one card. Rename, brand colour and About
// used to be three islands with three saves; now one Save sends ONE request carrying only what changed. What a click
// sends is pinned here — the body, the route, the navigation after a rename — because a static render cannot see it.
//
// vitest is `environment: "node"`: the island is driven through the hook harness, expanded through the C8 frame.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { expandSettingsCard } from "@/components/v2/__tests__/_settings-card-expand";
import { OrgProfileCard, profilePatch, type OrgBrandGate } from "../org-profile-card";
import { BrandColorPicker } from "../brand-color-picker";
import { ProseEditor } from "../prose-editor";
import { api } from "@/lib/client";
import { routes } from "@/lib/routes";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { publicThemeStyle } from "@/lib/public-theme";
import { BRAND_PALETTE } from "@/lib/brand-palette";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh }),
  usePathname: () => "/o/riverside/settings",
}));
vi.mock("@/lib/client", () => ({ api: vi.fn() }));
const patch = vi.mocked(api);
const say = (key: string, vars?: Record<string, string | number>) => t(uiEn as unknown as Dict, key, vars);

const OPEN: OrgBrandGate = { locked: false };
const LOCKED: OrgBrandGate = { locked: true, notice: <p data-testid="brand-locked">Brand color requires Pro</p> };

const mount = (o: { canEdit?: boolean; brandGate?: OrgBrandGate; about?: string | null } = {}) =>
  renderIsland(
    OrgProfileCard,
    {
      orgId: "o1",
      orgSlug: "riverside",
      initialName: "Riverside Community Club",
      initialBranding: { colors: { primary: "#0f766e" } },
      initialAbout: o.about === undefined ? "We play on Tuesdays." : o.about,
      canEdit: o.canEdit ?? true,
      brandGate: o.brandGate ?? OPEN,
      logo: <div data-testid="logo-slot" />,
      defaults: <div data-testid="defaults-slot" />,
    },
    expandSettingsCard,
  );
type Island = ReturnType<typeof mount>;

const byTestId = (tree: ReactElement[], id: string) => tree.find((el) => propsOf(el)["data-testid"] === id);
const nameInput = (tree: ReactElement[]) => byTestId(tree, "org-name-input")!;
const typeName = (island: Island, value: string) =>
  (propsOf(nameInput(island.tree())).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const typeAbout = (island: Island, md: string) =>
  (propsOf(island.tree().find((el) => el.type === ProseEditor)!).onChange as (md: string) => void)(md);
const submit = async (island: Island) => {
  const form = island.tree().find((el) => el.type === "form")!;
  await (propsOf(form).onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
};
const message = (island: Island) => textOf(byTestId(island.tree(), "settings-save-bar-message")!);

beforeEach(() => {
  patch.mockReset();
  patch.mockResolvedValue({ slug: "riverside" } as never);
  replace.mockReset();
  refresh.mockReset();
});

describe("profilePatch — only what changed rides", () => {
  const base = { name: "Riverside", brand: "#0f766e", about: "Hi" };

  it("empty case first: nothing changed is no request at all", () => {
    expect(profilePatch(base, base, false)).toBeNull();
    expect(profilePatch({ ...base, name: "  Riverside  " }, base, false), "whitespace is not a rename").toBeNull();
  });

  it("each key alone, and a cleared About is null", () => {
    expect(profilePatch({ ...base, name: "River" }, base, false)).toEqual({ name: "River" });
    expect(profilePatch({ ...base, brand: null }, base, false)).toEqual({ branding: { colors: { primary: null } } });
    expect(profilePatch({ ...base, about: "   " }, base, false)).toEqual({ about: null });
  });

  it("a locked colour never rides, even if the state differs", () => {
    expect(profilePatch({ ...base, brand: "#dc2626" }, base, true)).toBeNull();
  });
});

describe("OrgProfileCard — one Save, one request", () => {
  it("premise: the card's copy is real English", () => {
    let checked = 0;
    for (const k of ["settings.org.saveChanges", "settings.org.publicPage", "settings.org.viewPage", "settings.org.viewPageAria", "settings.saveBar.unsaved", "settings.saveBar.discard"]) {
      expect(say(k), k).not.toBe(k);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("nothing edited: an empty line, Discard disabled, and Save sends nothing", async () => {
    const island = mount();
    expect(message(island)).toBe("");
    await submit(island);
    expect(patch).not.toHaveBeenCalled();
  });

  it("About alone: PATCH /api/orgs/o1 with { about } and nothing else; no navigation", async () => {
    const island = mount();
    typeAbout(island, "We play on Thursdays.");
    expect(message(island)).toBe(say("settings.saveBar.unsaved", { fields: say("settings.org.about") }));
    await submit(island);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![0]).toBe("/api/orgs/o1");
    expect((patch.mock.calls[0]![1] as { method: string; json: unknown }).method).toBe("PATCH");
    expect((patch.mock.calls[0]![1] as { json: unknown }).json).toEqual({ about: "We play on Thursdays." });
    expect(replace).not.toHaveBeenCalled();
    expect(message(island)).toBe(say("settings.org.saved"));
  });

  it("name, colour and About together: ONE request with all three", async () => {
    patch.mockResolvedValue({ slug: "riverside-club" } as never);
    const island = mount();
    typeName(island, "Riverside Club");
    (propsOf(island.tree().find((el) => el.type === BrandColorPicker)!).onSelect as (hex: string | null) => void)("#dc2626");
    typeAbout(island, "");
    await submit(island);
    expect(patch).toHaveBeenCalledTimes(1);
    expect((patch.mock.calls[0]![1] as { json: unknown }).json).toEqual({
      name: "Riverside Club",
      branding: { colors: { primary: "#dc2626" } },
      about: null,
    });
    // A rename regenerates the slug: the page moves to the new URL.
    expect(replace).toHaveBeenCalledWith(routes.orgSettings("riverside-club"));
  });

  it("the sequence: after a save, a second edit sends only itself", async () => {
    const island = mount();
    typeAbout(island, "First");
    await submit(island);
    typeName(island, "Renamed");
    await submit(island);
    expect(patch).toHaveBeenCalledTimes(2);
    expect((patch.mock.calls[1]![1] as { json: unknown }).json).toEqual({ name: "Renamed" });
  });

  it("Discard puts the saved values back", () => {
    const island = mount();
    typeName(island, "Something else");
    const discard = island.tree().find((el) => el.type === "button" && textOf(el) === say("settings.saveBar.discard"))!;
    expect(propsOf(discard).disabled).toBe(false);
    (propsOf(discard).onClick as () => void)();
    expect(propsOf(nameInput(island.tree())).value).toBe("Riverside Community Club");
    expect(message(island)).toBe("");
  });

  it("a failed save says why and keeps the edit unsaved", async () => {
    patch.mockRejectedValueOnce(new Error("name taken"));
    const island = mount();
    typeName(island, "Taken");
    await submit(island);
    expect(textOf(island.tree())).toContain("name taken");
    expect(message(island)).toBe(say("settings.saveBar.unsaved", { fields: say("settings.org.nameLabel") }));
  });
});

describe("OrgProfileCard — what it shows", () => {
  it("View page opens the org's public page in a new tab", () => {
    const link = byTestId(mount().tree(), "org-view-page")!;
    expect(propsOf(link).href).toBe(routes.publicHub("riverside"));
    expect(propsOf(link).target).toBe("_blank");
    expect(String(propsOf(link).rel)).toContain("noopener");
  });

  it("the brand colour: the picker when open, the page's refusal when locked — never both", () => {
    const open = mount({ brandGate: OPEN }).tree();
    expect(byTestId(open, "org-brand-color-picker")).toBeDefined();
    expect(byTestId(open, "brand-locked")).toBeUndefined();
    const locked = mount({ brandGate: LOCKED }).tree();
    expect(byTestId(locked, "org-brand-color-picker")).toBeUndefined();
    expect(locked.some((el) => el.type === BrandColorPicker)).toBe(false);
    expect(byTestId(locked, "brand-locked")).toBeDefined();
  });

  it("the About preview wears the saved colour even when the picker is locked, and the picked one when open", () => {
    // Locked keeps the pre-C8 behaviour that settings-entitlement-gates.spec.ts (Finding A, Case 7) observes in a
    // browser: the editor's own preview is not plan-masked. Expected values come from the theme library, not the card.
    const previewOf = (island: Island) => propsOf(island.tree().find((el) => el.type === ProseEditor)!).previewStyle;
    const saved = publicThemeStyle({ colors: { primary: "#0f766e" } });
    expect(saved, "premise: the saved colour themes at all").toBeDefined();

    expect(previewOf(mount({ brandGate: LOCKED })), "locked: still the saved colour").toEqual(saved);

    const open = mount({ brandGate: OPEN });
    expect(previewOf(open), "open, untouched: the saved colour").toEqual(saved);
    const picked = BRAND_PALETTE.find((s) => s.hex.toLowerCase() !== "#0f766e")!.hex;
    (propsOf(open.tree().find((el) => el.type === BrandColorPicker)!).onSelect as (hex: string | null) => void)(picked);
    expect(previewOf(open), "open, picked: the preview follows the form before any save").toEqual(
      publicThemeStyle({ colors: { primary: picked } }),
    );
    expect(publicThemeStyle({ colors: { primary: picked } }), "premise: the two colours theme differently").not.toEqual(saved);
  });

  it("an editor gets the logo and the defaults; a viewer gets neither, nor a Save, and the name is read-only", () => {
    const editor = mount().tree();
    expect(byTestId(editor, "logo-slot")).toBeDefined();
    expect(byTestId(editor, "defaults-slot")).toBeDefined();
    expect(byTestId(editor, "settings-save-bar")).toBeDefined();

    const viewer = mount({ canEdit: false }).tree();
    expect(byTestId(viewer, "logo-slot")).toBeUndefined();
    expect(byTestId(viewer, "defaults-slot")).toBeUndefined();
    expect(byTestId(viewer, "settings-save-bar")).toBeUndefined();
    expect(propsOf(nameInput(viewer)).disabled).toBe(true);
    // The public page is still theirs to open.
    expect(byTestId(viewer, "org-view-page")).toBeDefined();
  });

  it("a rename target: the tour's step still finds the name field", () => {
    const tree = mount().tree();
    const anchor = tree.find((el) => propsOf(el)["data-tour"] === "org-rename");
    expect(anchor).toBeDefined();
  });
});
