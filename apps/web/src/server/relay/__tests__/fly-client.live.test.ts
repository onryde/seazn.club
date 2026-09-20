// LIVE, opt-in: walks the REAL Fly machine lifecycle (plan §"Fly machine
// lifecycle") in the org's relay app, region lhr, on the smallest guest that
// proves it. Runs only with FLY_API_TOKEN and RELAY_LIVE_FLY=1; skips LOUDLY
// otherwise — the token is never echoed, logged or committed.
// What it settles that the docs do not: the states Fly actually reports, the
// exit event's real shape (exit_code / oom_killed / requested_stop), that
// auto_destroy removes a Machine after exit 0 AND after exit 1, the
// request-id header's real name, the 429/Retry-After behaviour if it appears,
// and whether a destroyed Machine's name is reusable. Costs a minute of a
// shared-cpu-1x.
//
// EVERY Machine it creates is destroyed in the same run and CONFIRMED gone by a
// re-read, and `afterAll` sweeps the whole app by this run's tag — a test that
// times out never runs a `finally`, so the sweep cannot live in one.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FlyApiError, FlyClient, SESSION_METADATA_KEY, exitInfoFrom } from "../fly-client";
// Lane-A minors, Task 5A review m9: the Machine name was spelled `relay-${session}-r${attempt}`
// here as well as in `domain/runner.ts`, and a second spelling of an idempotency key is a
// second key — this file's whole point is that a 409 on the SAME name is what makes a create
// idempotent. A test file may import the domain; one authority per fact.
import { machineNameFor } from "../domain/runner";

/** The token from the environment, or from `apps/web/.env.local`, which is
 *  where it lands. Reading it HERE is what lets the run command below stay free
 *  of shell substitution (the plan's shell guard forbids `$(...)`), and it
 *  never reaches a transcript: it is not echoed, logged or asserted on. */
function flyToken(): string | undefined {
  if (process.env.FLY_API_TOKEN) return process.env.FLY_API_TOKEN;
  try {
    const line = readFileSync(resolve(import.meta.dirname, "../../../../.env.local"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("FLY_API_TOKEN="));
    return line?.slice("FLY_API_TOKEN=".length).trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;   // no .env.local in this checkout — the test skips
  }
}

// Lane-A minors, Task 5A review m8: the flag is read FIRST and the token only
// behind it. `flyToken()` used to run at module scope on every run of this file —
// including the ~40 ordinary unit runs a day that never set RELAY_LIVE_FLY — pulling
// a live Fly credential off disk into the worker's heap for no reason. The suite's
// standing convention for an outbound credential is two gates (vitest.config.ts
// deletes POSTHOG / RESEND / ANTHROPIC, and STRIPE except under BILLING_LIVE=1);
// this leg had one. `FLY_API_TOKEN` is not added to that delete list, deliberately:
// the delete list drops a value `.env.local` supplied, and `flyToken()` reads that
// FILE directly, so the list could not stop it anyway. The two live legs (this one
// and runner-fly.live.test.ts) are the token's only readers, and BOTH now read
// nothing unless asked to — the sibling carries the same gate for the same reason.
const WANTS_LIVE = process.env.RELAY_LIVE_FLY === "1";
const TOKEN = WANTS_LIVE ? flyToken() : undefined;
const ENABLED = !!TOKEN && WANTS_LIVE;
if (!ENABLED) console.log("SKIP  fly-client live lifecycle test (needs FLY_API_TOKEN in apps/web/.env.local or the environment and RELAY_LIVE_FLY=1; the app FLY_RELAY_APP in org seazn-club must exist)");

const image = "registry-1.docker.io/library/alpine:3.20";
const region = process.env.FLY_RELAY_REGION ?? "lhr";
const guest = { cpus: 1, memory_mb: 256, cpu_kind: "shared" as const };
const seen: string[] = [];
const note = (s: string) => { seen.push(s); console.log("LIVE  " + s); };

describe.skipIf(!ENABLED)("FlyClient — live lifecycle (org seazn-club, lhr)", () => {
  const app = process.env.FLY_RELAY_APP ?? "seazn-relay";
  // `waitMachine` is a LONG POLL: its per-request budget has to exceed the
  // `timeout` seconds it asks Fly to hold the connection for, or the client's
  // own AbortSignal fires first and the wait reads as a timeout. The live leg
  // sizes it here; Task 5's adapter owes the same arithmetic.
  const client = new FlyClient({ token: TOKEN!, app, requestTimeoutMs: 120_000, deadlineMs: 300_000, maxAttempts: 3 });
  /** The sweep gets its OWN short budget (review I1): with the 120 s / 3-attempt
   *  client above, ONE hung destroy can outlast the hook and leave the rest of the
   *  ledger unvisited — the sweep would red, but the Machines it never reached
   *  would still be running. */
  const sweeper = new FlyClient({ token: TOKEN!, app, requestTimeoutMs: 20_000, deadlineMs: 45_000, maxAttempts: 2 });
  const tag = `live-${Date.now()}`;
  const alive: string[] = [];
  /** Every Machine id this run ever minted — the ledger the sweep confirms. */
  const created: string[] = [];

  afterAll(async () => {
    for (const id of alive) await sweeper.destroyMachine(id).catch(() => undefined);
    // C1 sweep: list the app and destroy ANYTHING carrying this run's tag,
    // then confirm every id the run minted is gone by re-reading it.
    const mine = (await sweeper.listMachines().catch(() => []))
      .filter((m) => m.name.startsWith(`relay-${tag}`) || (m.config?.metadata?.[SESSION_METADATA_KEY] ?? "").startsWith(tag));
    for (const m of mine) await sweeper.destroyMachine(m.id, { force: true }).catch(() => undefined);
    const residue: string[] = [];
    for (const id of new Set([...created, ...mine.map((m) => m.id)])) {
      // A 404 (null) is NOT a confirmation: this id was created by this run, so
      // "never existed" is an anomaly, not proof it is gone.
      const after = await sweeper.getMachine(id).catch(() => ({ state: "unreadable" }));
      const state = after?.state ?? "absent-404";
      if (state !== "destroyed" && state !== "destroying") residue.push(`${id}=${state}`);
    }
    note(residue.length === 0 ? `sweep: all ${created.length} tagged Machine(s) confirmed gone` : `LEAK — NOT confirmed destroyed: ${residue.join(", ")}`);
    console.log("LIVE  summary\n  " + seen.join("\n  "));
    // review I1: the residue was PRINTED and never asserted, so a leak exited 0 and
    // read "3 passed". Carry C1's confirmation is now the gate's, not a human's.
    expect(residue).toEqual([]);
  }, 300_000);

  const create = (session: string, attempt: number, cmd: string[]) => client.createMachine({
    name: machineNameFor(session, attempt), region,
    config: { image, guest, auto_destroy: true, restart: { policy: "no" }, env: { RELAY_LIVE_TEST: "1" }, metadata: { seazn_session: session }, ...({ init: { cmd } } as object) },
  });

  it("1. create → started → SIGINT stop → exit 0 → auto-destroyed observed; metadata list round-trips; the second create for the same session is not a second Machine", async () => {
    const session = `${tag}-a`;
    const t0 = Date.now();
    const m = await create(session, 1, ["sh", "-c", "trap 'exit 0' INT; sleep 3600 & wait"]);
    alive.push(m.id); created.push(m.id);
    note(`create → state=${m.state} name=${m.name} id=${m.id} in ${Date.now() - t0} ms`);
    expect((await client.listMachines({ metadata: { seazn_session: session } })).map((x) => x.id)).toEqual([m.id]);
    const started = await client.waitMachine(m.id, "started", 60);
    note(`wait started → ${JSON.stringify(started)} (create→started ${Date.now() - t0} ms)`);
    const again = await client.createMachine({ name: machineNameFor(session, 1), region, config: { image, guest, auto_destroy: true, restart: { policy: "no" }, env: {}, metadata: { seazn_session: session } } }).catch((e: unknown) => e);
    note(`second create, same name+session → ${again instanceof Error ? `error: ${again.message}` : `id ${(again as { id: string }).id}`}`);
    if (!(again instanceof Error)) { created.push((again as { id: string }).id); }
    // review I2: this was guarded by `if (!(again instanceof Error))`, and the measured answer
    // is an ERROR — so the test asserted nothing on the path it actually took. The 409 is the
    // fact the whole T5-b safety argument rests on: an error where Fly DOES hold the Machine,
    // which must never reach the domain as retryable, and whose body names the existing id.
    expect(again).toBeInstanceOf(FlyApiError);
    expect(again).toMatchObject({ status: 409, retryable: false });
    expect((again as FlyApiError).message).toContain(m.id);
    expect((again as FlyApiError).message).toContain("already_exists");
    await client.stopMachine(m.id, { signal: "SIGINT", timeoutSeconds: 10 });
    const stopped = await client.waitMachine(m.id, "stopped", 30).catch((e: unknown) => e);
    note(`wait stopped → ${stopped instanceof Error ? stopped.message : JSON.stringify(stopped)}`);
    const events = await client.machineEvents(m.id).catch(() => []);
    note(`events → ${JSON.stringify(events.map((e) => ({ type: e.type, status: e.status, exit: e.request?.exit_event ?? null })))}`);
    const exit = exitInfoFrom(events);
    note(`exitInfoFrom → ${JSON.stringify(exit)}`);
    // review I2: noted, never asserted. A SIGINT the guest trapped exits 0 ON PURPOSE.
    expect(exit).toEqual({ exitCode: 0, oomKilled: false, requestedStop: true });
    const gone = await client.waitMachine(m.id, "destroyed", 60).catch((e: unknown) => e);
    note(`auto_destroy after exit 0 → ${gone instanceof Error ? gone.message : JSON.stringify(gone)}`);
    expect(gone).not.toBeInstanceOf(Error);
    expect(gone).toMatchObject({ state: "destroyed" });
    // MEASURED 2026-09-20: a destroyed Machine is still GET-able — 200 with
    // state "destroyed". 404 is only for an id that never existed.
    const afterDestroy = (await client.getMachine(m.id))?.state;
    note(`GET after destroy → ${JSON.stringify(afterDestroy ?? null)}`);
    // RACE, measured 2026-09-20: a wait on state=destroyed answering {ok:true}
    // does NOT mean the very next GET says "destroyed" — it read "destroying"
    // on one run and "destroyed" on another. Task 5 owes the same tolerance.
    expect(["destroyed", "destroying"]).toContain(afterDestroy);
    alive.splice(alive.indexOf(m.id), 1);
    // name reuse after destroy: record, do not assert
    const reuse = await client.createMachine({ name: machineNameFor(session, 1), region, config: { image, guest, auto_destroy: true, restart: { policy: "no" }, env: {}, metadata: { seazn_session: `${session}-reuse` } } }).catch((e: unknown) => e);
    note(`name reuse after destroy → ${reuse instanceof Error ? `refused: ${reuse.message}` : "allowed"}`);
    if (!(reuse instanceof Error)) { created.push((reuse as { id: string }).id); await client.destroyMachine((reuse as { id: string }).id); }
  }, 300_000);

  it("2. a Machine that exits 1 is auto-destroyed too, and its exit event says so", async () => {
    const session = `${tag}-b`;
    const m = await create(session, 1, ["sh", "-c", "sleep 5; exit 1"]);
    alive.push(m.id); created.push(m.id);
    // 90 is REFUSED: Fly caps the wait timeout at 60 s (HTTP 400 invalid_argument,
    // "value must be inside range [1s, 1m0s]" — measured 2026-09-20).
    const gone = await client.waitMachine(m.id, "destroyed", 60).catch((e: unknown) => e);
    note(`auto_destroy after exit 1 → ${gone instanceof Error ? gone.message : JSON.stringify(gone)}`);
    expect(gone).not.toBeInstanceOf(Error);
    expect(gone).toMatchObject({ state: "destroyed" });
    const events = await client.machineEvents(m.id).catch(() => []);
    note(`exit-1 events → ${JSON.stringify(events.map((e) => ({ type: e.type, exit: e.request?.exit_event ?? null })))}`);
    note(`exit-1 exitInfoFrom → ${JSON.stringify(exitInfoFrom(events))}`);
    // review I2: the test's own title says "and its exit event says so" — now it does.
    expect(exitInfoFrom(events)).toEqual({ exitCode: 1, oomKilled: false, requestedStop: false });
    expect(["destroyed", "destroying"]).toContain((await client.getMachine(m.id))?.state);
    alive.splice(alive.indexOf(m.id), 1);
  }, 240_000);

  it("3. force destroy of a RUNNING Machine; destroy again is idempotent; the app lists none of ours", async () => {
    const session = `${tag}-c`;
    const m = await create(session, 1, ["sleep", "3600"]);
    alive.push(m.id); created.push(m.id);
    await client.waitMachine(m.id, "started", 60);
    await client.destroyMachine(m.id, { force: true });
    await client.destroyMachine(m.id, { force: true });
    const gone = await client.waitMachine(m.id, "destroyed", 60).catch((e: unknown) => e);
    note(`force destroy running → ${gone instanceof Error ? gone.message : JSON.stringify(gone)}`);
    expect(gone).not.toBeInstanceOf(Error);
    expect(gone).toMatchObject({ state: "destroyed" });
    alive.splice(alive.indexOf(m.id), 1);
    const left = (await client.listMachines()).filter((x) => x.name.startsWith(`relay-${tag}`));
    expect(left).toEqual([]);
  }, 240_000);

  it("4. I6: a create whose response is lost is VISIBLE in the metadata list with no settle — the consistency premise the T5-b lookup rests on", async () => {
    // review I6: the ambiguity lookup is one list issued immediately after a failed POST. If Fly
    // accepts the create but has not yet materialised it in the list, that empty answer becomes
    // `retryable: true` and the domain reads it as proof Fly holds nothing. Measure it: abort the
    // POST client-side AFTER the request is on the wire (live creates take 1.1-2.5 s, so 600 ms
    // lands mid-flight), then look immediately and again after a settle.
    const session = `${tag}-d`;
    const name = machineNameFor(session, 1);
    const hairTrigger = new FlyClient({ token: TOKEN!, app, requestTimeoutMs: 600, maxAttempts: 1, deadlineMs: 5_000, lookupSettleMs: 1 });
    const outcome = await hairTrigger.createMachine({
      name, region,
      config: { image, guest, auto_destroy: true, restart: { policy: "no" }, env: {}, metadata: { seazn_session: session }, ...({ init: { cmd: ["sleep", "3600"] } } as object) },
    }).catch((e: unknown) => e);
    note(`aborted-POST create → ${outcome instanceof Error ? `${(outcome as FlyApiError).code}/retryable=${(outcome as FlyApiError).retryable}: ${outcome.message.slice(0, 120)}` : `adopted id ${(outcome as { id: string }).id}`}`);
    const t0 = Date.now();
    const now = (await client.listMachines({ metadata: { seazn_session: session } })).map((x) => x.name);
    note(`list immediately after the aborted POST (+${Date.now() - t0} ms) → ${JSON.stringify(now)}`);
    await new Promise((r) => setTimeout(r, 4000));
    const later = (await client.listMachines({ metadata: { seazn_session: session } })).map((x) => x.name);
    note(`list again after 4 s → ${JSON.stringify(later)}`);
    for (const mm of await client.listMachines({ metadata: { seazn_session: session } })) {
      created.push(mm.id);
      await client.destroyMachine(mm.id, { force: true });
    }
    // The premise, stated so it cannot pass vacuously in the wrong direction: if the Machine
    // EVER appears, it must have appeared on the immediate look. A later-but-not-sooner answer is
    // exactly the race, and would mean the settle-and-confirm is load-bearing rather than belt.
    expect(later.length === 0 || now.length > 0).toBe(true);
    note(later.length === 0 ? "I6: Fly created nothing from the aborted POST — premise untested this run" : "I6: list-after-lost-POST was immediately consistent");
  }, 180_000);
});
