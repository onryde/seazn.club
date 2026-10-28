// W2a bracketFinishSuite: the settle method's outcome name and the chess tie-break rungs, read from the engine's own
// declarations rather than typed. Both entry points load under plain `node --experimental-strip-types` (probed).
// W2b walkoverCreditSuite: the closed award reasons (`AWARD_REASONS`) and two sports' declared cfgs — the games a
// badminton walkover credits and each game's target, hockey's `awardScore` — read the same way (probed too).
import { AWARD_REASONS, type EngineErrorCode, type ForfeitReason } from "@seazn/engine/core";
import { badminton } from "@seazn/engine/sports/setbased";
import { hockey } from "@seazn/engine/sports/hockey";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, type V1Res, v1, v1data } from "../harness.ts";

/**
 * Format matrix W2b (spec §5.2–§5.4, plan Task 18 Step 2): a walkover credits what the sport declares, a double
 * walkover advances nobody, and a withdrawal walks a held line over. Six flows through the real API as the organiser of
 * one fresh community org — a private competition of two-entrant leagues and a PUBLIC competition of 4-entrant
 * knockouts (the hub's champion is a public read):
 *  1. BD-WO-1: a badminton league walkover reaches the table at the games a match needs (⌈bestOf/2⌉), each to the
 *     game's `setTo`, and nothing for the side that defaulted — 2-0 × 21-0 from the declared `bwf` cfg;
 *  2. HK-WO-1: a hockey league walkover reaches the table at `awardScore.goals`-0 — 5-0 from the declared
 *     `fih-outdoor` cfg;
 *  3. X-DW-2: a semi-final's double walkover advances nobody, so the other semi's winner takes the final as a bye award
 *     and is the champion on the public hub — in BOTH orders: the double walkover first (the winner's decision settles
 *     the final), and the other semi first (the final already holds the winner, so the double walkover's own decision
 *     is the one that has to settle it);
 *  4. D19: a final refuses a double walkover 409 DOUBLE_WALKOVER_NO_NEXT_MATCH and is unchanged (the positive pair: one
 *     side's walkover of the same final is accepted);
 *  5. BG-WO-3 / R14: a chess semi drawn into its tie-break (held: the decider is owed) is walked over by the away side's
 *     withdrawal — the cascade reports one held line walked over, the award names who withdrew, and the home side is
 *     seated in the final;
 *  6. X-BL-1: with the table competition at its division cap, archiving the division whose only fixture is a double
 *     walkover refunds its slot (the next create lands), while archiving the one whose only fixture is a single
 *     walkover keeps it spent (the next create is refused 402) — the positive pair, run first.
 * Expected values come from the engine's declarations (the cfgs, `AWARD_REASONS`, the error code), never typed. Every
 * refusal is judged on the body's error code, not only the HTTP status. Every list read states its count, and a zero
 * count fails. Flows 3, 4 and 6 run on the generic sport alone: the double-walkover cascade reads the feed graph and
 * the quota reads `division_has_results`, never the sport — the sport-specific credit is flows 1, 2 and 5.
 */
export async function walkoverCreditSuite(): Promise<void> {
  // `core.forfeit` admits a ForfeitReason only (a "bye" is refused with 422), so the two reasons this suite WRITES are
  // typed narrower than the award reason it only READS back.
  const WALKOVER: ForfeitReason = "walkover";
  const WITHDREW: ForfeitReason = "withdrew";
  const BYE: (typeof AWARD_REASONS)[number] = "bye";
  const declared = [WALKOVER, WITHDREW, BYE].filter((r) => (AWARD_REASONS as readonly string[]).includes(r));
  check(
    `walkover credit: the award reasons this suite writes and reads are the engine's own — ${declared.length} of 3 (${[WALKOVER, WITHDREW, BYE].join(", ")}) in AWARD_REASONS (${AWARD_REASONS.length} declared)`,
    declared.length === 3,
  );
  const QUOTA = "divisions.per_competition.max";
  const featureKey = (r: V1Res) => (r.json.error as { feature_key?: string } | undefined)?.feature_key;

  const owner = newSession();
  const who = await signIn(owner, `delivered+walkovercredit_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";
  const tables = await v1(owner, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Walkover Tables ${tag}`,
    visibility: "private",
  });
  const cups = await v1(owner, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Walkover Cups ${tag}`,
    visibility: "public",
  });
  const tablesId = v1data<{ id: string } | undefined>(tables)?.id ?? "";
  const cupsRow = v1data<{ id: string; slug: string; visibility: string } | undefined>(cups);
  check(
    "walkover credit: a private table competition and a PUBLIC knockout competition are created",
    tables.status === 201 && cups.status === 201 && cupsRow?.visibility === "public" && orgSlug !== "",
  );

  type WcFixture = {
    id: string;
    round_no: number;
    status: string;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    outcome: { kind: string; winner?: string; loser?: string | null; reason?: string } | null;
  };
  type WcRow = { entrantId: string; metrics: Record<string, number> };
  const fixture = async (id: string) => v1data<WcFixture | undefined>(await v1(owner, `/api/v1/fixtures/${id}`));
  // `?.`: a fixture id that never arrived ("") reads no state; the write then carries no seq and is refused, so the check
  // that needed it reds instead of a TypeError ending main() and skipping every later suite.
  const seqOf = async (id: string) =>
    v1data<{ last_seq: number } | undefined>(await v1(owner, `/api/v1/fixtures/${id}/state`))?.last_seq;
  const post = async (id: string, type: string, payload: unknown = {}) =>
    v1(owner, `/api/v1/fixtures/${id}/events`, "POST", { expected_seq: await seqOf(id), type, payload });
  const tableOf = async (stageId: string) =>
    v1data<{ rows?: WcRow[] } | undefined>(await v1(owner, `/api/v1/stages/${stageId}/standings`))?.rows ?? [];
  const metricsOf = (rows: readonly WcRow[], entrant: string | null | undefined, keys: readonly string[]) => {
    const row = rows.find((r) => r.entrantId === entrant);
    return row ? keys.map((k) => row.metrics[k]) : null;
  };
  /** A read polled within a bound (never a fixed sleep's worth of hope) until `done` holds; the reads are counted. */
  async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<{ value: T; reads: number }> {
    let value = await read();
    let reads = 1;
    for (let tries = 0; tries < 20 && !done(value); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      value = await read();
      reads++;
    }
    return { value, reads };
  }
  const GENERIC = { sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } };
  const mkDiv = (competitionId: string, name: string) =>
    v1(owner, `/api/v1/competitions/${competitionId}/divisions`, "POST", { name, ...GENERIC });

  /** A started division of `count` entrants with one generated `stageKind` stage. */
  async function division(
    competitionId: string,
    label: string,
    sport: Record<string, unknown>,
    kind: "individual" | "team",
    stageKind: "league" | "knockout",
    count: number,
  ) {
    const div = await v1(owner, `/api/v1/competitions/${competitionId}/divisions`, "POST", { name: label, ...sport });
    const divId = v1data<{ id: string } | undefined>(div)?.id ?? "";
    const names = Array.from({ length: count }, (_, i) => `${label} ${i + 1} ${tag}`);
    const entrants = await v1(
      owner,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      names.map((display_name, i) => ({ kind, display_name, seed: i + 1 })),
    );
    const ids = (v1data<{ id: string }[] | undefined>(entrants) ?? []).map((e) => e.id);
    const stage = await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: stageKind, name: label });
    const stageId = v1data<{ id: string } | undefined>(stage)?.id ?? "";
    const generated = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const drawn = v1data<WcFixture[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [];
    const ok =
      div.status === 201 && ids.length === count && stage.status < 300 && generated.status < 300 && started.status < 300;
    return { ok, divId, stageId, drawn };
  }

  /** A started two-entrant league in the table competition: exactly one fixture, both sides seated. */
  async function leagueOfTwo(label: string, sport: Record<string, unknown>, kind: "individual" | "team") {
    const d = await division(tablesId, label, sport, kind, "league", 2);
    const seated = d.drawn.filter((f) => f.home_entrant_id && f.away_entrant_id);
    check(
      `walkover credit (${label}): a two-entrant league is generated and started — ${d.drawn.length} fixture(s) read, ${seated.length} with both sides seated`,
      d.ok && d.drawn.length === 1 && seated.length === 1,
    );
    return { ...d, fx: seated[0] };
  }

  /** A started 4-entrant knockout in the public competition: its two seated semi-finals and its final. */
  async function knockoutOfFour(label: string, sport: Record<string, unknown>) {
    const d = await division(cupsRow?.id ?? "", label, sport, "individual", "knockout", 4);
    const firstRound = Math.min(...d.drawn.map((f) => f.round_no));
    const semis = d.drawn.filter((f) => f.round_no === firstRound && f.home_entrant_id && f.away_entrant_id);
    const finals = d.drawn.filter((f) => f.round_no !== firstRound);
    check(
      `walkover credit (${label}): a 4-entrant knockout is generated and started — ${d.drawn.length} fixture(s) read: ${semis.length} seated semi-final(s), ${finals.length} final(s)`,
      d.ok && d.drawn.length === 3 && semis.length === 2 && finals.length === 1,
    );
    return { ...d, semis, finalId: finals[0]?.id ?? "" };
  }

  /** One side's walkover of a two-entrant league, and both table rows against `want` (home, away) over `keys`. */
  async function leagueWalkover(lg: Awaited<ReturnType<typeof leagueOfTwo>>, keys: readonly string[], want: { home: number[]; away: number[] }) {
    const home = lg.fx?.home_entrant_id;
    const away = lg.fx?.away_entrant_id;
    const write = lg.fx ? await post(lg.fx.id, "core.forfeit", { by: away, reason: WALKOVER }) : undefined;
    const after = lg.fx ? await fixture(lg.fx.id) : undefined;
    const target = JSON.stringify([want.home, want.away]);
    const table = await until(
      () => tableOf(lg.stageId),
      (rows) => JSON.stringify([metricsOf(rows, home, keys), metricsOf(rows, away, keys)]) === target,
    );
    const got = { home: metricsOf(table.value, home, keys), away: metricsOf(table.value, away, keys) };
    const awarded =
      write?.status === 201 &&
      after?.status === "forfeited" &&
      after.outcome?.kind === "award" &&
      after.outcome.winner === home &&
      after.outcome.loser === away &&
      after.outcome.reason === WALKOVER;
    return { write, after, table, got, awarded, matches: JSON.stringify([got.home, got.away]) === target };
  }

  // --- 1. BD-WO-1: a badminton walkover credits the games a match needs, each to the game's target. ---
  const bwf = badminton.configSchema.parse(badminton.variants.bwf);
  const games = Math.ceil(bwf.bestOf / 2);
  const bd = await leagueOfTwo("WC Badminton", { sport_key: "badminton", variant_key: "bwf" }, "individual");
  const bdWo = await leagueWalkover(bd, ["sets_won", "sets_lost", "points_won", "points_lost"], {
    home: [games, 0, games * bwf.setTo, 0],
    away: [0, games, 0, games * bwf.setTo],
  });
  check(
    `walkover credit (badminton): the away side's walkover reaches the table at ${games}-0 in games, each ${bwf.setTo}-0 (the declared bwf cfg: Best of ${bwf.bestOf}) — fixture ${bdWo.after?.status} ${JSON.stringify(bdWo.after?.outcome)}; [games won, lost, points won, lost] home ${JSON.stringify(bdWo.got.home)}, away ${JSON.stringify(bdWo.got.away)} (${bdWo.table.value.length} table row(s), ${bdWo.table.reads} read(s))`,
    games > 0 && bwf.setTo > 0 && bdWo.awarded && bdWo.table.value.length === 2 && bdWo.matches,
  );

  // --- 2. HK-WO-1: a hockey walkover credits `awardScore.goals`-0. ---
  const fih = hockey.configSchema.parse(hockey.variants["fih-outdoor"]);
  const goals = fih.awardScore.goals;
  const hk = await leagueOfTwo("WC Hockey", { sport_key: "hockey", variant_key: "fih-outdoor" }, "team");
  const hkWo = await leagueWalkover(hk, ["gf", "ga"], { home: [goals, 0], away: [0, goals] });
  check(
    `walkover credit (hockey): the away side's walkover reaches the table at ${goals}-0 (the declared fih-outdoor cfg's awardScore) — fixture ${hkWo.after?.status} ${JSON.stringify(hkWo.after?.outcome)}; [goals for, against] home ${JSON.stringify(hkWo.got.home)}, away ${JSON.stringify(hkWo.got.away)} (${hkWo.table.value.length} table row(s), ${hkWo.table.reads} read(s))`,
    goals > 0 && hkWo.awarded && hkWo.table.value.length === 2 && hkWo.matches,
  );

  // --- 3. X-DW-2: a semi's double walkover advances nobody; the other semi's winner is the champion. ---
  const cup = await knockoutOfFour("WC Cup", GENERIC);
  const [cupSf1, cupSf2] = cup.semis;
  const cupDw = cupSf1 ? await post(cupSf1.id, "core.forfeit", { by: "both", reason: WALKOVER }) : undefined;
  const cupDwAfter = cupSf1 ? await fixture(cupSf1.id) : undefined;
  const cupWin = cupSf2 ? await post(cupSf2.id, "generic.result", { p1Score: 2, p2Score: 1 }) : undefined;
  const champion = (cupSf2 ? await fixture(cupSf2.id) : undefined)?.outcome?.winner ?? "";
  const cupFinal = await until(
    () => fixture(cup.finalId),
    (f) => f?.status === "forfeited",
  );
  type WcHub = { knockouts?: { rounds: { fixtureIds: string[] }[]; championFixtureId: string | null }[] };
  const hubPath = `/api/v1/public/orgs/${orgSlug}/competitions/${cupsRow?.slug ?? ""}/hub`;
  const hubKnockouts = async () => v1data<WcHub | undefined>(await v1(newSession(), hubPath))?.knockouts ?? [];
  const hub = await until(hubKnockouts, (kos) =>
    kos.some((k) => k.rounds.some((r) => r.fixtureIds.includes(cup.finalId)) && k.championFixtureId === cup.finalId),
  );
  const cupKo = hub.value.find((k) => k.rounds.some((r) => r.fixtureIds.includes(cup.finalId)));
  const finalOutcome = cupFinal.value?.outcome;
  check(
    `walkover credit (double walkover): a semi's double walkover advances nobody, so the other semi's winner takes the final as a ${BYE} award and is the hub's champion — semi ${cupDw?.status} → ${cupDwAfter?.status} ${JSON.stringify(cupDwAfter?.outcome)}; other semi ${cupWin?.status}; final ${cupFinal.value?.status} ${JSON.stringify(finalOutcome)} (${cupFinal.reads} read(s)); hub champion ${cupKo?.championFixtureId ?? "(none)"} of ${hub.value.length} knockout(s) (${hub.reads} read(s))`,
    cupDw?.status === 201 &&
      cupDwAfter?.status === "forfeited" &&
      cupDwAfter.outcome?.kind === "double_walkover" &&
      cupWin?.status === 201 &&
      champion !== "" &&
      cupFinal.value?.status === "forfeited" &&
      finalOutcome?.kind === "award" &&
      finalOutcome.winner === champion &&
      finalOutcome.loser === null &&
      finalOutcome.reason === BYE &&
      hub.value.length > 0 &&
      cupKo?.championFixtureId === cup.finalId,
  );

  // --- 3b. X-DW-2, the other order: the other semi first, so the double walkover lands beside a half-seated final. ---
  // Above, the winner's own decision ran the cascade that settled the final. Here the final already holds the winner
  // when the double walkover lands, so the double walkover's decision is the only one left to settle it.
  const rev = await knockoutOfFour("WC Cup Reversed", GENERIC);
  const [revSf1, revSf2] = rev.semis;
  const revWin = revSf2 ? await post(revSf2.id, "generic.result", { p1Score: 2, p2Score: 1 }) : undefined;
  const revChampion = (revSf2 ? await fixture(revSf2.id) : undefined)?.outcome?.winner ?? "";
  const revHalf = await until(
    () => fixture(rev.finalId),
    (f) => revChampion !== "" && (f?.home_entrant_id === revChampion || f?.away_entrant_id === revChampion),
  );
  const revSeats = [revHalf.value?.home_entrant_id, revHalf.value?.away_entrant_id];
  // The order's own precondition, its own check: a final that was not half-seated here would make this the DW-first
  // order again, and the outcome below could not tell.
  check(
    `walkover credit (double walkover, the other semi first): before the double walkover the final holds the other semi's winner and one open seat — other semi ${revWin?.status}; final ${revHalf.value?.status} seats ${JSON.stringify(revSeats)} (${revHalf.reads} read(s))`,
    revWin?.status === 201 &&
      revChampion !== "" &&
      revHalf.value?.status === "scheduled" &&
      revSeats.filter((s) => s === revChampion).length === 1 &&
      revSeats.filter((s) => s === null).length === 1,
  );
  const revDw = revSf1 ? await post(revSf1.id, "core.forfeit", { by: "both", reason: WALKOVER }) : undefined;
  const revDwAfter = revSf1 ? await fixture(revSf1.id) : undefined;
  const revFinal = await until(
    () => fixture(rev.finalId),
    (f) => f?.status === "forfeited",
  );
  const revHub = await until(hubKnockouts, (kos) =>
    kos.some((k) => k.rounds.some((r) => r.fixtureIds.includes(rev.finalId)) && k.championFixtureId === rev.finalId),
  );
  const revKo = revHub.value.find((k) => k.rounds.some((r) => r.fixtureIds.includes(rev.finalId)));
  const revOutcome = revFinal.value?.outcome;
  check(
    `walkover credit (double walkover, the other semi first): the double walkover landing beside the half-seated final still gives it to the other semi's winner as a ${BYE} award, the hub's champion — semi ${revDw?.status} → ${revDwAfter?.status} ${JSON.stringify(revDwAfter?.outcome)}; final ${revFinal.value?.status} ${JSON.stringify(revOutcome)} (${revFinal.reads} read(s)); hub champion ${revKo?.championFixtureId ?? "(none)"} of ${revHub.value.length} knockout(s) (${revHub.reads} read(s))`,
    revDw?.status === 201 &&
      revDwAfter?.status === "forfeited" &&
      revDwAfter.outcome?.kind === "double_walkover" &&
      revFinal.value?.status === "forfeited" &&
      revOutcome?.kind === "award" &&
      revOutcome.winner === revChampion &&
      revOutcome.loser === null &&
      revOutcome.reason === BYE &&
      revKo?.championFixtureId === rev.finalId,
  );

  // --- 4. D19: a final refuses a double walkover; one side's walkover of it is accepted. ---
  const NO_NEXT_MATCH: EngineErrorCode = "DOUBLE_WALKOVER_NO_NEXT_MATCH";
  const fin = await knockoutOfFour("WC Final", GENERIC);
  const finWrites: number[] = [];
  for (const sf of fin.semis) finWrites.push((await post(sf.id, "generic.result", { p1Score: 2, p2Score: 1 })).status);
  const seatedFinal = await until(
    () => fixture(fin.finalId),
    (f) => !!f?.home_entrant_id && !!f.away_entrant_id,
  );
  const finBefore = { seq: await seqOf(fin.finalId), fx: seatedFinal.value };
  const finDw = await post(fin.finalId, "core.forfeit", { by: "both", reason: WALKOVER });
  const finAfter = { seq: await seqOf(fin.finalId), fx: await fixture(fin.finalId) };
  check(
    `walkover credit (final): a double walkover of the final is refused 409 ${NO_NEXT_MATCH} (got ${finDw.status} ${finDw.json.error?.code}) and changes nothing — ${finWrites.length} semi result(s), final seated after ${seatedFinal.reads} read(s), seq ${finBefore.seq}→${finAfter.seq}, status ${finBefore.fx?.status}→${finAfter.fx?.status}`,
    finWrites.length === 2 &&
      finWrites.every((s) => s === 201) &&
      !!finBefore.fx?.home_entrant_id &&
      !!finBefore.fx.away_entrant_id &&
      finDw.status === 409 &&
      finDw.json.error?.code === NO_NEXT_MATCH &&
      typeof finBefore.seq === "number" &&
      finAfter.seq === finBefore.seq &&
      finAfter.fx?.status === "scheduled" &&
      finAfter.fx.outcome === null,
  );
  const finWo = await post(fin.finalId, "core.forfeit", { by: finBefore.fx?.away_entrant_id, reason: WALKOVER });
  const finDone = await fixture(fin.finalId);
  check(
    `walkover credit (final, the positive pair): one side's walkover of the same final is accepted (got ${finWo.status}) — ${finDone?.status} ${JSON.stringify(finDone?.outcome)}`,
    finWo.status === 201 &&
      finDone?.status === "forfeited" &&
      finDone.outcome?.kind === "award" &&
      finDone.outcome.winner === finBefore.fx?.home_entrant_id &&
      finDone.outcome.reason === WALKOVER,
  );

  // --- 5. BG-WO-3 / R14: a withdrawal walks a chess semi held on its owed tie-break over. ---
  const chess = await knockoutOfFour("WC Chess", { sport_key: "boardgame", variant_key: "classical" });
  const chessSf = chess.semis[0];
  const staying = chessSf?.home_entrant_id ?? "";
  const leaving = chessSf?.away_entrant_id ?? "";
  const chessWrites: number[] = [];
  if (chessSf) {
    chessWrites.push((await post(chessSf.id, "core.start")).status);
    chessWrites.push((await post(chessSf.id, "boardgame.result", { winner: null, method: "agreement" })).status);
  }
  const chessHeld = chessSf ? await fixture(chessSf.id) : undefined;
  check(
    `walkover credit (chess, BG-WO-3 / R14): a drawn knockout game waiting on its tie-break is held — ${chessWrites.length} write(s) accepted, status ${chessHeld?.status}, outcome ${JSON.stringify(chessHeld?.outcome)}`,
    chessWrites.length === 2 && chessWrites.every((s) => s === 201) && chessHeld?.status === "in_play" && chessHeld.outcome === null,
  );
  const withdraw = leaving !== "" ? await v1(owner, `/api/v1/entrants/${leaving}/withdraw`, "POST") : undefined;
  const cascade = withdraw ? v1data<{ walkovers?: number; walked_over_held?: number } | undefined>(withdraw) : undefined;
  const chessAfter = chessSf ? await fixture(chessSf.id) : undefined;
  const chessSeat = await until(
    () => fixture(chess.finalId),
    (f) => staying !== "" && (f?.home_entrant_id === staying || f?.away_entrant_id === staying),
  );
  check(
    `walkover credit (chess, BG-WO-3 / R14): the away side's withdrawal walks the semi held on its owed tie-break over — withdraw ${withdraw?.status}: ${cascade?.walkovers} walkover(s), ${cascade?.walked_over_held} of them held; semi ${chessAfter?.status} ${JSON.stringify(chessAfter?.outcome)}; the final seats the home side after ${chessSeat.reads} read(s)`,
    withdraw !== undefined &&
      withdraw.status < 300 &&
      cascade?.walkovers === 1 &&
      cascade.walked_over_held === 1 &&
      chessAfter?.status === "forfeited" &&
      chessAfter.outcome?.kind === "award" &&
      chessAfter.outcome.winner === staying &&
      chessAfter.outcome.loser === leaving &&
      chessAfter.outcome.reason === WITHDREW &&
      [chessSeat.value?.home_entrant_id, chessSeat.value?.away_entrant_id].includes(staying),
  );

  // --- 6. X-BL-1: a double walkover's division refunds its quota slot on archive; a single walkover's keeps it. ---
  const dw = await leagueOfTwo("WC Neither", GENERIC, "individual");
  const dwWrite = dw.fx ? await post(dw.fx.id, "core.forfeit", { by: "both", reason: WALKOVER }) : undefined;
  const dwAfter = dw.fx ? await fixture(dw.fx.id) : undefined;
  const ent = (await call(owner, `/api/orgs/${who.org_id}/entitlements`)) as {
    entitlements: Record<string, { limit?: number | null }>;
  };
  const cap = ent.entitlements[QUOTA]?.limit;
  const listed = v1data<{ id: string }[] | undefined>(await v1(owner, `/api/v1/competitions/${tablesId}/divisions`)) ?? [];
  const room = typeof cap === "number" ? cap - listed.length : -1;
  const fillers: number[] = [];
  for (let i = 0; i < room; i++) fillers.push((await mkDiv(tablesId, `WC Filler ${i + 1}`)).status);
  const over = await mkDiv(tablesId, "WC Over");
  check(
    `walkover credit (quota): the table competition is filled to its division cap — cap ${cap}, ${listed.length} division(s) listed (the badminton, hockey and double-walkover leagues), ${fillers.length} filler(s) created, the next create refused ${over.status} ${featureKey(over)}`,
    typeof cap === "number" &&
      listed.length === 3 &&
      room >= 0 &&
      fillers.every((s) => s === 201) &&
      over.status === 402 &&
      featureKey(over) === QUOTA,
  );
  const archive = (divId: string) => v1(owner, `/api/v1/divisions/${divId}/archive`, "POST");
  /** The archive's own row: a 200 alone does not prove the division was archived (an idempotent no-op answers 200). */
  const archivedAt = (r: V1Res) => v1data<{ archived_at?: string | null } | undefined>(r)?.archived_at ?? null;
  const keptArchive = await archive(bd.divId);
  const kept = await mkDiv(tablesId, "WC After Walkover");
  check(
    `walkover credit (quota, the positive pair): archiving the division whose only fixture is a single walkover keeps its slot spent — archive ${keptArchive.status} (archived_at ${archivedAt(keptArchive)}), the next create refused ${kept.status} ${featureKey(kept)}`,
    bdWo.awarded &&
      keptArchive.status === 200 &&
      archivedAt(keptArchive) !== null &&
      kept.status === 402 &&
      featureKey(kept) === QUOTA,
  );
  const refundArchive = await archive(dw.divId);
  const refunded = await mkDiv(tablesId, "WC After Neither");
  check(
    `walkover credit (quota): archiving the division whose only fixture is a double walkover refunds its slot — double walkover ${dwWrite?.status} (${dwAfter?.status} ${JSON.stringify(dwAfter?.outcome)}), archive ${refundArchive.status} (archived_at ${archivedAt(refundArchive)}), the next create ${refunded.status} ${featureKey(refunded) ?? ""}`,
    dwWrite?.status === 201 &&
      dwAfter?.status === "forfeited" &&
      dwAfter.outcome?.kind === "double_walkover" &&
      refundArchive.status === 200 &&
      archivedAt(refundArchive) !== null &&
      refunded.status === 201,
  );
}
