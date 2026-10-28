// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

export async function hubKnockoutSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+hubko_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";

  const comp = await v1(owner, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Hub Knockout ${tag}`,
    visibility: "public",
  });
  const compRow = v1data<{ id: string; slug: string; visibility: string }>(comp);
  check(
    "hub knockout: a PUBLIC competition is created (not degraded to private)",
    comp.status === 201 && compRow.visibility === "public" && orgSlug !== "",
  );

  const div = await v1(owner, `/api/v1/competitions/${compRow.id}/divisions`, "POST", {
    name: "Cup",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divId = v1data<{ id: string }>(div).id;
  const entrants = await v1(
    owner,
    `/api/v1/divisions/${divId}/entrants`,
    "POST",
    ["KO One", "KO Two", "KO Three", "KO Four"].map((name, i) => ({
      kind: "individual",
      display_name: name,
      seed: i + 1,
    })),
  );
  const stage = await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "knockout",
    name: "Cup",
  });
  const stageId = v1data<{ id: string }>(stage).id;
  const generated = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
  const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
  check(
    "hub knockout: a generic division, 4 entrants and a generated knockout stage, started",
    div.status === 201 &&
      entrants.status < 300 &&
      stage.status < 300 &&
      generated.status < 300 &&
      started.status < 300,
  );

  type KoFixture = {
    id: string;
    round_no: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  };
  const fixtures = async () =>
    v1data<KoFixture[]>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [];
  const score = async (fixtureId: string) => {
    const state = v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${fixtureId}/state`));
    return v1(owner, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: state.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
  };

  const drawn = await fixtures();
  const firstRound = Math.min(...drawn.map((f) => f.round_no));
  const semis = drawn.filter((f) => f.round_no === firstRound);
  const finalId = drawn.find((f) => f.round_no !== firstRound)?.id ?? "";
  check(
    "hub knockout: a 4-draw generates two semi-finals and a final",
    drawn.length === 3 && semis.length === 2 && finalId !== "",
  );

  // The first round.
  const semiWrites: number[] = [];
  for (const semi of semis) semiWrites.push((await score(semi.id)).status);
  check(
    "hub knockout: both semi-final results are accepted",
    semiWrites.length === 2 && semiWrites.every((s) => s < 300),
  );

  type HubOut = {
    tabs: string[];
    knockouts: {
      rounds: { key: string; fixtureIds: string[] }[];
      championFixtureId: string | null;
    }[];
    matches: { fixtureId: string }[];
  };
  const hubPath = `/api/v1/public/orgs/${orgSlug}/competitions/${compRow.slug}/hub`;
  const midRes = await v1(newSession(), hubPath);
  const mid = v1data<HubOut | undefined>(midRes);
  const midMatchIds = new Set((mid?.matches ?? []).map((m) => m.fixtureId));
  const midRounds = mid?.knockouts?.[0]?.rounds ?? [];
  check("hub knockout: the anonymous hub document serves 200", midRes.status === 200);
  check("hub knockout: `tabs` includes `knockout`", mid?.tabs?.includes("knockout") === true);
  check(
    "hub knockout: `knockouts[0].rounds` is non-empty — the semi-finals (2) then the final (1)",
    midRounds.length === 2 &&
      midRounds[0].fixtureIds.length === 2 &&
      midRounds[1].fixtureIds.length === 1,
  );
  check(
    "hub knockout: every `rounds[].fixtureIds` entry exists in `matches`",
    midRounds.length > 0 &&
      midRounds.every((r) => r.fixtureIds.length > 0 && r.fixtureIds.every((id) => midMatchIds.has(id))),
  );
  check(
    "hub knockout: no champion while the final is unplayed",
    mid?.knockouts?.[0]?.championFixtureId === null,
  );

  // The final's slots fill from the semi-final winners; bounded wait, never a
  // fixed sleep's worth of hope.
  let filled = false;
  for (let tries = 0; tries < 20 && !filled; tries++) {
    const final = (await fixtures()).find((f) => f.id === finalId);
    filled = !!final?.home_entrant_id && !!final?.away_entrant_id;
    if (!filled) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check("hub knockout: the final's two slots fill from the semi-final winners", filled);

  // Spectator W2 (Task 17, SM1) — the org home's chip island polls
  // `/api/v1/public/orgs/{org}/live`. Its in-play count must move on the
  // write itself: the read is primed first, so a cache entry that a scoring
  // write failed to retire would still say 0 right after the start. (Where
  // no REDIS_URL is set — CI's smoke server included — the cache is inert and
  // this pins the count's values, not the retirement.)
  type OrgLiveOut = { competitions: { id: string; status: string; in_play: number }[] };
  const livePath = `/api/v1/public/orgs/${orgSlug}/live`;
  const inPlay = async () => {
    const res = await v1(newSession(), livePath);
    const row = v1data<OrgLiveOut | undefined>(res)?.competitions?.find((c) => c.id === compRow.id);
    return { status: res.status, inPlay: row?.in_play };
  };
  // Owner decision 2026-09-27: a DRAFT is reachable by link but listed
  // nowhere. This competition is still a draft here (a division start never
  // promotes one), so the org's live read leaves it out while its hub serves
  // by link, noindexed. Publishing lists it: the org's live read on the very
  // next request (its poll document is deleted on the write), the hub PAGE
  // within a bound. Measured 2026-09-27 on a local prod build: the first one or
  // two page loads after the publish are the previous render, served with
  // `x-nextjs-cache: STALE` although `fireOrgRevalidate` expires the org tag
  // with `{ expire: 0 }`; ~2s later the page is fresh. Root cause not
  // established (the same expiry from `PATCH /api/orgs/{id}` did re-render the
  // landing on the next load) — an open finding, so this check pins the bound
  // and says how many stale loads it saw rather than promising the next load.
  const hubPage = `/shared/${orgSlug}/${compRow.slug}`;
  const NOINDEX = `name="robots" content="noindex`;
  const draftLive = await inPlay();
  const draftHub = await html(newSession(), hubPage);
  check(
    "draft unlisted: a started DRAFT is left out of the org's live read, and its hub serves by link with noindex",
    draftLive.status === 200 && draftLive.inPlay === undefined && draftHub.status === 200 && draftHub.body.includes(NOINDEX),
  );
  const published = await v1(owner, `/api/v1/competitions/${compRow.id}`, "PATCH", { status: "published" });
  let publishedHub = await html(newSession(), hubPage);
  let staleLoads = 0;
  for (let tries = 0; tries < 20 && publishedHub.status === 200 && publishedHub.body.includes(NOINDEX); tries++) {
    staleLoads++;
    await new Promise((resolve) => setTimeout(resolve, 500));
    publishedHub = await html(newSession(), hubPage);
  }
  check(
    `draft unlisted: publishing is accepted and the hub drops its noindex within 10s (${staleLoads} stale load(s) first)`,
    published.status === 200 &&
      v1data<{ status: string }>(published).status === "published" &&
      publishedHub.status === 200 &&
      !publishedHub.body.includes(NOINDEX),
  );
  const livePrimed = await inPlay();
  check(
    "org live: the competition is listed with nothing in play before the final starts",
    livePrimed.status === 200 && livePrimed.inPlay === 0,
  );
  const finalStart = filled
    ? (await v1(owner, `/api/v1/fixtures/${finalId}/events`, "POST", {
        expected_seq: v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${finalId}/state`)).last_seq,
        type: "core.start",
        payload: {},
      })).status
    : 0;
  const liveStarted = await inPlay();
  check(
    "org live: starting the final reads in_play 1 on the very next request",
    finalStart === 201 && liveStarted.status === 200 && liveStarted.inPlay === 1,
  );

  const finalWrite = filled ? (await score(finalId)).status : 0;
  check("hub knockout: the final's result is accepted", finalWrite > 0 && finalWrite < 300);
  const liveEnded = await inPlay();
  check(
    "org live: the final's result reads in_play 0 on the very next request",
    liveEnded.status === 200 && liveEnded.inPlay === 0,
  );
  const liveUnknown = await v1(newSession(), `/api/v1/public/orgs/no-such-org-${tag}/live`);
  check("org live: an unknown org is a 404, not a 500", liveUnknown.status === 404);
  const orgHome = await html(newSession(), `/shared/${orgSlug}`);
  check(
    "org live: the org home renders this competition's live chip",
    orgHome.status === 200 && orgHome.body.includes(`data-testid="mh-org-chip-${compRow.id}"`),
  );

  const done = v1data<HubOut | undefined>(await v1(newSession(), hubPath));
  check(
    "hub knockout: after the final is scored, `championFixtureId` equals the final's id",
    done?.knockouts?.[0]?.championFixtureId === finalId &&
      done?.knockouts?.[0]?.rounds?.[1]?.fixtureIds?.[0] === finalId,
  );

  // V416 — `show_seeds`. This division was seeded 1..4 in the order the names
  // were posted, and the name order is a different one, so the two reads below
  // can tell a hidden seed from a merely re-sorted list. Both are anonymous
  // and come straight after the organiser's PATCH: a hub or entrants document
  // the PATCH failed to retire would still print the numbers.
  const koNames = ["KO One", "KO Two", "KO Three", "KO Four"];
  const byName = [...koNames].sort();
  const divSlug = v1data<{ slug: string }>(div).slug;
  const entrantsPath = `/api/v1/public/orgs/${orgSlug}/competitions/${compRow.slug}/divisions/${divSlug}/entrants`;
  type SeedCard = { divisionId: string; name: string; seed: number | null };
  const hubCards = async () =>
    (v1data<{ teams?: SeedCard[] } | undefined>(await v1(newSession(), hubPath))?.teams ?? []).filter(
      (t) => t.divisionId === divId,
    );
  const publicRows = async () =>
    v1data<{ entrants?: { display_name: string; seed: number | null }[] } | undefined>(
      await v1(newSession(), entrantsPath),
    )?.entrants ?? [];
  const shownCards = await hubCards();
  check(
    "show seeds: while ON, the hub's Teams cards carry every seed, in seed order",
    JSON.stringify(shownCards.map((t) => [t.name, t.seed])) ===
      JSON.stringify(koNames.map((n, i) => [n, i + 1])),
  );
  const off = await v1(owner, `/api/v1/divisions/${divId}`, "PATCH", { show_seeds: false });
  check(
    "show seeds: PATCH { show_seeds: false } is accepted and echoed",
    off.status === 200 && v1data<{ show_seeds?: boolean }>(off)?.show_seeds === false,
  );
  const hiddenCards = await hubCards();
  check(
    "show seeds: after OFF, the next anonymous hub read carries NO seed, cards in name order",
    JSON.stringify(hiddenCards.map((t) => [t.name, t.seed])) === JSON.stringify(byName.map((n) => [n, null])),
  );
  const hiddenRows = await publicRows();
  check(
    "show seeds: after OFF, the anonymous entrants document carries NO seed, in name order",
    JSON.stringify(hiddenRows.map((e) => [e.display_name, e.seed])) === JSON.stringify(byName.map((n) => [n, null])),
  );
}
