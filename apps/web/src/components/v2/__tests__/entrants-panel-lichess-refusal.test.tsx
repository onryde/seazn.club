// Fix round 1 (owner 2026-10-25): the organiser's roster refusal for an online-play division names WHICH reason - "link
// Lichess" or "reconnect Lichess" - and WHO, in the organiser's language, instead of the server's English message. This
// mounts the REAL EntrantsPanel through the hook harness (no jsdom here) and drives the same handlers a click would
// reach - `onImport` (the CSV import / add), a row's `onPatch` (the roster editor's save) and a row's `onSyncSquad`
// ("sync from squad") - so the join under test is the one a click would make: the write's rejection -> `fail` -> the banner.
// The pure mapping is entrants-lichess-refusal.test.ts; this file is the WIRING (a green mapping suite is blind to a
// panel that never calls it).
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { EntrantsPanel, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

const api = vi.hoisted(() => ({
  /** What the next POST to /entrants answers: an error to throw, or null for success. */
  nextPost: null as { message: string; status: number; code: string; extra: Record<string, unknown> } | null,
  posts: 0,
  personsLoaded: 0,
  /** What the next roster write on an existing entrant (PATCH /entrants/{id}, POST /entrants/{id}/roster/sync) answers: an error to throw, or null. */
  nextWrite: null as { message: string; status: number; code: string; extra: Record<string, unknown> } | null,
  /** Every roster write on an existing entrant the panel made, as "METHOD url" - a refusal test that made no write proved nothing. */
  writes: [] as string[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async (url: string, options?: { method?: string }) => {
      if (url.startsWith("/api/v1/persons?")) {
        api.personsLoaded++;
        return {
          items: [
            { id: "p-ada", full_name: "Ada Okonkwo", dob: null, gender: null },
            { id: "p-bo", full_name: "Bo Lindqvist", dob: null, gender: null },
          ],
          nextCursor: null,
        };
      }
      if (/^\/api\/v1\/entrants\/[^/]+(\/roster\/sync)?$/.test(url) && (options?.method === "PATCH" || options?.method === "POST")) {
        api.writes.push(`${options.method} ${url}`);
        const failure = api.nextWrite;
        api.nextWrite = null;
        if (failure) throw new actual.ApiV1Error(failure.message, failure.status, failure.code, failure.extra);
        return { members: [] };
      }
      if (url === "/api/v1/clubs" || url === "/api/v1/teams" || url.includes("/roster")) return [];
      if (url.endsWith("/entrants") && options?.method === "POST") {
        api.posts++;
        const failure = api.nextPost;
        api.nextPost = null;
        if (failure) throw new actual.ApiV1Error(failure.message, failure.status, failure.code, failure.extra);
        return [];
      }
      return {};
    }),
  };
});

const EN_UI: Dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8")) as Dict;

const NO_ELIGIBILITY: EntrantsPanelEligibility = { category: null, age_min: null, age_max: null, eligibility_note: null };
const MODEL: EffectiveEntrantModel = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null };

const panelProps = () => ({
  divisionId: "div-1",
  entrants: [],
  canEdit: true,
  positionGroups: [],
  roles: [],
  eligibility: NO_ELIGIBILITY,
  entrantModel: MODEL,
  viewerPlan: "community" as const,
  divisionStatus: "setup",
});

type Tree = ReturnType<ReturnType<typeof renderIsland>["tree"]>;
function findOnImport(tree: Tree) {
  const formEl = tree.find((e) => propsOf(e).importControls !== undefined);
  if (!formEl) throw new Error("AddEntrantForm element (importControls prop) not found in tree");
  return propsOf(propsOf(formEl).importControls as ReactElement).onImport as (rows: { name: string }[]) => Promise<unknown>;
}
const banner = (tree: Tree) => tree.find((e) => e.type === "p" && String(propsOf(e).className ?? "").includes("bg-red-50"));

/** Mount the panel, let the persons directory load, and make one import that the server answers with `failure`. */
async function importRefusedWith(failure: typeof api.nextPost) {
  api.personsLoaded = 0;
  const island = renderIsland(EntrantsPanel, panelProps());
  await vi.waitFor(() => expect(api.personsLoaded, "premise: the persons directory was read").toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 0)); // let setPersons re-render, so `fail` closes over the loaded names
  api.nextPost = failure;
  await findOnImport(island.tree())([{ name: "Ada Okonkwo" }]);
  return island;
}

const SERVER_ENGLISH = "Every player must link a Lichess account before entering online play";

describe("EntrantsPanel — a Lichess roster refusal names the reason and the people, localized", () => {
  it("LICHESS_RECONSENT_REQUIRED: says RECONNECT and names the people the payload names", async () => {
    const island = await importRefusedWith({
      message: "Every player must reconnect their Lichess account so Seazn can submit their moves before entering online play",
      status: 422,
      code: "LICHESS_RECONSENT_REQUIRED",
      extra: { person_ids: ["p-ada", "p-bo"] },
    });

    const shown = textOf(banner(island.tree())!);
    expect(shown).toBe(pluralRuntime(EN_UI, "entrants.lichess.reconnectRequired", 2, "en", { players: "Ada Okonkwo and Bo Lindqvist" }));
    expect(shown, "the reason is reconnect, not link").not.toBe(pluralRuntime(EN_UI, "entrants.lichess.linkRequired", 2, "en", { players: "Ada Okonkwo and Bo Lindqvist" }));
    expect(shown, "never the server's English").not.toContain("Every player must reconnect");
  });

  it("LICHESS_LINK_REQUIRED: says LINK, for one person in the singular, and a second refusal replaces the first", async () => {
    const island = await importRefusedWith({
      message: SERVER_ENGLISH,
      status: 422,
      code: "LICHESS_LINK_REQUIRED",
      extra: { person_ids: ["p-bo"] },
    });
    expect(textOf(banner(island.tree())!)).toBe(pluralRuntime(EN_UI, "entrants.lichess.linkRequired", 1, "en", { players: "Bo Lindqvist" }));

    // The SEQUENCE: the same panel, refused again for the OTHER reason, shows that reason and not the first.
    api.nextPost = { message: "x", status: 422, code: "LICHESS_RECONSENT_REQUIRED", extra: { person_ids: ["p-ada"] } };
    await findOnImport(island.tree())([{ name: "Ada Okonkwo" }]);
    expect(textOf(banner(island.tree())!)).toBe(pluralRuntime(EN_UI, "entrants.lichess.reconnectRequired", 1, "en", { players: "Ada Okonkwo" }));

    // And a refusal that goes away: the next import the server accepts clears the banner.
    await findOnImport(island.tree())([{ name: "Ada Okonkwo" }]);
    expect(banner(island.tree()), "an accepted import leaves no refusal behind").toBeUndefined();
  });

  it("a person the client cannot name (an inline new player) gets the nameless copy, which names nobody", async () => {
    const island = await importRefusedWith({
      message: SERVER_ENGLISH,
      status: 422,
      code: "LICHESS_LINK_REQUIRED",
      extra: { person_ids: ["p-ada", "p-created-in-the-refused-request"] },
    });
    const shown = textOf(banner(island.tree())!);
    expect(shown).toBe(tRuntime(EN_UI, "entrants.lichess.linkRequired.unnamed"));
    expect(shown).not.toContain("Ada Okonkwo");
  });

  it("the other direction: any other refusal still shows the server's message, unchanged", async () => {
    const island = await importRefusedWith({
      message: "Online play takes individual entrants only",
      status: 422,
      code: "ENTRANT_KIND_NOT_ALLOWED",
      extra: { person_ids: ["p-ada"] },
    });
    expect(textOf(banner(island.tree())!)).toBe("Online play takes individual entrants only");
  });
});

// The roster EDITOR's save and "sync from squad" are the other two doors the panel offers onto the same refusal: they reach the server
// through `runGated`, not `run`, and a wiring that mapped the code in one place only would leave them on the server's English. Each row
// handler is taken from the mounted panel's own tree, as a click would reach it.
type Row = { id: string; kind: string; team_id: string | null; display_name: string; seed: number | null; status: string; badge_url: string | null };
const row = (id: string, team_id: string | null): Row => ({ id, kind: "individual", team_id, display_name: "Seat " + id, seed: null, status: "confirmed", badge_url: null });

async function mountWithRows(entrants: Row[]) {
  api.personsLoaded = 0;
  api.writes.length = 0;
  api.nextWrite = null;
  const island = renderIsland(EntrantsPanel, { ...panelProps(), entrants });
  await vi.waitFor(() => expect(api.personsLoaded, "premise: the persons directory was read").toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 0));
  return island;
}
const rowElement = (tree: Tree, entrantId: string) => {
  const el = tree.find((e) => propsOf(e).entrant !== undefined && (propsOf(e).entrant as Row).id === entrantId);
  if (!el) throw new Error(`EntrantTableRow ${entrantId} not found in tree`);
  return propsOf(el);
};

describe("EntrantsPanel — the roster editor's save and the squad sync say a Lichess refusal in the organiser's language", () => {
  const MEMBERS = [{ person_id: "p-ada", is_captain: false, roles: [] as string[] }];

  it("a roster save (onPatch) refused as RECONNECT shows the localized reason naming the person; a second refusal replaces it; an accepted save clears it", async () => {
    const island = await mountWithRows([row("e-1", null)]);
    api.nextWrite = { message: SERVER_ENGLISH, status: 422, code: "LICHESS_RECONSENT_REQUIRED", extra: { person_ids: ["p-ada"] } };

    await (rowElement(island.tree(), "e-1").onPatch as (patch: unknown) => Promise<unknown>)({ members: MEMBERS });

    expect(api.writes, "premise: the save really went to the server").toEqual(["PATCH /api/v1/entrants/e-1"]);
    const shown = textOf(banner(island.tree())!);
    expect(shown).toBe(pluralRuntime(EN_UI, "entrants.lichess.reconnectRequired", 1, "en", { players: "Ada Okonkwo" }));
    expect(shown, "never the server's English").not.toContain("Every player must");

    // The SEQUENCE: refused again, for the other reason and another person: the banner shows that, not the first.
    api.nextWrite = { message: "x", status: 422, code: "LICHESS_LINK_REQUIRED", extra: { person_ids: ["p-bo"] } };
    await (rowElement(island.tree(), "e-1").onPatch as (patch: unknown) => Promise<unknown>)({ members: MEMBERS });
    expect(textOf(banner(island.tree())!)).toBe(pluralRuntime(EN_UI, "entrants.lichess.linkRequired", 1, "en", { players: "Bo Lindqvist" }));

    await (rowElement(island.tree(), "e-1").onPatch as (patch: unknown) => Promise<unknown>)({ members: MEMBERS });
    expect(banner(island.tree()), "an accepted save leaves no refusal behind").toBeUndefined();
    expect(api.writes).toHaveLength(3);
  });

  it("a squad sync (onSyncSquad) refused as LINK shows the localized reason naming the people; only an entry with a squad offers it", async () => {
    const island = await mountWithRows([row("e-solo", null), row("e-team", "t-1")]);
    expect(rowElement(island.tree(), "e-solo").onSyncSquad, "premise: an entry with no squad has nothing to sync from").toBeUndefined();
    api.nextWrite = { message: SERVER_ENGLISH, status: 422, code: "LICHESS_LINK_REQUIRED", extra: { person_ids: ["p-ada", "p-bo"] } };

    await (rowElement(island.tree(), "e-team").onSyncSquad as () => Promise<unknown>)();

    expect(api.writes, "premise: the sync really went to the server").toEqual(["POST /api/v1/entrants/e-team/roster/sync"]);
    const shown = textOf(banner(island.tree())!);
    expect(shown).toBe(pluralRuntime(EN_UI, "entrants.lichess.linkRequired", 2, "en", { players: "Ada Okonkwo and Bo Lindqvist" }));
    expect(shown, "never the server's English").not.toContain("Every player must");
  });
});
