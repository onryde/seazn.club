// Regression (v4 Task 13 review): the AI diff panel's blocking rows used to
// render the engine verifier's raw English (`c.detail || c.reason`), leaking
// English into fr/es/nl. They must localize through the board's shared
// `board.conflict.*` labels — mapping the engine reason token to its API code
// via the ONE REASON_CODE table — with the raw `detail` demoted to muted
// supplementary text. These pin the reason→dict-key helper and assert the
// rendered panel shows the localized label, never the raw engine string.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AiDiffPanel } from "../ai-diff-panel";
import { blockingConflictCode, blockingConflictKey, type AiConsoleFixture } from "../ai-diff";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";

const enDict = en as Record<string, string>;
const frDict = fr as Record<string, string>;

describe("blockingConflict* (reason → shared board.conflict.* labels)", () => {
  it("maps an engine reason token to its API code and dict key", () => {
    // court and (direct) order are the only reasons schedule-ai marks blocking.
    expect(blockingConflictCode("court")).toBe("conflict.court");
    expect(blockingConflictKey("court")).toBe("board.conflict.conflict.court");
    expect(blockingConflictCode("order")).toBe("warn.order");
    expect(blockingConflictKey("order")).toBe("board.conflict.warn.order");
  });

  it.each(["court", "order"])(
    "resolves a real localized label for blocking reason %s (never the raw token/key)",
    (reason) => {
      const key = blockingConflictKey(reason);
      for (const dict of [enDict, frDict]) {
        const label = dict[key];
        expect(label, `missing ${key}`).toBeTruthy();
        expect(label).not.toBe(key); // key is actually present in the catalog
        expect(label).not.toBe(reason); // not the raw engine token
      }
    },
  );

  it("falls an unmapped token through as its own pseudo-code (panel then uses its localized fallback, not the raw detail)", () => {
    expect(blockingConflictCode("totally_unknown")).toBe("totally_unknown");
    expect(blockingConflictKey("totally_unknown")).toBe("board.conflict.totally_unknown");
  });
});

const FIX = "11111111-1111-1111-1111-111111111111";
// One blocking row carrying the engine's raw camelCase reason + structured
// detail (C3, 2026-08-13 design amendment). `court_double_booking` with no
// `otherFixtureId` is the reportability-fallback branch
// (calendar.ts:1384) — the ".unknown" localized variant.
//
// `court` is a real courts.id uuid on the wire (P9 review wave 3, finding
// #3) — this fixture used to write the bare string "Court 1" here as if it
// were still a name, which happened to "work" only because
// conflict-detail-format.ts used to interpolate `court` verbatim. P9 review
// wave 3's fix made that read `courtName` instead (server-resolved,
// venue-qualified) — and `AiPlanConflictDetail` (this schema, unlike
// `ScheduleConflictDetail`) has NO `courtName` field at all: schedule-ai.ts's
// own `blocking: result.blocking.map(withLegacyDetail)` never calls
// `attachCourtNames` first, unlike person-merge.ts's conflicts path, which
// already does (`conflicts.map((c) => withLegacyDetail(attachCourtNames(c,
// courtNames)))`). So an AI-plan blocking court conflict genuinely has no
// resolved name to show today — this fixture now uses a real uuid to be
// honest about that, and the expectations below assert the safe degrade
// (never the raw id) rather than a name this path cannot actually produce
// yet. Flagged as a real, separate gap — out of this pass's scope (server
// usecase, not a board/console file).
const COURT_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const plan: AiPlanResponse = {
  proposal: [],
  unschedulable: [],
  warnings: [],
  blocking: [{ fixtureId: FIX, reason: "court", details: { kind: "court_double_booking", court: COURT_UUID } }],
  diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "Kept the court clear.",
  // W5 (#400): the architect's own assumptions, always an array.
  assumptions: [],
  usage: { input_tokens: 10, output_tokens: 5, repair_rounds: 0 },
  repair: { engine: "none" as const, solver_ran: false },
  officials_coverage: null,
};
const fixtures: AiConsoleFixture[] = [
  { id: FIX, stage_id: "st-1", scheduled_at: null, court_label: null, code: "SF1", matchup: "A vs B", isFinal: false, isJunior: false, status: "scheduled", home_entrant_id: "en-a", away_entrant_id: "en-b" },
];

function renderPanel(dict: Record<string, string>, locale: Locale): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict as unknown as Dict} locale={locale}>
      <AiDiffPanel plan={plan} fixtures={fixtures} excluded={[]} onToggleExclude={() => {}} />
    </DictProvider>,
  );
}

describe("AiDiffPanel blocking row localization", () => {
  it("renders the localized conflict label as the primary text (en)", () => {
    const html = renderPanel(enDict, "en");
    expect(html).toContain(enDict["board.conflict.conflict.court"]); // "court clash"
  });

  it("localizes the primary into fr — not the raw engine string", () => {
    const html = renderPanel(frDict, "fr");
    // The fr label proves the row no longer prints raw English as primary; a
    // revert to `c.detail || c.reason` would drop this and print the detail.
    expect(html).toContain(frDict["board.conflict.conflict.court"]); // "conflit de court"
    expect(frDict["board.conflict.conflict.court"]).not.toBe(
      enDict["board.conflict.conflict.court"],
    );
  });

  it("localizes the structured detail as supplementary text — never the raw engine string (C3, 2026-08-13 design amendment)", () => {
    const html = renderPanel(enDict, "en");
    // No courtName on this wire shape (see the fixture's own comment above) —
    // the safe degrade, never the raw uuid.
    const expected = (enDict["board.conflict.detail.court_double_booking.unknown"] as string).replace(
      "{court}",
      enDict["courtPicker.unknownCourt"] as string,
    );
    expect(html).toContain(expected);
    expect(html).not.toContain(COURT_UUID);
    // Non-vacuity: the deprecated raw shape is gone from this row entirely,
    // not merely absent from the assertion.
    expect(html).not.toContain("court Court 1 double-booked");
  });

  it("localizes the supplementary detail text into fr too — not only the primary label", () => {
    // Regression guard for `c.detail || c.reason` sneaking back in
    // (the file header's own past-tense warning): this pins that the
    // SUPPLEMENTARY line changes language exactly as the primary label does.
    const html = renderPanel(frDict, "fr");
    const expected = (frDict["board.conflict.detail.court_double_booking.unknown"] as string).replace(
      "{court}",
      frDict["courtPicker.unknownCourt"] as string,
    );
    expect(html).toContain(expected);
    expect(html).not.toContain(COURT_UUID);
    expect(frDict["board.conflict.detail.court_double_booking.unknown"]).not.toBe(
      enDict["board.conflict.detail.court_double_booking.unknown"],
    );
  });
});
