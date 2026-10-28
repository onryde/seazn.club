// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, raw, check, tag, ledger, timedFixture, smokeDb, v1, v1data } from "../harness.ts";

// ---------------------------------------------------------------------------
// W4a follow-up (V347) — a config edit must not reach back into a scored
// fixture, over real HTTP.
//
// The adapter suites prove the column and the fold. This proves the rail: that
// `/api/v1/.../events` really freezes the resolved cfg on the first append,
// that a division-config edit afterwards can neither lock the scorer out of a
// match already in progress nor rewrite the result they published, and that
// /admin's escape hatch exists and refuses what it should.
//
// Assertions are paired so they cannot pass by doing nothing: the snapshot is
// read BEFORE and AFTER the edit, and the "still finalizable" check is paired
// with the outcome it finalized, because a 201 on core.finalize is equally true
// of a fixture whose result was silently rewritten on the way through.
// ---------------------------------------------------------------------------

/** The config a generic division starts on — `allowDraws` is an ungated
 *  cfg-derived refusal inside the module's apply(), which makes it the sharpest
 *  reproduction of the class this task closes. */
const SNAPSHOT_CFG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

export async function configSnapshotSuite(admin: Session, adminEmail: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // The whole point is what happens when the config moves BEHIND the app's
    // back, which needs SQL. Announced rather than silently skipped — a suite
    // that vanishes without saying so is how a gate stops testing anything.
    console.log("SKIP  V347 config snapshot suite (DATABASE_URL not set)");
    return;
  }
  const db = smokeDb();
  try {
    const comp = v1data<{ id: string }>(
      await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `Cfg Snapshot ${tag}`,
        visibility: "private",
      }),
    );
    const fx = await timedFixture(admin, comp.id, {
      name: "Snapshot",
      sport_key: "generic",
      variant_key: "score",
      config: SNAPSHOT_CFG,
      entrants: [
        { kind: "individual", display_name: `Asha ${tag}`, seed: 1 },
        { kind: "individual", display_name: `Bala ${tag}`, seed: 2 },
      ],
    });
    const led = ledger(admin, fx.fixtureId);

    const snapshotOf = async (): Promise<Record<string, unknown> | null> => {
      const [row] = await db<{ config_snapshot: Record<string, unknown> | null }[]>`
        select config_snapshot from fixtures where id = ${fx.fixtureId}`;
      return row?.config_snapshot ?? null;
    };

    // (1) Nothing frozen before there is history worth protecting — an
    //     organiser still setting the division up must have their edits apply.
    check("V347 an unscored fixture carries no config snapshot", (await snapshotOf()) === null);

    await led.send("core.start", {});
    const frozen = await snapshotOf();
    check(
      "V347 the first event freezes the resolved cfg onto the fixture",
      frozen !== null && frozen.allowDraws === true && frozen.resultMode === "score",
    );

    const scored = await led.send("generic.result", { p1Score: 1, p2Score: 1 });
    const drawn = v1data<{ outcome: { kind?: string } | null }>(
      await v1(admin, `/api/v1/fixtures/${fx.fixtureId}/state`),
    );
    check(
      "V347 a 1-1 card decides as a draw under the config in force",
      scored.status === 201 && drawn.outcome?.kind === "draw",
    );

    // (2) The organiser bans draws, after the match was played. Every append
    //     re-folds the WHOLE stream, so before V347 this made every further
    //     write fail — core.void included, so there was no undo that recovered
    //     it, and the fixture could never be finalized.
    await db`update divisions set config = ${db.json({ ...SNAPSHOT_CFG, allowDraws: false })}
             where id = ${fx.divisionId}`;
    check(
      "V347 the frozen copy does not follow the division config",
      (await snapshotOf())?.allowDraws === true,
    );

    const finalize = await led.send("core.finalize", {});
    const after = v1data<{ outcome: { kind?: string } | null; status: string }>(
      await v1(admin, `/api/v1/fixtures/${fx.fixtureId}/state`),
    );
    check(
      "V347 a banned-draws edit neither locks the scorer out nor rewrites the result",
      finalize.status === 201 && after.status === "finalized" && after.outcome?.kind === "draw",
    );

    // (3) The escape hatch. Staff-only, and refused on a FINALIZED fixture —
    //     rewriting the config a finalized result was computed under is exactly
    //     the harm the snapshot exists to prevent.
    const [me] = await db<{ id: string; is_staff: boolean; staff_role: string | null }[]>`
      select id, is_staff, staff_role from users where email = ${adminEmail}`;
    const hatch = `/api/admin/fixtures/${fx.fixtureId}/config-snapshot`;
    const asOutsider = await raw(admin, hatch, "POST", { reason: "not staff" });
    // The EXACT code, not `>= 400`: that also swallows a 500, so a route that
    // crashed on every call would read as "properly guarded". AuthError → 401
    // through the shared handler.
    check("V347 the re-snapshot hatch refuses a non-staff caller", asOutsider.status === 401);

    // SUPERADMIN, not merely staff. The discarded config survives only in the
    // audit row this writes; a support-role operator passes `requireStaff` and
    // must still be refused, so this is the one caller whose verdict differs
    // between the two guards.
    await db`update users set is_staff = true, staff_role = 'support' where id = ${me.id}`;
    const asSupport = await raw(admin, hatch, "POST", { reason: "support is not superadmin" });
    check("V347 the re-snapshot hatch refuses a support-role staff user", asSupport.status === 401);

    await db`update users set is_staff = true, staff_role = 'superadmin' where id = ${me.id}`;
    try {
      const onFinalized = await raw(admin, hatch, "POST", { reason: "smoke: should refuse" });
      check(
        "V347 the hatch refuses a finalized fixture (reopen it first)",
        onFinalized.status === 409,
      );
      check(
        "V347 a refused re-snapshot leaves the frozen config alone",
        (await snapshotOf())?.allowDraws === true,
      );

      // Reopen, correct the division to something the recorded draw can still
      // be read under, and re-snapshot for real.
      await db`update fixtures set status = 'decided' where id = ${fx.fixtureId}`;
      await db`update divisions set config = ${db.json({
        ...SNAPSHOT_CFG,
        points: { w: 2, d: 1, l: 0 },
      })} where id = ${fx.divisionId}`;
      const done = await raw(admin, hatch, "POST", { reason: "smoke: points table was wrong" });
      const reFrozen = await snapshotOf();
      check(
        "V347 a reopened fixture re-snapshots from live config",
        done.status === 200 &&
          (reFrozen?.points as { w?: number } | undefined)?.w === 2 &&
          reFrozen?.allowDraws === true,
      );

      const [audit] = await db<{ action: string; detail: Record<string, unknown> }[]>`
        select action, detail from staff_audit_log
        where target_id = ${fx.fixtureId} order by created_at desc limit 1`;
      check(
        "V347 the re-snapshot is audited with its reason and the discarded config",
        audit?.action === "fixture_config_resnapshot" &&
          audit.detail.reason === "smoke: points table was wrong" &&
          (audit.detail.before as { points?: { w?: number } } | undefined)?.points?.w === 3,
      );

      // A hatch that leaves the fixture unreadable is not a hatch: the preflight
      // folds the recorded stream under live config inside the tx and rolls the
      // whole thing back when it cannot.
      await db`update divisions set config = ${db.json({ ...SNAPSHOT_CFG, allowDraws: false })}
               where id = ${fx.divisionId}`;
      const impossible = await raw(admin, hatch, "POST", { reason: "smoke: would brick it" });
      check(
        "V347 the hatch refuses a config that cannot read the recorded events",
        impossible.status === 409,
      );
      check(
        "V347 that refusal rolled the snapshot back too",
        (await snapshotOf())?.allowDraws === true,
      );
    } finally {
      // Shared-DB poison trap: the smoke owner outlives this suite.
      await db`update users set is_staff = ${me.is_staff}, staff_role = ${me.staff_role}
               where id = ${me.id}`;
    }
  } finally {
    await db.end();
  }
}
