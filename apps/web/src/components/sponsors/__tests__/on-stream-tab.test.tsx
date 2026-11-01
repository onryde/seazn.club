// R4 sponsors on stream, S12 - the On stream tab (components/sponsors/on-stream-tab.tsx), driven the way a person drives it.
//
// vitest is `environment: "node"` (no DOM), so the island runs under components/__tests__/_hook-harness.tsx: React's own hook
// dispatcher, the element TREE back, and a click is the element's own `onClick` prop called. `fetch` is stubbed and its body is
// READ - "did the dial send what it shows?" is a string check on the request, not on a fixture. What this cannot see (CSS, tap
// area, the widths) is the e2e's (`e2e/sponsors-hub.spec.ts`, run by CI) and the walkthrough's.
//
// Expected values come from the engine's own declarations (`naturalBreaks.kinds`) and the planner's exported constants
// (`SPONSOR_STYLE_BY_SIZE`), never a table typed here. Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   K1  D12 default       DEFAULT_FREQUENCY "normal" -> "light"                    -> "opens at the stored frequency / Normal with no row"
//   K2  PUT scope         `competitionId: scope` -> `competitionId: null`           -> "a competition scope writes ITS row"
//   K3  where text        swap minor/major seconds in `whereBody` vars               -> "Where it shows is derived from the planner's constants"
//   K4  ticked+active     drop `s.status === "active"` from previewCards             -> "a parked sponsor is not a card"
//   K5  override reset    drop the render-phase reset                                -> "the server's props win over a click's result"
//   K6  failed write      drop the `undo()` in write()'s catch                       -> "a refused write puts the old value back and says so"
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

import { OnStreamTab, BREAK_MSG, DEFAULT_FREQUENCY, FREQ_MSG, previewCards, sponsorsInScope, type OnStreamSponsor, type OnStreamTabProps } from "../on-stream-tab";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { SPONSOR_FREQUENCIES, SPONSOR_STYLE_BY_SIZE, type BreakOpened, type SponsorFrequency } from "@/lib/sponsor-plan";
import { onStreamHref } from "@/lib/sponsors-hub";
import { t } from "@/lib/i18n-runtime";
import type { SportPreviewSource } from "@/lib/sponsor-preview";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const en = uiEn as unknown as Dict;
const msg = (key: MessageKey, vars?: Record<string, string | number>) => t(en, key, vars);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const ORG = "org-1";
const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const MIN = 60_000;

const sponsor = (over: Partial<OnStreamSponsor> & { id: string }): OnStreamSponsor => ({
  name: `Sponsor ${over.id}`,
  tier: "partner",
  status: "active",
  competition_id: null,
  on_stream: false,
  ...over,
});
const SPONSORS: OnStreamSponsor[] = [
  sponsor({ id: "s1", name: "Harbour Bank", tier: "title", on_stream: true }),
  sponsor({ id: "s2", name: "Ridge Cycles", tier: "gold" }),
  sponsor({ id: "s3", name: "Dormant Ltd", tier: "silver", status: "inactive" }),
  sponsor({ id: "s4", name: "Cup Printers", tier: "partner", competition_id: "c1" }),
];
const COMPETITIONS = [{ id: "c1", name: "Spring Cup" }, { id: "c2", name: "Autumn Cup" }];

/** Four of each declared kind, five minutes apart (outside the 90 s cooldown), sized by the SPORT'S declaration. */
function breaksOf(sportKey: string): BreakOpened[] {
  const kinds = builtinModules.find((m) => m.key === sportKey)!.naturalBreaks!.kinds;
  const out: BreakOpened[] = [];
  let seq = 0;
  for (let round = 0; round < 4; round++) {
    for (const k of kinds) {
      seq += 1;
      out.push({ seq, at: new Date(T0 + seq * 5 * MIN).toISOString(), kind: k.kind, size: k.size });
    }
  }
  return out;
}
const kindsOf = (sportKey: string) => builtinModules.find((m) => m.key === sportKey)!.naturalBreaks?.kinds.map((k) => ({ kind: k.kind, size: k.size })) ?? null;
const sportWith = (sportKey: string): SportPreviewSource => ({ sportKey, kinds: kindsOf(sportKey), sample: kindsOf(sportKey) === null ? null : breaksOf(sportKey) });
const sportWithout = (sportKey: string): SportPreviewSource => ({ sportKey, kinds: kindsOf(sportKey), sample: null });

const base = (over: Partial<OnStreamTabProps> = {}): OnStreamTabProps => ({
  orgId: ORG,
  orgSlug: "riverside",
  sponsors: SPONSORS,
  competitions: COMPETITIONS,
  scope: null,
  hasTiers: true,
  settings: { enabled: true, frequency: "normal" },
  ownRow: true,
  sports: [sportWith("cricket")],
  ...over,
});

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
  vi.stubGlobal("fetch", fetchMock);
});

function mount(over: Partial<OnStreamTabProps> = {}) {
  const island = renderIsland(OnStreamTab, base(over));
  const find = (id: string): ReactElement => {
    const el = island.tree().find((e) => propsOf(e)["data-testid"] === id);
    if (!el) throw new Error(`no element with data-testid="${id}"`);
    return el;
  };
  const has = (id: string) => island.tree().some((e) => propsOf(e)["data-testid"] === id);
  const checked = (id: string) => propsOf(find(id))["aria-checked"] === true;
  const text = (id: string) => flat(textOf(find(id)));
  const click = (id: string) => (propsOf(find(id)).onClick as () => void)();
  const tick = (sponsorId: string, value: boolean) =>
    (propsOf(find(`on-stream-tick-${sponsorId}`)).onChange as (e: unknown) => void)({ target: { checked: value } });
  return { island, find, has, checked, text, click, tick };
}
const dialValue = (m: ReturnType<typeof mount>): SponsorFrequency[] => SPONSOR_FREQUENCIES.filter((f) => m.checked(`on-stream-dial-${f}`));
const lastRequest = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, { method: string; body: string }];
  return { url, method: init.method, body: JSON.parse(init.body) as Record<string, unknown> };
};

describe("the rotation - the dial opens AT the stored value (D12)", () => {
  it("opens at the stored frequency for each of Light / Normal / Busy, and at Normal with no row (counted)", () => {
    let checked = 0;
    for (const f of SPONSOR_FREQUENCIES) {
      expect(dialValue(mount({ settings: { enabled: true, frequency: f } })), `stored ${f}`).toEqual([f]);
      checked++;
    }
    expect(dialValue(mount({ settings: null, ownRow: false })), "no row -> D12's Normal").toEqual(["normal"]);
    expect(DEFAULT_FREQUENCY).toBe("normal");
    checked++;
    expect(checked).toBe(SPONSOR_FREQUENCIES.length + 1);
  });

  it("the hint under the dial is the selected position's own sentence (not the default's)", () => {
    const m = mount({ settings: { enabled: true, frequency: "busy" } });
    expect(m.text("on-stream-dial-hint")).toBe(msg("sponsors.onStream.freqHint.busy"));
    expect(msg("sponsors.onStream.freqHint.busy")).not.toBe(msg("sponsors.onStream.freqHint.normal"));
  });

  it("the switch reflects the rotation: on when enabled, off with no row or a disabled one - and says why", () => {
    expect(mount({ settings: { enabled: true, frequency: "normal" } }).checked("on-stream-switch")).toBe(true);
    const none = mount({ settings: null, ownRow: false });
    expect(none.checked("on-stream-switch")).toBe(false);
    expect(none.text("on-stream-off-note")).toBe(msg("sponsors.onStream.offNoRow"));
    const paused = mount({ settings: { enabled: false, frequency: "light" } });
    expect(paused.checked("on-stream-switch")).toBe(false);
    expect(paused.text("on-stream-off-note")).toBe(msg("sponsors.onStream.offPaused"));
    expect(mount().has("on-stream-off-note"), "on: no off-note").toBe(false);
  });

  it("Where it shows is derived from the planner's constants: small breaks -> lower third, big breaks -> banner", () => {
    const where = mount().text("on-stream-where");
    const minor = SPONSOR_STYLE_BY_SIZE.minor;
    const major = SPONSOR_STYLE_BY_SIZE.major;
    expect(minor.style, "premise: minor is the lower third").toBe("lower_third");
    expect(major.style, "premise: major is the banner").toBe("banner");
    expect(where).toBe(msg("sponsors.onStream.whereBody", { minor: minor.holdMs / 1000, major: major.holdMs / 1000 }));
    expect(where).toMatch(/Small breaks show a lower third for \d+ seconds\. Big breaks show a banner for \d+ seconds\./);
    expect(minor.holdMs / 1000, "the two numbers differ, so a swap would show").not.toBe(major.holdMs / 1000);
  });
});

describe("the rotation - what a click sends", () => {
  it("a dial move PUTs the scope's whole setting: org scope -> competitionId null, the new frequency, enabled kept", async () => {
    const m = mount({ settings: { enabled: false, frequency: "light" } });
    m.click("on-stream-dial-busy");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toEqual({ url: `/api/v1/orgs/${ORG}/sponsor-stream-settings`, method: "PUT", body: { competitionId: null, enabled: false, frequency: "busy" } });
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
  });

  it("the first dial move with NO row creates one enabled (the dial is the owner turning the rotation on)", async () => {
    const m = mount({ settings: null, ownRow: false });
    m.click("on-stream-dial-light");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastRequest().body).toEqual({ competitionId: null, enabled: true, frequency: "light" });
  });

  it("the switch PUTs enabled flipped and the frequency on screen - on -> off, then (after a refresh) off -> on", async () => {
    const m = mount({ settings: { enabled: true, frequency: "busy" } });
    m.click("on-stream-switch");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastRequest().body).toEqual({ competitionId: null, enabled: false, frequency: "busy" });
    const off = mount({ settings: { enabled: false, frequency: "busy" } });
    off.click("on-stream-switch");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastRequest().body).toEqual({ competitionId: null, enabled: true, frequency: "busy" });
  });

  it("a competition scope writes ITS row: the competition id rides the PUT, and an inherited setting is what it starts from", async () => {
    const m = mount({ scope: "c1", ownRow: false, settings: { enabled: true, frequency: "light" } });
    expect(m.has("on-stream-inherited"), "no row of its own: says it follows the org").toBe(true);
    m.click("on-stream-dial-busy");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastRequest().body).toEqual({ competitionId: "c1", enabled: true, frequency: "busy" });
  });

  it("the inherited note shows ONLY for a competition scope without a row (org scope; a competition with its own row: no note)", () => {
    expect(mount({ scope: null, ownRow: false, settings: null }).has("on-stream-inherited")).toBe(false);
    expect(mount({ scope: "c1", ownRow: true }).has("on-stream-inherited")).toBe(false);
    expect(mount({ scope: "c1", ownRow: false }).has("on-stream-inherited")).toBe(true);
  });

  it("a dial move shows at once (the click's result), and the controls are locked while the write is in flight", async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const m = mount({ settings: { enabled: true, frequency: "normal" } });
    m.click("on-stream-dial-busy");
    expect(dialValue(m)).toEqual(["busy"]);
    expect(propsOf(m.find("on-stream-dial-light")).disabled, "no second write while one is out").toBe(true);
    expect(propsOf(m.find("on-stream-switch")).disabled).toBe(true);
    resolve({ ok: true, json: async () => ({}) });
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(propsOf(m.find("on-stream-dial-light")).disabled).toBe(false);
  });

  it("a refused write puts the old value back and says so (the server's words), and does not refresh", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: "competition not found" } }) });
    const m = mount({ settings: { enabled: true, frequency: "normal" } });
    m.click("on-stream-dial-busy");
    await vi.waitFor(() => expect(m.has("on-stream-error")).toBe(true));
    expect(m.text("on-stream-error")).toBe("competition not found");
    expect(dialValue(m), "back to the stored one").toEqual(["normal"]);
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("the server's props win over a click's result: a refresh that sends other values drops the override (the sequence)", async () => {
    const m = mount({ settings: { enabled: true, frequency: "normal" } });
    m.click("on-stream-dial-busy");
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(dialValue(m)).toEqual(["busy"]);
    m.island.rerender(base({ settings: { enabled: true, frequency: "light" } }));
    expect(dialValue(m), "the server said light").toEqual(["light"]);
    m.island.rerender(base({ settings: { enabled: true, frequency: "busy" } }));
    expect(dialValue(m)).toEqual(["busy"]);
  });
});

describe("the tick list", () => {
  it("lists the org's sponsors with their ticks, and shows each one's tier when the plan has tiers", () => {
    const m = mount();
    for (const s of SPONSORS) expect(m.has(`on-stream-sponsor-${s.id}`), s.id).toBe(true);
    expect(propsOf(m.find("on-stream-tick-s1")).checked).toBe(true);
    expect(propsOf(m.find("on-stream-tick-s2")).checked).toBe(false);
    expect(m.text("on-stream-tier-s1")).toBe("Title");
    expect(m.text("on-stream-tier-s2")).toBe("Gold");
    expect(m.text("on-stream-sponsor-s3")).toContain(msg("sponsors.onStream.notActive"));
  });

  it("without the tiers feature no tier badge is shown (every sponsor is a partner, as the public board draws them)", () => {
    const m = mount({ hasTiers: false });
    expect(SPONSORS.filter((s) => m.has(`on-stream-tier-${s.id}`))).toHaveLength(0);
  });

  it("a tick PATCHes on_stream (snake_case) to that sponsor and shows at once; an untick sends false", async () => {
    const m = mount();
    m.tick("s2", true);
    expect(propsOf(m.find("on-stream-tick-s2")).checked, "shown before the server answers").toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastRequest()).toEqual({ url: `/api/v1/orgs/${ORG}/sponsors/s2`, method: "PATCH", body: { on_stream: true } });
    await vi.waitFor(() => expect(nav.refresh).toHaveBeenCalledTimes(1));
    m.tick("s1", false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastRequest()).toEqual({ url: `/api/v1/orgs/${ORG}/sponsors/s1`, method: "PATCH", body: { on_stream: false } });
  });

  it("a refused tick is put back and reported", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Insufficient permissions" }) });
    const m = mount();
    m.tick("s2", true);
    await vi.waitFor(() => expect(m.has("on-stream-error")).toBe(true));
    expect(m.text("on-stream-error")).toBe("Insufficient permissions");
    expect(propsOf(m.find("on-stream-tick-s2")).checked).toBe(false);
  });

  it("a sponsor that is not active cannot be newly ticked, but a ticked one can still be unticked", () => {
    const m = mount({ sponsors: [sponsor({ id: "p1", status: "pending" }), sponsor({ id: "p2", status: "inactive", on_stream: true })] });
    expect(propsOf(m.find("on-stream-tick-p1")).disabled, "pending, unticked").toBe(true);
    expect(propsOf(m.find("on-stream-tick-p2")).disabled, "inactive, ticked: can be unticked").toBe(false);
  });

  it("a competition scope lists the organisation-wide sponsors and that competition's own - not another's (counted)", () => {
    const sponsors = [...SPONSORS, sponsor({ id: "s5", competition_id: "c2" })];
    expect(sponsorsInScope(sponsors, null).map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(sponsorsInScope(sponsors, "c1").map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(sponsorsInScope(sponsors, "c2").map((s) => s.id)).toEqual(["s1", "s2", "s3", "s5"]);
    const m = mount({ sponsors, scope: "c1" });
    expect(sponsors.filter((s) => m.has(`on-stream-sponsor-${s.id}`)).map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("no sponsors: says so and points at the Sponsors tab - and there is no 'Add a deal' here", () => {
    const m = mount({ sponsors: [] });
    expect(m.has("on-stream-checklist-empty")).toBe(true);
    expect(m.text("on-stream-checklist-empty")).toContain(msg("sponsors.onStream.checklistEmpty"));
    expect(flat(textOf(m.island.tree()[0]!))).not.toMatch(/add a deal/i);
  });
});

describe("the scope picker", () => {
  it("offers the organisation then each competition, opens on the scope in the URL, and navigates to the tab's own URL for a pick", () => {
    const m = mount({ scope: "c2" });
    const select = m.find("on-stream-scope");
    expect(propsOf(select).value).toBe("c2");
    (propsOf(select).onChange as (e: unknown) => void)({ target: { value: "c1" } });
    expect(nav.push).toHaveBeenLastCalledWith(onStreamHref("riverside", "c1"));
    (propsOf(select).onChange as (e: unknown) => void)({ target: { value: "" } });
    expect(nav.push).toHaveBeenLastCalledWith(onStreamHref("riverside", null));
    expect(onStreamHref("riverside", null), "the org scope is the bare tab URL").toBe("/o/riverside/sponsors?tab=on_stream");
    expect(onStreamHref("riverside", "c1")).toBe("/o/riverside/sponsors?tab=on_stream&scope=c1");
  });

  it("an org with no competitions has no picker", () => {
    expect(mount({ competitions: [] }).has("on-stream-scope")).toBe(false);
  });
});

describe("the preview - the planner's count over a real match's breaks (R11)", () => {
  const cricket = kindsOf("cricket")!;
  const majors = (breaks: readonly { size: string }[]) => breaks.filter((b) => b.size === "major").length;
  const minors = (breaks: readonly { size: string }[]) => breaks.length - majors(breaks);

  it("cricket on Light / Normal / Busy: the card count follows the dial (majors; + every 3rd minor; all) - derived from cricket's own declaration", async () => {
    const sample = breaksOf("cricket");
    const want: Record<SponsorFrequency, number> = {
      light: majors(sample),
      normal: majors(sample) + Math.floor(minors(sample) / 3),
      busy: sample.length,
    };
    expect(majors(sample), "premise: cricket has a major").toBeGreaterThan(0);
    expect(minors(sample), "premise: cricket has minors").toBeGreaterThan(0);
    expect(new Set(Object.values(want)).size, "the three positions differ, so a stuck dial would show").toBe(3);
    const m = mount({ settings: { enabled: true, frequency: "light" } });
    let cells = 0;
    for (const f of SPONSOR_FREQUENCIES) {
      m.click(`on-stream-dial-${f}`);
      await vi.waitFor(() => expect(dialValue(m)).toEqual([f]));
      expect(m.text("on-stream-preview-count-cricket"), f).toBe(msg("sponsors.onStream.previewCards.other", { count: want[f] }));
      cells++;
    }
    expect(cells).toBe(3);
    void cricket;
  });

  it("the strip draws every break of the match - tall for big, short for small - and fills the ones that drew a card", () => {
    const sample = breaksOf("cricket");
    const m = mount({ settings: { enabled: true, frequency: "light" } });
    const strip = m.find("on-stream-strip-cricket");
    const marks = (propsOf(strip).children as ReactElement[]).map((c) => propsOf(c));
    expect(marks).toHaveLength(sample.length);
    expect(marks.filter((p) => p["data-size"] === "major")).toHaveLength(majors(sample));
    // Light: the majors air, the minors do not.
    expect(marks.filter((p) => p["data-aired"] === "true")).toHaveLength(majors(sample));
    expect(marks.filter((p) => p["data-aired"] === "true").every((p) => p["data-size"] === "major")).toBe(true);
    expect(String(propsOf(strip)["aria-label"])).toBe(msg("sponsors.onStream.previewStripLabel", { sport: "Cricket", breaks: sample.length, cards: majors(sample) }));
  });

  it("one card reads singular ('≈1 card'), zero reads plural", () => {
    const one: BreakOpened[] = [{ seq: 1, at: new Date(T0).toISOString(), kind: "innings_break", size: "major" }];
    const m = mount({ sports: [{ sportKey: "cricket", kinds: cricket, sample: one }], settings: { enabled: true, frequency: "light" } });
    expect(m.text("on-stream-preview-count-cricket")).toBe("≈1 card over that match");
    const none = mount({ sponsors: [], sports: [{ sportKey: "cricket", kinds: cricket, sample: one }] });
    expect(none.text("on-stream-preview-count-cricket")).toBe("≈0 cards over that match");
    expect(none.has("on-stream-preview-noticks"), "no ticked sponsor: says no card would air").toBe(true);
  });

  it("a parked sponsor is not a card: ticked but inactive/pending draws no card (the rotation never airs it)", () => {
    const rows = [sponsor({ id: "a", on_stream: true }), sponsor({ id: "b", on_stream: true, status: "pending" }), sponsor({ id: "c", on_stream: true, status: "inactive" }), sponsor({ id: "d" })];
    expect(previewCards(rows, true).map((c) => c.id)).toEqual(["a"]);
    const onlyParked = mount({ sponsors: [rows[1]!, rows[2]!] });
    expect(onlyParked.text("on-stream-preview-count-cricket")).toBe("≈0 cards over that match");
  });

  it("tiers: without the feature every card is a partner; with it, the sponsor's own tier", () => {
    const rows = [sponsor({ id: "a", on_stream: true, tier: "title" })];
    expect(previewCards(rows, false).map((c) => c.tier)).toEqual(["partner"]);
    expect(previewCards(rows, true).map((c) => c.tier)).toEqual(["title"]);
  });

  it("the preview says the rotation is off when it is - and still shows the count it would give", () => {
    const m = mount({ settings: null, ownRow: false });
    expect(m.text("on-stream-preview-off")).toBe(msg("sponsors.onStream.previewOff"));
    expect(m.has("on-stream-preview-count-cricket")).toBe(true);
    expect(mount().has("on-stream-preview-off")).toBe(false);
  });

  it("no finished match of a sport that has breaks: its break kinds by size, from the engine's declaration, and NO numbers", () => {
    const m = mount({ sports: [sportWithout("football")] });
    const line = m.text("on-stream-preview-kinds-football");
    const declared = kindsOf("football")!;
    expect(declared.length).toBeGreaterThan(1);
    for (const k of declared) expect(line, k.kind).toContain(msg(BREAK_MSG[k.kind]!));
    expect(line).toContain(msg("sponsors.onStream.previewNoMatch", { sport: "Football" }));
    expect(line).toContain("Big breaks:");
    expect(line).toContain("Small breaks:");
    expect(line, "no numbers: nothing was counted").not.toMatch(/\d/);
    expect(m.has("on-stream-preview-count-football")).toBe(false);
    expect(m.has("on-stream-strip-football")).toBe(false);
  });

  it("a sport that declares no breaks (generic) says sponsors appear on scene screens - no strip, no count", () => {
    const m = mount({ sports: [sportWith("generic")] });
    expect(m.text("on-stream-preview-scene-generic")).toBe("Sponsors appear on scene screens.");
    expect(m.has("on-stream-strip-generic")).toBe(false);
    expect(m.has("on-stream-preview-count-generic")).toBe(false);
  });

  it("one strip per sport the org plays, in the order given (cricket, football, generic, badminton - counted)", () => {
    const sports = ["cricket", "football", "generic", "badminton"].map(sportWith);
    const m = mount({ sports });
    const shown = sports.filter((s) => m.has(`on-stream-preview-${s.sportKey}`));
    expect(shown.map((s) => s.sportKey)).toEqual(["cricket", "football", "generic", "badminton"]);
    expect(sports.filter((s) => m.has(`on-stream-strip-${s.sportKey}`)).map((s) => s.sportKey), "strips: every sport with breaks").toEqual(["cricket", "football", "badminton"]);
  });

  it("no divisions: says there is nothing to preview", () => {
    const m = mount({ sports: [] });
    expect(m.has("on-stream-preview-nosports")).toBe(true);
  });
});

describe("the copy - every break kind the engine declares has a label, in every language (counted)", () => {
  const LOCALE_DICTS = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as unknown as Record<string, Record<string, string>>;

  it("each declared kind of each sport maps to a key that exists, non-empty, in en/es/fr/nl", () => {
    const kinds = new Set(builtinModules.flatMap((m) => (m.naturalBreaks?.kinds ?? []).map((k) => k.kind)));
    expect(kinds.size, "the engine declares a dozen kinds").toBeGreaterThanOrEqual(12);
    let checked = 0;
    for (const kind of kinds) {
      const key = BREAK_MSG[kind];
      expect(key, `a label for "${kind}"`).toBeDefined();
      for (const [locale, dict] of Object.entries(LOCALE_DICTS)) {
        expect(typeof dict[key!] === "string" && dict[key!]!.length > 0, `${locale}: ${key}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(kinds.size * 4);
  });

  it("no stale labels: every BREAK_MSG entry is a kind some sport declares", () => {
    const kinds = new Set(builtinModules.flatMap((m) => (m.naturalBreaks?.kinds ?? []).map((k) => k.kind)));
    expect(Object.keys(BREAK_MSG).sort()).toEqual([...kinds].sort());
  });

  it("every sponsors.onStream.* key exists in all four languages with the same {placeholders} (counted)", () => {
    const keys = Object.keys(uiEn).filter((k) => k.startsWith("sponsors.onStream."));
    expect(keys.length).toBeGreaterThan(40);
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    let checked = 0;
    for (const key of keys) {
      const english = (uiEn as Record<string, string>)[key]!;
      for (const [locale, dict] of Object.entries(LOCALE_DICTS)) {
        expect(typeof dict[key], `${locale}: ${key}`).toBe("string");
        expect(holes(dict[key]!), `${locale}: ${key} placeholders`).toBe(holes(english));
        checked++;
      }
    }
    expect(checked).toBe(keys.length * 4);
    for (const f of SPONSOR_FREQUENCIES) expect(FREQ_MSG[f]).toBe(`sponsors.onStream.freq.${f}`);
  });
});
