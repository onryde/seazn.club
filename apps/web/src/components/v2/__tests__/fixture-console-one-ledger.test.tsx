// R7 / Task C, C1 (D-4, ruling R7-1) — ONE audit ledger.
//
// A live v3 console rendered THREE history surfaces, and the register's
// "renders twice" was wrong about all of it: they were not duplicates. The
// pad's `v3/activity.tsx` wrote plain sentences that NAME PEOPLE and offered
// Void; the page's hand-rolled `<ul>` in `fixture-console.tsx` carried #seq,
// the timestamp, WHO RECORDED each row and the audit controls. Deleting
// either lost something real, which is why the row survived five waves.
//
// So the consolidation is a MERGE. `v3/activity.tsx` is the one renderer and
// GAINS the page panel's provenance; the console mounts it with authority
// (void rights, provenance, the audit strip) and the device link mounts the
// same component without them — see
// `device-pad-history-and-undo.test.tsx`, which is the other half of this
// claim and the regression this consolidation could have caused.
//
// WHICH panel survives is forced, not preferred: `/score/[token]` has no page
// chrome at all, so the pad's panel is the only history a courtside scorer
// ever sees.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const football = builtinModules.find((m) => m.key === "football")!;
const CFG = football.configSchema.parse(
  (football.variants as Record<string, unknown> | undefined)?.["11-a-side"] ?? {},
);

const sport: SportInfo = {
  key: "football",
  config: {},
  scorerLabel: "Referee",
  positionGroups: [],
  roles: [],
  lineupSize: 11,
  benchMax: 5,
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

const ROWS: EventIn[] = [
  {
    id: "ev-1",
    seq: 1,
    type: "core.start",
    payload: {},
    recorded_at: "2026-08-30T10:01:00.000Z",
    recorded_by: "user-1",
    voids_event_id: null,
    device_link_id: null,
  },
  {
    id: "ev-2",
    seq: 2,
    type: "football.goal",
    payload: { by: "e-home" },
    recorded_at: "2026-08-30T10:05:00.000Z",
    recorded_by: null,
    voids_event_id: null,
    device_link_id: "link-9",
  },
];

const ENVELOPES: readonly EventEnvelope[] = ROWS.map((r) => ({
  id: r.id,
  fixtureId: "f1",
  seq: r.seq,
  type: r.type,
  payload: r.payload,
  recordedAt: r.recorded_at,
  recordedBy: r.recorded_by ?? null,
}));

function consoleHtml(over: {
  status?: string;
  outcome?: unknown;
  audit?: { verified: boolean; tamperedSeq: number | null; entitled: boolean } | null;
} = {}): string {
  const status = over.status ?? "in_play";
  const live: LiveState = {
    status,
    last_seq: 2,
    summary: { headline: "1 — 0" },
    state: {},
    outcome: over.outcome ?? null,
  };
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{
        id: "f1",
        status,
        scheduled_at: null,
        venue_name: null,
        court_name: null,
        round_no: 1,
      }}
      sport={sport}
      home={side("e-home", "Riverside FC")}
      away={side("e-away", "Summit Athletic")}
      initialState={live}
      initialEvents={ROWS}
      canEdit
      recorderNames={{ "user-1": "Dana Okafor" }}
      audit={over.audit === undefined ? { verified: true, tamperedSeq: null, entitled: true } : over.audit}
      scorePadV2={{
        moduleVersion: football.version,
        resolvedConfig: CFG,
        initialEvents: ENVELOPES,
        entitlements: {},
        identity: { recordedBy: "user-1", deviceLinkId: null },
      }}
    />,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("the console renders ONE ledger (D-4)", () => {
  it("mounts a single activity panel even while the pad is on screen", () => {
    const html = consoleHtml();
    expect(
      count(html, 'data-role="v3-activity"'),
      "the pad used to mount its own panel while the page rendered a second one",
    ).toBe(1);
    // The page panel's own container is gone with it. `overflow-hidden` on an
    // ancestor of the pad is separately forbidden this wave (it clips the 2px
    // ::before bleed the 44px floor on 40px minor tiles rides on).
    expect(html).not.toContain('class="card overflow-hidden"');
  });

  it("keeps the page panel's provenance — #seq, the time and who recorded it", () => {
    const html = consoleHtml();
    expect(html, "sequence numbers came from the deleted page panel").toContain(
      'data-role="v3-activity-seq"',
    );
    expect(html, "so did recorded-by attribution").toContain('data-role="v3-activity-provenance"');
    expect(html, "a signed-in recorder shows by name").toContain("Dana Okafor");
    // A device-link row has no user to name — it is the handed device, and the
    // page panel said so in the scorer's own vocabulary.
    expect(html).toContain("Courtside referee pad");
  });

  it("carries the audit controls, which only the authority mount gets", () => {
    expect(consoleHtml()).toContain('data-testid="audit-strip"');
    expect(
      consoleHtml({ audit: null }),
      "a fixture with nothing to audit renders no strip",
    ).not.toContain('data-testid="audit-strip"');
  });

  // R7/C review fix #2 — the DISCRIMINATING half of the device link's own
  // negatives (device-pad-history-and-undo.test.tsx). `ribbonUndoTarget` now
  // delegates to `activityRowState` with `authority` following the surface,
  // so the console — which owns the whole ledger — must keep offering Take
  // back for exactly the rows whose Void it offers. Without this case, that
  // file's `not.toContain('v3-ribbon-undo')` would still pass with the
  // control deleted outright.
  it("still offers the ribbon's Take back, for a row nobody on this device recorded", () => {
    const html = consoleHtml();
    expect(html).toContain('data-role="v3-ribbon"');
    expect(
      html,
      "ev-2 came from a device link and the console never submitted it — the console owns it anyway",
    ).toContain('data-role="v3-ribbon-undo"');
    // The ledger beside it says the same thing about the same row.
    expect(html).toContain('data-role="v3-activity-void"');
  });

  it("still shows history once the fixture is over and the pad has unmounted", () => {
    // `scorePadV2 && scoring && !decided` unmounts the pad on a decided
    // fixture, and the page panel used to be the only thing left saying what
    // happened. The merged panel must outlive the pad, not travel with it.
    const html = consoleHtml({ status: "finalized", outcome: { kind: "win", winner: "e-home" } });
    expect(html).not.toContain('data-testid="score-pad"');
    expect(count(html, 'data-role="v3-activity"')).toBe(1);
    expect(count(html, 'data-role="v3-activity-row"')).toBe(2);
  });
});
