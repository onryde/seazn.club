import { readFileSync } from "node:fs";
// W2a bracketFinishSuite: the settle method's outcome name and the chess tie-break rungs, read from the engine's own
// declarations rather than typed. Both entry points load under plain `node --experimental-strip-types` (probed).
// W2b walkoverCreditSuite: the closed award reasons (`AWARD_REASONS`) and two sports' declared cfgs — the games a
// badminton walkover credits and each game's target, hockey's `awardScore` — read the same way (probed too).
import { settledMethod, type EngineErrorCode } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
// W2c Task 11: the sport registry and the engine's own stage-key declaration, the expectation of the every-sport check
// below (never a list of keys typed into the script).
import { builtinModules } from "@seazn/engine/sports";
import { deciderKeysFor, type AnySportModule } from "@seazn/engine/sport";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, v1data, setPlan } from "../harness.ts";

/**
 * Format matrix W2a (spec §5, plan Task 17 Step 1): a knockout always finishes. Four flows through the real API as the
 * organiser of one fresh org, repriced to Pro (flow 4 mints a device link, a Pro grant):
 *  1. a football semi-final played to full time level, every decider switched off (C18; W2c X-SR-6): held `needs_decision`; the
 *     organiser settles it by lot for the away side → decided, `settled_lot`, the final's seat holds the winner, and
 *     the public match page says the winner "advanced on lot";
 *  2. a chess semi-final drawn, then `boardgame.tiebreak` at Armageddon recording the away side as Black, who won
 *     (W2c BG-KO-2: the scorer records Black and the result and the ENGINE decides who advances) → decided,
 *     `tiebreak_armageddon`, the away side seated in the final;
 *  3. a generic semi-final `generic.result` level → 409 `LEVEL_RESULT_IN_BRACKET`, the fixture unchanged (the positive
 *     pair: the other semi's non-level result is accepted);
 *  4. a device link's `core.settle` on a held semi-final → 403 `FORBIDDEN`, the fixture unchanged (X-ST-2); the same
 *     link authenticates a read of that fixture, so the refusal is the organiser-only gate, not a dead token.
 * Every refusal is judged on the body's error code, not only the HTTP status. Every list read states its count, and a
 * zero count fails.
 */
export async function bracketFinishSuite(): Promise<void> {
  const pub = JSON.parse(
    readFileSync(new URL("../../../apps/web/src/dictionaries/en/public.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  const owner = newSession();
  const who = await signIn(owner, `delivered+bracketfinish_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";
  await setPlan(who.org_id, "pro", owner);
  const comp = await v1(owner, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Bracket Finish ${tag}`,
    visibility: "public",
  });
  const compRow = v1data<{ id: string; slug: string; visibility: string }>(comp);
  check(
    "bracket finish: a PUBLIC competition is created on a Pro org",
    comp.status === 201 && compRow.visibility === "public" && orgSlug !== "",
  );

  type BfFixture = {
    id: string;
    round_no: number;
    status: string;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    outcome: { kind: string; winner?: string; method?: string } | null;
  };
  const fixture = async (id: string) => v1data<BfFixture>(await v1(owner, `/api/v1/fixtures/${id}`));
  // `?.`, as walkoverCreditSuite's: a fixture id that never arrived reads no state, and the check reds instead of main().
  const seqOf = async (id: string, headers: Record<string, string> = {}) =>
    v1data<{ last_seq: number } | undefined>(await v1(owner, `/api/v1/fixtures/${id}/state`, "GET", undefined, headers))
      ?.last_seq;
  const post = async (id: string, type: string, payload: unknown = {}) =>
    v1(owner, `/api/v1/fixtures/${id}/events`, "POST", { expected_seq: await seqOf(id), type, payload });

  /** One division with a generated, started 4-entrant knockout: its two semi-finals (both seated) and its final.
   *  `rules` = the knockout stage's own match rules (W2c Task 12: a new knockout starts with its sport's preset). */
  async function knockout(label: string, division: Record<string, unknown>, kind: "individual" | "team", rules?: Record<string, unknown>) {
    const div = await v1(owner, `/api/v1/competitions/${compRow.id}/divisions`, "POST", { name: label, ...division });
    const divRow = v1data<{ id: string; slug: string }>(div);
    const names = ["One", "Two", "Three", "Four"].map((n) => `${label} ${n} ${tag}`);
    const entrants = await v1(
      owner,
      `/api/v1/divisions/${divRow.id}/entrants`,
      "POST",
      names.map((display_name, i) => ({ kind, display_name, seed: i + 1 })),
    );
    const ids = (v1data<{ id: string }[] | undefined>(entrants) ?? []).map((e) => e.id);
    const stage = await v1(owner, `/api/v1/divisions/${divRow.id}/stages`, "POST", {
      seq: 1, kind: "knockout", name: label, ...(rules === undefined ? {} : { config: { rules } }),
    });
    const generated = await v1(owner, `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divRow.id}/start`, "POST");
    const drawn = v1data<BfFixture[] | undefined>(await v1(owner, `/api/v1/divisions/${divRow.id}/fixtures`)) ?? [];
    const firstRound = Math.min(...drawn.map((f) => f.round_no));
    const semis = drawn.filter((f) => f.round_no === firstRound && f.home_entrant_id && f.away_entrant_id);
    const finals = drawn.filter((f) => f.round_no !== firstRound);
    check(
      `bracket finish (${label}): a 4-entrant knockout is generated and started — ${drawn.length} fixture(s) read: ${semis.length} seated semi-final(s), ${finals.length} final(s)`,
      div.status === 201 &&
        ids.length === 4 &&
        stage.status < 300 &&
        generated.status < 300 &&
        started.status < 300 &&
        drawn.length === 3 &&
        semis.length === 2 &&
        finals.length === 1,
    );
    const nameOf = new Map(ids.map((id, i) => [id, names[i] ?? ""]));
    return { divSlug: divRow.slug, semis, finalId: finals[0]?.id ?? "", nameOf };
  }

  /** The final's seats, polled within a bound (never a fixed sleep's worth of hope) until `entrant` holds one. */
  async function seatedInFinal(finalId: string, entrant: string): Promise<{ seated: boolean; reads: number }> {
    let reads = 0;
    for (let tries = 0; tries < 20; tries++) {
      const f = await fixture(finalId);
      reads++;
      if (f?.home_entrant_id === entrant || f?.away_entrant_id === entrant) return { seated: true, reads };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { seated: false, reads };
  }

  // --- 1. Football: a level semi at full time is HELD, then settled by lot. ---
  // W2c Task 12 (X-SR-6): a new knockout starts with extra time and penalties; the organiser has switched every decider
  // off — to the 11-a-side division's own values, read off the engine — so the level semi is held, never refused.
  const football = builtinModules.find((m) => m.key === "football") as AnySportModule;
  const footballVariant = football.configSchema.parse(football.variants["11-a-side"]) as Record<string, unknown>;
  const decidersOff = Object.fromEntries(deciderKeysFor(football, "knockout", "11-a-side").map((k) => [k, footballVariant[k]]));
  const foot = await knockout("BF Football", { sport_key: "football", variant_key: "11-a-side" }, "team", decidersOff);
  const [footSf, footSf2] = foot.semis;
  const footAway = footSf?.away_entrant_id ?? "";
  const footWrites: number[] = [];
  if (footSf) {
    for (const [type, payload] of [
      ["core.start", {}],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
    ] as const) {
      footWrites.push((await post(footSf.id, type, payload)).status);
    }
  }
  const held = footSf ? await fixture(footSf.id) : undefined;
  check(
    `bracket finish (football): a semi-final level at full time with no decider is HELD — ${footWrites.length} write(s) accepted, status ${held?.status}, outcome ${JSON.stringify(held?.outcome)}`,
    footWrites.length === 3 &&
      footWrites.every((s) => s === 201) &&
      held?.status === "needs_decision" &&
      held.outcome?.kind === "draw",
  );
  const settle = footSf ? await post(footSf.id, "core.settle", { winner: footAway, method: "lot" }) : undefined;
  const settled = footSf ? await fixture(footSf.id) : undefined;
  check(
    `bracket finish (football): the organiser's lot settle decides it for the away side — status ${settled?.status}, method ${settled?.outcome?.method}`,
    settle?.status === 201 &&
      settled?.status === "decided" &&
      settled.outcome?.kind === "win" &&
      settled.outcome.winner === footAway &&
      settled.outcome.method === settledMethod("lot"),
  );
  const footSeat = await seatedInFinal(foot.finalId, footAway);
  check(
    `bracket finish (football): the final's seat holds the settled winner (${footSeat.reads} read(s) of the final)`,
    footAway !== "" && footSeat.reads > 0 && footSeat.seated,
  );
  // The public match page names the method ON the court card's status line (`mc-status-line`: match-centre.ts
  // resultMsg → matchCentre.result.settled_lot, "{winner} advanced on lot"). Anchored there, never anywhere in the
  // body: the page's meta description and share text carry the same sentence from another builder, so a body-wide
  // search stayed green while the court card read "<winner> won" (Task 17's prod-build mutant on resultMsg).
  const lotLine = (pub["matchCentre.result.settled_lot"] ?? "").replaceAll("{winner}", foot.nameOf.get(footAway) ?? "");
  const statusLine = (body: string): string | null => /data-testid="mc-status-line"[^>]*>([^<]*)</.exec(body)?.[1] ?? null;
  const matchPath = `/shared/${orgSlug}/${compRow.slug}/${foot.divSlug}/fixtures/${footSf?.id ?? ""}`;
  let matchPage = await html(newSession(), matchPath);
  let pageReads = 1;
  for (let tries = 0; tries < 20 && !(matchPage.status === 200 && statusLine(matchPage.body) === lotLine); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    matchPage = await html(newSession(), matchPath);
    pageReads++;
  }
  check(
    `bracket finish (football): the public match page's court card says "${lotLine}" (read "${statusLine(matchPage.body) ?? "(no status line)"}", ${pageReads} load(s))`,
    lotLine.includes("advanced on lot") && !lotLine.includes("{winner}") && matchPage.status === 200 && statusLine(matchPage.body) === lotLine,
  );

  // --- 2. Chess: a drawn game goes to its tie-break; Armageddon records the away side as Black, and Black won. ---
  const ARMAGEDDON = "armageddon";
  const chess = await knockout("BF Chess", { sport_key: "boardgame", variant_key: "classical" }, "individual");
  const chessSf = chess.semis[0];
  const chessAway = chessSf?.away_entrant_id ?? "";
  const chessWrites: number[] = [];
  if (chessSf) {
    chessWrites.push((await post(chessSf.id, "core.start")).status);
    chessWrites.push((await post(chessSf.id, "boardgame.result", { winner: null, method: "agreement" })).status);
  }
  const drawnGame = chessSf ? await fixture(chessSf.id) : undefined;
  check(
    `bracket finish (chess): a drawn knockout game awaits its tie-break, decided by nobody — status ${drawnGame?.status}, outcome ${JSON.stringify(drawnGame?.outcome)}`,
    chessWrites.length === 2 && chessWrites.every((s) => s === 201) && drawnGame?.status === "in_play" && drawnGame.outcome === null,
  );
  const tiebreak = chessSf
    ? await post(chessSf.id, "boardgame.tiebreak", { rung: ARMAGEDDON, black: chessAway, result: "black" })
    : undefined;
  const broken = chessSf ? await fixture(chessSf.id) : undefined;
  check(
    `bracket finish (chess): the Armageddon with the away side as Black, winning, decides it — status ${broken?.status}, method ${broken?.outcome?.method}`,
    (TIEBREAK_RUNGS as readonly string[]).includes(ARMAGEDDON) &&
      tiebreak?.status === 201 &&
      broken?.status === "decided" &&
      broken.outcome?.kind === "win" &&
      broken.outcome.winner === chessAway &&
      broken.outcome.method === `tiebreak_${ARMAGEDDON}` &&
      pub[`matchCentre.result.tiebreak_${ARMAGEDDON}`] !== undefined,
  );
  const chessSeat = await seatedInFinal(chess.finalId, chessAway);
  check(
    `bracket finish (chess): the away side is seated in the final (${chessSeat.reads} read(s) of the final)`,
    chessAway !== "" && chessSeat.reads > 0 && chessSeat.seated,
  );

  // --- 3. Generic: a level result cannot finish a bracket match. ---
  const LEVEL_IN_BRACKET: EngineErrorCode = "LEVEL_RESULT_IN_BRACKET";
  const gen = await knockout(
    "BF Generic",
    { sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false } },
    "individual",
  );
  const [genSf, genSf2] = gen.semis;
  const genStart = genSf ? (await post(genSf.id, "core.start")).status : 0;
  const genBefore = genSf ? { seq: await seqOf(genSf.id), fx: await fixture(genSf.id) } : undefined;
  const level = genSf ? await post(genSf.id, "generic.result", { p1Score: 1, p2Score: 1 }) : undefined;
  const genAfter = genSf ? { seq: await seqOf(genSf.id), fx: await fixture(genSf.id) } : undefined;
  check(
    `bracket finish (generic): a level result is refused 409 ${LEVEL_IN_BRACKET} (got ${level?.status} ${level?.json.error?.code})`,
    genStart === 201 && level?.status === 409 && level.json.error?.code === LEVEL_IN_BRACKET,
  );
  check(
    `bracket finish (generic): the refused result changed nothing — seq ${genBefore?.seq}→${genAfter?.seq}, status ${genBefore?.fx.status}→${genAfter?.fx.status}`,
    genBefore !== undefined &&
      genAfter !== undefined &&
      typeof genBefore.seq === "number" &&
      genAfter.seq === genBefore.seq &&
      genAfter.fx.status === genBefore.fx.status &&
      genAfter.fx.status === "in_play" &&
      genAfter.fx.outcome === null,
  );
  const notLevel = genSf2 ? await post(genSf2.id, "generic.result", { p1Score: 2, p2Score: 1 }) : undefined;
  check(
    `bracket finish (generic): the positive pair — the other semi's 2–1 result is accepted (got ${notLevel?.status})`,
    notLevel?.status === 201,
  );

  // --- 4. X-ST-2: a device link may not settle a held fixture. ---
  const held2Writes: number[] = [];
  if (footSf2) {
    for (const [type, payload] of [
      ["core.start", {}],
      ["football.period", { phase: "HT" }],
      ["football.period", { phase: "FT" }],
    ] as const) {
      held2Writes.push((await post(footSf2.id, type, payload)).status);
    }
  }
  const link = footSf2 ? await v1(owner, `/api/v1/fixtures/${footSf2.id}/device-links`, "POST", { label: "BF court" }) : undefined;
  const dlSecret = link ? (v1data<{ secret?: string }>(link)?.secret ?? "") : "";
  const bearer = { Authorization: `Bearer ${dlSecret}` };
  const bare = newSession(); // no cookie — the token is the credential
  const dlRead = footSf2 ? await v1(bare, `/api/v1/fixtures/${footSf2.id}/state`, "GET", undefined, bearer) : undefined;
  const dlBefore = footSf2 ? { seq: await seqOf(footSf2.id), fx: await fixture(footSf2.id) } : undefined;
  check(
    `bracket finish (device link): a held semi-final, a minted dl_ link, and the link reads it — ${held2Writes.length} write(s), status ${dlBefore?.fx.status}, link read ${dlRead?.status}`,
    held2Writes.length === 3 &&
      held2Writes.every((s) => s === 201) &&
      dlBefore?.fx.status === "needs_decision" &&
      link?.status === 201 &&
      dlSecret.startsWith("dl_") &&
      dlRead?.status === 200,
  );
  const dlSettle = footSf2
    ? await v1(
        bare,
        `/api/v1/fixtures/${footSf2.id}/events`,
        "POST",
        { expected_seq: dlBefore?.seq ?? 0, type: "core.settle", payload: { winner: footSf2.away_entrant_id, method: "lot" } },
        bearer,
      )
    : undefined;
  const dlAfter = footSf2 ? { seq: await seqOf(footSf2.id), fx: await fixture(footSf2.id) } : undefined;
  check(
    `bracket finish (device link): its core.settle is refused 403 FORBIDDEN by the organiser-only gate (got ${dlSettle?.status} ${dlSettle?.json.error?.code}: ${dlSettle?.json.error?.message})`,
    dlSettle?.status === 403 &&
      dlSettle.json.error?.code === "FORBIDDEN" &&
      dlSettle.json.error.message === "Only an organiser can settle a match",
  );
  check(
    `bracket finish (device link): the refused settle changed nothing — seq ${dlBefore?.seq}→${dlAfter?.seq}, status ${dlAfter?.fx.status}, outcome ${JSON.stringify(dlAfter?.fx.outcome)}`,
    dlBefore !== undefined &&
      dlAfter !== undefined &&
      typeof dlBefore.seq === "number" &&
      dlAfter.seq === dlBefore.seq &&
      dlAfter.fx.status === "needs_decision" &&
      dlAfter.fx.outcome?.kind === "draw",
  );
}
