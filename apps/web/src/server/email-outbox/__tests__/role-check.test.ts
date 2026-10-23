// The outbox writes email_outbox as the pooled, privileged role. The table is FORCE RLS with an INSERT policy only, so a
// role that is neither superuser nor BYPASSRLS does not get an error: its UPDATE simply matches zero rows. Every send would
// quietly come back `deferred` and nothing would ever leave. This check turns that silence into a loud, answerable
// question ("may this role write the outbox?"), asked once per process and exported for the Task 4 worker.
//
// Claims: the probe answers true for the pooled role and FALSE for app_user (the real tenant role, via `set local role`);
// the answer is remembered (one statement however many calls), a failed probe is not remembered, and concurrent first
// calls share one probe.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";
import { createRoleCheck, outboxRoleOk, probeOutboxRole, resetOutboxRoleCheck } from "../role-check";

const HAS_DB = !!process.env.DATABASE_URL;

describe("createRoleCheck (memoisation, no database)", () => {
  it("probes once and remembers the answer, true or false", async () => {
    for (const answer of [true, false]) {
      const probe = vi.fn(async () => answer);
      const check = createRoleCheck(probe);
      expect(await check.ok()).toBe(answer);
      expect(await check.ok()).toBe(answer);
      expect(await check.ok()).toBe(answer);
      expect(probe, String(answer)).toHaveBeenCalledTimes(1);
    }
  });

  it("two calls before the first answer share one probe", async () => {
    let release!: (v: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>((r) => { release = r; }));
    const check = createRoleCheck(probe);
    const a = check.ok();
    const b = check.ok();
    release(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a failed probe is not remembered: the caller sees the error and the next call asks again", async () => {
    const probe = vi.fn<() => Promise<boolean>>();
    probe.mockRejectedValueOnce(new Error("db down"));
    probe.mockResolvedValueOnce(true);
    const check = createRoleCheck(probe);
    await expect(check.ok()).rejects.toThrow("db down");
    expect(await check.ok()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("a probe that throws synchronously is handled the same way", async () => {
    const probe = vi.fn<() => Promise<boolean>>(() => { throw new Error("sync"); });
    const check = createRoleCheck(probe);
    await expect(check.ok()).rejects.toThrow("sync");
    probe.mockImplementation(async () => false);
    expect(await check.ok()).toBe(false);
  });

  it("reset forgets the answer", async () => {
    const probe = vi.fn(async () => true);
    const check = createRoleCheck(probe);
    await check.ok();
    check.reset();
    await check.ok();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!HAS_DB)("probeOutboxRole (DB)", () => {
  afterAll(async () => {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  it("is true for the pooled role (superuser or BYPASSRLS), and false for app_user", async () => {
    expect(await probeOutboxRole(sql)).toBe(true);
    const asTenant = await sql.begin(async (tx) => {
      await tx`set local role app_user`;
      const [who] = await tx<{ u: string }[]>`select current_user as u`;
      return { who: who!.u, ok: await probeOutboxRole(tx) };
    });
    // Anti-vacuity: the probe really ran as app_user, not as the pooled role.
    expect(asTenant.who).toBe("app_user");
    expect(asTenant.ok).toBe(false);
  });

  describe("each attribute on its own (roles made for the test)", () => {
    const tag = randomUUID().slice(0, 8);
    const roles = { superOnly: `t3_super_${tag}`, bypassOnly: `t3_bypass_${tag}`, plain: `t3_plain_${tag}`, both: `t3_both_${tag}` };

    beforeAll(async () => {
      await sql.unsafe(`create role ${roles.superOnly} superuser nobypassrls`);
      await sql.unsafe(`create role ${roles.bypassOnly} nosuperuser bypassrls`);
      await sql.unsafe(`create role ${roles.plain} nosuperuser nobypassrls`);
      await sql.unsafe(`create role ${roles.both} superuser bypassrls`);
    });
    afterAll(async () => {
      for (const r of Object.values(roles)) await sql.unsafe(`drop role if exists ${r}`);
    });

    it("superuser alone, BYPASSRLS alone and both can write; neither cannot", async () => {
      const answer = async (role: string): Promise<[string, boolean]> =>
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          const [who] = await tx<{ u: string }[]>`select current_user as u`;
          return [who!.u, await probeOutboxRole(tx)] as [string, boolean];
        }) as unknown as Promise<[string, boolean]>;
      const got = {
        superOnly: await answer(roles.superOnly),
        bypassOnly: await answer(roles.bypassOnly),
        both: await answer(roles.both),
        plain: await answer(roles.plain),
      };
      // Each probe ran as the role it names (anti-vacuity), and the answers are the attribute's, one at a time.
      expect(got.superOnly).toEqual([roles.superOnly, true]);
      expect(got.bypassOnly).toEqual([roles.bypassOnly, true]);
      expect(got.both).toEqual([roles.both, true]);
      expect(got.plain).toEqual([roles.plain, false]);
    });
  });

  it("agrees with the catalogue, not with a guess: app_user is neither superuser nor BYPASSRLS, the pooled role is one of them", async () => {
    const rows = await sql<{ rolname: string; priv: boolean }[]>`
      select rolname, (rolsuper or rolbypassrls) as priv from pg_roles where rolname in ('app_user', current_user)`;
    const priv = new Map(rows.map((r) => [r.rolname, r.priv]));
    expect(priv.get("app_user")).toBe(false);
    expect([...priv.values()].filter(Boolean).length).toBe(1);
  });

  it("the default check is remembered: after a reset the first call costs one statement and the second none", async () => {
    resetOutboxRoleCheck();
    const before = statementCount();
    expect(await outboxRoleOk()).toBe(true);
    const first = statementCount() - before;
    expect(await outboxRoleOk()).toBe(true);
    expect(statementCount() - before).toBe(first);
    expect(first).toBe(1);
  });
});
