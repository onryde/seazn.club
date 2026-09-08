// What each manifest group needs seeded, and the placeholders it then
// provides. A later wave extends this file (W1-E adds "overlay-fixture", R2
// adds "relay-session") but NOT ONLY this file: the two TABLES live in
// ./manifest, so adding a kind is one entry in each of `SEED_KINDS` and
// `SEED_PARAMS` there plus one `seedFor` case here — the "SEED_KINDS /
// SEED_PARAMS are declared in ./manifest" comment just above the first recipe
// is the authority, and this header now agrees with it. (It used to say "THIS
// is the file a later wave extends … the harness itself does not change",
// which that comment contradicted a dozen lines further down;
// `docs/runbooks/visual-gate.md`'s step 2 repeated the same error and was
// corrected with it, 2026-09-08.) SEED_PARAMS is read by
// the manifest unit test so a route asking for a placeholder its seed cannot
// provide fails in seconds, not in Playwright.
import type { APIRequestContext, Page } from "@playwright/test";
import { activeOrg, apiJson, seedRosteredFixture, TAG } from "../helpers";
import type { SeedKind } from "./manifest";

// SEED_KINDS / SEED_PARAMS are declared in ./manifest (pure); this file holds
// the RECIPES. Adding a kind = one entry in each table there + one case here.

/** A PUBLIC competition with one started, scored and DECIDED football fixture
 *  — the public match page and the embed widgets both render it.
 *  `skipLineups`: the pad's rosterless case, so no position rule can refuse
 *  the seed.
 *
 *  Decided, not merely live, and that was measured rather than assumed
 *  (2026-09-08, streaming T1). `/embed/divisions/{id}/standings` renders from
 *  the standings SNAPSHOT rows, and `recomputeStandings`
 *  (`server/engine-db/competition.ts`) writes one only on a decided/void
 *  fixture — so a live 2-1 gave the widget a 200 with an EMPTY body and no
 *  `<table>` at all. That is the manifest's `awaitSelector` doing its job:
 *  without it the harness would have photographed a blank widget and passed.
 *  `core.finalize` is not the lever either — it 422s `WRONG_PHASE`, "cannot
 *  finalize an undecided fixture". Full time is: two `football.period` events
 *  on a non-level score (a level one goes to a shoot-out instead). */
async function publicFixture(page: Page): Promise<Record<string, string>> {
  const request = page.request;
  const seeded = await seedRosteredFixture(request, {
    label: `Visual gate ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [{ fullName: "Ada Okafor" }, { fullName: "Bea Nwosu" }],
    away: [{ fullName: "Cal Adeyemi" }, { fullName: "Dee Harbour" }],
    entrantKind: "team",
    emitCoreStart: true,
    skipLineups: true,
  });
  // 2-1, then full time. The SPORT's own events, not `scoreFixture`'s
  // sport-generic `generic.result` (helpers.ts) — the brief offered either;
  // `football.goal` is what every other football seed in this suite posts
  // (walkthrough/scorepad-v3-deciders-byhand.spec.ts, gallery.capture.ts),
  // and its `by` is the ENTRANT ID, never the string "home". Each call
  // throws on refusal: a seed that quietly leaves the score at 0-0, or the
  // match undecided, photographs a state the manifest never asked for.
  await postEvent(request, seeded.fixtureId, "football.goal", { by: seeded.homeEntrantId });
  await postEvent(request, seeded.fixtureId, "football.goal", { by: seeded.awayEntrantId });
  await postEvent(request, seeded.fixtureId, "football.goal", { by: seeded.homeEntrantId });
  await postEvent(request, seeded.fixtureId, "football.period", { phase: "HT" });
  await postEvent(request, seeded.fixtureId, "football.period", { phase: "FT" });
  const status = await apiJson<{ status: string }>(
    request,
    `/api/v1/fixtures/${seeded.fixtureId}/state`,
  );
  if (status.data?.status !== "decided" && status.data?.status !== "finalized") {
    throw new Error(
      `seed public-fixture: full time left the fixture ${status.data?.status ?? status.status} — ` +
        `the standings snapshot the embed widget reads is only written for a decided fixture`,
    );
  }
  const org = await activeOrg(page);
  const comp = await apiJson<{ slug: string }>(
    request,
    `/api/v1/competitions/${seeded.competitionId}`,
  );
  const div = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${seeded.divisionId}`);
  if (!comp.data?.slug || !div.data?.slug) {
    throw new Error(`seed public-fixture: slugs missing (comp ${comp.status}, div ${div.status})`);
  }
  return {
    orgSlug: org.slug,
    compSlug: comp.data.slug,
    divSlug: div.data.slug,
    divisionId: seeded.divisionId,
    fixtureId: seeded.fixtureId,
  };
}

/** Append one event through the real server reducer, on the fixture's current
 *  sequence. Same shape as `gallery.capture.ts`'s own `postEvent`; local
 *  because `helpers.ts` exports no generic appender. */
async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) {
    throw new Error(`seed postEvent(${type}): GET state -> ${state.status}`);
  }
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  if (res.status >= 300) {
    throw new Error(`seed postEvent(${type}) -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

export async function seedFor(kind: SeedKind, page: Page): Promise<Record<string, string>> {
  switch (kind) {
    case "none":
      return {};
    case "public-fixture":
      return publicFixture(page);
  }
}
