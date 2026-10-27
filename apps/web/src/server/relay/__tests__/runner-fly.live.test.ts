// LIVE, opt-in: drives `FlyRunner` itself — the ADAPTER, not the client —
// against the real Machines API, for the one composition no fixture can prove.
// Runs only with FLY_API_TOKEN, RELAY_LIVE_FLY=1 and FLY_RELAY_APP (REQUIRED, no default — PR #971 review I1; the
// retired shared `seazn-relay` throws, `_live-fly-gate.ts`); skips LOUDLY otherwise.
// The token is never echoed, logged or asserted on.
//
// What it settles that runner-fly.test.ts cannot: that a real `409
// already_exists` out of a real duplicate create is ADOPTED by `FlyRunner.create`
// and comes back as the SAME runnerId (carry T5-c, the wave's money path —
// reporting a create failure there strands a running compositor and the domain
// then creates a second one). Task 5A measured the 409 BODY; nothing has ever
// driven the adopt that reads it. A fixture on both ends proves the fixture.
//
// Guest is the smallest that proves it (shared-cpu-1x / 256 MB), NOT the ruled
// performance-6x: the spec's guest is caller-supplied, and this leg is about the
// 409 path, not about the size. The image is a long-running one on purpose — an
// image that exits immediately would auto_destroy and free the name before the
// second create could collide with it.
//
// EVERY Machine it creates is destroyed in the same run and CONFIRMED gone by a
// re-read (C1: a destroyed Machine still GETs 200 `destroyed`; a 404 is NOT a
// confirmation for an id this run minted). `afterAll` sweeps the app by this
// run's tag and ASSERTS the residue — a test that times out never runs a
// `finally`, and a printed leak exits 0.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FlyClient, SESSION_METADATA_KEY } from "../fly-client";
import { FlyRunner } from "../runner-fly";
import { RUNNER_STOP_GRACE_SECONDS } from "../config";
import { CRASHES_NONE, machineNameFor, stepRunner } from "../domain/runner";
import type { ProviderCallRecord, RunnerSpec } from "../ports";
import { liveFlyGate } from "./_live-fly-gate";

/** The token from the environment, or from `apps/web/.env.local`, which is where
 *  it lands — so the run command needs no shell substitution. */
function flyToken(): string | undefined {
  if (process.env.FLY_API_TOKEN) return process.env.FLY_API_TOKEN;
  try {
    const line = readFileSync(resolve(import.meta.dirname, "../../../../.env.local"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("FLY_API_TOKEN="));
    return line?.slice("FLY_API_TOKEN=".length).trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

// Lane-A minors, Task 5A review m8, applied to THIS leg too: the flag is read
// first and the token only behind it. `flyToken()` ran at module scope on every
// ordinary unit run of this file, pulling a live Fly credential off disk into the
// worker's heap for no reason — the exact shape m8 named in fly-client.live.test.ts.
// Fixing one sibling and leaving the other is half a fix.
// PR #971 review I1: and the app is named explicitly, never defaulted, never the retired one (the sibling's gate).
const GATE = liveFlyGate(process.env, flyToken);
const TOKEN = GATE.enabled ? GATE.token : undefined;
const ENABLED = GATE.enabled;
if (!GATE.enabled) console.log(`SKIP  runner-fly live adopt test — ${GATE.reason} (needs RELAY_LIVE_FLY=1, FLY_RELAY_APP naming an app in org seazn-club, and FLY_API_TOKEN in the environment or apps/web/.env.local)`);

const seen: string[] = [];
const note = (s: string) => {
  seen.push(s);
  console.log("LIVE  " + s);
};

describe.skipIf(!ENABLED)("FlyRunner — live 409 adopt (org seazn-club, lhr)", () => {
  const app = GATE.enabled ? GATE.app : "(live leg disabled)";   // read by nothing while skipped
  const region = process.env.FLY_RELAY_REGION ?? "lhr";
  const image = "registry-1.docker.io/library/nginx:1.27-alpine";
  // A create can take tens of seconds on a cold image pull, so this leg's client
  // gets a budget of its own rather than the shipped defaults.
  /** Every provider row this leg's client writes, in order. The client records one
   *  row per ATTEMPT with the status Fly actually answered, which is the only place
   *  a live test can read the 409 itself — `FlyRunner.create` swallows the refusal
   *  by design (lane-A minors, Task 5 review M4). */
  const rec: { calls: ProviderCallRecord[] } = { calls: [] };
  const client = new FlyClient({
    token: TOKEN!, app, requestTimeoutMs: 120_000, deadlineMs: 300_000, maxAttempts: 2,
    recorder: { record(c) { rec.calls.push(c); } },
  });
  /** The sweep gets its OWN short budget: with the client above, one hung destroy
   *  can outlast the hook and leave the rest of the ledger unvisited. */
  const sweeper = new FlyClient({ token: TOKEN!, app, requestTimeoutMs: 20_000, deadlineMs: 45_000, maxAttempts: 2 });
  const runner = new FlyRunner({ client, image });
  const tag = `live-t5-${Date.now()}`;
  /** Every Machine id this run ever minted — the ledger the sweep confirms. */
  const created: string[] = [];

  afterAll(async () => {
    for (const id of created) await sweeper.destroyMachine(id, { force: true }).catch(() => undefined);
    const mine = (await sweeper.listMachines().catch(() => [])).filter(
      (m) => m.name.startsWith(`relay-${tag}`) || (m.config?.metadata?.[SESSION_METADATA_KEY] ?? "").startsWith(tag),
    );
    for (const m of mine) await sweeper.destroyMachine(m.id, { force: true }).catch(() => undefined);
    const residue: string[] = [];
    for (const id of new Set([...created, ...mine.map((m) => m.id)])) {
      const after = await sweeper.getMachine(id).catch(() => ({ state: "unreadable" }));
      const state = after?.state ?? "absent-404";
      if (state !== "destroyed" && state !== "destroying") residue.push(`${id}=${state}`);
    }
    note(residue.length === 0 ? `sweep: all ${created.length} tagged Machine(s) confirmed gone` : `LEAK — NOT confirmed destroyed: ${residue.join(", ")}`);
    console.log("LIVE  summary\n  " + seen.join("\n  "));
    expect(residue).toEqual([]);
  }, 300_000);

  it("a real duplicate create 409s, and FlyRunner ADOPTS the Machine the refusal names — same runnerId, no second Machine", async () => {
    const session = `${tag}-a`;
    const spec: RunnerSpec = {
      sessionId: session, attempt: 1, environment: "live-test", jobToken: "live-not-a-real-token", appUrl: "https://seazn.club",
      guest: { cpus: 1, memoryMb: 256, cpuClass: "shared" }, region,
      deadlineAt: new Date(Date.now() + 10 * 60_000),
    };
    const t0 = Date.now();
    const first = await runner.create(spec);
    created.push(first.runnerId);
    note(`create 1 → runnerId=${first.runnerId} in ${Date.now() - t0} ms`);

    // The SAME spec again. Fly refuses the duplicate name with 409 already_exists,
    // which never reaches the client's ambiguity lookup — the adapter is the only
    // thing that can turn it into anything but a failure.
    const t1 = Date.now();
    // Lane-A minors, Task 5 review M4: the title says "a real duplicate create 409s"
    // and nothing asserted a 409 ever happened — the test could not tell "409 →
    // adopted" from "Fly returned 200 with the same Machine", which is the whole
    // premise the adopt is built on. The client records one row per attempt, so the
    // refusal's own STATUS is readable here.
    const before = rec.calls.length;
    const second = await runner.create(spec);
    note(`create 2 (same session+attempt) → runnerId=${second.runnerId} in ${Date.now() - t1} ms`);
    expect(second.runnerId).toBe(first.runnerId);
    const statuses = rec.calls.slice(before).map((c) => c.status);
    note(`create 2 recorded statuses → ${JSON.stringify(statuses)}`);
    expect(statuses, "the duplicate create must be REFUSED by Fly, not quietly answered 200").toContain(409);

    // …and Fly really does hold exactly ONE Machine for this session: the adopt
    // returned an id rather than minting one. This is the assertion that would
    // catch an "adopt" that quietly created a second Machine.
    const held = await client.listMachines({ metadata: { [SESSION_METADATA_KEY]: session } });
    note(`list by session → ${JSON.stringify(held.map((m) => ({ id: m.id, name: m.name, state: m.state })))}`);
    expect(held.map((m) => m.id)).toEqual([first.runnerId]);

    // The adapter's own vocabulary over the same Machine.
    const listed = (await runner.list()).filter((l) => l.sessionId === session);
    note(`runner.list() → ${JSON.stringify(listed)}`);
    expect(listed).toHaveLength(1);
    // Lane-A minors, Task 5 review M3: `state: expect.any(String)` was a reachability
    // assertion satisfied by ANY value (failure class 19), on precisely the field the
    // report calls surprising — `listStateOf` answers `"other"` for a Machine that is
    // still coming up, so a green here proved nothing about it. The summary is a
    // closed three-value union, so pinning TWO of the three is the strongest honest
    // assertion: seconds after its own successful create the Machine is up or coming
    // up, and `"stopped"` would mean it died on the way.
    const { state: listedState, ...identity } = listed[0]!;
    expect(identity).toEqual({ runnerId: first.runnerId, sessionId: session, name: `relay-${session}-r1`, environment: "live-test" });   // I1: the metadata round trip, on the real API
    expect(["running", "other"], "a Machine seconds after a successful create is running or coming up — `stopped` means it died").toContain(listedState);

    // Teardown through the adapter, then CONFIRMED by re-read: 200 `destroyed`
    // (or `destroying`) — never a 404 (C1).
    await runner.destroy(first.runnerId);
    const after = await client.getMachine(first.runnerId);
    note(`after destroy → ${JSON.stringify({ id: after?.id ?? null, state: after?.state ?? "absent-404" })}`);
    expect(after).not.toBeNull();
    expect(["destroyed", "destroying"]).toContain(after!.state);
    const observed = await runner.observe(first.runnerId);
    note(`runner.observe() after destroy → ${JSON.stringify(observed)}`);
    expect(["destroyed", "destroying"]).toContain(observed.state);
  }, 300_000);

  // R2004 PR 0: the ADAPTER's own create — not a hand-built body — reads back the stop_config it sent, on the real API. The
  // form is the one fly-client.live.test.ts leg 5 measured to round-trip; this leg proves FlyRunner sends that form. Then
  // our stop goes out through the adapter, driven from the domain's own STOP effect, and the Machine records it as a
  // requested stop. (Which signal ARRIVED is leg 5's to prove — this image cannot tell INT from TERM.)
  it("R2004 PR 0: a composed create reads back the stop_config it sent ({ SIGTERM, the grace }), and our STOP effect stops it as a requested stop", async () => {
    const session = `${tag}-b`;
    const spec: RunnerSpec = {
      sessionId: session, attempt: 1, environment: "live-test", jobToken: "live-not-a-real-token", appUrl: "https://seazn.club",
      guest: { cpus: 1, memoryMb: 256, cpuClass: "shared" }, region,
      deadlineAt: new Date(Date.now() + 10 * 60_000),
    };
    const h = await runner.create(spec);
    created.push(h.runnerId);
    const back = ((await client.getMachine(h.runnerId))?.config as { stop_config?: unknown } | undefined)?.stop_config;
    note(`create → ${h.runnerId}; stop_config read back → ${JSON.stringify(back)}`);
    expect(back).toEqual({ signal: "SIGTERM", timeout: `${RUNNER_STOP_GRACE_SECONDS}s` });

    await client.waitMachine(h.runnerId, "started", 60);
    const effect = stepRunner({ state: "playing", attempt: 1, name: machineNameFor(session, 1), machineId: h.runnerId, stopRequestedAt: null, lastExit: null, crashes: CRASHES_NONE }, { type: "session_stop" }, new Date())
      .effects.find((e) => e.type === "stop_machine");
    if (effect?.type !== "stop_machine") throw new Error("premise: playing × session_stop issues the STOP effect");
    await runner.stop(h.runnerId, { signal: effect.signal, timeoutSeconds: effect.timeoutSeconds });
    const gone = await client.waitMachine(h.runnerId, "destroyed", 60).catch((e: unknown) => e);
    note(`after our stop (auto_destroy) → ${gone instanceof Error ? gone.message : JSON.stringify(gone)}`);
    const observed = await runner.observe(h.runnerId);
    note(`runner.observe() after our stop → ${JSON.stringify(observed)}`);
    expect(["destroyed", "destroying"]).toContain(observed.state);
    expect(observed.exit?.requestedStop, "the exit Fly recorded is OUR requested stop, not a crash").toBe(true);
  }, 300_000);
});
