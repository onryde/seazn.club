// W2b Task 11 (UI-1; spec §5.5, §7) — the organiser's forfeit dialog, driven through its REAL clicks. Replaces B07a
// Task 10's hook test for the old side menu + free-text reason prompt (R59(c)): the hooks moved with the controls,
// and `core.forfeit` is still authority-only on the scorer pad (`AUTHORITY_ONLY_EVENT_TYPES`, v3/pad-host.tsx), so the
// bench's and the matrix's tap drivers author it HERE — `score-forfeit`, then `forfeit-who-<side>`,
// `forfeit-why-<reason>`, `forfeit-confirm`.
//
// Same identity discipline as `scorepad/v3/__tests__/tap-hooks.test.tsx`: a hook is proven to sit on the RIGHT control,
// never merely to exist — the per-side test asserts WHICH entrant the send names, so a hook pair swapped between the
// two sides fails even though both still render. The dialog renders only after a click, which `renderToStaticMarkup`
// can never show, so this file uses `_hook-harness.tsx`'s `renderIsland` (one level: the console, then the dialog).
//
// Expected values are the rules': X-RS-1 / D3 for the chips (before play a walkover or Neither; after play retired or
// disqualified; never withdrew — PF-2), §7 for the refusal (the dialog closes, the reason shows on the console).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { foldMatch } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland, textOf, type Props } from "@/components/__tests__/_hook-harness";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { messages, type MessageKey } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string) => {
      if (url.includes("/events")) return Promise.resolve([] as EventIn[]);
      return Promise.resolve({ status: "in_play", last_seq: 1, summary: null, state: null, outcome: null });
    }),
  };
});

const en = (key: MessageKey) => tRuntime(messages, key);

const generic = builtinModules.find((m) => m.key === "generic")!;
const CFG = generic.configSchema.parse(Object.values(generic.variants)[0] ?? {});
const sport: SportInfo = { key: "generic", config: {}, scorerLabel: "Scorer", positionGroups: [], roles: [], lineupSize: 0, benchMax: 0 };

const HOME: SideInfo = { id: "home-1", name: "Riverside FC", members: [], lineup: [] };
const AWAY: SideInfo = { id: "away-1", name: "Summit Athletic", members: [], lineup: [] };
const STARTED = foldMatch(generic, CFG, defaultLineupPair(generic.positions), [makeEnvelope(1, { type: "core.start", payload: {} })]);

type Shape = "in_play" | "scheduled";
function baseProps(shape: Shape, noNextMatch = false) {
  const live = { status: shape, last_seq: shape === "in_play" ? 1 : 0, summary: null, state: shape === "in_play" ? STARTED : null, outcome: null };
  return {
    fixture: { id: "f1", status: shape, scheduled_at: null, venue_name: null, court_name: null, round_no: 1, no_next_match: noNextMatch },
    sport,
    home: HOME,
    away: AWAY,
    initialState: live,
    initialEvents: [] as EventIn[],
    canEdit: true,
    canOrganise: true,
    stageKind: null,
    viewerPlan: "community" as const,
    scorePadV2: {
      moduleVersion: generic.version,
      resolvedConfig: CFG,
      initialEvents: [],
      entitlements: {},
      stageKind: null,
      identity: { recordedBy: "user-1", deviceLinkId: null },
    },
  };
}

type Component = (props: Props) => ReactNode;
const byTestid = (tree: ReactElement[], testid: string) => tree.filter((e) => propsOf(e)["data-testid"] === testid);
const click = (el: ReactElement | undefined) => (propsOf(el!).onClick as () => void)();

/** The console, and the `<ForfeitDialog/>` element its `score-forfeit` opens (the only child handed `model` AND `forfeit`). */
function openConsole(shape: Shape, noNextMatch = false) {
  const island = renderIsland(FixtureConsole, baseProps(shape, noNextMatch));
  const dialogEl = () => island.tree().find((e) => typeof e.type === "function" && propsOf(e).model !== undefined && propsOf(e).forfeit !== undefined);
  const toggles = byTestid(island.tree(), "score-forfeit");
  expect(toggles, 'exactly one data-testid="score-forfeit"').toHaveLength(1);
  expect(toggles[0]!.type).toBe("button");
  expect(textOf(toggles[0]!)).toContain(en("score.forfeit"));
  expect(dialogEl(), "the dialog mounts only once Forfeit is clicked").toBeUndefined();
  click(toggles[0]);
  const el = dialogEl();
  if (el === undefined) throw new Error("score-forfeit did not open the forfeit dialog");
  return { island, el, dialogEl };
}

/** The dialog island, with its `forfeit` / `onClose` / `onRefused` doubled so a test reads what it sends. */
type Send = (p: unknown) => Promise<{ ok: true } | { ok: false; message: string }>;
function driveDialog(el: ReactElement, forfeit = vi.fn<Send>(async () => ({ ok: true }))) {
  const onClose = vi.fn();
  const onRefused = vi.fn();
  const dialog = renderIsland(el.type as Component, { ...propsOf(el), forfeit, onClose, onRefused });
  return { dialog, forfeit, onClose, onRefused, tree: () => dialog.tree() };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The dialog registers its keydown trap on `document` in an effect.
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {}, activeElement: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(apiV1).mockClear();
});

describe("UI-1: the organiser's forfeit dialog carries stable hooks and sends the closed vocabulary", () => {
  it.each([
    ["home", HOME, AWAY],
    ["away", AWAY, HOME],
  ] as const)("after play: forfeit-who-%s names ITS OWN side and forfeits ITS OWN entrant; why is retired/disqualified only", async (sideKey, own, other) => {
    const { el } = openConsole("in_play");
    const d = driveDialog(el);
    expect(byTestid(d.tree(), "forfeit-who-both"), "no Neither once play started").toHaveLength(0);
    const who = byTestid(d.tree(), `forfeit-who-${sideKey}`);
    expect(who, `exactly one data-testid="forfeit-who-${sideKey}"`).toHaveLength(1);
    expect(who[0]!.type).toBe("button");
    expect(textOf(who[0]!)).toContain(own.name);
    expect(textOf(who[0]!)).not.toContain(other.name);
    expect(byTestid(d.tree(), "forfeit-why-retired"), "the reasons appear once a side is chosen").toHaveLength(0);

    const confirm = () => byTestid(d.tree(), "forfeit-confirm")[0]!;
    expect(propsOf(confirm()).disabled, "Confirm is blocked with nothing chosen").toBe(true);
    click(who[0]);
    expect(propsOf(byTestid(d.tree(), `forfeit-who-${sideKey}`)[0]!)["aria-pressed"]).toBe(true);
    expect(propsOf(confirm()).disabled, "Confirm is blocked with only the side chosen").toBe(true);
    const offered = ["walkover", "retired", "disqualified", "withdrew"].filter((r) => byTestid(d.tree(), `forfeit-why-${r}`).length > 0);
    expect(offered, "after play: retired or disqualified (X-RS-1); withdrew is the cascade's (PF-2)").toEqual(["retired", "disqualified"]);
    const retired = byTestid(d.tree(), "forfeit-why-retired")[0]!;
    expect(retired.type).toBe("input");
    expect(propsOf(retired).type).toBe("radio");
    (propsOf(retired).onChange as () => void)();

    expect(propsOf(confirm()).disabled).toBe(false);
    expect(textOf(confirm()), "one specific Confirm").toBe(en("forfeitDialog.confirm.retired"));
    expect(textOf(byTestid(d.tree(), "forfeit-preview")[0]!), "generic credits no score (GN-WO-1)").toBe(en("forfeitDialog.preview.none"));
    click(confirm());
    await vi.waitFor(() => expect(d.onClose).toHaveBeenCalledTimes(1));
    expect(d.forfeit).toHaveBeenCalledTimes(1);
    expect(d.forfeit).toHaveBeenCalledWith({ by: own.id, reason: "retired" });
    expect(d.onRefused).not.toHaveBeenCalled();
  });

  it("before play: Neither walks over — a double walkover, its own Confirm, `by: \"both\"`", async () => {
    const { el } = openConsole("scheduled");
    const d = driveDialog(el);
    for (const w of ["home", "away", "both"]) expect(byTestid(d.tree(), `forfeit-who-${w}`), w).toHaveLength(1);
    expect(textOf(byTestid(d.tree(), "forfeit-who-both")[0]!)).toBe(en("forfeitDialog.who.both"));
    expect(byTestid(d.tree(), "forfeit-guidance-no-next-match")).toHaveLength(0);
    click(byTestid(d.tree(), "forfeit-who-both")[0]);
    const offered = ["walkover", "retired", "disqualified", "withdrew"].filter((r) => byTestid(d.tree(), `forfeit-why-${r}`).length > 0);
    expect(offered).toEqual(["walkover"]);
    (propsOf(byTestid(d.tree(), "forfeit-why-walkover")[0]!).onChange as () => void)();
    const confirm = byTestid(d.tree(), "forfeit-confirm")[0]!;
    expect(textOf(confirm)).toBe(en("forfeitDialog.confirm.doubleWalkover"));
    click(confirm);
    await vi.waitFor(() => expect(d.onClose).toHaveBeenCalledTimes(1));
    expect(d.forfeit).toHaveBeenCalledWith({ by: "both", reason: "walkover" });
  });

  it("X-DW-3: on a fixture with no next match the guidance replaces Neither (the page's server-side reading)", () => {
    const { el } = openConsole("scheduled", true);
    const d = driveDialog(el);
    expect(byTestid(d.tree(), "forfeit-who-both")).toHaveLength(0);
    const g = byTestid(d.tree(), "forfeit-guidance-no-next-match");
    expect(g).toHaveLength(1);
    expect(textOf(g[0]!)).toBe(en("forfeitDialog.guidance.noNextMatch"));
    expect(byTestid(d.tree(), "forfeit-who-home"), "a side's walkover is still offered").toHaveLength(1);
  });

  it("Review Focus 4: a double tap on Confirm sends ONE forfeit (the synchronous guard), and Confirm is blocked while sending", async () => {
    const { el } = openConsole("in_play");
    let answer!: (v: { ok: true }) => void;
    const forfeit = vi.fn<Send>(() => new Promise<{ ok: true }>((r) => (answer = r)));
    const d = driveDialog(el, forfeit);
    click(byTestid(d.tree(), "forfeit-who-away")[0]);
    (propsOf(byTestid(d.tree(), "forfeit-why-disqualified")[0]!).onChange as () => void)();
    const confirm = byTestid(d.tree(), "forfeit-confirm")[0]!;
    click(confirm);
    click(confirm);
    expect(forfeit).toHaveBeenCalledTimes(1);
    expect(propsOf(byTestid(d.tree(), "forfeit-confirm")[0]!).disabled, "blocked while the first send is in flight").toBe(true);
    answer({ ok: true });
    await vi.waitFor(() => expect(d.onClose).toHaveBeenCalledTimes(1));
    expect(forfeit).toHaveBeenCalledWith({ by: AWAY.id, reason: "disqualified" });
  });

  it("the console's own send: Confirm POSTs `core.forfeit {by, reason}` through the console's one write", async () => {
    const { el } = openConsole("in_play");
    const r = await (propsOf(el).forfeit as (p: unknown) => Promise<unknown>)({ by: AWAY.id, reason: "retired" });
    expect(r).toEqual({ ok: true });
    const posts = vi.mocked(apiV1).mock.calls.filter(([url, init]) => url.endsWith("/events") && (init as { method?: string } | undefined)?.method === "POST");
    expect(posts, "exactly one event POST").toHaveLength(1);
    const json = (posts[0]![1] as { json: { type: string; payload: unknown } }).json;
    expect(json.type).toBe("core.forfeit");
    expect(json.payload).toEqual({ by: AWAY.id, reason: "retired" });
  });

  it("§7: a refused forfeit closes the dialog and the console shows the reason (`forfeit-refusal`), localized by code", async () => {
    vi.mocked(apiV1).mockImplementationOnce(() => Promise.reject(new ApiV1Error("Match already decided", 409, "ALREADY_DECIDED")));
    const { island, el, dialogEl } = openConsole("in_play");
    expect(byTestid(island.tree(), "forfeit-refusal"), "no refusal before a send").toHaveLength(0);
    const r = (await (propsOf(el).forfeit as (p: unknown) => Promise<{ ok: boolean; message?: string }>)({ by: AWAY.id, reason: "retired" }));
    expect(r).toEqual({ ok: false, message: en("engineError.ALREADY_DECIDED") });
    (propsOf(dialogEl()!).onRefused as (m: string) => void)(r.message!);
    expect(dialogEl(), "the refusal closed the dialog").toBeUndefined();
    const line = byTestid(island.tree(), "forfeit-refusal");
    expect(line).toHaveLength(1);
    expect(textOf(line[0]!)).toBe(en("engineError.ALREADY_DECIDED"));
    // Reopening the dialog clears the old refusal.
    click(byTestid(island.tree(), "score-forfeit")[0]);
    expect(byTestid(island.tree(), "forfeit-refusal")).toHaveLength(0);
    expect(dialogEl()).toBeDefined();
  });

  it("the dialog reports a refusal instead of closing: onRefused, never onClose", async () => {
    const { el } = openConsole("in_play");
    const d = driveDialog(el, vi.fn<Send>(async () => ({ ok: false, message: "nope" })));
    click(byTestid(d.tree(), "forfeit-who-home")[0]);
    (propsOf(byTestid(d.tree(), "forfeit-why-retired")[0]!).onChange as () => void)();
    click(byTestid(d.tree(), "forfeit-confirm")[0]);
    await vi.waitFor(() => expect(d.onRefused).toHaveBeenCalledWith("nope"));
    expect(d.onClose).not.toHaveBeenCalled();
  });
});
