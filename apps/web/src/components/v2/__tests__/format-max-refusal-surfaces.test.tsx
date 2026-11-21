// W5 B4 review I-1 (+ m-8): FORMAT_TOO_MANY_ENTRANTS and DRAW_TOO_LARGE reach the organiser in their own language on EVERY door
// that can raise them, with the numbers grouped their way - never the server's English, never a bare "4096" beside a pre-click
// reason reading "4,096". The doors (the server's three: usecases/stages/generate-tx.ts, stage-graph.ts, registrations/waitlist.ts):
//   - the Format dialog's Save (stage-graph's create/replace gate)         - DivisionFormatDialog, through the hook harness
//   - an organiser's Promote off the waiting list (waitlist.ts)             - RegistrationHubRegistrantActions, through the harness
//   - Start on the division page and on the schedule board (generate-tx)   - LaunchActions and useBoardActions, through the harness
//   - Generate / Complete, Rebuild and Add stage on the stage list          - the panel's exported readers (the panel passes its locale;
//     the readers TAKE one, so tsc holds every caller to it)
//   - a completion whose next stage's draw is refused (completion.ts's STAGE_COMPLETED_SEEDING_FAILED wrap)
//   - an Undo / Redo / Restore re-pairing an unstarted Swiss (undo-redo.ts runs the draw) - the stage list's and the AI console's
//     undo readers (B4 re-review N-1: they now take the locale)
//   - a late add into a running table past the format's max (roundrobin-late-entry.ts, B4 re-review N-3) - the waiting strip's
//     place tap through the harness, and the late-add reader the entrants panel shares (`lateEntryRefusalText`)
//
// "Through the real reply shape": every refusal is the SERVER's own error (`roundRobinRefusal`, `formatMaxPromotionRefusal`) sent
// through the REAL v1 handler and read back by the REAL `apiV1` (fetch stubbed to answer the handler's Response) - so a field the
// envelope renames or drops reds here. Expected copy is each locale's dictionary entry (`t`, the runtime's own interpolation) with
// the numbers put in by `Intl.NumberFormat(locale)` - never the component's output; the max is the engine-derived one
// (`formatMaxEntrants`, pinned against the real generators in lib/__tests__/format-max-entrants.test.ts).
//
// One sport: the refusals read stage kinds and counts only (sport-agnostic); the dialog needs a sport for its picker - badminton.
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expandWithHooks, propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

type L = "en" | "es" | "fr" | "nl";
const LOCALES: readonly L[] = ["en", "es", "fr", "nl"];
const DICTS: Record<L, Dict> = { en: uiEn as unknown as Dict, es: uiEs as unknown as Dict, fr: uiFr as unknown as Dict, nl: uiNl as unknown as Dict };

const cur = vi.hoisted(() => ({ locale: "en" as "en" | "es" | "fr" | "nl" }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const runtime = await import("@/lib/i18n-runtime");
  const dicts = {
    en: (await import("@/dictionaries/en/ui.json")).default,
    es: (await import("@/dictionaries/es/ui.json")).default,
    fr: (await import("@/dictionaries/fr/ui.json")).default,
    nl: (await import("@/dictionaries/nl/ui.json")).default,
  } as unknown as Record<string, Record<string, unknown>>;
  // The reader's language, switched per case: the hooks a screen calls answer in `cur.locale` exactly as a DictProvider would.
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => runtime.t(dicts[cur.locale]!, key, vars),
    useMsgPlural: () => (key: string, n: number, vars?: Record<string, string | number>) => runtime.plural(dicts[cur.locale]!, key, n, cur.locale, vars),
    useLocale: () => cur.locale,
    useLocaleOrDefault: () => cur.locale,
  };
});

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, push: nav.push, replace: vi.fn() }),
  usePathname: () => "/o/acme/c/champs/d/u12",
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));

/** What the next request answers: a SERVER error (sent over the real wire) or a body. */
const net = vi.hoisted(() => ({ next: [] as unknown[], calls: [] as string[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class
    apiV1: vi.fn(async (url: string) => {
      net.calls.push(url);
      // The board's advisory conflict check (useBoardActions' runValidate) runs on its own after a write: it answers its own shape
      // and never takes the queued answer, which belongs to the write under test. (An empty `{}` here became `[undefined]` in the
      // hook's conflicts and threw an unhandled rejection after the test had passed.)
      if (url.endsWith("/schedule/validate")) return { conflicts: [] };
      const answer = net.next.shift();
      if (answer instanceof Error) throw await overTheWire(answer);
      return answer ?? {};
    }),
  };
});

import { v1 } from "@/server/api-v1/http";
import { formatMaxLateEntryRefusal, formatMaxPromotionRefusal, roundRobinRefusal } from "@/server/usecases/roundrobin-refusal";
import { HttpError } from "@/lib/errors";
import { ApiV1Error } from "@/lib/client-v1";
import { formatMaxEntrants, START_LINE_BUDGET } from "@/lib/format-max-entrants";
import { FORMAT_MAX_LATE_ENTRY, FORMAT_MAX_PROMOTION, ROUND_ROBIN_REFUSALS, lateEntryRefusalText } from "@/lib/roundrobin-refusals";
import { completedSeedingFailedText, STAGE_COMPLETED_SEEDING_FAILED } from "@/lib/completed-seeding-failed";
import { Modal } from "@/components/modal";
import { LegsChoice } from "@/components/v2/legs-choice";
import { DivisionFormatDialog, type DivisionFormatProps, type DivisionFormatStage } from "@/components/v2/rules/division-format";
import { RegistrationHubRegistrantActions } from "@/components/registration-hub-registrant-actions";
import { LaunchActions } from "@/components/v2/launch-actions";
import { StartConfirmDialog } from "@/components/v2/start-confirm-dialog";
import { useBoardActions, type BoardActions } from "@/components/v2/board/use-board-actions";
import type { BoardDivision } from "@/components/v2/board/types";
import { addStageErrorText, classifyActError, rebuildErrorText, undoRefusalMessage } from "@/components/v2/stages-panel";
import { aiUndoErrorText } from "@/components/v2/board/ai-console-state";
import { TableWaitingStrip } from "@/components/v2/desk/table-waiting-strip";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";

/** The server's error as the browser receives it: the REAL v1 handler's Response, parsed by the REAL apiV1. */
async function overTheWire(err: Error): Promise<ApiV1Error> {
  const real = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  const res = await v1(async () => {
    throw err;
  });
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => res) as typeof fetch;
  try {
    await real.apiV1("/api/v1/the-door");
  } catch (e) {
    return e as ApiV1Error;
  } finally {
    globalThis.fetch = saved;
  }
  throw new Error("premise: the wire answered ok");
}

const KNOCKOUT_MAX = formatMaxEntrants({ kind: "knockout", config: {} })!;
const LEAGUE_MAX = formatMaxEntrants({ kind: "league", config: { legs: 1 } })!;
// An americano as an API client stored it - 40 courts x 300 rounds: a draw no field bounds (DRAW_TOO_LARGE's reason to exist). Five
// digits, so even Spanish (which leaves a four-digit number ungrouped) groups it.
const AMERICANO_LINES = 40 * 300;

const group = (locale: L, n: number) => new Intl.NumberFormat(locale).format(n);
const said = (locale: L, key: string, vars: Record<string, number>) =>
  t(DICTS[locale], key, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, group(locale, v)])));

/** The two refusals a draw door raises, as the server raises them (generate-tx.ts). */
const DRAW_REFUSALS = [
  { code: "FORMAT_TOO_MANY_ENTRANTS", vars: { max: KNOCKOUT_MAX, entrants: KNOCKOUT_MAX + 1 }, server: () => roundRobinRefusal("FORMAT_TOO_MANY_ENTRANTS", { max: KNOCKOUT_MAX, entrants: KNOCKOUT_MAX + 1, stageId: "s1" }) },
  { code: "DRAW_TOO_LARGE", vars: { lines: AMERICANO_LINES, budget: START_LINE_BUDGET }, server: () => roundRobinRefusal("DRAW_TOO_LARGE", { lines: AMERICANO_LINES, budget: START_LINE_BUDGET }) },
] as const;
const keyOf = (code: keyof typeof ROUND_ROBIN_REFUSALS) => ROUND_ROBIN_REFUSALS[code].key;

/** Every case asserts the localized sentence, that it is not the server's English (outside en), and that no slot is left open. */
function expectSaid(shown: string | null | undefined, locale: L, expected: string, english: string, label: string) {
  expect(shown, `${label} ${locale}: the dictionary's sentence, numbers grouped the reader's way`).toBe(expected);
  expect(shown, `${label} ${locale}: every slot filled`).not.toMatch(/\{\w+\}/);
  if (locale !== "en") expect(shown, `${label} ${locale}: never the server's English`).not.toBe(english);
}

beforeEach(() => {
  cur.locale = "en";
  net.next.length = 0;
  net.calls.length = 0;
  nav.refresh.mockClear();
  nav.push.mockClear();
});

describe("premises", () => {
  it("the wire carries the code and both numbers by name; the numbers group differently by locale (else the sweep is vacuous)", async () => {
    const wire = await overTheWire(DRAW_REFUSALS[0].server());
    expect(wire).toBeInstanceOf(ApiV1Error);
    expect({ status: wire.status, code: wire.code, max: wire.extra.max, entrants: wire.extra.entrants }).toEqual({
      status: 422,
      code: "FORMAT_TOO_MANY_ENTRANTS",
      max: KNOCKOUT_MAX,
      entrants: KNOCKOUT_MAX + 1,
    });
    // Anti-vacuity: grouping changes the text in at least three of the four locales for the knockout's max, and in all four for the
    // americano's five-digit count.
    expect(LOCALES.filter((l) => group(l, KNOCKOUT_MAX) !== String(KNOCKOUT_MAX)).length).toBeGreaterThanOrEqual(3);
    expect(LOCALES.filter((l) => group(l, AMERICANO_LINES) !== String(AMERICANO_LINES))).toEqual(LOCALES);
    expect(new Set(LOCALES.map((l) => group(l, AMERICANO_LINES))).size, "the four groupings differ").toBeGreaterThanOrEqual(3);
  });
});

describe("the Format dialog's Save (the create/replace door) says FORMAT_TOO_MANY_ENTRANTS in the reader's language", () => {
  const SPORT = "badminton";
  const KINDS = engineEntrantKinds(SPORT);
  const stagesOf = (template: string): DivisionFormatStage[] =>
    buildTemplateStages(template, { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 }).map((d) => ({
      name: d.name,
      kind: d.kind,
      config: d.config ?? null,
      progression: d.progression ?? null,
    }));
  const props = (over: Partial<DivisionFormatProps>): DivisionFormatProps => ({
    divisionId: "d1",
    sportKey: SPORT,
    stages: [],
    offer: templatesForSport(SPORT, KINDS).map((x) => x.key),
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
  });
  const expand = (node: ReactNode): ReactElement[] =>
    walk(node).flatMap((el) => {
      if (el.type === Modal) return [el, ...expand(propsOf(el).footer as ReactNode)];
      if (el.type === LegsChoice) return [el, ...expand(expandWithHooks(LegsChoice, propsOf(el) as Parameters<typeof LegsChoice>[0]))];
      return [el];
    });

  it("a 1,500-entrant division saved as a league (max per the engine): the refusal's sentence, both numbers grouped, in 4 locales", async () => {
    const ENTRANTS = 1500;
    let checked = 0;
    for (const locale of LOCALES) {
      cur.locale = locale;
      // The server's create/replace gate (stage-graph.ts insertStageBatch): `{ max, entrants }`.
      const server = roundRobinRefusal("FORMAT_TOO_MANY_ENTRANTS", { max: LEAGUE_MAX, entrants: ENTRANTS });
      net.next.push(server);
      const h = renderIsland(DivisionFormatDialog, { ...props({ stages: stagesOf("league"), entrants: ENTRANTS }), onClose: vi.fn() }, expand);
      (propsOf(h.tree().find((e) => propsOf(e)["data-testid"] === "division-format-save")!).onClick as () => void)();
      // The refusal crosses the real handler and parser first: wait for the line rather than a fixed number of ticks.
      const error = await vi.waitFor(() => h.tree().find((e) => propsOf(e)["data-testid"] === "division-format-error") ?? Promise.reject(new Error("no error line yet")), { timeout: 15_000 });
      expect(net.calls.some((u) => u.includes("/stages?dry_run=1")), `premise ${locale}: the dry run was sent`).toBe(true);
      expectSaid(error ? textOf(error) : null, locale, said(locale, keyOf("FORMAT_TOO_MANY_ENTRANTS"), { max: LEAGUE_MAX, entrants: ENTRANTS }), server.message, "format dialog");
      checked++;
    }
    expect(checked, "anti-vacuity: 4 locales").toBe(4);
  });
});

describe("an organiser's Promote at the format's max says it in the promotion's own sentence (m-8), in the reader's language", () => {
  type ActionProps = Parameters<typeof RegistrationHubRegistrantActions>[0];
  const PROPS: ActionProps = {
    registrationId: "reg-1",
    status: "waitlisted",
    approval: "auto",
    amountCents: 0,
    divisionFeeCents: 0,
    paymentIntentId: null,
    entryPaymentIntentId: null,
    refundedCents: 0,
    lastRemindedAt: null,
    remindersInWindow: 0,
    approvedAt: null,
    paymentLostToDispute: false,
  };

  it("a knockout at its max (the field AS IT STANDS, never one past it): the sentence, both numbers grouped, in 4 locales", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      cur.locale = locale;
      const server = formatMaxPromotionRefusal(KNOCKOUT_MAX, KNOCKOUT_MAX);
      net.next.push(server);
      const island = renderIsland(RegistrationHubRegistrantActions, PROPS);
      const promote = island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-action"] === "promote")!;
      await (propsOf(promote).onClick as () => Promise<void>)();
      expect(net.calls.at(-1), `premise ${locale}: promote was sent`).toMatch(/\/promote$/);
      const el = island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-actions-feedback"] !== undefined);
      expect(el && propsOf(el)["data-tone"], `${locale}: an error`).toBe("error");
      expectSaid(el ? textOf(el) : null, locale, said(locale, FORMAT_MAX_PROMOTION.key, { max: KNOCKOUT_MAX, entrants: KNOCKOUT_MAX }), server.message, "promote");
      expect(nav.refresh, `${locale}: a refused promotion refreshes nothing`).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("m-8: the server's English no longer contradicts itself at the max ('up to N ... has N'); it says the division already has them", () => {
    const err = formatMaxPromotionRefusal(LEAGUE_MAX, LEAGUE_MAX);
    expect(err).toMatchObject({ status: ROUND_ROBIN_REFUSALS.FORMAT_TOO_MANY_ENTRANTS.status, code: "FORMAT_TOO_MANY_ENTRANTS", extra: { max: LEAGUE_MAX, entrants: LEAGUE_MAX } });
    expect(err.message).toBe(t(DICTS.en, FORMAT_MAX_PROMOTION.key, { max: LEAGUE_MAX, entrants: LEAGUE_MAX }));
    expect(err.message, "not the draw doors' sentence").not.toBe(roundRobinRefusal("FORMAT_TOO_MANY_ENTRANTS", { max: LEAGUE_MAX, entrants: LEAGUE_MAX }).message);
  });
});

describe("Start - on the division page and on the schedule board - says both draw refusals in the reader's language", () => {
  type LaunchProps = Parameters<typeof LaunchActions>[0];
  const launchProps: LaunchProps = {
    divisionId: "d1",
    orgSlug: "acme",
    compSlug: "champs",
    divSlug: "u12",
    status: "scheduled",
    canEdit: true,
    fixtures: [],
    entrantNames: {},
    // The page's field read is stale (a registration landed after it rendered), so Start is live and the SERVER refuses.
    stages: [{ kind: "knockout", progression: null, config: {} }],
    competitionStatus: "published",
    competitionVisibility: "public",
    viewerPlan: "community",
    activeEntrants: 2,
  } as LaunchProps;

  it("LaunchActions: the confirmed Start's refusal, 2 codes x 4 locales", async () => {
    let checked = 0;
    for (const r of DRAW_REFUSALS) {
      for (const locale of LOCALES) {
        cur.locale = locale;
        const server = r.server();
        net.next.push(server);
        const island = renderIsland(LaunchActions, launchProps);
        const confirm = island.tree().find((e) => e.type === StartConfirmDialog)!;
        (propsOf(confirm).onConfirm as () => void)();
        const red = await vi.waitFor(() => island.tree().find((e) => e.type === "span" && propsOf(e).className === "text-xs text-red-600") ?? Promise.reject(new Error("no red line yet")), { timeout: 15_000 });
        expect(net.calls.at(-1), `premise ${r.code} ${locale}: Start was sent`).toBe("/api/v1/divisions/d1/start");
        expectSaid(red ? textOf(red) : null, locale, said(locale, keyOf(r.code), r.vars), server.message, `Start ${r.code}`);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("useBoardActions: the board's Start (act) says the same, 2 codes x 4 locales", async () => {
    // Stable references, as the board passes them: a fresh array each render re-runs the hook's board sync for ever.
    const DIVISIONS = [{ id: "d1", name: "Open", seq: 1 } as unknown as BoardDivision];
    const FIXTURES: never[] = [];
    const NONE = {};
    let checked = 0;
    for (const r of DRAW_REFUSALS) {
      for (const locale of LOCALES) {
        cur.locale = locale;
        const server = r.server();
        net.next.push(server);
        let latest: BoardActions | null = null;
        renderIsland(() => {
          latest = useBoardActions(DIVISIONS, FIXTURES, NONE, NONE, true);
          return null;
        }, {});
        await (latest as unknown as BoardActions).act("/api/v1/divisions/d1/start", "started");
        expectSaid((latest as unknown as BoardActions).error, locale, said(locale, keyOf(r.code), r.vars), server.message, `board Start ${r.code}`);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });
});

describe("the stage list's readers - Generate / Complete, Rebuild, Add stage - and a completion's wrapped cause", () => {
  const msgIn = (locale: L) => (key: string, vars?: Record<string, string | number>) => t(DICTS[locale], key, vars);
  const pluralIn = (locale: L) => (key: string, n: number, vars?: Record<string, string | number>) => t(DICTS[locale], `${key}.other`, { count: n, ...vars });

  it("classifyActError, rebuildErrorText and addStageErrorText: 3 readers x 2 codes x 4 locales", async () => {
    let checked = 0;
    for (const r of DRAW_REFUSALS) {
      const server = r.server();
      const wire = await overTheWire(server);
      for (const locale of LOCALES) {
        const expected = said(locale, keyOf(r.code), r.vars);
        const act = classifyActError(wire, msgIn(locale) as never, locale);
        expect(act.tone, `Generate ${r.code}: amber, the stage stands`).toBe("warning");
        expectSaid(act.text, locale, expected, server.message, `Generate ${r.code}`);
        expectSaid(rebuildErrorText(wire, msgIn(locale) as never, pluralIn(locale) as never, locale), locale, expected, server.message, `Rebuild ${r.code}`);
        expectSaid(addStageErrorText(wire, msgIn(locale) as never, locale), locale, expected, server.message, `Add stage ${r.code}`);
        checked += 3;
      }
    }
    expect(checked).toBe(24);
  });

  it("STAGE_COMPLETED_SEEDING_FAILED carrying either draw refusal as its cause: 'completed, but' + the cause's sentence, 2 x 4", async () => {
    let checked = 0;
    for (const r of DRAW_REFUSALS) {
      const inner = r.server();
      // completion.ts's wrap, built as it builds it: the inner refusal's fields plus `cause` (its code) and the two stage ids.
      const wrapped = new HttpError(409, inner.message, STAGE_COMPLETED_SEEDING_FAILED, { ...inner.extra, cause: inner.code, stageId: "s1", nextStageId: "s2" });
      const wire = await overTheWire(wrapped);
      for (const locale of LOCALES) {
        const expected = t(DICTS[locale], "schedule.error.completedSeedingFailed", { reason: said(locale, keyOf(r.code), r.vars) });
        expectSaid(completedSeedingFailedText(wire, msgIn(locale) as never, locale), locale, expected, wrapped.message, `completion ${r.code}`);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });
});

describe("B4 re-review N-1: the undo readers - the stage list's and the AI console's - say both draw refusals with grouped numbers", () => {
  const msgIn = (locale: L) => (key: string, vars?: Record<string, string | number>) => t(DICTS[locale], key, vars);

  it("undoRefusalMessage and aiUndoErrorText: 2 readers x 2 codes x 4 locales", async () => {
    let checked = 0;
    for (const r of DRAW_REFUSALS) {
      const server = r.server();
      const wire = await overTheWire(server);
      for (const locale of LOCALES) {
        const expected = said(locale, keyOf(r.code), r.vars);
        expectSaid(undoRefusalMessage(wire, msgIn(locale) as never, locale), locale, expected, server.message, `stage-list Undo ${r.code}`);
        expectSaid(aiUndoErrorText(wire.status, wire.code, wire.extra, msgIn(locale) as never, locale), locale, expected, server.message, `AI console Undo ${r.code}`);
        checked += 2;
      }
    }
    expect(checked).toBe(16);
  });
});

describe("B4 re-review N-3: a late add past the format's max says it in the late add's own sentence, in the reader's language", () => {
  const msgIn = (locale: L) => (key: string, vars?: Record<string, string | number>) => t(DICTS[locale], key, vars);
  // A league at its max takes one more: the field the add would make, never one the division holds (the add is rolled back).
  const VARS = { max: LEAGUE_MAX, entrants: LEAGUE_MAX + 1 };

  it("the server's English is the sentence's own en, not the draw doors' 'This division has {entrants}' (false: nothing was added)", () => {
    const err = formatMaxLateEntryRefusal(VARS.max, VARS.entrants);
    expect(err).toMatchObject({ status: ROUND_ROBIN_REFUSALS.FORMAT_TOO_MANY_ENTRANTS.status, code: "FORMAT_TOO_MANY_ENTRANTS", extra: VARS });
    expect(err.message).toBe(t(DICTS.en, FORMAT_MAX_LATE_ENTRY.key, VARS));
    expect(err.message, "not the draw doors' sentence").not.toBe(roundRobinRefusal("FORMAT_TOO_MANY_ENTRANTS", VARS).message);
  });

  it("lateEntryRefusalText (the entrants panel's add): the late-add sentence for the max, every other code the table's own, 4 locales", async () => {
    let checked = 0;
    const late = formatMaxLateEntryRefusal(VARS.max, VARS.entrants);
    const lateWire = await overTheWire(late);
    const other = DRAW_REFUSALS[1];
    const otherWire = await overTheWire(other.server());
    for (const locale of LOCALES) {
      expectSaid(lateEntryRefusalText("FORMAT_TOO_MANY_ENTRANTS", lateWire.extra, msgIn(locale) as never, locale), locale, said(locale, FORMAT_MAX_LATE_ENTRY.key, VARS), late.message, "late add");
      expectSaid(lateEntryRefusalText(other.code, otherWire.extra, msgIn(locale) as never, locale), locale, said(locale, keyOf(other.code), other.vars), other.server().message, `late add ${other.code}`);
      checked += 2;
    }
    expect(checked).toBe(8);
  });

  it("the waiting strip's place tap, refused at the max: the row says the late-add sentence, 4 locales", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      cur.locale = locale;
      net.calls.length = 0;
      const server = formatMaxLateEntryRefusal(VARS.max, VARS.entrants);
      net.next.push(server);
      const island = renderIsland(TableWaitingStrip, {
        stageId: "stage-1",
        waiting: [{ entrantId: "e-late", stageId: "stage-1", name: "Late Joiner", paid: false }],
        names: {},
        registrationsHref: "/o/club/c/open/registration",
        onPlaced: () => {},
      } as never);
      const tap = island.tree().find((e) => propsOf(e)["data-testid"] === "table-waiting-place")!;
      (propsOf(tap).onClick as () => void)();
      // Waited on by condition, as the sibling cases do: the refusal crosses the real v1 handler, and on a loaded machine twenty
      // zero-delay ticks were not enough for the row to render (seen at load ~40: the tap sent, its answer taken, no row yet).
      const row = await vi.waitFor(() => island.tree().find((e) => propsOf(e)["data-testid"] === "table-waiting-outcome") ?? Promise.reject(new Error("no outcome row yet")), { timeout: 15_000 });
      // By membership, not `.at(-1)`: the board case's advisory `/schedule/validate` (debounced) can land late from an earlier test.
      expect(net.calls.filter((c) => /\/late-entrants\/e-late\/place$/.test(c)), `premise ${locale}: the place tap was sent once`).toHaveLength(1);
      // The row's sentence: its first line (the Withdraw / refund buttons follow it in the same box).
      const line = (propsOf(row).children as unknown[]).flat().find((c) => (c as ReactElement | null)?.type === "p") as ReactElement | undefined;
      expectSaid(line ? textOf(line) : null, locale, said(locale, FORMAT_MAX_LATE_ENTRY.key, VARS), server.message, "waiting strip");
      checked++;
    }
    expect(checked).toBe(4);
  });
});
