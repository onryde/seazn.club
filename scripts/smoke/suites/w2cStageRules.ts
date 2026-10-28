import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { badminton } from "@seazn/engine/sports/setbased";
import { hockey } from "@seazn/engine/sports/hockey";
// W2c Task 11: the sport registry and the engine's own stage-key declaration, the expectation of the every-sport check
// below (never a list of keys typed into the script).
import { builtinModules } from "@seazn/engine/sports";
import { stageDefaultsFor, stageTopKeysFor, type AnySportModule } from "@seazn/engine/sport";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, call, check, signIn, tag, html, v1, v1data, setPlan } from "../harness.ts";

/**
 * Format matrix W2c (spec 2026-10-13, stage-level rules) — the one smoke suite every W2c task appends its named
 * check to (plan Global Constraints, created by Task 10). Over real HTTP against a live server; own fresh owner,
 * bumped to Pro by Task 11 (the every-sport check needs more divisions than the free plan allows; that needs
 * DATABASE_URL, like every other suite that calls setPlan), keyless-safe.
 *
 * Task 10's own change (`fixtures.rules_override` through every resolver caller) has no HTTP writer until Task 14,
 * whose smoke check covers the override; its first check is Task 2's owed one. SMOKE_ONLY=w2cStageRules runs it
 * alone (SELECTABLE_SUITES).
 */
export async function w2cStageRulesSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+w2c_${tag}@resend.dev`);
  // Task 11's every-sport check needs more divisions than the free plan allows in one competition (4); the Pro bump is
  // the suite's own, after the seed-independent sign-in, and affects no check below it.
  await setPlan(who.org_id, "pro", owner);
  // Task 2's owed check (X-SR-4), as W2d Task 10 reads it (spec §5.4, §11 item 4): a division's tie-break order no longer
  // locks a started stage — Pool A is pinned (generated, then started) and ranks by its pin — so the save answers 200, refuses
  // nothing, and names the pinned stage it kept in `stagesKeptPinned`. The order must pass `validateCascade` on the write
  // path (W2c's `["h2h_points"]` puts neither the primary first nor lots last), and must MOVE the division's live order (the
  // stored cascade is null, so the live one is the sport's default): the sport's own default without its head-to-head steps.
  const bdmCfg = badminton.configSchema.parse(badminton.variants.short) as never;
  const bdmDefault = badminton.defaultTiebreakers("league", bdmCfg);
  const order = bdmDefault.filter((k) => !k.startsWith("h2h"));
  const { divisionId, fixtureId, unstartedId } = await w2cSeedStartedPool(owner);
  const r = await v1(owner, `/api/v1/divisions/${divisionId}`, "PATCH", { tiebreakers: order });
  const rRow = r.json.data as { refused?: unknown[]; stagesKeptPinned?: { name?: string }[]; tiebreakers?: unknown } | undefined;
  const keptNamed =
    order.length >= 3 &&
    JSON.stringify(order) !== JSON.stringify(bdmDefault) &&
    r.status === 200 &&
    (rRow?.refused ?? []).length === 0 &&
    JSON.stringify(rRow?.tiebreakers) === JSON.stringify(order) &&
    rRow?.stagesKeptPinned?.length === 1 &&
    rRow.stagesKeptPinned[0]?.name === "Pool A";
  check(
    "w2c→w2d: a division tie-break order never locks a started stage; the save names the pinned stage it kept" +
      (keptNamed ? "" : ` — got ${r.status} ${JSON.stringify(r.json.error ?? r.json.data)} (order ${JSON.stringify(order)})`),
    keptNamed,
  );
  // Task 20's owed check (S4) — a rename beside a cascade change: both land in one 200, nothing refused, the pinned stage
  // named as kept. The rename and the cascade are read back from the division, so a 200 that dropped either fails here. The
  // second order swaps the two middle steps of the first (a change from what is now stored; both pass `validateCascade`).
  const renamed = `W2c Singles Renamed ${tag}`;
  const order2 = [order[0], ...order.slice(1, -1).reverse(), order[order.length - 1]];
  const mixed = await v1(owner, `/api/v1/divisions/${divisionId}`, "PATCH", { name: renamed, tiebreakers: order2 });
  const mixedRow = mixed.json.data as { name?: string; refused?: unknown[]; stagesKeptPinned?: { name?: string }[] } | undefined;
  const afterMixed = v1data<{ name: string; tiebreakers: unknown }>(await v1(owner, `/api/v1/divisions/${divisionId}`));
  const mixedOk =
    JSON.stringify(order2) !== JSON.stringify(order) &&
    mixed.status === 200 &&
    mixedRow?.name === renamed &&
    (mixedRow.refused ?? []).length === 0 &&
    mixedRow.stagesKeptPinned?.[0]?.name === "Pool A" &&
    afterMixed.name === renamed &&
    JSON.stringify(afterMixed.tiebreakers) === JSON.stringify(order2);
  check(
    "w2c→w2d: a mixed division save answers 200, lands the rename AND the cascade, refuses nothing" +
      (mixedOk ? "" : ` — got ${mixed.status} ${JSON.stringify(mixed.json.error ?? mixed.json.data)} / stored ${JSON.stringify(afterMixed)}`),
    mixedOk,
  );
  // The sequence: a save AFTER the partial one is plain — nothing kept, no `refused` on the row.
  const next = await v1(owner, `/api/v1/divisions/${divisionId}`, "PATCH", { name: `${renamed} 2` });
  const nextRow = next.json.data as { name?: string; refused?: unknown } | undefined;
  check(
    "w2c: the save after a partial one carries no refused[]",
    next.status === 200 && nextRow?.name === `${renamed} 2` && (nextRow.refused === undefined || (Array.isArray(nextRow.refused) && nextRow.refused.length === 0)),
  );
  await w2cFixtureRulesChecks(owner, fixtureId, unstartedId);
  await w2cStageRulesEverySportChecks(owner);
  await w2cStagePresetChecks(owner);
  await w2cStageOffAndReseedChecks(owner);
  await w2cStagePointsWalkoverChecks(owner);
  await w2cRulesVersionChecks(owner);
  await w2cRulesVersionPreKickoffChecks(owner);
  await w2cPublicStageFormatChecks(owner, who.org_id);
  await w2cWalkoverHeadlineChecks(owner, who.org_id);
}

/**
 * W2c Task 13 (ST-G8) — over real HTTP: a badminton `short` league stage takes its own points through
 * `PUT /stages/{id}/rules` (`{points}`), with a forfeit row; the stage is generated and the division started; the away
 * side's walkover is recorded with `core.forfeit`; and the stage's table pays the FORFEIT ROW, not the division's own.
 * The forfeit row is derived from the division's own walkover pay (badminton's `pointsMap["*"]`, the engine's
 * declaration) plus one each, so a table that ignored the stage rule could not pass: the brief's `{2, 0}` IS badminton's
 * own pay and would have been green with the rule never read.
 */
async function w2cStagePointsWalkoverChecks(owner: Session): Promise<void> {
  const own = (badminton.configSchema.parse(badminton.variants.short) as { pointsMap?: Record<string, [number, number]> }).pointsMap?.["*"];
  const forfeit = { winnerPoints: (own?.[0] ?? 0) + 1, loserPoints: (own?.[1] ?? 0) + 1 };
  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2c Stage Points ${tag}` }),
  );
  const divId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: "W2c Points", sport_key: "badminton", variant_key: "short" }),
  )?.id;
  const entrants = v1data<{ id: string }[] | undefined>(
    await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
      ["Dee", "Eli"].map((n, i) => ({ kind: "individual", display_name: `${n} ${tag}`, seed: i + 1 }))),
  ) ?? [];
  const stageId = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: "Points Pool" }),
  )?.id;
  const points = { win: { regulation: own?.[0] ?? 0 }, draw: 0, loss: { regulation: own?.[1] ?? 0 }, shootoutAs: "result", unit: "whole", forfeit };
  const put = await v1(owner, `/api/v1/stages/${stageId}/rules`, "PUT", { points });
  const stored = (put.json.data as { points?: { forfeit?: unknown } | null } | undefined)?.points?.forfeit;
  check(
    "w2c: a league stage saves its own points with a forfeit row through the stage rules endpoint" +
      (put.status === 200 && isDeepStrictEqual(stored, forfeit) ? "" : ` — got ${put.status} ${JSON.stringify(put.json.error ?? put.json.data)}`),
    own !== undefined && put.status === 200 && isDeepStrictEqual(stored, forfeit),
  );
  const generated = v1data<{ fixtures: { id: string }[] } | undefined>(await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST"))?.fixtures ?? [];
  const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
  const fixtureId = generated[0]?.id ?? "";
  const fx = v1data<{ home_entrant_id: string | null; away_entrant_id: string | null } | undefined>(await v1(owner, `/api/v1/fixtures/${fixtureId}`));
  const walkover = await v1(owner, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.forfeit",
    payload: { by: fx?.away_entrant_id, reason: "walkover" },
  });
  type Row = { entrantId: string; points: number };
  const rowsNow = async () => v1data<{ rows?: Row[] } | undefined>(await v1(owner, `/api/v1/stages/${stageId}/standings`))?.rows ?? [];
  const paid = (rows: readonly Row[]) =>
    rows.find((r) => r.entrantId === fx?.home_entrant_id)?.points === forfeit.winnerPoints &&
    rows.find((r) => r.entrantId === fx?.away_entrant_id)?.points === forfeit.loserPoints;
  // The table is a snapshot the append refreshes; a bounded poll, its reads counted, never a fixed sleep.
  let rows = await rowsNow();
  let reads = 1;
  for (; reads < 20 && !paid(rows); reads++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    rows = await rowsNow();
  }
  const ok =
    entrants.length === 2 && generated.length === 1 && started.status < 300 && walkover.status === 201 && rows.length === 2 && paid(rows);
  check(
    `w2c: stage points walkover pays the forfeit row (${forfeit.winnerPoints}-${forfeit.loserPoints}; the division's own walkover pays ${JSON.stringify(own)})` +
      (ok
        ? ""
        : ` — got ${entrants.length} entrant(s), ${generated.length} fixture(s), start ${started.status}, forfeit ${walkover.status} ${JSON.stringify(walkover.json.error ?? null)}, ${rows.length} row(s) ${JSON.stringify(rows.map((r) => [r.entrantId === fx?.home_entrant_id ? "home" : "away", r.points]))} after ${reads} read(s)`),
    ok,
  );
}

/**
 * W2c Task 16 (X-SR-1 public half, spec items 12-13, carried M4) - over real HTTP, read ANONYMOUSLY: a public hockey
 * division's knockout stage, created with its sport's preset (a shoot-out), is NAMED on the division page's stage chip
 * and in the hub document, in the org's words - the period line from the variant's own config ("4 quarters of 15 min")
 * and how a tie ends from the preset ("shoot-out (5 each)"). Hockey is a family the old four-sport gate never described.
 * Every number is read from the engine's own declarations and every word from the en dictionary on disk. The league
 * stage beside it plays the division's own format, so it gets no chip: exactly one chip, the knockout's. The attribute
 * is anchored on `="` (AGENTS.md: React serialises an omitted prop as "$undefined").
 */
async function w2cPublicStageFormatChecks(owner: Session, orgId: string): Promise<void> {
  const pub = JSON.parse(
    readFileSync(new URL("../apps/web/src/dictionaries/en/public.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  const fill = (template: string | undefined, params: Record<string, number>): string =>
    (template ?? "<missing key>").replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]));
  const variant = "fih-outdoor";
  const division = hockey.configSchema.parse(hockey.variants[variant]) as { periods: { count: number; minutes: number } };
  const preset = stageDefaultsFor(hockey as AnySportModule, "knockout", variant) as { shootout: { attempts: number } };
  // The period word is the declared count's (4 -> quarters); the numbers differ from each other, so a swapped pair fails.
  const periods = fill(pub["format.rules.period.quarters"], { minutes: division.periods.minutes });
  const shootout = fill(pub["format.rules.decider.shootout"], { n: preset.shootout.attempts });
  const sentence = `${periods}, ${shootout}`;

  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === orgId)?.slug ?? "";
  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2c Public Stage Format ${tag}`, visibility: "public" }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: "W2c Hockey Cup", sport_key: "hockey", variant_key: variant }),
  );
  await v1(
    owner,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    // Hockey takes team entrants only.
    ["Dee", "Eli", "Fay", "Gus"].map((n, i) => ({ kind: "team", display_name: `${n} ${tag}`, seed: i + 1 })),
  );
  const league = v1data<{ id: string }>(await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "Pool" }));
  const cup = v1data<{ id: string }>(await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 2, kind: "knockout", name: "Cup" }));
  await v1(owner, `/api/v1/stages/${league.id}/generate`, "POST");
  await v1(owner, `/api/v1/stages/${cup.id}/generate`, "POST");
  const started = await v1(owner, `/api/v1/divisions/${div.id}/start`, "POST");

  const anon = newSession();
  const page = await html(anon, `/shared/${orgSlug}/${comp.slug}/${div.slug}`);
  const chips = page.body.split(`data-testid="division-stage-format"`).length - 1;
  const hub = v1data<{ divisions?: { slug: string; stageFormatLines?: { stageName: string; line: { key: string }[] }[] }[] } | undefined>(
    await v1(anon, `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/hub`),
  );
  const hubLines = hub?.divisions?.find((d) => d.slug === div.slug)?.stageFormatLines ?? [];
  const ok =
    started.status === 200 &&
    page.status === 200 &&
    chips === 1 &&
    page.body.includes(sentence) &&
    hubLines.length === 1 &&
    hubLines[0].stageName === "Cup" &&
    hubLines[0].line.map((c) => c.key).join() === "format.rules.period.quarters,format.rules.decider.shootout";
  check(
    "w2c: the public division page states a hockey stage's format" +
      (ok ? "" : ` - start ${started.status}, page ${page.status}, ${chips} chip(s), "${sentence}" ${page.body.includes(sentence) ? "present" : "absent"}, hub ${JSON.stringify(hubLines)}`),
    ok,
  );
}

/**
 * W2c Task 16b (X-WO-1 B, Task 9 P-3 "A") - over real HTTP: a football pool whose points rule awards a walkover score gives
 * ONE number everywhere. The away side's walkover is recorded with `core.forfeit` and nothing is played, so the console's
 * stored summary (`GET /fixtures/{id}/state`), the hub's results card (read anonymously) and the stage table's goals-for /
 * goals-against all say the RULE's award - never the division's own walkover goals, which the same headline said before.
 * Both numbers come from the engine's declarations: the division's is football's `awardScore.goals` for the variant, the
 * rule's is that figure plus 4 for the winner and 1 for the side that did not turn up, so the right answer differs from the
 * wrong one's constant on both figures. A second match, played to a score and then retired, keeps the sport's own credit:
 * its stored summary equals the same three events' in a twin pool of the division that carries no points rule.
 */
async function w2cWalkoverHeadlineChecks(owner: Session, orgId: string): Promise<void> {
  const football = builtinModules.find((m) => m.key === "football") as AnySportModule;
  const variant = "11-a-side";
  const divisionGoals = (football.configSchema.parse(football.variants[variant]) as { awardScore: { goals: number } }).awardScore.goals;
  const award: [number, number] = [divisionGoals + 4, 1];
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === orgId)?.slug ?? "";
  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2c Walkover Headline ${tag}`, visibility: "public" }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: "W2c Football", sport_key: "football", variant_key: variant }),
  );
  await v1(
    owner,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    ["Dee", "Eli", "Fay", "Gus"].map((n, i) => ({ kind: "team", display_name: `${n} ${tag}`, seed: i + 1 })),
  );
  const stage = v1data<{ id: string }>(await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "Pool" }));
  const put = await v1(owner, `/api/v1/stages/${stage.id}/rules`, "PUT", {
    points: { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 3, loserPoints: 0, awardScore: award } },
  });
  // The twin: a second pool over the same entrants with NO points rule - the same ledger read without an award.
  const twinStage = v1data<{ id: string }>(await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 2, kind: "league", name: "Pool B" }));
  const generated = v1data<{ fixtures: { id: string }[] }>(await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST")).fixtures;
  const twinGenerated = v1data<{ fixtures: { id: string }[] }>(await v1(owner, `/api/v1/stages/${twinStage.id}/generate`, "POST")).fixtures;
  const started = await v1(owner, `/api/v1/divisions/${div.id}/start`, "POST");
  const fixtureId = generated[0]?.id ?? "";
  const fx = v1data<{ home_entrant_id: string; away_entrant_id: string }>(await v1(owner, `/api/v1/fixtures/${fixtureId}`));
  const walkover = await v1(owner, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.forfeit",
    payload: { by: fx.away_entrant_id, reason: "walkover" },
  });

  const lines = [String(award[0]), String(award[1])];
  const state = v1data<{ summary: { headline: string; perSide: { line: string }[] } }>(await v1(owner, `/api/v1/fixtures/${fixtureId}/state`));
  const consoleOk = isDeepStrictEqual(state.summary.perSide.map((p) => p.line), lines) && state.summary.headline === `${lines[0]} — ${lines[1]}`;

  const hub = v1data<{ matches?: { fixtureId: string; header: { scoreLines: (string | null)[] } }[] } | undefined>(
    await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/hub`),
  );
  const card = hub?.matches?.find((m) => m.fixtureId === fixtureId);
  const hubOk = isDeepStrictEqual(card?.header.scoreLines, lines);

  type Row = { entrantId: string; metrics: { gf?: number; ga?: number } };
  const table = async () => v1data<{ rows?: Row[] } | undefined>(await v1(owner, `/api/v1/stages/${stage.id}/standings`))?.rows ?? [];
  const credited = (rows: readonly Row[]) => {
    const home = rows.find((r) => r.entrantId === fx.home_entrant_id)?.metrics;
    const away = rows.find((r) => r.entrantId === fx.away_entrant_id)?.metrics;
    return home?.gf === award[0] && home?.ga === award[1] && away?.gf === award[1] && away?.ga === award[0];
  };
  // The table is a snapshot the append refreshes; a bounded poll, its reads counted, never a fixed sleep.
  let rows = await table();
  let reads = 1;
  for (; reads < 20 && !credited(rows); reads++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    rows = await table();
  }
  const tableOk = credited(rows);

  const ok =
    put.status === 200 && started.status === 200 && generated.length > 0 && walkover.status === 201 && consoleOk && hubOk && tableOk && award[0] !== divisionGoals;
  check(
    `w2c: a walkover under a stage points rule reads ${award[0]}-${award[1]} on the console, the results list and the table (the division's own is ${divisionGoals}-0)` +
      (ok
        ? ""
        : ` - rules ${put.status} ${JSON.stringify(put.json.error ?? null)}, start ${started.status}, forfeit ${walkover.status} ${JSON.stringify(walkover.json.error ?? null)}, console ${JSON.stringify(state.summary)}, hub ${JSON.stringify(card?.header.scoreLines)}, table ${JSON.stringify(rows.map((r) => [r.entrantId === fx.home_entrant_id ? "home" : "away", r.metrics.gf, r.metrics.ga]))} after ${reads} read(s)`),
    ok,
  );

  // P-3 "A": a match played to a score and then retired keeps the sport's own credit - the rule's award is for a forfeit with
  // nothing played. The same three events go to a fixture of the rule's pool and of the twin pool (no rule): the stored
  // summaries must be identical, and neither may be the rule's award.
  const playThenRetire = async (id: string) => {
    const f = v1data<{ home_entrant_id: string; away_entrant_id: string }>(await v1(owner, `/api/v1/fixtures/${id}`));
    const send = (expectedSeq: number, type: string, payload: unknown) => v1(owner, `/api/v1/fixtures/${id}/events`, "POST", { expected_seq: expectedSeq, type, payload });
    const statuses = [
      (await send(0, "core.start", {})).status,
      (await send(1, "football.goal", { by: f.home_entrant_id })).status,
      (await send(2, "core.forfeit", { by: f.away_entrant_id, reason: "retired" })).status,
    ];
    const st = v1data<{ summary: { headline: string; perSide: { line: string }[] } }>(await v1(owner, `/api/v1/fixtures/${id}/state`));
    return { statuses, lines: st.summary.perSide.map((p) => p.line) };
  };
  const ruled = await playThenRetire(generated[1]?.id ?? "");
  const twin = await playThenRetire(twinGenerated[0]?.id ?? "");
  const retiredOk =
    [...ruled.statuses, ...twin.statuses].every((c) => c === 201) &&
    ruled.lines.length === 2 &&
    isDeepStrictEqual(ruled.lines, twin.lines) &&
    !isDeepStrictEqual(ruled.lines, lines);
  check(
    `w2c: a match played then retired keeps the sport's own credit under a stage points rule (the rule's ${award[0]}-${award[1]} is for a walkover with nothing played)` +
      (retiredOk ? "" : ` - rule pool ${JSON.stringify(ruled)}, twin pool ${JSON.stringify(twin)}, rule's award ${JSON.stringify(lines)}`),
    retiredOk,
  );
}

/**
 * W2c Task 12 fix round 1 — over real HTTP. R-T12-1: an iihf knockout created with `{overtime: false, shootout: false}`
 * is 201 and stored as sent (a stage's `false` is OFF for a period sport's deciders), while `{periods: false}` is refused
 * 422 CONFIG_INVALID (`false` is not off for a key that is no decider). R-T12-2: a cricket t20 knockout stores its preset
 * super over; `PATCH` the division's variant to `test` lands 200 and re-seeds the stage to the test match's knockout
 * preset (none), and the change back writes it again. Every expected preset is the engine's (`stageDefaultsFor`).
 */
async function w2cStageOffAndReseedChecks(owner: Session): Promise<void> {
  const ih = builtinModules.find((m) => m.key === "icehockey") as AnySportModule;
  const ck = builtinModules.find((m) => m.key === "cricket") as AnySportModule;
  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2c Deciders Off ${tag}` }),
  );
  const ihDiv = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: "W2c IH KO", sport_key: "icehockey", variant_key: "iihf" }),
  );
  const off = await v1(owner, `/api/v1/divisions/${ihDiv?.id}/stages`, "POST", {
    seq: 1, kind: "knockout", name: "Off", config: { rules: { overtime: false, shootout: false } },
  });
  const offRules = (v1data<{ config?: { rules?: Record<string, unknown> } } | undefined>(off))?.config?.rules;
  const offWanted = { ...stageDefaultsFor(ih, "knockout", "iihf"), overtime: false, shootout: false };
  const offStored = off.status === 201 && isDeepStrictEqual(offRules, offWanted);
  check(
    "w2c: an ice-hockey knockout switches its overtime and shoot-out off with false" +
      (offStored ? "" : ` — got ${off.status} ${JSON.stringify(offRules ?? off.json.error)}`),
    offStored,
  );
  const periods = await v1(owner, `/api/v1/divisions/${ihDiv?.id}/stages`, "POST", {
    seq: 2, kind: "knockout", name: "Periods", config: { rules: { periods: false } },
  });
  const periodsRefused = periods.status === 422 && periods.json.error?.code === "CONFIG_INVALID";
  check(
    "w2c: false on a key that is no decider (ice-hockey periods) is refused CONFIG_INVALID" +
      (periodsRefused ? "" : ` — got ${periods.status} ${JSON.stringify(periods.json.error ?? periods.json.data)}`),
    periodsRefused,
  );

  const ckDiv = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: "W2c CK KO", sport_key: "cricket", variant_key: "t20" }),
  );
  const ko = await v1(owner, `/api/v1/divisions/${ckDiv?.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup" });
  const rulesNow = async () =>
    (v1data<{ seq: number; config: { rules?: Record<string, unknown> } }[] | undefined>(await v1(owner, `/api/v1/divisions/${ckDiv?.id}/stages`)) ?? [])
      .find((s) => s.seq === 1)?.config.rules;
  const t20Preset = stageDefaultsFor(ck, "knockout", "t20");
  const testPreset = stageDefaultsFor(ck, "knockout", "test");
  const seeded = await rulesNow();
  const toTest = await v1(owner, `/api/v1/divisions/${ckDiv?.id}`, "PATCH", { variant_key: "test" });
  const afterTest = await rulesNow();
  // An empty preset is stored as no rules at all (the stage inherits everything).
  const asStored = (p: Record<string, unknown>) => (Object.keys(p).length === 0 ? undefined : p);
  const reseeded =
    ko.status === 201 && t20Preset.superOver === true && isDeepStrictEqual(seeded, t20Preset) &&
    toTest.status === 200 && isDeepStrictEqual(afterTest, asStored(testPreset));
  check(
    "w2c: a division variant change re-seeds an unstarted knockout's preset (t20 -> test drops the super over)" +
      (reseeded ? "" : ` — got ${ko.status}/${toTest.status} ${JSON.stringify({ seeded, afterTest, error: toTest.json.error })}`),
    reseeded,
  );
  const back = await v1(owner, `/api/v1/divisions/${ckDiv?.id}`, "PATCH", { variant_key: "t20" });
  const afterBack = await rulesNow();
  const rewritten = back.status === 200 && isDeepStrictEqual(afterBack, t20Preset);
  check(
    "w2c: the change back (test -> t20) writes the super over again" +
      (rewritten ? "" : ` — got ${back.status} ${JSON.stringify({ afterBack, error: back.json.error })}`),
    rewritten,
  );
}

/**
 * W2c Task 12 (X-SR-6, SC-P8) — over real HTTP: a football knockout created with no rules is stored with football's
 * knockout preset (extra time, penalties, the kick count), read back off `GET /stages`; a second one created with
 * `config.rules` keeps the organiser's choice over it; and a top-level `shootout` is refused 400 naming where it moved.
 * The expected preset is the engine's (`stageDefaultsFor`), never typed here.
 */
async function w2cStagePresetChecks(owner: Session): Promise<void> {
  const football = builtinModules.find((m) => m.key === "football") as AnySportModule;
  const preset = stageDefaultsFor(football, "knockout", "11-a-side");
  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2c Presets ${tag}` }),
  );
  const div = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", { name: "W2c KO", sport_key: "football", variant_key: "11-a-side" }),
  );
  const created = await v1(owner, `/api/v1/divisions/${div?.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup" });
  const off = await v1(owner, `/api/v1/divisions/${div?.id}/stages`, "POST", { seq: 2, kind: "knockout", name: "Plate", config: { rules: { shootout: false } } });
  const listed = v1data<{ seq: number; config: { rules?: Record<string, unknown> } }[] | undefined>(await v1(owner, `/api/v1/divisions/${div?.id}/stages`)) ?? [];
  const cup = listed.find((s) => s.seq === 1)?.config.rules;
  const plate = listed.find((s) => s.seq === 2)?.config.rules;
  // jsonb keeps its own key order, so the comparison is structural, never JSON.stringify's.
  const stored = created.status === 201 && isDeepStrictEqual(cup, preset) && cup?.shootout === true;
  check(
    "w2c: a new knockout stage stores its sport's deciders" + (stored ? "" : ` — got ${created.status} ${JSON.stringify(cup ?? created.json.error)}`),
    stored,
  );
  const kept = off.status === 201 && isDeepStrictEqual(plate, { ...preset, shootout: false });
  check(
    "w2c: a knockout created with config.rules keeps the organiser's choice over the preset" + (kept ? "" : ` — got ${off.status} ${JSON.stringify(plate ?? off.json.error)}`),
    kept,
  );
  const top = await v1(owner, `/api/v1/divisions/${div?.id}/stages`, "POST", { seq: 3, kind: "knockout", name: "Old", config: { shootout: true } });
  const refused = top.status === 400 && JSON.stringify(top.json.error ?? {}).includes("config.rules");
  check(
    "w2c: a top-level stage shootout is refused, naming config.rules" + (refused ? "" : ` — got ${top.status} ${JSON.stringify(top.json.error ?? top.json.data)}`),
    refused,
  );
}

/**
 * W2c Task 11 (X-SR-1) — `PUT /stages/{id}/rules` is every sport's door now, over real HTTP: one division and one
 * league stage per registered sport, saving the first stage key the ENGINE declares for it (`stageTopKeysFor`) at the
 * value its own schema gives the variant. Then the two cases the old four-sport gate could not reach: a hockey league
 * stage that keeps a fourth-quarter result on abandon (`q4_stands`), and a chess knockout stage that saves an EMPTY
 * rung list, "held for the organiser" (carry I2: the merge stores an explicit []).
 */
async function w2cStageRulesEverySportChecks(owner: Session): Promise<void> {
  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2c Every Sport ${tag}` }),
  );
  const stageFor = async (m: AnySportModule, variant: string, kind: "league" | "knockout", n: number) => {
    const div = await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: `W2c ${m.key} ${kind} ${n}`,
      sport_key: m.key,
      variant_key: variant,
      // generic has no all-default config: the variant's own declared one, as the engine states it.
      config: m.variants[variant] as Record<string, unknown>,
    });
    const divId = v1data<{ id: string } | undefined>(div)?.id;
    const stage = await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind, name: `S ${m.key}` });
    return { div, stage, stageId: v1data<{ id: string } | undefined>(stage)?.id };
  };

  const failures: string[] = [];
  let saved = 0;
  for (const [n, m] of builtinModules.entries()) {
    const variant = Object.keys(m.variants)[0];
    const base = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
    const key = [...stageTopKeysFor(m, "league", variant)].find((k) => base[k] !== undefined);
    if (key === undefined) {
      failures.push(`${m.key}: the engine declares no stage key with a value to save`);
      continue;
    }
    const { div, stage, stageId } = await stageFor(m, variant, "league", n);
    const put = await v1(owner, `/api/v1/stages/${stageId}/rules`, "PUT", { rules: { [key]: base[key] } });
    const got = (put.json.data as { rules?: Record<string, unknown> } | undefined)?.rules;
    if (div.status === 201 && stage.status === 201 && put.status === 200 && JSON.stringify(got?.[key]) === JSON.stringify(base[key])) saved++;
    else failures.push(`${m.key}.${key}: division ${div.status}, stage ${stage.status}, PUT ${put.status} ${JSON.stringify(put.json.error ?? got)}`);
  }
  check(
    `w2c: every sport accepts its stage keys (${saved} of ${builtinModules.length} sports saved one over HTTP)` +
      (failures.length === 0 ? "" : ` — ${failures.join("; ")}`),
    builtinModules.length > 0 && saved === builtinModules.length && failures.length === 0,
  );

  // Hockey, the sport whose league stage the old gate could not reach: a fourth-quarter result stands on abandon.
  const hk = builtinModules.find((m) => m.key === "hockey") as AnySportModule;
  const hkVariant = Object.keys(hk.variants)[0];
  const hockeyStage = await stageFor(hk, hkVariant, "league", 100);
  const q4 = await v1(owner, `/api/v1/stages/${hockeyStage.stageId}/rules`, "PUT", { rules: { abandonPolicy: "q4_stands" } });
  const q4Rules = (q4.json.data as { rules?: { abandonPolicy?: unknown } } | undefined)?.rules;
  check(
    "w2c: a hockey stage saves q4_stands" +
      (q4.status === 200 && q4Rules?.abandonPolicy === "q4_stands" ? "" : ` — got ${q4.status} ${JSON.stringify(q4.json.error ?? q4.json.data)}`),
    q4.status === 200 && q4Rules?.abandonPolicy === "q4_stands",
  );

  // Chess (the boardgame sport), a knockout: an explicit empty rung list is a value the merge stores, and a SECOND save
  // that leaves it out keeps it (carry I2) - made over HTTP below, not assumed.
  const bg = builtinModules.find((m) => m.key === "boardgame") as AnySportModule;
  const bgVariant = Object.keys(bg.variants)[0];
  const chessStage = await stageFor(bg, bgVariant, "knockout", 101);
  const empty = await v1(owner, `/api/v1/stages/${chessStage.stageId}/rules`, "PUT", { rules: { tiebreakRungs: [] } });
  const emptyRules = (empty.json.data as { rules?: { tiebreakRungs?: unknown } } | undefined)?.rules;
  const emptyKept = JSON.stringify(emptyRules?.tiebreakRungs) === "[]";
  // The second save names another key and omits the rung list: the merge keeps the list (an omitted key is kept) and
  // adds the key. Under the old replace semantics the list would be gone.
  const second = await v1(owner, `/api/v1/stages/${chessStage.stageId}/rules`, "PUT", { rules: { variant: "rapid" } });
  const secondRules = (second.json.data as { rules?: Record<string, unknown> } | undefined)?.rules;
  const survived = second.status === 200 && JSON.stringify(secondRules?.tiebreakRungs) === "[]" && secondRules?.variant === "rapid";
  check(
    "w2c: a chess knockout stage saves an empty rung list" +
      (empty.status === 200 && emptyKept ? "" : ` — got ${empty.status} ${JSON.stringify(empty.json.error ?? empty.json.data)}`),
    empty.status === 200 && emptyKept,
  );
  check(
    "w2c: a second save of another key keeps the empty rung list (the merge)" +
      (survived ? "" : ` — got ${second.status} ${JSON.stringify(second.json.error ?? second.json.data)}`),
    survived,
  );
}

/**
 * W2c Task 14 (X-SR-2, X-SR-5) — `PUT /fixtures/{id}/rules`, the one override writer, on the seed's STARTED match (only
 * a `core.start` recorded, so any format fits): a live correction to best of 5 answers `started` with a bumped
 * `rules_version`, and the state every reader serves was refolded under it. Then the match is walked over and
 * finalized, and the same PUT is 409 FIXTURE_FORMAT_LOCKED. First (fix round 1), the same PUT on one of the pool's
 * UNSTARTED matches: 200 `started: false`, bumped once (W2c Task 15 fix round 1, I-1: a write that moves an unstarted
 * match's format moves its version, so a pad open on it is refused), and once that match starts, the cfg it froze is
 * its own format.
 */
async function w2cFixtureRulesChecks(owner: Session, fixtureId: string, unstartedId: string): Promise<void> {
  const own = await v1(owner, `/api/v1/fixtures/${unstartedId}/rules`, "PUT", { rules: { bestOf: 1 } });
  const ownOut = own.json.data as { fixtures?: { id: string; started: boolean; rules_version: number }[] } | undefined;
  // An unstarted match has no fold to read until it starts: its first event freezes the cfg it resolves to.
  const begun = await v1(owner, `/api/v1/fixtures/${unstartedId}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  const ownState = v1data<{ state: { cfg?: { bestOf?: unknown } } | null }>(await v1(owner, `/api/v1/fixtures/${unstartedId}/state`));
  const ownSaved =
    own.status === 200 &&
    ownOut?.fixtures?.[0]?.started === false &&
    ownOut.fixtures[0].rules_version === 1 &&
    begun.status === 201 &&
    ownState.state?.cfg?.bestOf === 1;
  check(
    "w2c: an unstarted match's own format saves (200), and the match plays it once started" +
      (ownSaved
        ? ""
        : ` — got ${own.status} ${JSON.stringify(own.json.error ?? own.json.data)}, start ${begun.status}, state cfg bestOf ${String(ownState.state?.cfg?.bestOf)}`),
    ownSaved,
  );

  const put = await v1(owner, `/api/v1/fixtures/${fixtureId}/rules`, "PUT", { rules: { bestOf: 5 } });
  const wrote = put.json.data as { fixtures?: { id: string; started: boolean; rules_version: number }[] } | undefined;
  const state = v1data<{ state: { cfg?: { bestOf?: unknown } } | null; last_seq: number }>(
    await v1(owner, `/api/v1/fixtures/${fixtureId}/state`),
  );
  const saved =
    put.status === 200 && wrote?.fixtures?.[0]?.started === true && wrote.fixtures[0].rules_version === 1 && state.state?.cfg?.bestOf === 5;
  check(
    "w2c: a match override saves and the pad cfg shows it" +
      (saved ? "" : ` — got ${put.status} ${JSON.stringify(put.json.error ?? put.json.data)}, state cfg bestOf ${String(state.state?.cfg?.bestOf)}`),
    saved,
  );

  // `expected_seq` is the last seq the caller has seen (the state's `last_seq`), as every v1 append in this file sends.
  const fx = v1data<{ away_entrant_id: string }>(await v1(owner, `/api/v1/fixtures/${fixtureId}`));
  const forfeit = await v1(owner, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.last_seq,
    type: "core.forfeit",
    payload: { by: fx.away_entrant_id, reason: "walkover" },
  });
  const lastSeq = v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${fixtureId}/state`)).last_seq;
  const finalize = await v1(owner, `/api/v1/fixtures/${fixtureId}/finalize`, "POST", { expected_seq: lastSeq });
  const locked = await v1(owner, `/api/v1/fixtures/${fixtureId}/rules`, "PUT", { rules: { bestOf: 3 } });
  // POST /finalize answers 200 (the events API's append is the 201).
  const refused =
    forfeit.status === 201 && finalize.status === 200 && locked.status === 409 && locked.json.error?.code === "FIXTURE_FORMAT_LOCKED";
  check(
    "w2c: a finished match's format is locked" +
      (refused
        ? ""
        : ` — forfeit ${forfeit.status}, finalize ${finalize.status}, PUT ${locked.status} ${JSON.stringify(locked.json.error ?? locked.json.data)}`),
    refused,
  );
}

/**
 * A badminton `short` division with ONE league stage, "Pool A", generated, the division started, and one of its
 * fixtures started through the v1 events API — so exactly one stage has started. The call shapes are
 * `stageRulesFormatSmoke`'s (competition, division, entrants, stage, generate, start) and the v1 scoring append's
 * (`expected_seq: 0`, a flat `type`/`payload`). Scoring before the division starts is 422 WRONG_PHASE, hence `start`.
 */
async function w2cSeedStartedPool(owner: Session): Promise<{ divisionId: string; fixtureId: string; unstartedId: string }> {
  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W2c Smoke ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "W2c Singles",
      sport_key: "badminton",
      variant_key: "short",
    }),
  );
  await v1(
    owner,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    // Three, so the pool has matches beside the started one (the unstarted override check's).
    ["Ana", "Ben", "Cal"].map((n, i) => ({ kind: "individual", display_name: `${n} ${tag}`, seed: i + 1 })),
  );
  const pool = v1data<{ id: string }>(
    await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "Pool A" }),
  );
  const generated = v1data<{ fixtures: { id: string }[] }>(await v1(owner, `/api/v1/stages/${pool.id}/generate`, "POST")).fixtures;
  const fixtureId = generated[0].id;
  const unstartedId = generated[1].id;
  await v1(owner, `/api/v1/divisions/${div.id}/start`, "POST");
  const started = await v1(owner, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  // The premise of every lock check after it: a seed that failed to start the match would turn each into a check of
  // an unstarted division.
  check("w2c seed: Pool A's first match started through the v1 events API (201)", started.status === 201);
  return { divisionId: div.id, fixtureId, unstartedId };
}

/**
 * W2c Task 15 (X-SR-7, owner P-1 "A") — over real HTTP: an open pad's tap after a correction. A started badminton
 * `short` match reads its rules (`GET /fixtures/{id}/rules`, version 0), the organiser corrects it (`PUT …/rules`,
 * version 1), and a tap still sent under version 0 is refused 409 FIXTURE_RULES_CHANGED naming the version that stands —
 * with the ledger's tip unmoved, so nothing was written. The same tap under version 1 lands and its answer carries 1.
 */
async function w2cRulesVersionChecks(owner: Session): Promise<void> {
  const { fixtureId } = await w2cSeedStartedPool(owner);
  const before = await v1(owner, `/api/v1/fixtures/${fixtureId}/rules`);
  const loaded = before.json.data as { rules_version?: number; cfg?: { bestOf?: unknown }; format_line?: unknown } | undefined;
  const put = await v1(owner, `/api/v1/fixtures/${fixtureId}/rules`, "PUT", { rules: { bestOf: 5 } });
  const tip = v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${fixtureId}/state`)).last_seq;
  const tap = { expected_seq: tip, type: "badminton.game.summary", payload: { home: 11, away: 5 } };
  const stale = await v1(owner, `/api/v1/fixtures/${fixtureId}/events`, "POST", { ...tap, rules_version: loaded?.rules_version ?? 0 });
  const tipAfter = v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${fixtureId}/state`)).last_seq;
  const refused =
    before.status === 200 &&
    loaded?.rules_version === 0 &&
    put.status === 200 &&
    stale.status === 409 &&
    stale.json.error?.code === "FIXTURE_RULES_CHANGED" &&
    (stale.json.error as { rules_version?: unknown } | undefined)?.rules_version === 1 &&
    tipAfter === tip;
  check(
    "w2c: a stale rules version is refused and writes nothing" +
      (refused
        ? ""
        : ` — GET ${before.status} v${String(loaded?.rules_version)}, PUT ${put.status}, POST ${stale.status} ${JSON.stringify(stale.json.error ?? stale.json.data)}, tip ${tip}→${tipAfter}`),
    refused,
  );
  const fresh = await v1(owner, `/api/v1/fixtures/${fixtureId}/events`, "POST", { ...tap, rules_version: 1 });
  const now = await v1(owner, `/api/v1/fixtures/${fixtureId}/rules`);
  const landed =
    fresh.status === 201 &&
    (fresh.json.data as { rules_version?: unknown } | undefined)?.rules_version === 1 &&
    (now.json.data as { cfg?: { bestOf?: unknown } } | undefined)?.cfg?.bestOf === 5;
  check(
    "w2c: the same tap under the current rules version lands, and the rules read back corrected" +
      (landed ? "" : ` — POST ${fresh.status} ${JSON.stringify(fresh.json.error ?? fresh.json.data)}, GET cfg ${JSON.stringify(now.json.data)}`),
    landed,
  );
}

/**
 * W2c Task 15 fix round 1 (review I-1) — over real HTTP, BEFORE kickoff: a pad opened on an UNSTARTED match reads its
 * rules (version 0), the organiser corrects that match's own format (`PUT …/rules`, which now bumps it), and the pad's
 * FIRST tap, still under version 0, is refused 409 FIXTURE_RULES_CHANGED with nothing written and nothing frozen. The
 * first tap under the version it reloads lands and freezes the corrected format.
 */
async function w2cRulesVersionPreKickoffChecks(owner: Session): Promise<void> {
  const { unstartedId } = await w2cSeedStartedPool(owner);
  const before = await v1(owner, `/api/v1/fixtures/${unstartedId}/rules`);
  const loaded = before.json.data as { rules_version?: number; cfg?: { bestOf?: unknown } } | undefined;
  const target = loaded?.cfg?.bestOf === 5 ? 3 : 5;
  const put = await v1(owner, `/api/v1/fixtures/${unstartedId}/rules`, "PUT", { rules: { bestOf: target } });
  const start = { expected_seq: 0, type: "core.start", payload: {} };
  const stale = await v1(owner, `/api/v1/fixtures/${unstartedId}/events`, "POST", { ...start, rules_version: loaded?.rules_version ?? 0 });
  const tipAfter = v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${unstartedId}/state`)).last_seq;
  const refused =
    before.status === 200 &&
    loaded?.rules_version === 0 &&
    put.status === 200 &&
    stale.status === 409 &&
    stale.json.error?.code === "FIXTURE_RULES_CHANGED" &&
    (stale.json.error as { rules_version?: unknown } | undefined)?.rules_version === 1 &&
    tipAfter === 0;
  check(
    "w2c: before kickoff, a correction refuses the open pad's first tap under the old rules version" +
      (refused
        ? ""
        : ` — GET ${before.status} v${String(loaded?.rules_version)}, PUT ${put.status} ${JSON.stringify(put.json.error ?? put.json.data)}, POST ${stale.status} ${JSON.stringify(stale.json.error ?? stale.json.data)}, tip ${tipAfter}`),
    refused,
  );
  const reloaded = await v1(owner, `/api/v1/fixtures/${unstartedId}/rules`);
  const version = (reloaded.json.data as { rules_version?: number } | undefined)?.rules_version;
  const fresh = await v1(owner, `/api/v1/fixtures/${unstartedId}/events`, "POST", { ...start, rules_version: version });
  const state = v1data<{ state: { cfg?: { bestOf?: unknown } } | null }>(await v1(owner, `/api/v1/fixtures/${unstartedId}/state`));
  const landed = version === 1 && fresh.status === 201 && state.state?.cfg?.bestOf === target;
  check(
    "w2c: before kickoff, the first tap under the reloaded rules version lands and freezes the corrected format" +
      (landed ? "" : ` — v${String(version)}, POST ${fresh.status} ${JSON.stringify(fresh.json.error ?? fresh.json.data)}, cfg bestOf ${String(state.state?.cfg?.bestOf)}`),
    landed,
  );
}
