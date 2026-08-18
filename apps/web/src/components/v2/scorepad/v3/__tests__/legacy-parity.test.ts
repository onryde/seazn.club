// THE GATE THIS PROGRAMME WAS MISSING.
//
// R2 flipped cricket from the legacy pad onto the v3 chassis, and three
// capabilities the legacy surface had were silently dropped. All three shipped
// past 8155 unit tests, 300 v3 tests, a seven-width e2e matrix and a
// twelve-sport gallery capture, because every one of those gates asks "does v3
// work?" and none asks "did v3 LOSE anything?".
//
// The three (all found by the owner reading the sign-off sheet, not by CI):
//
//   1. Event history + per-event void. `pad-renderer.tsx` mounts <Timeline>
//      INSIDE the pad, so both reached the device-link surface, which has no
//      console chrome to fall back on. v3 had a one-line ribbon and an undo
//      wired solely to `latestEvent.id`.
//   2. Fidelity-band gating of tiles. v3 rendered every tile at every band, so
//      an unentitled org tapped ball tiles that the server refused.
//   3. The fold's result headline (`summaryHeadline`, pad-renderer.tsx:192).
//      On a TIE that headline IS the outcome; v3 showed two equal scores and
//      no verdict.
//
// This file asserts the v3 host still SOURCES each capability. It is
// deliberately a source-level check rather than a render test: apps/web vitest
// is environment:"node", and the failure mode being guarded against is
// "the wiring was never written", which a source check catches at the exact
// point the capability is dropped.
//
// When a later wave converts football/tennis/etc., this test protects them
// too — the chassis is shared, so a capability lost here is lost for all.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const V3 = join(HERE, "..");
const LEGACY = join(HERE, "..", "..");

const padHost = readFileSync(join(V3, "pad-host.tsx"), "utf8");
const activity = readFileSync(join(V3, "activity.tsx"), "utf8");
const padRenderer = readFileSync(join(LEGACY, "pad-renderer.tsx"), "utf8");

describe("legacy parity — capabilities the v3 chassis must not lose", () => {
  it("1a. mounts an event-history panel, as the legacy pad mounts <Timeline>", () => {
    // Anchored on a JSX boundary, not a bare substring: `toContain
    // ("<ActivityPanel")` still passes against `<ActivityPanelREMOVED`, which
    // is precisely the vacuous assertion this programme keeps shipping. Found
    // by mutating this file's own subject and watching the test stay green.
    expect(padRenderer).toMatch(/<Timeline[\s/>]/);
    expect(padHost).toMatch(/<ActivityPanel[\s/>]/);
  });

  it("1b. offers per-event void, not only undo-the-last-event", () => {
    // The regression shape: undo existed but had ONE call site passing the
    // latest event, so nothing older could ever be corrected.
    expect(padHost).toContain("onVoid=");
    expect(activity).toContain("core.void");
    // The panel must hand a specific row's id to the handler.
    expect(activity).toContain("onVoid?.(event.id)");
  });

  it("1c. honours 'a device link may only void its OWN events'", () => {
    expect(padRenderer).toContain("device_link_id");
    expect(activity).toContain("ownEventIds");
    expect(activity).toContain("deviceLinkId === null");
  });

  it("2. filters tiles by the org's entitled fidelity band", () => {
    expect(padHost).toContain("filterTilesByBand");
    // Applied to what the phase machinery sees, not merely computed: a filter
    // whose result is never used is the exact inert-seam failure this
    // programme keeps hitting.
    expect(padHost).toMatch(/phasesWithTiles\(tiles\)/);
  });

  it("3. surfaces the fold's own result headline, so a TIE is stated rather than inferred", () => {
    expect(padRenderer).toContain("summaryHeadline(");
    expect(padHost).toContain("summaryHeadline(");
    // Reused from the legacy view-model rather than reimplemented, so the two
    // readers cannot drift apart.
    expect(padHost).toMatch(/import \{[^}]*summaryHeadline[^}]*\} from "\.\.\/view-model"/);
    expect(padHost).toContain('data-role="v3-headline"');
  });

  it("3b. the skin's per-event detail is WIRED, not merely exported", () => {
    // D2's helper (`cricketBallDetail`) shipped with 9 passing unit tests
    // while nothing passed it to the panel, so every activity row still read
    // "Ball recorded" in the product. Unit tests cannot see that gap: they
    // call the function directly. Assert the whole chain instead.
    const cricket = readFileSync(join(V3, "skins", "cricket.tsx"), "utf8");
    const types = readFileSync(join(V3, "types.ts"), "utf8");
    expect(types).toContain("activityDetail?(");            // the contract exists
    expect(cricket).toContain("activityDetail: cricketBallDetail"); // the skin declares it
    expect(padHost).toContain("resolveDetail=");             // the host passes it
    expect(padHost).toContain("props.skin.activityDetail");  // ...from the skin, not a direct import
    expect(activity).toContain("resolveDetail");             // the panel consumes it
  });

  it("4. every restored capability is actually RENDERED, not just imported", () => {
    // Each of the three regressions passed its own unit tests while being
    // invisible on screen. Pin the render markers.
    for (const marker of ['data-role="v3-activity-slot"', 'data-role="v3-headline"']) {
      expect(padHost).toContain(marker);
    }
  });

  it("5. over-by-over entry (R2b) is wired end to end: sheet key resolves, ribbon copy is registered", () => {
    // The tile's sheet key must resolve to a REAL builder in buildSheets, not
    // a typo'd or forgotten entry — the exact "unit-tested function nothing
    // calls" shape 3b guards against, one level down: a dangling sheet key
    // opens on an empty wizard with no visible failure anywhere in this
    // chassis.
    const cricket = readFileSync(join(V3, "skins", "cricket.tsx"), "utf8");
    expect(cricket).toMatch(/action:\s*\{\s*sheet:\s*"overSummary"\s*\}/);
    expect(cricket).toMatch(/overSummary:\s*overSummarySheet\(view\)/);
    // ribbon.ts gates its per-sport lookup on PAD_LABEL_KEYS membership
    // BEFORE calling padLabel() — a ribbon key present only in the
    // dictionaries (not here) silently stays on the generic "{event}
    // recorded" fallback forever, with nothing failing (R1's own standing
    // item, restated for R2b in the plan/_INDEX.md).
    const scoringVocab = readFileSync(
      join(HERE, "..", "..", "..", "..", "..", "lib", "scoring-vocab.ts"),
      "utf8",
    );
    expect(scoringVocab).toContain('"pad.cricket.ribbon.innings.summary"');
  });

  it("6. the bowler-changed activity note resolves a NAME, not a raw id — personNames is forwarded from host to skin", () => {
    // Same shape as 3b's own gap: `cricketBallDetail` shipping a
    // `personNames` field with passing unit tests proves nothing about
    // the product if `pad-host.tsx`'s own call site never forwards the real
    // map — exactly the "unit-tested function nothing calls" defect 3b
    // exists to catch, one field over.
    const cricket = readFileSync(join(V3, "skins", "cricket.tsx"), "utf8");
    const types = readFileSync(join(V3, "types.ts"), "utf8");
    // R2b-cricket-over review fix (item 1): `activityDetail` now takes a
    // single `ActivityDetailContext` object (types.ts) instead of seven
    // positional parameters — updated below to match. `personNames` is
    // part of THAT object's own contract, not a positional parameter of
    // `activityDetail` itself any more.
    expect(types).toContain("interface ActivityDetailContext"); // the dedicated context type exists
    expect(types).toMatch(/activityDetail\?\(ctx: ActivityDetailContext\)/); // the method takes it
    expect(types).toMatch(/interface ActivityDetailContext \{[\s\S]*?personNames\?:/); // …and personNames is part of that contract
    expect(cricket).toMatch(/function cricketBallDetail\(ctx: ActivityDetailContext\)/); // the skin reads the same object shape
    expect(cricket).toContain("personNames"); // …and destructures personNames from it
    // The host's own resolveDetail closure must build the context object
    // with personNames alongside cfg — not merely have it in scope
    // (props.personNames is read for the ribbon and the ActivityPanel prop
    // too; only the activityDetail call site proves THIS feature is wired).
    expect(padHost).toMatch(/activityDetail!\(\{[\s\S]*?\bt,[\s\S]*?\beventType,[\s\S]*?\bpayload,[\s\S]*?\bhistory,[\s\S]*?cfg:\s*view\.cfg,[\s\S]*?\bpersonNames[\s\S]*?\}\)/);
  });
});
