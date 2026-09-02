// P11 (D6) — division import page client island (design doc §7). This is
// "the meaty part" per the task brief: every rejection code §4 lists must
// render as a real, localized sentence — per row for a stream the CALL
// itself completed but refused, and as a call-level banner for a rejection
// that means no per-stream result exists at all (413/409). No jsdom in this
// workspace (vitest.config.ts: environment "node") — driven through the
// shared hook harness, same convention as registration-hub-config-panel.test.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland, walk, propsOf, textOf } from "@/components/__tests__/_hook-harness";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  response: null as unknown,
  rejection: null as unknown,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      if (net.rejection) {
        const e = net.rejection;
        net.rejection = null;
        return Promise.reject(e);
      }
      return Promise.resolve(net.response);
    },
  };
});

import { ApiV1Error } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";
import { ImportClient } from "../ImportClient";

// Real dictionary lookup (never a stub echoing the key back), matching the
// discipline registration-hub-config-panel.test.tsx documents: a section
// that forgot to route copy through `msg` at all must still read as a real
// render, not a false pass.
const msg = (key: string, vars?: Record<string, string | number>) => t(uiEn, key, vars);

const BASE_PROPS = {
  divisionId: "div-1",
  orgSlug: "riverside",
  compSlug: "summer",
  divSlug: "open",
  fixtureNoById: { "fx-1": 3 },
};

type Tree = ReturnType<typeof walk>;

const findButton = (tree: Tree) => tree.find((e) => e.type === "button")!;
const findTextarea = (tree: Tree) => tree.find((e) => e.type === "textarea")!;
const findFileInput = (tree: Tree) => tree.find((e) => e.type === "input" && propsOf(e).type === "file")!;

// `Pick<..., "tree">` rather than the full return type: `rerender`'s
// parameter is typed by renderIsland's own generic `P`, and this helper
// never calls it — the full type forces `P` to `unknown` here, which then
// rejects every concretely-typed island passed in (rerender's parameter is
// checked contravariantly). Only `tree()` is used below, so only that.
async function setPastedAndSubmit(island: Pick<ReturnType<typeof renderIsland>, "tree">, jsonText: string) {
  const textarea = findTextarea(island.tree());
  (propsOf(textarea).onChange as (e: unknown) => void)({ target: { value: jsonText } });
  const button = findButton(island.tree());
  await (propsOf(button).onClick as () => Promise<void>)();
}

beforeEach(() => {
  net.calls = [];
  net.response = null;
  net.rejection = null;
});

describe("ImportClient — local JSON.parse before submit", () => {
  it("shows a local parse error naming the position and never calls the API", async () => {
    const island = renderIsland(ImportClient, BASE_PROPS);
    let nativeMessage = "";
    try {
      JSON.parse("{ bad json");
    } catch (e) {
      nativeMessage = (e as Error).message;
    }
    await setPastedAndSubmit(island, "{ bad json");
    expect(island.text()).toContain(msg("eventImport.parseError", { message: nativeMessage }));
    expect(net.calls).toHaveLength(0);
  });

  it("keeps the textarea's contents after a parse error", async () => {
    const island = renderIsland(ImportClient, BASE_PROPS);
    await setPastedAndSubmit(island, "not json");
    expect(propsOf(findTextarea(island.tree())).value).toBe("not json");
  });
});

describe("ImportClient — file picker feeds the SAME state as the textarea", () => {
  it("populates the textarea from the selected file's contents", async () => {
    const island = renderIsland(ImportClient, BASE_PROPS);
    const fileInput = findFileInput(island.tree());
    const fakeFile = { text: async () => '{"import_id":"x","streams":[]}' };
    await (propsOf(fileInput).onChange as (e: unknown) => Promise<void>)({
      target: { files: [fakeFile], value: "" },
    });
    expect(propsOf(findTextarea(island.tree())).value).toBe('{"import_id":"x","streams":[]}');
  });
});

describe("ImportClient — POSTs the parsed body verbatim", () => {
  it("sends the parsed JSON (not the raw string) to this division's import route", async () => {
    net.response = { importId: "imp-1", totals: { imported: 0, skipped: 0, rejected: 0 }, results: [] };
    const island = renderIsland(ImportClient, BASE_PROPS);
    const payload = { import_id: "imp-1", streams: [] };
    await setPastedAndSubmit(island, JSON.stringify(payload));
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe("/api/v1/divisions/div-1/events/import");
    expect(net.calls[0]!.method).toBe("POST");
    expect(net.calls[0]!.json).toEqual(payload);
  });
});

describe("ImportClient — the report table (every rejection code the design doc lists)", () => {
  it("renders one localized message per code, a linked fixture, an unresolved reference as plain text, and the totals row", async () => {
    const REPORT = {
      importId: "imp-1",
      totals: { imported: 1, skipped: 1, rejected: 8 },
      results: [
        {
          fixture: "fx-1",
          status: "imported",
          eventsAppended: 3,
          outcome: {
            kind: "win",
            winner: "11111111-1111-4111-8111-111111111111",
            loser: "22222222-2222-4222-8222-222222222222",
            method: "regulation",
          },
        },
        { fixture: "fx-2", status: "skipped_duplicate", eventsAppended: 0 },
        { fixture: "fx-3", status: "rejected", eventsAppended: 0, error: { code: "import.fixture_started" } },
        {
          fixture: "ext:unknown-1",
          status: "rejected",
          eventsAppended: 0,
          error: { code: "import.fixture_unknown", matches: 2 },
        },
        {
          fixture: "fx-4",
          status: "rejected",
          eventsAppended: 0,
          error: { code: "import.fold_rejected", eventIndex: 2, engineCode: "SEQ_CONFLICT" },
        },
        {
          fixture: "fx-5",
          status: "rejected",
          eventsAppended: 0,
          error: { code: "import.fold_rejected", engineCode: "WRONG_PHASE" },
        },
        { fixture: "fx-6", status: "rejected", eventsAppended: 0, error: { code: "import.not_decided" } },
        {
          fixture: "fx-7",
          status: "rejected",
          eventsAppended: 0,
          // W1 (entitlements v18): `cricket.dls`, not `scoring.ball_by_ball`.
          // V390 deleted the three fidelity keys, and `event-import.ts` can now
          // only ever put `cricket.dls` in this field — a fixture naming a key
          // production cannot emit proves the renderer against nothing.
          error: { code: "import.entitlement", feature: "cricket.dls" },
        },
        { fixture: "fx-8", status: "rejected", eventsAppended: 0, error: { code: "import.slots_unfilled" } },
        // Final review I-4: the catch-all row. It carries no named fields, so
        // a page that fell through to `.generic` here would print the raw code
        // at the operator instead of a sentence.
        { fixture: "fx-9", status: "rejected", eventsAppended: 0, error: { code: "import.stream_failed" } },
      ],
    };
    net.response = REPORT;
    const island = renderIsland(ImportClient, BASE_PROPS);
    const submitted = JSON.stringify({ import_id: "imp-1", streams: [] });
    await setPastedAndSubmit(island, submitted);

    const text = island.text();
    expect(text).toContain(msg("eventImport.totals.summary", { imported: 1, skipped: 1, rejected: 8 }));
    expect(text).toContain(msg("eventImport.status.imported"));
    expect(text).toContain(msg("eventImport.status.skipped_duplicate"));
    expect(text).toContain(msg("eventImport.status.rejected"));

    // Fix wave (deferred finding 1): the Outcome column renders a localized
    // label for `kind`, never the raw payload or the entrant UUIDs inside it
    // (packages/engine's MatchOutcome) — this response can't resolve winner/
    // loser ids to names, and the row's own fixture link is where a human
    // goes for who won.
    expect(text).toContain(msg("eventImport.outcome.win"));
    expect(text).not.toContain(JSON.stringify(REPORT.results[0]!.outcome));
    expect(text).not.toContain("11111111-1111-4111-8111-111111111111");

    expect(text).toContain(msg("eventImport.error.fixture_started"));
    expect(text).toContain(msg("eventImport.error.fixture_unknown", { matches: 2 }));
    expect(text).toContain(
      msg("eventImport.error.fold_rejected", {
        eventRef: msg("eventImport.eventRef.withIndex", { eventIndex: 2 }),
        engineCode: "SEQ_CONFLICT",
      }),
    );
    expect(text).toContain(
      msg("eventImport.error.fold_rejected", {
        eventRef: msg("eventImport.eventRef.unknown"),
        engineCode: "WRONG_PHASE",
      }),
    );
    expect(text).toContain(msg("eventImport.error.not_decided"));
    expect(text).toContain(msg("eventImport.error.entitlement", { feature: "cricket.dls" }));
    expect(text).toContain(msg("eventImport.error.slots_unfilled"));
    expect(text).toContain(msg("eventImport.error.stream_failed"));
    // And it is a real sentence, not the generic fallback naming the code.
    expect(text).not.toContain(msg("eventImport.error.generic", { code: "import.stream_failed" }));

    // Fixture (linked): fx-1 resolves through fixtureNoById -> a real console link.
    const tree = island.tree();
    const link = tree.find(
      (e) => e.type === Link && propsOf(e).href === routes.fixture("riverside", "summer", "open", 3),
    );
    expect(link).toBeTruthy();
    expect(textOf(propsOf(link!).children as never)).toBe(msg("eventImport.table.fixtureLabel", { no: 3 }));

    // An unresolved reference (no entry in fixtureNoById) renders as plain
    // text — never a link to a fixture number this page cannot vouch for.
    expect(text).toContain("ext:unknown-1");

    // Re-running is the "show me that report again" path (design doc §7):
    // the textarea keeps exactly what was submitted.
    expect(propsOf(findTextarea(tree)).value).toBe(submitted);
  });
});

describe("ImportClient — Outcome column renders every MatchOutcome kind as a localized label (fix wave, deferred finding 1)", () => {
  it("localizes draw/tie/no_result/award, and falls back to the bare kind string for an unrecognised kind — never a UUID or the raw payload", async () => {
    const REPORT = {
      importId: "imp-2",
      totals: { imported: 6, skipped: 0, rejected: 0 },
      results: [
        { fixture: "fx-a", status: "imported", eventsAppended: 1, outcome: { kind: "draw" } },
        { fixture: "fx-b", status: "imported", eventsAppended: 1, outcome: { kind: "tie" } },
        { fixture: "fx-c", status: "imported", eventsAppended: 1, outcome: { kind: "no_result" } },
        {
          fixture: "fx-d",
          status: "imported",
          eventsAppended: 1,
          outcome: { kind: "award", winner: "33333333-3333-4333-8333-333333333333" },
        },
        { fixture: "fx-e", status: "imported", eventsAppended: 1, outcome: { kind: "future_kind_v9" } },
        // Final review (minor): an outcome object with NO `kind` at all. The
        // old fallback was `String(outcome)`, which renders the literal text
        // `[object Object]` — the raw payload leaking in the ugliest form
        // available, and the exact opposite of what this column promises.
        { fixture: "fx-f", status: "imported", eventsAppended: 1, outcome: { winner: "nobody" } },
      ],
    };
    net.response = REPORT;
    const island = renderIsland(ImportClient, BASE_PROPS);
    await setPastedAndSubmit(island, JSON.stringify({ import_id: "imp-2", streams: [] }));

    const text = island.text();
    expect(text).toContain(msg("eventImport.outcome.draw"));
    expect(text).toContain(msg("eventImport.outcome.tie"));
    expect(text).toContain(msg("eventImport.outcome.no_result"));
    expect(text).toContain(msg("eventImport.outcome.award"));
    // Defensive fallback: an unrecognised kind (e.g. a future engine
    // addition this page hasn't learned yet) renders the bare kind string,
    // never the raw payload.
    expect(text).toContain("future_kind_v9");
    expect(text).not.toContain("33333333-3333-4333-8333-333333333333");
    // A kind-less outcome renders nothing at all rather than `[object Object]`.
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain("nobody");
  });
});

describe("ImportClient — call-level rejections (no per-stream result exists at all)", () => {
  it("renders import.too_large as a banner with its cap/limit/actual interpolated", async () => {
    net.rejection = new ApiV1Error("too many streams", 413, "import.too_large", {
      cap: "streams",
      limit: 50,
      actual: 55,
    });
    const island = renderIsland(ImportClient, BASE_PROPS);
    await setPastedAndSubmit(island, JSON.stringify({ import_id: "x", streams: [] }));
    expect(island.text()).toContain(
      msg("eventImport.error.too_large", { capLabel: msg("eventImport.cap.streams"), actual: 55, limit: 50 }),
    );
  });

  it("renders import.concurrent with no extra fields", async () => {
    net.rejection = new ApiV1Error("locked", 409, "import.concurrent", {});
    const island = renderIsland(ImportClient, BASE_PROPS);
    await setPastedAndSubmit(island, JSON.stringify({ import_id: "x", streams: [] }));
    expect(island.text()).toContain(msg("eventImport.error.concurrent"));
  });

  // Both 402s arrive under the SAME transport code (http.ts:79/221), so the
  // only thing separating them is `feature`. The freeze became reachable from
  // this page when the importer started enforcing it alongside live scoring,
  // and it is not a "buy this feature" refusal — archiving a competition fixes
  // it, upgrading is merely the other option. Before this branch existed both
  // fell through to `.generic` and printed "Import failed (PAYMENT_REQUIRED).".
  it("renders the over-quota competition freeze as its own sentence, not a bare code", async () => {
    net.rejection = new ApiV1Error("Plan upgrade required: competitions.max_active", 402, "PAYMENT_REQUIRED", {
      feature: "competitions.max_active",
      feature_key: "competitions.max_active",
    });
    const island = renderIsland(ImportClient, BASE_PROPS);
    await setPastedAndSubmit(island, JSON.stringify({ import_id: "x", streams: [] }));
    expect(island.text()).toContain(msg("eventImport.error.competition_frozen"));
    expect(island.text()).not.toContain(msg("eventImport.error.generic", { code: "PAYMENT_REQUIRED" }));
  });

  it("renders any OTHER call-level 402 as the named-feature entitlement sentence", async () => {
    net.rejection = new ApiV1Error("Plan upgrade required: import.events", 402, "PAYMENT_REQUIRED", {
      feature: "import.events",
      feature_key: "import.events",
    });
    const island = renderIsland(ImportClient, BASE_PROPS);
    await setPastedAndSubmit(island, JSON.stringify({ import_id: "x", streams: [] }));
    expect(island.text()).toContain(msg("eventImport.error.entitlement", { feature: "import.events" }));
  });

  it("renders import.division_not_started with the division's status interpolated", async () => {
    net.rejection = new ApiV1Error("not started", 409, "import.division_not_started", {
      divisionStatus: "scheduled",
    });
    const island = renderIsland(ImportClient, BASE_PROPS);
    await setPastedAndSubmit(island, JSON.stringify({ import_id: "x", streams: [] }));
    expect(island.text()).toContain(msg("eventImport.error.division_not_started", { divisionStatus: "scheduled" }));
  });

  it("falls back to the generic message for an unlisted code, naming the raw code", async () => {
    net.rejection = new ApiV1Error("boom", 500, "INTERNAL", {});
    const island = renderIsland(ImportClient, BASE_PROPS);
    await setPastedAndSubmit(island, JSON.stringify({ import_id: "x", streams: [] }));
    expect(island.text()).toContain(msg("eventImport.error.generic", { code: "INTERNAL" }));
  });

  it("routes a non-ApiV1Error (a transport failure) through the localized generic error key, never the raw English message unwrapped", async () => {
    net.rejection = new Error("Failed to fetch");
    const island = renderIsland(ImportClient, BASE_PROPS);
    await setPastedAndSubmit(island, JSON.stringify({ import_id: "x", streams: [] }));
    expect(island.text()).toContain(msg("eventImport.error.generic", { code: "Failed to fetch" }));
  });
});
