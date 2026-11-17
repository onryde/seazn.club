import "server-only";
import { sql, withTenant } from "@/lib/db";
// Since #382 a manual save AT THE CAP rolls the window instead of refusing, so
// PaymentRequiredError survives here for one case only: a quota that resolves
// below 1, where there is no window to roll (see `createCheckpoint`).
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { getLimit } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { divisionLockState } from "../schedule";
import { divisionMeta, loadLedger } from "./ledger";
import { publishHistoryWrite, stepWrite } from "./undo-redo";

/** `manual` = an organiser's own save point, counted against
 *  schedule.checkpoints.max. `ai` = an undo anchor the AI accept flow creates on
 *  their behalf (V303) — exempt, because it is the feature's bookkeeping, not
 *  something the organiser chose to spend a slot on. */
export type CheckpointKind = "manual" | "ai";

export interface CheckpointRow {
  id: string;
  seq: number;
  label: string;
  kind: CheckpointKind;
  created_at: string;
  /** True for every AI anchor except the newest — the panel strikes these
   *  through. They stay restorable: the ledger can rewind to any watermark, and
   *  jumping back two AI runs is a real capability worth keeping. */
  superseded?: boolean;
  /** #382 — set on the row RETURNED BY A CREATE, never by a list: the save
   *  point this one pushed out of the plan's rolling window. The panel names it
   *  in a non-blocking notice, so the organiser learns which label they lost
   *  rather than discovering it missing later.
   *
   *  Present only when something was actually dropped. One name, even when a
   *  downgrade drops several — see `createCheckpoint`. */
  evicted?: { id: string; label: string };
}

export async function listCheckpoints(auth: AuthCtx, divisionId: string): Promise<CheckpointRow[]> {
  const rows = await withTenant(auth.orgId, (tx) => tx<CheckpointRow[]>`
    select id, seq, label, kind, created_at from division_checkpoints
    where division_id = ${divisionId} order by created_at desc`);
  // Newest first, so the first `ai` row is the live anchor and the rest are
  // superseded. Derived on read rather than stored — a stored flag would need
  // updating on every AI apply and could drift.
  let seenLiveAi = false;
  return rows.map((r) => {
    if (r.kind !== "ai") return r;
    if (!seenLiveAi) {
      seenLiveAi = true;
      return r;
    }
    return { ...r, superseded: true };
  });
}

/** The competition an Event-Pass-lifted gate must be resolved against.
 *
 *  lib/entitlements.ts only consults `competition_passes` when a competition is
 *  in scope, so a gate on a key V393 lifts (`schedule.checkpoints.max`) that omits it makes the
 *  pass INVISIBLE — the org pays $29 and is refused on the competition it
 *  bought. Same shape as usecases/officials.ts's `competitionForDivision` (T6).
 *
 *  Pooled `sql`, and deliberately OUTSIDE the `withTenant` callback below:
 *  `resolve` queries the pooled proxy, and issuing that from inside a pinned
 *  tenant transaction asks the pool for a second connection while the first is
 *  still held — the self-deadlock lib/db.ts guards against.
 *
 *  A missing row yields `undefined`, which resolves the gate org-wide (the
 *  pre-V393 behaviour) and the 404 is raised inside the transaction as before. */
async function competitionForDivision(divisionId: string): Promise<string | undefined> {
  const [row] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  return row?.competition_id;
}

export async function createCheckpoint(
  auth: AuthCtx,
  divisionId: string,
  label: string,
  kind: CheckpointKind = "manual",
): Promise<CheckpointRow> {
  // The plan LOOKUP is resolved out here; the COUNT stays inside the
  // transaction with the insert (doc 10 §2 rule 1). `getLimit` queries the
  // pooled `sql` proxy, and `withTenant` pins a pooled connection for its whole
  // callback — see `assertWithinLimit` in lib/entitlements.ts.
  // V393 lifts this cap on an Event Pass (community 2 -> event_pass 5), so the
  // read is scoped to this division's competition.
  const checkpointLimit = await getLimit(
    auth.orgId,
    "schedule.checkpoints.max",
    await competitionForDivision(divisionId),
  );
  return withTenant(auth.orgId, async (tx) => {
    // #382 review, finding 3: the roll below is count → delete → insert, and
    // without this lock those three steps are not serialised. Two saves landing
    // together (the realistic shape is one owner double-clicking Save, not two
    // admins) both read the same count, both compute the same `drop`, and both
    // target the SAME oldest row — one DELETE takes it, the other takes nothing
    // and so reports no `evicted` — while both INSERTs land. The division ends
    // at limit + 1 and one organiser is never told a bookmark went. It
    // self-corrects on the next save, which is exactly why it went unnoticed.
    //
    // The key is `division:<id>`, byte-identical to `lockDivisions`
    // (competition-schedule-apply.ts) and to `step`/`restoreCheckpoint` below:
    // the checkpoint window is a fact ABOUT a division, so it must serialise
    // against every other writer of that division's plan, not just against
    // other checkpoint saves. A private key would leave an apply free to move
    // the watermark this insert is about to read.
    //
    // Safe to take here because `createCheckpoint` is a LEAF — the checkpoints
    // route is its only caller — so this transaction never holds
    // `division:<id>` while some nested call waits for the same key on another
    // connection. `pg_advisory_xact_lock` releases at commit or rollback, so
    // nothing survives the transaction either.
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const meta = await divisionMeta(tx, divisionId);
    // Jul3/03 §7 → V290: save points are a per-plan quota (community 1,
    // pro 5, pro_plus unlimited). schedule.versioning still gates scope locks.
    //
    // V303: the count is MANUAL rows only. Charging the organiser for the AI
    // flow's own undo anchor is what previously blocked a community org that
    // already held one save point from applying an AI schedule at all — the
    // create 402'd, the apply aborted, and the AI generation was already spent.
    //
    // #382: at the cap this used to throw PaymentRequiredError. It now ROLLS.
    // A checkpoint is a named bookmark, not the history — the ledger keeps
    // every event and restore is "undo until the watermark reaches this seq",
    // so dropping a save point costs the LABEL, not the ability to rewind that
    // far. Refusing the save cost the organiser the thing they were doing, in
    // the middle of doing it, which is a far worse trade than losing the oldest
    // bookmark. The quota still means something: it is the width of the window.
    let evicted: { id: string; label: string } | undefined;
    if (kind === "manual") {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from division_checkpoints
        where division_id = ${divisionId} and kind = 'manual'`;
      const limit = checkpointLimit;
      // #382 review, finding 2: a quota below 1 has NO window to roll, so the
      // rolling branch cannot express it. `drop = n - limit + 1` at n=0/limit=0
      // asks to delete one row from an empty table — the delete removes nothing
      // and the insert lands anyway, leaving an org entitled to zero save points
      // permanently holding one, with the "post-insert count is exactly the
      // limit" invariant broken on the one input where it mattered.
      //
      // Refusing is a quota refusal, so it is `PaymentRequiredError` with the
      // feature key, the shape every other quota gate in usecases/ uses
      // (clubs.ts, divisions.ts, entrants.ts, competitions.ts).
      //
      // Zero is reachable two ways and this deliberately does not distinguish
      // them: a staff override with `int_value = 0`, and a MISSING
      // `plan_entitlements` row, which `getLimit` also resolves to 0. The
      // override is a deliberate grant of nothing and must be honoured. The
      // missing row is a mis-seeded database — and there, refusing is still the
      // better answer than the old behaviour, which silently held one save point
      // and lied about the count. All three real plan keys (community 2, pro 5,
      // pro_plus unlimited) carry a row, so a correctly migrated database cannot
      // reach this by accident; `event_pass`/`event_pass_l` have no row, but
      // they are pass keys, never an org's plan key, and this read passes no
      // competition so no pass overlay applies.
      if (limit !== null && limit < 1) throw new PaymentRequiredError("schedule.checkpoints.max");
      // A null limit is unlimited (pro_plus) — never evict.
      if (limit !== null && n >= limit) {
        // Delete n - limit + 1, so the POST-INSERT count is exactly the limit.
        // Do not assume n === limit: a plan downgrade can leave a division above
        // the cap, and one save must bring it back to the limit, not to n.
        //
        // Order: created_at asc, seq asc, id asc. The `id` tie-break is a UUID,
        // which the determinism rule normally forbids — acceptable here because
        // this is SELECTION INPUT, not output ordering, the same exemption
        // advisory-lock ordering gets. Do not "fix" it.
        const drop = n - limit + 1;
        const gone = await tx<
          { id: string; label: string; created_at: Date | string; seq: string | number }[]
        >`
          delete from division_checkpoints
           where id in (
             select id from division_checkpoints
              where division_id = ${divisionId} and kind = 'manual'
              order by created_at asc, seq asc, id asc
              limit ${drop}
           )
           returning id, label, created_at, seq`;
        // RETURNING does NOT preserve the subquery's ORDER BY — Postgres hands
        // back deleted rows in whatever order it removed them. Re-apply the
        // same ordering here rather than trusting the array's shape.
        //
        // The notice names ONE save point; when several go (a downgrade), name
        // the newest of them — it is the one the organiser is likeliest to miss.
        const newest = gone
          .slice()
          .sort(
            (a, b) =>
              new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
              Number(a.seq) - Number(b.seq) ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )
          .at(-1);
        if (newest) evicted = { id: newest.id, label: newest.label };
      }
    }
    const ledger = await loadLedger(tx, divisionId);
    const wm = meta.edit_watermark ?? (ledger[ledger.length - 1]?.seq ?? 0);
    const [row] = await tx<CheckpointRow[]>`
      insert into division_checkpoints (division_id, seq, label, kind, created_by)
      values (${divisionId}, ${wm}, ${label}, ${kind}, ${auth.userId})
      returning id, seq, label, kind, created_at`;
    // #382: AI anchors are exempt from the manual quota and nothing ever deleted
    // them, so they accumulated one per AI apply, for ever — `superseded` is
    // derived on read, not stored, and the only other DELETE is the organiser's
    // own. Keep the newest 3.
    //
    // Three, not one: `CheckpointRow.superseded` exists because jumping back
    // two AI runs is a capability worth keeping, and two runs back plus the
    // newest is exactly 3. No notice for these — the organiser did not name
    // them and the panel already strikes the superseded ones through.
    //
    // AFTER the insert, so the row just created is always among the survivors.
    // Same ordering exemption as the manual eviction above: selection input.
    // The V303 index (division_id, kind, created_at desc) already serves it.
    if (kind === "ai") {
      await tx`
        delete from division_checkpoints
         where id in (
           select id from division_checkpoints
            where division_id = ${divisionId} and kind = 'ai'
            order by created_at desc, seq desc, id desc
            offset 3
         )`;
    }
    return { ...row!, ...(evicted ? { evicted } : {}) };
  });
}

/** DELETE /divisions/{id}/checkpoints/{checkpointId} — drop a save point.
 *
 *  Deleting a MANUAL save point frees a quota slot, which is the point: the
 *  quota is per-division and nothing could reclaim one, so an organiser who
 *  made a save point they no longer wanted was stuck with it — on community,
 *  that meant permanently holding their only slot.
 *
 *  AI anchors are deletable too. They cost no quota so there is no need to
 *  remove one, but they are rows in the organiser's own division and hiding the
 *  affordance would be stranger than allowing it. The next AI apply creates a
 *  fresh anchor regardless. */
export async function deleteCheckpoint(
  auth: AuthCtx,
  divisionId: string,
  checkpointId: string,
): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    // Scoped by division as well as id, so a checkpoint id belonging to another
    // division cannot be deleted by guessing it.
    //
    // The lookup used to BE the delete (`delete … returning id`, 404 on no
    // row). It is split in two now so the freeze guard has somewhere to stand
    // that keeps 404 ahead of 422: a checkpoint that does not exist must still
    // answer "checkpoint not found" on a frozen division, which a guard placed
    // before a combined delete-and-check could not do. Both halves run in the
    // same transaction, so nothing can delete the row between them.
    const [row] = await tx<{ id: string }[]>`
      select id from division_checkpoints
      where id = ${checkpointId} and division_id = ${divisionId}`;
    if (!row) throw new HttpError(404, "checkpoint not found");
    // Deleting a save point is destroying a REWIND, which is precisely what the
    // freeze exists to protect — and it is irreversible, unlike every other
    // refusal in this file. The panel had already reached this conclusion for
    // the safer half of the same row: Restore got `disabled={busy ||
    // scheduleLocked}` while Delete beside it kept `disabled={busy}`, so a
    // frozen division's only save point could be destroyed from a console that
    // had visibly greyed out the button that would merely have USED it.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    await tx`
      delete from division_checkpoints
      where id = ${checkpointId} and division_id = ${divisionId}`;
  });
}

/** POST /divisions/{id}/restore — undo repeatedly to the checkpoint's
 *  watermark (guarded by the same results-guard as single undo). */
export async function restoreCheckpoint(
  auth: AuthCtx,
  divisionId: string,
  checkpointId: string,
  confirm: boolean,
): Promise<{ watermark: number; steps: number }> {
  if (!confirm) throw new HttpError(422, "restore requires confirm: true");
  const target = await withTenant(auth.orgId, async (tx) => {
    const [cp] = await tx<{ seq: string | number }[]>`
      select seq from division_checkpoints
      where id = ${checkpointId} and division_id = ${divisionId}`;
    if (!cp) throw new HttpError(404, "checkpoint not found");
    // A freeze has to stop the REWIND as well as the clear. Restore is the
    // wider of the two: `clearScheduleScoped` empties unlocked slots, this
    // rewrites every fixture's time and court back to the save point — and the
    // two controls sit in the same console a few hundred pixels apart, so a
    // freeze that only bound one of them refused the smaller edit and allowed
    // the larger.
    //
    // Same 422, same code, same sentence as every other board-write refusal:
    // all of them now throw `SCHEDULE_LOCKED_MESSAGE`/`SCHEDULE_LOCKED_CODE`
    // out of `@/lib/schedule-lock`, so a reword is one edit and the set of
    // refusing paths is that constant's import graph rather than a list typed
    // into a comment. See `step` above for why a typed list is not kept here.
    //
    // `step` (undo/redo) now carries the same guard, and this one is still
    // load-bearing rather than redundant: a restore whose watermark has already
    // reached the checkpoint short-circuits to `{ steps: 0 }` in the loop below
    // WITHOUT ever calling undo, so only this guard can refuse that call. The
    // two are pinned by separate cases in history.test.ts for exactly that
    // reason. It also has to be ahead of the loop regardless: inside it, the
    // first undo would already have landed.
    //
    // After the checkpoint lookup, so a checkpoint that does not exist (or
    // belongs to another division) still answers 404 rather than 422 — the
    // ordering `clearScheduleScoped` uses for its own existence check.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    return Number(cp.seq);
  });
  let steps = 0;
  // R10e: every fixture any step changed, published ONCE when the rewind ends
  // (or stops part-way: the steps that committed stay committed), not once
  // per step — a restore is one organiser write.
  const changed = new Set<string>();
  let scoredFixtureRemoved = false;
  let competitionId = "";
  try {
    // Each undo is its own single-writer append (concurrency-safe); stop once
    // the watermark reaches the checkpoint.
    for (let i = 0; i < 500; i++) {
      const meta = await withTenant(auth.orgId, (tx) => divisionMeta(tx, divisionId));
      competitionId = meta.competition_id;
      const ledger = await withTenant(auth.orgId, (tx) => loadLedger(tx, divisionId));
      const wm = meta.edit_watermark ?? (ledger[ledger.length - 1]?.seq ?? 0);
      if (wm <= target) return { watermark: wm, steps };
      const write = await stepWrite(auth, divisionId, "undo", undefined);
      for (const id of write.fixtureIds) changed.add(id);
      if (write.scoredFixtureRemoved) scoredFixtureRemoved = true;
      steps++;
    }
    throw new HttpError(500, "restore did not converge");
  } finally {
    publishHistoryWrite(auth, divisionId, competitionId, [...changed], scoredFixtureRemoved);
  }
}

// ---------------------------------------------------------------------------
// Scoped clear + remove-teams-in-pool (Jul3/03 §5)
// ---------------------------------------------------------------------------
