// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { call, check, newSession, signIn, tag, v1, v1data } from "../harness.ts";

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
 * Every check is counted, and a run that checked nothing fails. SMOKE_ONLY=w5RoundRobinA runs it alone (SELECTABLE_SUITES).
 */
export async function w5RoundRobinASuite(): Promise<void> {
  // T2: 2 (4 -> 6 reconciles by pair; a 5-team league persists its byes). T3: 1 (Add match lands in the round both sides are free).
  // T5: 2 (a late player's catch-up lines; Undo across the add refused by name). T5b: 1 (her hub row reads Joined round 3).
  // T6: 1 (an automatic arrival waits; one tap places it; a second tap is refused by name).
  const EXPECTED_CHECKS = 7;
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
  };
  type StageOut = { id: string; config: { round_byes?: { round_no: number; leg: number; entrant_id: string }[] } };

  /** A generic league of `n` entrants, generated once. */
  async function league(label: string, n: number, compId: string | undefined = comp?.id) {
    const divRes = await v1(owner, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name: label,
        sport_key: "generic",
        variant_key: "score",
        config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      });
    const divId = v1data<{ id: string } | undefined>(divRes)?.id;
    const addEntrants = async (from: number, to: number) =>
      v1data<{ id: string }[] | undefined>(
        await v1(owner, `/api/v1/divisions/${divId}/entrants`, "POST",
          Array.from({ length: to - from + 1 }, (_, i) => ({ kind: "individual", display_name: `${label}${from + i} ${tag}`, seed: from + i }))),
      ) ?? [];
    const entrants = await addEntrants(1, n);
    const stageId = v1data<{ id: string } | undefined>(
      await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: label }),
    )?.id;
    const generate = () => v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
    await generate();
    const fixtures = async () =>
      (v1data<Fx[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? []).filter((f) => f.stage_id === stageId);
    const stage = async () =>
      (v1data<StageOut[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`)) ?? []).find((s) => s.id === stageId);
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

  // Check 6 - X-CU-10 / RB5-L5: the late player's row in the public hub document reads "Joined round 3" while her catch-up lines remain.
  {
    const pub = v1data<{ id: string; slug: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR A hub ${tag}`, visibility: "public" }),
    );
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

  // Check 7 - X-CU-8 / RB5-L10: a reinstated player with no line waits; one tap writes her catch-up lines; a second tap is refused.
  {
    // Its own competition: `comp` already holds four divisions, the plan's per-competition cap (a 5th answers 402).
    const own = v1data<{ id: string } | undefined>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W5 RR A wait ${tag}`, visibility: "private" }),
    );
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

  check(`w5a: the W5 round-robin app-A suite ran its ${EXPECTED_CHECKS} checks (ran ${checked})`, checked === EXPECTED_CHECKS);
}
