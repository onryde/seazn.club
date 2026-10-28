import { readFileSync } from "node:fs";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, v1data, setPlan } from "../harness.ts";

/** payments-hardening Task 16 — the 4-plan user matrix. Four fresh owners, one
 *  per plan, created through the same HTTP surface the rest of smoke uses; each
 *  asserts the entitlements that distinguish its tier at the resolution + HTTP-
 *  status level. Keyless-safe: every check resolves entitlements or 402s BEFORE
 *  any Stripe/LLM call, and each check runs AFTER its data is seeded. Own fresh
 *  orgs (never touches org/org2 from main()); the pass persona stays community.
 *
 *  V291 truths this pins: the AI cap rises with the tier; a
 *  pass overlays comp-scoped Pro features INSIDE the passed comp only; the dead
 *  Event-Pass members.max row is gone → org-wide keys resolve community for a
 *  passed org. */
/**
 * Hub Knockout tab (plan 2026-09-13, Task 3) — the PUBLIC competition hub
 * document for a seeded knockout competition offers a `knockout` tab, its
 * knockout view's rounds name only fixtures that same document lists, and the
 * view's champion appears exactly when the final is decided.
 *
 * Driven through the real API end to end: results are `generic.result`
 * events, and the final's two slots fill from the semi-final winners through
 * the engine's own `onDecided`, never SQL. The hub is read by an ANONYMOUS
 * session, as a spectator's page polls it. The mid-event read comes after a
 * scoring write and the final read after another, so a hub cache that a
 * scoring write fails to clear reds the champion check rather than hiding.
 * Own fresh community org (single-elimination knockout is a Community
 * format); keyless-safe.
 */
/** Schedule-board knockout round codes (2026-09-23): the division board's
 *  SERVER-RENDERED HTML for a freshly generated 4-entrant knockout carries the
 *  round-role chip on its cards — SF for both semi-finals, F for the final,
 *  each with the long round name as its title — and the legend row naming
 *  them; then a generated page playoff's board reads Q1 / E / Q2 / F (board
 *  playoff codes). Every expected string is read from the en dictionary on
 *  disk (this runner cannot import the JSON-backed `@/lib/messages`), so a
 *  copy change moves the check with it. */
export async function boardRoundCodesSuite(): Promise<void> {
  const en = JSON.parse(
    readFileSync(new URL("../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  const owner = newSession();
  const who = await signIn(owner, `delivered+brcodes_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";
  const comp = await v1(owner, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Board Codes ${tag}`,
    visibility: "private",
  });
  const compRow = v1data<{ id: string; slug: string }>(comp);
  const div = await v1(owner, `/api/v1/competitions/${compRow.id}/divisions`, "POST", {
    name: "Cup",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divRow = v1data<{ id: string; slug: string }>(div);
  const entrants = await v1(
    owner,
    `/api/v1/divisions/${divRow.id}/entrants`,
    "POST",
    ["Codes One", "Codes Two", "Codes Three", "Codes Four"].map((name, i) => ({
      kind: "individual",
      display_name: name,
      seed: i + 1,
    })),
  );
  const stage = await v1(owner, `/api/v1/divisions/${divRow.id}/stages`, "POST", {
    seq: 1,
    kind: "knockout",
    name: "Cup",
  });
  const generated = await v1(owner, `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`, "POST");
  check(
    "board round codes: a generic division with 4 entrants and a generated knockout stage",
    orgSlug !== "" &&
      comp.status === 201 &&
      div.status === 201 &&
      entrants.status < 300 &&
      stage.status < 300 &&
      generated.status < 300,
  );

  const page = await html(owner, `/o/${orgSlug}/c/${compRow.slug}/d/${divRow.slug}/schedule?tab=board`);
  // Anchored on `="` and the chip's own attribute order (round-code-chip.tsx):
  // a knockout chip is the heavier variant, titled with the long round name.
  const chips = (code: string, name: string) =>
    page.body.match(
      new RegExp(
        `data-testid="board-round-code" data-round-code-chip="knockout" title="${name}" class="[^"]*">${code}<`,
        "g",
      ),
    )?.length ?? 0;
  const sf = chips(en["bracket.roundShort.semi"], en["bracket.round.semi"]);
  const f = chips(en["bracket.roundShort.final"], en["bracket.round.final"]);
  check(
    `board round codes: the division board renders both semi-finals' chips as ${en["bracket.roundShort.semi"]} and the final's as ${en["bracket.roundShort.final"]} (got ${sf} and ${f})`,
    page.status === 200 && sf === 2 && f === 1,
  );
  check(
    "board round codes: no knockout card falls back to the generic R{n} chip",
    page.status === 200 && !page.body.includes('data-round-code-chip="plain"'),
  );
  check(
    "board round codes: the legend row is an explicit, named list of the codes in view",
    new RegExp(
      `data-testid="board-legend-rounds" role="list" aria-label="${en["board.roundLegend.aria"]}"`,
    ).test(page.body),
  );

  // Board playoff codes (2026-09-23): a generated PAGE PLAYOFF's division board
  // reads Q1 / E / Q2 / F — the codes that ride the board read's one new
  // column, `ext_key` (page-playoff rows only). Without it the server would
  // hand the board four key-less rows and every chip would stay R{n}. The page
  // playoff is Pro-gated (format-gates.ts), so this org is repriced first.
  await setPlan(who.org_id, "pro", owner);
  const ppDiv = await v1(owner, `/api/v1/competitions/${compRow.id}/divisions`, "POST", {
    name: "Playoffs",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const ppRow = v1data<{ id: string; slug: string }>(ppDiv);
  await v1(
    owner,
    `/api/v1/divisions/${ppRow.id}/entrants`,
    "POST",
    ["Page One", "Page Two", "Page Three", "Page Four"].map((name, i) => ({
      kind: "individual",
      display_name: name,
      seed: i + 1,
    })),
  );
  const ppStage = await v1(owner, `/api/v1/divisions/${ppRow.id}/stages`, "POST", {
    seq: 1,
    kind: "page_playoff",
    name: "Playoffs",
  });
  const ppGenerated = await v1(owner, `/api/v1/stages/${v1data<{ id: string }>(ppStage).id}/generate`, "POST");
  const ppPage = await html(owner, `/o/${orgSlug}/c/${compRow.slug}/d/${ppRow.slug}/schedule?tab=board`);
  const ppChips = (code: string, name: string) =>
    ppPage.body.match(
      new RegExp(
        `data-testid="board-round-code" data-round-code-chip="knockout" title="${name}" class="[^"]*">${code}<`,
        "g",
      ),
    )?.length ?? 0;
  const ppCounts = [
    ppChips(en["bracket.roundShort.qualifier1"], en["bracket.round.qualifier1"]),
    ppChips(en["bracket.roundShort.eliminator"], en["bracket.round.eliminator"]),
    ppChips(en["bracket.roundShort.qualifier2"], en["bracket.round.qualifier2"]),
    ppChips(en["bracket.roundShort.final"], en["bracket.round.final"]),
  ];
  check(
    `board round codes: a generated page playoff's division board renders one each of ${en["bracket.roundShort.qualifier1"]}, ${en["bracket.roundShort.eliminator"]}, ${en["bracket.roundShort.qualifier2"]} and ${en["bracket.roundShort.final"]}, and no plain R{n} chip (got ${ppCounts.join("/")})`,
    ppDiv.status === 201 &&
      ppStage.status < 300 &&
      ppGenerated.status < 300 &&
      ppPage.status === 200 &&
      ppCounts.every((n) => n === 1) &&
      !ppPage.body.includes('data-round-code-chip="plain"'),
  );
}
