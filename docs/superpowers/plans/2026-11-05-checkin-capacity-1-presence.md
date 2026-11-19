# Check-in capacity, plan 1 of 3: webhook presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every RealtimeKit `participantJoined` / `participantLeft` / `meeting.ended` webhook in a presence table, signed and deduplicated, with the fixture vendor emitting the same webhooks so every suite exercises the path, and prove on staging that the table agrees with what the seat's vendor reads find.

**Architecture:** A public `POST /api/webhooks/realtimekit` route verifies the vendor's RSA-SHA256 signature over the raw body, records the delivery id for dedupe and applies the event to `fixture_video_presence` in one transaction. The fixture vendor (`apps/web/e2e/realtimekit-fixture-server.ts`) makes a key pair at start, serves it at its own `/.well-known/webhooks.json` and emits signed webhooks through a pluggable transport (HTTP for e2e, an in-process call for vitest). Nothing in this plan changes what seats a player: the seat still reads the vendor as today. The table is compared against those reads before plan 2 reads from it.

**Tech Stack:** Next.js 16 route handlers, `postgres` driver, Flyway SQL migrations under `db/migration/deltas`, Node `crypto` (RSA-SHA256), vitest (DB suites guarded by `describe.skipIf(!process.env.DATABASE_URL)`), Playwright e2e, `fast-check`.

**Spec:** `docs/superpowers/specs/2026-11-05-checkin-capacity-design.md` (sections 3, 6.2, 6.8 steps 0 to 3). Read it first; this plan argues from it.

> **Revised 2026-11-17** against origin/main 59c72dd361: migration V492 → V527 (siblings V528/V529; V529/V530 since 2026-11-18, when main's lots-draw index fix took V528), seed/pacing/env helpers and line numbers re-pinned, the root-script entry check moved to `isMainModule`, the staging key check moved under vitest (`server-only` is not installable outside Next/vitest), the walkthrough's base and insertion point re-pinned, and the missing commit wrapper replaced. Details in "Revision notes" at the end.
>
> **Review fixes 2026-11-17** (review `.superpowers/sdd/2026-11-17-checkin-capacity-review/plan-1.md`, owner rulings R4 and R7): the shadow report is two-sided and scoped; `currentPresence` has a deterministic tie-break and trusts a `source='read'` row only briefly; a third sealed table records ended sessions; deliveries are bound to meetings we hold; the key floor answers 503, not 401; retention, a smoke suite and the load harness's webhook knob are new tasks (10a–10c); and the rollout gate is a STAGING run against real RealtimeKit (Task 12 step 5), with the fixture-vendor load run kept as a local pre-check only. Every finding is mapped in "Review fixes 2026-11-17" at the end.

> **Execution order (owner, 2026-11-17):** this plan → plan 2 (its Task 0, the `sweep.ts` split, first as its own PR) → plan 3 Tasks 1–3 → the Match Day plan → plan 3 Task 7.

## Global Constraints

- Every new table is SEALED exactly like V460 `video_rooms_to_end`: `enable row level security`, `force row level security`, no policy, no grant; the sealed catalog test `apps/web/src/server/usecases/__tests__/online-chess-video-schema.test.ts` gains all three names. Neither table carries `org_id`, so `scripts/rls-exempt.ts` is untouched.
- Migrations are numbered by the next `V` after the highest file in `db/migration/deltas` at the moment of writing: V526 (`V526__pricing_recut_fees_credits_stream_cap.sql`) is the highest on origin/main 59c72dd361 (2026-11-17), so this plan's is V527 (plan 2's V529 and plan 3's V530 since 2026-11-18, when main's lots-draw index fix took V528); the file header says "renumber at merge if main has moved", as V460's does.
- The load harness (rollout step 2 and every later measurement) is `apps/web/e2e/load/chess-30-boards.load.ts` with `apps/web/e2e/load/line-load.ts`, its scenarios `B`, `B-honest`, `B-slow-*`, `B-dry`, `B-end`, run metered (`LOAD_METERED=1`, the server with `REALTIMEKIT_METER_ANY_BASE=1`); its header is the runbook. From Task 10c on, `LOAD_WEBHOOKS=1` makes its fixture deliver webhooks to the server under test; unset (Task 11's baseline) it delivers none. Every run that measures presence (Task 12 step 4, plan 2's final run) sets it, and the harness fails a run that set it and delivered zero.
- No token, key or secret is ever written to disk or committed. The fixture's key pair lives in process memory only.
- **A delivery is ours only if it names a meeting we hold.** Cloudflare's key URL names no account or app, so every RealtimeKit customer's events verify against the same key, and staging and production may share one app. After verification and parsing, an event applies only when its `meeting.id` is in `fixture_video_meetings`, in `video_rooms_to_end` (a room a re-pair parked), or already has a `fixture_video_presence` row (so a `meeting.ended` that arrives after the sweep ended a parked room and deleted its parking row still closes our rows). Any other meeting is answered `200 ignored` and writes NOTHING, not even a delivery row: a third party can never make the public route insert.
- **Presence order is total.** Every reader that picks a current peer orders by `joined_at`, then `received_at`, then the `seq` column (a `bigserial`), ascending, and the LAST open row wins. `currentPeerOf` takes rows in that order; any SQL that feeds it (plan 3's round statement included) must `order by joined_at, received_at, seq`.
- **A `source='read'` row is a hint, not a fact.** Only a webhook can close a row, and a read row exists exactly when webhooks are missing, so `currentPresence` treats a read row as current only for `PRESENCE_READ_TRUST_MS = 10_000` after its `received_at` (the spec §6.3 fallback window): after that the seat returns to its 3-call read (owner ruling R4: the seat must be able to tell a departed peer). A webhook for the same peer upgrades the row to `source='webhook'`.
- A webhook never seats a player and never decides a seat in this plan (spec section 2, anti-goals). The seat path (`preflight.ts`) is not modified here.
- Vendor payload fields read: `event`, `meeting.id`, `meeting.sessionId`, `meeting.endedAt`, `participant.peerId`, `participant.customParticipantId`, `participant.joinedAt`, `participant.leftAt`. Headers: `rtk-signature` (Base64 RSA-SHA256 over the raw body), `rtk-uuid` (delivery id). 2xx is success; the vendor retries 5xx and network errors only.
- Cloudflare's public key URL is `https://api.realtime.cloudflare.com/.well-known/webhooks.json`, body `{ data: { publicKey } }`. The key's encoding there is NOT measured: the verifier accepts a PEM (SPKI or PKCS#1, with real or escaped newlines) or bare base64 DER, and the staging checklist proves the fetched document imports before anything else. The key is cached per process for `WEBHOOK_KEY_TTL_MS = 24 h`; a verification failure forces at most one refetch per `WEBHOOK_KEY_REFETCH_MIN_MS = 60_000` per process (the route is public: a forged signature must not be a way to make the server call out). Spec §6.2 says to refresh the key on any verification failure before refusing, and the vendor never retries a 4xx (§3), so when the floor (or a failed fetch) means NO fresh key was fetched, the receiver answers a retryable **503**, never 401: a correctly signed delivery under a just-rotated key arriving inside the floor window is retried by the vendor after it, never lost. 401 is answered only when a key fetched for this very request still does not verify. The floor applies to Cloudflare's base only (`baseUrlOf({}) === CF_BASE`, the same gate `cfEnvelope` meters by): any other base is a fixture, which mints a fresh key per start under a dev server or CI's one server that outlives many starts, so a forced refetch there always fetches.
- The fixture serves its key at `GET /.well-known/webhooks.json` ABOVE its Bearer check and its `setUnavailable` gate (always answered, never a kit call, never in `calls`), as the real document is public.
- Cron-shaped routes are found by the literal `x-cron-secret` in a route file's TEXT, comments included (`apps/cron-worker/test/drift.test.ts`); the webhook route's source must not contain that literal anywhere.
- Tests: every invariant reports how many items it checked and zero is a failure; expected values come from the fixture's own record or the spec, never from the code under test; every guard added is mutated once before the task is called green (TEST-STRATEGY.md rules 2, 3, 5).
- Scoped runs only: `cd apps/web && npx vitest run <paths>` with `DATABASE_URL` exported from a fresh schema (`seazn-env up`), never the full suite (AGENTS.md).
- A test that touches a user-facing string adds it to all four dictionaries under `apps/web/src/dictionaries/<locale>/`; this plan adds none.
- Commits go through plain `git commit` (pathspec-limited to the task's files) on a non-protected branch in a worktree; never on `main` (AGENTS.md: new branches go in a worktree). The `~/.claude/tools/github-safe.sh` wrapper this line used to name does not exist on the current workstation.

## Review Focus

1. **A webhook for a participant the table cannot name yet.** The vendor can deliver `participantJoined` for a custom id with no `fixture_video_participants` row (an arbiter whose insert failed, a row deleted by a re-pair). Expected: stored with a null `participant_id`, logged at warn, and found later by `currentPresence` through `custom_participant_id`. Pinned in Task 5.
2. **A delivery whose transaction failed, then retried by the vendor with the same `rtk-uuid`.** Expected: the retry applies (no delivery row was committed), so the dedupe never swallows a legitimate retry. Pinned in Task 6.
3. **`participantLeft` arriving before its own `participantJoined`.** Expected: one row with both stamps from the payload; the later `joined` changes nothing. Pinned in Task 5.
4. **A body that is not JSON, or JSON that is not a RealtimeKit event.** Expected: 400 and nothing written; never a 500 that the vendor would retry forever. Pinned in Task 7.
5. **The key rotated at the vendor.** Expected: one forced refetch, then the event applies; a second failure is 401; a refetch the floor suppressed is 503 (retried), never 401 (lost). Pinned in Task 6.
6. **Phantom presence: an open row for a peer that has gone.** A lost `participantLeft`, or a `joined` retried after `meeting.ended`, must not leave a peer looking current. Expected: `joined` after the session's recorded end is stored closed; a `read` row stops being current after `PRESENCE_READ_TRUST_MS`; the shadow report counts open rows and rows closed only by the session end. Pinned in Tasks 5, 9, 10c and 12.
7. **A signed event from another RealtimeKit app.** Expected: 200 `ignored`, no row of any kind. Pinned in Tasks 6 and 7.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/web/e2e/realtimekit-fixture-server.ts` (modify) | The fixture vendor: key pair, `/.well-known/webhooks.json`, webhook emission at every join, leave, kick and session end, pluggable delivery, a log of what it emitted. |
| `apps/web/src/server/external-play/__tests__/realtimekit-fixture-webhooks.test.ts` (create, beside the existing `realtimekit-fixture-contract.test.ts` in that directory) | The fixture's webhook contract. |
| `db/migration/deltas/V<next>__video_presence.sql` (create) | `realtimekit_webhook_deliveries`, `fixture_video_presence` and `realtimekit_ended_sessions`, sealed. |
| `apps/web/src/server/external-play/video/webhook-event.ts` (create) | Pure parser from a JSON body to a typed event. |
| `apps/web/src/server/external-play/video/webhook-signature.ts` (create) | Pure signature verification, the key URL rule, the per-process key cache. |
| `apps/web/src/server/external-play/video/presence.ts` (create) | The presence table's one writer (`applyPresenceEvent`, `recordPresenceFromRead`, `prunePresence`) and its readers (`currentPresence`, `everJoined`, `peersOf`, `presenceShadowReport`, `heldMeeting`); the pure `currentPeerOf`. |
| `apps/web/src/server/external-play/video/webhook.ts` (create) | The receiver usecase: verify, dedupe, apply, in one transaction. |
| `apps/web/src/server/external-play/video/realtimekit.ts` (modify) | Export `CF_BASE` and `baseUrlOf` so the key URL rule and the metering gate read one base. |
| `apps/web/src/app/api/webhooks/realtimekit/route.ts` (create) | The HTTP door, shaped like `apps/web/src/app/api/webhooks/stripe/route.ts`. |
| `scripts/realtimekit-webhook-register.ts` (create), `package.json` (modify) | One-off registration of the webhook at the vendor, per environment. |
| `scripts/presence-shadow-report.ts` (create) | The shadow-mode comparison, runnable against staging. |
| `apps/web/e2e/walkthrough/chess-external-play.spec.ts` (modify) | The walkthrough delivers the fixture's webhooks over HTTP and asserts the presence row. |
| `scripts/smoke/suites/realtimekitWebhookSmoke.ts` (create), `scripts/smoke/main.ts` (modify) | The public route's smoke (Task 10a), beside `resendWebhookSmoke`. |
| `apps/web/src/server/usecases/external-play/sweep.ts` (modify) | One retention step in `runPass` (Task 10b). The file is 1,504 lines, over MODULARIZATION.md's 1,500: read that file first; the step is a single call into `presence.ts`, and plan 2's Task 0 split carries it verbatim into `sweep/run.ts`. |
| `apps/web/e2e/load/chess-30-boards.load.ts` (modify) | The `LOAD_WEBHOOKS` knob, the delivered count and the end-of-run presence checks (Task 10c). |
| `docs/superpowers/plans/2026-11-05-checkin-capacity-baseline.md` (create) | The baseline load run's numbers (rollout step 2). |

---

### Task 1: The fixture vendor emits signed webhooks

**Files:**
- Modify: `apps/web/e2e/realtimekit-fixture-server.ts`
- Test: `apps/web/src/server/external-play/__tests__/realtimekit-fixture-webhooks.test.ts`

**Interfaces:**
- Consumes: the fixture's existing `setLivePublisher`, `endIfEmpty`, `leave`, the kick routes and `DELETE /meetings/:id/participants/:pid`.
- Produces:

```ts
export type FixtureWebhookEvent = "meeting.participantJoined" | "meeting.participantLeft" | "meeting.ended";
export type FixtureWebhook = { uuid: string; event: FixtureWebhookEvent; body: string; signature: string; at: number };
/** Resolves when the receiver accepted the webhook (2xx); REJECTS when it did not (a final non-2xx, a network error, a thrown
 *  receiver). The fixture catches every rejection itself (never an unhandled rejection) and records it in `webhookOutcomes`. */
export type WebhookDeliver = (w: FixtureWebhook) => Promise<void>;
export type WebhookOutcome = "pending" | "delivered" | "failed" | "down";
/** POST `body` to `url` with headers rtk-signature, rtk-uuid, content-type application/json. A 5xx or a network error
 *  is retried twice more, 200 ms apart; any other non-2xx is not retried (the vendor does not retry those). Rejects with the
 *  last status (or the network error) when no attempt got a 2xx. */
export function httpWebhookDeliver(url: string, fetchImpl?: typeof fetch): WebhookDeliver;
export async function startRealtimeKitFixtureServer(port?: number, opts?: { webhooks?: WebhookDeliver }): Promise<RealtimeKitFixtureServer>;
// RealtimeKitFixtureServer gains:
//   webhooks: FixtureWebhook[];            every webhook emitted, delivered or not, in order
//   webhookOutcomes: Map<string, WebhookOutcome>;  uuid → what became of it ("down" while setWebhooksDown, "pending" until settled)
//   webhooksSettled(): Promise<void>;      resolves once every delivery started so far has settled, through Promise.allSettled over the
//                                          kept promises (a failed delivery never rejects it); a test awaits it before reading what a delivery wrote
//   publicKeyPem: string;                  SPKI PEM, what GET /.well-known/webhooks.json serves as { success: true, data: { publicKey } }
//   setWebhooksDown(down: boolean): void;  while down, emitted webhooks are logged and not delivered
//   reset() also empties `webhooks` and `webhookOutcomes`, clears the down flag and awaits the in-flight deliveries, so one test's deliveries never land in the next's `got`.
//     Its return type therefore changes from `void` (today, fixture line 140) to `Promise<void>`: it clears synchronously exactly as today,
//     then awaits. The existing callers that do not await it (realtimekit-fixture-contract.test.ts, route-seat-wire.test.ts,
//     external-play-sweep.test.ts, external-play-create-recovery-fixture.test.ts, ...) need no edit: they start the fixture without
//     `webhooks`, so nothing is in flight, and apps/web's eslint config has no floating-promise rule.
// Suites start the fixture on port 0 (the OS picks; `fx.port` and `fx.url` carry the bound port), so files running in parallel threads never share one.
```

Body shapes (the fields the receiver reads; extra fields allowed):

```json
{"event":"meeting.participantJoined","meeting":{"id":"<meeting>","sessionId":"<session>","status":"LIVE"},"participant":{"peerId":"<peer>","customParticipantId":"<subject>","presetName":"<preset>","joinedAt":"<iso>"}}
{"event":"meeting.participantLeft","meeting":{"id":"<meeting>","sessionId":"<session>","status":"LIVE"},"participant":{"peerId":"<peer>","customParticipantId":"<subject>","presetName":"<preset>","joinedAt":"<iso>","leftAt":"<iso>"}}
{"event":"meeting.ended","meeting":{"id":"<meeting>","sessionId":"<session>","status":"ENDED","endedAt":"<iso>"}}
```

`participant.joinedAt` is the PEER's own join: the `created_at` of that peer's `PEER_JOINING` event in the fixture's row (the `at` that `setLivePublisher` stamps), never `row.joinedAt`, which a reload leaves at the row's first join (fixture line 459: a reload is a new peer under the same row) and which would make two peers of one row tie. `participantLeft` carries the same peer's `joinedAt` and the row's `leftAt`. This matches how `realtimekit.ts currentPeer` (line 721) dates a peer.

Emission points: `setLivePublisher(id, true)` emits one `participantJoined` for the new peer (a second call on a live participant, a reload, emits a second `participantJoined` for a second, distinct peer and no leave for the first, exactly as the fixture's model keeps both peers' `PEER_JOINING`); `setLivePublisher(id, false)`, `POST .../kick`, `POST .../kick-all` and `DELETE .../participants/:pid` emit one `participantLeft` per peer they take out; a session that ends (`endIfEmpty`) emits one `meeting.ended` after the leaves. The signature is `crypto.sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64")` over the exact bytes delivered; `uuid` is `randomUUID()`. `GET /.well-known/webhooks.json` is matched FIRST in the request handler, before the `down` 503, the Bearer check and the kit-prefix 404 (the real document is public and always up), and is not pushed to `calls`. The key pair is `generateKeyPairSync("rsa", { modulusLength: 2048 })`, made once per `start`, never written anywhere. Delivery stays fire-and-forget for the routes, but every delivery promise is kept until it settles so `webhooksSettled()` can await them; each is wrapped `deliver(w).then(() => outcomes.set(uuid, "delivered"), (err) => { outcomes.set(uuid, "failed"); lastError = err; })`, so no rejection escapes the fixture.

- [ ] **Step 1: Write the failing tests**

```ts
import { createServer } from "node:http";
import { verify } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { httpWebhookDeliver, startRealtimeKitFixtureServer, type FixtureWebhook, type RealtimeKitFixtureServer } from "../../../../e2e/realtimekit-fixture-server"; // the path realtimekit-fixture-contract.test.ts uses

let fx: RealtimeKitFixtureServer;
const got: FixtureWebhook[] = [];
beforeAll(async () => { fx = await startRealtimeKitFixtureServer(0, { webhooks: async (w) => { got.push(w); } }); });
beforeEach(async () => { await fx.reset(); got.length = 0; });
afterAll(() => fx.close());

const mint = async () => { /* POST `${fx.url}${fx.kitPath}/meetings` then `${fx.url}${fx.kitPath}/meetings/:id/participants` (body { custom_participant_id, preset_name }) over HTTP with `Bearer ${REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN}`, as the contract test's `meeting()` does (a path outside `kitPath` is the gateway 404); return { meetingId, participantId } */ };
const parse = (w: FixtureWebhook) => JSON.parse(w.body) as { event: string; meeting: { id: string; sessionId: string }; participant?: { peerId: string; customParticipantId: string; joinedAt: string; leftAt?: string } };

it("a join emits one participantJoined that verifies against the served key and names the fixture's own peer", async () => {
  const { meetingId, participantId } = await mint();
  fx.setLivePublisher(participantId, true);
  await fx.webhooksSettled();
  expect(got).toHaveLength(1);
  const w = got[0]!;
  const body = parse(w);
  expect(body.event).toBe("meeting.participantJoined");
  expect(body.meeting.id).toBe(meetingId);
  expect(body.participant!.peerId).toBe(fx.currentPeer(participantId));
  expect(body.participant!.customParticipantId).toBe(fx.participant(participantId)!.subject);
  expect(verify("RSA-SHA256", Buffer.from(w.body), fx.publicKeyPem, Buffer.from(w.signature, "base64"))).toBe(true);
  const served = await (await fetch(`${fx.url}/.well-known/webhooks.json`)).json();
  expect(served.data.publicKey).toBe(fx.publicKeyPem);
  expect(fx.webhooks).toEqual(got);
});

it("a leave emits participantLeft for the same peer with leftAt no earlier than joinedAt; the last leave ends the session", async () => { /* setLivePublisher true then false: events [joined, left, ended]; left.peerId equals joined.peerId; Date.parse(leftAt) >= Date.parse(joinedAt); ended.meeting.sessionId equals joined.meeting.sessionId; fx.currentPeer(participantId) is null */ });

it("a reload (setLivePublisher true twice) emits two joins for two distinct peers, each dated by its OWN PEER_JOINING", async () => {
  /* setLivePublisher(pid, true) twice; got: [joined, joined]; the two peerIds differ; the second equals fx.currentPeer(pid); each
     body's participant.joinedAt equals the created_at of that peer's PEER_JOINING event as the fixture itself serves it
     (GET `${fx.kitPath}/sessions/:id/participants?include_peer_events=true`, the row's peer_events): the expected value is the
     fixture's own record, never the emitter's output; no participantLeft was emitted */
});

it("kick-all emits one participantLeft per live peer, then meeting.ended", async () => { /* two participants joined; POST kick-all; expect got events [joined, joined, left, left, ended] and the two left peers equal the two joined peers as a set */ });

it("DELETE of a participant emits its leave", async () => { /* joined; DELETE .../participants/:pid; expect a participantLeft for that peer */ });

it("webhooks down: emitted and logged, never delivered", async () => { fx.setWebhooksDown(true); /* join */ await fx.webhooksSettled(); expect(got).toHaveLength(0); expect(fx.webhooks).toHaveLength(1); expect(fx.webhookOutcomes.get(fx.webhooks[0]!.uuid)).toBe("down"); });

it("a delivery that rejects is recorded as failed and never escapes: webhooksSettled resolves, no unhandled rejection", async () => {
  /* a second fixture started with webhooks: async () => { throw new Error("receiver down"); }; join; await fx2.webhooksSettled()
     resolves; fx2.webhookOutcomes.get(uuid) === "failed"; a process.on("unhandledRejection") counter registered for the test is 0 */
});

it("the key document is served during a vendor outage and without a bearer, and never lands in `calls`", async () => { fx.setUnavailable(true); const res = await fetch(`${fx.url}/.well-known/webhooks.json`); expect(res.status).toBe(200); expect(fx.calls.some((c) => c.path.includes("well-known"))).toBe(false); fx.setUnavailable(false); });

it("a tampered body does not verify", async () => { /* join; const w = got[0]; verify over w.body + " " is false */ });

it("no HTTP request emits a webhook: only the in-process seam does (anti-vacuity: every route is hit)", async () => {
  /* hit each of the fixture's routes with any body spelling a join ("live", "cameraOk", "joined": true ...); count routes hit (expect >= 10); expect fx.webhooks to be [] */
});

describe("httpWebhookDeliver", () => {
  it("posts the body with rtk-signature and rtk-uuid, retries a 500 twice more, and drops a 401 without retry", async () => {
    /* a local http server records requests and answers from a queue [500, 500, 200] then [401]; expect 3 requests for the first webhook with identical bodies and headers and the promise resolved, 1 for the second and its promise REJECTED */
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && DATABASE_URL= npx vitest run src/server/external-play/__tests__/realtimekit-fixture-webhooks.test.ts`
Expected: FAIL with `httpWebhookDeliver is not a function` / `fx.webhooks is undefined`.

- [ ] **Step 3: Implement the emission in `apps/web/e2e/realtimekit-fixture-server.ts`**

Add the key pair, the well-known route, `emit(event, meeting, session, row?, peerId?)` building the body and signature, the `webhooks` log, `setWebhooksDown`, and call `emit` from the five points named in the Interfaces block. `deliver` is awaited inside a `void (async () => …)()` so emission never blocks a route. Keep the one design rule of the file: nothing arriving over HTTP creates presence or a webhook.

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same command. Expected: PASS, every `it` green, the route count assertion at or above 10.

- [ ] **Step 5: Mutate once**

Comment out the `emit` call in `setLivePublisher`; the first test must fail. Restore. Then emit `row.joinedAt` instead of the peer's `at`; the reload test must fail. Restore. Then drop the rejection handler from the delivery wrapper; the "rejects" test must fail. Restore.

- [ ] **Step 6: Commit**

Message: `test(e2e): realtimekit fixture emits signed presence webhooks`. Files: the fixture server and the new test.

---

### Task 2: The two tables

**Files:**
- Create: `db/migration/deltas/V527__video_presence.sql`
- Modify: `apps/web/src/server/usecases/__tests__/online-chess-video-schema.test.ts` (the sealed catalog)

**Interfaces:**
- Produces the schema every later task reads:

```sql
-- V<next> — webhook presence (check-in capacity design 2026-11-05 §6.2). Renumber at merge if main has moved past.
create table realtimekit_webhook_deliveries (
  rtk_uuid    text primary key,
  event       text not null,
  received_at timestamptz not null default now()
);
create index realtimekit_webhook_deliveries_received_idx on realtimekit_webhook_deliveries (received_at); -- retention (Task 10b)
alter table realtimekit_webhook_deliveries enable row level security;
alter table realtimekit_webhook_deliveries force  row level security;

create table fixture_video_presence (
  meeting_id            text not null,
  peer_id               text not null,
  -- the board and side the meeting belonged to when the row was written (heldMeeting, Task 5), kept because a re-pair or a
  -- teardown can delete the meeting row; the shadow report and its tests scope by it. null only if the lookup found none.
  fixture_id            uuid null,
  side                  text null check (side in ('home', 'away')),
  participant_id        text null,
  custom_participant_id text not null,
  session_id            text null,
  joined_at             timestamptz null,
  left_at               timestamptz null,
  -- what closed the row: the peer's own participantLeft, or its session's meeting.ended (a row closed only by the end is a
  -- lost-leave witness the shadow report counts); null while open
  left_by               text null check (left_by in ('left', 'ended')),
  source                text not null check (source in ('webhook', 'read')),
  received_at           timestamptz not null default now(),
  -- the last tie-break of the presence order (joined_at, received_at, seq): two joins in one millisecond still order
  seq                   bigserial not null,
  primary key (meeting_id, peer_id)
);
create index fixture_video_presence_live_idx on fixture_video_presence (meeting_id, participant_id) where left_at is null;
create index fixture_video_presence_custom_idx on fixture_video_presence (meeting_id, custom_participant_id);
create index fixture_video_presence_session_idx on fixture_video_presence (meeting_id, session_id) where left_at is null; -- meeting.ended
create index fixture_video_presence_received_idx on fixture_video_presence (received_at); -- retention (Task 10b)
create index fixture_video_presence_fixture_idx on fixture_video_presence (fixture_id, side); -- the shadow report's scope
alter table fixture_video_presence enable row level security;
alter table fixture_video_presence force  row level security;

-- A session's end, kept so a joined/left that arrives AFTER meeting.ended (a 5xx retried late) is stored closed.
create table realtimekit_ended_sessions (
  meeting_id  text not null,
  session_id  text not null,
  ended_at    timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (meeting_id, session_id)
);
create index realtimekit_ended_sessions_received_idx on realtimekit_ended_sessions (received_at); -- retention (Task 10b)
alter table realtimekit_ended_sessions enable row level security;
alter table realtimekit_ended_sessions force  row level security;
```

No foreign keys, on purpose: a webhook can name a meeting whose row a re-pair has deleted, and the row must still be kept (spec §6.2, "never dropped"; the meeting is still in `video_rooms_to_end`, Global Constraints). No `org_id`.

- [ ] **Step 1: Add the three names to the sealed catalog test's list (`SEALED`, line 882, in the `describe("sealed tables (V451, V454, V457, V458, V460, V461) …")` block near the file's end), each in its alphabetical position (the list is compared against `order by relname`: `fixture_video_presence` after `fixture_video_participants`; `realtimekit_ended_sessions` then `realtimekit_webhook_deliveries` after `realtimekit_call_budget`; `WITH_ORG_ID` is unchanged), and run it**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/online-chess-video-schema.test.ts`
Expected: FAIL, the three tables are missing from the catalog.

- [ ] **Step 2: Write the migration file with the SQL above, apply it**

Run: `npm run db:apply` (from the repo root, against the fresh schema's `DATABASE_URL`).
Expected: Flyway reports the new version applied.

- [ ] **Step 3: Run the sealed catalog test**

Expected: PASS; it asserts RLS enabled and forced, zero policies and no `app_user` privilege on all three.

- [ ] **Step 4: Commit**

Message: `feat(db): presence and webhook delivery tables, sealed`.

---

### Task 3: The event parser (pure)

**Files:**
- Create: `apps/web/src/server/external-play/video/webhook-event.ts`
- Test: `apps/web/src/server/external-play/video/__tests__/webhook-event.test.ts`

**Interfaces:**

```ts
export type RealtimeKitEvent =
  | { kind: "joined"; event: string; meetingId: string; sessionId: string | null; peerId: string; customParticipantId: string; joinedAt: Date }
  | { kind: "left"; event: string; meetingId: string; sessionId: string | null; peerId: string; customParticipantId: string; joinedAt: Date | null; leftAt: Date }
  | { kind: "ended"; event: string; meetingId: string; sessionId: string | null; endedAt: Date }
  | { kind: "other"; event: string };
// `event` is the body's raw name on every variant: the delivery row records it (Task 6).
/** null: not a RealtimeKit webhook body (no string `event`, or a known event missing a required field or with an unreadable date). */
export function parseRealtimeKitEvent(body: unknown): RealtimeKitEvent | null;
```

- [ ] **Step 1: Write the failing tests**

```ts
it("parses the three events the receiver applies", () => { /* the three bodies from Task 1, exact Date values from the ISO strings */ });
it("an unknown event name is `other`, never null", () => { expect(parseRealtimeKitEvent({ event: "meeting.started", meeting: { id: "m" } })).toEqual({ kind: "other", event: "meeting.started" }); });
it("a known event missing a required field is null (sweep: every required field of every applied shape removed, one at a time)", () => {
  /* a table of the three bodies from Task 1 with their required key paths, typed from spec §6.2 (never read off the parser):
     joined  5: event, meeting.id, participant.peerId, participant.customParticipantId, participant.joinedAt
     left    5: event, meeting.id, participant.peerId, participant.customParticipantId, participant.leftAt
     ended   3: event, meeting.id, meeting.endedAt
     for each (shape, path) delete the path and expect null; ALSO set it to an unreadable value ("yesterday" for a date, 7 for an id)
     and expect null. Report the count of (shape, path) pairs checked and expect exactly 13: zero or fewer is a failure. A parser that
     fell back to the receipt time for a missing leftAt / endedAt (spec §6.2 forbids it) fails this sweep. */
});
it("tolerated as null, and only these: a missing meeting.sessionId (all three shapes), a missing participant.joinedAt on `left`", () => { /* left without joinedAt parses with joinedAt null and leftAt from the payload; each shape without meeting.sessionId parses with sessionId null */ });
it("a body that is not an object is null", () => { for (const b of [null, 1, "x", [], undefined]) expect(parseRealtimeKitEvent(b)).toBeNull(); });
```

- [ ] **Step 2: Run to verify they fail** (`cd apps/web && DATABASE_URL= npx vitest run src/server/external-play/video/__tests__/webhook-event.test.ts`): FAIL, module not found.

- [ ] **Step 3: Implement `parseRealtimeKitEvent`** with a small `isoDate(v: unknown): Date | null` helper; no library.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutate once:** make a missing `participant.leftAt` fall back to `new Date()`; the sweep must fail at `(left, participant.leftAt)`. Restore.

- [ ] **Step 6: Commit** — `feat(video): parse realtimekit webhook events`.

---

### Task 4: Signature verification and the key cache

**Files:**
- Create: `apps/web/src/server/external-play/video/webhook-signature.ts`
- Modify: `apps/web/src/server/external-play/video/realtimekit.ts` (export `CF_BASE` and `baseUrlOf`)
- Test: `apps/web/src/server/external-play/video/__tests__/webhook-signature.test.ts`

**Interfaces:**

```ts
export const REALTIMEKIT_WEBHOOK_KEY_URL = "https://api.realtime.cloudflare.com/.well-known/webhooks.json";
export const WEBHOOK_KEY_TTL_MS = 24 * 60 * 60_000;
export const WEBHOOK_KEY_REFETCH_MIN_MS = 60_000;
/** The served key in any of the shapes a vendor may use, as a KeyObject: a PEM (SPKI or PKCS#1, real or `\n`-escaped newlines) or bare
 *  base64 DER (SPKI). null when none of them imports. The ONE normalizer; the verifier and the staging check both use it. */
export function importWebhookPublicKey(served: string): KeyObject | null;
/** RSA-SHA256 over the raw body bytes, Base64 signature, against `importWebhookPublicKey(served)`. False on any malformed input; never throws. */
export function verifyRealtimeKitSignature(rawBody: string, signatureB64: string, served: string): boolean;
/** Cloudflare's base (realtimekit.ts CF_BASE) → REALTIMEKIT_WEBHOOK_KEY_URL; any other base → `${new URL(base).origin}/.well-known/webhooks.json`. */
export function webhookKeyUrl(baseUrl: string): string;
/** The served key string for the process's vendor base (`baseUrlOf({})` read AT CALL TIME unless `opts.baseUrl`), cached; refetched after
 *  WEBHOOK_KEY_TTL_MS, or on `force`: at most once per WEBHOOK_KEY_REFETCH_MIN_MS when the base is CF_BASE (a forced ask inside that
 *  window returns the cached key without fetching), and every time for any other base (a fixture's key changes per start). A fetch
 *  failure with a cached key returns the cached key and logs; with none it throws. `fetched` says whether THIS call fetched a fresh
 *  key: false when served from the cache (unforced inside the TTL, floor-suppressed, or a failed fetch falling back to the cache), so
 *  the receiver can tell "a fresh key still refuses" (401) from "no fresh key was fetched" (503, Global Constraints). */
export async function webhookPublicKey(opts?: { fetch?: typeof fetch; baseUrl?: string; now?: number; force?: boolean }): Promise<{ key: string; fetched: boolean }>;
export function forgetWebhookKey(): void; // test seam
```

- [ ] **Step 1: Write the failing tests**

```ts
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const signed = (body: string) => sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64");

it("verifies a signature over the exact bytes and refuses a changed body, another key, and garbage", () => {
  expect(verifyRealtimeKitSignature("{}", signed("{}"), pem)).toBe(true);
  expect(verifyRealtimeKitSignature("{} ", signed("{}"), pem)).toBe(false);
  expect(verifyRealtimeKitSignature("{}", signed("{}"), otherPem)).toBe(false);
  expect(verifyRealtimeKitSignature("{}", "not base64!", pem)).toBe(false);
  expect(verifyRealtimeKitSignature("{}", signed("{}"), "not a pem")).toBe(false);
});
it("the key URL: Cloudflare's base reads Cloudflare's published key; a fixture base reads its own origin", () => {
  expect(webhookKeyUrl(CF_BASE)).toBe(REALTIMEKIT_WEBHOOK_KEY_URL);
  expect(webhookKeyUrl("http://127.0.0.1:4322")).toBe("http://127.0.0.1:4322/.well-known/webhooks.json");
  expect(webhookKeyUrl("http://127.0.0.1:4322/some/path/")).toBe("http://127.0.0.1:4322/.well-known/webhooks.json");
});
it("imports the key in every shape a vendor may serve: SPKI PEM, PKCS#1 PEM, a PEM with escaped newlines, bare base64 DER; and not garbage (5 cases counted)", () => {
  /* derive each shape from the one generated key; expect importWebhookPublicKey non-null for the four and null for "not a key"; verifyRealtimeKitSignature true with each of the four */
});
it("caches for the TTL, refetches after it and on force, floors forced refetches on Cloudflare's base, keeps the old key across a failed refetch", async () => {
  /* baseUrl: CF_BASE; a counting fetch stub answering { data: { publicKey: pem } }; two calls at now=0 -> 1 fetch, fetched [true, false];
     now=TTL -> 2 (fetched true); force at now=TTL -> 3 (fetched true); force again at now=TTL+1s -> still 3, { key: pem, fetched: false }
     (floored); force at now=TTL+WEBHOOK_KEY_REFETCH_MIN_MS -> 4; stub then rejects on a forced ask past the floor: resolves to
     { key: pem, fetched: false } (cached) and the count is 5 */
});
it("a fixture base has no floor: two forced asks one second apart fetch twice, and the second returns the NEW key the stub now serves", async () => {
  /* baseUrl: "http://127.0.0.1:4322"; force at now=0 -> 1 fetch; the stub switches to otherPem; force at now=1s -> 2 fetches and the answer is { key: otherPem, fetched: true } */
});
it("with no cached key a failed fetch throws", async () => { forgetWebhookKey(); /* rejecting fetch */ await expect(webhookPublicKey({ fetch: failing })).rejects.toThrow(); });
// Mutate once (Step 4): make a floor-suppressed forced ask report fetched: true; the floor test must fail. Restore.
// The operator's staging check (Task 12 step 3), run only when the fetched document is handed in; skipped in CI and in every normal run.
it.skipIf(!process.env.RTK_WEBHOOK_KEY_DOC)("the live key document imports (Task 12 step 3)", () => {
  const doc = JSON.parse(process.env.RTK_WEBHOOK_KEY_DOC!) as { data?: { publicKey?: unknown } };
  expect(typeof doc.data?.publicKey).toBe("string");
  expect(importWebhookPublicKey(doc.data!.publicKey as string)).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** In `realtimekit.ts` change `const CF_BASE` to `export const CF_BASE` (line 104, value `"https://api.cloudflare.com/client/v4"`) and `function baseUrlOf` to `export function baseUrlOf` (line 107, signature `baseUrlOf(deps: RealtimeKitDeps): string`, so the rule reads `baseUrlOf({})`). Verification uses `crypto.verify("RSA-SHA256", …)` inside try/catch returning false.

- [ ] **Step 4: Run to verify they pass**, then the mutation noted under the tests (a floored forced ask reporting `fetched: true` must red the floor test). Restore.

- [ ] **Step 5: Commit** — `feat(video): realtimekit webhook signature and key cache`.

---

### Task 5: The presence store

**Files:**
- Create: `apps/web/src/server/external-play/video/presence.ts`
- Test: `apps/web/src/server/external-play/video/__tests__/presence.test.ts` (DB suite)

**Interfaces:**

```ts
type AnySql = postgres.Sql | postgres.TransactionSql;
export type PresenceRow = { meetingId: string; peerId: string; fixtureId: string | null; side: "home" | "away" | null; participantId: string | null; customParticipantId: string; sessionId: string | null; joinedAt: Date | null; leftAt: Date | null; leftBy: "left" | "ended" | null; source: "webhook" | "read"; receivedAt: Date };
// `seq` stays in SQL only (an int8 the postgres driver would hand back as a string): it orders rows, nothing reads its value.
/** A `source='read'` row is current only this long after its `received_at` (Global Constraints; spec §6.3's fallback window). */
export const PRESENCE_READ_TRUST_MS = 10_000;
/** The shadow report's tolerance for a webhook that lands after the seat's stamp: inside it, plan 2's presence path would still
 *  have seated the player before its fallback fired (spec §6.3). Compared on OUR clock (`received_at` against the seat's stamp). */
export const SHADOW_ARRIVAL_TOLERANCE_MS = 10_000;
/** The current peer of a set of rows: the latest `joinedAt` with `leftAt` null; a row with no `joinedAt` is never current; among
 *  equal `joinedAt` the LATER row in the input wins. Callers pass rows in the presence order (`joined_at, received_at, seq`
 *  ascending, Global Constraints), so the tie is deterministic: a SQL reader feeding this function must `order by` exactly that. */
export function currentPeerOf(rows: readonly Pick<PresenceRow, "peerId" | "joinedAt" | "leftAt">[]): { peerId: string; joinedAt: Date } | null;
/** The receiver's ownership test (Global Constraints), and the board the rows are stamped with: the meeting's (fixture_id, side)
 *  from fixture_video_meetings, else from video_rooms_to_end, else from an existing presence row of that meeting; null when none
 *  (not ours: the receiver answers 200 ignored and writes nothing). Each lookup is keyed by meeting_id alone, which the video
 *  source guard classifies `other_key` (its own rule test, `video-per-player-source-guard.test.ts` line 146), not unkeyed. */
export async function heldMeeting(db: AnySql, meetingId: string): Promise<{ fixtureId: string; side: "home" | "away" } | null>;
/** The participant a custom id names in a meeting, through the meeting row's (fixture_id, side): a player's row where `person_id::text =
 *  customParticipantId` (preset 'player'); else an arbiter's row where `user_id::text = split_part(customParticipantId, ':', 1)` (preset
 *  'arbiter', removed_at null): an arbiter's subject is the user id, a colon and a nonce (arbiter.ts mintArbiter, kept by plan 3), so the
 *  prefix is the match; when that user has more than one live arbiter row in the meeting (one per open tab until plan 3's V530 makes the
 *  pair unique) the newest wins: `order by created_at desc limit 1` (V451 line 280). null when neither. */
export async function resolveParticipant(db: AnySql, a: { meetingId: string; customParticipantId: string }): Promise<string | null>;
/** Applies one event; the result depends only on the SET of events applied, never their order or repeats (property in the tests).
 *  joined: insert the row with joined_at from the payload and, when `realtimekit_ended_sessions` already holds (meetingId,
 *  sessionId), left_at = that ended_at and left_by 'ended'; on conflict keep an existing row's joined_at / left_at (coalesce) and set
 *  source 'webhook' (a webhook upgrades a read row).
 *  left: insert with both stamps and left_by 'left'; on conflict left_at = the payload's leftAt UNLESS the row's left_by is already
 *  'left' (a peer's own leave beats its session's end; the first own leave is kept), left_by 'left', source 'webhook'.
 *  ended: upsert (meetingId, sessionId, endedAt) into realtimekit_ended_sessions (do nothing on conflict), then left_at = endedAt,
 *  left_by 'ended' on every open row WHERE meeting_id = meetingId AND (session_id = sessionId OR (session_id is null AND
 *  joined_at <= endedAt)): scoped by the meeting (the session index), and a row stored without a session is closed only when it
 *  joined before the end. An `ended` with a null sessionId closes nothing and records nothing (logged at warn).
 *  Every row written carries fixture_id / side from `held` (the receiver passes the heldMeeting answer it gated on; when omitted it
 *  is looked up here). "ignored" for `other`. */
export async function applyPresenceEvent(db: AnySql, ev: RealtimeKitEvent, receivedAt: Date, held?: { fixtureId: string; side: "home" | "away" } | null): Promise<"applied" | "ignored">;
/** The current peer of this participant in this meeting, matched by participant_id OR (participant_id null and custom_participant_id
 *  = `customParticipantId`), in the presence order. A `source='read'` row older than PRESENCE_READ_TRUST_MS at `now` (default: the
 *  wall clock) is skipped, so a fallback seat's row is a hint for one claim, never a standing fact (owner ruling R4). `source` and
 *  `receivedAt` are returned so the caller can tell a read hint from a webhook. */
export async function currentPresence(db: AnySql, a: { meetingId: string; participantId: string; customParticipantId: string; now?: Date }): Promise<{ peerId: string; sessionId: string | null; joinedAt: Date; source: "webhook" | "read"; receivedAt: Date } | null>;
/** Has this participant EVER had a presence row (any source, open or closed) in this meeting? The same matching rule as
 *  currentPresence. Plan 3's arbiter refusal calls this, so the match rule ships once. */
export async function everJoined(db: AnySql, a: { meetingId: string; participantId: string; customParticipantId: string }): Promise<boolean>;
/** A row from the seat's own vendor read (plan 2): source 'read'; an existing row (of either source) is never overwritten. */
export async function recordPresenceFromRead(db: AnySql, a: { meetingId: string; participantId: string; customParticipantId: string; peerId: string; sessionId: string | null; joinedAt: Date }, receivedAt: Date): Promise<void>;
/** Every peer of a participant in a meeting, in the presence order (oldest join first). */
export async function peersOf(db: AnySql, a: { meetingId: string; participantId: string; customParticipantId: string }): Promise<Pick<PresenceRow, "peerId" | "sessionId" | "joinedAt" | "leftAt" | "leftBy" | "source">[]>;
export type ShadowScope = { since: Date; fixtureIds?: readonly string[] };
export type ShadowReport = {
  /** player participants in scope whose seat verified the camera (`last_publisher_seen_at >= since`) */
  verified: number;
  /** of those, the ones a `source='webhook'` row was OPEN for at the stamp: received_at <= stamp + SHADOW_ARRIVAL_TOLERANCE_MS
   *  and (left_at is null or left_at > stamp) */
  covered: number;
  missing: { fixtureId: string; side: "home" | "away"; participantId: string; seenAt: Date }[];
  /** presence rows in scope with left_at null at report time. Read at a quiescent point (every meeting in scope ended), any is a
   *  phantom: the dangerous direction, a peer that looks current after it went */
  open: { meetingId: string; peerId: string; participantId: string | null; source: "webhook" | "read"; receivedAt: Date }[];
  /** rows in scope closed only by meeting.ended (left_by 'ended'): each is a participantLeft that never arrived, or a reload's old
   *  peer the vendor never reported leaving. Measured and printed, not gated (spec §3: the vendor's leave-on-reload is unmeasured) */
  closedByEnded: number;
};
/** Shadow mode's TWO-SIDED comparison over `scope`: player participants whose seat read found the camera on
 *  (`fixture_video_participants.last_publisher_seen_at`, V451 line 279, stamped by preflight.ts line ~530 with the seat's `now` at the
 *  claim that verified the camera) against the webhook rows, and the rows that are still open. Scope: `since` (seats by
 *  last_publisher_seen_at, presence rows by received_at), and when `fixtureIds` is given only those fixtures (seats by
 *  `fixture_video_participants.fixture_id`, presence rows by their own `fixture_id`) — a test or a run never reads another suite's
 *  seats on a shared DB. */
export async function presenceShadowReport(db: AnySql, scope: ShadowScope): Promise<ShadowReport>;
```

- [ ] **Step 1: Write the failing tests**

Seed with `apps/web/src/server/usecases/__tests__/_external-play-seed.ts` (the external-play suites' one seed, which already inserts `fixture_video_participants` rows with their camera-report columns); the tests need only a `fixture_video_meetings` row (fixture, side, meeting_id) and a `fixture_video_participants` row (person_id, participant_id, preset 'player'). Its helpers: `seedOnlineChessFixture` for the board, then `putVideoMeeting({ fixtureId, orgId, side })` (returns the meeting id) and `putVideoParticipant({ fixtureId, side, personId, preset?, participantId? }, { removedAt? })`. Neither helper writes `user_id` (the arbiter case) or `last_publisher_seen_at` (the shadow report): set each with a one-column `update fixture_video_participants … where fixture_id = … and side = … and participant_id = …` after the insert.

```ts
describe("currentPeerOf (pure)", () => {
  it("empty case: no rows is null", () => expect(currentPeerOf([])).toBeNull());
  it("property: the answer is the latest-joined row with left_at null (ties: the later row in the input), or null when every joined row has left (fast-check, >= 200 cases, with duplicate joinedAt values forced into >= 25% of cases)", () => { /* generate rows; compute expected by filtering and a stable max; assert; report numRuns and the count of cases that HAD a tie, and fail if that count is 0 */ });
});
describe.skipIf(!DB)("applyPresenceEvent", () => {
  it("joined: a row with participant_id resolved from the player's person id, stamped with the meeting's fixture_id and side", async () => { /* apply joined for meeting M custom = person id; row.participant_id === the seeded participant_id; source 'webhook'; fixture_id/side === the seed's */ });
  it("joined for a custom id nobody has on file: stored with a null participant and logged, never dropped", async () => { /* spy on log.warn; row exists; participant_id null */ });
  it("joined for an arbiter's subject `<userId>:<nonce>` resolves to that organizer's live arbiter row in the meeting (prefix match); a removed row does not match", async () => {});
  it("left before joined: one row with both stamps; the later joined keeps left_at", async () => { /* apply left (joinedAt, leftAt) then joined; row.left_at unchanged, left_by 'left' */ });
  it("joined AFTER meeting.ended (a 5xx retried late): stored closed at the session's end, left_by 'ended'", async () => { /* apply ended(session S, endedAt E) then joined(S); row.left_at === E; currentPresence is null */ });
  it("ended: closes every open row of THAT meeting's session and no other; a null-session row of that meeting closes only if it joined before the end", async () => {
    /* meeting M sessions A and B, one open row each; a second meeting M2 that reuses the session id A (ids are vendor strings: the
       update must be keyed by the meeting too); a null-session row in M joined before E and one joined after E. ended(M, A, E):
       M/A closed at E with left_by 'ended'; M/B open; M2/A open; the null-session row joined before E closed, the one after E open.
       Count rows checked: 5 */
  });
  it("other: ignored and nothing written", async () => { /* count rows before/after equal */ });
  it("property: the rows depend only on the SET of a stay's events, never their order or repeats (fast-check, >= 50 cases, numRuns reported)", async () => {
    /* per case: a fresh meeting; a stay of 1-2 peers in one session, each with joined and optionally left, and optionally the session's
       ended; shuffle the events and duplicate some (fc.shuffledSubarray + repeats); apply all; expected per peer, derived from the
       event SET (never from applyPresenceEvent): joined_at = its joined payload; left_at = its left payload's leftAt if a left is in
       the set, else endedAt if ended is in the set, else null; left_by likewise 'left' / 'ended' / null. Report the number of cases
       and of cases whose applied order differed from the canonical one; both > 0 */
  });
});
describe.skipIf(!DB)("currentPresence / everJoined / peersOf / recordPresenceFromRead", () => {
  it("currentPresence: the latest live peer; matched by participant_id, and by custom id when the row has none", async () => { /* two joins, second current; null participant row still found via custom id */ });
  it("currentPresence after a reload: two open rows of one participant with EQUAL joined_at (the old fixture bug) — the later received_at wins, and with equal received_at the higher seq wins", async () => { /* insert both through applyPresenceEvent at the same receivedAt; expect the second applied */ });
  it("currentPresence: null once every peer has left", async () => {});
  it("a read row is current for PRESENCE_READ_TRUST_MS and then is not (owner ruling R4)", async () => {
    /* recordPresenceFromRead at receivedAt R; currentPresence with now = R + PRESENCE_READ_TRUST_MS - 1 → that peer, source 'read';
       now = R + PRESENCE_READ_TRUST_MS → null; then a webhook joined for the SAME peer → source 'webhook', current at any later now;
       then the webhook left → null */
  });
  it("recordPresenceFromRead never overwrites an existing row and writes source 'read' otherwise", async () => {});
  it("everJoined: false with no row; true for an open row, a closed row, a read row, and a null-participant row matched by custom id (4 trues counted)", async () => {});
  it("peersOf lists every peer in the presence order", async () => { /* count 3 */ });
});
describe.skipIf(!DB)("presenceShadowReport", () => {
  // Scoped to this file's seeded fixture ids, so other suites' seats on the shared DB never enter the counts.
  it("covered needs a webhook row OPEN at the stamp; an old peer that already left does not cover a later seat", async () => {
    /* one seeded player participant per case, each with last_publisher_seen_at S:
       P1: a webhook row received at S - 1 s, open → covered.
       P2: a webhook row received before S, left_at S - 5 s (an OLD peer) → missing.
       P3: a webhook row received at S + SHADOW_ARRIVAL_TOLERANCE_MS + 1 s → missing.
       P4: a webhook row received at S + 1 s, open → covered.
       P5: only a source 'read' row, open at S → missing.
       expected, typed from this table: verified 5, covered 2, missing = [P2, P3, P5] as a set */
  });
  it("open lists every row in scope with left_at null, and closedByEnded counts rows closed by meeting.ended only", async () => {});
  it("scope: a seat and a presence row of a fixture outside fixtureIds are not counted; `since` excludes an older stamp", async () => {});
  it("empty scope (no seats, no rows): verified 0 — the script's --strict treats verified 0 as a FAILURE (Task 9), never a pass", async () => {});
});
```

- [ ] **Step 2: Run to verify they fail** (`cd apps/web && npx vitest run src/server/external-play/video/__tests__/presence.test.ts`).

- [ ] **Step 3: Implement `presence.ts`.** The joined upsert:

```sql
insert into fixture_video_presence (meeting_id, peer_id, participant_id, custom_participant_id, session_id, joined_at, left_at, source, received_at)
values (…, 'webhook', …)
on conflict (meeting_id, peer_id) do update
  set joined_at = coalesce(fixture_video_presence.joined_at, excluded.joined_at),
      participant_id = coalesce(fixture_video_presence.participant_id, excluded.participant_id),
      session_id = coalesce(fixture_video_presence.session_id, excluded.session_id)
```

The joined insert's `left_at` / `left_by` come from `(select ended_at from realtimekit_ended_sessions where meeting_id = … and session_id = …)` (null when the session has no recorded end), and its conflict arm also sets `source = 'webhook'`. The left upsert sets `left_at = case when fixture_video_presence.left_by = 'left' then fixture_video_presence.left_at else excluded.left_at end`, `left_by = 'left'`, `source = 'webhook'`, and the same coalesces. The ended statement is ONE `with` statement: insert into `realtimekit_ended_sessions … on conflict do nothing`, then the scoped update. Every reader orders `order by joined_at, received_at, seq` and hands the rows to `currentPeerOf`; `currentPresence` filters `source = 'webhook' or received_at > now - PRESENCE_READ_TRUST_MS` before that. The shadow report is one statement per side of the comparison (seats: `fixture_video_participants` where `preset = 'player' and last_publisher_seen_at >= since` [and `fixture_id = any(fixtureIds)`], left-joined to webhook rows of that participant open at the stamp; open: presence rows in scope with `left_at is null`; closedByEnded: rows in scope with `left_by = 'ended'`). `resolveParticipant` joins `fixture_video_meetings m` on `meeting_id` and `fixture_video_participants p` on `(p.fixture_id, p.side) = (m.fixture_id, m.side)` (the per-player source guard requires `side` in every reference to these tables). The video source guard (`apps/web/src/server/external-play/__tests__/_video-source-scan.ts` and its rule test) scans production sources: run it after writing the SQL (`cd apps/web && npx vitest run src/server/external-play/__tests__/`) and fix any reference it classifies as unkeyed.

- [ ] **Step 4: Run to verify they pass**, then run the source guards in `apps/web/src/server/external-play/__tests__/`.

- [ ] **Step 5: Mutate each new guard once** (one at a time, restore after each): remove the `custom_participant_id` arm from `currentPresence`'s match → the "found via custom id" test fails; drop `seq` from the order → the equal-received_at reload case fails; drop the read-row trust filter → the R4 case fails; drop the ended-sessions lookup from the joined insert → "joined AFTER meeting.ended" fails; drop `meeting_id` from the ended update → the M2 row in the ended case fails; make the left upsert coalesce (first stamp wins) → the order property fails; drop the `left_at > stamp` arm of the report's coverage → P2 fails.

- [ ] **Step 6: Commit** — `feat(video): presence table writer and readers`.

---

### Task 6: The receiver usecase

**Files:**
- Create: `apps/web/src/server/external-play/video/webhook.ts`
- Test: `apps/web/src/server/external-play/video/__tests__/webhook.test.ts` (DB suite)

**Interfaces:**

```ts
export type WebhookReceipt =
  | { status: 200; outcome: "applied" | "duplicate" | "ignored" }
  | { status: 400; reason: "unparseable" }
  | { status: 401; reason: "no_signature" | "no_uuid" | "signature" }
  | { status: 503; reason: "key_unavailable" };  // no fresh key could be fetched for this request (floor or fetch failure): retry
export type WebhookDeps = {
  publicKey?: (opts: { force?: boolean }) => Promise<{ key: string; fetched: boolean }>; // default webhookPublicKey
  apply?: typeof applyPresenceEvent;                                                     // test seam for a storage failure
  now?: Date;
};
/** Verify (refetching the key once on failure: 401 only when a key fetched for THIS request still refuses, 503 when none could be
 *  fetched), parse, then in ONE transaction: `heldMeeting` (not ours → 200 ignored, NOTHING written, not even the delivery row),
 *  record the delivery id, apply the event. A storage failure throws (the route answers 500 so the vendor retries); a duplicate
 *  `rtk-uuid` is a 200 that applies nothing. An `other` event is 200 ignored and writes nothing. */
export async function receiveRealtimeKitWebhook(a: { rawBody: string; signature: string | null; uuid: string | null }, deps?: WebhookDeps): Promise<WebhookReceipt>;
```

- [ ] **Step 1: Write the failing tests**

```ts
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); const pem = …; const signed = (b: string) => …;
const publicKey = async () => ({ key: pem, fetched: true });
// Seed one held meeting (putVideoMeeting, Task 5's helpers); `joined` names it unless told otherwise.
const joined = (uuid = randomUUID(), meetingId = seededMeetingId) => ({ rawBody: JSON.stringify(<joined body for meetingId>), signature: signed(rawBody), uuid });

it("applies a signed joined event and records the delivery", async () => { expect(await receive(joined(), { publicKey })).toEqual({ status: 200, outcome: "applied" }); /* presence row exists; deliveries row with that uuid */ });
it("a repeat of the same rtk-uuid is a 200 duplicate and changes no row", async () => { const w = joined(); await receive(w); const before = await rows(); expect(await receive(w)).toEqual({ status: 200, outcome: "duplicate" }); expect(await rows()).toEqual(before); });
it("no signature, no uuid, a bad signature: 401 and nothing written", async () => { /* three calls; deliveries count unchanged */ });
it("a rotated key: the first verification fails, one forced refetch returns the new key, and the event applies", async () => { /* publicKey stub: first call (force undefined) returns { key: oldPem, fetched: false }, second call (force true) returns { key: pem, fetched: true }; expect applied and the stub called exactly twice */ });
it("still failing after a FRESH forced refetch is 401", async () => { /* stub: cached oldPem, then { key: oldPem, fetched: true }; expect 401 signature; called twice; nothing written */ });
it("a forced refetch the floor suppressed (fetched: false) is 503 key_unavailable, nothing written, and the same delivery retried after the floor applies", async () => {
  /* stub: { key: oldPem, fetched: false } twice → 503; deliveries has no row for the uuid; then the stub serves { key: pem, fetched: true } on force → the SAME uuid applies (200 applied) */
});
it("a signed event for a meeting we do not hold is 200 ignored and writes NOTHING: no delivery row, no presence row", async () => {
  /* joined(uuid, "m-foreign-<random>"); expect { status: 200, outcome: "ignored" }; deliveries row for uuid: 0; presence rows for that meeting: 0 */
});
it("a meeting known only through its presence rows (the parked room ended and its parking row deleted) still takes meeting.ended", async () => {
  /* seed a meeting, apply a joined; delete its fixture_video_meetings row (no video_rooms_to_end row); receive a signed ended → applied; the row is closed, left_by 'ended' */
});
it("an unparseable body is 400 and nothing written", async () => { /* rawBody "not json" signed; and JSON `{"x":1}` signed */ });
it("an event the receiver does not apply is 200 ignored and writes nothing, not even its delivery row (we subscribe to three events only; no third party may make the route insert)", async () => { /* meeting.started; deliveries row for the uuid: 0 */ });
it("a storage failure throws and leaves NO delivery row, so the vendor's retry with the same uuid applies", async () => {
  const w = joined();
  await expect(receive(w, { publicKey, apply: async () => { throw new Error("db down"); } })).rejects.toThrow("db down");
  /* deliveries has no row for w.uuid */
  expect(await receive(w, { publicKey })).toEqual({ status: 200, outcome: "applied" });
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** An `other` event answers 200 ignored before any statement. Then `sql.begin(async (tx) => { const held = await heldMeeting(tx, ev.meetingId); if (held === null) return "ignored-foreign"; const [row] = await tx\`insert into realtimekit_webhook_deliveries (rtk_uuid, event) values (${uuid}, ${ev.event}) on conflict (rtk_uuid) do nothing returning rtk_uuid\`; if (!row) return "duplicate"; return (deps.apply ?? applyPresenceEvent)(tx, ev, now, held) })`, with `ignored-foreign` mapped to `{ status: 200, outcome: "ignored" }` and a `log.info` line `realtimekit-webhook: foreign meeting` (the meeting id only). The forced refetch on a failed verification goes through `webhookPublicKey({ force: true })`, whose floor makes a storm of forged signatures cost one outbound fetch a minute at most; when it answers `fetched: false` (floored, or a failed fetch served from the cache) the receipt is 503, and a `webhookPublicKey` that throws (no key ever fetched) is also 503, never a 500.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutate each new guard once** (restore after each): make the dedupe insert `on conflict do update set event = excluded.event returning rtk_uuid` → the duplicate test fails; answer 401 instead of 503 when `fetched` is false → the floor test fails; skip `heldMeeting` → the foreign-meeting test fails; drop the presence-row arm of `heldMeeting` → the parked-and-deleted ended test fails.

- [ ] **Step 6: Commit** — `feat(video): realtimekit webhook receiver`.

---

### Task 7: The route

**Files:**
- Create: `apps/web/src/app/api/webhooks/realtimekit/route.ts`
- Test: `apps/web/src/app/api/webhooks/realtimekit/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `receiveRealtimeKitWebhook` (Task 6), `webhookPublicKey` / `forgetWebhookKey` (Task 4).
- Produces: `POST /api/webhooks/realtimekit` → `200 {"received":true,"outcome":…}`, `400 {"error":"Unreadable body"}`, `401 {"error":"Invalid signature"}`, `503 {"error":"Key unavailable"}` with `Retry-After: 60` (the key floor), `500 {"error":"Processing failed"}`. Public: no session and no CSRF token (`apps/web/src/proxy.ts` line 178 already exempts `/api/webhooks/` from its Origin check); it carries no cron secret header, and its source must not contain the cron secret header's literal name even in a comment, or the cron drift test counts it as scheduled.

- [ ] **Step 1: Write the failing tests** (a DB suite: `describe.skipIf(!process.env.DATABASE_URL)`; seed ONE held meeting with Task 5's helpers — `seedOnlineChessFixture` then `putVideoMeeting` — since an event for a meeting we do not hold is ignored; no participant row is needed, a null participant row is allowed)

```ts
// a tiny http server serving GET /.well-known/webhooks.json with the test key; process.env.REALTIMEKIT_BASE_URL = its url (webhookPublicKey reads it at call time); forgetWebhookKey() in beforeEach
it("200 for a signed joined event, with the outcome", async () => { const res = await POST(new Request("http://x/api/webhooks/realtimekit", { method: "POST", headers: { "rtk-signature": sig, "rtk-uuid": uuid, "content-type": "application/json" }, body })); expect(res.status).toBe(200); expect(await res.json()).toEqual({ received: true, outcome: "applied" }); });
it("401 without headers", async () => {});
it("400 for a body that is not an event", async () => {});
it("200 ignored for a signed event naming a meeting we do not hold, and no row of any kind", async () => {});
it("503 with Retry-After when the receiver answers key_unavailable", async () => { /* the key server answers 500 with no key cached: webhookPublicKey throws → 503 */ });
it("500 when the receiver throws, so the vendor retries", async () => { vi.spyOn(webhookModule, "receiveRealtimeKitWebhook").mockRejectedValueOnce(new Error("boom")); /* expect 500 */ });
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement the route** on the Stripe route's shape: `const rawBody = await req.text()`, headers read, `try { receipt } catch { log.error; 500 }`, map `receipt.status` (503 adds `Retry-After: 60`, the key floor's length).

- [ ] **Step 4: Run to verify they pass.** Then run `cd apps/cron-worker && npx vitest run test/drift.test.ts` to prove the new route is not cron-shaped (it must stay green with no schedule row).

- [ ] **Step 5: Commit** — `feat(api): POST /api/webhooks/realtimekit`.

---

### Task 8: Registration script

**Files:**
- Create: `scripts/realtimekit-webhook-register.ts`
- Modify: `package.json` (root): `"realtimekit:webhook-register": "node --env-file-if-exists=apps/web/.env.local --experimental-strip-types scripts/realtimekit-webhook-register.ts"`
- Test: `apps/web/src/server/__tests__/realtimekit-webhook-register.test.ts`, importing the script's exported pure parts by relative path (`../../../../../scripts/realtimekit-webhook-register.ts`), so it runs under the apps/web vitest workspace in CI. Precedent: `apps/web/src/server/usecases/__tests__/end-shared-meetings-script.test.ts` imports the root RealtimeKit script `scripts/chess-end-shared-meetings.ts` the same way. (`scripts/__tests__` DOES now have a CI runner, the smoke-db job's "Repo-root scripts tests (real Postgres)" step in `.github/workflows/ci.yml`; the apps/web placement is kept because it was the plan's choice and has the precedent, not because the other has no runner.)

**Interfaces:**

```ts
export const PRESENCE_WEBHOOK_EVENTS = ["meeting.participantJoined", "meeting.participantLeft", "meeting.ended"] as const;
export type VendorWebhook = { id: string; name: string; url: string; events: string[]; enabled: boolean };
/** Pure: what to send. An existing webhook of the same name is PATCHed to the wanted url/events/enabled; none is POSTed. */
export function registrationPlan(existing: readonly VendorWebhook[], want: { name: string; url: string }): { method: "POST" | "PATCH"; path: string; body: { name: string; url: string; events: string[]; enabled: true } };
/** The CLI body, exported for the test: --url <https://…/api/webhooks/realtimekit> [--name seazn-presence] [--dry-run]. Reads
 *  CLOUDFLARE_ACCOUNT_ID, REALTIMEKIT_API_TOKEN, REALTIMEKIT_APP_ID (and REALTIMEKIT_BASE_URL) from `deps.env`. Prints the plan and the
 *  vendor's answer; never the token. Returns the exit code. */
export async function run(argv: readonly string[], deps: { fetch: typeof fetch; env: NodeJS.ProcessEnv; out?: (line: string) => void }): Promise<number>;
// The file's `main` runs ONLY when the script is the entry, `if (isMainModule(import.meta.url))` with `isMainModule` from
// `./lib/main-module.ts` (the shared check; comparing argv[1] with import.meta.url fails open through a symlink, that file's header),
// as scripts/chess-end-shared-meetings.ts does; never on import: the test imports this module under vitest, whose argv has no --url.
```

- [ ] **Step 1: Write the failing tests** for `registrationPlan` (POST when absent; PATCH `/webhooks/{id}` when a webhook of that name exists; events exactly `PRESENCE_WEBHOOK_EVENTS`) and for `run` (`--dry-run` makes no request, proven with `run(["--url", u, "--dry-run"], { fetch: throwing, env })` whose fetch throws if called and whose exit code is 0; importing the module runs nothing: the import itself, under vitest's argv, neither fetches nor exits).

- [ ] **Step 2: Run to verify they fail** (`cd apps/web && DATABASE_URL= npx vitest run src/server/__tests__/realtimekit-webhook-register.test.ts`).

- [ ] **Step 3: Implement**, self-contained (relative or bare imports only, never `@/`: a root script runs under nodenext and cannot resolve the alias, the reason `scripts/stripe-connect-fixture.ts`'s header gives). Endpoints: `GET`/`POST /accounts/{account}/realtime/kit/{app}/webhooks`, `PATCH …/webhooks/{id}`, `Authorization: Bearer`.

- [ ] **Step 4: Run to verify they pass.** Also `npm run lint:scripts` and `npm run typecheck:scripts`.

- [ ] **Step 5: Commit** — `feat(scripts): register the realtimekit presence webhook`.

---

### Task 9: Shadow report script and the in-process comparison

**Files:**
- Create: `scripts/presence-shadow-report.ts`
- Create: `apps/web/src/server/usecases/external-play/__tests__/presence-shadow.test.ts` (DB suite, fixture vendor in process)

**Interfaces:**
- `scripts/presence-shadow-report.ts`: `--since <iso>` (staging starts counting at the webhook's registration time, so seats from before it never read as missing) or `--since-hours <n>` (default 24; `--since` wins), `--fixture <uuid>` (repeatable; the scope's `fixtureIds`), `--strict` (exit 1 when `verified === 0` — an empty run is a failure, never a pass — or `missing.length > 0` or `open.length > 0`); prints the report as JSON with `closedByEnded` always shown. `--strict` is meant for a QUIESCENT scope (every meeting in it ended); run mid-round, `open` lists the live peers and the operator reads it rather than gating on it. A root script cannot import from `apps/web/src` (the `@/` alias does not resolve under nodenext; `scripts/stripe-connect-fixture.ts`'s header), so the script carries its own copy of the report's SQL, exported as `shadowReportSql(scope)` (the same `ShadowScope` shape), and the DB test below runs the script's query and `presenceShadowReport` against one seed and asserts they agree, so the two cannot drift unnoticed. Because that test imports the script, its `main` is guarded by `isMainModule(import.meta.url)` exactly as Task 8's is.

- [ ] **Step 1: Write the failing test**

```ts
// Start the fixture with in-process delivery straight to the receiver. A non-200 receipt REJECTS, so the fixture records it as
// "failed" (Task 1: the fixture catches every rejection); a storage failure is a rejection too, never an unhandled one.
const fx = await startRealtimeKitFixtureServer(0, { webhooks: async (w) => {
  const r = await receiveRealtimeKitWebhook({ rawBody: w.body, signature: w.signature, uuid: w.uuid }, { publicKey: async () => ({ key: fx.publicKeyPem, fetched: true }) });
  if (r.status !== 200) throw new Error(`receiver answered ${r.status}`);
} });
// Every report is SCOPED to this file's seeded fixture ids: presenceShadowReport(sql, { since: T0, fixtureIds: [board.fixtureId] }).
// Other files in the same CI shard seat players on the same DB with no webhooks; an unscoped report would count them as missing.
// CLOCK: seatPlayer runs on the WALL clock here (no deps.now). The seat stamps last_publisher_seen_at with its own now while the
// fixture stamps joins with the wall clock (fixture `iso()`); a virtual clock such as _external-play-line.ts's SCENE_T0 (two minutes
// in the past) would stamp seats before the real joins and read as missing with webhooks working. The pacing below therefore WAITS
// the real cameraEvidenceDelayMs(k) between claims (a few seconds per player), rather than passing virtual times.
// Env: `vi.stubEnv` of each REALTIMEKIT_FIXTURE_ENV key and `REALTIMEKIT_BASE_URL = fx.url`, exactly as
// apps/web/src/server/external-play/__tests__/realtimekit-fixture-contract.test.ts lines 50-54 do (its beforeEach: reset, the env loop,
// then the base; the one precedent that points the seat at the fixture server). Seed: `seedBoard()` from
// apps/web/src/server/usecases/__tests__/_external-play-line.ts (an opened Required round with two players) and bucket funding on the key
// `currentBudgetKey()` returns after the stubs: `setBucket(key, tokens, asOf)` from that same file, or `fund(key, tokens)` (setBucket
// stamped an hour ahead, so nothing refills) from _external-play-line-route.ts; NOT `stubBucket()`, which points the base at a
// non-resolving host, and NOT `_external-play-line-route.ts`'s `world()`, which is bound to the in-memory fake vendor.
it("after two players are seated by the seat's own vendor reads, the presence table names both, and the shadow report has nothing missing", async () => {
  /* for each player call seatPlayer (apps/web/src/server/usecases/external-play/preflight.ts) on the room's own schedule (camera reads
     spaced by `cameraEvidenceDelayMs(k)` from @/components/public-site/match-room/room-snapshot, as external-play-line-cost.test.ts's
     `readOffsetMs` paces its claims; a `queued` answer's own `line` wire when the line holds one) until the answer is seated, calling fx.setLivePublisher(pid, true)
     once the participant exists;
     await fx.webhooksSettled() before every read of what a delivery wrote (delivery is fire-and-forget at the fixture);
     expect currentPresence(sql, { meetingId, participantId, customParticipantId: personId }) peerId === fx.currentPeer(pid) for both;
     every uuid in fx.webhooks has fx.webhookOutcomes "delivered" (count reported, > 0);
     const r = await presenceShadowReport(sql, scope); expect(r.verified).toBe(2); expect(r.covered).toBe(2); expect(r.missing).toEqual([]);
     r.open has exactly the two live peers (the meetings are still live: open is read, not gated, mid-round) */
});
it("a reload: the second peer is current in the table exactly as at the fixture", async () => {
  /* one seated player; fx.setLivePublisher(pid, true) again (a new peer under the same row, Task 1); await fx.webhooksSettled();
     currentPresence(...).peerId === fx.currentPeer(pid), and peersOf lists both peers */
});
it("a leave: the table drops the peer exactly when the fixture does (the phantom direction)", async () => {
  /* one seated player; fx.setLivePublisher(pid, false); await fx.webhooksSettled(); fx.currentPeer(pid) is null AND
     currentPresence(...) is null; once every meeting in scope has ended (kick-all at the fixture), r.open is [] and every closed
     row's left_by is 'left' (closedByEnded 0: the fixture emits each leave before the end) */
});
it("with webhooks down the report shows both missing (the gate fails loudly, never vacuously)", async () => { fx.setWebhooksDown(true); /* same flow; r.verified === 2; r.covered === 0; r.missing.length === 2 */ });
it("the script's query agrees with the usecase on the same seed and scope", async () => { /* import the script's exported shadowReportSql and compare the whole report, field by field (verified, covered, missing, open, closedByEnded) */ });
it("the script's --strict: exit 0 on the green seed, 1 with webhooks down, 1 on an EMPTY scope (a fixture id with no seats: verified 0)", async () => { /* call the script's exported run(argv, deps) as Task 8's test does; three exit codes */ });
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement the script**, with an exported `run(argv, deps: { sql; out? }): Promise<number>` beside `shadowReportSql`, so the exit codes are tested without a process.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Mutate once:** make `--strict` ignore `verified === 0`; the empty-scope exit-code case must fail. Restore.

- [ ] **Step 6: Commit** — `feat: presence shadow report`.

---

### Task 10: The walkthrough delivers webhooks over HTTP

**Files:**
- Modify: `apps/web/e2e/walkthrough/chess-external-play.spec.ts`

- [ ] **Step 1: Start the fixture with HTTP delivery** in the Task 17 describe's setup (`test.describe("online chess on our page — the venue, end to end (Task 17)")`, its `test.beforeAll` at line 351, which today calls `startRealtimeKitFixtureServer()` at line 353): `test.beforeAll(async ({}, testInfo) => { …; video = await startRealtimeKitFixtureServer(REALTIMEKIT_FIXTURE_PORT, { webhooks: httpWebhookDeliver(`${testInfo.project.use.baseURL}/api/webhooks/realtimekit`) }); })`. The spec has no `BASE` constant of its own; the project's `baseURL` is `playwright.config.ts`'s `BASE` (`PLAYWRIGHT_BASE ?? "http://localhost:3000"`), which the spec already reads as `test.info().project.use.baseURL` at line 364.

- [ ] **Step 2: Add two expectations** inside the existing flow: after the first player is seated (the test "board 1 seats only on the SERVER's word …" at line 617, right after its `checkedInAt(...)` "seated on the meeting's word" assertion at line 650 and before the camera is taken away at line 657), `withDb` reads `select count(*)::int from fixture_video_presence where participant_id = <that player's participant id> and left_at is null` and expects 1 (poll up to `POLL_BUDGET_MS`). That poll is one more wait inside the board-1 test, so its budget moves from `test.setTimeout(budget(10))` (line 618) to `budget(11)`: the derived budget counts it (AGENTS.md class 20), never a flat bump.

And a new `test("a forged webhook is refused and writes nothing")`, which goes through VERIFICATION, not just the missing-header branch: it makes its own key pair (`generateKeyPairSync`, never the fixture's), builds a joined body naming board 1's held meeting with a fresh `rtk-uuid` U, signs it with the foreign key, and POSTs it with both headers via `request.post`. The server verifies against the fixture's key, fails, forces one refetch from the fixture's origin (a fixture base has no floor, Task 4: the refetch really fetches), fails again → expects 401. Then `await video.webhooksSettled()` (no fixture delivery still in flight) and `withDb` asserts `select count(*)::int from realtimekit_webhook_deliveries where rtk_uuid = U` is 0 — a per-uuid check, never a global count that an in-flight fixture delivery could move. Any assertion in this spec or the line-cost test that counts `fixture.calls` is unaffected: the key document's GET is never pushed to `calls` (Task 1).

- [ ] **Step 3: Run the spec** against a local server started per `docs/runbooks/e2e-local.md` (the server needs no new variable: the key is read from the fixture's origin): `cd apps/web && PLAYWRIGHT_BASE=http://localhost:3100 npx playwright test --project=walkthrough walkthrough/chess-external-play.spec.ts`. Expected: the whole file green (never a `-g` slice, AGENTS.md rule 21).

- [ ] **Step 4: Commit** — `test(e2e): walkthrough proves presence webhooks over HTTP`.

---

### Task 10a: Smoke for the public route

**Files:**
- Create: `scripts/smoke/suites/realtimekitWebhookSmoke.ts` (shaped like `scripts/smoke/suites/resendWebhookSmoke.ts`: `BASE` and `check` from `../harness.ts`)
- Modify: `scripts/smoke/main.ts` (import beside `resendWebhookSmoke`, line 110; `await suite("realtimekitWebhookSmoke", () => realtimekitWebhookSmoke())` beside line 1250)

RULES.md's four test types owe a smoke for a new public, signed route. The smoke server runs in production mode with NO `REALTIMEKIT_BASE_URL` (ci.yml sets none), so its key is Cloudflare's and smoke cannot sign a delivery the server accepts: the accepted path (signed → 200 and a row; a repeated `rtk-uuid` → 200 `duplicate`) is proven by Task 7's route suite and over HTTP by Task 10's walkthrough. The smoke proves the door refuses, against the real production build:

- [ ] **Step 1: Write the suite**, counted checks:
  1. no `rtk-signature` → 401;
  2. a signature but no `rtk-uuid` → 401;
  3. a body signed with a key the smoke makes for itself, naming a random meeting id, with a fresh `rtk-uuid` U → 401 when the server could fetch Cloudflare's key, 503 when it could not (CI's network): `check` accepts exactly {401, 503}, and a 200 or a 500 fails it;
  4. after 3, the smoke's DB helper reads `select count(*)::int from realtimekit_webhook_deliveries where rtk_uuid = U` = 0 and the same for `fixture_video_presence where meeting_id = <the random id>`.
- [ ] **Step 2: Mutate once:** run the suite against a server built with the route's signature check short-circuited to "verified" (a local build, deleted after); check 3 or 4 must fail. Restore and rebuild. (One build at a time, `pgrep` first.)
- [ ] **Step 3: Run the one suite** against a local production server as `docs/runbooks/e2e-local.md` starts it, never the whole smoke.
- [ ] **Step 4: Commit** — `test(smoke): realtimekit webhook route refuses unsigned and forged deliveries`.

---

### Task 10b: Retention

**Files:**
- Modify: `apps/web/src/server/external-play/video/presence.ts` (add `prunePresence`)
- Modify: `apps/web/src/server/usecases/external-play/sweep.ts` (one call in `runPass`, line 1463; read `apps/web/src/server/MODULARIZATION.md` first — the file is 1,504 lines)
- Test: `apps/web/src/server/external-play/video/__tests__/presence.test.ts` (the counted cases) and the existing `apps/web/src/server/usecases/__tests__/external-play-sweep.test.ts` (one wiring case)

**Interfaces:**

```ts
/** Dedupe needs only the vendor's retry horizon (unmeasured; spec §3): a week is generous. */
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A presence row outlives any stay, round and shadow-report window (`--since` is at most days). */
export const PRESENCE_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Deletes delivery rows received before now - WEBHOOK_DELIVERY_RETENTION_MS, and presence and ended-session rows received before
 *  now - PRESENCE_RETENTION_MS; one statement per table on its received_at index. Returns the counts. */
export async function prunePresence(db: AnySql, now: Date): Promise<{ deliveries: number; presence: number; endedSessions: number }>;
```

- [ ] **Step 1: Write the failing tests:** seed, per table, rows on BOTH sides of its cutoff (one a second older than it, one a second younger); `prunePresence(sql, now)` returns `{ deliveries: 1, presence: 1, endedSessions: 1 }` for this file's rows (scope the seeded rows by unique ids and assert on THOSE ids being gone or kept, since other suites write the same tables); every younger row is still there (3 kept, counted); a second call returns zeros for this file's ids (the second-call case). In the sweep suite: one pass with a seeded expired delivery row removes it.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** In `runPass`, BEFORE the parked-rooms job (which must stay LAST, its D16 fix-3 comment) and after `arbiter_revoke`: `try { const pruned = await prunePresence(sql, pass.now); log.info({ ...pruned }, "sweep: presence pruned"); } catch (err) { log.error({ err }, "sweep: presence prune failed"); }`, so a prune failure never starves the jobs around it. (Not `report.failures`: its entries are `{ job: SweepJob, fixtureId, code }`, sweep.ts line 279, and a prune has neither a job nor a fixture.) It is not a `SWEEP_JOBS` member (no vendor call, no budget), so `SWEEP_JOBS` and `NETWORK_JOBS` are unchanged. Plan 2's Task 0 split carries this call verbatim into `sweep/run.ts`.
- [ ] **Step 4: Run to verify they pass**, with `external-play-sweep.test.ts` whole.
- [ ] **Step 5: Mutate once:** swap the deliveries cutoff to `PRESENCE_RETENTION_MS`; the deliveries count case must fail. Restore.
- [ ] **Step 6: Commit** — `feat(video): prune webhook deliveries and presence past their retention`.

---

### Task 10c: The load harness delivers webhooks (`LOAD_WEBHOOKS`)

**Files:**
- Modify: `apps/web/e2e/load/chess-30-boards.load.ts` (the fixture start at line 335; the header's knob list at line 46; the report)
- Test: its unit mirror `apps/web/src/server/external-play/__tests__/line-load.test.ts` only if a pure helper is extracted; otherwise the harness's own end-of-run assertions are the test

Without this task the harness starts the fixture with no options (`startRealtimeKitFixtureServer()`, line 335), so a run "with the receiver live" delivers zero webhooks and every presence measurement — this plan's local pre-check and plan 2's final run — is taken over an empty table.

- [ ] **Step 1: Add the knob.** `const WEBHOOKS = process.env.LOAD_WEBHOOKS === "1";` and `startRealtimeKitFixtureServer(undefined, WEBHOOKS ? { webhooks: httpWebhookDeliver(\`${baseURL}/api/webhooks/realtimekit\`) } : undefined)`. Document it in the header's knob list: "LOAD_WEBHOOKS (0: the fixture emits webhooks but delivers none, the baseline; 1: delivered over HTTP to the server under test, which reads the key from the fixture's origin)".
- [ ] **Step 2: Report and assert, at the end of the run** (after the harness's existing "sweep until every meeting is ended" loop, line ~930, so every meeting in the run has ended), into the JSON report and as failures:
  - `webhooks: { emitted, delivered, failed, down }` from `video.webhooks` / `video.webhookOutcomes` (after `await video.webhooksSettled()`);
  - with `LOAD_WEBHOOKS=1`: a failure when `delivered === 0` (an inert run), and when `failed > 0`;
  - with `LOAD_WEBHOOKS=1`, through the harness's existing `monitor` postgres client, scoped to the run's fixture ids: (a) open presence rows = 0 (every meeting ended, so any open row is a phantom); (b) every `participantLeft` the fixture delivered has its row closed with `left_by = 'left'` (count checked, > 0); (c) every uuid the fixture delivered is in `realtimekit_webhook_deliveries` (count checked, > 0);
  - the shadow report's numbers for the run's fixtures (`verified`, `covered`, `missing`, `closedByEnded`), from the same SQL as `scripts/presence-shadow-report.ts` (import its exported `shadowReportSql` by relative path: it is a root script with no `@/` imports, Task 9).
- [ ] **Step 3: Prove the knob is not inert:** a short run (`LOAD_BOARDS=2`, scenario `B`) with `LOAD_WEBHOOKS=1` reports `delivered > 0` and green checks; the same run with `LOAD_WEBHOOKS=1` and the server's webhook route made to answer 401 (a local build with the verifier refusing everything, deleted after) fails on `failed > 0`. Restore and rebuild.
- [ ] **Step 4: Commit** — `test(load): chess-30-boards delivers presence webhooks behind LOAD_WEBHOOKS`.

---

### Task 11: Baseline load run (rollout step 2, operator task)

**Files:**
- Create: `docs/superpowers/plans/2026-11-05-checkin-capacity-baseline.md`

- [ ] **Step 1: Read the harness's own runbook**: the header of `apps/web/e2e/load/chess-30-boards.load.ts` (modes, env, scenarios) and `apps/web/e2e/load/line-load.ts` (what each scenario asserts: cost, order, dry). Its unit mirror `apps/web/src/server/external-play/__tests__/line-load.test.ts` names the scenario set.

- [ ] **Step 2: Run it at 200 players on current `main`** against the fixture vendor, metered, on the burst scenarios (`B`, `B-honest`, `B-slow-5`, `B-slow-10`), with the fixture started WITHOUT webhooks (today's behavior; `LOAD_WEBHOOKS` unset once Task 10c has landed); the harness is written for 30 boards, so the 200-player count is its board count raised through its own setting (`LOAD_BOARDS`, default 30: 200 players is `LOAD_BOARDS=100`), and the number used is recorded.

- [ ] **Step 2b: Prove the webhook knob is not inert (Task 10c Step 3, carried here: the harness runs on a local prod server only in this task).** On the same local server, three short runs (`LOAD_BOARDS=2`, scenario `B`), each recorded with its exit code and its report's `webhooks` block: (1) `LOAD_WEBHOOKS=0`: `delivered` is 0 and the run is green (the baseline delivers nothing); (2) `LOAD_WEBHOOKS=1`: `delivered > 0`, `failed` 0, and the webhook checks green; (3) `LOAD_WEBHOOKS=1` against a build whose webhook route answers 401 to everything (a local build with the verifier made to refuse, never committed, deleted after): the run FAILS on `failed > 0`. Then restore the source, rebuild, and confirm the restore with run (2) once more. If (2) delivers 0 or (3) passes, the knob is inert: stop and fix Task 10c before Task 12.

- [ ] **Step 3: Record** in the new file: calls per board (from the fixture's `calls` attributed by `meetingId`), time to seat p50 and p95, `lockWaitMs` p95 (the `seat-line: gate decision` log line), `seatLineBusyCount`, the run's command line and commit hash. These are the numbers plans 2 and 3 are measured against.

- [ ] **Step 4: Commit** — `docs: check-in capacity baseline`.

---

### Task 12: Staging (rollout step 0 and the end of step 3, operator checklist)

- [ ] **Step 1 (owner):** the Cloudflare zone in front of the Fly app gets a WAF skip rule for `POST /api/webhooks/realtimekit` (Browser Integrity Check and bot challenges skipped for that path and method only).
- [ ] **Step 2:** `npm run realtimekit:webhook-register -- --url https://<staging host>/api/webhooks/realtimekit` with staging's credentials in the shell. Write down the UTC time the vendor answered (the OK line's `T_reg=`, beside the vendor host, account and app ids it registered under): it is `T_reg`, step 5's `--since`. A `REFUSED` line means a webhook of that name already delivers to ANOTHER host (staging and production may share one RealtimeKit app): stop and settle which environment owns it before any `--force`.
- [ ] **Step 3:** BEFORE any join: fetch `https://api.realtime.cloudflare.com/.well-known/webhooks.json` from the staging shell and run `importWebhookPublicKey` over its `data.publicKey` through the gated case Task 4 adds: `cd apps/web && RTK_WEBHOOK_KEY_DOC="$(curl -fsS https://api.realtime.cloudflare.com/.well-known/webhooks.json)" DATABASE_URL= npx vitest run --reporter=json --outputFile=/tmp/key.json src/server/external-play/video/__tests__/webhook-signature.test.ts -t "the live key document imports"`, and read `numPassedTests` = 1 (not skipped) from the file. Under vitest because the module imports `realtimekit.ts`, which imports `server-only` (not an installed package: Next resolves it at build, vitest aliases it to `vitest.stubs/server-only.ts`) and the `@/` alias, so neither `tsx` nor a root script can load it. A failing case means the verifier needs the vendor's actual shape before anything else, and nothing proceeds.
- [ ] **Step 4 (local PRE-CHECK, not the gate; run before step 5):** the load harness repeated against a LOCAL server with the receiver live and `LOAD_WEBHOOKS=1` (Task 10c; as Task 11 otherwise: the fixture listens on 127.0.0.1 only, so no Fly app can reach its key or its reads). Its own end-of-run checks pass (delivered > 0, failed 0, open rows 0, every delivered leave closed `left_by = 'left'`), and `node --experimental-strip-types scripts/presence-shadow-report.ts --strict --since <run start> --fixture <each of the run's fixture ids>` against the local DB exits 0. This is the fixture vendor compared with our own receiver; it proves the plumbing under load, and by itself it proves nothing about the real vendor (owner ruling R7, 2026-11-17).
- [ ] **Step 5 (THE GATE for plan 2's one-read proof, spec §6.8 step 3; owner ruling R7):** a staging run against REAL Cloudflare RealtimeKit with the webhook registered (steps 1–3 done). **Pre-check, before the round (spec §6.8 step 0):** one real join on staging (any board, one player, camera on), then `select count(*) from realtimekit_webhook_deliveries where received_at >= '<T_reg>'` on staging's DB reads >= 1. Zero means the vendor's deliveries are not reaching the receiver (the zone's skip rule, the registration, or the key): stop there, since the round would measure an empty table. The staging test round: at least 2 Required boards (4 players on real devices), every player checked in and seated by today's seat path (the seat is unchanged in this plan), and during the round two probes:
  - **leave probe** (the phantom direction): one seated player closes the tab while the opponent stays; within 60 s `select left_at, left_by from fixture_video_presence where participant_id = <that participant> order by joined_at, received_at, seq` shows the last row closed with `left_by = 'left'`. A row still open after 60 s fails the gate: the real vendor's `participantLeft` did not reach us;
  - **peer-report probe** (right after the leave probe passes; spec §6.8 step 3, §6.3): read the vendor's peer report ONCE for that closed row's `peer_id` (`GET /sessions/peer-report/<peer_id>` on the app's base, the call `realtimekit.ts` makes after a match), and write down the UTC time of the read (`T_read`). Record: **peerId equality** (the report answers for the webhook's `peer_id`: a 404 or a report naming another peer means the webhook's peerId is not the id the peer report takes, and the gate fails); the report's `participant.left_at` (or that it was null at `T_read`); and the **leave -> `left_at` delay**, the report's `left_at` minus the presence row's `left_at` (the webhook's `leftAt`) when the report carries it, else `T_read` minus the row's `left_at` recorded as a LOWER bound. These numbers, with the report's `joinLatencyMs` and `noEcho` below, feed owner ruling R4 (plan 2: whether the one-read proof stays 1 call or adds the session-participants filter, design §6.3);
  - **reload probe:** one seated player reloads the page; a second row for that participant appears and is the newest by the presence order.
  After the round has finished and the sweep has ended every room (no `fixture_video_meetings` row of the round left un-ended), run from the repo root with staging's `DATABASE_URL` exported (the script has no npm alias): `node --experimental-strip-types scripts/presence-shadow-report.ts --strict --since <T_reg> --fixture <each of the round's fixture ids>`. It must exit 0: `verified >= 4` (every player; zero is a failure), `missing` empty (both directions: a webhook row was OPEN at every seat's stamp), `open` empty (no phantom once every meeting ended). Record `closedByEnded` (and its split: `endedWhileNewest`, the peer still in the room at the end, and `endedSuperseded`, a reload's old peer only the end closed; the script's `blocksProofFlag` is true when the TOTAL is non-zero, owner ruling 2026-11-17: any closed-by-end row keeps `EXTERNAL_PLAY_PRESENCE_PROOF` off until explained), `joinLatencyMs` (p50, p95, n: join -> webhook latency, against the 1.5 s first read and the 10 s fallback), `noEcho` (webhook rows whose customParticipantId did not echo back to a participant; non-zero means the echo failed for those rows), the peer-report probe's numbers and the reload probe's result in the baseline file beside Task 11's numbers. Steps 4 and 5 both green, in that order, are the gate; step 4 alone never is.
  - **Gate condition on plan 2's proof flag (owner ruling 2026-11-17; defined here, once):** a non-zero `closedByEnded` BLOCKS turning `EXTERNAL_PLAY_PRESENCE_PROOF` on, on staging or production, until every row it counts is explained (which peer, which session, and why only `meeting.ended` closed it: the vendor not reporting a reload's old peer leaving, or a lost leave) and the explanation is recorded in the baseline file beside the number. The reason: plan 2's departed-peer guard (R4) reads the peer report's `left_at` when a leave was lost, so a vendor that does not report leaves makes that counted fallback, and its cost, routine. This is separate from the step's pass rule: the step can exit 0 with the flag still blocked. It applies to every run of this step, plan 2 Task 11 Step 2's re-run included. Plan 2 (Task 11) and the design (§6.8 step 5) point at this bullet and do not restate it.

---

## Self-review notes

- Spec coverage: §6.2 (route, verification, dedupe, presence rows, ordering, answering, registration, zone, test fixture) → Tasks 1 to 8, 10a, 10b and 12; §6.8 steps 0 to 3 → Tasks 10, 10c, 11 and 12; §3 webhook facts → the Global Constraints.
- Not in this plan, by design: anything that reads the presence table to seat a player (plan 2) or to show an arbiter (plan 3).
- Type consistency: `RealtimeKitEvent` (Task 3) is what `applyPresenceEvent` (Task 5) and `receiveRealtimeKitWebhook` (Task 6) take; `FixtureWebhook` (Task 1) is what `httpWebhookDeliver` and the in-process delivery in Task 9 consume; `currentPresence` takes `customParticipantId` everywhere it is called; `ShadowScope` / `ShadowReport` (Task 5) are what the script's `shadowReportSql` (Task 9) and the harness (Task 10c) produce; `webhookPublicKey` returns `{ key, fetched }` everywhere (Tasks 4, 6, 7, 9).
- Names other plans import from this one: `currentPresence` (plan 2: its result gained `source` and `receivedAt`, and its argument an optional `now`, both additive), `recordPresenceFromRead`, `peersOf` (plan 2), `currentPeerOf` and the presence order `joined_at, received_at, seq` (plan 3's round statement), `everJoined` (plan 3's arbiter refusal, NEW), `LOAD_WEBHOOKS=1` (plan 2's final run and plan 3 Task 7 must set it), and Task 12 step 5 as the one definition of "the staging gate".

---

## Revision notes (2026-11-17, against origin/main 59c72dd361)

Every repo path, symbol, signature and line number the plan cites was re-opened in that tree. Unchanged and confirmed: `realtimekit.ts` (`CF_BASE`, `baseUrlOf`, `cfEnvelope`'s metering gate at line 228, `currentPeer`'s later-wins tie rule), the fixture server's `setLivePublisher` / `endIfEmpty` / `leave` / kick / DELETE routes / `setUnavailable` / `calls` / `currentPeer` / `participant` / `kitPath` and its 10 `route(` sites, the sealed catalog test, V451 lines 279/280, V454's `user_id`/`removed_at`, V459's `side`, `scripts/rls-exempt.ts` (no change owed: neither table has `org_id`), the cron drift test's `x-cron-secret` text scan, the Stripe route's shape, `proxy.ts`'s webhook exemption, `arbiter.ts mintArbiter`'s `${userId}:${randomUUID()}` subject, `preflight.ts`'s person-id subject and `last_publisher_seen_at` stamp, the video source guard, the load harness's scenarios / `seat-line: gate decision` / `lockWaitMs` / `seatLineBusyCount`, and TEST-STRATEGY rules 2, 3, 5. No migration after V491 touches the video tables. `realtimekit.ts` is 1,171 lines (under MODULARIZATION.md's 1,500), and none of the plan's paths is in a split folder. Exported names plans 2 and 3 consume are unchanged.

Changes:

1. **Migration number.** Global Constraints "V491 is the highest … V492 (plan 2's V493, plan 3's V494)" → "V526 … V527 (V528, V529)"; Task 2's file `V492__video_presence.sql` → `V527__video_presence.sql`; Task 5's "plan 3's V494" → "V529" (V530 since 2026-11-18). Why: main reached V526 (`V526__pricing_recut_fees_credits_stream_cap.sql`).
2. **Commit wrapper.** Global Constraints `~/.claude/tools/github-safe.sh commit …` → plain pathspec-limited `git commit` on a worktree branch. Why: the wrapper does not exist on this workstation (no `~/.claude/tools`), and no repo doc names it.
3. **Fixture `reset()` return type** (Task 1 Interfaces). Made explicit: `void` → `Promise<void>`, because the plan's own "reset() … awaits the in-flight deliveries" cannot be done synchronously. Existing un-awaited callers need no edit (no `webhooks`, no floating-promise lint). The one interface shape change in this plan; siblings that call `fx.reset()` are unaffected.
4. **Task 1 test import and `mint`.** `"<relative path …>"` → `"../../../../e2e/realtimekit-fixture-server"` (the contract test's path); `mint` now posts under `fx.kitPath`. Why: a path outside `kitPath` gets the fixture's gateway 404.
5. **Task 2 sealed list.** Named the `SEALED` constant and the two insertion points; `WITH_ORG_ID` unchanged.
6. **Task 4 line pins.** `CF_BASE` line 104, `baseUrlOf` line 107 with its `(deps: RealtimeKitDeps)` signature.
7. **Task 4 gains one env-gated case; Task 12 step 3 uses it.** Old: `npx tsx -e` under `apps/web`. New: `RTK_WEBHOOK_KEY_DOC=… npx vitest run … -t "the live key document imports"`. Why: `server-only` is not an installed package (Next resolves it at build; vitest aliases it to `apps/web/vitest.stubs/server-only.ts`), and `tsx` is not installed either, so the old command cannot load `webhook-signature.ts`. The case is `it.skipIf` with no document, so CI and normal runs skip it, and it still goes through the one normalizer.
8. **Task 5 seed helpers.** Named `seedOnlineChessFixture` / `putVideoMeeting` / `putVideoParticipant`. Recorded that neither helper writes `user_id` or `last_publisher_seen_at`, so those are set with a one-column update.
9. **Task 7.** `proxy.ts` → `apps/web/src/proxy.ts` line 178 (an Origin-check exemption). The `vi.spyOn(webhookModule, …)` snippet stands: a namespace spy on a cross-module call works here (`connect-routes.test.ts`, `competition-schedule-apply.test.ts`).
10. **Task 8 test placement rationale.** Old: "`scripts/__tests__` has no runner of its own". New: it does (ci.yml smoke-db "Repo-root scripts tests (real Postgres)"). The apps/web placement is kept, with its precedent (`end-shared-meetings-script.test.ts` importing `scripts/chess-end-shared-meetings.ts`).
11. **Task 8/9 entry check.** Old: "`process.argv[1]` resolves to `import.meta.url`". New: `isMainModule(import.meta.url)` from `scripts/lib/main-module.ts`. Why: that is the house check, and its header records that the argv-vs-URL comparison fails open through a symlink. The rule is extended to Task 9's script, which its DB test imports.
12. **Task 9 re-pins.**
    - Contract test env stubs: "lines 50-57" → "lines 50-54".
    - `setBucket` is in `_external-play-line.ts`, but `fund` is in `_external-play-line-route.ts` (the old text attributed both to the former). Both are named, with the key from `currentBudgetKey()`.
    - Pacing: "the line's `lineWire` ETA, as external-play-line-cost.test.ts paces its claims" → `cameraEvidenceDelayMs(k)` (`@/components/public-site/match-room/room-snapshot`), which is what that test's `readOffsetMs` paces on (it never references `lineWire`), plus a `queued` answer's own `line` wire.
13. **Task 10.**
    - The spec has no `BASE` constant. The receiver URL now comes from `testInfo.project.use.baseURL`, which is `playwright.config.ts`'s `PLAYWRIGHT_BASE ?? "http://localhost:3000"` and which the spec already reads at line 364.
    - Pinned the Task 17 `beforeAll` (lines 351/353).
    - Pinned the "first player seated" point: the board 1 test at line 617, after line 650 and before line 657.
14. **Task 11.** "its own setting" → `LOAD_BOARDS` (default 30; 200 players = 100).
15. **Task 12 steps 4/5.** `presence-shadow-report --strict …` (no such command or npm alias) → `node --experimental-strip-types scripts/presence-shadow-report.ts …`.

Not repo paths, and expected missing from the reference tree: the spec `docs/superpowers/specs/2026-11-05-checkin-capacity-design.md` and this plan file. Both sit untracked in the main checkout and must ship with the plans.

Open for owner (as of the first revision): none. Superseded by the review below: the gate's definition changed, and the owner ruled on it (R7).

### Review fixes 2026-11-17

Review: `.superpowers/sdd/2026-11-17-checkin-capacity-review/plan-1.md` (16 findings, against origin/main 59c72dd361). Owner rulings applied: **R7** (the rollout gate is a staging run against real Cloudflare RealtimeKit with the webhook registered; the fixture-vendor run is a local pre-check only) and **R4** (the seat must be able to tell a departed peer: plan 1's readers carry what plan 2 needs).

| # | sev | what changed |
|---|---|---|
| 1 | major | New **Task 10c**: `LOAD_WEBHOOKS=1` makes the harness's fixture deliver over HTTP (`httpWebhookDeliver(${baseURL}/api/webhooks/realtimekit)`); the run reports `{ emitted, delivered, failed, down }` and FAILS when the knob is on and `delivered === 0` or `failed > 0`. Global Constraints and Task 11 name the knob (unset for the baseline). File structure gains the harness. |
| 2 | major | The shadow report is two-sided (Task 5 `ShadowReport`): `covered` needs a `source='webhook'` row OPEN at the stamp (`received_at <= stamp + SHADOW_ARRIVAL_TOLERANCE_MS` on our clock, and `left_at` null or after the stamp), so an old departed peer covers nothing; `open` lists rows still open (a phantom once the scope is quiescent); `closedByEnded` counts rows closed only by `meeting.ended` (new `left_by` column). `--strict` fails on `missing`, `open` or `verified === 0`. Task 9 adds the leave case (`fx.currentPeer` null AND `currentPresence` null) and the reload case; Task 10c checks open = 0 and every delivered leave closed `left_by='left'`; Task 12 step 5 adds a live leave probe. |
| 3 | major | R4: `currentPresence` trusts a `source='read'` row only for `PRESENCE_READ_TRUST_MS = 10_000` after its `received_at` (takes an optional `now`), and returns `source` / `receivedAt`; a webhook for the same peer upgrades the row to `source='webhook'`. Test: read row current at R+trust-1, gone at R+trust, then webhook join/leave. The plan 2 test the finding names (webhooks down → fallback seats → player leaves → next claim back to the 3-call read) belongs to plan 2. |
| 4 | major | `presenceShadowReport(db, { since, fixtureIds? })` and the script's `shadowReportSql(scope)`; the script gains `--since <iso>` and repeatable `--fixture`. Presence rows carry `fixture_id` / `side` (stamped from `heldMeeting` at write time, since a re-pair or teardown can delete the meeting row) so the scope holds after a room is gone. Task 9 scopes every report to its seeded fixtures. |
| 5 | major | The fixture's `participant.joinedAt` is the peer's own `PEER_JOINING` `created_at` (Task 1, with a reload test that takes the expected value from the fixture's served peer events). New `seq bigserial` column; the presence order `joined_at, received_at, seq` is a Global Constraint, used by `currentPresence` / `peersOf` and required of any SQL feeding `currentPeerOf` (plan 3's statement). Task 5 adds the equal-`received_at` reload case and a forced-tie share in the `currentPeerOf` property. |
| 6 | minor | New sealed table `realtimekit_ended_sessions`; `joined` after a recorded end is stored closed (`left_by 'ended'`); a peer's own leave beats the session end regardless of order; `ended` is scoped by `meeting_id` + `session_id` (new partial index) and closes a null-session row only if it joined before the end. Task 5 adds a DB fast-check property: a stay's rows depend only on the event SET (shuffled, with repeats). |
| 7 | minor | The key floor answers a retryable **503** (`key_unavailable`, `Retry-After: 60`), never 401: `webhookPublicKey` returns `{ key, fetched }`, and 401 is answered only when a key fetched for this request still refuses. Tests in Tasks 4, 6 and 7. |
| 8 | minor | Applied as a meeting-ownership rule instead of a path secret: an event applies only if its meeting is in `fixture_video_meetings`, `video_rooms_to_end`, or already has presence rows (`heldMeeting`); any other meeting, and any `other` event, is 200 `ignored` and writes NOTHING (not even a delivery row). Cloudflare signs only real events of the sender's own app, so a foreign app's events name meetings we never hold, and staging/production sharing one app separate the same way. The per-environment path secret was NOT added: it would need a new env var on every server, CI's walkthrough server included, for no protection beyond the ownership rule. |
| 9 | minor | New **Task 10b**: `prunePresence` (deliveries after 7 days, presence and ended sessions after 30), one call in `sweep.ts runPass` before the parked-rooms job, `received_at` indexes added; counted test with rows on both sides of each cutoff and a second-call case. |
| 10 | minor | Task 3's sweep covers all three shapes' required paths, deleted AND corrupted, counted. Count is **13, not the finding's 14** (5 + 6 + 3): `left`'s `joinedAt` is nullable by this plan's own type (a `left` before its `joined` must still store), so `left` has 5 required paths; the tolerated nulls get their own case. Plus a receipt-time-fallback mutation. |
| 11 | minor | Task 10's forged test signs with a foreign key (so it exercises verification and the HTTP refetch), awaits `video.webhooksSettled()`, and asserts on its own `rtk_uuid` only; the board-1 test moves to `budget(11)`. |
| 12 | minor | R7 settles it: Task 12 step 4 is the LOCAL pre-check (fixture vendor, `LOAD_WEBHOOKS=1`); step 5 is THE gate, a staging round against real RealtimeKit with the webhook registered. "Open for owner: none" above is superseded. Plans 2 and 3 must point at Task 12 step 5 as the one gate definition (their "load harness on staging" cannot run: the fixture listens on 127.0.0.1). |
| 13 | minor | `WebhookDeliver` resolves on 2xx and rejects otherwise; `httpWebhookDeliver` rejects after its retries; the fixture catches every rejection and records `webhookOutcomes`; `webhooksSettled` uses `Promise.allSettled`. Task 1 adds a rejecting-deliver case with an unhandled-rejection counter; Task 9's in-process deliver throws on a non-200 receipt. |
| 14 | minor | New `everJoined(db, { meetingId, participantId, customParticipantId })` in `presence.ts`, with currentPresence's matching rule (custom-id fallback included); plan 3's arbiter refusal should call it. |
| 15 | minor | New **Task 10a** smoke suite. Partly applied: unsigned → 401, no uuid → 401, foreign-key signature → 401 or 503 with no row written. The signed-200 and duplicate checks are NOT in smoke: the smoke server reads Cloudflare's key (ci.yml gives it no `REALTIMEKIT_BASE_URL`), so smoke cannot sign an accepted delivery; Task 7's route suite and Task 10's walkthrough cover them. |
| 16 | minor | Task 9 drives `seatPlayer` on the wall clock (no `deps.now`), waiting the real `cameraEvidenceDelayMs(k)`, and the report compares `received_at` (our clock) against the seat's stamp. |

Interface changes siblings must follow: `currentPresence` result `+ source, receivedAt` and argument `+ now?` (additive); `everJoined` new (plan 3); the presence order for any SQL feeding `currentPeerOf` (plan 3); `presenceShadowReport` takes a scope object (no sibling calls it); `webhookPublicKey` returns `{ key, fetched }` (no sibling calls it); `fx.reset()`/`FixtureWebhook` unchanged; `LOAD_WEBHOOKS=1` for every presence measurement (plans 2 and 3); Task 12 step 5 is the staging gate. Every other name plans 2 and 3 import is unchanged.

Owner ruling 2026-11-17 (2) ("apply both rec"), closing the item that was open here: a non-zero `closedByEnded` at Task 12 step 5 BLOCKS turning plan 2's `EXTERNAL_PLAY_PRESENCE_PROOF` on until it is explained and recorded. Written as a gate condition in Task 12 step 5 (the one definition); plan 2 Task 11 and design §6.8 step 5 and §12 point at it. Open for owner: none.
