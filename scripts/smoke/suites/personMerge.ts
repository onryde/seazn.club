// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, setPlan } from "../harness.ts";

/** #404: the duplicate-review queue and the reversible merge behind it, over
 *  real HTTP — the four claims the DB-backed suites cannot make from outside:
 *   • `GET /persons/duplicates` ranks a same-name pair and says WHY it did;
 *   • a merge body without `confirmed` is refused 422 MERGE_NOT_CONFIRMED —
 *     the gate that makes every merge a named human decision;
 *   • a merge PRESERVES a suspension, repointed to the survivor. This is the
 *     shipped defect the wave exists to end: the old merge DELETED the absorbed
 *     row, so a ban recorded against it vanished with it. Asserted as a pair
 *     (before: on the absorbed person / after: on the survivor) so it cannot be
 *     satisfied by a suspension that never existed;
 *   • the merge is durable in `GET /persons/merges`, one reversal puts BOTH
 *     records back on the roster, and a second reversal is 409.
 *  Own fresh Pro org (`discipline.enforced` is Pro-gated, and the suspension is
 *  the load-bearing assertion); keyless-safe and spends no AI tokens. */
export async function personMergeSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+dupmerge_${tag}@resend.dev`);
  const orgId = who.org_id;
  await setPlan(orgId, "pro", owner);

  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Dupe Cup ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );

  // Two records for one human. `keep` is inserted first, so the queue offers it
  // as the survivor (`a` is the older row). The names are identical because a
  // shared normalised name is the queue's entry ticket.
  const NAME = `Priya Raman ${tag}`;
  const mkPerson = async (consent: Record<string, boolean>) =>
    v1data<{ id: string; full_name: string }>(
      await v1(owner, "/api/v1/persons", "POST", { full_name: NAME, consent }),
    );
  const keep = await mkPerson({ public_name: true, public_photo: true });
  const dupe = await mkPerson({ public_name: false, public_photo: true });

  // The ban goes on the record that is about to be ABSORBED — the direction
  // that used to lose it.
  const REASON = `smoke ${tag}: dissent`;
  const banned = await v1(owner, `/api/v1/divisions/${div.id}/suspensions`, "POST", {
    person_id: dupe.id,
    matches_total: 2,
    reason: REASON,
  });
  type SuspensionOut = { id: string; personId: string; reason: string; matchesTotal: number };
  const suspensions = async () =>
    v1data<SuspensionOut[]>(await v1(owner, `/api/v1/divisions/${div.id}/suspensions`));
  const before = await suspensions();
  check(
    "#404: the absorbed person carries a live suspension before the merge",
    banned.status === 201 &&
      before.length === 1 &&
      before[0].personId === dupe.id &&
      before[0].reason === REASON,
  );

  // --- The queue ranks the pair and shows its working.
  type Candidate = {
    a: { id: string };
    b: { id: string };
    score: number;
    evidence: { kind: string; detail: string }[];
  };
  const queue = v1data<{ items: Candidate[] }>(await v1(owner, "/api/v1/persons/duplicates"));
  const pair = queue.items.find(
    (c) =>
      (c.a.id === keep.id && c.b.id === dupe.id) || (c.a.id === dupe.id && c.b.id === keep.id),
  );
  check(
    "#404: the duplicate queue offers the same-name pair, with name evidence",
    !!pair && pair.score >= 1 && pair.evidence.some((e) => e.kind === "name"),
  );

  // --- A merge nobody confirmed is a refused ACTION (422), not a bad request.
  const unconfirmed = await v1(owner, `/api/v1/persons/${keep.id}/merge`, "POST", {
    duplicate_id: dupe.id,
  });
  check(
    "#404: a merge without `confirmed` is refused 422 MERGE_NOT_CONFIRMED",
    unconfirmed.status === 422 && unconfirmed.json.error?.code === "MERGE_NOT_CONFIRMED",
  );

  // --- The confirmed merge.
  const merged = await v1(owner, `/api/v1/persons/${keep.id}/merge`, "POST", {
    duplicate_id: dupe.id,
    confirmed: true,
  });
  const result = v1data<{ merge_id: string; survivor: { id: string; consent: unknown } }>(merged);
  check(
    "#404: a confirmed merge keeps the named survivor",
    merged.status === 200 && result.survivor.id === keep.id && !!result.merge_id,
  );

  const roster = async () =>
    v1data<{ items: { id: string }[] }>(await v1(owner, "/api/v1/persons?limit=100")).items.map(
      (p) => p.id,
    );
  const afterIds = await roster();
  check(
    "#404: the merged-away record leaves the roster, the survivor stays",
    afterIds.includes(keep.id) && !afterIds.includes(dupe.id),
  );

  // --- THE REGRESSION: the ban survived, and now belongs to the survivor.
  const after = await suspensions();
  check(
    "#404: the merge preserves the suspension, repointed to the survivor",
    after.length === 1 &&
      after[0].personId === keep.id &&
      after[0].reason === REASON &&
      after[0].matchesTotal === 2,
  );

  // --- The merge is durable, not a toast the panel forgets on reload.
  type LogEntry = {
    merge_id: string;
    survivor_id: string;
    absorbed_id: string;
    reversed_at: string | null;
  };
  const log = v1data<{ items: LogEntry[] }>(await v1(owner, "/api/v1/persons/merges"));
  const entry = log.items.find((m) => m.merge_id === result.merge_id);
  check(
    "#404: the merge is in the org's durable merge log, not yet reversed",
    !!entry &&
      entry.survivor_id === keep.id &&
      entry.absorbed_id === dupe.id &&
      entry.reversed_at === null,
  );

  // --- Undo restores BOTH records and leaves the ban where it started.
  const undo = await v1(owner, `/api/v1/persons/merges/${result.merge_id}/reverse`, "POST", {
    confirmed: true,
  });
  const restoredIds = await roster();
  const restoredBans = await suspensions();
  check(
    "#404: reversing the merge puts both records back and returns the ban",
    undo.status === 200 &&
      restoredIds.includes(keep.id) &&
      restoredIds.includes(dupe.id) &&
      restoredBans.length === 1 &&
      restoredBans[0].personId === dupe.id,
  );

  const undoTwice = await v1(owner, `/api/v1/persons/merges/${result.merge_id}/reverse`, "POST", {
    confirmed: true,
  });
  check(
    "#404: a second reversal is refused 409 MERGE_ALREADY_REVERSED",
    undoTwice.status === 409 && undoTwice.json.error?.code === "MERGE_ALREADY_REVERSED",
  );
}
