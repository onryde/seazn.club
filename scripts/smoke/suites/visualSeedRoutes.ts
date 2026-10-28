// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, check, tag, ledger, timedFixture, html, v1, v1data } from "../harness.ts";

/**
 * Purge this run's test data: delete the run's test users and every org they
 * created (org delete cascades competitions/divisions/fixtures/members/
 * invites). Scoped to the run's `tag` by exact email match. No-op when
 * DATABASE_URL is unset. Never throws — teardown must not fail the run.
 */

// =====================================================================
// Streaming T1 — the routes the visual gate photographs.
// =====================================================================
/**
 * The two routes the visual gate photographs today answer as its manifest
 * expects them to, through the SERVER rather than a browser: the public
 * fixture page with the match-centre score the manifest awaits, and the embed
 * standings widget with both a `<table>` and its auto-height script. Those are
 * the manifest's own `awaitSelector`s (`apps/web/e2e/visual/manifest.json` —
 * `[data-testid=mc-score-0]` and `table`), so a 200 whose body lacks them is
 * the inert page the harness would otherwise photograph as "fine" and sign
 * off on. `mc-score-0` rather than a heading deliberately: the branded 404
 * (`shared/[orgSlug]/not-found.tsx`) renders an `<h1>` inside the same
 * `<main>`, so a heading probe passes on a page that is not the fixture.
 *
 * The fixture is driven to FULL TIME on purpose, and that was measured rather
 * than assumed: `/embed/divisions/{id}/standings` renders from the standings
 * SNAPSHOT rows, which `recomputeStandings` writes only for a decided fixture,
 * so a live 2-1 returns 200 with an empty widget body and no table at all.
 * `core.finalize` is not the lever either — it 422s WRONG_PHASE on an
 * undecided fixture. A level score would go to a shoot-out instead of
 * deciding, hence 2-1.
 *
 * Distinct from the pro-path embed check in `v3ContentApiSuite` below, which
 * asserts only that the widget renders the attribution string ("seazn.club")
 * on a division that has no standings at all.
 */
export async function visualSeedRoutesSuite(owner: Session, orgSlug: string): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Visual Gate ${tag}`,
      visibility: "public",
    }),
  );
  const fx = await timedFixture(owner, comp.id, {
    name: "Visual Gate League",
    sport_key: "football",
    variant_key: "11-a-side",
    entrants: [
      { kind: "team", display_name: `Visual Home ${tag}`, seed: 1 },
      { kind: "team", display_name: `Visual Away ${tag}`, seed: 2 },
    ],
  });
  const led = ledger(owner, fx.fixtureId);
  // Status-checked one at a time. A mid-sequence refusal used to surface only
  // as the `decided` check failing, which names neither the event nor its
  // reason — and a 422 on the first `football.period` reads exactly like a
  // 422 on the third goal.
  const refused: string[] = [];
  const send = async (type: string, payload: unknown) => {
    const res = await led.send(type, payload);
    if (res.status !== 201) {
      refused.push(`${type} -> ${res.status} ${JSON.stringify(res.json)}`.slice(0, 160));
    }
  };
  await send("core.start", {});
  await send("football.goal", { by: fx.entrantIds[0] });
  await send("football.goal", { by: fx.entrantIds[1] });
  await send("football.goal", { by: fx.entrantIds[0] });
  await send("football.period", { phase: "HT" });
  await send("football.period", { phase: "FT" });
  check(
    `visual gate: every seed event was accepted${refused.length ? ` (refused: ${refused.join("; ")})` : ""}`,
    refused.length === 0,
  );
  const state = v1data<{ status: string }>(await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/state`));
  check(
    `visual gate: full time decides the seeded fixture (got '${state.status}')`,
    state.status === "decided" || state.status === "finalized",
  );

  const embed = await html(newSession(), `/embed/divisions/${fx.divisionId}/standings`);
  check(
    "visual gate: embed standings renders a <table> and the auto-height script",
    embed.status === 200 && embed.body.includes("<table") && embed.body.includes("seazn:embed:height"),
  );

  const div = v1data<{ slug: string }>(await v1(owner, `/api/v1/divisions/${fx.divisionId}`));
  const page = await html(
    newSession(),
    `/shared/${orgSlug}/${comp.slug}/${div.slug}/fixtures/${fx.fixtureId}`,
  );
  check(
    "visual gate: public fixture page renders the match-centre score the manifest awaits",
    page.status === 200 &&
      page.body.includes("<main") &&
      page.body.includes('data-testid="mc-score-0"'),
  );
  // The manifest's THIRD group, `stream-overlay`, has its counterpart in
  // `streamOverlaySuite` below rather than here: its negative needs an org-wide
  // `streaming.overlay` override-false row, and this suite runs on the shared
  // Pro org.
}
