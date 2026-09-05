// R3.5/Task O — the decided sentence has to update on a LIVE poll, not only
// when the whole page (and this component) is freshly mounted with the
// final props: mounting a FRESH `LiveScore` with an already-decided
// `initial` proves nothing about a spectator who already has the page open
// when the decision lands (see AGENTS.md's "static render tests blind to
// state coupling" trap). This drives the SAME component instance through
// its own poll cycle instead.
//
// This workspace's vitest runs `environment: "node"` (vitest.config.ts) — no
// jsdom — so `LiveScore`'s `useState`/`useEffect` cannot run under a real DOM
// renderer here. `_hook-harness.tsx`'s `renderIsland` supplies React's hook
// dispatcher directly (same convention as every other stateful-island test
// in this workspace, see hook-harness.test.tsx) instead of adding jsdom for
// one component.
//
// The interval itself is stubbed rather than driven with fake timers: the
// polling effect calls the real global `setInterval(refresh, POLL_MS)`
// (live-score.tsx), so capturing that callback and invoking it directly
// proves the exact same wiring a real 15s tick would, without a wall-clock
// wait or `vi.advanceTimersByTimeAsync` bookkeeping.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/public.json";
import fr from "@/dictionaries/fr/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { LiveScore, LiveScoreBody } from "../live-score";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";

function stubFetch(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      json: async () => payload,
    })),
  );
}

/** Captures `setInterval`'s callback instead of letting a real (or fake)
 *  timer fire it. `clearInterval` is stubbed to a no-op — nothing in this
 *  file needs the interval torn down. */
function stubInterval(): { fire: () => Promise<void> } {
  let callback: (() => void | Promise<void>) | null = null;
  vi.stubGlobal(
    "setInterval",
    ((fn: () => void) => {
      callback = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
  );
  vi.stubGlobal("clearInterval", (() => {}) as typeof clearInterval);
  return {
    fire: async () => {
      if (!callback) throw new Error("setInterval was never armed — LiveScore did not start polling");
      await callback();
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

// Synthetic, ALL-CAPS templates rather than the real English dictionary
// strings — this file is proving WIRING (a live state update reaches
// `renderDecidedOutcome` and the result actually renders), not the copy
// itself, which `scoring-vocab.test.ts` already pins against the real
// dictionaries in all four locales.
const templates: DecidedOutcomeTemplates = {
  tie: "TIE",
  plain: "{winner} WON",
  byMethod: { shootout: "{winner} WON {score} ON PENALTIES" },
  // F8 (R3.5 review) — the score-less shootout fallback. Distinct wording
  // from the scored one above so this file's own live-update assertions
  // cannot pass by accidentally matching the wrong template.
  shootoutPlain: "{winner} WON ON PENALTIES",
};

const entrantNames = { W: "Riverside FC", L: "Oakdale United" };

describe("LiveScore — the decided sentence updates on a live poll, not only on remount (R3.5/Task O)", () => {
  it("renders nothing decided at first paint, then the sentence after the SAME instance polls a decided outcome", async () => {
    const interval = stubInterval();
    const island = renderIsland(LiveScore, {
      fixtureId: "fx-1",
      initial: { status: "scheduled", summary: null, outcome: null },
      realtime: false,
      entrantNames,
      sportKey: "football",
      decidedTemplates: templates,
    });

    // Positive discriminator first: the island actually mounted its usual
    // "nothing happening yet" copy, so the later assertion is a real
    // transition and not a component that never rendered. `LiveScore` is
    // called here with NO `dict` (this file's whole point, per its own
    // header comment, is proving WIRING without one) — `LiveScoreBody`
    // falls back to the English `public.json` import. Round 2 briefly
    // routed this headline through `matchCentre.status.scheduled`
    // ("Scheduled"), which silently changed the copy a live Playwright spec
    // (apps/web/e2e/scorepad-v3-football.spec.ts) asserts on the legacy
    // fixture page; round 3's product-owner ruling keeps the ORIGINAL copy
    // verbatim on its own key, `matchCentre.status.notStarted` — English
    // value is, not coincidentally, "Not started" again.
    expect(island.text()).toContain("Not started");
    expect(island.text()).not.toContain("WON");

    stubFetch({
      ok: true,
      data: {
        status: "decided",
        summary: {
          headline: "Riverside FC 1 – 1 Oakdale United",
          detail: { shootout: { home: 3, away: 0 } },
        },
        outcome: { kind: "win", winner: "W", method: "shootout" },
      },
    });

    // NO second renderIsland() call anywhere in this test — this is the same
    // mounted instance picking up its own poll tick.
    await interval.fire();

    expect(island.text()).toContain("Riverside FC WON 3–0 ON PENALTIES");
  });

  it("falls back to the plain template when a live update decides the fixture with no method", async () => {
    const interval = stubInterval();
    const island = renderIsland(LiveScore, {
      fixtureId: "fx-2",
      initial: { status: "in_play", summary: { headline: "1 – 0" }, outcome: null },
      realtime: false,
      entrantNames,
      sportKey: "football",
      decidedTemplates: templates,
    });

    stubFetch({
      ok: true,
      data: {
        status: "decided",
        summary: { headline: "1 – 0" },
        outcome: { kind: "win", winner: "W" },
      },
    });

    await interval.fire();

    expect(island.text()).toContain("Riverside FC WON");
    expect(island.text()).not.toContain("ON PENALTIES");
  });

  it("never arms a poll when realtime is off and the fixture is already decided at mount (nothing to update to)", async () => {
    const interval = stubInterval();
    renderIsland(LiveScore, {
      fixtureId: "fx-3",
      initial: { status: "decided", summary: { headline: "2 – 0" }, outcome: { kind: "win", winner: "W" } },
      realtime: false,
      entrantNames,
      sportKey: "football",
      decidedTemplates: templates,
    });

    await expect(interval.fire()).rejects.toThrow("setInterval was never armed");
  });
});

// Review round 2 — OPEN item from Task 11 Important 3: the earlier round's
// localisation had NO test that could fail if reverted, since every prior
// render used the English dict (the fallback), so "Live"/"Ended"/"Winner:"
// stayed in the output whether `t()` ran or the raw English literal was
// still hardcoded. These render with the FRENCH dictionary specifically and
// assert the FRENCH words — a revert to hardcoded English would fail every
// one of these.
describe("LiveScoreBody — localisation actually applies (not just wired to an English fallback)", () => {
  const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };

  it("in_play, rendered with the FRENCH dict: the French word appears, the English 'Live' does not", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={{ status: "in_play", summary: { headline: "1 – 0" }, outcome: null }}
        entrantNames={entrantNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain(fr["matchCentre.status.live"] as string); // "En direct"
    expect(html).not.toContain(">Live<");
  });

  it("decided, rendered with the FRENCH dict: the French word appears, the English 'Ended' does not", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={{ status: "decided", summary: { headline: "2 – 1" }, outcome: null }}
        entrantNames={entrantNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain(fr["matchCentre.status.decided"] as string); // "Terminé"
    expect(html).not.toContain("Ended");
  });

  it("a winner line, rendered with the FRENCH dict: the French word appears, the English 'Winner:' does not", () => {
    const html = renderToStaticMarkup(
      <LiveScoreBody
        data={{ status: "decided", summary: { headline: "2 – 1" }, outcome: { kind: "win", winner: "W" } }}
        entrantNames={entrantNames}
        sportKey="football"
        decidedTemplates={emptyTemplates}
        dict={fr as Dict}
      />,
    );
    expect(html).toContain(fr["matchCentre.winner"] as string); // "Vainqueur :"
    expect(html).not.toContain("Winner:");
  });
});

// Review round 2 — NEW IMPORTANT B: the DB's `fixtures.status` vocabulary
// (server/usecases/stages.ts:2142-2156) carries values beyond in_play/
// decided/finalized/scheduled — abandoned, cancelled, forfeited, postponed,
// walkover — each of which used to collapse into the generic
// `matchCentre.status.other` ("Not played") on the legacy fixture page.
describe("LiveScoreBody — the full DB status vocabulary, not just the generic 'Not played'", () => {
  const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };

  it("'abandoned' renders its OWN word — English 'Abandoned', French 'Abandonné' — never 'Not played'", () => {
    const data = { status: "abandoned", summary: null, outcome: null };
    const htmlEn = renderToStaticMarkup(
      <LiveScoreBody data={data} entrantNames={entrantNames} sportKey="football" decidedTemplates={emptyTemplates} dict={en as Dict} />,
    );
    expect(htmlEn).toContain("Abandoned");
    expect(htmlEn).not.toContain("Not played");

    const htmlFr = renderToStaticMarkup(
      <LiveScoreBody data={data} entrantNames={entrantNames} sportKey="football" decidedTemplates={emptyTemplates} dict={fr as Dict} />,
    );
    expect(htmlFr).toContain("Abandonné");
  });

  it("a genuinely UNRECOGNISED status renders ITSELF (the raw word) — never 'Not played', never a dictionary lookup", () => {
    const data = { status: "some_future_status_nobody_mapped_yet", summary: null, outcome: null };
    const html = renderToStaticMarkup(
      <LiveScoreBody data={data} entrantNames={entrantNames} sportKey="football" decidedTemplates={emptyTemplates} dict={en as Dict} />,
    );
    expect(html).toContain("some_future_status_nobody_mapped_yet");
    expect(html).not.toContain("Not played");
  });
});
