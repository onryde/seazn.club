import { readFileSync } from "node:fs";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/**
 * Standings qualification status (spec 2026-09-22; plan Task 10): the PUBLIC
 * division page marks each row's status, draws the cut line after place N and
 * keys the markers in a legend under the table — and a table with no next
 * stage draws none of it, exactly as before.
 *
 * Smoke rather than only e2e: smoke is the only gate a PR gets automatically
 * (e2e.yml triggers on push to `main` alone), and the status reaches the page
 * through a seam no unit test sees — V414's `stage_qualification_meta` read
 * through `public_stages_v`, the standings snapshot, the builder, and the
 * table's `qualification` prop. The served HTML is all smoke can read, so this
 * pins STRUCTURE; the engine-exact statuses are
 * `apps/web/e2e/standings-qualification.spec.ts`'s job.
 *
 * Markers are counted per ROW, not over the body: the legend draws one of each
 * kind as its key, so a four-row table with a legend carries seven
 * `data-qual-marker` attributes, and a whole-body count of four would fail on a
 * healthy page.
 *
 * Own fresh free session (not an entitlement gate): a community org builds a
 * Swiss → knockout composite and publishes one public competition.
 */
export async function publicQualificationStandingsSuite(): Promise<void> {
  const free = newSession();
  const ver = await signIn(free, `delivered+qual_board_${tag}@resend.dev`);
  const orgs = (await call(free, "/api/orgs")) as { id: string; slug: string }[];
  const org = orgs.find((o) => o.id === ver.org_id)!;
  const comp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Qualification Board ${tag}`,
      visibility: "public",
    }),
  );
  const mkDiv = async (name: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
  type Fx = { id: string; stage_id: string; round_no: number; home_entrant_id: string | null; away_entrant_id: string | null };
  const score = async (fixtureId: string) => {
    const st = v1data<{ last_seq: number }>(await v1(free, `/api/v1/fixtures/${fixtureId}/state`));
    await v1(free, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: st.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
  };
  // The fold runs after each result commits, and the public page is cached
  // from its first render: a snapshot that trails its fixtures shows no
  // status, so nothing is fetched until every result has folded.
  const settle = async (stageId: string, played: number) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = v1data<{ rows: { played: number }[] }>(await v1(free, `/api/v1/stages/${stageId}/standings`)).rows;
      if (rows.reduce((n, r) => n + r.played, 0) === played) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const field = (prefix: string) =>
    ["A", "B", "C", "D"].map((n, i) => ({ kind: "individual", display_name: `${prefix} ${n} ${tag}`, seed: i + 1 }));

  // A Swiss of four over three rounds into Finals (places 1–2), round 1 played.
  const swissDiv = await mkDiv("Swiss");
  const stages = v1data<{ id: string; seq: number }[]>(
    await v1(free, `/api/v1/divisions/${swissDiv.id}/stages`, "POST", [
      { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null },
      {
        seq: 2,
        kind: "knockout",
        name: "Finals",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "on_complete",
        },
      },
    ]),
  );
  const swissId = stages.find((s) => s.seq === 1)!.id;
  // An early Generate on the on_complete Finals (the Swiss has not completed)
  // is refused, and the envelope names BOTH stages under a reason — the desk
  // turns that into an amber notice naming them, instead of this English
  // message in a red banner. Refused in the pre-flight, so nothing is written.
  const finalsId = stages.find((s) => s.seq === 2)!.id;
  const early = await v1(free, `/api/v1/stages/${finalsId}/generate`, "POST");
  const earlyErr = (early.json.error ?? {}) as {
    code?: string;
    reason?: unknown;
    stageId?: unknown;
    previousStageId?: unknown;
  };
  check(
    `add-stage wait: an early Generate on an on_complete stage is 422 previous_stage_incomplete naming both stages (status=${early.status}, reason=${String(earlyErr.reason)})`,
    early.status === 422 &&
      earlyErr.code === "STAGE_NOT_READY" &&
      earlyErr.reason === "previous_stage_incomplete" &&
      earlyErr.stageId === finalsId &&
      earlyErr.previousStageId === swissId,
  );
  await v1(free, `/api/v1/divisions/${swissDiv.id}/entrants`, "POST", field("Swiss"));
  await v1(free, `/api/v1/divisions/${swissDiv.id}/start`, "POST");
  await v1(free, `/api/v1/stages/${swissId}/generate`, "POST");
  const swissFx = v1data<Fx[]>(await v1(free, `/api/v1/divisions/${swissDiv.id}/fixtures`)).filter(
    (f) => f.stage_id === swissId && f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null,
  );
  for (const f of swissFx) await score(f.id);
  await settle(swissId, 4);

  // The sibling: a league with NO next stage, round 1 played.
  const plainDiv = await mkDiv("Plain");
  const league = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${plainDiv.id}/stages`, "POST", { seq: 1, kind: "league", name: "League", config: {} }),
  );
  await v1(free, `/api/v1/divisions/${plainDiv.id}/entrants`, "POST", field("Plain"));
  const gen = v1data<{ fixtures: Fx[] }>(await v1(free, `/api/v1/stages/${league.id}/generate`, "POST"));
  await v1(free, `/api/v1/divisions/${plainDiv.id}/start`, "POST");
  const firstRound = Math.min(...gen.fixtures.map((f) => f.round_no));
  for (const f of gen.fixtures.filter((x) => x.round_no === firstRound)) await score(f.id);
  await settle(league.id, 4);

  const count = (body: string, re: RegExp) => (body.match(re) ?? []).length;
  /** The standings box's own rows. The page also serves a results grid whose
   *  rows are `<th scope="row">` too, so a body-wide count reads double. */
  const standingsRows = (body: string) =>
    count(/<div role="region"[^>]*>([\s\S]*?)<\/table>/.exec(body)?.[1] ?? "", /<th scope="row"/g);

  const swissPage = await html(newSession(), `/shared/${org.slug}/${comp.slug}/${swissDiv.slug}?tab=standings`);
  check(
    `qualification board: the Swiss page is 200 and draws exactly ONE cut line and one legend (status=${swissPage.status})`,
    swissPage.status === 200 &&
      count(swissPage.body, /data-testid="qual-cut"/g) === 1 &&
      count(swissPage.body, /data-testid="qual-legend"/g) === 1,
  );
  const rows = [...swissPage.body.matchAll(/<tr data-qual="(\w+)"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => ({
    status: m[1] ?? "",
    markers: [...(m[2] ?? "").matchAll(/data-qual-marker="(\w+)"/g)].map((x) => x[1] ?? ""),
  }));
  check(
    `qualification board: each of the four rows carries a status and ONE marker of that status (${rows
      .map((r) => `${r.status}:${r.markers.join("/")}`)
      .join(" ")})`,
    rows.length === 4 && rows.every((r) => r.markers.length === 1 && r.markers[0] === r.status),
  );
  check(
    `qualification board: the page's markers are the four rows' plus the legend's three keys (${count(swissPage.body, /data-qual-marker="/g)})`,
    count(swissPage.body, /data-qual-marker="/g) === 4 + 3,
  );

  const plainPage = await html(newSession(), `/shared/${org.slug}/${comp.slug}/${plainDiv.slug}?tab=standings`);
  check(
    `qualification board: a league with no next stage draws its table (${standingsRows(plainPage.body)} rows) and no cut line, legend, status or marker`,
    plainPage.status === 200 &&
      // The positive pair: an empty page satisfies every zero below.
      standingsRows(plainPage.body) === 4 &&
      count(plainPage.body, /data-testid="qual-cut"/g) === 0 &&
      count(plainPage.body, /data-testid="qual-legend"/g) === 0 &&
      count(plainPage.body, /data-qual="/g) === 0 &&
      count(plainPage.body, /data-qual-marker="/g) === 0,
  );

  // --- Pool label in the org's locale (2026-10-06). `pools.name` is stored
  // once, as the English "Pool " + key (usecases/stages.ts), and the public
  // surfaces used to print it, so a Spanish org's pools read "Pool A". The hub
  // document's table captions and the division page's <caption> text nodes must
  // be `table.poolLabel` over the pool's KEY, read from es/public.json on disk,
  // never typed. Own fresh org set to es (a community org publishes one public
  // competition); anonymous reads.
  const esPublic = JSON.parse(
    readFileSync(new URL("../apps/web/src/dictionaries/es/public.json", import.meta.url), "utf8"),
  ) as Record<string, string | undefined>;
  const poolWord = esPublic["table.poolLabel"] ?? "";
  check(
    `pool label: es/public.json declares table.poolLabel with a {key} slot (${JSON.stringify(poolWord)})`,
    poolWord.includes("{key}"),
  );
  const POOL_STAGE = "Groups";
  const wantCaptions = ["A", "B"].map((key) => `${POOL_STAGE} — ${poolWord.replace("{key}", key)}`);
  check(
    `pool label: premise — the Spanish caption is not the stored English name (${wantCaptions.join(" | ")})`,
    wantCaptions[0] !== `${POOL_STAGE} — Pool A`,
  );
  const es = newSession();
  const esVer = await signIn(es, `delivered+qual_pool_es_${tag}@resend.dev`);
  const esLocale = await v1(es, `/api/orgs/${esVer.org_id}`, "PATCH", { default_locale: "es" });
  check(`pool label: org PATCH accepts default_locale=es (status=${esLocale.status})`, esLocale.status === 200);
  const esOrg = ((await call(es, "/api/orgs")) as { id: string; slug: string }[]).find((o) => o.id === esVer.org_id)!;
  const esComp = v1data<{ id: string; slug: string }>(
    await v1(es, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Grupos ${tag}`, visibility: "public" }),
  );
  const esDiv = v1data<{ id: string; slug: string }>(
    await v1(es, `/api/v1/competitions/${esComp.id}/divisions`, "POST", {
      name: "Abierto",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const esStage = v1data<{ id: string }>(
    await v1(es, `/api/v1/divisions/${esDiv.id}/stages`, "POST", {
      seq: 1,
      kind: "group",
      name: POOL_STAGE,
      config: { pools: { count: 2 } },
    }),
  );
  await v1(
    es,
    `/api/v1/divisions/${esDiv.id}/entrants`,
    "POST",
    Array.from({ length: 8 }, (_, i) => ({ kind: "individual", display_name: `Lado ${i + 1} ${tag}`, seed: i + 1 })),
  );
  const esGen = v1data<{ fixtures: (Fx & { pool_id: string | null })[] }>(
    await v1(es, `/api/v1/stages/${esStage.id}/generate`, "POST"),
  );
  await v1(es, `/api/v1/divisions/${esDiv.id}/start`, "POST");
  const esFirst = Math.min(...esGen.fixtures.map((f) => f.round_no));
  for (const f of esGen.fixtures.filter((x) => x.round_no === esFirst)) {
    const st = v1data<{ last_seq: number }>(await v1(es, `/api/v1/fixtures/${f.id}/state`));
    await v1(es, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: st.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 0 },
    });
  }
  const esPools = [...new Set(esGen.fixtures.map((f) => f.pool_id).filter((p): p is string => p !== null))];
  check(`pool label: the group stage generated two pools (${esPools.length})`, esPools.length === 2);
  // Each pool of four played two matches in round 1: four appearances apiece.
  for (const poolId of esPools) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = v1data<{ rows: { played: number }[] }>(
        await v1(es, `/api/v1/stages/${esStage.id}/standings?pool_id=${poolId}`),
      ).rows;
      if (rows.reduce((n, r) => n + r.played, 0) === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const esHub = v1data<{ locale?: string; tables?: { caption: string }[] } | undefined>(
    await v1(newSession(), `/api/v1/public/orgs/${esOrg.slug}/competitions/${esComp.slug}/hub`),
  );
  const hubCaptions = (esHub?.tables ?? []).map((t) => t.caption);
  check(
    `pool label: the es hub document captions each pool's table in Spanish, from its key (locale=${String(esHub?.locale)}, ${JSON.stringify(hubCaptions)})`,
    esHub?.locale === "es" &&
      JSON.stringify(hubCaptions) === JSON.stringify(wantCaptions) &&
      !hubCaptions.some((c) => c.includes("Pool")),
  );

  const esPage = await html(newSession(), `/shared/${esOrg.slug}/${esComp.slug}/${esDiv.slug}?tab=standings`);
  // The standings table's <caption class="…">TEXT</caption>: anchored on `="`
  // and on the text node itself, so a prop or a flight-payload copy of the
  // string cannot satisfy it.
  const pageCaptions = [...esPage.body.matchAll(/<caption class="[^"]*">([^<]*)<\/caption>/g)]
    .map((m) => m[1] ?? "")
    .filter((c) => c.startsWith(`${POOL_STAGE} — `));
  check(
    `pool label: the es division page's standings captions name each pool in Spanish, from its key (status=${esPage.status}, ${JSON.stringify(pageCaptions)})`,
    esPage.status === 200 &&
      JSON.stringify(pageCaptions) === JSON.stringify(wantCaptions) &&
      !esPage.body.includes(`>${POOL_STAGE} — Pool A</caption>`) &&
      !esPage.body.includes(`>${POOL_STAGE} — Pool B</caption>`),
  );
}
