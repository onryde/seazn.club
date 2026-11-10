// 2026-11-10 — the console's half of "Void back to here" (docs/specs/2026-11-10-cricket-wicket-void-latest-only.md):
// the ledger panel is handed the sequence, the sequence is each a plain `core.void` of the then-latest entry, newest first,
// each on the next seq, and one refused step stops it and says how many were voided. Driven through the console's own
// `onVoidBack`, exactly what the panel calls on Confirm. Expected strings come from the dictionary, expected seqs and ids
// from the ledger below.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { messages, type MessageKey } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: vi.fn() };
});

const en = (key: MessageKey, params?: Record<string, string | number>) => tRuntime(messages, key, params);

const generic = builtinModules.find((m) => m.key === "generic")!;
const CFG = generic.configSchema.parse(Object.values(generic.variants)[0] ?? {});
const sport: SportInfo = { key: "generic", config: {}, scorerLabel: "Scorer", positionGroups: [], roles: [], lineupSize: 0, benchMax: 0 };
const HOME: SideInfo = { id: "home-1", name: "Riverside CC", members: [], lineup: [] };
const AWAY: SideInfo = { id: "away-1", name: "Summit CC", members: [], lineup: [] };

const row = (id: string, seq: number, type: string, payload: unknown): EventIn => ({
  id, seq, type, payload, recorded_at: "2026-11-10T10:00:00Z", voids_event_id: null,
});
const BALL = { over: 0, ballInOver: 1, striker: "h1", nonStriker: "h2", bowler: "a7", runs: { bat: 1 } };
// seq 1 start, 2 a single, 3 a WICKET, 4 a single, 5 a four.
const ROWS: EventIn[] = [
  row("s1", 1, "core.start", {}),
  row("b2", 2, "cricket.ball", BALL),
  row("w3", 3, "cricket.ball", { ...BALL, wicket: { kind: "bowled", out: "h1", bowlerCredited: true } }),
  row("b4", 4, "cricket.ball", BALL),
  row("b5", 5, "cricket.ball", BALL),
];

function props(status = "in_play") {
  const live = { status, last_seq: ROWS.length, summary: null, state: null, outcome: null };
  return {
    fixture: { id: "f1", status, scheduled_at: null, venue_name: null, court_name: null, round_no: 1, no_next_match: false },
    sport, home: HOME, away: AWAY, initialState: live, initialEvents: ROWS, canEdit: true, canOrganise: true, stageKind: null,
    viewerPlan: "community" as const,
    scorePadV2: {
      moduleVersion: generic.version, resolvedConfig: CFG, initialEvents: [], entitlements: {}, stageKind: null,
      identity: { recordedBy: "user-1", deviceLinkId: null },
    },
  };
}

const panelOf = (tree: ReactElement[]) => tree.find((e) => typeof e.type === "function" && propsOf(e).events !== undefined && "onVoidBack" in propsOf(e));
const posts = () => vi.mocked(apiV1).mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === "POST");
const sent = () =>
  posts().map(([, o]) => {
    const { expected_seq, type, payload } = (o as { json: { expected_seq: number; type: string; payload: { event_id: string } } }).json;
    return { expected_seq, type, payload };
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {}, activeElement: null });
  vi.mocked(apiV1).mockImplementation(async (url: string) => {
    if (url.includes("/events?")) return [] as EventIn[];
    return { status: "in_play", last_seq: 5, summary: null, state: null, outcome: null };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.mocked(apiV1).mockReset();
});

describe("the console hands the ledger panel 'Void back to here'", () => {
  it("sends one core.void per id, newest first, each on the next seq", async () => {
    const island = renderIsland(FixtureConsole, props());
    const panel = panelOf(island.tree());
    expect(panel, "the ledger panel is mounted with onVoidBack").toBeDefined();
    const onVoidBack = propsOf(panel!).onVoidBack as (ids: string[]) => void;
    onVoidBack(["b5", "b4", "w3"]);
    await vi.waitFor(() => expect(posts()).toHaveLength(3));
    expect(sent()).toEqual([
      { expected_seq: 5, type: "core.void", payload: { event_id: "b5" } },
      { expected_seq: 6, type: "core.void", payload: { event_id: "b4" } },
      { expected_seq: 7, type: "core.void", payload: { event_id: "w3" } },
    ]);
  });

  it("a refused step stops the sequence: the rest is not sent, and the line says how many were voided and why", async () => {
    let n = 0;
    vi.mocked(apiV1).mockImplementation(async (url: string, o?: RequestInit) => {
      if (o?.method === "POST") {
        n += 1;
        if (n === 2) throw new ApiV1Error("conflict", 409, "SEQ_CONFLICT");
        return {};
      }
      if (url.includes("/events?")) return [] as EventIn[];
      return { status: "in_play", last_seq: 6, summary: null, state: null, outcome: null };
    });
    const island = renderIsland(FixtureConsole, props());
    (propsOf(panelOf(island.tree())!).onVoidBack as (ids: string[]) => void)(["b5", "b4", "w3"]);
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    await vi.waitFor(() => {
      const line = island.tree().find((e) => e.type === "p" && textOf(e).includes("Voided"));
      expect(line && textOf(line)).toBe(en("score.voidBackStopped", { done: 1, total: 3, reason: en("score.seqConflict") }));
    });
    expect(posts(), "w3 was never sent").toHaveLength(2);
    expect(sent().map((s) => s.payload.event_id)).toEqual(["b5", "b4"]);
  });

  it("the server's own refusal reads in the reader's words, not the raw English message", async () => {
    vi.mocked(apiV1).mockImplementation(async (url: string, o?: RequestInit) => {
      if (o?.method === "POST") throw new ApiV1Error("A wicket can be undone only while it is the latest ball", 409, "UNDO_WICKET_NOT_LATEST");
      if (url.includes("/events?")) return [] as EventIn[];
      return { status: "in_play", last_seq: 5, summary: null, state: null, outcome: null };
    });
    const island = renderIsland(FixtureConsole, props());
    (propsOf(panelOf(island.tree())!).onVoidBack as (ids: string[]) => void)(["w3"]);
    await vi.waitFor(() => {
      const line = island.tree().find((e) => e.type === "p" && textOf(e).includes("Voided 0 of 1"));
      expect(line && textOf(line)).toBe(en("score.voidBackStopped", { done: 0, total: 1, reason: en("scorepad.refusal.undoWicketNotLatest") }));
    });
  });

  it("a decided fixture offers no sequence at all", () => {
    const island = renderIsland(FixtureConsole, props("finalized"));
    const panel = panelOf(island.tree());
    expect(panel).toBeDefined();
    expect(propsOf(panel!).onVoidBack).toBeUndefined();
    expect(posts()).toHaveLength(0);
  });
});
