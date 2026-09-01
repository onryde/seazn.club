import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceScorePad } from "@/components/v2/device-score-pad";
import type { LiveState, SportInfo, SideInfo } from "@/components/v2/fixture-console";

// Courtside-pad mobile fixes (user report, 12 Jul): set-score headlines used
// to wrap mid-number at phone widths, and the rally target read as a text
// link. These pin the render contract; interaction stays with e2e.
//
// S13/#422 W11 cutover: this file used to ALSO render v1's `SetbasedPad`
// (deleted this session) directly to pin two of its own properties — a
// 44px+ touch target on the rally card, and dictionary-driven (not
// hardcoded English) chrome. Removed rather than re-pinned: v1's specific
// implementation (a `touch-manipulation` class, `bg-purple-600`, a literal
// "+ point" string, its own `pad.*` dictionary keys) has no v2 equivalent to
// point at — the replacement is the shared, per-skin `ActionForm`-driven
// rendering every scoring skin now uses (badminton's own skin, in v3, since
// R5). The two PROPERTIES those tests were really guarding — a real tap target
// and real i18n, not the specific class/key names — are structural
// guarantees of the shared chassis now: `action-form.tsx`'s own primary
// action button is `h-14` (56px, well past the 44px bar), and every skin
// resolves its copy through `useMsg()` against the real dictionaries, which
// this repo's `i18n:check` gate enforces independently of any one pad.

const sport: SportInfo = {
  key: "badminton",
  config: {},
  scorerLabel: "Umpire",
  positionGroups: [],
  roles: [],
  lineupSize: 2,
  benchMax: 1,
  fidelityTiers: [
    { tier: 3, eventTypes: ["badminton.rally"] },
    { tier: 0, eventTypes: ["badminton.game_summary"] },
  ] as SportInfo["fidelityTiers"],
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

const live: LiveState = {
  status: "in_play",
  last_seq: 7,
  summary: { headline: "1 — 0 · 21-18 (16-12)" },
  state: {
    phase: "set",
    sets: [
      { home: 21, away: 18, closed: true },
      { home: 16, away: 12, closed: false },
    ],
    setsWon: { home: 1, away: 0 },
    cfg: { bestOf: 3 },
  },
  outcome: null,
};

describe("device score pad on phones", () => {
  it("headline groups are atomic — wrap only between ' · ' groups, fluid size", () => {
    const html = renderToStaticMarkup(
      <DeviceScorePad
        token="dl_test"
        deviceLinkId="link-1"
        fixture={{
          id: "f1",
          round_no: 2,
          venue: null,
          court_label: "Court 2",
          competition_name: "Summer League",
          division_name: "Badminton Doubles",
        }}
        sport={sport}
        home={side("h", "Nia & Marco")}
        away={side("a", "Mira & Josh")}
        initialState={live}
        initialEvents={[]}
      />,
    );
    expect(html).toContain('<span class="inline-block whitespace-nowrap">1 — 0');
    expect(html).toContain('<span class="inline-block whitespace-nowrap">21-18 (16-12)</span>');
    // The old fixed-size headline ("text-5xl font-bold") died with the wrap
    // bug — fluid clamp instead. (Rally cards keep a plain text-5xl numeral.)
    expect(html).not.toContain("text-5xl font-bold");
    expect(html).toContain("clamp(1.5rem,8.5vw,3rem)");
  });
});
