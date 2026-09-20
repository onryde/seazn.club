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
import { FlyClient, SESSION_METADATA_KEY, exitInfoFrom } from "../fly-client";

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

const TOKEN = flyToken();
const ENABLED = !!TOKEN && process.env.RELAY_LIVE_FLY === "1";
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
  const tag = `live-${Date.now()}`;
  const alive: string[] = [];
  /** Every Machine id this run ever minted — the ledger the sweep confirms. */
  const created: string[] = [];

  afterAll(async () => {
    for (const id of alive) await client.destroyMachine(id).catch(() => undefined);
    // C1 sweep: list the app and destroy ANYTHING carrying this run's tag,
    // then confirm every id the run minted is gone by re-reading it.
    const mine = (await client.listMachines().catch(() => []))
      .filter((m) => m.name.startsWith(`relay-${tag}`) || (m.config?.metadata?.[SESSION_METADATA_KEY] ?? "").startsWith(tag));
    for (const m of mine) await client.destroyMachine(m.id, { force: true }).catch(() => undefined);
    const residue: string[] = [];
    for (const id of new Set([...created, ...mine.map((m) => m.id)])) {
      const after = await client.getMachine(id).catch(() => ({ state: "unreadable" }));
      if (after && after.state !== "destroyed" && after.state !== "destroying") residue.push(`${id}=${after.state}`);
    }
    note(residue.length === 0 ? `sweep: all ${created.length} tagged Machine(s) confirmed gone` : `LEAK — NOT confirmed destroyed: ${residue.join(", ")}`);
    console.log("LIVE  summary\n  " + seen.join("\n  "));
  });

  const create = (session: string, attempt: number, cmd: string[]) => client.createMachine({
    name: `relay-${session}-r${attempt}`, region,
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
    const again = await client.createMachine({ name: `relay-${session}-r1`, region, config: { image, guest, auto_destroy: true, restart: { policy: "no" }, env: {}, metadata: { seazn_session: session } } }).catch((e: unknown) => e);
    note(`second create, same name+session → ${again instanceof Error ? `error: ${again.message}` : `id ${(again as { id: string }).id}`}`);
    if (!(again instanceof Error)) { created.push((again as { id: string }).id); expect((again as { id: string }).id).toBe(m.id); }
    await client.stopMachine(m.id, { signal: "SIGINT", timeoutSeconds: 10 });
    const stopped = await client.waitMachine(m.id, "stopped", 30).catch((e: unknown) => e);
    note(`wait stopped → ${stopped instanceof Error ? stopped.message : JSON.stringify(stopped)}`);
    const events = await client.machineEvents(m.id).catch(() => []);
    note(`events → ${JSON.stringify(events.map((e) => ({ type: e.type, status: e.status, exit: e.request?.exit_event ?? null })))}`);
    const exit = exitInfoFrom(events);
    note(`exitInfoFrom → ${JSON.stringify(exit)}`);
    const gone = await client.waitMachine(m.id, "destroyed", 60).catch((e: unknown) => e);
    note(`auto_destroy after exit 0 → ${gone instanceof Error ? gone.message : JSON.stringify(gone)}`);
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
    const reuse = await client.createMachine({ name: `relay-${session}-r1`, region, config: { image, guest, auto_destroy: true, restart: { policy: "no" }, env: {}, metadata: { seazn_session: `${session}-reuse` } } }).catch((e: unknown) => e);
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
    const events = await client.machineEvents(m.id).catch(() => []);
    note(`exit-1 events → ${JSON.stringify(events.map((e) => ({ type: e.type, exit: e.request?.exit_event ?? null })))}`);
    note(`exit-1 exitInfoFrom → ${JSON.stringify(exitInfoFrom(events))}`);
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
    alive.splice(alive.indexOf(m.id), 1);
    const left = (await client.listMachines()).filter((x) => x.name.startsWith(`relay-${tag}`));
    expect(left).toEqual([]);
  }, 240_000);
});
