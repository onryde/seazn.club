// stream-target-holders.ts is the ONE answer to "which session holds this destination" (spec §5.3, §5.5): the
// Directory list's `inUse`, Go live's refusal and Replace key / Remove's refusal all read it. Held = an ACTIVE session
// references the target, in this org. Every expected state comes from the domain's own ACTIVE_STATES / TERMINAL_STATES
// and holdStateOf; every href from routes.fixture over the fixture's own slugs, read from the DB.
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): holding a destination reads sessions, targets and the fixture's
// number and slugs; nothing here depends on the fixture's sport.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import { ACTIVE_STATES, TERMINAL_STATES, holdStateOf } from "@/server/relay/domain/session";
import { holdRig, sessionOnTarget } from "@/server/relay/__tests__/_session-rig";
import { holderRows, toTargetHolder } from "../stream-target-holders";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("holderRows — who holds a destination, named for a person", () => {
  it("each ACTIVE state is a holder with its hold state, fixture number and organiser href; each TERMINAL state is not", async () => {
    let checked = 0;
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES]) {
      const r = await holdRig();
      const targetId = r.targetId;
      const sid = await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, state);
      const got = await holderRows(sql, { orgId: r.auth.orgId, targetId });
      if (holdStateOf(state) === null) {
        expect(got, state).toEqual([]);
      } else {
        const [fx] = await sql<{ fixture_no: number; org: string; comp: string; div: string }[]>`
          select f.fixture_no, o.slug as org, c.slug as comp, d.slug as div from fixtures f
            join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
            join organizations o on o.id = c.org_id where f.id = ${r.fixtureId}`;
        expect(got, state).toEqual([expect.objectContaining({
          sessionId: sid, targetId, fixtureId: r.fixtureId, matchNo: fx!.fixture_no, state: holdStateOf(state),
          href: routes.fixture(fx!.org, fx!.comp, fx!.div, fx!.fixture_no),
        })]);
      }
      checked++;
    }
    expect(checked).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
  });

  it("a holder whose fixture was DELETED still holds, with fixtureId, href and matchNo null", async () => {
    const r = await holdRig();
    const targetId = r.targetId;
    await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, "live");
    await sql`update fixture_stream_sessions set fixture_id = null where target_id = ${targetId}`;
    const [h] = await holderRows(sql, { orgId: r.auth.orgId, targetId });
    expect(h).toMatchObject({ fixtureId: null, href: null, matchNo: null, courtName: null, state: "live" });
  });

  it("notFixtureId excludes THIS fixture's own session and nothing else; another org's session is never a holder", async () => {
    const r = await holdRig();
    const other = await holdRig();
    const targetId = r.targetId;
    await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, "warming");
    expect(await holderRows(sql, { orgId: r.auth.orgId, targetId, notFixtureId: r.fixtureId })).toEqual([]);
    expect(await holderRows(sql, { orgId: r.auth.orgId, targetId })).toHaveLength(1);
    expect(await holderRows(sql, { orgId: other.auth.orgId, targetId })).toEqual([]);
  });

  it("toTargetHolder refuses a TERMINAL row — 'a holder is active' is a guard, not a comment", () => {
    expect(() => toTargetHolder({
      session_id: "s", target_id: "t", state: "completed", fixture_id: null, fixture_no: null,
      court_name: null, label: "L", org_slug: null, comp_slug: null, div_slug: null,
    })).toThrow(/terminal/);
  });
});
