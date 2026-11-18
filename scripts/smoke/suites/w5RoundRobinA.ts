// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { call, check, html, newSession, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Format matrix W5 round-robin app PR A, Task 2 (X-CU-6 FX-G1 #879; FX-G21) — the smoke proof, over real HTTP against a live
 * server. Own fresh owner; keyless; every read and write is a v1 route (the generic sport needs no key).
 *
 * T2 (X-CU-6, FX-G1): a league of four, generated, then two entrants added before Start and Generate pressed again, owes
 * exactly the pairs the newcomers owe, drawn once: 15 lines, every unordered pair of the six once. Main wrote nine new
 * positional lines that repeated pairs already drawn and left the newcomers' pairs short.
 * T2 (FX-G21): a league of five has a bye each round; the stage's `config.round_byes` names who sat out which round, each
 * entrant once (five rounds, five byes), so an odd field's byes are a stored fact and not a thing every reader re-derives.
 *
 * T3 (X-BD-6, FX-G15): Add match defaults to the latest round where NEITHER side plays, not to the round after the last. A league of six
 * plays in every round of its five, so a side is free only where its line was expunged: two round-3 lines are picked and their far
 * sides withdrawn after Start, which frees the two near sides in round 3 and nowhere else; the match added with no round named is
 * written in round 3 (main wrote it in round 6).
 *
 * T5 (X-CU-7, X-CU-12, X-CU-13; RB5-L3): "Add late player" into a started league of five, rounds 1-2 under way, writes the newcomer
 * five UNSCHEDULED catch-up lines — in the bye rounds still to come (3, 4, 5: the engine's byes r3 P3, r4 P2, r5 P1) and two
 * appended rounds (6, 7) — and every earlier line stays as it was (main refused the add 422; Task 4's interim accepted it with no
 * seat). Undo across the add is then refused by name (RR_LATE_ENTRY_NOT_UNDOABLE) and moves nothing.
 *
 * T5b (X-CU-10; RB5-L5): the same late player's row in the PUBLIC hub document reads "Joined round 3" while her catch-up lines are
 * undecided (`tables[].rows[].markers`, read anonymously); main marked no league row at all.
 *
 * T6 (X-CU-8; RB5-L10): an AUTOMATIC arrival into a started league waits for one tap. A league of five whose fifth player withdrew
 * before Start is drawn as four; after round 1 starts, the fifth is reinstated — the PATCH answers `late_entry.case: "waiting"`
 * (main: no answer, seated nowhere, no flag) and nothing is placed. The organiser's tap (`POST /stages/{id}/late-entrants/{id}/place`)
 * writes one unscheduled catch-up line against each of the four, and a second tap is refused 409 RR_LATE_ENTRY_ALREADY_PLACED.
 *
 * T8 (X-WDT-5, X-WDT-8; ST-G15, RB5-W2/W6/W7): a public league of four, P1's one played match signed off (finalized), then P1
 * withdraws: 1 of 3 played is under half, so all three of her lines are removed through the expunge abandon, the signed-off one
 * included (main skipped it: `skipped_finalized: 1`, her win kept on the table). The anonymous hub document carries the footnote
 * "left after 1 of 3, so their results are removed and their other matches are void." under that table. A Reinstate then puts
 * her two unplayed lines back to scheduled.
 *
 * T8b Part 1 (X-WDT-9; RB5-W10, ruling 288): a registrant's OWN withdrawal from the public status door after Start runs the table
 * withdrawal — at 1 of 3 played her lines are all taken out and the hub footnote names the rule (main: only her status changed).
 *
 * Task 10 (X-RP-2, X-RP-3; RB5-R2, RB5-R3): a league of four PAIRS, started, one match won by the first pair. Swapping one of its
 * partners for a newcomer is refused 422 RR_SUBSTITUTE_PARTNER_REFUSED and the roster stays; dropping a partner then withdraws the pair
 * as the entrant — 1 of 3 played is under half, so all three of its lines are taken out (main: the members write succeeded and every
 * fixture was left standing).
 *
 * Task 11 (X-CUT-4 <- RB5-K6): in check 12's division, with the seeding confirmed and the finals not started, the champion leaves: the
 * confirmed cut goes stale and her seat is given back (the finals read unseated), a fresh proposal offers the next eligible, and
 * confirming it seats them. (Main: the confirmed seats stood, a departed entrant on a finals line.)
 *
 * Task 10b (ruling 292, X-RP-2/3 in every format): a started SWISS of four pairs and a started KNOCKOUT of four pairs, in a second org
 * (the first org's competitions are at their caps). A substitute partner is refused 422 RR_SUBSTITUTE_PARTNER_REFUSED and the roster
 * stays; dropping a partner withdraws the pair as the entrant, its seated line walked over to the opponent (W3 R4b / RB4-V1), and a
 * Reinstate leaves the pair in the field. (Main: the members write succeeded and every fixture was left standing.)
 *
 * Task 13 (X-PO-3, X-PO-4; RB5-P5, RB5-P7): a league of four. A pin above the table's size is refused 422 RR_RANK_OVERRIDE_POOL at write and
 * stores nothing (main: stored, thrown by the engine at the next recompute); the size itself is accepted; on a knockout stage of the same
 * division a pin is refused 422 RR_RANK_OVERRIDE_NOT_TABLE; and withdrawing a pinned entrant takes her pin out of the stage's config.
 *
 * Task 17 (X-BD-4 <- RB5-S4, CS-1): a league feeding a setup-timing knockout, played out and Completed. A SECOND Complete answers
 * `{completed: false, already_complete: true}` and names the one draft proposal the first call minted (main: `completed: true`, and the
 * progression re-run); the proposal's `computed` and the knockout's lines are exactly what they were, and a third call says the same.
 *
 * Every check is counted, and a run that checked nothing fails. SMOKE_ONLY=w5RoundRobinA runs it alone (SELECTABLE_SUITES).
 */
export async function w5RoundRobinASuite(): Promise<void> {
  // T2: 2 (4 -> 6 reconciles by pair; a 5-team league persists its byes). T3: 1 (Add match lands in the round both sides are free).
  // T5: 2 (a late player's catch-up lines; Undo across the add refused by name). T5b: 1 (her hub row reads Joined round 3).
  // T6: 1 (an automatic arrival waits; one tap places it; a second tap is refused by name).
  // T8: 1 (a leaver's signed-off result is removed, the hub's footnote names the rule; Reinstate restores her unplayed lines).
  // T8b Part 1: 1 (a registrant's own public withdrawal after Start runs the table withdrawal).
  // T8b Part 2: 1 (an in-match disqualification withdraws the entrant from the league).
  // T8b Part 3: 1 (the Disqualify preview's numbers are the ones the cascade then acts on).
  // Task 9: 1 (a qualifier who leaves after the table completes is cut; the 5th place is seated).
  // Task 10: 1 (a started league's pair: a substitute partner is refused by name; dropping a partner withdraws the pair by the 50 percent rule).
  // Task 11: 1 (a confirmed qualifier leaves before the finals start: the proposal goes stale and her seat is given back; the re-proposal seats the next eligible).
  // Task 10b: 1 (the same rule in a started Swiss and a started knockout of pairs: a substitute is refused; dropping a partner withdraws the pair and walks her line over).
  // Task 15: 1 (the any-sport super-groups card builds a badminton pairs event: 6 pools of 4, then 2 groups, then a knockout; a fixed card refuses a choice).
  // Task 13: 1 (a rank override is checked against its pool's size, refused on a bracket, and a withdrawal takes the leaver's pin away).
  // Task 17: 1 (a second Complete answers already_complete, leaves the draft proposal and the knockout as they were, and mints nothing).
  const EXPECTED_CHECKS = 18;
  let checked = 0;
  const w5Check = (label: string, cond: boolean) => {
    checked++;
    check(label, cond);
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+w5a_${tag}@resend.dev`);
  const orgId = who.org_id;
  const comp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR A ${tag}`, visibility: "private" }),
  );

  type Fx = {
    id: string;
    stage_id: string;
    round_no: number;
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    ext_key?: string | null;
    scheduled_at?: string | null;
    status?: string;
  };
  type StageOut = { id: string; config: { round_byes?: { round_no: number; leg: number; entrant_id: string }[] } };

  /** A generic league of `n` entrants, generated once. */
  async function league(label: string, n: number, compId: string | undefined = comp?.id, who = owner) {
    const divRes = await v1(who, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name: label,
        sport_key: "generic",
        variant_key: "score",
        config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      });
    const divId = v1data<{ id: string } | undefined>(divRes)?.id;
    const addEntrants = async (from: number, to: number) =>
      v1data<{ id: string }[] | undefined>(
        await v1(who, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: to - from + 1 }, (_, i) => ({ kind: "individual", display_name: `${label}${from + i} ${tag}`, seed: from + i }))),
      ) ?? [];
    const entrants = await addEntrants(1, n);
    const stageId = v1data<{ id: string } | undefined>(
      await v1(who, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: label }),
    )?.id;
    const generate = () => v1(who, `/api/v1/stages/${stageId}/generate`, "POST");
    await generate();
    const fixtures = async () =>
      (v1data<Fx[] | undefined>(await v1(who, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const stage = async () =>
      (v1data<StageOut[] | undefined>(await v1(who, `/api/v1/divisions/${divId}/stages`)) ?? []).find((s) => s.id === stageId);
    /** The division POST's status and body, for a failure message (an absent division 404s every call after it). */
    const created = `division ${divRes.status} ${JSON.stringify(divRes.json).slice(0, 200)}`;
    return { divId, entrants, stageId, generate, fixtures, stage, addEntrants, created };
  }

  // Check 1 — 4 -> 6 before Start: Generate adds the missing pairs and nothing twice.
  {
    const l = await league("Grow", 4);
    const before = await l.fixtures();
    const added = await l.addEntrants(5, 6);
    const res = await l.generate();
    const after = await l.fixtures();
    const pairKeys = after.map((f) => [f.home_entrant_id, f.away_entrant_id].sort().join("|"));
    const everyone = [...l.entrants, ...added].map((e) => e.id);
    // The 15 unordered pairs of six, derived from the roster, not from the response.
    const owed = everyone.flatMap((a, i) => everyone.slice(i + 1).map((b) => [a, b].sort().join("|")));
    const ok =
      before.length === 6 && added.length === 2 && res.status === 200 &&
      after.length === 15 && owed.length === 15 &&
      new Set(pairKeys).size === 15 && owed.every((k) => pairKeys.includes(k)) &&
      after.every((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    w5Check(
      "w5a X-CU-6: a league of four grown to six before Start, then Generate, holds exactly the 15 pairs once each (no repeat, none missing)" +
        (ok ? "" : ` — before ${before.length}, added ${added.length}, status ${res.status}, after ${after.length}, distinct ${new Set(pairKeys).size}, missing ${owed.filter((k) => !pairKeys.includes(k)).length}, org ${orgId}`),
      ok,
    );
  }

  // Check 2 — FX-G21: a five-team league persists one bye per round, each entrant once.
  {
    const l = await league("Odd", 5);
    const stage = await l.stage();
    const byes = stage?.config.round_byes ?? [];
    const rounds = byes.map((b) => b.round_no).sort((a, b) => a - b);
    const sitting = byes.map((b) => b.entrant_id).sort();
    const ok =
      l.entrants.length === 5 && byes.length === 5 &&
      rounds.join(",") === "1,2,3,4,5" &&
      sitting.join(",") === l.entrants.map((e) => e.id).sort().join(",") &&
      byes.every((b) => b.leg === 1);
    w5Check(
      "w5a FX-G21: a five-team league stores its byes (config.round_byes: one per round 1-5, each entrant once, leg 1)" +
        (ok ? "" : ` — entrants ${l.entrants.length}, byes ${JSON.stringify(byes).slice(0, 300)}`),
      ok,
    );
  }

  // Check 3 - X-BD-6: Add match with no round named lands in the latest round where neither side plays.
  {
    const l = await league("AddRound", 6);
    const lines = await l.fixtures();
    const round3 = lines.filter((f) => f.round_no === 3);
    const [lineA, lineB] = round3;
    const a = lineA?.home_entrant_id ?? "";
    const x = lineA?.away_entrant_id ?? "";
    const b = lineB?.home_entrant_id ?? "";
    const y = lineB?.away_entrant_id ?? "";
    const started = await v1(owner, `/api/v1/divisions/${l.divId}/start`, "POST");
    // The withdrawal expunges the leaver's lines only once the division is under way: play one round-1 line neither leaver is in.
    const free = lines.find((f) => f.round_no === 1 && ![x, y].includes(f.home_entrant_id ?? "") && ![x, y].includes(f.away_entrant_id ?? ""));
    const startEv = await v1(owner, `/api/v1/fixtures/${free?.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    const resultEv = await v1(owner, `/api/v1/fixtures/${free?.id}/events`, "POST", { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    const gone = [await v1(owner, `/api/v1/entrants/${x}/withdraw`, "POST"), await v1(owner, `/api/v1/entrants/${y}/withdraw`, "POST")];
    const addRes = await v1(owner, `/api/v1/stages/${l.stageId}/fixtures`, "POST", { home_entrant_id: a, away_entrant_id: b });
    const after = await l.fixtures();
    const added = after.filter((f) => !lines.some((o) => o.id === f.id));
    const rounds = Math.max(...lines.map((f) => f.round_no));
    const ok =
      lines.length === 15 && rounds === 5 && round3.length === 3 && new Set([a, x, b, y]).size === 4 &&
      started.status === 200 && free !== undefined && startEv.status === 201 && resultEv.status === 201 && gone.every((g) => g.status === 200) && addRes.status === 201 &&
      added.length === 1 && added[0]?.round_no === 3;
    w5Check(
      "w5a X-BD-6: Add match with no round named lands in round 3, where both sides are free (main wrote round 6)" +
        (ok ? "" : ` - lines ${lines.length}, rounds ${rounds}, start ${started.status}, add ${addRes.status}, added ${added.length} in round ${added[0]?.round_no}`),
      ok,
    );
  }

  // Checks 4-5 - X-CU-7 / X-CU-13: a late player added to a started league of five gets catch-up lines; Undo refuses.
  {
    const l = await league("Late", 5);
    const lines = await l.fixtures();
    const started = await v1(owner, `/api/v1/divisions/${l.divId}/start`, "POST");
    const starts = [];
    for (const r of [1, 2]) {
      const line = lines.find((f) => f.round_no === r);
      starts.push(await v1(owner, `/api/v1/fixtures/${line?.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} }));
    }
    type Late = { id: string; late_entry?: { case?: string; fixtures?: { round_no: number; placement: string; scheduled: boolean }[] } };
    const addRes = await v1(owner, `/api/v1/divisions/${l.divId}/entrants`, "POST", [{ kind: "individual", display_name: `Late ${tag}` }]);
    const late = (v1data<Late[] | undefined>(addRes) ?? [])[0];
    const after = await l.fixtures();
    const mine = after.filter((f) => f.home_entrant_id === late?.id || f.away_entrant_id === late?.id).sort((a, b) => a.round_no - b.round_no);
    const placed = (late?.late_entry?.fixtures ?? []).map((f) => `${f.placement}:${f.round_no}`).sort();
    const kept = lines.every((o) => {
      const now = after.find((f) => f.id === o.id);
      return now !== undefined && now.round_no === o.round_no && now.home_entrant_id === o.home_entrant_id && now.away_entrant_id === o.away_entrant_id;
    });
    const ok =
      lines.length === 10 && started.status === 200 && starts.every((s) => s.status === 201) && addRes.status === 201 &&
      late?.late_entry?.case === "catch_up" &&
      mine.map((f) => f.round_no).join(",") === "3,4,5,6,7" &&
      placed.join(",") === "bye_slot:3,bye_slot:4,bye_slot:5,catch_up_round:6,catch_up_round:7" &&
      mine.every((f) => (f.scheduled_at ?? null) === null) && kept && after.length === 15;
    w5Check(
      "w5a X-CU-7: a late player in a started league of five gets 5 unscheduled catch-up lines (byes r3-r5, appended r6-r7), every earlier line kept" +
        (ok ? "" : ` - start ${started.status}, add ${addRes.status}, case ${late?.late_entry?.case}, rounds ${mine.map((f) => f.round_no).join(",")}, placed ${placed.join(",")}, kept ${kept}, after ${after.length}`),
      ok,
    );
    const undo = await v1(owner, `/api/v1/divisions/${l.divId}/undo`, "POST", {});
    const code = undo.json.error?.code;
    const still = await l.fixtures();
    const okUndo = undo.status === 409 && code === "RR_LATE_ENTRY_NOT_UNDOABLE" && still.length === after.length;
    w5Check(
      "w5a X-CU-13: Undo across Add late player is refused 409 RR_LATE_ENTRY_NOT_UNDOABLE and moves nothing" +
        (okUndo ? "" : ` - status ${undo.status}, code ${code}, lines ${still.length}/${after.length}`),
      okUndo,
    );
  }

  // The public competition checks 6 and 8 read the hub of (one division each; the org's competition cap refuses a fourth).
  const pub = v1data<{ id: string; slug: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR A hub ${tag}`, visibility: "public" }),
  );

  // Check 6 - X-CU-10 / RB5-L5: the late player's row in the public hub document reads "Joined round 3" while her catch-up lines remain.
  {
    const l = await league("Hub", 5, pub?.id);
    const lines = await l.fixtures();
    await v1(owner, `/api/v1/divisions/${l.divId}/start`, "POST");
    for (const r of [1, 2]) {
      await v1(owner, `/api/v1/fixtures/${lines.find((f) => f.round_no === r)?.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    }
    const addRes = await v1(owner, `/api/v1/divisions/${l.divId}/entrants`, "POST", [{ kind: "individual", display_name: `Late hub ${tag}` }]);
    const late = (v1data<{ id: string }[] | undefined>(addRes) ?? [])[0];
    const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
    const orgSlug = orgs.find((o) => o.id === orgId)?.slug ?? "";
    const hubRes = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${pub?.slug}/hub`);
    type HubRow = { entrantId: string; markers?: { kind: string; text: string }[] };
    const tables = (v1data<{ tables?: { divisionId: string; rows: HubRow[] }[] } | undefined>(hubRes)?.tables ?? []).filter((t) => t.divisionId === l.divId);
    const rows = tables[0]?.rows ?? [];
    const mine = rows.find((r) => r.entrantId === late?.id);
    const others = rows.filter((r) => r.entrantId !== late?.id);
    const ok =
      addRes.status === 201 && late !== undefined && orgSlug !== "" && hubRes.status === 200 && tables.length === 1 && rows.length === 6 &&
      mine?.markers?.length === 1 && mine.markers[0]?.kind === "late" && mine.markers[0]?.text === "Joined round 3" &&
      others.length === 5 && others.every((r) => (r.markers ?? []).length === 0);
    w5Check(
      "w5a X-CU-10: the public hub marks a late player's row 'Joined round 3' while her catch-up lines remain, and no other row" +
        (ok ? "" : ` - add ${addRes.status}, hub ${hubRes.status}, tables ${tables.length}, rows ${rows.length}, hers ${JSON.stringify(mine?.markers ?? null)}, others marked ${others.filter((r) => (r.markers ?? []).length > 0).length}`),
      ok,
    );
  }

  // Checks 7 and 10 share their own competition: `comp` already holds four divisions, the plan's per-competition cap (a 5th
  // answers 402).
  const own = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR A wait ${tag}`, visibility: "private" }),
  );

  // Check 7 - X-CU-8 / RB5-L10: a reinstated player with no line waits; one tap writes her catch-up lines; a second tap is refused.
  {
    const l = await league("Wait", 5, own?.id);
    const ids = l.entrants.map((e) => e.id);
    const gone = ids[4];
    // Withdrawn before Start (a plain status flip); Generate then redraws the four still in the field.
    const out = await v1(owner, `/api/v1/entrants/${gone}/withdraw`, "POST");
    const regen = await l.generate();
    const started = await v1(owner, `/api/v1/divisions/${l.divId}/start`, "POST");
    const drawn = await l.fixtures();
    const first = drawn.find((f) => f.round_no === 1);
    const ev = await v1(owner, `/api/v1/fixtures/${first?.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    const back = await v1(owner, `/api/v1/entrants/${gone}`, "PATCH", { status: "registered" });
    const answer = v1data<{ late_entry?: { case?: string; source?: string } } | undefined>(back)?.late_entry;
    const placedBefore = (await l.fixtures()).filter((f) => f.home_entrant_id === gone || f.away_entrant_id === gone).length;
    const tap = await v1(owner, `/api/v1/stages/${l.stageId}/late-entrants/${gone}/place`, "POST");
    const tapCase = v1data<{ case?: string } | undefined>(tap)?.case;
    const mine = (await l.fixtures()).filter((f) => f.home_entrant_id === gone || f.away_entrant_id === gone);
    const opps = mine.map((f) => (f.home_entrant_id === gone ? f.away_entrant_id : f.home_entrant_id)).sort().join(",");
    const again = await v1(owner, `/api/v1/stages/${l.stageId}/late-entrants/${gone}/place`, "POST");
    const ok =
      out.status === 200 && regen.status === 200 && started.status === 200 && drawn.length === 6 &&
      drawn.every((f) => f.home_entrant_id !== gone && f.away_entrant_id !== gone) && ev.status === 201 && back.status === 200 &&
      answer?.case === "waiting" && answer.source === "automatic" && placedBefore === 0 &&
      tap.status === 200 && tapCase === "catch_up" && mine.length === 4 && opps === ids.slice(0, 4).sort().join(",") &&
      mine.every((f) => (f.scheduled_at ?? null) === null) &&
      again.status === 409 && again.json.error?.code === "RR_LATE_ENTRY_ALREADY_PLACED";
    w5Check(
      "w5a X-CU-8: a reinstated player with no line waits (nothing placed); one tap writes 4 unscheduled catch-up lines; a second tap is RR_LATE_ENTRY_ALREADY_PLACED" +
        (ok ? "" : ` - ${l.created}, withdraw ${out.status}, generate ${regen.status}, start ${started.status}, drawn ${drawn.length}, ev ${ev.status}, back ${back.status}, answer ${JSON.stringify(answer ?? null)}, before ${placedBefore}, tap ${tap.status}/${tapCase}, mine ${mine.length}, again ${again.status}/${again.json.error?.code}`),
      ok,
    );
  }

  // Check 8 - X-WDT-5 / X-WDT-8 (ST-G15): a leaver's signed-off result is removed through the expunge abandon; the hub footnote; Reinstate.
  {
    // Check 6's public competition (the hub is read anonymously; `comp` is at the per-competition division cap). An absent
    // one 404s this check by name rather than falling through to `league`'s default competition.
    const l = await league("Expunge", 4, pub?.id ?? "no-public-competition");
    const [p1, p2] = l.entrants.map((e) => e.id);
    const started = await v1(owner, `/api/v1/divisions/${l.divId}/start`, "POST");
    const signed = (await l.fixtures()).find((f) => [f.home_entrant_id, f.away_entrant_id].sort().join("|") === [p1, p2].sort().join("|"));
    const p1Home = signed?.home_entrant_id === p1;
    const codes: number[] = [];
    let seq = 0;
    for (const [type, payload] of [
      ["core.start", {}],
      ["generic.result", p1Home ? { p1Score: 3, p2Score: 0 } : { p1Score: 0, p2Score: 3 }],
      ["core.finalize", {}],
    ] as const) {
      const ev = await v1(owner, `/api/v1/fixtures/${signed?.id}/events`, "POST", { expected_seq: seq, type, payload });
      codes.push(ev.status);
      seq = v1data<{ seq: number } | undefined>(ev)?.seq ?? seq;
    }
    const out = await v1(owner, `/api/v1/entrants/${p1}/withdraw`, "POST");
    const report = v1data<{ policy?: string; voided?: number; skipped_cancelled?: number } | undefined>(out);
    const gone = (await l.fixtures()).find((f) => f.id === signed?.id)?.status;
    const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
    const orgSlug = orgs.find((o) => o.id === orgId)?.slug ?? "";
    const hubRes = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${pub?.slug}/hub`);
    type HubTable = { divisionId: string; withdrawalNotes?: { entrantId: string; lead: string; body: string }[] };
    const table = (v1data<{ tables?: HubTable[] } | undefined>(hubRes)?.tables ?? []).find((t) => t.divisionId === l.divId);
    const notes = table?.withdrawalNotes ?? [];
    const back = await v1(owner, `/api/v1/entrants/${p1}`, "PATCH", { status: "registered" });
    const hers = (await l.fixtures()).filter((f) => f.id !== signed?.id && (f.home_entrant_id === p1 || f.away_entrant_id === p1));
    const ok =
      started.status === 200 && signed !== undefined && codes.join(",") === "201,201,201" && out.status === 200 &&
      report?.policy === "expunge" && report.voided === 3 && report.skipped_cancelled === 0 && gone === "abandoned" &&
      hubRes.status === 200 && notes.length === 1 && notes[0]?.entrantId === p1 &&
      notes[0]?.body === "left after 1 of 3, so their results are removed and their other matches are void." &&
      back.status === 200 && hers.length === 2 && hers.every((f) => f.status === "scheduled");
    w5Check(
      "w5a X-WDT-5: a leaver's finalized result is removed (expunge, 3 voided), the hub footnote names the rule; Reinstate puts her 2 unplayed lines back" +
        (ok ? "" : ` - ${l.created}, start ${started.status}, events ${codes.join(",")}, withdraw ${out.status} ${JSON.stringify(report ?? null)}, signed ${gone}, hub ${hubRes.status} notes ${JSON.stringify(notes)}, back ${back.status}, hers ${hers.map((f) => f.status).join(",")}`),
      ok,
    );
  }

  // Check 9 - X-WDT-9 (RB5-W10; ruling 111 joins the withdrawal door, ruling 288): a registrant's OWN public withdrawal after Start
  // goes through the table withdrawal. A league of three plus Rae (registered through the public door before Start), Rae wins
  // one by walkover, then withdraws from her status page's door: 1 of 3 is under half, so all three of her lines are taken out and
  // the hub's footnote names the rule; a second press settles nothing twice (still one footnote, still three lines out).
  {
    // Check 6's public competition (the register door and the hub are public; the org's competition cap is reached).
    const l = await league("SelfLeave", 3, pub?.id ?? "no-public-competition");
    const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
    const orgSlug = orgs.find((o) => o.id === orgId)?.slug ?? "";
    const settings = await v1(owner, `/api/v1/divisions/${l.divId}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      approval: "auto",
      form_fields: [],
    });
    const rae = `SelfLeave Rae ${tag}`;
    const sent = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${pub?.slug}/register`, "POST", {
      contact: { name: rae, email: `delivered+w5a_self_${tag}@resend.dev` },
      privacy_consent: true,
      entries: [{ division_id: l.divId, entrant_kind: "individual", players: [{ full_name: rae }], answers: {} }],
    });
    const submitted = v1data<{ access_token?: string; entries?: { registration_id: string; status: string }[] } | undefined>(sent);
    const regId = submitted?.entries?.[0]?.registration_id;
    const entrants = v1data<{ id: string; display_name: string }[] | undefined>(await v1(owner, `/api/v1/divisions/${l.divId}/entrants`)) ?? [];
    const raeId = entrants.find((e) => e.display_name === rae)?.id;
    const regen = await l.generate();
    const started = await v1(owner, `/api/v1/divisions/${l.divId}/start`, "POST");
    const hers = (await l.fixtures()).filter((f) => f.home_entrant_id === raeId || f.away_entrant_id === raeId);
    const won = hers[0];
    const opp = won?.home_entrant_id === raeId ? won?.away_entrant_id : won?.home_entrant_id;
    const walk = await v1(owner, `/api/v1/fixtures/${won?.id}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: opp, reason: "walkover" } });
    const out = await v1(newSession(), `/api/v1/public/registrations/${regId}/withdraw`, "POST", { token: submitted?.access_token });
    const again = await v1(newSession(), `/api/v1/public/registrations/${regId}/withdraw`, "POST", { token: submitted?.access_token });
    const after = (await l.fixtures()).filter((f) => f.home_entrant_id === raeId || f.away_entrant_id === raeId);
    const hubRes = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${pub?.slug}/hub`);
    type HubTable = { divisionId: string; withdrawalNotes?: { entrantId: string; body: string }[] };
    const notes = ((v1data<{ tables?: HubTable[] } | undefined>(hubRes)?.tables ?? []).find((t) => t.divisionId === l.divId)?.withdrawalNotes) ?? [];
    const ok =
      settings.status === 200 && sent.status === 201 && submitted?.entries?.[0]?.status === "confirmed" && raeId !== undefined &&
      regen.status === 200 && started.status === 200 && hers.length === 3 && walk.status === 201 &&
      out.status === 200 && again.status === 200 && after.length === 3 && after.every((f) => f.status === "abandoned") &&
      hubRes.status === 200 && notes.length === 1 && notes[0]?.entrantId === raeId &&
      notes[0]?.body === "left after 1 of 3, so their results are removed and their other matches are void.";
    w5Check(
      "w5a X-WDT-9: a registrant's own public withdrawal after Start takes all 3 lines out at 1 of 3 played, the hub footnote names the rule, a second press settles nothing twice" +
        (ok ? "" : ` - ${l.created}, settings ${settings.status}, register ${sent.status} ${JSON.stringify(submitted?.entries ?? null)}, rae ${raeId}, generate ${regen.status}, start ${started.status}, hers ${hers.length}, walk ${walk.status}, withdraw ${out.status}/${again.status} ${JSON.stringify(out.json).slice(0, 200)}, after ${after.map((f) => f.status).join(",")}, hub ${hubRes.status} notes ${JSON.stringify(notes)}`),
      ok,
    );
  }

  // Check 10 - X-WDT-10 (RB5-W11 as signed by ruling 289): a disqualification recorded IN a match (the organiser's forfeit with
  // reason disqualified, the console's Forfeit dialog) withdraws the entrant from the league. A league of four: Dee is disqualified
  // in her first match, so she has played 1 of 3 — under half: all three of her lines are taken out and she reads disqualified.
  {
    const l = await league("InMatchDq", 4, own?.id ?? "no-own-competition");
    const dee = l.entrants[0]?.id;
    const started = await v1(owner, `/api/v1/divisions/${l.divId}/start`, "POST");
    const hers = (await l.fixtures()).filter((f) => f.home_entrant_id === dee || f.away_entrant_id === dee);
    const line = hers[0];
    const go = await v1(owner, `/api/v1/fixtures/${line?.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    const dq = await v1(owner, `/api/v1/fixtures/${line?.id}/events`, "POST", {
      expected_seq: v1data<{ seq: number } | undefined>(go)?.seq ?? 1,
      type: "core.forfeit",
      payload: { by: dee, reason: "disqualified" },
    });
    const after = (await l.fixtures()).filter((f) => f.home_entrant_id === dee || f.away_entrant_id === dee);
    const status = (v1data<{ id: string; status: string }[] | undefined>(await v1(owner, `/api/v1/divisions/${l.divId}/entrants`)) ?? []).find((e) => e.id === dee)?.status;
    const ok =
      started.status === 200 && hers.length === 3 && go.status === 201 && dq.status === 201 &&
      after.length === 3 && after.every((f) => f.status === "abandoned") && status === "disqualified";
    w5Check(
      "w5a X-WDT-10: a disqualification recorded in a match withdraws the entrant from the league — at 1 of 3 played all 3 of her lines are taken out and she reads disqualified" +
        (ok ? "" : ` - ${l.created}, start ${started.status}, hers ${hers.length}, start ${go.status}, forfeit ${dq.status} ${JSON.stringify(dq.json).slice(0, 200)}, after ${after.map((f) => f.status).join(",")}, status ${status}`),
      ok,
    );
  }

  // Check 11 - X-WDT-10 (ruling 289's condition): what Disqualify WOULD do, read before the write, is what it then does. A league
  // of five: Fay wins two by walkover, so she has played 2 of 4 — half: her results stand and her other two walk over. The
  // preview says award, 2 of 4, and names those two lines; the PATCH's own report then walks exactly two over.
  {
    const l = await league("DqPreview", 5, own?.id ?? "no-own-competition");
    const fay = l.entrants[0]?.id;
    const started = await v1(owner, `/api/v1/divisions/${l.divId}/start`, "POST");
    const hers = (await l.fixtures()).filter((f) => f.home_entrant_id === fay || f.away_entrant_id === fay);
    const walks: number[] = [];
    for (const f of hers.slice(0, 2)) {
      const opp = f.home_entrant_id === fay ? f.away_entrant_id : f.home_entrant_id;
      walks.push((await v1(owner, `/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: opp, reason: "walkover" } })).status);
    }
    type Pv = { cascade?: boolean; stages?: { mode: string; played: number; scheduled: number; pending: { fixture_id: string }[] }[] };
    const pvRes = await v1(owner, `/api/v1/entrants/${fay}/withdrawal-preview?as=disqualified`);
    const pv = v1data<Pv | undefined>(pvRes);
    const stage = pv?.stages?.[0];
    const bad = await v1(owner, `/api/v1/entrants/${fay}/withdrawal-preview?as=gone`);
    const dq = await v1(owner, `/api/v1/entrants/${fay}`, "PATCH", { status: "disqualified" });
    const report = v1data<{ cascade?: { policy?: string; walkovers?: number } } | undefined>(dq)?.cascade;
    const after = (await l.fixtures()).filter((f) => stage?.pending.some((p) => p.fixture_id === f.id));
    const open = hers.slice(2).map((f) => f.id).sort().join(",");
    const ok =
      started.status === 200 && hers.length === 4 && walks.join(",") === "201,201" && pvRes.status === 200 && pv?.cascade === true &&
      stage?.mode === "award" && stage.played === 2 && stage.scheduled === 4 &&
      stage.pending.map((p) => p.fixture_id).sort().join(",") === open && bad.status === 422 &&
      dq.status === 200 && report?.policy === "walkover" && report.walkovers === 2 && after.length === 2 && after.every((f) => f.status === "forfeited");
    w5Check(
      "w5a X-WDT-10: the Disqualify preview says award at 2 of 4 and names her 2 open lines; the PATCH then walks exactly those over; as=gone is 422" +
        (ok ? "" : ` - ${l.created}, start ${started.status}, hers ${hers.length}, walks ${walks.join(",")}, preview ${pvRes.status} ${JSON.stringify(pv ?? null).slice(0, 300)}, bad ${bad.status}, dq ${dq.status} ${JSON.stringify(report ?? null)}, after ${after.map((f) => f.status).join(",")}`),
      ok,
    );
  }

  // Check 12 - Task 9 (X-CUT-1, X-CUT-3): the league_ko template's own drafts (league, then a top-4 knockout on the setup path)
  // over 6 entrants, every match won by the better seed so the table reads seed order. After the table completes and BEFORE the
  // seeding is confirmed, the 3rd-placed qualifier withdraws: the proposal and, once confirmed, the public division's schedule
  // seat the 5th-placed entrant and never the withdrawn one. Check 6's public competition: `comp` is at its division cap.
  {
    const dRes = await v1(owner, `/api/v1/competitions/${pub?.id ?? "no-public-competition"}/divisions`, "POST", {
      name: "Cut",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const div = v1data<{ id: string; slug: string } | undefined>(dRes);
    const field = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${div?.id}/entrants`, "POST",
        Array.from({ length: 6 }, (_, i) => ({ kind: "individual", display_name: `Cut${i + 1} ${tag}`, seed: i + 1 }))),
    ) ?? [];
    const seedOf = new Map(field.map((e, i) => [e.id, i + 1]));
    const stages = v1data<{ id: string; kind: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${div?.id}/stages`, "POST", [
        { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
        { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" } },
      ]),
    ) ?? [];
    const leagueId = stages.find((x) => x.kind === "league")?.id;
    const koId = stages.find((x) => x.kind === "knockout")?.id;
    const koGen = await v1(owner, `/api/v1/stages/${koId}/generate`, "POST");
    const lgGen = await v1(owner, `/api/v1/stages/${leagueId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${div?.id}/start`, "POST");
    const all = (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${div?.id}/fixtures`)) ?? []);
    const table = all.filter((f) => f.stage_id === leagueId);
    const scored: number[] = [];
    for (const f of table) {
      const homeWins = (seedOf.get(f.home_entrant_id ?? "") ?? 99) < (seedOf.get(f.away_entrant_id ?? "") ?? 99);
      scored.push((await v1(owner, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: 0, type: "generic.result", payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 } })).status);
    }
    const done = v1data<{ completed?: boolean } | undefined>(await v1(owner, `/api/v1/stages/${leagueId}/complete`, "POST"));
    const [third, fifth] = [field[2]?.id, field[4]?.id];
    const left = await v1(owner, `/api/v1/entrants/${third}/withdraw`, "POST");
    const pRes = await v1(owner, `/api/v1/stages/${koId}/seed-proposal`, "POST");
    const proposal = v1data<{ id: string; computed: { qualifiers: { entrantId: string }[] } } | undefined>(pRes);
    const proposed = (proposal?.computed.qualifiers ?? []).map((q) => q.entrantId);
    const want = [field[0]?.id, field[1]?.id, field[3]?.id, fifth].sort().join(",");
    const conf = await v1(owner, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", { proposalId: proposal?.id });
    const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
    const orgSlug = orgs.find((o) => o.id === orgId)?.slug ?? "";
    const schedRes = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${pub?.slug}/divisions/${div?.slug}/schedule`);
    type PubFx = { stage_id: string; home_entrant_id: string | null; away_entrant_id: string | null };
    const sched = v1data<{ fixtures?: PubFx[] } | PubFx[] | undefined>(schedRes);
    const pubRows = (Array.isArray(sched) ? sched : (sched?.fixtures ?? [])).filter((f) => f.stage_id === koId);
    const seated = pubRows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null).sort().join(",");
    const page = await html(newSession(), `/live/${orgSlug}/${pub?.slug}/${div?.slug}`);
    const ok =
      dRes.status === 201 && field.length === 6 && stages.length === 2 && koGen.status === 200 && lgGen.status === 200 && started.status === 200 &&
      table.length === 15 && scored.every((c) => c === 201) && done?.completed === true && left.status === 200 &&
      pRes.status === 201 && proposed.length === 4 && proposed.sort().join(",") === want && !proposed.includes(third ?? "") &&
      // A draw of four: two semi-finals seated, the final still to be decided.
      conf.status === 200 && schedRes.status === 200 && pubRows.length === 3 && seated === want &&
      page.status === 200 && page.body.includes(`Cut5 ${tag}`);
    w5Check(
      "w5a X-CUT-1/X-CUT-3: the 3rd-placed qualifier leaves after the table completes; the proposal and the public schedule seat the 5th, never her" +
        (ok ? "" : ` - div ${dRes.status}, field ${field.length}, stages ${stages.length}, gen ${koGen.status}/${lgGen.status}, start ${started.status}, lines ${table.length}, scored ${scored.join(",")}, done ${JSON.stringify(done ?? null)}, left ${left.status}, proposal ${pRes.status} [${proposed.map((id) => seedOf.get(id)).join(",")}], confirm ${conf.status} ${JSON.stringify(conf.json).slice(0, 200)}, public ${schedRes.status} rows ${pubRows.length} [${seated.split(",").map((id) => seedOf.get(id)).join(",")}], page ${page.status}`),
      ok,
    );

    // Check 14 - Task 11 (X-CUT-4 <- RB5-K6): the SAME division, its seeding confirmed and the finals not started. The champion (1st) now
    // leaves: her confirmed cut is no longer the cut, so the proposal goes stale and her seat is given back (the public schedule shows
    // the finals unseated, not seated with a departed entrant); a fresh proposal offers the next eligible and its confirm seats them.
    // (Own division: both competitions that could take a fifth division are full - `comp` and `pub` hold four each, a fourth competition is 402.)
    {
      const first = field[0]?.id;
      const left1 = await v1(owner, `/api/v1/entrants/${first}/withdraw`, "POST");
      const seatedNow = async () => {
        const r = await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${pub?.slug}/divisions/${div?.slug}/schedule`);
        const sc = v1data<{ fixtures?: PubFx[] } | PubFx[] | undefined>(r);
        const rows = (Array.isArray(sc) ? sc : (sc?.fixtures ?? [])).filter((f) => f.stage_id === koId);
        return { status: r.status, ids: rows.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((x): x is string => x !== null).sort() };
      };
      const gone = await seatedNow();
      const p2 = await v1(owner, `/api/v1/stages/${koId}/seed-proposal`, "POST");
      const next = v1data<{ id: string; computed: { qualifiers: { entrantId: string }[] } } | undefined>(p2);
      const nextIds = (next?.computed.qualifiers ?? []).map((q) => q.entrantId);
      // The table less the champion and the 3rd (already gone): 2nd, 4th, 5th, 6th.
      const want2 = [field[1]?.id, field[3]?.id, field[4]?.id, field[5]?.id].sort().join(",");
      const conf2 = await v1(owner, `/api/v1/stages/${koId}/seed-proposal/confirm`, "POST", { proposalId: next?.id });
      const back = await seatedNow();
      const ok2 =
        left1.status === 200 && gone.status === 200 && gone.ids.length === 0 &&
        p2.status === 201 && nextIds.length === 4 && [...nextIds].sort().join(",") === want2 && !nextIds.includes(first ?? "") &&
        conf2.status === 200 && back.status === 200 && back.ids.join(",") === want2;
      w5Check(
        "w5a X-CUT-4: the champion leaves after the seeding was confirmed and before the finals start; her seat is given back (the finals unseated), the re-proposal offers the next eligible and confirming it seats them" +
          (ok2 ? "" : ` - left ${left1.status}, seated after ${gone.status}/${gone.ids.length}, re-proposal ${p2.status} [${nextIds.map((id) => seedOf.get(id)).join(",")}], confirm ${conf2.status} ${JSON.stringify(conf2.json).slice(0, 200)}, seated again ${back.status} [${back.ids.map((id) => seedOf.get(id)).join(",")}]`),
        ok2,
      );
    }
  }

  // Check 13 - Task 10 (X-RP-2, X-RP-3; RB5-R2, RB5-R3): a started league of PAIRS. Own competition (three divisions so far: room for one).
  {
    const dRes = await v1(owner, `/api/v1/competitions/${own?.id ?? "no-own-competition"}/divisions`, "POST", {
      name: "Pairs",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const divId = v1data<{ id: string } | undefined>(dRes)?.id;
    const persons: string[] = [];
    for (let i = 0; i < 9; i++) {
      const p = v1data<{ id: string } | undefined>(await v1(owner, "/api/v1/persons", "POST", { full_name: `Pair person ${i + 1} ${tag}` }));
      persons.push(p?.id ?? "");
    }
    const pairs = v1data<{ id: string }[] | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
        [0, 1, 2, 3].map((i) => ({
          kind: "pair", display_name: `Pair ${i + 1} ${tag}`, seed: i + 1,
          members: [{ person_id: persons[2 * i] }, { person_id: persons[2 * i + 1] }],
        }))),
    ) ?? [];
    const stageId = v1data<{ id: string } | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: "Pairs" }))?.id;
    await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
    const first = pairs[0]?.id;
    const lines = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const hers = (await lines()).filter((f) => f.home_entrant_id === first || f.away_entrant_id === first);
    const opp = hers[0]?.home_entrant_id === first ? hers[0]?.away_entrant_id : hers[0]?.home_entrant_id;
    const walk = await v1(owner, `/api/v1/fixtures/${hers[0]?.id}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: opp, reason: "walkover" } });
    const swap = await v1(owner, `/api/v1/entrants/${first}`, "PATCH", { members: [{ person_id: persons[0] }, { person_id: persons[8] }] });
    const rosterAfterSwap = v1data<{ members?: { person_id: string }[] } | undefined>(await v1(owner, `/api/v1/entrants/${first}`))?.members?.map((m) => m.person_id).sort().join(",");
    const drop = await v1(owner, `/api/v1/entrants/${first}`, "PATCH", { members: [{ person_id: persons[0] }] });
    const report = v1data<{ status?: string; cascade?: { policy?: string } } | undefined>(drop);
    const after = (await lines()).filter((f) => f.home_entrant_id === first || f.away_entrant_id === first);
    const ok =
      dRes.status === 201 && pairs.length === 4 && started.status === 200 && hers.length === 3 && walk.status === 201 &&
      swap.status === 422 && (swap.json as { error?: { code?: string } } | undefined)?.error?.code === "RR_SUBSTITUTE_PARTNER_REFUSED" &&
      rosterAfterSwap === [persons[0], persons[1]].sort().join(",") &&
      drop.status === 200 && report?.status === "withdrawn" && report.cascade?.policy === "expunge" &&
      after.length === 3 && after.every((f) => f.status === "abandoned");
    w5Check(
      "w5a X-RP-2/X-RP-3: in a started league a substitute partner is refused by name and changes nothing; dropping a partner withdraws the pair (1 of 3 played: all 3 lines taken out)" +
        (ok ? "" : ` - div ${dRes.status}, pairs ${pairs.length}, start ${started.status}, hers ${hers.length}, walk ${walk.status}, swap ${swap.status} ${JSON.stringify(swap.json).slice(0, 200)}, roster ${rosterAfterSwap}, drop ${drop.status} ${JSON.stringify(report ?? null).slice(0, 200)}, after ${after.map((f) => f.status).join(",")}`),
      ok,
    );
  }

  // Check 15 - Task 10b (ruling 292): the partner rule in a started Swiss and a started knockout. A SECOND org: the first one's
  // competitions are at their caps (the module's header). Nothing here reads the first org's data.
  {
    const second = newSession();
    await signIn(second, `delivered+w5a2_${tag}@resend.dev`);
    const c2 = v1data<{ id: string } | undefined>(
      await v1(second, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR A pairs ${tag}`, visibility: "private" }),
    );
    const verdicts: string[] = [];
    for (const kind of ["swiss", "knockout"] as const) {
      const dRes = await v1(second, `/api/v1/competitions/${c2?.id ?? "no-competition"}/divisions`, "POST", {
        name: `Pairs ${kind}`,
        sport_key: "generic",
        variant_key: "score",
        config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      });
      const divId = v1data<{ id: string } | undefined>(dRes)?.id;
      const persons: string[] = [];
      for (let i = 0; i < 9; i++) {
        const p = v1data<{ id: string } | undefined>(await v1(second, "/api/v1/persons", "POST", { full_name: `${kind} person ${i + 1} ${tag}` }));
        persons.push(p?.id ?? "");
      }
      const pairs = v1data<{ id: string }[] | undefined>(
        await v1(second, `/api/v1/divisions/${divId}/entrants`, "POST",
          [0, 1, 2, 3].map((i) => ({
            kind: "pair", display_name: `${kind} pair ${i + 1} ${tag}`, seed: i + 1,
            members: [{ person_id: persons[2 * i] }, { person_id: persons[2 * i + 1] }],
          }))),
      ) ?? [];
      const stageId = v1data<{ id: string } | undefined>(
        await v1(second, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind, name: kind, ...(kind === "swiss" ? { config: { rounds: 2 } } : {}) }),
      )?.id;
      const started = await v1(second, `/api/v1/divisions/${divId}/start`, "POST");
      if (kind === "swiss") await v1(second, `/api/v1/stages/${stageId}/generate`, "POST");
      const last = pairs[3]?.id;
      const seated = async () =>
        (v1data<Fx[] | undefined>(await v1(second, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter(
          (f) => f.stage_id === stageId && (f.home_entrant_id === last || f.away_entrant_id === last) && f.home_entrant_id && f.away_entrant_id,
        );
      const before = await seated();
      const opp = before[0]?.home_entrant_id === last ? before[0]?.away_entrant_id : before[0]?.home_entrant_id;
      const swap = await v1(second, `/api/v1/entrants/${last}`, "PATCH", { members: [{ person_id: persons[6] }, { person_id: persons[8] }] });
      const rosterAfterSwap = v1data<{ members?: { person_id: string }[] } | undefined>(await v1(second, `/api/v1/entrants/${last}`))?.members?.map((m) => m.person_id).sort().join(",");
      const drop = await v1(second, `/api/v1/entrants/${last}`, "PATCH", { members: [{ person_id: persons[6] }] });
      const report = v1data<{ status?: string } | undefined>(drop);
      const after = await seated();
      const back = await v1(second, `/api/v1/entrants/${last}`, "PATCH", { status: "registered" });
      const reinstated = v1data<{ status?: string } | undefined>(back);
      const ok =
        dRes.status === 201 && pairs.length === 4 && started.status === 200 && before.length === 1 &&
        swap.status === 422 && (swap.json as { error?: { code?: string } } | undefined)?.error?.code === "RR_SUBSTITUTE_PARTNER_REFUSED" &&
        rosterAfterSwap === [persons[6], persons[7]].sort().join(",") &&
        drop.status === 200 && report?.status === "withdrawn" &&
        after.length === 1 && after[0]?.status === "forfeited" && opp !== undefined && opp !== null &&
        back.status === 200 && reinstated?.status === "registered";
      verdicts.push(ok ? `${kind} ok` : `${kind} FAILED - div ${dRes.status}, pairs ${pairs.length}, start ${started.status}, before ${before.length}, swap ${swap.status} ${JSON.stringify(swap.json).slice(0, 160)}, roster ${rosterAfterSwap}, drop ${drop.status} ${JSON.stringify(report ?? null).slice(0, 120)}, after ${after.map((f) => f.status).join(",")}, back ${back.status}`);
    }
    w5Check(
      "w5a X-RP-2/X-RP-3 (ruling 292): in a started Swiss and a started knockout a substitute partner is refused by name; dropping a partner withdraws the pair and walks her line over; Reinstate puts her back" +
        (verdicts.every((v) => v.endsWith(" ok")) ? "" : ` - ${verdicts.join("; ")}`),
      verdicts.length === 2 && verdicts.every((v) => v.endsWith(" ok")),
    );
  }

  // Task 15 (X-BD-3): the sport-agnostic two-tier card, through the real route.
  {
    // A fresh org: the first one's competitions are at their caps (the module's header).
    const third = newSession();
    await signIn(third, `delivered+w5a3_${tag}@resend.dev`);
    type Made = { templateKey: string; divisions: { id: string; stages: { id: string; fixtureCount: number }[] }[] };
    const made = await v1(third, "/api/v1/competitions/from-template", "POST", {
      template_key: "super-groups", name: `W5 super groups ${tag}`, ends_on: "2030-12-31",
      sport_key: "badminton", variant_key: "short", entrant_kind: "pair", entrant_count: 24,
    });
    const out = v1data<Made | undefined>(made);
    const divId = out?.divisions[0]?.id;
    const div = divId ? v1data<{ sport_key?: string; config?: { entrants?: { kinds?: string[] } } } | undefined>(await v1(third, `/api/v1/divisions/${divId}`)) : undefined;
    const stages = divId
      ? (v1data<{ seq: number; kind: string; config: { pools?: { count: number } } }[] | undefined>(await v1(third, `/api/v1/divisions/${divId}/stages`)) ?? []).sort((a, b) => a.seq - b.seq)
      : [];
    const unchosen = await v1(third, "/api/v1/competitions/from-template", "POST", { template_key: "super-groups", name: `W5 super groups none ${tag}`, ends_on: "2030-12-31" });
    const fixed = await v1(third, "/api/v1/competitions/from-template", "POST", { template_key: "t20-super8", name: `W5 t20 choice ${tag}`, ends_on: "2030-12-31", sport_key: "football" });
    w5Check(
      "w5a X-BD-3: super-groups builds a badminton pairs event of 24 (6 pools of 4, 2 groups, a knockout); a choice left out or offered to a fixed card is refused by name" +
        (made.status === 201 && unchosen.status === 400 && fixed.status === 400
          ? ""
          : ` - made ${made.status} ${JSON.stringify(made.json).slice(0, 200)}, unchosen ${unchosen.status} ${JSON.stringify(unchosen.json).slice(0, 160)}, fixed ${fixed.status} ${JSON.stringify(fixed.json).slice(0, 160)}`),
      made.status === 201 && out?.templateKey === "super-groups" && div?.sport_key === "badminton" &&
        JSON.stringify(div?.config?.entrants?.kinds) === JSON.stringify(["pair"]) &&
        JSON.stringify(stages.map((x) => x.kind)) === JSON.stringify(["group", "group", "knockout"]) &&
        JSON.stringify(stages.map((x) => x.config.pools?.count)) === JSON.stringify([6, 2, undefined]) &&
        unchosen.status === 400 && (unchosen.json as { error?: { code?: string } } | undefined)?.error?.code === "TEMPLATE_CHOICE_REQUIRED" &&
        fixed.status === 400 && (fixed.json as { error?: { code?: string } } | undefined)?.error?.code === "TEMPLATE_CHOICE_NOT_OFFERED",
    );
  }

  // Check 16 - Task 13 (X-PO-3, X-PO-4; RB5-P5, RB5-P7): the rank override per pool, refused above the table's size and on a bracket; a
  // withdrawal takes the leaver's pin with her.
  {
    // Its own org: the first one's competitions are at their caps (the module's header), as check 15 found. B4 merge: `w5a5_`, since
    // the super-groups check above signs in `w5a3_` - each check keeps an org of its own.
    const third = newSession();
    await signIn(third, `delivered+w5a5_${tag}@resend.dev`);
    const pinComp = v1data<{ id: string } | undefined>(
      await v1(third, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR A pin ${tag}`, visibility: "private" }),
    );
    const l = await league("Pin", 4, pinComp?.id ?? "no-pin-competition", third);
    const [first, second] = l.entrants;
    const code = (r: { json?: unknown }) => (r.json as { error?: { code?: string } } | undefined)?.error?.code;
    const pin = (entrant: string | undefined, rank: number) =>
      v1(third, `/api/v1/stages/${l.stageId}/standings/override`, "POST", { rows: [{ entrant_id: entrant, rank, reason: "smoke" }] });
    const over = await pin(first?.id, 5);
    const storedAfterOver = (await l.stage())?.config as { rank_overrides?: unknown[] } | undefined;
    const exact = await pin(first?.id, 4);
    const both = await v1(third, `/api/v1/stages/${l.stageId}/standings/override`, "POST", {
      rows: [{ entrant_id: first?.id, rank: 4, reason: "smoke" }, { entrant_id: second?.id, rank: 3, reason: "smoke" }],
    });
    const ko = v1data<{ id: string } | undefined>(await v1(third, `/api/v1/divisions/${l.divId}/stages`, "POST", { seq: 2, kind: "knockout", name: "Finals" }));
    const onKo = await v1(third, `/api/v1/stages/${ko?.id}/standings/override`, "POST", { rows: [{ entrant_id: first?.id, rank: 1, reason: "smoke" }] });
    const gone = await v1(third, `/api/v1/entrants/${first?.id}/withdraw`, "POST");
    const remaining = ((await l.stage())?.config as { rank_overrides?: { entrant_id: string }[] } | undefined)?.rank_overrides;
    const ok =
      over.status === 422 && code(over) === "RR_RANK_OVERRIDE_POOL" && storedAfterOver?.rank_overrides === undefined &&
      exact.status === 200 && both.status === 200 &&
      ko?.id !== undefined && onKo.status === 422 && code(onKo) === "RR_RANK_OVERRIDE_NOT_TABLE" &&
      gone.status === 200 && remaining?.length === 1 && remaining[0]?.entrant_id === second?.id;
    w5Check(
      "w5a X-PO-3/X-PO-4: a pin above the table's size is refused at write, one on a knockout stage is refused by name, and a withdrawal takes the leaver's pin away" +
        (ok ? "" : ` - ${l.created}, over ${over.status} ${JSON.stringify(over.json).slice(0, 160)}, stored ${JSON.stringify(storedAfterOver?.rank_overrides)}, exact ${exact.status}, both ${both.status} ${JSON.stringify(both.json).slice(0, 160)}, ko ${ko?.id}, onKo ${onKo.status} ${JSON.stringify(onKo.json).slice(0, 160)}, gone ${gone.status}, remaining ${JSON.stringify(remaining)}`),
      ok,
    );
  }

  // Check 17 - Task 17 (X-BD-4 <- RB5-S4, CS-1): a second Complete is a no-op that says so. A FOURTH org (the first's competitions are at their caps).
  {
    const fourth = newSession();
    await signIn(fourth, `delivered+w5a4_${tag}@resend.dev`);
    const c2 = v1data<{ id: string } | undefined>(
      await v1(fourth, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR A twice ${tag}`, visibility: "private" }),
    );
    const dRes = await v1(fourth, `/api/v1/competitions/${c2?.id}/divisions`, "POST", {
      name: "Twice",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const div = v1data<{ id: string } | undefined>(dRes);
    const field = v1data<{ id: string }[] | undefined>(
      await v1(fourth, `/api/v1/divisions/${div?.id}/entrants`, "POST",
        Array.from({ length: 4 }, (_, i) => ({ kind: "individual", display_name: `Twice${i + 1} ${tag}`, seed: i + 1 }))),
    ) ?? [];
    const seedOf = new Map(field.map((e, i) => [e.id, i + 1]));
    const stages = v1data<{ id: string; kind: string }[] | undefined>(
      await v1(fourth, `/api/v1/divisions/${div?.id}/stages`, "POST", [
        { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
        { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }], placement: "rank_order", timing: "setup" } },
      ]),
    ) ?? [];
    const leagueId = stages.find((x) => x.kind === "league")?.id;
    const koId = stages.find((x) => x.kind === "knockout")?.id;
    await v1(fourth, `/api/v1/stages/${koId}/generate`, "POST");
    await v1(fourth, `/api/v1/stages/${leagueId}/generate`, "POST");
    await v1(fourth, `/api/v1/divisions/${div?.id}/start`, "POST");
    const lines = async () => (v1data<Fx[] | undefined>(await v1(fourth, `/api/v1/divisions/${div?.id}/fixtures`)) ?? []);
    const table = (await lines()).filter((f) => f.stage_id === leagueId);
    const scored: number[] = [];
    for (const f of table) {
      const homeWins = (seedOf.get(f.home_entrant_id ?? "") ?? 99) < (seedOf.get(f.away_entrant_id ?? "") ?? 99);
      scored.push((await v1(fourth, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: 0, type: "generic.result", payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 } })).status);
    }
    type Done = { completed?: boolean; already_complete?: boolean; seed_proposal?: { id: string; status: string } | null } | undefined;
    const first = v1data<Done>(await v1(fourth, `/api/v1/stages/${leagueId}/complete`, "POST"));
    const koBefore = JSON.stringify((await lines()).filter((f) => f.stage_id === koId).map((f) => [f.id, f.home_entrant_id, f.away_entrant_id, f.status]));
    const secondRes = await v1(fourth, `/api/v1/stages/${leagueId}/complete`, "POST");
    const second = v1data<Done>(secondRes);
    const third = v1data<Done>(await v1(fourth, `/api/v1/stages/${leagueId}/complete`, "POST"));
    const koAfter = JSON.stringify((await lines()).filter((f) => f.stage_id === koId).map((f) => [f.id, f.home_entrant_id, f.away_entrant_id, f.status]));
    const ok =
      dRes.status === 201 && field.length === 4 && stages.length === 2 && table.length === 6 && scored.every((c) => c === 201) &&
      first?.completed === true && first.already_complete === undefined && first.seed_proposal?.status === "draft" &&
      secondRes.status === 200 && second?.completed === false && second.already_complete === true && second.seed_proposal?.id === first.seed_proposal.id &&
      third?.already_complete === true && third.seed_proposal?.id === first.seed_proposal.id &&
      koBefore === koAfter && koBefore.length > 2;
    w5Check(
      "w5a X-BD-4: a second Complete answers already_complete with the one draft, and the knockout and the proposal stand as they were" +
        (ok ? "" : ` - div ${dRes.status}, field ${field.length}, scored ${scored.join(",")}, first ${JSON.stringify(first)}, second ${secondRes.status} ${JSON.stringify(second)}, third ${JSON.stringify(third)}, ko same ${koBefore === koAfter}`),
      ok,
    );
  }

  check(`w5a: the W5 round-robin app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
