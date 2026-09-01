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
// R7 demolished the legacy/universal pad lane (pad-renderer.tsx and friends)
// once the last sport (carrom) converted to v3, so the three checks that used
// to diff against `pad-renderer.tsx`'s own source now pin the v3 host's
// behaviour directly instead of comparing it to a legacy file that no longer
// exists. The chassis is still shared across every sport, so a capability
// lost here is still lost for all of them.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const V3 = join(HERE, "..");

const padHost = readFileSync(join(V3, "pad-host.tsx"), "utf8");
const activity = readFileSync(join(V3, "activity.tsx"), "utf8");

describe("legacy parity — capabilities the v3 chassis must not lose", () => {
  it("1a. mounts an event-history panel", () => {
    // Anchored on a JSX boundary, not a bare substring: `toContain
    // ("<ActivityPanel")` still passes against `<ActivityPanelREMOVED`, which
    // is precisely the vacuous assertion this programme keeps shipping. Found
    // by mutating this file's own subject and watching the test stay green.
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

// R7-46 — the same class as capability 1 above, one wave later, and this time
// the LOSS was introduced by the fix for something else.
//
// R7/C1 consolidated the ledger: the organiser console stopped letting the pad
// render its own `<ActivityPanel>` (`hideActivity`) and mounted the same
// component itself, one level out, with void authority and the audit strip.
// R7-42/F then added the partial-answer badge — "a rally settled without its
// dock answer is labelled partial wherever the stat surfaces" — and wired it
// on `PadHostV3`'s panel, with a comment at the call site that says, in as
// many words, that wiring it there rather than merely building it is what
// stops the helper being inert.
//
// It was inert anyway, on the console. That panel is the one the pad
// SUPPRESSES, so the badge shipped working on `/score/[token]` and missing on
// the organiser's own screen — the surface whose entire job is telling an
// organiser what the courtside scorer left incomplete. A green suite, a clean
// typecheck and a call-site comment warning about this exact defect all held
// while it was true.
//
// So the guard is TOTAL over mount sites rather than pinned to one file: every
// `<ActivityPanel>` in production source must be handed `isPartial`, and the
// set of files mounting one is pinned so a third mount cannot appear
// unguarded.
describe("R7-46: EVERY ActivityPanel mount is handed the partial-answer predicate", () => {
  const V2 = join(V3, "..", "..");
  const fixtureConsole = readFileSync(join(V2, "fixture-console.tsx"), "utf8");

  /** REAL JSX mounts only. Both files discuss `<ActivityPanel>` at length in
   *  prose — the first draft of this guard matched a sentence in a comment and
   *  reported a defect that was not there, which is the same "a grep is not a
   *  read" trap the programme keeps re-learning. A mount is the element name
   *  followed by a newline (prose writes `<ActivityPanel>` closed on the spot)
   *  and it always passes `events=`. */
  const mountsIn = (src: string): string[] =>
    (src.match(/<ActivityPanel\r?\n[\s\S]*?\n\s*\/>/g) ?? []).filter((m) => /\bevents=/.test(m));

  it("both mount sites pass isPartial — the pad's own, and the console's consolidated one", () => {
    for (const [name, src] of [
      ["pad-host.tsx", padHost],
      ["fixture-console.tsx", fixtureConsole],
    ] as const) {
      const mounts = mountsIn(src);
      expect(mounts.length, `${name} mounts no <ActivityPanel> at all`).toBeGreaterThan(0);
      for (const mount of mounts) {
        expect(mount, `${name} mounts an <ActivityPanel> with no isPartial prop`).toMatch(/\bisPartial=/);
      }
    }
  });

  it("the console's predicate is the PAD's, handed up — never a second PadHostView built console-side", () => {
    // The alternative repair was for the console to assemble its own
    // `PadHostView` from `live.state` + cfg + lineups and call
    // `isPartialDockAnswer` directly. `fixture-console.tsx`'s own R7-28
    // comment records what that costs: the last time this bag was built
    // twice, `plural` reached one site only and the same rally read "1 pt"
    // in the pad's ribbon and "1 pts" in the console's ledger, on one
    // screen. So the console must NOT name the predicate's engine-side
    // entry point at all — it receives a closure the pad already built.
    expect(fixtureConsole).not.toContain("isPartialDockAnswer");
    expect(fixtureConsole).toContain("onPartialResolver=");
    // …and the pad must actually publish it, not merely accept the prop.
    expect(padHost).toMatch(/publishPartial\?\.\(isPartial\)/);
  });

  it("only those two files mount an ActivityPanel — a third would be unguarded by the check above", () => {
    // Pinned rather than globbed: the check above can only be total if the
    // list of files it reads is itself total. A new mount site reds here
    // first, which is the prompt to add it above.
    const componentsDir = join(V2, "..");
    const mounting: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue;
          walk(full);
        } else if (entry.name.endsWith(".tsx") && mountsIn(readFileSync(full, "utf8")).length > 0) {
          mounting.push(entry.name);
        }
      }
    };
    walk(componentsDir);
    expect(mounting.sort()).toEqual(["fixture-console.tsx", "pad-host.tsx"]);
  });
});
