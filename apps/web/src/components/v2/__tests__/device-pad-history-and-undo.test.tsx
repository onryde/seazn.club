// R7 / Task C, C1 + C4 — the two claims that can only be proved on the
// DEVICE-LINK surface, driven through the real chain
// (`DeviceScorePad` -> `ScorePad` -> `PadHostV3` -> the real football skin
// -> the real engine fold), never through a fixture on both ends.
//
// C1 (the regression this consolidation can cause). `fixture-console.tsx`'s
// own page-level "Event ledger" is DELETED in this wave and `v3/activity.tsx`
// becomes the one renderer. `/score/[token]` has no page chrome at all, so
// that panel is the ONLY history a courtside scorer ever sees: if the merge
// took the panel with it, nothing on the device link would notice, because
// no console test mounts this route. Hence a test on THIS surface.
//
// C4 (ruling R7-5, the open item the design of record left to verify). The
// ribbon's undo used to target `events[events.length - 1]` UNFILTERED
// (pad-host.tsx), while the console's own "Undo last" skipped `core.void`
// rows. After ANY void the newest event IS a `core.void`, so the ribbon
// offered a control the engine hard-refuses — `resolveVoids`
// (packages/engine/src/core/events.ts) throws INVALID_EVENT "voids are not
// themselves voidable". That is the pad offering exactly what the engine
// will refuse: the defect class the v3 programme exists to remove.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventEnvelope } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { DeviceScorePad } from "@/components/v2/device-score-pad";
import type { LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";

const football = builtinModules.find((m) => m.key === "football")!;

const sport: SportInfo = {
  key: "football",
  config: {},
  scorerLabel: "Referee",
  positionGroups: [],
  roles: [],
  lineupSize: 11,
  benchMax: 5,
  fidelityTiers: football.fidelityTiers as SportInfo["fidelityTiers"],
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

const live: LiveState = {
  status: "in_play",
  last_seq: 3,
  summary: { headline: "1 — 0" },
  state: {},
  outcome: null,
};

function envelope(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  voids?: string,
): EventEnvelope {
  return {
    id: `ev-${seq}`,
    fixtureId: "f1",
    seq,
    type,
    payload,
    recordedAt: `2026-08-30T10:0${seq}:00.000Z`,
    recordedBy: "user-1",
    ...(voids === undefined ? {} : { voids }),
  };
}

/** The variant football's own e2e uses; parsed through the module's real
 *  schema so the pad folds against a cfg the engine accepts, not a literal. */
const CFG = football.configSchema.parse(
  (football.variants as Record<string, unknown> | undefined)?.["11-a-side"] ?? {},
);

function deviceHtml(events: readonly EventEnvelope[]): string {
  return renderToStaticMarkup(
    <DeviceScorePad
      token="dl_test"
      deviceLinkId="link-1"
      fixture={{
        id: "f1",
        round_no: 1,
        venue: null,
        court_label: null,
        competition_name: "Summer League",
        division_name: "Men's XI",
      }}
      sport={sport}
      home={side("e-home", "Riverside FC")}
      away={side("e-away", "Summit Athletic")}
      initialState={live}
      initialEvents={[]}
      scorePadV2={{
        moduleVersion: football.version,
        resolvedConfig: CFG,
        initialEvents: events,
        entitlements: {},
        band: 3,
        identity: { recordedBy: null, deviceLinkId: "link-1" },
      }}
    />,
  );
}

const START = envelope(1, "core.start", {});
const GOAL = envelope(2, "football.goal", { by: "e-home" });

describe("device link — the only history a courtside scorer sees (C1)", () => {
  it("still renders the activity ledger, with a row per recorded event", () => {
    const html = deviceHtml([START, GOAL]);

    expect(html, 'the pad-side panel is the device link\'s ONLY history surface').toContain(
      'data-role="v3-activity"',
    );
    // Two rows, not "a panel that rendered empty": the count chip and the
    // per-row markers both have to move with the ledger.
    expect(html.match(/data-role="v3-activity-row"/g) ?? []).toHaveLength(2);
    expect(html).toContain('data-event-id="ev-2"');
    expect(html).toContain('data-event-id="ev-1"');
  });
});

describe("ribbon undo cannot target a void (C4, ruling R7-5)", () => {
  // R7/C review fix #2. C4 said the ribbon applies "deliberately the SAME
  // rule the console applies" — and it did, on BOTH surfaces, which is the
  // bug: this one is not the console. `ownEventIds` holds only what THIS
  // mount submitted ("an event loaded from `initialEvents` is never in this
  // set — honestly unknown, never a guess", use-pad-pipeline.ts), and the
  // server refuses anything else outright: "A device link can only undo its
  // own events", 403 (server/usecases/scoring.ts). So a courtside scorer
  // whose newest row came from the console — or from before their last
  // reload — was offered a control that could only fail, while the panel one
  // line below had already hidden Void for that very row.
  //
  // The positive half of this rule is NOT assertable here and that is a fact
  // about the surface, not a gap: nothing rendered server-side can put an id
  // into `ownEventIds`. It is pinned twice instead — on the console's own
  // real render ("the console's ribbon still offers Take back",
  // fixture-console-one-ledger.test.tsx) and over the whole rule table
  // (`ribbonUndoTarget`, scorepad/v3/__tests__/pad-host.test.ts).
  it("withdraws undo for a row this device did not record — the server would 403", () => {
    const html = deviceHtml([START, GOAL]);

    // The strip itself still renders, so the absence below is the RULE and
    // not a missing ribbon.
    expect(html).toContain('data-role="v3-ribbon"');
    expect(
      html,
      "these rows arrived as server history, so this device cannot void them",
    ).not.toContain('data-role="v3-ribbon-undo"');
    // ...and the panel one line below agrees about the same rows — which is
    // the whole point: two controls that both write `core.void` on one screen
    // must not disagree.
    expect(html).not.toContain('data-role="v3-activity-void"');
  });

  it("withdraws undo once the newest event is itself a core.void", () => {
    const html = deviceHtml([START, GOAL, envelope(3, "core.void", {}, GOAL.id)]);

    // The strip still SAYS what happened — losing the last-event line would
    // be a different regression.
    expect(html).toContain('data-role="v3-ribbon"');
    expect(
      html,
      "the engine refuses to void a void (resolveVoids: 'voids are not themselves voidable'), so the pad must not offer it",
    ).not.toContain('data-role="v3-ribbon-undo"');
  });
});
