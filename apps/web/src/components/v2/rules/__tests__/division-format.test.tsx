// FMT5 (owner-approved 2026-11-03): the Format button on the Fixtures tab's Division rules card, and the dialog it opens.
//
// The dialog is the C9 builder's picker (`formatPickerFields`, shared, not forked) over the division's own stored format,
// and its Save is three PUTs on one route: a dry run (`?dry_run=1`) that answers what the change would clear; then either a
// plain PUT (nothing generated: nothing to confirm) or, after the organiser confirms the list, `?clear=<token>`. The server
// side of each is server/usecases/__tests__/format-change.test.ts (real database) and the route's is
// app/api/v1/divisions/[id]/stages/__tests__/route.test.ts; this file drives the CLIENT through the hook harness and reads
// what it sends and says.
//
// Expected copy comes from the en dictionary (filled by hand here, never through the component's own formatter), expected
// counts from the preview the test hands the dialog, and expected stages from the templates' own builder.
// Ported here from Settings › Format (removed by FMT5): a stored triple round robin is kept on a save, never clamped
// (triple-rr-retired.test.tsx); a stored Swiss opens at its rounds and an unpicked one at the field's recommendation
// (division-settings-derived-rounds.test.tsx). The bounds sweep and the stored-legs case moved with the rest of the
// bounds, into lib/__tests__/format-bounds.test.ts.
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expandWithHooks, propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { Modal } from "@/components/modal";
import { UpgradeGate } from "@/components/upgrade-gate";
import { WithReasonTip } from "@/components/v2/desk/reason-tip";
import { LegsChoice } from "@/components/v2/legs-choice";
import { pickTemplate, pickedTemplate } from "@/components/v2/__tests__/_division-builder-driver";
import { DivisionFormatButton, DivisionFormatDialog, formatChipText, type DivisionFormatProps, type DivisionFormatStage } from "@/components/v2/rules/division-format";
import { DivisionRulesStrip } from "@/components/v2/rules/division-rules-strip";
import { ApiV1Error } from "@/lib/client-v1";
import { OPENING_PLAN } from "@/lib/division-builder/model";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { FORMAT_CHANGE_REFUSALS, type FormatChangePreview } from "@/lib/format-change";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { rulesLineDict } from "@/lib/rules-line";
import type { Dict } from "@/lib/i18n-constants";
import enUi from "@/dictionaries/en/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";

const { apiV1Mock, refresh } = vi.hoisted(() => ({ apiV1Mock: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/div",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

const en = enUi as Record<string, string>;
/** The en sentence for a key, its placeholders filled by hand. */
function say(key: string, vars: Record<string, string | number> = {}): string {
  const raw = en[key];
  if (raw === undefined) throw new Error(`no en copy for ${key}`);
  return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), raw);
}
const sayN = (key: string, n: number, vars: Record<string, string | number> = {}) => say(`${key}.${n === 1 ? "one" : "other"}`, { count: n, ...vars });

const SPORT = "badminton";
const KINDS = engineEntrantKinds(SPORT);
const OFFER = templatesForSport(SPORT, KINDS).map((t) => t.key);
const URL_BASE = "/api/v1/divisions/d1/stages";

const stagesOf = (template: string, knobs: Partial<{ qualified: number; swissRounds: number; poolCount: number; legs: number }> = {}): DivisionFormatStage[] =>
  buildTemplateStages(template, { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1, ...knobs }).map((d) => ({
    name: d.name,
    kind: d.kind,
    config: d.config ?? null,
    progression: d.progression ?? null,
  }));

function props(over: Partial<DivisionFormatProps> = {}): DivisionFormatProps {
  return {
    divisionId: "d1",
    sportKey: SPORT,
    stages: [],
    offer: OFFER,
    entrantKinds: KINDS,
    templateLocks: {},
    carryAllowed: true,
    viewerPlan: "community",
    entrants: 6,
    places: 2,
    matchMinutes: 30,
    locked: false,
    canEdit: true,
    ...over,
  };
}

/** The tree, with the Modal's footer (a prop, not a child) and the shared legs control opened. */
function expand(node: ReactNode): ReactElement[] {
  return walk(node).flatMap((el) => {
    if (el.type === Modal) return [el, ...expand(propsOf(el).footer as ReactNode)];
    if (el.type === LegsChoice) return [el, ...expand(expandWithHooks(LegsChoice, propsOf(el) as Parameters<typeof LegsChoice>[0]))];
    return [el];
  });
}

const mountDialog = (over: Partial<DivisionFormatProps> = {}, onClose = vi.fn()) => ({
  h: renderIsland(DivisionFormatDialog, { ...props(over), onClose }, expand),
  onClose,
});
type Island = ReturnType<typeof mountDialog>["h"];

const byId = (h: Island, id: string) => h.tree().find((e) => propsOf(e)["data-testid"] === id);
const click = (h: Island, id: string) => {
  const el = byId(h, id);
  if (!el) throw new Error(`no ${id}`);
  (propsOf(el).onClick as () => void)();
};
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
const modalTitle = (h: Island) => String(propsOf(h.tree().find((e) => e.type === Modal)!).title);
const boundInput = (h: Island, field: string) => h.tree().find((e) => propsOf(e)["data-format-bound"] === field && e.type === "input");
const type = (h: Island, field: string, value: string) => (propsOf(boundInput(h, field)!).onChange as (e: { target: { value: string } }) => void)({ target: { value } });

type Sent = { seq: number; kind: string; name: string; config?: Record<string, unknown> | null }[];
const calls = () => apiV1Mock.mock.calls.map(([url, init]) => ({ url: String(url), method: (init as { method?: string }).method, json: (init as { json?: Sent }).json }));

const PREVIEW: FormatChangePreview = {
  dry_run: true,
  stages: [
    { id: "s1", name: "Group stage" },
    { id: "s2", name: "Knockout" },
  ],
  fixtures: 12,
  slots: 10,
  courts: 2,
  officials: 0,
  lineups: 0,
  device_links: 0,
  calls: 0,
  voided_scores: 0,
  token: "t0k",
};
const NOTHING: FormatChangePreview = { ...PREVIEW, stages: [], fixtures: 0, slots: 0, courts: 0, token: null };
const refusal = (code: keyof typeof FORMAT_CHANGE_REFUSALS, extra: Record<string, unknown> = {}) =>
  new ApiV1Error(FORMAT_CHANGE_REFUSALS[code].message, 409, code, extra);

beforeEach(() => {
  apiV1Mock.mockReset();
  refresh.mockReset();
});

describe("the Format button (FMT5)", () => {
  it("a reader gets nothing at all", () => {
    expect(renderIsland(DivisionFormatButton, props({ canEdit: false })).tree()).toEqual([]);
  });

  it("open: the purple Format button, which opens the dialog on this division's props", () => {
    const h = renderIsland(DivisionFormatButton, props());
    const button = h.tree().find((e) => propsOf(e)["data-testid"] === "division-rules-format")!;
    expect(textOf(button)).toBe(say("formatChange.button"));
    expect(String(propsOf(button).className)).toContain("bg-purple-600");
    expect(propsOf(button)["aria-disabled"]).toBeUndefined();
    expect(h.tree().some((e) => e.type === DivisionFormatDialog), "closed until pressed").toBe(false);
    (propsOf(button).onClick as () => void)();
    const dialog = h.tree().filter((e) => e.type === DivisionFormatDialog);
    expect(dialog).toHaveLength(1);
    expect(propsOf(dialog[0]!).divisionId).toBe("d1");
    // Closing it from inside: the button is back alone.
    (propsOf(dialog[0]!).onClose as () => void)();
    expect(h.tree().some((e) => e.type === DivisionFormatDialog)).toBe(false);
  });

  it("locked (a result exists): greyed, aria-disabled, the house reason in its bubble, and nothing opens - not even from the old address", () => {
    const h = renderIsland(DivisionFormatButton, props({ locked: true, initialOpen: true }));
    const button = h.tree().find((e) => propsOf(e)["data-testid"] === "division-rules-format")!;
    expect(propsOf(button)["aria-disabled"]).toBe("true");
    expect(propsOf(button).onClick, "no handler to press").toBeUndefined();
    expect(String(propsOf(button).className)).not.toContain("bg-purple-600");
    const tip = h.tree().find((e) => e.type === WithReasonTip)!;
    expect(propsOf(tip).reason).toBe(say(FORMAT_CHANGE_REFUSALS.FORMAT_LOCKED.key));
    expect(say(FORMAT_CHANGE_REFUSALS.FORMAT_LOCKED.key), "the owner's words").toBe("Format is locked once scoring starts.");
    expect(propsOf(tip).reasonTestId).toBe("division-rules-format-reason");
    expect(propsOf(button)["aria-describedby"]).toBe(propsOf(tip).id);
    expect(h.tree().some((e) => e.type === DivisionFormatDialog)).toBe(false);
  });

  // Fix round 1 (review I2): this was titled "a void unlocks it on refresh", which only the server can prove - it is now
  // proved there (format-change.test.ts, "score, void, score again"). What THIS test drives is the button's half: handed
  // `locked` false on a later render (the page's re-read of the predicate), it is live, and it does not pop open.
  it("the prop flips from locked to open on a later render: the button is live to press, and the dialog does not pop open by itself", () => {
    const h = renderIsland(DivisionFormatButton, props({ locked: true, initialOpen: true }));
    expect(h.tree().some((e) => e.type === DivisionFormatDialog)).toBe(false);
    h.rerender(props({ locked: false, initialOpen: true }));
    const button = h.tree().find((e) => propsOf(e)["data-testid"] === "division-rules-format")!;
    expect(propsOf(button)["aria-disabled"], "now open to press").toBeUndefined();
    expect(h.tree().some((e) => e.type === DivisionFormatDialog), "but not opened for the organiser").toBe(false);
  });

  it("the old Settings › Format address (initialOpen) opens the dialog on first render; without it, closed", () => {
    expect(renderIsland(DivisionFormatButton, props({ initialOpen: true })).tree().some((e) => e.type === DivisionFormatDialog)).toBe(true);
    expect(renderIsland(DivisionFormatButton, props({ initialOpen: false })).tree().some((e) => e.type === DivisionFormatDialog)).toBe(false);
  });
});

describe("the card's chip names the current format", () => {
  const msg = (key: string) => say(key);
  it("no stages: 'No format yet'; a template's stages: its name; a hand-built graph: 'Custom format'", () => {
    expect(formatChipText([], msg as never)).toBe(say("formatChange.chip.none"));
    expect(formatChipText(stagesOf("league_ko"), msg as never)).toBe(say("format.template.league_ko.label"));
    expect(formatChipText(stagesOf("swiss"), msg as never)).toBe(say("format.template.swiss.label"));
    const custom = [...stagesOf("league"), { name: "Odd", kind: "ladder", config: {}, progression: null }];
    expect(formatChipText(custom, msg as never)).toBe(say("formatChange.chip.custom"));
  });

  it("the Division rules card draws the chip and the Format button FIRST, only when handed a format and never in the builder's draft", () => {
    const strip = (format: DivisionFormatProps | undefined) =>
      renderToStaticMarkup(
        <DictProvider dict={enUi as Dict} locale="en">
          <DivisionRulesStrip
            divisionId="d1"
            sportKey={SPORT}
            variantKey={null}
            divisionConfig={{}}
            divisionTiebreakers={null}
            tableKinds={["league"]}
            canEdit
            ruleDict={rulesLineDict(enPublic as Dict)}
            variants={[]}
            lockedFields={[]}
            onlineChessOffered={false}
            format={format}
          />
        </DictProvider>,
      );
    const html = strip(props({ stages: stagesOf("league_ko") }));
    expect(html).toContain('data-testid="division-rules-format-chip"');
    expect(html).toContain(say("format.template.league_ko.label"));
    const formatAt = html.indexOf('data-testid="division-rules-format"');
    expect(formatAt).toBeGreaterThan(-1);
    let toggles = 0;
    for (const id of ["format", "points", "tiebreaks"]) {
      const at = html.indexOf(`data-testid="division-rules-toggle-${id}"`);
      if (at === -1) continue;
      expect(formatAt, `Format comes before the ${id} toggle`).toBeLessThan(at);
      toggles++;
    }
    expect(toggles, "premise: Match rules, Points and Tie-breaks are drawn beside it").toBe(3);
    const none = strip(undefined);
    expect(none).not.toContain('data-testid="division-rules-format-chip"');
    expect(none).not.toContain('data-testid="division-rules-format"');
  });
});

describe("the Format dialog: the picker over the division's own format", () => {
  it("opens on the stored format and its knobs (league_ko with Top 6), with the lead counting the division's field and courts", () => {
    const { h } = mountDialog({ stages: stagesOf("league_ko", { qualified: 6 }) });
    expect(pickedTemplate(h as never)).toBe("league_ko");
    expect(Number(propsOf(boundInput(h, "qualify")!).value)).toBe(6);
    expect(textOf(byId(h, "division-format-lead")!)).toBe(sayN("formatChange.lead", 6, { places: sayN("divBuilder.places.court", 2) }));
    expect(modalTitle(h)).toBe(say("formatChange.button"));
  });

  it("the empty case: no stages, no entrants - the builder's opening plan stands in, and the lead says so", () => {
    const { h } = mountDialog({ stages: [], entrants: 0, places: 0 });
    expect(pickedTemplate(h as never), "an opening format is picked").toBeDefined();
    expect(textOf(byId(h, "division-format-lead")!)).toBe(
      say("formatChange.lead.noEntrants", { count: OPENING_PLAN.entrants, places: sayN("divBuilder.places.court", 1) }),
    );
  });

  it("a hand-built graph says Save replaces it, and opens on the opening format", () => {
    const custom = [...stagesOf("league"), { name: "Odd", kind: "ladder", config: {}, progression: null }];
    const { h } = mountDialog({ stages: custom });
    expect(h.text()).toContain(say("formatChange.customNote"));
    expect(pickedTemplate(h as never)).toBeDefined();
    // A template's stages carry no such note.
    expect(mountDialog({ stages: stagesOf("league") }).h.text()).not.toContain(say("formatChange.customNote"));
  });

  it("a stored Swiss opens at its rounds; an unpicked Swiss at the field's recommendation, under the field's guidance", () => {
    const { h } = mountDialog({ stages: stagesOf("swiss", { swissRounds: 7 }), entrants: 20 });
    expect(Number(propsOf(boundInput(h, "swissRounds")!).value)).toBe(7);
    // 20 players: ceil(log2 20) = 5 rounds (the Swiss rule of thumb: rounds enough to separate one unbeaten player).
    const { h: fresh } = mountDialog({ stages: stagesOf("league"), entrants: 20 });
    pickTemplate(fresh as never, "swiss");
    expect(Number(propsOf(boundInput(fresh, "swissRounds")!).value)).toBe(5);
    expect(textOf(byId(fresh, "builder-swiss-rounds-guidance")!)).toContain("20");
  });
});

describe("Save: the dry run, then the write (FMT5)", () => {
  it("no fixtures: the dry run answers no token, so ONE plain PUT of the same body follows - no confirm - and the page refreshes", async () => {
    apiV1Mock.mockResolvedValueOnce(NOTHING).mockResolvedValueOnce([]);
    const { h, onClose } = mountDialog({ stages: [] });
    pickTemplate(h as never, "league_ko");
    click(h, "division-format-save");
    await flush();
    const sent = calls();
    expect(sent.map((c) => [c.method, c.url])).toEqual([
      ["PUT", `${URL_BASE}?dry_run=1`],
      ["PUT", URL_BASE],
    ]);
    expect(sent[1]!.json).toEqual(sent[0]!.json);
    const want = buildTemplateStages("league_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(sent[1]!.json!.map((s) => [s.seq, s.kind, s.name])).toEqual(want.map((d, i) => [i + 1, d.kind, d.name]));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(byId(h, "division-format-confirm")).toBeUndefined();
  });

  it("fixtures: the confirm lists what goes - N stages by name, M unplayed fixtures, K slots on C courts - and nothing is written yet", async () => {
    apiV1Mock.mockResolvedValueOnce(PREVIEW);
    const { h, onClose } = mountDialog({ stages: stagesOf("groups_ko") });
    pickTemplate(h as never, "league");
    click(h, "division-format-save");
    await flush();
    expect(calls()).toHaveLength(1);
    expect(byId(h, "division-format-confirm")).toBeDefined();
    expect(modalTitle(h)).toBe(say("formatChange.confirm.title", { format: say("format.template.league.label") }));
    const items = walk(byId(h, "division-format-clears")!).filter((e) => e.type === "li");
    expect(items.map((e) => [propsOf(e)["data-clear"], textOf(e)])).toEqual([
      ["stages", sayN("formatChange.confirm.stages", 2, { names: "Group stage, Knockout" })],
      ["fixtures", sayN("formatChange.confirm.fixtures", 12)],
      ["slots", sayN("formatChange.confirm.slots", 10, { places: sayN("divBuilder.places.court", 2) })],
    ]);
    expect(h.text()).toContain(say("formatChange.confirm.safe"));
    expect(h.text()).toContain(say("formatChange.confirm.stay"));
    expect(h.text(), "no device link: nothing about printed sheets").not.toContain(say("formatChange.confirm.sheetsStop"));
    expect(textOf(byId(h, "division-format-keep")!)).toBe(say("formatChange.confirm.keep", { format: say("format.template.groups_ko.label") }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the setup it clears is listed only where there is some, and live remote-scoring links are named with the sheets that stop", async () => {
    apiV1Mock.mockResolvedValueOnce({ ...PREVIEW, slots: 3, courts: 0, officials: 2, lineups: 1, device_links: 4, calls: 1 });
    const { h } = mountDialog({ stages: stagesOf("league") });
    click(h, "division-format-save");
    await flush();
    const items = walk(byId(h, "division-format-clears")!).filter((e) => e.type === "li");
    expect(items.map((e) => propsOf(e)["data-clear"])).toEqual(["stages", "fixtures", "slots", "officials", "lineups", "remoteLinks", "calls"]);
    expect(textOf(items[2]!)).toBe(sayN("formatChange.confirm.slotsNoCourt", 3));
    expect(textOf(items[5]!)).toBe(sayN("formatChange.confirm.remoteLinks", 4));
    expect(textOf(items[6]!)).toBe(sayN("formatChange.confirm.calls", 1));
    expect(h.text()).toContain(say("formatChange.confirm.sheetsStop"));
  });

  // Re-review r1-m1: a board whose only scores were all voided is open (ruling I2), but the clear deletes those entries.
  // The lead then names them instead of "Nothing has been played yet"; at none, the plain lead stands.
  it("voided scores: the lead says how many will be deleted, never 'nothing has been played'; none: the plain lead", async () => {
    for (const n of [3, 1]) {
      apiV1Mock.mockResolvedValueOnce({ ...PREVIEW, voided_scores: n });
      const { h } = mountDialog({ stages: stagesOf("league") });
      click(h, "division-format-save");
      await flush();
      expect(textOf(byId(h, "division-format-safe")!), `${n} voided`).toBe(sayN("formatChange.confirm.safeVoided", n));
      expect(h.text(), `${n} voided`).not.toContain(say("formatChange.confirm.safe"));
    }
    apiV1Mock.mockResolvedValueOnce({ ...PREVIEW, voided_scores: 0 });
    const { h } = mountDialog({ stages: stagesOf("league") });
    click(h, "division-format-save");
    await flush();
    expect(textOf(byId(h, "division-format-safe")!)).toBe(say("formatChange.confirm.safe"));
  });

  // Controller ruling I1 (fix round 1): a live remote-scoring link is not refused; the confirm says how many stop working,
  // and only when there is one. The server counts live links only (format-change.test.ts), so one, then none.
  it("one live remote-scoring link: its own line, in the singular; none: no line and no sheets warning", async () => {
    apiV1Mock.mockResolvedValueOnce({ ...PREVIEW, device_links: 1 });
    const { h } = mountDialog({ stages: stagesOf("league") });
    click(h, "division-format-save");
    await flush();
    const line = walk(byId(h, "division-format-clears")!).find((e) => propsOf(e)["data-clear"] === "remoteLinks");
    expect(textOf(line!)).toBe(say("formatChange.confirm.remoteLinks.one", { count: 1 }));

    apiV1Mock.mockResolvedValueOnce({ ...PREVIEW, device_links: 0 });
    const { h: none } = mountDialog({ stages: stagesOf("league") });
    click(none, "division-format-save");
    await flush();
    const kinds = walk(byId(none, "division-format-clears")!).filter((e) => e.type === "li").map((e) => propsOf(e)["data-clear"]);
    expect(kinds, "anti-vacuity: the list itself is drawn").toContain("fixtures");
    expect(kinds).not.toContain("remoteLinks");
    expect(none.text()).not.toContain(say("formatChange.confirm.sheetsStop"));
  });

  it("Clear sends the previewed body with its token, ONE write, then closes and refreshes", async () => {
    apiV1Mock.mockResolvedValueOnce(PREVIEW).mockResolvedValueOnce([]);
    const { h, onClose } = mountDialog({ stages: stagesOf("groups_ko") });
    pickTemplate(h as never, "league");
    click(h, "division-format-save");
    await flush();
    click(h, "division-format-clear");
    await flush();
    const sent = calls();
    expect(sent.map((c) => c.url)).toEqual([`${URL_BASE}?dry_run=1`, `${URL_BASE}?clear=t0k`]);
    expect(sent[1]!.json).toEqual(sent[0]!.json);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("Keep closes and writes nothing", async () => {
    apiV1Mock.mockResolvedValueOnce(PREVIEW);
    const { h, onClose } = mountDialog({ stages: stagesOf("league") });
    click(h, "division-format-save");
    await flush();
    click(h, "division-format-keep");
    await flush();
    expect(calls()).toHaveLength(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("the board moved under the open confirm: the STALE refusal's fresh counts replace the list, said so; the second Clear sends the NEW token", async () => {
    const fresh: FormatChangePreview = { ...PREVIEW, fixtures: 14, slots: 12, token: "n3w" };
    apiV1Mock
      .mockResolvedValueOnce(PREVIEW)
      .mockRejectedValueOnce(refusal("FORMAT_CHANGE_STALE", { preview: fresh }))
      .mockResolvedValueOnce([]);
    const { h, onClose } = mountDialog({ stages: stagesOf("league") });
    click(h, "division-format-save");
    await flush();
    expect(byId(h, "division-format-stale")).toBeUndefined();
    click(h, "division-format-clear");
    await flush();
    expect(textOf(byId(h, "division-format-stale")!)).toBe(say("formatChange.err.FORMAT_CHANGE_STALE"));
    const fixtures = walk(byId(h, "division-format-clears")!).find((e) => propsOf(e)["data-clear"] === "fixtures")!;
    expect(textOf(fixtures)).toBe(sayN("formatChange.confirm.fixtures", 14));
    expect(onClose, "still open for the second look").not.toHaveBeenCalled();
    click(h, "division-format-clear");
    await flush();
    expect(calls().map((c) => c.url)).toEqual([`${URL_BASE}?dry_run=1`, `${URL_BASE}?clear=t0k`, `${URL_BASE}?clear=n3w`]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a refusal at the dry run is said in words on the picker, and nothing else is sent (locked; a live stream names its match)", async () => {
    apiV1Mock.mockRejectedValueOnce(refusal("FORMAT_LOCKED"));
    const { h, onClose } = mountDialog({ stages: stagesOf("league") });
    click(h, "division-format-save");
    await flush();
    expect(textOf(byId(h, "division-format-error")!)).toBe(say("formatChange.err.FORMAT_LOCKED"));
    expect(byId(h, "division-format-confirm")).toBeUndefined();
    expect(calls()).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    // Review m6b: a first result landed while the dialog was open - the page re-reads the lock, so the button behind greys.
    expect(refresh, "FORMAT_LOCKED refreshes the page").toHaveBeenCalledTimes(1);

    apiV1Mock.mockRejectedValueOnce(refusal("FORMAT_STREAM_LIVE", { fixture_no: 7 }));
    click(h, "division-format-save");
    await flush();
    expect(textOf(byId(h, "division-format-error")!)).toBe(say("formatChange.err.FORMAT_STREAM_LIVE", { match: say("rules.err.match", { n: 7 }) }));
    expect(refresh, "any other refusal leaves the page as it is").toHaveBeenCalledTimes(1);
  });

  // Review m6a (fix round 1): the dry run found nothing to clear, but fixtures were generated before the plain PUT landed. That
  // PUT is refused FORMAT_CHANGE_CONFIRM with the board as it is now; the dialog opens the confirm on it, flagged as changed,
  // instead of an error asking for a confirm step it never showed. The confirm's Clear then sends that preview's token.
  it("fixtures appear between the dry run and the plain save: the CONFIRM refusal opens the confirm on its own counts; Clear sends its token", async () => {
    const appeared: FormatChangePreview = { ...PREVIEW, stages: [{ id: "s1", name: "League" }], fixtures: 6, slots: 0, courts: 0, token: "l4te" };
    apiV1Mock
      .mockResolvedValueOnce(NOTHING)
      .mockRejectedValueOnce(refusal("FORMAT_CHANGE_CONFIRM", { preview: appeared }))
      .mockResolvedValueOnce([]);
    const { h, onClose } = mountDialog({ stages: stagesOf("league") });
    pickTemplate(h as never, "league_ko");
    click(h, "division-format-save");
    await flush();
    expect(byId(h, "division-format-error"), "no error sentence").toBeUndefined();
    expect(byId(h, "division-format-confirm")).toBeDefined();
    expect(textOf(byId(h, "division-format-stale")!)).toBe(say("formatChange.err.FORMAT_CHANGE_STALE"));
    const items = walk(byId(h, "division-format-clears")!).filter((e) => e.type === "li");
    expect(items.map((e) => [propsOf(e)["data-clear"], textOf(e)])).toEqual([
      ["stages", sayN("formatChange.confirm.stages", 1, { names: "League" })],
      ["fixtures", sayN("formatChange.confirm.fixtures", 6)],
    ]);
    expect(onClose).not.toHaveBeenCalled();
    click(h, "division-format-clear");
    await flush();
    const sent = calls();
    expect(sent.map((c) => c.url)).toEqual([`${URL_BASE}?dry_run=1`, URL_BASE, `${URL_BASE}?clear=l4te`]);
    expect(sent[2]!.json, "the body the organiser saved").toEqual(sent[0]!.json);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Review m2's client half: someone else's change emptied the board under the open confirm, so the STALE refusal's preview
  // has no fixture and no token. The list names the stages alone (no "0 unplayed fixtures"), and Clear sends no token.
  it("the board was emptied under the open confirm: the fresh list has no fixture line, and Clear sends no token", async () => {
    const emptied: FormatChangePreview = { ...NOTHING, stages: [{ id: "s9", name: "Knockout" }] };
    apiV1Mock
      .mockResolvedValueOnce(PREVIEW)
      .mockRejectedValueOnce(refusal("FORMAT_CHANGE_STALE", { preview: emptied }))
      .mockResolvedValueOnce([]);
    const { h, onClose } = mountDialog({ stages: stagesOf("league") });
    click(h, "division-format-save");
    await flush();
    click(h, "division-format-clear");
    await flush();
    const items = walk(byId(h, "division-format-clears")!).filter((e) => e.type === "li");
    expect(items.map((e) => [propsOf(e)["data-clear"], textOf(e)])).toEqual([["stages", sayN("formatChange.confirm.stages", 1, { names: "Knockout" })]]);
    click(h, "division-format-clear");
    await flush();
    expect(calls().map((c) => c.url)).toEqual([`${URL_BASE}?dry_run=1`, `${URL_BASE}?clear=t0k`, URL_BASE]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a plan gate answers with the upgrade card, not a sentence", async () => {
    apiV1Mock.mockRejectedValueOnce(new ApiV1Error("payment required", 402, "PAYMENT_REQUIRED", { feature_key: "formats.double_elim" }));
    const { h } = mountDialog({ stages: stagesOf("league") });
    click(h, "division-format-save");
    await flush();
    const gate = h.tree().find((e) => e.type === UpgradeGate && propsOf(e).feature === "formats.double_elim");
    expect(gate).toBeDefined();
    expect(byId(h, "division-format-error")).toBeUndefined();
  });

  it("a knob outside its bounds is refused before anything is sent; back inside, the save goes", async () => {
    apiV1Mock.mockResolvedValueOnce(NOTHING).mockResolvedValueOnce([]);
    const { h } = mountDialog({ stages: stagesOf("league_ko") });
    type(h, "qualify", String(FORMAT_BOUNDS.qualify.max + 8));
    click(h, "division-format-save");
    await flush();
    expect(calls(), "nothing sent").toHaveLength(0);
    expect(textOf(byId(h, "division-format-error")!)).toBe(
      say("wizard.err.formatBound", { field: say("wizard.qualify"), min: FORMAT_BOUNDS.qualify.min, max: FORMAT_BOUNDS.qualify.max }),
    );
    type(h, "qualify", String(FORMAT_BOUNDS.qualify.max));
    click(h, "division-format-save");
    await flush();
    expect(calls()).toHaveLength(2);
    expect(byId(h, "division-format-error")).toBeUndefined();
  });
});

describe("a stored format is kept as it is, never clamped (ported from Settings › Format)", () => {
  it("a stored triple round robin opens picked (it is in the offer only for this division) and a save keeps its 3 legs", async () => {
    apiV1Mock.mockResolvedValueOnce(NOTHING).mockResolvedValueOnce([]);
    const stored: DivisionFormatStage[] = [{ kind: "league", name: "Triple RR", config: { legs: 3 }, progression: null }];
    const { h } = mountDialog({ stages: stored, offer: templatesForSport(SPORT, KINDS, "triple_rr").map((t) => t.key) });
    expect(pickedTemplate(h as never)).toBe("triple_rr");
    click(h, "division-format-save");
    await flush();
    expect(calls()[1]!.json!.map((s) => [s.kind, (s.config as { legs?: number }).legs])).toEqual([["league", 3]]);
  });
});
