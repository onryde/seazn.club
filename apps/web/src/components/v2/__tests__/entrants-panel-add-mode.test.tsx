// The Add-entrant form's "Existing team / New entrant" mode (ESLint L3). The
// default used to be copied into state by an effect once teams loaded; it is
// now derived (`picked ?? (canExisting ? "existing" : "new")`). Pinned: the
// server render already defaults to "existing" when teams are there (it used to
// render "new" and flip one effect later), the default FOLLOWS the teams
// arriving, and an explicit pick is never overridden — through the teams
// emptying and coming back. `AddEntrantForm` is module-private, so it is taken
// from the panel's own tree (the element that carries `importControls`).
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { EntrantsPanel } from "@/components/v2/entrants-panel";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: vi.fn(async (url: string) => (url.startsWith("/api/v1/persons?") ? { items: [], nextCursor: null } : [])),
}));

const MODEL: EffectiveEntrantModel = {
  kinds: ["individual", "pair", "team"],
  defaultKind: "individual",
  squadNumbers: true,
  captain: true,
  maxTeamMembers: null,
};
const TEAM = {
  id: "t1",
  name: "Zq Rovers",
  short_name: null,
  club_name: null,
  club_short_name: null,
  logo_path: null,
  latest_entrant_id: null,
  squad_count: 0,
};

/** The form component and the props the panel hands it. */
function addEntrantForm() {
  const panel = renderIsland(EntrantsPanel, {
    divisionId: "div-1",
    entrants: [],
    canEdit: true,
    positionGroups: [],
    roles: [],
    eligibility: { category: null, age_min: null, age_max: null, eligibility_note: null },
    entrantModel: MODEL,
    viewerPlan: "community" as const,
    divisionStatus: "setup",
  });
  const el = panel.tree().find((e) => propsOf(e).importControls !== undefined);
  if (!el) throw new Error("AddEntrantForm element (importControls prop) not found");
  return { Form: el.type as (p: Record<string, unknown>) => ReactElement, base: propsOf(el) };
}

const toggle = (tree: ReactElement[], label: string) =>
  tree.find((e) => e.type === "button" && textOf(e) === label);
const pressed = (tree: ReactElement[]) =>
  tree.filter((e) => e.type === "button" && propsOf(e)["aria-pressed"] === true).map(textOf);

describe("Add entrant — Existing team / New entrant", () => {
  it("server render defaults to Existing team when the org has teams", () => {
    const { Form, base } = addEntrantForm();
    const html = renderToStaticMarkup(createElement(Form, { ...base, teams: [TEAM] }));
    expect(html).toMatch(/aria-pressed="true"[^>]*>Existing team</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>New entrant</);
  });

  it("the default follows the teams arriving; a pick survives the teams emptying and returning", () => {
    const { Form, base } = addEntrantForm();
    const form = renderIsland(Form, { ...base, teams: [] as (typeof TEAM)[] });
    expect(toggle(form.tree(), "Existing team"), "no teams — no toggle").toBeUndefined();

    form.rerender({ ...base, teams: [TEAM] });
    expect(pressed(form.tree())).toEqual(["Existing team"]);

    (propsOf(toggle(form.tree(), "New entrant")!).onClick as () => void)();
    expect(pressed(form.tree())).toEqual(["New entrant"]);

    form.rerender({ ...base, teams: [] });
    form.rerender({ ...base, teams: [TEAM] });
    expect(pressed(form.tree()), "an explicit pick is never overridden").toEqual(["New entrant"]);
  });
});
