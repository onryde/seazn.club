// Design audit 1.5 — a refused forfeit names the reasons it could have recorded, as a LIST in the reader's language
// (`Intl.ListFormat`), never English ", " punctuation. scoring-vocab.test.ts pins the sentence builder per locale; this
// file drives the console's own send path in a French provider, so a console that stopped handing its locale to
// `scoringErrorText` (the seam) fails here even while the builder stays green.
//
// Single-sport: the refusal is the server's, read by code; the sport only shapes the ledger the console opens on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { foldMatch } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";
import { FixtureConsole, type EventIn, type SideInfo, type SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { messages } from "@/lib/messages";
import { interpolate } from "@/lib/i18n-runtime";
import frUi from "@/dictionaries/fr/ui.json";

const FR = { ...(messages as Record<string, string>), ...(frUi as Record<string, string>) };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  // A hoisted factory: its own imports, never the file's top-level bindings.
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { messages: base } = await import("@/lib/messages");
  const { t } = await import("@/lib/i18n-runtime");
  const fr = { ...(base as Record<string, string>), ...((await import("@/dictionaries/fr/ui.json")).default as Record<string, string>) };
  const msg = (key: string, vars?: Record<string, string | number>) => t(fr as never, key as never, vars);
  return { ...actual, useMsg: () => msg, useLocaleOrDefault: () => "fr" };
});

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

const generic = builtinModules.find((m) => m.key === "generic")!;
const CFG = generic.configSchema.parse(Object.values(generic.variants)[0] ?? {});
const sport: SportInfo = { key: "generic", config: {}, scorerLabel: "Scorer", positionGroups: [], roles: [], lineupSize: 0, benchMax: 0 };
const HOME: SideInfo = { id: "home-1", name: "Riverside FC", members: [], lineup: [] };
const AWAY: SideInfo = { id: "away-1", name: "Summit Athletic", members: [], lineup: [] };
const LINEUPS = defaultLineupPair(generic.positions);
const START = makeEnvelope(1, { type: "core.start", payload: {} });
const PLAY = onePlayEvent(generic, CFG, LINEUPS, [START]);
if (PLAY === null) throw new Error("generic: its generator draws no sport event after the start");
const LEDGER = [START, PLAY];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {}, activeElement: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(apiV1).mockClear();
});

describe("a refused forfeit lists its reasons in the reader's language (audit 1.5)", () => {
  it("fr: the console's refusal joins the allowed reasons with the language's own list — « abandon et disqualification »", async () => {
    const island = renderIsland(FixtureConsole, {
      fixture: { id: "f1", status: "in_play", scheduled_at: null, venue_name: null, court_name: null, round_no: 1, no_next_match: false },
      sport,
      home: HOME,
      away: AWAY,
      initialState: { status: "in_play", last_seq: LEDGER.length, summary: null, state: foldMatch(generic, CFG, LINEUPS, LEDGER), outcome: null },
      initialEvents: LEDGER.map((e) => ({ id: e.id, seq: e.seq, type: e.type, payload: e.payload, recorded_at: "2026-10-09T10:00:00Z", voids_event_id: null })),
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
    });
    const toggle = island.tree().find((e) => propsOf(e)["data-testid"] === "score-forfeit");
    expect(toggle, "the console's Forfeit").toBeDefined();
    (propsOf(toggle!).onClick as () => void)();
    const dialog = island.tree().find((e) => typeof e.type === "function" && propsOf(e).model !== undefined && propsOf(e).forfeit !== undefined) as ReactElement | undefined;
    expect(dialog, "the dialog opened").toBeDefined();

    // The server's FORFEIT_REASON_WRONG_PHASE after play: the engine's order, the cascade's withdrew among them.
    const extra = { phase: "play", allowed: ["retired", "disqualified", "withdrew"], both: false, played: true };
    vi.mocked(apiV1).mockImplementationOnce(() => Promise.reject(new ApiV1Error("raw English", 422, "FORFEIT_REASON_WRONG_PHASE", extra)));
    const r = await (propsOf(dialog!).forfeit as (p: unknown) => Promise<{ ok: boolean; message?: string }>)({ by: AWAY.id, reason: "walkover" });

    // Expected from the platform's French list and the French dictionary — never from the code under test.
    const list = new Intl.ListFormat("fr", { style: "long", type: "conjunction" }).format([FR["forfeit.reason.retired"]!, FR["forfeit.reason.disqualified"]!]);
    expect(list, "premise: French joins the last pair with « et »").toContain(" et ");
    const want = interpolate(FR["engineErrorReason.FORFEIT_REASON_WRONG_PHASE.named"]!, { phase: FR["forfeit.phase.play"]!, allowed: list });
    expect(r).toEqual({ ok: false, message: want });
    expect(r.message, "no English list punctuation").not.toContain(`${FR["forfeit.reason.retired"]}, ${FR["forfeit.reason.disqualified"]}`);
  });
});
