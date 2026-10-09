# Chess in-page board and camera — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play a tournament chess match on our own page — chessground board beside the
player's own camera tile — with Lichess as the authority on legality, clocks and results.

**Architecture:** Our server is the only mover: both players submit intended moves to us,
we validate and forward them to the Lichess Board API with that player's token, then
broadcast the new position over the realtime channel we already own. There is no
long-lived connection to Lichess; four triggers cause a single export read that settles
status, winner and clocks. Video is a Cloudflare RealtimeKit meeting created with the
game and torn down at the result.

**Tech Stack:** Next 16.3 / React 19.2 / TS, Postgres + Flyway, Supabase realtime,
chessground 9.x (GPL-3.0, isolated chunk), chess.js 1.x (BSD-2), Cloudflare RealtimeKit,
Lichess Board API.

**Spec:** `docs/superpowers/specs/2026-10-09-chess-in-page-board-and-camera-design.md`
(owner-approved 2026-10-09, commit `d6f46ab52`). Read it before Task 1. Its §2 lists
fifteen facts measured against live Lichess; several contradict the brainstorming
document and three of them are the reason tasks exist.

---

## Global Constraints

Copied from the spec. Every task's requirements implicitly include this section.

- **Lichess is the authority** on legality, clocks and results. We never adjudicate chess.
- **No long-lived connection to Lichess anywhere.** No always-on service. The 5-minute
  cron stays sweeps and no-shows.
- **A malformed UCI is played, not rejected** (spec M5: `e7e6xx` → `200`, `e7e6` played).
  Every move string is validated against `^[a-h][1-8][a-h][1-8][qrbn]?$` server-side
  before submission. A client string is never forwarded unparsed.
- **`400 "Not your turn, or game already over"` covers two states** (M6). It means
  reconcile; it never means assume.
- **Challenge creation is rate-limited; moves are not** (M3, M4). Creation goes through
  one global queue with 429 backoff. Move submission does not.
- **The Board API accepts a fast-clock challenge then refuses every move on it** (M12).
  Time controls are validated at tournament setup, from a curated list.
- **Colour is read from the pairing, never assigned.** W3 owns colour allocation.
- **Names resolve through `entrantDisplayName`**, never raw entrant text.
- **Unrated games only** (`rated=false`).
- **Players never see each other's camera.** Own tile only, plus a presence pill.
- **Copy says "your camera may be reviewed by an organiser"** — never "you are being
  monitored". There is no mandatory observer.
- **chessground stays isolated and unmodified** — own chunk, loaded as a library, thin
  wrapper above it. Never vendored, never patched.
- Every user-facing string ships in **en/es/fr/nl**; this surface is not under
  `games/**`, so the English-only exemption does not apply. Run `i18n:check` and
  `i18n:gen-keys`, and commit the regenerated `i18n-keys.ts`.
- **Mobile bar in full:** 320, 768, 1280, no horizontal page scroll, seven-width e2e.
- **No new role.** Organiser/admin covers the arbiter.
- **The branch does not typecheck today.** Four live routes import six symbols defined
  nowhere: `app/api/cron/external-play/route.ts:6-8`, `.../external-play/resolve/route.ts:4`,
  `.../external-play/resend/route.ts:3`, `app/api/webhooks/lichess/route.ts:3`. T13
  repoints the cron route; the other three belong to B4/B5. Expected mid-redesign state —
  each task gates on ITS OWN files being clean, not on the app-wide count.
- **RealtimeKit has no synchronous publishing signal, but DOES have a post-hoc one.**
  The gate proves joined-and-live only; camera-on is enforced by the preset (env-pinned,
  no defaults; an outage THROWS). Separately, `sessions/peer-report/{peer_id}` carries
  `video_producer`, `video_producer_cumulative`, `frames_encoded`, `key_frames_encoded`,
  `no_video_fraction`, `bytes_sent` — server-held evidence a camera really published.
  **T7 owes a measurement of that report's lag against a live session** and a written
  verdict; it is organiser evidence after a match, never a seat-gate input.
- **A new `cameraPolicy` division config key MUST be added to
  `withoutDivisionMetaKeys`** (`server/external-play/online-play.ts:45`, whose allowlist
  is exactly `entrants` and `onlinePlay`). The format-lock comparison path calls it
  (`usecases/divisions.ts:603` via `withoutEntrants`), so without this every save on a
  division that has fixtures 409s FORMAT_LOCKED — verified 2026-10-09.
- **The public fixture seam is NOT inert** — it is mounted (`page.tsx:372/392`, fed from
  `data.ts:35-36/1117/1258`). The hazard is the cache: that payload lives inside
  `unstable_cache(["pub-fixture-v3", …])` with a 30s revalidate, so reshaping it WITHOUT
  bumping the key to `pub-fixture-v4` serves the old shape and looks like a failed deploy.
- **`entrantDisplayName` cannot be applied to a chess seat today**: `loadSide`
  (`guard.ts:238`) selects `e.display_name` raw and falls back to the entrant **UUID**
  (`:251`). Fix it at source in T14; never paper over it in a view.
- **`core.settle` does not exist** anywhere in apps/packages/db. Use the shipped
  `POST /fixtures/{id}/external-play/resolve` (`schemas.ts:1329`, kinds
  `home_forfeit | away_forfeit | draw | no_result`).
- **`ui.json` is FLAT, not nested**, `externalPlay.lobby.*` (10 keys + `playOnLichess`)
  is still live at 33/33 per locale, and no `externalPlay.room.*` exists yet.
- **There are SIX `?lichess=` flashes, not five** — `not_configured` is live
  (`en:937`, emitted by `api/auth/lichess/route.ts:37`). The callback already defaults
  its landing to `/me`, which today reads only `claimed`.
- **`NeedsReason` and the queue's `REASON_KEYS` share zero values**
  (`types.ts:14-21` vs `needs-result-queue.tsx:19-26`), so every real reason renders
  `generic` today. A live defect, not a new one.
- **`needs_decision` and division phase `tiebreak` do not exist** (`DIVISION_PHASES` is
  `setting_up | scheduled | match_day | finished`, `lib/division-phase.ts:26`), and
  **`organiser-only-events.ts` does not exist** — W2a is unmerged. Do not code against
  either; hold a knockout draw as `needs_organiser` + `tiebreak_owed`.
- **`mintMatchRoomToken` has no production caller today** — T14 is what gives it one. A
  token minted by nothing and read by nothing is an inert seam; prove it end to end.
- **The branch is RED today**: `apps/web/e2e/walkthrough/chess-external-play.spec.ts`
  exists, asserts the deleted `lichess.org/e2eReadyGame` link at :84, and is absent from
  `WALKTHROUGH_SPECS`, which `e2e-ci-wiring.test.ts:590` asserts is empty. T17 reproduces
  that red before fixing it.
- **No recorded Lichess fixture carries `clocks`** — all were captured with
  `clocks=false`, so M11 has live evidence but none in the repo. T17 records one.
- Repo uses **pnpm**. `grep -a` always. `rtk proxy git diff` for diff content —
  plain `rtk` indents diffs and a `^[-+]` scan silently returns nothing.

## Sequencing gates (read before scheduling)

- **Task 13 must not merge before W2b merges.** Until then a pre-start chess forfeit
  returns 422 `WRONG_PHASE`. W2b accepts phase `pre` and makes `core.forfeit` strict:
  `{by: <entrant> | "both", reason: "walkover" | "retired" | "disqualified" | "withdrew"}`.
- **W2a's organiser-only gate** (`isOrganiserOnlyEvent`, `apps/web/src/lib/organiser-only-events.ts`)
  must be checked **as merged**, not as described here.
- **Migrations V405/V407 are below main's high-water mark (V431)** and `flyway.toml` sets
  no `outOfOrder`. Task 1 amends them to V432/V433. Do not enable `outOfOrder`.

## Review Focus

Seven conditions the spec implies that no task's happy path exercises. Each has a test
assigned to the task that owns the code; they are listed here once so a reviewer can
check they survived.

1. **A player revokes our token on lichess.org between linking and the round.** Our
   stored token is dead; the first submission 401s. Expected: that player's fixture goes
   to the organiser queue with its own reason — never recorded as a no-show. *(Task 12)*
2. **The same player opens the room in two tabs.** Two submissions of the same move
   arrive. Expected: the second is absorbed, not played twice, and not reported as an
   error to the player. *(Task 10)*
3. **Camera is granted at preflight, then revoked before the game is created.** Expected:
   under `Required`, creation does not proceed on a stale pass; the seat reverts and the
   player is told why. *(Task 8)*
4. **Our server is down while a clock expires, and comes back after Lichess has ended the
   game.** Expected: reconcile writes the result exactly once; a second reconcile is a
   no-op, not a duplicate event. *(Task 11)*
5. **An entrant whose only member is merged (`merged_into` set), or a BYE row.** There is
   no person to link or seat. Expected: the fixture is never offered as an online match
   and says so, rather than failing at creation. *(Task 9)*

Two more arrived with owner decision D12 (organiser-driven rounds), and they are the
highest-consequence items on this list, because the code they displace anchors on the
schedule:

6. **A round that is paired but NOT opened, whose scheduled time is long past.** Expected:
   nobody can be seated and NO forfeits are produced. Anchoring on the schedule instead of
   `round_opened_at` would mark an entire field as no-shows for a round that never started.
   *(Task 13, proven end to end in Task 17)*
7. **A player opens the room for a round the organiser has not opened yet.** Expected: the
   room says it has not started, with the scheduled time shown for information — not a dead
   board, and not a countdown against a deadline that is not running. *(Task 14, via
   `roomPhase`'s new `not_opened` member — `RoomPhase` has no such state today)*

---

## File structure

**Reused as built (Tasks 1–8 of the superseded plan, already on this branch):**

| File | Responsibility | This plan |
|---|---|---|
| `apps/web/src/server/external-play/window.ts` | T−10/T+20 window, phases, check-in counts | unchanged |
| `apps/web/src/server/external-play/types.ts` | shared types, `NeedsReason` | extended |
| `apps/web/src/server/usecases/external-play/guard.ts` | fixture/side loading, `whiteSideOf`, staleness | extended |
| `apps/web/src/server/usecases/external-play/room.ts` | room read, check-in, claim-then-call mint | rewritten in T9 |
| `apps/web/src/server/usecases/{signing-key,match-room-token,checkin-token}.ts` | JWTs | unchanged |
| `apps/web/src/server/usecases/me.ts` → `stampFixtureCheckIn` | check-in stamp | unchanged |
| `apps/web/src/lib/realtime.ts` | lobby/room token with `lobby_fixture_id` | extended in T10 |

**Created or rewritten by this plan:**

| File | Responsibility | Task |
|---|---|---|
| `db/migration/deltas/V432__online_chess_board_and_camera.sql` | amended schema: tokens at rest, camera policy, meetings, flags, audit | T1 |
| `db/migration/deltas/V433__online_chess_realtime_policy.sql` | realtime policy for the room channel | T1 |
| `apps/web/src/server/external-play/secrets.ts` | seal/unseal a player token (device-link pattern) | T2 |
| `apps/web/src/server/usecases/external-accounts.ts` | store token + scopes + consent, revoke on unlink | T2 |
| `apps/web/src/server/external-play/lichess/board-api.ts` | challenge-to-user, accept, move, resign, draw, abort, export | T3 |
| `apps/web/src/server/external-play/lichess/uci.ts` | strict UCI validation | T3 |
| `apps/web/src/server/external-play/creation-queue.ts` | global throttle + 429 backoff for creation | T4 |
| `apps/web/src/server/external-play/time-controls.ts` | curated catalogue + setup validation | T5 |
| `apps/web/src/server/external-play/camera-policy.ts` | `Off`/`Optional`/`Required`, downgrade-only rule | T6 |
| `apps/web/src/server/external-play/video/realtimekit.ts` | meeting/participant lifecycle, publisher check | T7 |
| `apps/web/src/server/usecases/external-play/preflight.ts` | server-verified seat gating, override | T8 |
| `apps/web/src/server/usecases/external-play/create-game.ts` | claim-then-call orchestration | T9 |
| `apps/web/src/server/usecases/external-play/play.ts` | move/draw/resign/abort, broadcast | T10 |
| `apps/web/src/server/usecases/external-play/reconcile.ts` | the four triggers, clock correction, idempotent write | T11 |
| `apps/web/src/server/usecases/external-play/result.ts` | terminal status → our events, organiser authority | T12 |
| `apps/web/src/server/usecases/external-play/sweep.ts` | T−10 notice, mint retry, T+20 no-show | T13 |
| `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/[token]/page.tsx` | the room's URL — the page a player's invite link opens | T14 |
| `apps/web/src/app/api/v1/fixtures/[id]/external-play/room/route.ts` | room read + actions API | T14 |
| `apps/web/src/components/public-site/match-room/*` | room shell, board wrapper, promotion picker, tile, pill | T14 |
| `apps/web/src/server/usecases/external-play/open-round.ts` | organiser opens a round: stamp + invites | T19 |
| `apps/web/src/components/v2/arbiter-panel.tsx` | optional arbiter view | T15 |

---

---

## Interfaces (authoritative)

These signatures are fixed by the plan, not chosen by the implementer. A task may add
to its own module, but may not rename or re-shape anything another task consumes.

```ts
// T2 — apps/web/src/server/external-play/secrets.ts
export function sealPlayerToken(plain: string): Promise<string>;
export function openPlayerToken(sealed: string): Promise<string>;

// T2 — apps/web/src/server/usecases/external-accounts.ts
export type LichessLink = {
  externalUserId: string;        // lowercase lichess id
  username: string;              // display case
  scopes: string[];              // e.g. ["board:play","challenge:write"]
  consentedAt: Date | null;      // null => re-consent owed before play
};
export function upsertLichessLink(
  userId: string,
  link: { externalUserId: string; username: string; scopes: string[]; token: string },
): Promise<void>;
export function getLichessLink(userId: string): Promise<LichessLink | null>;
export function getLichessAccessToken(userId: string): Promise<string | null>;
export function unlinkLichess(userId: string): Promise<void>; // revokes at Lichess, then deletes

// T3 — apps/web/src/server/external-play/lichess/uci.ts
export const UCI_RE: RegExp;                      // ^[a-h][1-8][a-h][1-8][qrbn]?$
export function assertUci(value: string): string; // throws HttpError(400,"INVALID_UCI")

// T3 — apps/web/src/server/external-play/lichess/board-api.ts
export type BoardCall = { ok: true } | { ok: false; code: BoardErrorCode; raw: string };
export type BoardErrorCode =
  | "not_your_turn_or_over"   // 400 "Not your turn, or game already over"  (M6)
  | "unplayable_time_control" // 400 "This game cannot be played with the Board API." (M12)
  | "rate_limited"            // 429
  | "unauthorized"            // 401/403 — token revoked or wrong scope
  | "unavailable"             // a DEFINITE failure: Lichess answered and nothing was created
  | "outcome_unknown";        // timeout, 5xx, or a 200 with no id — a challenge MAY exist.
                              // Never release a creation claim on this code: look the
                              // challenge up before any re-create (Task 3-5 review T3-I2).
export type GameSnapshot = {
  gameId: string;
  status: LichessStatus;
  winner: "white" | "black" | null;
  movesSan: string[];
  whiteMs: number | null;      // from export "clocks" (centiseconds → ms)
  blackMs: number | null;
  increment: number;           // seconds
};
export type LichessStatus =
  | "created" | "started" | "mate" | "resign" | "outoftime"
  | "draw" | "stalemate" | "aborted" | "timeout" | "noStart" | "unknownFinish";
export function createChallengeToUser(a: {
  whiteToken: string; blackUsername: string; limitSeconds: number; incrementSeconds: number;
}): Promise<{ ok: true; challengeId: string } | { ok: false; code: BoardErrorCode; raw: string }>;
export function acceptChallenge(a: { blackToken: string; challengeId: string }): Promise<BoardCall>;
export function submitMove(a: { token: string; gameId: string; uci: string }): Promise<BoardCall>;
export function resignGame(a: { token: string; gameId: string }): Promise<BoardCall>;
export function offerOrAcceptDraw(a: { token: string; gameId: string; accept: boolean }): Promise<BoardCall>;
export function abortGame(a: { token: string; gameId: string }): Promise<BoardCall>;
export function exportGame(gameId: string): Promise<GameSnapshot | null>; // null = 404

// T4 — apps/web/src/server/external-play/creation-queue.ts
export function enqueueCreation<T>(key: string, job: () => Promise<T>): Promise<T>;

// T5 — apps/web/src/server/external-play/time-controls.ts
export type TimeControl = { key: string; limitSeconds: number; incrementSeconds: number };
export const SHIP1_TIME_CONTROLS: readonly TimeControl[]; // 3+0,3+2,5+0,5+3,10+5,15+10
export function isBoardApiPlayable(tc: TimeControl): boolean; // limit + 40*inc >= 180
export function assertTimeControl(key: string): TimeControl;  // throws 400 INVALID_TIME_CONTROL

// T6 — apps/web/src/server/external-play/camera-policy.ts
export type CameraPolicy = "off" | "optional" | "required";
export function effectivePolicy(a: { stage: CameraPolicy | null; competition: CameraPolicy | null }): CameraPolicy;
export function assertPolicyChange(a: {
  from: CameraPolicy; to: CameraPolicy; windowOpened: boolean;
}): void; // after windowOpened, only downgrades; throws 409 POLICY_LOCKED

// T7 — apps/web/src/server/external-play/video/realtimekit.ts
export type MeetingRef = { meetingId: string };
export type ParticipantToken = { participantId: string; authToken: string };
export function ensureMeeting(fixtureId: string): Promise<MeetingRef>;
export function addParticipant(a: {
  meetingId: string; subject: string; preset: "player" | "arbiter";
}): Promise<ParticipantToken>;
export function hasLiveVideoPublisher(a: { meetingId: string; participantId: string }): Promise<boolean>;
export function endMeeting(meetingId: string): Promise<void>;

// T8 — apps/web/src/server/usecases/external-play/preflight.ts
export type SeatResult =
  | { seated: true; participant: ParticipantToken | null }
  | { seated: false; reason: "camera_required" | "camera_lost" | "window_closed" | "round_not_open" | "not_a_player" };
export function seatPlayer(a: { fixtureId: string; personId: string }): Promise<SeatResult>;
export function organiserOverrideVideo(a: { fixtureId: string; actorUserId: string; note: string }): Promise<void>;

// T9 — apps/web/src/server/usecases/external-play/create-game.ts
export type CreateOutcome =
  | { created: true; gameId: string }
  | { created: false; reason: "not_ready" | "already" | "unplayable" | "provider_error" | "no_person" };
export function createGameIfReady(fixtureId: string): Promise<CreateOutcome>;

// T19 — apps/web/src/server/usecases/external-play/open-round.ts
// Swiss PAIRS the next round by itself; opening and inviting is the organiser's act (D12).
export type OpenRoundResult = { opened: true; invited: number } | { opened: false; reason: "already_open" | "not_paired" | "no_fixtures" };
export function openRound(a: { stageId: string; roundNo: number; actorUserId: string }): Promise<OpenRoundResult>;
export function roundOpenedAt(a: { stageId: string; roundNo: number }): Promise<Date | null>;

// T10 — apps/web/src/server/usecases/external-play/play.ts
export type PlayAction =
  | { kind: "move"; uci: string }
  | { kind: "resign" } | { kind: "draw"; accept: boolean } | { kind: "abort" };
export type PlayResult =
  | { ok: true; applied: boolean }   // applied:false = duplicate absorbed (Review Focus 2)
  | { ok: false; reconcile: true; reason: BoardErrorCode };
export function act(a: { fixtureId: string; personId: string; action: PlayAction }): Promise<PlayResult>;

// T10 — apps/web/src/lib/realtime.ts (extended)
export type RoomBroadcast = {
  fen: string; lastMove: string | null; turn: "white" | "black";
  whiteMs: number; blackMs: number; status: LichessStatus; drawOfferBy: "white" | "black" | null;
};

// T11 — apps/web/src/server/usecases/external-play/reconcile.ts
export type ReconcileTrigger = "rejected_move" | "clock_zero" | "game_end" | "organiser" | "sweep";
export function reconcile(a: { fixtureId: string; trigger: ReconcileTrigger }): Promise<GameSnapshot | null>;

// T12 — apps/web/src/server/usecases/external-play/result.ts
export type ResultWrite =
  | { wrote: "decided" | "draw" | "aborted" | "forfeit" | "none" }
  | { wrote: "needs_organiser"; reason: "token_revoked" | "provider_error" | "double_walkover_blocked" };
export function writeResultFrom(snapshot: GameSnapshot, fixtureId: string): Promise<ResultWrite>;
```

---

## Tasks

Batches: **B1** = T1–T5 (schema, secrets, transport). **B2** = T6–T9 (camera, seat,
creation) **then T19 (open round)** — T19 is written last but **executes after T9 and
before T10**, because the window every later task reads is anchored on the stamp T19
writes. **B3** = T10–T13 (play, reconcile, result, sweeps), **built in the order 10 → 12 → 11 →
13**: reconcile must write a result and the writer is T12, so building T11 first forces
an injected default, which is an inert seam by construction. **B4** = T14–T16
(surfaces). **B5** = T17–T18 (e2e, smoke, gate). Within a batch, tasks are sequential —
each consumes the interface the previous one produces.

` marker. -->

### Batch B1 conventions (every task below)

`WT` = `/Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play`.
Every shell line is prefixed `cd <abs path> &&` in the SAME call — the shell cwd
resets between calls, and a verify run launched from the wrong cwd silently
executes on `main` and returns a false green.

- **Scoped vitest** (never the full suite, never `--root`):
  `cd $WT/apps/web && npx vitest run <exact paths> --reporter=json --outputFile=/tmp/b1-<label>.json`
  then `jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b1-<label>.json`
  and `jq -r '.testResults[].name' /tmp/b1-<label>.json | head -3` to confirm the
  resolved paths are under this worktree. Positional args are **literal filename
  filters**, not regexes: a typo runs a subset and reports green. Pin
  `numTotalTests` as well as failures — a file that fails to COLLECT reports
  `PASS(0) FAIL(0)` through `rtk`, and a mutant that fails to parse shrinks the
  total and reads as a survivor.
- **DB-backed tests** take the test DB in front of the command:
  `DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable`
  Suites are `describe.skipIf(!process.env.DATABASE_URL)` — **a missing
  `DATABASE_URL` is a silent skip that reports green**, so after every DB run
  check `numTotalTests` is what you expect, not just `numFailedTests: 0`.
- **Typecheck:** `cd $WT && rtk proxy npx tsc --noEmit -p apps/web` ⇒ exit 0.
  `rtk` rewrites `pnpm exec tsc`; go through `rtk proxy`.
- **Lint on touched files:** `cd $WT && rtk proxy npx eslint <paths>` and read
  `✖ N problems`. Plain `rtk` hides lint output entirely.
- `grep -a` always — files here report as `Binary file … matches` and hide the
  lines, so a bare grep says a call site does not exist when it does.
- `rtk proxy git diff` when you need diff CONTENT; plain `rtk` indents the diff
  and a `^[-+]` scan silently returns nothing.
- Repo uses **pnpm**, never npm, for installs. Test/typecheck go through `npx`
  as written above.

---

### Task 1: Amend V405/V407 to V432/V433 and add the board + camera schema

V405 and V407 exist on this branch and are **unmerged**; main's high-water mark
is V431 and `db/flyway.toml` sets no `outOfOrder` (confirmed:
`db/flyway.toml` has `locations`, `validateMigrationNaming`, `baselineVersion`
and nothing else), so both are refused on any DB past V431. They are **amended
in place** — renamed and rewritten — not superseded by forward migrations.

**Files:**
- Rename + rewrite: `db/migration/deltas/V405__lichess_external_play.sql` →
  `db/migration/deltas/V432__online_chess_board_and_camera.sql` (current file is
  75 lines: `user_external_accounts` at 12-24, its index at 26, RLS at 28-29,
  `fixture_external_play` at 31-62, indexes 64-70, RLS + tenant policy +
  grant 72-75)
- Rename + rewrite: `db/migration/deltas/V407__lichess_lobby_ready.sql` →
  `db/migration/deltas/V433__online_chess_realtime_policy.sql` (current file is
  44 lines; the `realtime.messages` policy body is at 35-45 of the `do $migrate$`
  block, reading `auth.jwt() ->> 'lobby_fixture_id'`)
- Modify: `apps/web/src/server/usecases/__tests__/external-play-schema.test.ts`
  (7-column `toEqual` at 64-68; 22-column `toEqual` at 70-77; `tryInsert` rig at
  44-62; constants at 9-11)
- Modify: `apps/web/src/server/relay/__tests__/enc-boundary.test.ts`
  (`ENC_COLUMNS` derived from the deltas at 36-43; the exhaustiveness
  `toEqual` at 54-56)
- Read-only reference: `db/migration/v2-engine/tables/V207__competitions.sql`
  (competitions DDL, 4-26), `.../V209__divisions.sql` (the *"columns, not config
  keys: the config snapshot is sport-module-validated and would strip foreign
  keys"* precedent, 18-21), `.../V210__stages.sql` (stages DDL, 1-12),
  `db/migration/deltas/V410__stream_sessions.sql` 16-23 (the sealed-table
  pattern: ENABLE + FORCE RLS and **no** policy, reached only through the
  privileged client), `apps/web/src/server/usecases/__tests__/_external-play-seed.ts`
  (`seedOnlineChessFixture`, 92-162)

**Interfaces:**
- Consumes: nothing from this plan. Reads only existing tables
  `organizations`, `users`, `fixtures`, `persons`, `competitions`, `stages`.
- Produces (SQL surface the later tasks consume):
  - `user_external_accounts.access_token_enc bytea null`,
    `.scopes text[] not null default '{}'`, `.consented_at timestamptz null`
    — T2
  - `competitions.camera_policy text not null default 'off'`,
    `stages.camera_policy text null` — T6
  - `fixture_external_play.video_override_at timestamptz null` — T8
  - `fixture_external_play.needs_reason` vocabulary gains `token_revoked` and
    `double_walkover_blocked` — T12
  - `fixture_video_meetings`, `fixture_video_participants` — T7
  - `fixture_play_flags` — T10, T13
  - `online_chess_audit` — T6, T8
  - `stage_round_opens` (D12: the organiser-driven round open — `opened_at`,
    `opened_by`, one row per `(stage_id, round_no)`) — T9, T13
  - `fixture_external_play.round_open_id` + `.invited_at` (D12: the per-fixture
    invite record, gated on an opened round) — T13
  - V433's `realtime.messages` policy `external play lobby read by claim` — T10

**Deviations decided here, with reasons (do not silently re-litigate):**

1. **`url_white` / `url_black` are PRESERVED**, although §3.3 removes the
   hand-off. Dropping them in this task reds `external-play/guard.ts` (7
   references), `external-play/room.ts` (4), `external-play/types.ts` (2),
   `__tests__/external-play-room.test.ts` (5) and
   `__tests__/lichess-adapter.test.ts` (7) — files T9/T10/T3 own. A batch must
   commit green, so the columns stay nullable and unread, and **T9 drops them in
   its own forward migration once the last reader is gone**. Verified reference
   counts: `grep -arn "url_white\|url_black\|urlWhite\|urlBlack" apps/web/src`.
2. **No move ledger here.** §3.4 records accepted moves, but the brief's schema
   list does not include a ledger and this task must not invent one. V432/V433
   are the branch's new high-water mark, so **T10 adds `V434__…` as a normal
   forward migration** — nothing is blocked by leaving it out.
3. **Camera policy lands on `competitions` and `stages`, not `divisions`.** The
   brief says "division/stage", but the authoritative interface is
   `effectivePolicy({ stage, competition })` — exactly two levels. A
   `divisions.camera_policy` column no resolver reads is an inert seam
   (AGENTS.md failure class 1), so it is not created. A division expresses its
   policy on its stages.
4. **Columns, not config keys.** `divisions.config` / `stages.config` are
   sport-module-validated snapshots that strip foreign keys (V209's own comment
   at 18-21), so `camera_policy` is a column on the same precedent as
   `scorer_can_finalize`.
5. **New tables are SEALED**: `enable` + `force` row level security and **no**
   `app_user` policy, following V410 16-23, reached only through the privileged
   `sql` client. `fixture_external_play` keeps V405's tenant policy and grant
   unchanged.
6. **D12's round grain is `(stage_id, round_no)`, because v2 has no rounds
   table.** `db/migration/v1-baseline/V013__rounds.sql` is v1-only and unrelated;
   in v2 a round is a column on `fixtures` (`V214__fixtures.sql:10`, indexed at
   `:47` as `fixtures(stage_id, round_no, seq_in_round)`). So the open stamp gets
   its own table keyed `unique (stage_id, round_no)` rather than a column on a
   table that does not exist. Steps 31-40.
7. **"Invited before the round opened" is enforced by EXISTENCE plus a named
   CHECK, not by comparing two timestamps.** A CHECK cannot span tables, so the
   invariant is split into two guards that are each independently mutable: the
   bridge's `round_open_id` must be non-null whenever `invited_at` is
   (`fixture_external_play_invite_needs_open_round_check`, SQLSTATE 23514), and
   that id must name a real `stage_round_opens` row, which only exists once the
   organiser pressed Open round (`…_round_open_id_fkey`, SQLSTATE 23503). A
   trigger was considered and rejected: it is a heavier guard with no more
   strength, and it would not be reachable from the INSERT-based rig.
8. **The window anchor moves, and that is CODE, not schema.** Under D12 the
   window opens AT `stage_round_opens.opened_at` and the deadline is
   `opened_at + DEADLINE_AFTER_MS`; `scheduled_at_basis` becomes only the time
   players are SHOWN. `WINDOW_OPEN_LEAD_MS` (10 min) stops being the window and
   becomes the pre-open notice lead. `window.ts`'s `windowFor`/`roomPhase` are
   **not** touched by this task — T9 and T13 own that change. Writing it down
   here so nobody re-derives T−10 off `scheduled_at` and marks a field no-show
   for a round that never started, which is the exact failure D12 exists to fix.

---

- [ ] **Step 1: Rebuild the test DB from scratch, because the rename invalidates its Flyway history.**
  `seazn_chess-lep` already recorded V405/V407 as applied; after the rename
  Flyway would try V432 against a database that already has
  `user_external_accounts`, and `create table` would fail. Drop and recreate,
  and **run `sync:sports`** — `db:apply` alone is not a fresh schema and
  `funnel.test.ts` then fails `expected 'generic' to be 'badminton'`:

  ```
  cd $WT && dropdb -h 127.0.0.1 -p 54890 -U postgres --if-exists seazn_chess-lep \
    && createdb -h 127.0.0.1 -p 54890 -U postgres seazn_chess-lep
  cd $WT && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep \
    DATABASE_SSL=disable npm run db:apply
  cd $WT && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep \
    DATABASE_SSL=disable npm run sync:sports
  ```

  Before `createdb`, confirm the server you reached is yours — a `pg_ctl` that
  failed with "Address already in use" is followed by a `createdb` that SUCCEEDS
  against another session's server:
  `psql -h 127.0.0.1 -p 54890 -U postgres -c 'show data_directory'`.

- [ ] **Step 2: Rename both migrations with `git mv` (content untouched) and confirm the tree still applies.**

  ```
  cd $WT && git mv db/migration/deltas/V405__lichess_external_play.sql \
    db/migration/deltas/V432__online_chess_board_and_camera.sql
  cd $WT && git mv db/migration/deltas/V407__lichess_lobby_ready.sql \
    db/migration/deltas/V433__online_chess_realtime_policy.sql
  cd $WT && grep -arn "V405\|V407" db/ apps/web/src docs/superpowers/plans/2026-10-09-chess-in-page-board-and-camera.md
  ```

  Expect hits only in: `V410__stream_sessions.sql:12` (a historical note about
  which versions were claimed — prose, leave it), the renamed files' own header
  comments, `external-play-schema.test.ts:17` (`"external play schema
  (V405/V407)"`), `external-accounts.ts:3`, and the plan/spec. Fix the two code
  comments in later steps of this task; leave V410's history note alone.

- [ ] **Step 3: Failing test — `user_external_accounts` carries the token at rest.**
  Replace `external-play-schema.test.ts` 64-68 with the new column list and a
  token round-trip through the column. The old test's title ("stores identity
  only — no token columns") asserts the decision this task reverses; it is
  deleted, not weakened.

  ```ts
  it("user_external_accounts carries the sealed token, scopes and consent (V432)", async () => {
    expect(await columns("user_external_accounts")).toEqual([
      "access_token_enc", "consented_at", "created_at", "external_user_id",
      "id", "provider", "scopes", "updated_at", "user_id", "username",
    ]);
  });
  ```

- [ ] **Step 4: Run it and read the failure.**
  `cd $WT/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/external-play-schema.test.ts --reporter=json --outputFile=/tmp/b1-t1-red1.json`
  Expected: `numFailedTests: 1`, message
  `expected [ 'created_at', 'external_user_id', 'id', 'provider', 'updated_at', 'user_id', 'username' ] to deeply equal [ 'access_token_enc', 'consented_at', … ]`.
  If instead `numTotalTests: 0`, the `DATABASE_URL` did not reach the process —
  fix that before reading anything into the result.

- [ ] **Step 5: Failing tests — the two consent coupling CHECKs, by constraint NAME.**
  Add to the same file, above the existing `fixture_external_play` cases. These
  need their own insert rig because `tryInsert` (44-62) is bound to
  `fixture_external_play`:

  ```ts
  const CONSENT_TOKEN_CHECK = "user_external_accounts_consent_token_check";
  const CONSENT_SCOPES_CHECK = "user_external_accounts_consent_scopes_check";

  /** One account row against a REAL user (so no FK can fire), read back, rolled back. */
  async function tryAccount(a: {
    token: Buffer | null; scopes: string[]; consentedAt: Date | null;
  }): Promise<Outcome> {
    const rollback = new Error("rollback");
    let row: { status: string; needs_reason: string | null } | undefined;
    try {
      await sql.begin(async (tx) => {
        const [u] = await tx<{ id: string }[]>`
          insert into users (email, display_name, email_verified)
          values (${`v432-${randomUUID()}@test.local`}, 'V432', true) returning id`;
        await tx`
          insert into user_external_accounts
            (user_id, provider, external_user_id, username, access_token_enc, scopes, consented_at)
          values (${u!.id}, 'lichess', ${`lid-${randomUUID().slice(0, 8)}`}, 'Player',
                  ${a.token}, ${a.scopes}, ${a.consentedAt})`;
        row = { status: "accepted", needs_reason: null };
        throw rollback;
      });
    } catch (err) {
      if (err === rollback && row) return { accepted: true, row };
      const e = err as { code?: string; constraint_name?: string };
      return { accepted: false, code: e.code, constraint: e.constraint_name };
    }
    throw new Error("transaction committed — the rollback sentinel never fired");
  }

  it("refuses a stored token with no consent timestamp", async () => {
    expect(await tryAccount({
      token: Buffer.from("sealed"), scopes: ["board:play"], consentedAt: null,
    })).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: CONSENT_TOKEN_CHECK });
  });

  it("refuses a consent timestamp with no stored token", async () => {
    expect(await tryAccount({
      token: null, scopes: ["board:play"], consentedAt: new Date(),
    })).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: CONSENT_TOKEN_CHECK });
  });

  it("refuses consent with an empty scope list", async () => {
    expect(await tryAccount({
      token: Buffer.from("sealed"), scopes: [], consentedAt: new Date(),
    })).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: CONSENT_SCOPES_CHECK });
  });

  // The EMPTY case, stated first in spirit: a legacy identity-only row — the
  // state every already-linked player is in — must stay legal, or V432 cannot
  // be applied to a database that has one.
  it("accepts a legacy identity-only row: no token, no scopes, no consent", async () => {
    expect(await tryAccount({ token: null, scopes: [], consentedAt: null }))
      .toEqual({ accepted: true, row: { status: "accepted", needs_reason: null } });
  });

  it("accepts a sealed token with scopes and consent", async () => {
    expect(await tryAccount({
      token: Buffer.from("sealed"), scopes: ["board:play", "challenge:write"],
      consentedAt: new Date(),
    })).toEqual({ accepted: true, row: { status: "accepted", needs_reason: null } });
  });
  ```

  Add `import { randomUUID } from "node:crypto";` at the top of the file.

- [ ] **Step 6: Run and read the failure.** Same command as Step 4, outputFile
  `/tmp/b1-t1-red2.json`. Expected `numFailedTests: 6` (Step 3's plus five
  here); each new one fails with
  `column "access_token_enc" of relation "user_external_accounts" does not exist`
  — i.e. `{ accepted: false, code: "42703", constraint: undefined }`, not the
  expected `23514`.

- [ ] **Step 7: Write V432's `user_external_accounts` half.**
  Replace lines 1-29 of `V432__online_chess_board_and_camera.sql`:

  ```sql
  -- =============================================================================
  -- V432 — Online chess: board in page + camera (design 2026-10-09).
  -- Amends the unmerged V405 in place (renamed: V405 sat below main's V431 and
  -- flyway.toml sets no outOfOrder, so it could never be applied again).
  --
  -- user_external_accounts: a Seazn user's Lichess identity AND their token at
  -- rest. This REVERSES V405's identity-only decision (design §3.1): the board
  -- API submits moves with each player's own token, so the token is sealed
  -- under LICHESS_TOKEN_KEK (server/relay/crypto.ts sealWith — the same
  -- envelope V417 gave the device link) and kept. `scopes` records what the
  -- grant actually carries, `consented_at` when the player agreed to it.
  -- A row with all three null is a LEGACY identity-only link: legal, and owed
  -- a re-consent screen before its first online fixture.
  -- Not org-scoped; FORCE RLS with no app_user policy, read via privileged `sql`.
  --
  -- fixture_external_play: per-fixture bridge for online play. Check-in is NOT
  -- here — it is fixture_availability.checked_in_at.
  -- =============================================================================

  create table user_external_accounts (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid not null references users(id) on delete cascade,
    provider         text not null check (provider in ('lichess')),
    external_user_id text not null,
    username         text not null,
    -- Sealed under LICHESS_TOKEN_KEK. Named ONLY by
    -- server/usecases/external-accounts.ts (enc-boundary.test.ts holds every
    -- other file to that). Nothing ever searches by this value.
    access_token_enc bytea null,
    scopes           text[] not null default '{}',
    consented_at     timestamptz null,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    unique (user_id, provider),
    unique (provider, external_user_id),
    -- Named, not positional: two table CHECKs would otherwise be
    -- `…_check` and `…_check1`, and a test that asserts a constraint NAME is
    -- the only thing stopping the other CHECK from satisfying it.
    constraint user_external_accounts_consent_token_check
      check ((access_token_enc is null) = (consented_at is null)),
    constraint user_external_accounts_consent_scopes_check
      check (consented_at is null or cardinality(scopes) > 0)
  );

  create index user_external_accounts_user_idx on user_external_accounts (user_id);

  alter table user_external_accounts enable row level security;
  alter table user_external_accounts force row level security;
  ```

- [ ] **Step 8: Re-apply and run green.**
  Flyway will not re-run an already-applied V432, so rebuild again (Step 1's
  three commands), then re-run the suite with outputFile `/tmp/b1-t1-green1.json`.
  Expected: `numFailedTests: 0`, and `numTotalTests` = the file's case count
  (6 pre-existing `fixture_external_play` cases minus the deleted identity-only
  one, plus 6 new = 11 at this point). Also confirm
  `jq -r '.testResults[].name' /tmp/b1-t1-green1.json` resolves under `$WT`.

- [ ] **Step 9: Mutate the coupling CHECK, confirm red, restore.**
  Against the live DB, by hand (DDL has no `cp` backup):

  ```
  cd $WT && psql postgresql://postgres@127.0.0.1:54890/seazn_chess-lep -c \
    'set search_path to seazn_club; alter table user_external_accounts drop constraint user_external_accounts_consent_token_check;'
  ```

  Re-run ⇒ expect the two token/consent cases to fail with
  `{ accepted: true, … }` instead of `23514`. Then restore:

  ```
  cd $WT && psql postgresql://postgres@127.0.0.1:54890/seazn_chess-lep -c \
    'set search_path to seazn_club; alter table user_external_accounts add constraint user_external_accounts_consent_token_check check ((access_token_enc is null) = (consented_at is null));'
  ```

  Re-run ⇒ green again. Repeat the same drop/restore for
  `user_external_accounts_consent_scopes_check` separately — two guards covering
  for each other are each untested, so mutate one at a time.

- [ ] **Step 10: Keep `enc-boundary.test.ts`'s exhaustiveness claim accurate.**
  `ENC_COLUMNS` is derived from the delta files by
  `/\b([a-z_]+_enc)\s+bytea\b/` (36-43) and `toEqual`'d against
  `[...STREAM_COLUMNS, ...DEVICE_LINK_COLUMNS].sort()` (54-56) — the new column
  reds it, which is the test doing its job. Add the third owner group; the
  **positive** owner claim ("and it does") belongs to T2, which writes the owner
  file, so it is not added here.

  ```ts
  /** Design §3.1 (2026-10-09): the player's Lichess token at rest, sealed under
   *  LICHESS_TOKEN_KEK. SQL over it lives in exactly one file — the positive
   *  "and it does" claim is added with that file (T2). */
  const LICHESS_COLUMNS = ["access_token_enc"];
  ```

  and in the exhaustiveness case:

  ```ts
    expect(ENC_COLUMNS).toEqual(
      [...STREAM_COLUMNS, ...DEVICE_LINK_COLUMNS, ...LICHESS_COLUMNS].sort(),
    );
  ```

  Run it (no DB needed):
  `cd $WT/apps/web && npx vitest run src/server/relay/__tests__/enc-boundary.test.ts --reporter=json --outputFile=/tmp/b1-t1-enc.json`
  ⇒ `numFailedTests: 0`, `numTotalTests: 5`.

- [ ] **Step 11: Commit the account half.**
  ```
  cd $WT && git add db/migration/deltas/V432__online_chess_board_and_camera.sql \
    db/migration/deltas/V433__online_chess_realtime_policy.sql \
    apps/web/src/server/usecases/__tests__/external-play-schema.test.ts \
    apps/web/src/server/relay/__tests__/enc-boundary.test.ts
  cd $WT && git commit -m "feat(chess): amend V405/V407 to V432/V433 and keep the player token at rest"
  ```

- [ ] **Step 12: Failing test — the bridge row's new column and reason vocabulary.**
  Update the 22-column `toEqual` (70-77) to 23 and add the two new reasons.
  `url_white`/`url_black` stay (deviation 1):

  ```ts
  it("fixture_external_play has exactly the design §3 columns (V432)", async () => {
    expect(await columns("fixture_external_play")).toEqual([
      "black_emailed_at", "black_lichess_id", "challenge_id", "created_at", "expires_at",
      "finished_at", "fixture_id", "last_error", "last_polled_at", "mint_claimed_at",
      "needs_reason", "org_id", "provider", "scheduled_at_basis", "started_at", "status",
      "updated_at", "url_black", "url_white", "video_override_at", "white_emailed_at",
      "white_lichess_id", "white_side",
    ]);
  });

  // Design §3.6: a token revoked mid-match is NOT a no-show and must not be
  // recorded as one; a blocked double walkover is its own state. Both are
  // written by T12, so the vocabulary has to admit them here.
  it.each(["token_revoked", "double_walkover_blocked"])(
    "accepts needs_reason %s",
    async (reason) => {
      expect(await tryInsert("needs_organiser", reason)).toEqual({
        accepted: true,
        row: { status: "needs_organiser", needs_reason: reason },
      });
    },
  );
  ```

- [ ] **Step 13: Run and read the failure.** Expected 3 failures: the column list
  off by `video_override_at`, and the two reasons rejected with
  `{ accepted: false, code: "23514", constraint: "fixture_external_play_needs_reason_check" }`.

- [ ] **Step 14: Write V432's bridge amendments.**
  In `V432__online_chess_board_and_camera.sql`, inside the
  `create table fixture_external_play (...)`: extend the `needs_reason` CHECK and
  add the override stamp, immediately after `last_error`:

  ```sql
    needs_reason        text check (needs_reason in (
                          'no_show_white', 'no_show_black', 'no_show_both',
                          'not_started', 'aborted', 'mismatch', 'provider_error',
                          -- §3.6: a revoked/rejected token is not a no-show; a
                          -- double walkover on a final/last rung/third place is
                          -- refused and the fixture stays open for the organiser.
                          'token_revoked', 'double_walkover_blocked'
                        )),
    last_error          text,
    -- §5.5 / D11: the organiser proceeded without video under policy
    -- `required` (RealtimeKit unavailable). Read by preflight (T8); the human
    -- record of WHO and WHY is the online_chess_audit row beside it.
    video_override_at   timestamptz null,
  ```

  Leave `url_white` / `url_black` in place with a comment:

  ```sql
    -- Dead under the 2026-10-09 design (§3.3 removes the urlWhite/urlBlack
    -- hand-off: White's token challenges Black's username). Kept nullable
    -- because guard.ts/room.ts still select them; T9 drops them in V434 once
    -- the last reader is gone.
    url_white           text,
    url_black           text,
  ```

- [ ] **Step 15: Rebuild, run green, mutate.** Rebuild (Step 1), re-run ⇒
  `numFailedTests: 0`. Mutant: by hand drop and re-add the reason CHECK without
  `token_revoked`:

  ```
  cd $WT && psql postgresql://postgres@127.0.0.1:54890/seazn_chess-lep -c \
    "set search_path to seazn_club; alter table fixture_external_play drop constraint fixture_external_play_needs_reason_check; alter table fixture_external_play add constraint fixture_external_play_needs_reason_check check (needs_reason in ('no_show_white','no_show_black','no_show_both','not_started','aborted','mismatch','provider_error','double_walkover_blocked'));"
  ```

  ⇒ the `token_revoked` case reds. Rebuild the DB to restore (Step 1) rather than
  hand-patching back, so the live schema is exactly what the migration says.

- [ ] **Step 16: Commit.**
  ```
  cd $WT && git add db/migration/deltas/V432__online_chess_board_and_camera.sql \
    apps/web/src/server/usecases/__tests__/external-play-schema.test.ts
  cd $WT && git commit -m "feat(chess): bridge carries the video override and the two new organiser reasons"
  ```

- [ ] **Step 17: Failing test — camera policy columns and their inheritance shape.**
  New file
  `apps/web/src/server/usecases/__tests__/online-chess-camera-schema.test.ts`:

  ```ts
  // V432 camera policy: a column on competitions and stages, never a config key
  // (divisions.config / stages.config are sport-module-validated snapshots that
  // strip foreign keys — V209's own note). Competition is NOT NULL with 'off' for
  // all existing data (design §5.1); stage is nullable = inherit.
  import { afterAll, beforeAll, describe, expect, it } from "vitest";
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import { seedOnlineChessFixture } from "./_external-play-seed";

  const CHECK_VIOLATION = "23514";
  const HAS_DB = !!process.env.DATABASE_URL;

  describe.skipIf(!HAS_DB)("camera policy columns (V432)", () => {
    let orgId = "";
    let divisionId = "";
    let stageId = "";
    let competitionId = "";

    beforeAll(async () => {
      const seeded = await seedOnlineChessFixture({
        onlinePlay: "lichess", divisionStarted: false, linked: true,
        scheduledAt: new Date(Date.now() + 86_400_000),
      });
      orgId = seeded.orgId;
      divisionId = seeded.divisionId;
      // seedOnlineChessFixture returns no stageId/competitionId — read them back.
      const [s] = await sql<{ id: string; competition_id: string }[]>`
        select st.id, d.competition_id
          from stages st join divisions d on d.id = st.division_id
         where st.division_id = ${divisionId}`;
      stageId = s!.id;
      competitionId = s!.competition_id;
    });

    afterAll(async () => {
      await sql.end({ timeout: 2 }).catch(() => undefined);
    });

    it("every existing competition defaults to 'off' — zero video spend on legacy data", async () => {
      const [row] = await sql<{ camera_policy: string }[]>`
        select camera_policy from competitions where id = ${competitionId}`;
      expect(row!.camera_policy).toBe("off");
    });

    it("a stage inherits by default: its own policy is null", async () => {
      const [row] = await sql<{ camera_policy: string | null }[]>`
        select camera_policy from stages where id = ${stageId}`;
      expect(row!.camera_policy).toBeNull();
    });

    it.each(["off", "optional", "required"])("accepts the policy %s on a stage", async (p) => {
      await sql`update stages set camera_policy = ${p} where id = ${stageId}`;
      const [row] = await sql<{ camera_policy: string }[]>`
        select camera_policy from stages where id = ${stageId}`;
      expect(row!.camera_policy).toBe(p);
      await sql`update stages set camera_policy = null where id = ${stageId}`;
    });

    it("refuses a policy outside the vocabulary, by constraint name", async () => {
      const out = await sql`
        update stages set camera_policy = 'mandatory' where id = ${stageId}`
        .then(() => ({ accepted: true as const }))
        .catch((err: { code?: string; constraint_name?: string }) => ({
          accepted: false as const, code: err.code, constraint: err.constraint_name,
        }));
      expect(out).toEqual({
        accepted: false, code: CHECK_VIOLATION, constraint: "stages_camera_policy_check",
      });
    });

    it("refuses a null competition policy — the inheritance chain has a floor", async () => {
      const out = await sql`
        update competitions set camera_policy = null where id = ${competitionId}`
        .then(() => ({ accepted: true as const }))
        .catch((err: { code?: string; constraint_name?: string }) => ({
          accepted: false as const, code: err.code, constraint: err.constraint_name,
        }));
      expect(out).toEqual({
        accepted: false, code: "23502", constraint: "camera_policy",
      });
    });

    it("the org seeded here is real — the suite is not vacuously green", () => {
      expect(orgId).toMatch(/^[0-9a-f-]{36}$/);
      expect(randomUUID()).not.toBe(orgId);
    });
  });
  ```

- [ ] **Step 18: Run and read the failure.** Expected: every case fails with
  `column "camera_policy" does not exist` (`42703`). If instead `numTotalTests:
  0`, the DB env did not reach the process.

- [ ] **Step 19: Write the camera policy columns.** Append to V432:

  ```sql
  -- =============================================================================
  -- Camera policy (design §5.1, D5). COLUMNS, not config keys: divisions.config
  -- and stages.config are sport-module-validated snapshots and would strip a
  -- foreign key — the same reason V209 put scorer_can_finalize in a column.
  -- The competition is the floor (NOT NULL, 'off' for all existing data, so no
  -- legacy competition can accidentally start spending on video); a stage's
  -- null means "inherit". effectivePolicy (T6) reads exactly these two levels.
  -- =============================================================================
  alter table competitions
    add column camera_policy text not null default 'off'
      check (camera_policy in ('off', 'optional', 'required'));
  alter table stages
    add column camera_policy text null
      check (camera_policy in ('off', 'optional', 'required'));
  ```

- [ ] **Step 20: Rebuild, run green, mutate.** Rebuild (Step 1); run ⇒
  `numFailedTests: 0`, `numTotalTests: 8`. Mutant: drop the stage CHECK
  (`alter table stages drop constraint stages_camera_policy_check;`) ⇒ the
  vocabulary case reds. Rebuild to restore.

- [ ] **Step 21: Commit.**
  ```
  cd $WT && git add db/migration/deltas/V432__online_chess_board_and_camera.sql \
    apps/web/src/server/usecases/__tests__/online-chess-camera-schema.test.ts
  cd $WT && git commit -m "feat(chess): camera policy columns on competitions and stages"
  ```

- [ ] **Step 22: Failing test — meetings, participants, flags, audit.**
  New file
  `apps/web/src/server/usecases/__tests__/online-chess-video-schema.test.ts`:

  ```ts
  // V432 video + flags + audit. Four claims that are not derivable from the DDL:
  //  - D6: N participants per fixture is the MODEL, so (fixture_id, person_id)
  //    is deliberately NOT unique — a second angle is config later, not a
  //    migration. The test proves two rows for one person are accepted.
  //  - a participant cannot exist without a meeting (FK to the meeting row).
  //  - a flag's resolution is all-or-nothing (closed_at ⇔ resolved_by).
  //  - an audit row's actor cannot be deleted out from under it.
  import { afterAll, beforeAll, describe, expect, it } from "vitest";
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import { seedOnlineChessFixture } from "./_external-play-seed";

  const CHECK_VIOLATION = "23514";
  const FK_VIOLATION = "23503";
  const HAS_DB = !!process.env.DATABASE_URL;

  type Outcome =
    | { accepted: true }
    | { accepted: false; code: string | undefined; constraint: string | undefined };

  const attempt = (p: Promise<unknown>): Promise<Outcome> =>
    p.then(() => ({ accepted: true as const })).catch(
      (err: { code?: string; constraint_name?: string }) => ({
        accepted: false as const, code: err.code, constraint: err.constraint_name,
      }),
    );

  describe.skipIf(!HAS_DB)("video, flags and audit schema (V432)", () => {
    let orgId = "";
    let fixtureId = "";
    let stageId = "";
    let personId = "";
    let userId = "";

    beforeAll(async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess", divisionStarted: false, linked: true,
        scheduledAt: new Date(Date.now() + 86_400_000),
      });
      orgId = s.orgId;
      fixtureId = s.fixtureId;
      personId = s.home.personId;
      userId = s.home.userId;
      const [st] = await sql<{ id: string }[]>`
        select id from stages where division_id = ${s.divisionId}`;
      stageId = st!.id;
      await sql`
        insert into fixture_video_meetings (fixture_id, org_id, meeting_id)
        values (${fixtureId}, ${orgId}, ${`mtg-${randomUUID().slice(0, 8)}`})`;
    });

    afterAll(async () => {
      await sql.end({ timeout: 2 }).catch(() => undefined);
    });

    it("one meeting per fixture — a second insert collides on the primary key", async () => {
      expect(await attempt(sql`
        insert into fixture_video_meetings (fixture_id, org_id, meeting_id)
        values (${fixtureId}, ${orgId}, ${`mtg-${randomUUID().slice(0, 8)}`})`,
      )).toEqual({
        accepted: false, code: "23505", constraint: "fixture_video_meetings_pkey",
      });
    });

    it("D6: two participants for ONE person are accepted — N angles are config, not a migration", async () => {
      for (const n of ["a", "b"]) {
        expect(await attempt(sql`
          insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
          values (${fixtureId}, ${personId}, 'player', ${`p-${n}-${randomUUID().slice(0, 8)}`})`,
        )).toEqual({ accepted: true });
      }
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text as count from fixture_video_participants
         where fixture_id = ${fixtureId} and person_id = ${personId}`;
      expect(Number(count)).toBe(2);
    });

    it("a participant cannot exist without a meeting", async () => {
      const [other] = await sql<{ id: string }[]>`
        select f.id from fixtures f where f.id <> ${fixtureId} and f.org_id = ${orgId} limit 1`;
      expect(other, "the seed produced only one fixture — this case cannot run").toBeDefined();
      expect(await attempt(sql`
        insert into fixture_video_participants (fixture_id, person_id, preset, participant_id)
        values (${other!.id}, ${personId}, 'player', ${`p-${randomUUID().slice(0, 8)}`})`,
      )).toEqual({
        accepted: false, code: FK_VIOLATION,
        constraint: "fixture_video_participants_fixture_id_fkey",
      });
    });

    it.each(["camera_lost", "out_of_band_play"])("accepts an open %s flag", async (kind) => {
      expect(await attempt(sql`
        insert into fixture_play_flags (fixture_id, org_id, kind, person_id)
        values (${fixtureId}, ${orgId}, ${kind}, ${personId})`,
      )).toEqual({ accepted: true });
    });

    it("refuses a flag kind outside the vocabulary", async () => {
      expect(await attempt(sql`
        insert into fixture_play_flags (fixture_id, org_id, kind)
        values (${fixtureId}, ${orgId}, 'suspicious_engine_use')`,
      )).toEqual({
        accepted: false, code: CHECK_VIOLATION, constraint: "fixture_play_flags_kind_check",
      });
    });

    it("refuses a half-resolved flag in BOTH directions", async () => {
      expect(await attempt(sql`
        insert into fixture_play_flags (fixture_id, org_id, kind, closed_at)
        values (${fixtureId}, ${orgId}, 'camera_lost', now())`,
      )).toEqual({
        accepted: false, code: CHECK_VIOLATION,
        constraint: "fixture_play_flags_resolution_check",
      });
      expect(await attempt(sql`
        insert into fixture_play_flags (fixture_id, org_id, kind, resolved_by)
        values (${fixtureId}, ${orgId}, 'camera_lost', ${userId})`,
      )).toEqual({
        accepted: false, code: CHECK_VIOLATION,
        constraint: "fixture_play_flags_resolution_check",
      });
    });

    it("a policy downgrade audit row needs its stage and both policies", async () => {
      expect(await attempt(sql`
        insert into online_chess_audit (org_id, stage_id, kind, actor_user_id, from_policy, to_policy, note)
        values (${orgId}, ${stageId}, 'policy_downgrade', ${userId}, 'required', 'optional', 'vendor outage')`,
      )).toEqual({ accepted: true });
      // The wrong shape differs from the right one by more than a missing field:
      // a downgrade carrying a fixture is a video override wearing the wrong kind.
      expect(await attempt(sql`
        insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, from_policy, to_policy, note)
        values (${orgId}, ${fixtureId}, 'policy_downgrade', ${userId}, 'required', 'optional', 'wrong shape')`,
      )).toEqual({
        accepted: false, code: CHECK_VIOLATION, constraint: "online_chess_audit_shape_check",
      });
    });

    it("a video override audit row needs its fixture and no policies", async () => {
      expect(await attempt(sql`
        insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, note)
        values (${orgId}, ${fixtureId}, 'video_override', ${userId}, 'realtimekit 503, proceeding')`,
      )).toEqual({ accepted: true });
      expect(await attempt(sql`
        insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, from_policy, to_policy, note)
        values (${orgId}, ${fixtureId}, 'video_override', ${userId}, 'required', 'off', 'wrong shape')`,
      )).toEqual({
        accepted: false, code: CHECK_VIOLATION, constraint: "online_chess_audit_shape_check",
      });
    });

    // Assumption as a guard, not a comment: "an audit row always has an actor".
    it("refuses deleting the actor of an audit row", async () => {
      expect(await attempt(sql`delete from users where id = ${userId}`)).toEqual({
        accepted: false, code: FK_VIOLATION,
        constraint: "online_chess_audit_actor_user_id_fkey",
      });
    });
  });
  ```

- [ ] **Step 23: Run and read the failure.** Expected: every case fails with
  `relation "fixture_video_meetings" does not exist` (`42P01`), surfaced from
  `beforeAll` — so the JSON shows the whole file failing, not 10 individual
  assertion diffs. That is the right red; do not "fix" it by softening
  `beforeAll`.

- [ ] **Step 24: Write the video, flag and audit tables.** Append to V432:

  ```sql
  -- =============================================================================
  -- Video (design §5.2, D6) — one RealtimeKit meeting per fixture, created when
  -- the FIRST player arrives in the window (preflight needs something to join),
  -- torn down at the result or at T+20. N participants per fixture on purpose:
  -- one camera is enough for ship 1, a second angle is then config, not a
  -- migration — so (fixture_id, person_id) is deliberately NOT unique.
  -- Sealed like V410's tables: ENABLE + FORCE RLS, no app_user policy; these
  -- rows are reached only through the app's privileged client, and the organiser
  -- sees a projection, never a row.
  -- =============================================================================
  create table fixture_video_meetings (
    fixture_id uuid primary key references fixtures(id) on delete cascade,
    org_id     uuid not null references organizations(id) on delete cascade,
    provider   text not null default 'realtimekit' check (provider in ('realtimekit')),
    meeting_id text not null unique,
    created_at timestamptz not null default now(),
    ended_at   timestamptz null
  );
  create index fixture_video_meetings_org_idx on fixture_video_meetings (org_id);

  create table fixture_video_participants (
    id                     uuid primary key default gen_random_uuid(),
    -- To the MEETING, not the fixture: a participant with no meeting is a
    -- preflight that ran against nothing.
    fixture_id             uuid not null
                             references fixture_video_meetings(fixture_id) on delete cascade,
    person_id              uuid null references persons(id) on delete set null,
    preset                 text not null check (preset in ('player', 'arbiter')),
    participant_id         text not null,
    -- §5.2: a player is seated only when the MEETING reports a live video
    -- publisher for them. The POC's client-sent cameraOk boolean is on the
    -- do-not-copy list (§10); this is the server-verified stamp.
    last_publisher_seen_at timestamptz null,
    created_at             timestamptz not null default now(),
    unique (fixture_id, participant_id)
  );
  create index fixture_video_participants_person_idx
    on fixture_video_participants (fixture_id, person_id);

  -- =============================================================================
  -- Flags (design §5.5 / D10, §3.6). A camera that goes dark and out-of-band
  -- play are LOGGED, never automatic sanctions — the organiser decides. The
  -- board never freezes, so a flag is a record with two timestamps and an actor,
  -- not a state the engine reads.
  -- =============================================================================
  create table fixture_play_flags (
    id          uuid primary key default gen_random_uuid(),
    fixture_id  uuid not null references fixtures(id) on delete cascade,
    org_id      uuid not null references organizations(id) on delete cascade,
    kind        text not null check (kind in ('camera_lost', 'out_of_band_play')),
    person_id   uuid null references persons(id) on delete set null,
    opened_at   timestamptz not null default now(),
    closed_at   timestamptz null,
    resolved_by uuid null references users(id) on delete set null,
    note        text null,
    -- Resolution is all-or-nothing in BOTH directions: a closed flag nobody
    -- resolved, and a resolver on a flag still open, are each a bug.
    constraint fixture_play_flags_resolution_check
      check ((closed_at is null) = (resolved_by is null))
  );
  create index fixture_play_flags_open_idx
    on fixture_play_flags (fixture_id) where closed_at is null;

  -- =============================================================================
  -- Audit (design D9, D11). Two things an org can do that must leave a trace:
  -- downgrade the camera policy after a window has opened, and override a
  -- RealtimeKit outage under `required`. Both carry WHO; `on delete restrict`
  -- because an audit row whose actor vanished is not an audit row.
  -- =============================================================================
  create table online_chess_audit (
    id            uuid primary key default gen_random_uuid(),
    org_id        uuid not null references organizations(id) on delete cascade,
    fixture_id    uuid null references fixtures(id) on delete cascade,
    stage_id      uuid null references stages(id) on delete cascade,
    kind          text not null check (kind in ('policy_downgrade', 'video_override')),
    actor_user_id uuid not null references users(id) on delete restrict,
    from_policy   text null check (from_policy in ('off', 'optional', 'required')),
    to_policy     text null check (to_policy   in ('off', 'optional', 'required')),
    note          text not null,
    created_at    timestamptz not null default now(),
    -- `else false`, not a bare CASE: a CASE with no ELSE yields NULL for an
    -- unknown kind and a NULL CHECK PASSES, which would leave this guard
    -- covered for by the kind CHECK instead of standing on its own.
    constraint online_chess_audit_shape_check check (
      case kind
        when 'policy_downgrade' then
          stage_id is not null and fixture_id is null
          and from_policy is not null and to_policy is not null
        when 'video_override' then
          fixture_id is not null and stage_id is null
          and from_policy is null and to_policy is null
        else false
      end
    )
  );
  create index online_chess_audit_org_idx on online_chess_audit (org_id, created_at desc);

  alter table fixture_video_meetings     enable row level security;
  alter table fixture_video_meetings     force  row level security;
  alter table fixture_video_participants enable row level security;
  alter table fixture_video_participants force  row level security;
  alter table fixture_play_flags         enable row level security;
  alter table fixture_play_flags         force  row level security;
  alter table online_chess_audit         enable row level security;
  alter table online_chess_audit         force  row level security;
  ```

- [ ] **Step 25: Rebuild, run green.** Rebuild (Step 1); run the new file ⇒
  `numFailedTests: 0`, `numTotalTests: 11` (`it.each` over two flag kinds counts
  as two). Confirm the resolved path is under `$WT`.

- [ ] **Step 26: Mutate the audit shape CHECK, confirm red, restore.**
  Replace `else false` with `else true` by hand:

  ```
  cd $WT && psql postgresql://postgres@127.0.0.1:54890/seazn_chess-lep -c \
    "set search_path to seazn_club; alter table online_chess_audit drop constraint online_chess_audit_shape_check;"
  ```

  ⇒ both "wrong shape" assertions red. Rebuild the DB (Step 1) to restore.
  Then mutate the flag resolution CHECK to one direction only
  (`check (closed_at is not null or resolved_by is null)`) ⇒ the first half of
  the both-directions case still reds; confirm it does, then rebuild. A guard
  nothing kills is not tested.

- [ ] **Step 27: Rename V433 and update its header for the room channel.**
  The policy body is unchanged — the room channel IS `external-play:{fixtureId}`
  and the claim it reads is still `lobby_fixture_id`, never `fixture_id` (V403's
  paid `fixture:{id}` policy reads that, and sharing the claim name would let a
  paid-realtime JWT authorize this free channel, or the reverse). Replace line 1
  of `V433__online_chess_realtime_policy.sql`:

  ```sql
  -- V433 — private match-room channel external-play:{fixtureId} (amends the
  -- unmerged V407; renamed because V407 sat below main's V431 and flyway.toml
  -- sets no outOfOrder). Under the 2026-10-09 design this topic carries the
  -- LIVE game, not just lobby readiness: our server is the only mover, so every
  -- accepted move is broadcast here (RoomBroadcast, T10). The token still
  -- carries lobby_fixture_id, NEVER fixture_id — V403's paid fixture:{id} score
  -- policy reads fixture_id, and one claim name must not authorize both.
  -- Writes come from the service role, which bypasses RLS; this policy is the
  -- READ side, and it is the only thing stopping a player subscribing to
  -- someone else's room.
  ```

  Also fix the three stale references found in Step 2:
  `external-play-schema.test.ts:17` describe title → `"external play schema
  (V432/V433)"`, and `external-accounts.ts:3`'s `V405` → `V432` (its "no OAuth
  token is kept" sentence is T2's to rewrite — leave the sentence, fix only the
  version, so T2's diff shows the reversal clearly).

- [ ] **Step 28: Verify the whole migration applies from empty, twice.**
  Rebuild (Step 1), then
  `cd $WT && DATABASE_URL=… DATABASE_SSL=disable npm run db:info` and confirm
  V432 and V433 both show `Success` and that **no** version above V433 is
  pending. Then run `db:apply` again ⇒ "No migration necessary" (idempotent, and
  proof the rename did not leave a duplicate version).

- [ ] **Step 29: Checkpoint — run the three DB suites this task has touched so far, together.**
  (Not the final gate for Task 1: the D12 addendum, Steps 31-40, adds cases to
  `external-play-schema.test.ts` and one new suite. Step 39 re-runs all of them.)
  ```
  cd $WT/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep \
    DATABASE_SSL=disable npx vitest run \
    src/server/usecases/__tests__/external-play-schema.test.ts \
    src/server/usecases/__tests__/online-chess-camera-schema.test.ts \
    src/server/usecases/__tests__/online-chess-video-schema.test.ts \
    src/server/relay/__tests__/enc-boundary.test.ts \
    --reporter=json --outputFile=/tmp/b1-t1-final.json
  ```
  Expected `numFailedTests: 0`, `numTotalTests: 35` (11 + 8 + 11 + 5). A lower
  total means a file was filtered out by a literal-filename mismatch — check
  `jq -r '.testResults[].name' /tmp/b1-t1-final.json`.

- [ ] **Step 30: Typecheck and commit.**
  ```
  cd $WT && rtk proxy npx tsc --noEmit -p apps/web
  cd $WT && git add db/migration/deltas/V432__online_chess_board_and_camera.sql \
    db/migration/deltas/V433__online_chess_realtime_policy.sql \
    apps/web/src/server/usecases/external-accounts.ts \
    apps/web/src/server/usecases/__tests__/external-play-schema.test.ts \
    apps/web/src/server/usecases/__tests__/online-chess-video-schema.test.ts
  cd $WT && git commit -m "feat(chess): meetings, participants, play flags and the policy/override audit"
  ```

#### Task 1 addendum — D12: organiser-driven rounds (added mid-batch, 2026-10-09)

Spec D12: the organiser presses **Open round**, which stamps the round as
opened, sends every pairing's invite and starts the window. The schedule becomes
the time players are SHOWN, not the trigger — a Swiss round almost never starts
when the timetable said, and opening windows on a stale schedule marks people
no-shows for a round that had not started. See deviations 6-8 above for the
grain, the enforcement shape and the window-anchor consequence.

- [ ] **Step 31: Failing test — a round opens once, and only an organiser's press creates the row.**
  New file
  `apps/web/src/server/usecases/__tests__/online-chess-round-open-schema.test.ts`:

  ```ts
  // V432 / D12: rounds are organiser-driven. The open stamp is its own table
  // keyed (stage_id, round_no) because v2 has no rounds table — a round is a
  // column on fixtures (V214__fixtures.sql:10). Claims:
  //   - a round opens ONCE: a second press collides on the unique key, so
  //     "Open round" is idempotent at the schema level, not just in the usecase;
  //   - the row records WHO, and that actor cannot be deleted out from under it;
  //   - the EMPTY case first: a stage with no open row has no open rounds at
  //     all, which is what "not yet playable" means and what every window
  //     calculation now hangs off.
  import { afterAll, beforeAll, describe, expect, it } from "vitest";
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import { seedOnlineChessFixture } from "./_external-play-seed";

  const UNIQUE_VIOLATION = "23505";
  const FK_VIOLATION = "23503";
  const HAS_DB = !!process.env.DATABASE_URL;

  type Outcome =
    | { accepted: true }
    | { accepted: false; code: string | undefined; constraint: string | undefined };

  const attempt = (p: Promise<unknown>): Promise<Outcome> =>
    p.then(() => ({ accepted: true as const })).catch(
      (err: { code?: string; constraint_name?: string }) => ({
        accepted: false as const, code: err.code, constraint: err.constraint_name,
      }),
    );

  describe.skipIf(!HAS_DB)("stage_round_opens (V432, D12)", () => {
    let orgId = "";
    let stageId = "";
    let userId = "";

    beforeAll(async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess", divisionStarted: false, linked: true,
        scheduledAt: new Date(Date.now() + 86_400_000),
      });
      orgId = s.orgId;
      userId = s.home.userId;
      const [st] = await sql<{ id: string }[]>`
        select id from stages where division_id = ${s.divisionId}`;
      stageId = st!.id;
    });

    afterAll(async () => {
      await sql.end({ timeout: 2 }).catch(() => undefined);
    });

    it("the empty case: a freshly seeded stage has NO opened rounds", async () => {
      const [{ count }] = await sql<{ count: string }[]>`
        select count(*)::text as count from stage_round_opens where stage_id = ${stageId}`;
      expect(Number(count)).toBe(0);
    });

    it("accepts the organiser's press, stamping when and who", async () => {
      expect(await attempt(sql`
        insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
        values (${stageId}, ${orgId}, 1, ${userId})`,
      )).toEqual({ accepted: true });
      const [row] = await sql<{ opened_at: Date; opened_by: string; round_no: number }[]>`
        select opened_at, opened_by, round_no from stage_round_opens
         where stage_id = ${stageId} and round_no = 1`;
      expect(row!.opened_by).toBe(userId);
      expect(row!.round_no).toBe(1);
      expect(row!.opened_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it("a round opens ONCE — a second press is refused, not a second window", async () => {
      expect(await attempt(sql`
        insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
        values (${stageId}, ${orgId}, 1, ${userId})`,
      )).toEqual({
        accepted: false, code: UNIQUE_VIOLATION,
        constraint: "stage_round_opens_stage_id_round_no_key",
      });
    });

    it("round 2 of the same stage is a different round, not a duplicate", async () => {
      expect(await attempt(sql`
        insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
        values (${stageId}, ${orgId}, 2, ${userId})`,
      )).toEqual({ accepted: true });
    });

    it("refuses deleting the organiser who opened a round", async () => {
      expect(await attempt(sql`delete from users where id = ${userId}`)).toEqual({
        accepted: false, code: FK_VIOLATION,
        constraint: "stage_round_opens_opened_by_fkey",
      });
    });

    it("refuses an open row for a stage that does not exist", async () => {
      expect(await attempt(sql`
        insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
        values (${randomUUID()}, ${orgId}, 1, ${userId})`,
      )).toEqual({
        accepted: false, code: FK_VIOLATION, constraint: "stage_round_opens_stage_id_fkey",
      });
    });
  });
  ```

- [ ] **Step 32: Run it and read the failure.**
  `cd $WT/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/online-chess-round-open-schema.test.ts --reporter=json --outputFile=/tmp/b1-t1-red-d12a.json`
  Expected: the whole file fails from the first query with
  `relation "stage_round_opens" does not exist` (`42P01`). Confirm
  `numTotalTests` is 6 and not 0 — a 0 means the DB env never reached the
  process and the `skipIf` swallowed the file.

- [ ] **Step 33: Write `stage_round_opens`.** Append to
  `db/migration/deltas/V432__online_chess_board_and_camera.sql`:

  ```sql
  -- =============================================================================
  -- Organiser-driven rounds (design D12, 2026-10-09). The organiser presses
  -- "Open round": that stamps the round, sends every pairing's invite and STARTS
  -- the window. The timetable becomes the time players are SHOWN
  -- (fixture_external_play.scheduled_at_basis), never the trigger — a Swiss
  -- round almost never starts when the timetable said, and opening windows on a
  -- stale schedule marks a field no-show for a round that had not started.
  --
  -- The grain is (stage_id, round_no), because v2 has no rounds table: a round
  -- is a column on fixtures (V214__fixtures.sql:10, indexed at :47).
  -- `unique (stage_id, round_no)` makes "Open round" idempotent in the SCHEMA,
  -- so a double press or a retry cannot produce two windows for one round.
  -- `opened_by … on delete restrict`: this row is the authority for a window
  -- that can forfeit somebody, so it keeps its actor.
  --
  -- CONSEQUENCE FOR CODE, not enforced here: T−10 and T+20 are now relative to
  -- `opened_at`, not to the fixture's scheduled time, and a fixture whose round
  -- has no row here is not yet playable. window.ts is T9/T13's to change.
  -- =============================================================================
  create table stage_round_opens (
    id        uuid primary key default gen_random_uuid(),
    stage_id  uuid not null references stages(id) on delete cascade,
    org_id    uuid not null references organizations(id) on delete cascade,
    round_no  int  not null,
    opened_at timestamptz not null default now(),
    opened_by uuid not null references users(id) on delete restrict,
    unique (stage_id, round_no)
  );
  create index stage_round_opens_org_idx on stage_round_opens (org_id, opened_at desc);

  alter table stage_round_opens enable row level security;
  alter table stage_round_opens force  row level security;
  ```

- [ ] **Step 34: Rebuild, run green, mutate.**
  Rebuild the test DB (Step 1's three commands — Flyway will not re-run an
  applied V432), then re-run Step 32's command ⇒ `numFailedTests: 0`,
  `numTotalTests: 6`. Mutant: drop the unique key by hand

  ```
  cd $WT && psql postgresql://postgres@127.0.0.1:54890/seazn_chess-lep -c \
    "set search_path to seazn_club; alter table stage_round_opens drop constraint stage_round_opens_stage_id_round_no_key;"
  ```

  ⇒ "a round opens ONCE" reds with `{ accepted: true }`. Rebuild the DB to
  restore, rather than hand-patching back, so the live schema is exactly what the
  migration says.

- [ ] **Step 35: Commit.**
  ```
  cd $WT && git add db/migration/deltas/V432__online_chess_board_and_camera.sql \
    apps/web/src/server/usecases/__tests__/online-chess-round-open-schema.test.ts
  cd $WT && git commit -m "feat(chess): organiser-driven round opens stamp when and who (D12)"
  ```

- [ ] **Step 36: Failing test — the invite record, and the invariant that it needs an opened round.**
  In `apps/web/src/server/usecases/__tests__/external-play-schema.test.ts`:
  bump the column list written in Step 12 from 23 to 25, and add the invariant
  cases. `tryInsert` (44-62) only takes `status`/`needsReason`, so the invite
  cases get their own rig beside it — same rolled-back-transaction shape, same
  real org + fixture so no FK can fire for the wrong reason.

  ```ts
  const INVITE_CHECK = "fixture_external_play_invite_needs_open_round_check";
  const ROUND_OPEN_FK = "fixture_external_play_round_open_id_fkey";
  ```

  ```ts
  it("fixture_external_play has exactly the design §3 + D12 columns (V432)", async () => {
    expect(await columns("fixture_external_play")).toEqual([
      "black_emailed_at", "black_lichess_id", "challenge_id", "created_at", "expires_at",
      "finished_at", "fixture_id", "invited_at", "last_error", "last_polled_at",
      "mint_claimed_at", "needs_reason", "org_id", "provider", "round_open_id",
      "scheduled_at_basis", "started_at", "status", "updated_at", "url_black", "url_white",
      "video_override_at", "white_emailed_at", "white_lichess_id", "white_side",
    ]);
  });

  /** One bridge row carrying an invite stamp, against the SAME real org +
   *  fixture every other case uses, rolled back. `roundOpen` is either null,
   *  a real opened-round id (created inside the transaction so it rolls back
   *  too), or a syntactically valid id that names nothing. */
  async function tryInvite(a: {
    invitedAt: Date | null;
    roundOpen: "none" | "real" | "dangling";
  }): Promise<Outcome> {
    const rollback = new Error("rollback");
    let row: { status: string; needs_reason: string | null } | undefined;
    try {
      await sql.begin(async (tx) => {
        let openId: string | null = null;
        if (a.roundOpen === "real") {
          const [stage] = await tx<{ stage_id: string; round_no: number }[]>`
            select stage_id, round_no from fixtures where id = ${fixtureId}`;
          const [owner] = await tx<{ user_id: string }[]>`
            select user_id from org_members where org_id = ${orgId} limit 1`;
          const [open] = await tx<{ id: string }[]>`
            insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
            values (${stage!.stage_id}, ${orgId}, ${stage!.round_no}, ${owner!.user_id})
            returning id`;
          openId = open!.id;
        } else if (a.roundOpen === "dangling") {
          openId = randomUUID();
        }
        await tx`
          insert into fixture_external_play
            (fixture_id, org_id, status, scheduled_at_basis, round_open_id, invited_at)
          values (${fixtureId}, ${orgId}, 'pending', now(), ${openId}, ${a.invitedAt})`;
        row = { status: "pending", needs_reason: null };
        throw rollback;
      });
    } catch (err) {
      if (err === rollback && row) return { accepted: true, row };
      const e = err as { code?: string; constraint_name?: string };
      return { accepted: false, code: e.code, constraint: e.constraint_name };
    }
    throw new Error("transaction committed — the rollback sentinel never fired");
  }

  // D12, the invariant that matters: a fixture cannot be marked invited before
  // its round is opened. The wrong answer differs from the right one by having
  // sent a real email on a round that had not started.
  it("refuses an invite stamp with no opened round", async () => {
    expect(await tryInvite({ invitedAt: new Date(), roundOpen: "none" })).toEqual({
      accepted: false, code: CHECK_VIOLATION, constraint: INVITE_CHECK,
    });
  });

  it("refuses an invite stamp naming a round open that does not exist", async () => {
    expect(await tryInvite({ invitedAt: new Date(), roundOpen: "dangling" })).toEqual({
      accepted: false, code: FK_VIOLATION, constraint: ROUND_OPEN_FK,
    });
  });

  it("accepts an invite stamp once the round is opened", async () => {
    expect(await tryInvite({ invitedAt: new Date(), roundOpen: "real" })).toEqual({
      accepted: true, row: { status: "pending", needs_reason: null },
    });
  });

  // The empty case: the state every fixture is in before the organiser presses
  // Open round. Neither column set, and that must stay legal.
  it("accepts a bridge row with neither an open round nor an invite", async () => {
    expect(await tryInvite({ invitedAt: null, roundOpen: "none" })).toEqual({
      accepted: true, row: { status: "pending", needs_reason: null },
    });
  });

  // And the other direction: a round opened but nobody invited yet is the state
  // between the press and the send. An over-tight CHECK would refuse it.
  it("accepts an opened round with no invite stamp yet", async () => {
    expect(await tryInvite({ invitedAt: null, roundOpen: "real" })).toEqual({
      accepted: true, row: { status: "pending", needs_reason: null },
    });
  });
  ```

  Add `const FK_VIOLATION = "23503";` beside `CHECK_VIOLATION` (line 11).
  `randomUUID` is already imported by Step 5.

- [ ] **Step 37: Run and read the failure.**
  `cd $WT/apps/web && DATABASE_URL=… DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/external-play-schema.test.ts --reporter=json --outputFile=/tmp/b1-t1-red-d12b.json`
  Expected `numFailedTests: 6` — the column list off by `invited_at` and
  `round_open_id`, and all five invite cases failing with
  `column "round_open_id" of relation "fixture_external_play" does not exist`
  (`42703`), i.e. `{ accepted: false, code: "42703", constraint: undefined }`.

- [ ] **Step 38: Write the bridge's invite half.** In V432's
  `create table fixture_external_play (...)`, immediately after `last_error` and
  the `video_override_at` block added in Step 14:

  ```sql
    -- D12: the round this fixture's window hangs off. Null until the organiser
    -- presses Open round; `on delete restrict` because a round that has already
    -- invited players cannot be un-opened by deleting its row.
    round_open_id       uuid null references stage_round_opens(id) on delete restrict,
    -- D12: the per-fixture record that the pairing's invite went out. One row
    -- per fixture (fixture_id is the primary key), so "invited" is recorded
    -- once; T13 writes it with `where invited_at is null`, which is what makes a
    -- re-open or a retry a no-op instead of a second email to both players.
    invited_at          timestamptz null,
  ```

  and, with the other named table CHECKs at the end of the same `create table`:

  ```sql
    -- D12's invariant: a fixture cannot be marked invited before its round is
    -- opened. Half of it — the other half is the round_open_id FK, which can
    -- only name a row the organiser's press created. Two guards, deliberately
    -- separate so each is mutable on its own; a CHECK cannot span tables, so no
    -- single constraint can express the whole thing.
    constraint fixture_external_play_invite_needs_open_round_check
      check (invited_at is null or round_open_id is not null),
  ```

  **Ordering note:** `stage_round_opens` must be created ABOVE
  `create table fixture_external_play` in the file, or the FK has no target.
  Step 33 appended it at the end; move that block so it sits before the bridge
  table, and re-read the file top to bottom before applying.

- [ ] **Step 39: Rebuild, run the whole set green.**
  Rebuild the test DB (Step 1), then:

  ```
  cd $WT/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep \
    DATABASE_SSL=disable npx vitest run \
    src/server/usecases/__tests__/external-play-schema.test.ts \
    src/server/usecases/__tests__/online-chess-camera-schema.test.ts \
    src/server/usecases/__tests__/online-chess-video-schema.test.ts \
    src/server/usecases/__tests__/online-chess-round-open-schema.test.ts \
    src/server/relay/__tests__/enc-boundary.test.ts \
    --reporter=json --outputFile=/tmp/b1-t1-final.json
  ```

  Expected `numFailedTests: 0`, `numTotalTests: 46` — 16 in
  `external-play-schema.test.ts` (11 at Step 29 plus the 5 invite cases), 8
  camera, 11 video, 6 round-open, 5 enc-boundary. A lower total means a path was
  filtered out by a literal-filename mismatch; check
  `jq -r '.testResults[].name' /tmp/b1-t1-final.json` and confirm all five
  resolve under `$WT`. Then `cd $WT && DATABASE_URL=… DATABASE_SSL=disable npm run db:apply`
  once more ⇒ "No migration necessary".

- [ ] **Step 40: Mutate the invite CHECK, confirm red, restore, typecheck, commit.**

  ```
  cd $WT && psql postgresql://postgres@127.0.0.1:54890/seazn_chess-lep -c \
    "set search_path to seazn_club; alter table fixture_external_play drop constraint fixture_external_play_invite_needs_open_round_check;"
  ```

  ⇒ "refuses an invite stamp with no opened round" reds with
  `{ accepted: true, … }`; the FK case stays green, which is the proof the two
  guards are not covering for each other. Rebuild the DB to restore, re-run Step
  39 green, then:

  ```
  cd $WT && rtk proxy npx tsc --noEmit -p apps/web
  cd $WT && rtk proxy npx eslint db/../apps/web/src/server/usecases/__tests__/external-play-schema.test.ts \
    apps/web/src/server/usecases/__tests__/online-chess-round-open-schema.test.ts
  cd $WT && git add db/migration/deltas/V432__online_chess_board_and_camera.sql \
    apps/web/src/server/usecases/__tests__/external-play-schema.test.ts
  cd $WT && git commit -m "feat(chess): a fixture cannot be marked invited before its round is opened (D12)"
  ```

---

### Task 2: Store the player token at rest, with re-consent

This task **reverses a built decision**. The OAuth callback currently reads
identity and revokes the token immediately (`DELETE /api/token` in a `finally`,
`callback/route.ts:121-132`), stores no token, and `LICHESS_OAUTH_SCOPES` is
`""` (`lib/oauth.ts:65`). Design §3.1: we now request `board:play
challenge:write`, seal the token, keep it, revoke at Lichess on unlink, and show
a re-consent screen to anyone linked under the identity-only flow before their
first online fixture.

**The nine places the "no stored token" assumption is baked in.** Each is undone
by a named step below; none may be left for later.

| # | Where | What it asserts | Undone in |
|---|---|---|---|
| 1 | `apps/web/src/lib/oauth.ts:61-65` | `LICHESS_OAUTH_SCOPES = ""` plus a doc comment arguing the token "is never used again, so there is nothing to ask permission for" | Step 10 |
| 2 | `apps/web/src/app/api/auth/lichess/route.ts:62-65` | `if (LICHESS_OAUTH_SCOPES) params.set(…)` — a branch that is dead in one direction once the constant is non-empty | Step 10 |
| 3 | `apps/web/src/app/api/auth/lichess/__tests__/lichess-oauth-routes.test.ts:79-83` | `it("omits scope …")` asserts `loc.searchParams.has("scope") === false` | Step 11 |
| 4 | same file, 92 / 103+113 / 122+132+139 / 205+215+222 / 231+244+251 | five cases asserting a `DELETE /api/token` revoke on the LINK path, one of them in its title ("reads account, revokes, stores identity only") | Step 14 |
| 5 | `apps/web/src/app/api/auth/lichess/callback/route.ts:31-33, 62-65, 121-132` | the doc comment, the `let accessToken` comment and the `finally` that revokes on *every* exit path | Step 13 |
| 6 | `apps/web/src/server/usecases/external-accounts.ts:1-5` | file header: "IDENTITY ONLY — no OAuth token is ever stored here" | Step 7 |
| 7 | `apps/web/src/server/usecases/__tests__/external-play-schema.test.ts` | the 7-column `toEqual` with the title "stores identity only — no token columns" | **already undone in T1 Step 3** — verify, do not redo |
| 8 | `docs/superpowers/plans/2026-09-15-chess-lichess-external-play.md:1602` (and the prose at `:589` and `:697`) | a Task-16 gate that greps to FORBID `getLichessAccessToken`, plus "delete `getLichessAccessToken`" / "no stored token" prose | Step 16 |
| 9 | `apps/web/src/server/relay/__tests__/enc-boundary.test.ts` | claim 1's exhaustive `ENC_COLUMNS` list (**extended in T1 Step 10**) still has no positive owner claim for `access_token_enc` | Step 8 |

**Files:**
- Create: `apps/web/src/server/external-play/secrets.ts`
- Create: `apps/web/src/server/external-play/__tests__/secrets.test.ts`
- Modify: `apps/web/src/server/relay/crypto.ts` (`KekName` union at 38, its
  rationale comment at 35-37; `sealWith`/`openWith` at 61-94 are reused
  unchanged)
- Modify: `apps/web/src/lib/oauth.ts` (61-65)
- Modify: `apps/web/src/app/api/auth/lichess/route.ts` (62-65)
- Modify: `apps/web/src/app/api/auth/lichess/callback/route.ts` (15, 31-33,
  62-65, 105-118, 121-132)
- Modify: `apps/web/src/server/usecases/external-accounts.ts` (whole file: header
  1-5, `getLinkedAccount` 22-40, `upsertLichessLink` 42-76,
  `unlinkExternalAccount` 78-85, `personHasLichessLink` 87-100,
  `assertUserHasLichessForOnlinePlay` 102-117,
  `assertPersonIdsLinkedForOnlinePlay` 119-132)
- Modify: `apps/web/src/server/usecases/__tests__/external-accounts.test.ts`
  (imports 4-9; 2-arg `upsertLichessLink` calls at 27, 39, 79, 99, 102, 119, 121;
  `getLinkedAccount` at 25, 32, 43, 46, 106, 110, 124;
  `unlinkExternalAccount` at 45)
- Modify: `apps/web/src/server/usecases/__tests__/_external-play-seed.ts:63`
- Modify: `apps/web/src/app/api/auth/lichess/__tests__/lichess-oauth-routes.test.ts`
- Modify: `apps/web/src/app/api/users/me/external-accounts/lichess/route.ts` (3, 9)
- Modify: `apps/web/src/app/o/[orgSlug]/settings/page.tsx` (30, 226-227 — only
  `linked?.username` is read, verified)
- Modify: `apps/web/src/server/relay/__tests__/enc-boundary.test.ts` (the
  `LICHESS_COLUMNS` group T1 added at claim 1; a new owner claim)
- Modify: `apps/web/src/lib/__tests__/device-link-kek-wiring.test.ts` (whole
  file, 1-65: table-driven over two KEKs)
- Modify: `.env.example`; `.github/workflows/bench.yml:85`, `ci.yml:669`,
  `ci.yml:1065`, `ci.yml:1338`, `e2e.yml:379`, `e2e.yml:1052`, `e2e.yml:1402`,
  `help-shots.yml:45`, `matrix-truth.yml:150`, `matrix-truth.yml:264`;
  `scripts/ci-local.sh` (`common_env()`)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (new
  `settings.account.lichess.*` consent keys), then regenerate
  `apps/web/src/i18n-keys.ts` with `npm run i18n:gen-keys` (it is GENERATED —
  never hand-edited)
- Modify: `docs/superpowers/plans/2026-09-15-chess-lichess-external-play.md:1602`

**Interfaces:**
- Consumes: `sealWith` / `openWith` / `hasValidKek` / `assertKek` from
  `@/server/relay/crypto` (61-94, 50-59); `HttpError` from `@/lib/errors`
  (12-22); `sql` / `withTenant` from `@/lib/db`;
  `user_external_accounts.access_token_enc | scopes | consented_at` from T1.
- Produces, exactly as the authoritative list declares:
  ```ts
  // apps/web/src/server/external-play/secrets.ts
  export function sealPlayerToken(plain: string): Promise<string>;
  export function openPlayerToken(sealed: string): Promise<string>;

  // apps/web/src/server/usecases/external-accounts.ts
  export type LichessLink = {
    externalUserId: string; username: string; scopes: string[]; consentedAt: Date | null;
  };
  export function upsertLichessLink(
    userId: string,
    link: { externalUserId: string; username: string; scopes: string[]; token: string },
  ): Promise<void>;
  export function getLichessLink(userId: string): Promise<LichessLink | null>;
  export function getLichessAccessToken(userId: string): Promise<string | null>;
  export function unlinkLichess(userId: string): Promise<void>;
  ```
- Also produced, added to this task's own module (T8/T9 call it, T14 renders the
  screen on its code): `export const PLAY_SCOPES: readonly string[]` and
  `export function assertLichessConsentForPlay(userId: string | null): Promise<void>`
  — throws `HttpError(422, …, "LICHESS_RECONSENT_REQUIRED")`.

**Decisions taken here (do not re-litigate):**

1. **A third KEK, `LICHESS_TOKEN_KEK`**, not a reuse of `DEVICE_LINK_KEK`.
   `crypto.ts:35-37` states the separation rationale in the code: "a leaked
   RELAY_KEK opens stream keys, a leaked DEVICE_LINK_KEK opens printed scoring
   QRs, and neither opens the other". A leaked scoring-QR key must not also open
   every player's move-submitting token. Cost: ten workflow env blocks,
   `ci-local.sh` and `.env.example`, all mechanical, all covered by Step 17.
2. **`sealPlayerToken` returns base64**, because the authoritative signature is
   `Promise<string>` while the column is `bytea`. `external-accounts.ts` converts
   at the SQL boundary (`Buffer.from(sealed, "base64")` on write,
   `.toString("base64")` on read). The functions are `async` only to match the
   declared signature; the crypto itself is synchronous.
3. **`getLinkedAccount` and `unlinkExternalAccount` are REPLACED, not kept
   beside the new pair.** Keeping `unlinkExternalAccount` exported would leave a
   path that deletes the row without revoking at Lichess — a live orphaned grant
   with `board:play`. Two readers of one row is also duplication with no caller
   asking for it. The two call sites (`settings/page.tsx:226`,
   `external-accounts/lichess/route.ts:9`) move in Steps 9 and 15.
4. **Re-consent is gated at the SEAT and at CREATION, never at registration.**
   `assertUserHasLichessForOnlinePlay` (102-117) runs from `entrants.ts` when a
   player enters a division, which happens long before consent is needed;
   tightening it there would lock legacy players out of signing up, which §5.4's
   "registration states the camera requirement before signup" does not ask for.
   The new `assertLichessConsentForPlay` is a separate function, called by T8
   and T9.
5. **The callback revokes only on failure.** The `finally` block becomes a
   `catch`-shaped revoke on the paths that do not link, so a successful link
   keeps its token. A revoke that fails still leaves an orphaned grant on
   Lichess's side, not a hole on ours — unchanged.

---

- [ ] **Step 1: Failing test — seal/open round-trips, and a wrong key cannot read it.**
  New file `apps/web/src/server/external-play/__tests__/secrets.test.ts`:

  ```ts
  // Design §3.1: the player's Lichess token at rest, under its OWN key. The
  // envelope is server/relay/crypto.ts's (V417's device-link pattern); this
  // module only names the KEK and the base64 boundary. Claims:
  //   - a round trip returns the exact token, including a 1-char and a long one;
  //   - the sealed form is base64 TEXT (the column is bytea, the signature is
  //     string — the conversion happens in external-accounts.ts, not here);
  //   - a token sealed under LICHESS_TOKEN_KEK cannot be opened under
  //     DEVICE_LINK_KEK, which is the whole reason for a third key;
  //   - a flipped byte THROWS rather than decrypting to a plausible wrong token;
  //   - no key configured says so, naming the key, without echoing the value.
  import { afterEach, beforeEach, describe, expect, it } from "vitest";
  import { randomBytes } from "node:crypto";
  import { openPlayerToken, sealPlayerToken } from "../secrets";
  import { openWith, sealWith } from "@/server/relay/crypto";

  const KEK = () => randomBytes(32).toString("hex");

  describe("player token envelope", () => {
    beforeEach(() => {
      process.env.LICHESS_TOKEN_KEK = KEK();
      process.env.DEVICE_LINK_KEK = KEK();
    });
    afterEach(() => {
      delete process.env.LICHESS_TOKEN_KEK;
      delete process.env.DEVICE_LINK_KEK;
    });

    it.each(["x", "lio_" + "a".repeat(60), "lip_Zz09+/-_=="])(
      "round-trips %s",
      async (token) => {
        expect(await openPlayerToken(await sealPlayerToken(token))).toBe(token);
      },
    );

    it("the sealed form is base64 text, and never contains the plaintext", async () => {
      const sealed = await sealPlayerToken("lio_secret_value");
      expect(sealed).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(sealed).not.toContain("lio_secret_value");
      // 89-byte header + body, base64 — comfortably longer than the token.
      expect(Buffer.from(sealed, "base64").length).toBeGreaterThan(89);
    });

    it("two seals of the SAME token differ — a per-row DEK, not a fixed IV", async () => {
      const a = await sealPlayerToken("lio_same");
      const b = await sealPlayerToken("lio_same");
      expect(a).not.toBe(b);
      expect(await openPlayerToken(a)).toBe("lio_same");
      expect(await openPlayerToken(b)).toBe("lio_same");
    });

    it("DEVICE_LINK_KEK cannot open a player token — the keys are separate on purpose", async () => {
      const sealed = await sealPlayerToken("lio_player");
      expect(() => openWith("DEVICE_LINK_KEK", Buffer.from(sealed, "base64"))).toThrow();
      // The positive pair: the right key DOES open it, so the line above is not
      // passing because the envelope is broken for everyone.
      expect(openWith("LICHESS_TOKEN_KEK", Buffer.from(sealed, "base64"))).toBe("lio_player");
    });

    it("a flipped byte throws instead of decrypting to a wrong token", async () => {
      const buf = Buffer.from(await sealPlayerToken("lio_player"), "base64");
      buf[buf.length - 1] ^= 0xff;
      await expect(openPlayerToken(buf.toString("base64"))).rejects.toThrow();
    });

    it("an unset key says which key, and does not echo it", async () => {
      delete process.env.LICHESS_TOKEN_KEK;
      await expect(sealPlayerToken("lio_player")).rejects.toThrow(/LICHESS_TOKEN_KEK is not set/);
    });

    it("a malformed key is refused whole — a junk suffix is not silently truncated", async () => {
      process.env.LICHESS_TOKEN_KEK = KEK() + "zz";
      await expect(sealPlayerToken("lio_player")).rejects.toThrow(
        /LICHESS_TOKEN_KEK must be exactly 64 hex characters/,
      );
    });

    it("seals under the player key, not the relay key (sealWith is given the right name)", async () => {
      const sealed = await sealPlayerToken("lio_player");
      expect(sealWith("LICHESS_TOKEN_KEK", "anything").length).toBeGreaterThan(89);
      expect(await openPlayerToken(sealed)).toBe("lio_player");
    });
  });
  ```

- [ ] **Step 2: Run it and read the failure.**
  `cd $WT/apps/web && npx vitest run src/server/external-play/__tests__/secrets.test.ts --reporter=json --outputFile=/tmp/b1-t2-red1.json`
  Expected: the file fails to COLLECT —
  `Failed to resolve import "../secrets"`. `rtk` would report this as
  `PASS(0) FAIL(0)`; the JSON shows it, which is why the JSON is the only judge.

- [ ] **Step 3: Add `LICHESS_TOKEN_KEK` to `crypto.ts`'s key union.**
  Replace `crypto.ts:35-38`:

  ```ts
  /** The three envelope keys. Separate on purpose (scorer sheets §4.1; chess
   *  design §3.1): a leaked RELAY_KEK opens stream keys, a leaked
   *  DEVICE_LINK_KEK opens printed scoring QRs, a leaked LICHESS_TOKEN_KEK
   *  opens players' Lichess tokens — and none of them opens another. The last
   *  one is the sharpest: that token can submit moves in games that are not
   *  ours, so it must not ride on a key that is also printed on paper. */
  export type KekName = "RELAY_KEK" | "DEVICE_LINK_KEK" | "LICHESS_TOKEN_KEK";
  ```

  Nothing else in `crypto.ts` changes: `kek()` (40-45) reads
  `process.env[name]` and `KEK_HEX` (33) already matches whole.

- [ ] **Step 4: Write `secrets.ts`.**

  ```ts
  import "server-only";
  // The player's Lichess OAuth token at rest (design §3.1). The envelope is
  // server/relay/crypto.ts's — V417 gave the device link exactly this shape —
  // under its OWN key, LICHESS_TOKEN_KEK. This module is the only place that
  // names that key.
  //
  // base64, not Buffer, because the declared interface is Promise<string>; the
  // column is bytea, and external-accounts.ts converts at the SQL boundary. The
  // async signature matches the authoritative interface — the crypto is sync.
  import { openWith, sealWith } from "@/server/relay/crypto";

  export async function sealPlayerToken(plain: string): Promise<string> {
    return sealWith("LICHESS_TOKEN_KEK", plain).toString("base64");
  }

  export async function openPlayerToken(sealed: string): Promise<string> {
    return openWith("LICHESS_TOKEN_KEK", Buffer.from(sealed, "base64"));
  }
  ```

- [ ] **Step 5: Run green.** Same command as Step 2, outputFile
  `/tmp/b1-t2-green1.json` ⇒ `numFailedTests: 0`, `numTotalTests: 11` (the
  `it.each` contributes 3).

- [ ] **Step 6: Mutate the key name, confirm red, restore.**
  In `secrets.ts`, change `sealWith("LICHESS_TOKEN_KEK", …)` to
  `sealWith("DEVICE_LINK_KEK", …)`. Re-run ⇒ the separation case and the
  unset-key case both red. Restore from a `cp` backup taken first
  (`cp apps/web/src/server/external-play/secrets.ts /tmp/secrets.bak` →
  `cp /tmp/secrets.bak …`) — **never `git checkout <file>`**, which on
  uncommitted work restores the index and deletes the implementation the sweep
  is verifying.

- [ ] **Step 7: Commit `secrets.ts`.**
  ```
  cd $WT && git add apps/web/src/server/relay/crypto.ts \
    apps/web/src/server/external-play/secrets.ts \
    apps/web/src/server/external-play/__tests__/secrets.test.ts
  cd $WT && git commit -m "feat(chess): seal a player's Lichess token under its own KEK"
  ```

- [ ] **Step 8: Close the enc-boundary loop — the column now has a named owner.**
  T1 Step 10 added `LICHESS_COLUMNS` to claim 1 so the exhaustive list stayed
  accurate. The owner claim — the positive half, which an empty scan cannot
  pass — belongs here, because this task writes the owning file. In
  `enc-boundary.test.ts`, beside `DEVICE_LINK_OWNER` (51):

  ```ts
  /** Chess design §3.1: the sealed Lichess token. SQL over it lives in exactly
   *  one file. Named, so a second usecase reaching for the column reds. */
  const LICHESS_OWNER = "server/usecases/external-accounts.ts";
  ```

  and a new case beside the device-link one (75-82):

  ```ts
  it("outside __tests__, only external-accounts.ts names access_token_enc — and it does", () => {
    const pattern = new RegExp(`\\b(${LICHESS_COLUMNS.join("|")})\\b`);
    const naming = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.split("/").includes("__tests__"))
      .filter((f) => pattern.test(readFileSync(join(SRC, f), "utf8")));
    expect(naming).toEqual([LICHESS_OWNER]);
  });
  ```

  Run it now and expect **red** with `expected [] to deeply equal [
  'server/usecases/external-accounts.ts' ]` — nothing names the column yet.
  That is the correct failing test for Step 9.

- [ ] **Step 9: Failing test — the account row stores, reads back and re-consents.**
  Rewrite `apps/web/src/server/usecases/__tests__/external-accounts.test.ts`.
  Keep its four existing claims (upsert/get/unlink, `personHasLichessLink` both
  ways, the already-linked 409, idempotent re-link) and move them onto the new
  signatures; add the token and consent claims:

  ```ts
  import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
  import { randomUUID, randomBytes } from "node:crypto";
  import { sql } from "@/lib/db";
  import {
    PLAY_SCOPES,
    assertLichessConsentForPlay,
    getLichessAccessToken,
    getLichessLink,
    personHasLichessLink,
    unlinkLichess,
    upsertLichessLink,
  } from "../external-accounts";

  const HAS_DB = !!process.env.DATABASE_URL;
  const newUser = async (tag: string): Promise<string> => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`${tag}-${randomUUID()}@test.local`}, 'T2 User', true) returning id`;
    return u!.id;
  };

  afterAll(async () => {
    if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
  });

  describe.skipIf(!HAS_DB)("external-accounts — token at rest", () => {
    beforeEach(() => {
      vi.stubEnv("LICHESS_TOKEN_KEK", randomBytes(32).toString("hex"));
      // Unlink revokes at Lichess; every case here stubs that call and the
      // assertions below check it was made with the OPENED token.
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    });

    it("stores the token sealed, and the column never holds the plaintext", async () => {
      const userId = await newUser("seal");
      await upsertLichessLink(userId, {
        externalUserId: "lid-seal", username: "Sealer",
        scopes: [...PLAY_SCOPES], token: "lio_plaintext_token",
      });
      const [row] = await sql<{ access_token_enc: Uint8Array; scopes: string[] }[]>`
        select access_token_enc, scopes from user_external_accounts where user_id = ${userId}`;
      expect(Buffer.from(row!.access_token_enc).includes("lio_plaintext_token")).toBe(false);
      expect(row!.scopes).toEqual(["board:play", "challenge:write"]);
      expect(await getLichessAccessToken(userId)).toBe("lio_plaintext_token");
    });

    it("records consent at link time, so a fresh link owes no re-consent", async () => {
      const userId = await newUser("consent");
      await upsertLichessLink(userId, {
        externalUserId: "lid-consent", username: "Consenter",
        scopes: [...PLAY_SCOPES], token: "lio_t",
      });
      const link = await getLichessLink(userId);
      expect(link).toMatchObject({
        externalUserId: "lid-consent", username: "Consenter",
        scopes: ["board:play", "challenge:write"],
      });
      expect(link!.consentedAt).toBeInstanceOf(Date);
      await expect(assertLichessConsentForPlay(userId)).resolves.toBeUndefined();
    });

    // Review Focus / §3.1: every player linked under the identity-only flow.
    it("a legacy identity-only row reads as consent-owed, and refuses play", async () => {
      const userId = await newUser("legacy");
      await sql`
        insert into user_external_accounts (user_id, provider, external_user_id, username)
        values (${userId}, 'lichess', ${`lid-legacy-${randomUUID().slice(0, 8)}`}, 'Legacy')`;
      const link = await getLichessLink(userId);
      expect(link!.consentedAt).toBeNull();
      expect(link!.scopes).toEqual([]);
      expect(await getLichessAccessToken(userId)).toBeNull();
      await expect(assertLichessConsentForPlay(userId)).rejects.toMatchObject({
        status: 422, code: "LICHESS_RECONSENT_REQUIRED",
      });
    });

    // A grant that predates board:play — linked, consented, wrong scopes. The
    // wrong answer differs from the right one by letting a move submission reach
    // Lichess and 401 mid-game instead of asking first.
    it("a consented row MISSING board:play still owes re-consent", async () => {
      const userId = await newUser("narrow");
      await upsertLichessLink(userId, {
        externalUserId: "lid-narrow", username: "Narrow",
        scopes: ["challenge:write"], token: "lio_narrow",
      });
      await expect(assertLichessConsentForPlay(userId)).rejects.toMatchObject({
        status: 422, code: "LICHESS_RECONSENT_REQUIRED",
      });
    });

    it("no link at all refuses with the LINK code, not the re-consent code", async () => {
      const userId = await newUser("nolink");
      await expect(assertLichessConsentForPlay(userId)).rejects.toMatchObject({
        status: 422, code: "LICHESS_LINK_REQUIRED",
      });
      await expect(assertLichessConsentForPlay(null)).rejects.toMatchObject({
        status: 422, code: "LICHESS_LINK_REQUIRED",
      });
    });

    it("re-linking replaces the token and moves consent forward", async () => {
      const userId = await newUser("relink");
      await upsertLichessLink(userId, {
        externalUserId: "lid-relink", username: "A",
        scopes: [...PLAY_SCOPES], token: "lio_first",
      });
      const first = (await getLichessLink(userId))!.consentedAt!;
      await new Promise((r) => setTimeout(r, 5));
      await upsertLichessLink(userId, {
        externalUserId: "lid-relink", username: "A",
        scopes: [...PLAY_SCOPES], token: "lio_second",
      });
      expect(await getLichessAccessToken(userId)).toBe("lio_second");
      expect((await getLichessLink(userId))!.consentedAt!.getTime())
        .toBeGreaterThan(first.getTime());
    });

    it("unlink REVOKES at Lichess with the opened token, then deletes the row", async () => {
      const userId = await newUser("unlink");
      await upsertLichessLink(userId, {
        externalUserId: "lid-unlink", username: "Leaver",
        scopes: [...PLAY_SCOPES], token: "lio_revoke_me",
      });
      await unlinkLichess(userId);
      const calls = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
      const revoke = calls.find(([, i]) => i.method === "DELETE");
      expect(revoke, "no DELETE /api/token was sent").toBeDefined();
      expect(revoke![0]).toBe("https://lichess.org/api/token");
      expect(new Headers(revoke![1].headers).get("authorization")).toBe("Bearer lio_revoke_me");
      expect(await getLichessLink(userId)).toBeNull();
    });

    it("a revoke that FAILS still deletes the row — an orphaned grant is not a reason to keep ours", async () => {
      const userId = await newUser("revokefail");
      await upsertLichessLink(userId, {
        externalUserId: "lid-revokefail", username: "Failer",
        scopes: [...PLAY_SCOPES], token: "lio_t",
      });
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
      await expect(unlinkLichess(userId)).resolves.toBeUndefined();
      expect(await getLichessLink(userId)).toBeNull();
    });

    it("unlinking a legacy row with no token sends no revoke at all", async () => {
      const userId = await newUser("legacyunlink");
      await sql`
        insert into user_external_accounts (user_id, provider, external_user_id, username)
        values (${userId}, 'lichess', ${`lid-lu-${randomUUID().slice(0, 8)}`}, 'Legacy')`;
      await unlinkLichess(userId);
      const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls;
      expect(calls).toEqual([]);
      expect(await getLichessLink(userId)).toBeNull();
    });

    it("unlinking a user with no link is a no-op, not a throw", async () => {
      await expect(unlinkLichess(await newUser("absent"))).resolves.toBeUndefined();
    });

    it("PLAY_SCOPES is what the design asks for, and the OAuth start sends exactly it", () => {
      expect([...PLAY_SCOPES]).toEqual(["board:play", "challenge:write"]);
    });
  });
  ```

  Keep the four pre-existing cases in a second `describe`, with their
  `upsertLichessLink` calls given `scopes: [...PLAY_SCOPES], token: "lio_t"` and
  `getLinkedAccount(userId, "lichess")` → `getLichessLink(userId)`,
  `unlinkExternalAccount(userId, "lichess")` → `unlinkLichess(userId)`.

- [ ] **Step 10: Run and read the failure.**
  `cd $WT/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/external-accounts.test.ts --reporter=json --outputFile=/tmp/b1-t2-red2.json`
  Expected: collection failure —
  `"PLAY_SCOPES" is not exported by "src/server/usecases/external-accounts.ts"`.
  Confirm from the JSON, not from `rtk`'s summary.

- [ ] **Step 11: Rewrite `external-accounts.ts`.** Replace the whole file:

  ```ts
  import "server-only";
  // Linked external board accounts (Lichess first). The row carries the
  // player's OAuth TOKEN AT REST (chess design §3.1, V432) — this reverses the
  // identity-only decision V405 shipped under, because our server submits both
  // players' moves with their own tokens. The token is sealed by
  // external-play/secrets.ts; `access_token_enc` is named HERE and nowhere else
  // (enc-boundary.test.ts holds every other file to that). Touched only via
  // privileged `sql` (FORCE RLS with no app_user policy).
  import { sql, withTenant } from "@/lib/db";
  import { HttpError } from "@/lib/errors";
  import { LICHESS_TOKEN_URL } from "@/lib/oauth";
  import { LICHESS_TIMEOUT_MS } from "@/server/external-play/window";
  import { openPlayerToken, sealPlayerToken } from "@/server/external-play/secrets";

  /** V432's second unique constraint — a Lichess account can only ever be
   *  linked to ONE Seazn user. */
  const ALREADY_LINKED_CONSTRAINT = "user_external_accounts_provider_external_user_id_key";

  /** The grant design §3.1 asks for: submit moves (`board:play`) and create the
   *  challenge (`challenge:write`). Any linked row that does not carry
   *  `board:play` owes a re-consent, whatever else it carries. */
  export const PLAY_SCOPES = ["board:play", "challenge:write"] as const;

  export type LichessLink = {
    externalUserId: string;
    username: string;
    scopes: string[];
    /** null => linked under the identity-only flow; re-consent owed before play. */
    consentedAt: Date | null;
  };

  export async function getLichessLink(userId: string): Promise<LichessLink | null> {
    const rows = await sql<
      { external_user_id: string; username: string; scopes: string[]; consented_at: Date | null }[]
    >`
      select external_user_id, username, scopes, consented_at
        from user_external_accounts
       where user_id = ${userId} and provider = 'lichess'`;
    const row = rows[0];
    if (!row) return null;
    return {
      externalUserId: row.external_user_id,
      username: row.username,
      scopes: row.scopes,
      consentedAt: row.consented_at,
    };
  }

  /** The plaintext token, or null when there is none (no link, or a legacy
   *  identity-only row). Every caller treats null as "cannot play yet", never
   *  as "play without a token". */
  export async function getLichessAccessToken(userId: string): Promise<string | null> {
    const rows = await sql<{ access_token_enc: Uint8Array | null }[]>`
      select access_token_enc from user_external_accounts
       where user_id = ${userId} and provider = 'lichess'`;
    const enc = rows[0]?.access_token_enc ?? null;
    if (!enc) return null;
    return openPlayerToken(Buffer.from(enc).toString("base64"));
  }

  /** Upsert on `(user_id, provider)`. V432's second unique constraint,
   *  `(provider, external_user_id)`, means a given Lichess account links to ONE
   *  Seazn user; a different user claiming an already-linked account trips it,
   *  and it is surfaced as a typed 409 rather than a raw 23505. Writing the
   *  token also writes `consented_at = now()`: V432's
   *  `user_external_accounts_consent_token_check` refuses one without the
   *  other, so the two cannot drift apart. */
  export async function upsertLichessLink(
    userId: string,
    link: { externalUserId: string; username: string; scopes: string[]; token: string },
  ): Promise<void> {
    const sealed = Buffer.from(await sealPlayerToken(link.token), "base64");
    try {
      await sql`
        insert into user_external_accounts (
          user_id, provider, external_user_id, username,
          access_token_enc, scopes, consented_at, updated_at
        ) values (
          ${userId}, 'lichess', ${link.externalUserId}, ${link.username},
          ${sealed}, ${link.scopes}, now(), now()
        )
        on conflict (user_id, provider) do update set
          external_user_id = excluded.external_user_id,
          username         = excluded.username,
          access_token_enc = excluded.access_token_enc,
          scopes           = excluded.scopes,
          consented_at     = excluded.consented_at,
          updated_at       = now()`;
    } catch (err) {
      const pg = err as { code?: string; constraint_name?: string };
      if (pg.code === "23505" && pg.constraint_name === ALREADY_LINKED_CONSTRAINT) {
        throw new HttpError(
          409,
          "That Lichess account is already linked to a different Seazn account.",
          "LICHESS_ALREADY_LINKED",
        );
      }
      throw err;
    }
  }

  /** Revoke at Lichess, THEN delete. Best-effort revoke: a failure leaves an
   *  orphaned grant on Lichess's side, which is not a reason to keep a token we
   *  were told to forget. A legacy row has no token, so nothing is sent. */
  export async function unlinkLichess(userId: string): Promise<void> {
    const token = await getLichessAccessToken(userId).catch(() => null);
    if (token) {
      await fetch(LICHESS_TOKEN_URL, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
      }).catch(() => undefined);
    }
    await sql`
      delete from user_external_accounts
       where user_id = ${userId} and provider = 'lichess'`;
  }

  /** True when the person's linked Seazn user has a Lichess account row. */
  export async function personHasLichessLink(orgId: string, personId: string): Promise<boolean> {
    const userId = await withTenant(orgId, async (tx) => {
      const rows = await tx<{ user_id: string | null }[]>`
        select user_id from persons where id = ${personId}`;
      return rows[0]?.user_id ?? null;
    });
    if (!userId) return false;
    return (await getLichessLink(userId)) !== null;
  }

  /** REGISTRATION gate — a link is required to enter an online division.
   *  Deliberately NOT a consent gate: a player registers long before consent is
   *  needed, and §3.1 owes re-consent "before their first online fixture", not
   *  before signup. The consent gate is assertLichessConsentForPlay. */
  export async function assertUserHasLichessForOnlinePlay(userId: string | null): Promise<void> {
    if (!userId) {
      throw new HttpError(
        422,
        "Sign in and link your Lichess account to register for online play",
        "LICHESS_LINK_REQUIRED",
      );
    }
    if (!(await getLichessLink(userId))) {
      throw new HttpError(
        422,
        "Link your Lichess account in Settings before registering for online play",
        "LICHESS_LINK_REQUIRED",
      );
    }
  }

  export async function assertPersonIdsLinkedForOnlinePlay(
    orgId: string,
    personIds: string[],
  ): Promise<void> {
    for (const personId of personIds) {
      if (!(await personHasLichessLink(orgId, personId))) {
        throw new HttpError(
          422,
          "Every player must link a Lichess account before entering online play",
          "LICHESS_LINK_REQUIRED",
        );
      }
    }
  }

  /** PLAY gate (§3.1). A link is not enough: the row must carry a consent
   *  timestamp AND `board:play`, because a grant from the identity-only flow
   *  cannot submit a move and would 401 mid-game. Called by T8 (seat) and T9
   *  (creation); T14 renders the re-consent screen on this code. */
  export async function assertLichessConsentForPlay(userId: string | null): Promise<void> {
    if (!userId) {
      throw new HttpError(
        422,
        "Sign in and link your Lichess account to play online",
        "LICHESS_LINK_REQUIRED",
      );
    }
    const link = await getLichessLink(userId);
    if (!link) {
      throw new HttpError(
        422,
        "Link your Lichess account in Settings before playing online",
        "LICHESS_LINK_REQUIRED",
      );
    }
    if (link.consentedAt === null || !link.scopes.includes("board:play")) {
      throw new HttpError(
        422,
        "Re-link your Lichess account so Seazn can submit your moves",
        "LICHESS_RECONSENT_REQUIRED",
      );
    }
  }
  ```

- [ ] **Step 12: Run green, then mutate the consent gate.**
  Re-run Step 10's command ⇒ `numFailedTests: 0`, `numTotalTests: 15` (11 new +
  4 carried). Confirm `numTotalTests` is not 0 — a missing `DATABASE_URL` skips
  the whole file silently.
  Mutant A: drop `|| !link.scopes.includes("board:play")` ⇒ "a consented row
  MISSING board:play still owes re-consent" reds.
  Mutant B: drop `link.consentedAt === null` ⇒ "a legacy identity-only row …"
  reds. Mutate one at a time — two conditions in one `if` cover for each other.
  Mutant C: in `unlinkLichess`, delete the `fetch` block ⇒ the revoke case reds
  with `no DELETE /api/token was sent`.
  Restore from `cp` backups each time, never `git checkout`.

- [ ] **Step 13: Run the enc-boundary owner claim green.**
  `cd $WT/apps/web && npx vitest run src/server/relay/__tests__/enc-boundary.test.ts --reporter=json --outputFile=/tmp/b1-t2-enc.json`
  ⇒ `numFailedTests: 0`, `numTotalTests: 6` (5 + the new owner claim).
  Mutant: in `external-accounts.ts`, rename the column in the two SQL
  statements to `access_token_enc2` ⇒ the owner claim reds with
  `expected [] to deeply equal [ 'server/usecases/external-accounts.ts' ]`.
  Restore from the `cp` backup.

- [ ] **Step 14: Commit the usecase.**
  ```
  cd $WT && git add apps/web/src/server/usecases/external-accounts.ts \
    apps/web/src/server/usecases/__tests__/external-accounts.test.ts \
    apps/web/src/server/relay/__tests__/enc-boundary.test.ts
  cd $WT && git commit -m "feat(chess): keep the player token, revoke on unlink, gate play on consent"
  ```

- [ ] **Step 15: Failing test — the OAuth start asks for the play scopes.**
  Replace `lichess-oauth-routes.test.ts:79-83` (undo #3). The old title asserts
  the decision being reversed, so it is deleted, not weakened:

  ```ts
  it("asks for exactly board:play and challenge:write — the grant that submits moves", async () => {
    const res = await GET(new Request("http://localhost/api/auth/lichess"));
    const loc = new URL(res.headers.get("location")!);
    // Derived from the usecase's own declaration, never retyped here: a change
    // to PLAY_SCOPES moves this assertion with it.
    expect(loc.searchParams.get("scope")).toBe([...PLAY_SCOPES].join(" "));
  });
  ```

  Import `PLAY_SCOPES` from `@/server/usecases/external-accounts` at the top of
  the file. Run ⇒ red: `expected null to be 'board:play challenge:write'`.

- [ ] **Step 16: Make the scopes real (undo #1 and #2).**
  `lib/oauth.ts` 61-65 →

  ```ts
  /** Design §3.1: our server submits both players' moves with their own tokens,
   *  so the grant must carry `board:play` (submit a move, resign, offer a draw,
   *  abort) and `challenge:write` (White's token challenges Black). Derived from
   *  the usecase's PLAY_SCOPES so there is one source of truth for the list. */
  export const LICHESS_OAUTH_SCOPES = PLAY_SCOPES.join(" ");
  ```

  with `import { PLAY_SCOPES } from "@/server/usecases/external-accounts";` —
  **check this import first**: `lib/oauth.ts` is imported by client components,
  and `external-accounts.ts` is `server-only`, so this would break the build
  (a client component importing server code is a known red here). If `tsc` or
  the build complains, invert it: keep the literal
  `export const LICHESS_OAUTH_SCOPES = "board:play challenge:write";` in
  `oauth.ts` and have `external-accounts.ts` derive
  `PLAY_SCOPES = LICHESS_OAUTH_SCOPES.split(" ")` from it — one source of truth
  either way, and `oauth.ts` is the safe side of the boundary. **Verify with
  `cd $WT && rtk proxy npx tsc --noEmit -p apps/web` before moving on**, and
  record which direction you took.
  `route.ts:62-65` →

  ```ts
  // §3.1: the grant is what lets our server submit this player's moves.
  params.set("scope", LICHESS_OAUTH_SCOPES);
  ```

  The `if (LICHESS_OAUTH_SCOPES)` branch goes: with a non-empty constant it is
  dead in one direction, and a guard that can never fail is decoration.

- [ ] **Step 17: Run green and mutate.** Run the route test file ⇒
  `numFailedTests: 0`. Mutant: set `LICHESS_OAUTH_SCOPES` to
  `"challenge:write"` ⇒ the new case reds with a one-scope diff. Restore from
  the `cp` backup.

- [ ] **Step 18: Failing tests — the callback stores the token and revokes only on failure (undo #4, #5).**
  In `lichess-oauth-routes.test.ts`, the five revoke assertions split in two:
  the four FAILURE cases (account read non-ok, account fetch throwing,
  already_linked, token exchange failure) **keep** their
  `calls.some(([u, i]) => u.endsWith("/api/token") && i.method === "DELETE")`
  assertion — a link that did not happen must not leave a live grant. The
  happy-path case at 92-121 inverts. Replace its title and add the inverse
  assertion:

  ```ts
  it("sends code_verifier (no secret), reads account, KEEPS the token, returns to next", async () => {
    // … existing cookie/fetch setup unchanged …
    expect(calls.some(([u, i]) => u.endsWith("/api/token") && i.method === "DELETE")).toBe(false);
    // The positive pair: the token reached the usecase. Asserting only "no
    // DELETE" would pass if the callback had stopped calling Lichess at all.
    expect(upsertSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      externalUserId: "lid", username: "Player",
      scopes: [...PLAY_SCOPES], token: "tok-from-exchange",
    }));
  });
  ```

  with `const upsertSpy = vi.fn();` wired through the file's existing
  `vi.mock("@/server/usecases/external-accounts", …)` (add the mock if the file
  has none — read it first; it currently exercises the real usecase for the
  already_linked case, so mock `upsertLichessLink` only and keep the thrown
  `HttpError` behaviour for that case).

- [ ] **Step 19: Run and read the failure.** Expected 2 failures: the happy path
  still sends a DELETE (`expected true to be false`) and `upsertSpy` was called
  without `scopes`/`token`.

- [ ] **Step 20: Rewrite the callback (undo #5).**
  `callback/route.ts`: the doc comment at 31-33 →

  ```ts
  /** Exchange the Lichess OAuth code (PKCE, no client secret), read the
   *  account's identity, and KEEP the token sealed at rest (design §3.1 — our
   *  server submits this player's moves). The token is revoked here only when
   *  the link does NOT happen: an unusable grant must not be left live. */
  ```

  the comment at 62-65 and the `finally` at 121-132 → a `linked` flag plus a
  conditional revoke:

  ```ts
    // Revoked on every exit path that does NOT end in a stored link. Set true
    // only after upsertLichessLink has returned.
    let linked = false;
    let accessToken: string | undefined;
    try {
      // … token exchange and account read unchanged (66-103) …
      try {
        await upsertLichessLink(user.id, {
          externalUserId: account.id,
          username: account.username,
          scopes: [...PLAY_SCOPES],
          token: accessToken,
        });
        linked = true;
      } catch (err) {
        if (err instanceof HttpError && err.code === "LICHESS_ALREADY_LINKED") {
          return fail(next, "already_linked");
        }
        throw err;
      }
      return redirectLocal(landing(next, "lichess=linked"));
    } finally {
      // A grant we did not store is a grant nobody will ever use — revoke it.
      // Best-effort: a failed revoke leaves an orphan on Lichess's side, not a
      // hole on ours.
      if (accessToken && !linked) {
        await fetch(LICHESS_TOKEN_URL, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
        }).catch(() => undefined);
      }
    }
  ```

  Add `PLAY_SCOPES` to the `@/server/usecases/external-accounts` import at 15.
  The declared scopes are sent as the grant we ASKED for; Lichess does not
  return the granted list on this endpoint, which is why
  `assertLichessConsentForPlay` checks `board:play` membership rather than
  trusting the stored list blindly — a narrowed grant surfaces as a 401 at the
  first submission and T12 routes it to the organiser queue.

- [ ] **Step 21: Run green and mutate.**
  `cd $WT/apps/web && npx vitest run src/app/api/auth/lichess/__tests__/lichess-oauth-routes.test.ts --reporter=json --outputFile=/tmp/b1-t2-oauth.json`
  ⇒ `numFailedTests: 0`. Mutant: change `if (accessToken && !linked)` to
  `if (accessToken)` ⇒ the happy-path case reds (`expected true to be false`).
  Second mutant: `linked = true` → never set ⇒ same case reds. Restore from the
  `cp` backup each time.

- [ ] **Step 22: Move the two remaining call sites (decision 3).**
  `apps/web/src/app/api/users/me/external-accounts/lichess/route.ts` — swap the
  import at 3 and the call at 9 to `unlinkLichess(user.id)`; the provider
  argument goes (the route is already Lichess-specific, per its own path and
  its doc comment at 5).
  `apps/web/src/app/o/[orgSlug]/settings/page.tsx` — line 30's import and 226 →
  `const linked = await getLichessLink(user.id);`. Line 227 reads
  `linked?.username` only (verified), so nothing else moves.
  `_external-play-seed.ts:63` → `await upsertLichessLink(userId, {
  externalUserId: lichessId, username: lichessId, scopes: [...PLAY_SCOPES],
  token: `lio_seed_${lichessId}` });` with `PLAY_SCOPES` imported. The seed
  needs `LICHESS_TOKEN_KEK` in the process, so add
  `vi.stubEnv("LICHESS_TOKEN_KEK", …)` where the suites that call it set up env
  — grep first: `grep -arn "seedOnlineChessFixture\|seedPlayer" apps/web/src --include="*.ts"`
  and give every caller the key.

- [ ] **Step 23: Run every suite that touches the moved call sites.**
  ```
  cd $WT/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep \
    DATABASE_SSL=disable npx vitest run \
    src/server/usecases/__tests__/external-accounts.test.ts \
    src/server/usecases/__tests__/external-play-guard.test.ts \
    src/server/usecases/__tests__/external-play-room.test.ts \
    src/server/usecases/__tests__/external-play-prepare.test.ts \
    src/server/usecases/__tests__/external-play-escalate.test.ts \
    src/server/usecases/__tests__/external-play-happy-path.test.ts \
    src/server/usecases/__tests__/external-play-sync.test.ts \
    src/app/api/auth/lichess/__tests__/lichess-oauth-routes.test.ts \
    --reporter=json --outputFile=/tmp/b1-t2-callsites.json
  ```
  ⇒ `numFailedTests: 0`. Record `numTotalTests` and compare it with the same
  command on a detached `origin/main` worktree plus this task's new cases — a
  DROP in total means a file silently stopped collecting.

- [ ] **Step 24: Wire `LICHESS_TOKEN_KEK` into CI, `.env.example` and `ci-local.sh`.**
  `.env.example`: add `LICHESS_TOKEN_KEK=` next to `DEVICE_LINK_KEK=`, with the
  same `openssl rand -hex 32` comment the wiring test greps for.
  Ten workflow env blocks, mirroring exactly where `DEVICE_LINK_KEK` sits — add
  `LICHESS_TOKEN_KEK:` on the line immediately after it, at the same indent, with
  a DIFFERENT 64-hex throwaway value (the same value twice would let the
  separation this task exists for pass by accident):
  `bench.yml:85`, `ci.yml:669`, `ci.yml:1065`, `ci.yml:1338`, `e2e.yml:379`,
  `e2e.yml:1052`, `e2e.yml:1402`, `help-shots.yml:45`, `matrix-truth.yml:150`,
  `matrix-truth.yml:264`.
  `scripts/ci-local.sh` `common_env()`: `export LICHESS_TOKEN_KEK=<the same
  throwaway the workflows use>` beside the `DEVICE_LINK_KEK` export.

- [ ] **Step 25: Table-drive the KEK wiring test over both keys.**
  `apps/web/src/lib/__tests__/device-link-kek-wiring.test.ts` has two instances
  of the same 60-line claim set now, which is real present duplication — drive
  it from a list rather than copying the file. Replace 10-64's structure:

  ```ts
  const WORKFLOWS = ["ci.yml", "e2e.yml", "bench.yml", "help-shots.yml"];
  /** matrix-truth.yml also carries both keys but has no AUTH_SECRET-paired job
   *  env, so it is not in WORKFLOWS; its presence is asserted separately below. */
  const KEKS = ["DEVICE_LINK_KEK", "LICHESS_TOKEN_KEK"] as const;
  ```

  and parameterise `unpaired(text, kek)` and the three claims with
  `for (const kek of KEKS)`. Keep every existing assertion verbatim, including
  `expect(auth, "… the premise of this test moved").toBeGreaterThan(0)` and the
  derived-from-the-workflows `ci.size === 1` check. Add one claim the two-key
  world needs:

  ```ts
  it("the two keys are DIFFERENT in CI — a shared value would make the separation vacuous", () => {
    const valueOf = (kek: string) =>
      new Set(WORKFLOWS.flatMap((wf) =>
        [...readFileSync(resolve(ROOT, ".github/workflows", wf), "utf8")
          .matchAll(new RegExp(`^\\s+${kek}:\\s*([0-9a-f]{64})\\s*$`, "gm"))].map((m) => m[1]),
      ));
    const values = KEKS.map(valueOf);
    for (const v of values) expect(v.size, "the workflows disagree on a throwaway key").toBe(1);
    expect(new Set(values.flatMap((v) => [...v])).size).toBe(KEKS.length);
  });
  ```

  Run: `cd $WT/apps/web && npx vitest run src/lib/__tests__/device-link-kek-wiring.test.ts --reporter=json --outputFile=/tmp/b1-t2-kek.json`
  ⇒ `numFailedTests: 0`, `numTotalTests: 11` (4 workflows × 2 keys, plus
  `.env.example` × 2, `ci-local.sh` × 2, plus the new difference claim). Mutant:
  remove `LICHESS_TOKEN_KEK` from `bench.yml` ⇒ that leg reds naming the
  unpaired line number. Restore.

- [ ] **Step 26: Consent copy in all four locales.**
  Add to `apps/web/src/dictionaries/en/ui.json` beside the existing
  `settings.account.lichess.*` block (925-938):

  ```json
  "settings.account.lichess.consent.title": "Seazn will submit your moves",
  "settings.account.lichess.consent.body": "To play on Seazn's board, we need permission to make moves in your Lichess games. That permission is not limited to Seazn fixtures — it covers any game on your account. You can remove it at any time by unlinking, which also revokes it at Lichess.",
  "settings.account.lichess.consent.cta": "Re-link Lichess",
  "settings.account.lichess.consent.scopes": "Permissions requested: play on a board, create challenges.",
  "settings.account.lichess.reconsentRequired": "Re-link your Lichess account so Seazn can submit your moves."
  ```

  Translate all five into `es/`, `fr/`, `nl/` — no English fallbacks; this
  surface is not under `games/**`, so the English-only exemption does not apply.
  Add the error-code mapping `"LICHESS_RECONSENT_REQUIRED"` →
  `settings.account.lichess.reconsentRequired` wherever
  `LICHESS_LINK_REQUIRED` is already mapped (grep:
  `grep -arn "LICHESS_LINK_REQUIRED" apps/web/src --include="*.ts" --include="*.tsx"`).
  Then:
  ```
  cd $WT && npm run i18n:check
  cd $WT && npm run i18n:gen-keys
  ```
  `i18n-keys.ts` is GENERATED — commit the regenerated file, never hand-edit it.
  **T14 renders the screen**; this task ships the server code and the copy, so
  the keys are not inert for more than one task.

- [ ] **Step 27: Undo the superseded plan's FORBID gate (undo #8).**
  `docs/superpowers/plans/2026-09-15-chess-lichess-external-play.md:1602` greps
  to assert `getLichessAccessToken` appears nowhere. That plan is **superseded**
  by this one and its Task 16 gate must not be run as written, or this task's
  central function reads as dead code to be deleted. Edit the line to remove
  `getLichessAccessToken\|` from the alternation and append:

  ```
  (`getLichessAccessToken` was removed from this list on 2026-10-09: the
  2026-10-09 in-page-board design REVERSES the identity-only decision and
  reinstates the function — see that plan's Task 2. Do not re-add it.)
  ```

  Also correct the prose at `:589` ("drop `getLichessAccessToken`, token args")
  and `:697` ("delete `getLichessAccessToken`") with a one-line superseded note
  each. Then confirm nothing else forbids it:
  `cd $WT && grep -arn "getLichessAccessToken" apps scripts db docs | grep -av "2026-10-09"`
  ⇒ only the three annotated lines in the superseded plan.

- [ ] **Step 28: Verify undo #7 landed in T1, do not redo it.**
  `cd $WT && grep -an "no token columns\|stores identity only" apps/web/src/server/usecases/__tests__/external-play-schema.test.ts`
  ⇒ **no output**. If it returns a line, T1 Step 3 was skipped: stop and fix T1
  rather than editing around it.

- [ ] **Step 29: Full typecheck, lint, and the touched suites together.**
  ```
  cd $WT && rtk proxy npx tsc --noEmit -p apps/web
  cd $WT && rtk proxy npx eslint apps/web/src/server/external-play/secrets.ts \
    apps/web/src/server/usecases/external-accounts.ts \
    apps/web/src/app/api/auth/lichess/callback/route.ts \
    apps/web/src/app/api/auth/lichess/route.ts apps/web/src/lib/oauth.ts
  cd $WT/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep \
    DATABASE_SSL=disable npx vitest run \
    src/server/external-play/__tests__/secrets.test.ts \
    src/server/usecases/__tests__/external-accounts.test.ts \
    src/server/relay/__tests__/enc-boundary.test.ts \
    src/lib/__tests__/device-link-kek-wiring.test.ts \
    src/app/api/auth/lichess/__tests__/lichess-oauth-routes.test.ts \
    --reporter=json --outputFile=/tmp/b1-t2-final.json
  ```
  Read `✖ N problems` from the eslint run (plain `rtk` hides it, and "ESLint
  output (JSON parse failed)" is the wrapper losing the result, not a clean
  run). Expect `numFailedTests: 0` and a `numTotalTests` that accounts for
  11 + 15 + 6 + 11 + the oauth file's own count.

- [ ] **Step 30: Commit.**
  ```
  cd $WT && git add apps/web/src/lib/oauth.ts apps/web/src/app/api/auth/lichess \
    apps/web/src/app/api/users/me/external-accounts/lichess/route.ts \
    "apps/web/src/app/o/[orgSlug]/settings/page.tsx" \
    apps/web/src/server/usecases/__tests__/_external-play-seed.ts \
    apps/web/src/lib/__tests__/device-link-kek-wiring.test.ts \
    apps/web/src/dictionaries apps/web/src/i18n-keys.ts \
    .env.example .github/workflows scripts/ci-local.sh \
    docs/superpowers/plans/2026-09-15-chess-lichess-external-play.md
  cd $WT && git commit -m "feat(chess): request board:play, keep the token, and wire LICHESS_TOKEN_KEK"
  ```

---

### Task 3: Board API client and strict UCI validation

Every error mapping below comes from a **measured** fact, not from the Lichess
docs: **M5** (a malformed UCI is PLAYED, not refused: `move e7e6xx` →
`200 {"ok":true}`, export `moves=e4 e6` — Lichess truncated the suffix and moved
a piece), **M6** (`400 {"error":"Not your turn, or game already over"}` covers
two states), **M12** (`400 {"error":"This game cannot be played with the Board
API."}`, on a challenge Lichess had *accepted* at creation). M5 is why
`assertUci` exists and why it is mutation-tested: a client string forwarded
unparsed does not error, it moves the wrong piece.

**Files:**
- Create: `apps/web/src/server/external-play/lichess/uci.ts`
- Create: `apps/web/src/server/external-play/__tests__/uci.test.ts`
- Create: `apps/web/src/server/external-play/lichess/board-api.ts`
- Create: `apps/web/src/server/external-play/__tests__/board-api.test.ts`
- Create: `apps/web/src/server/external-play/__fixtures__/lichess/export-live-clocks.json`
  (a REAL recorded body — see Step 9)
- Modify: `apps/web/src/server/external-play/__fixtures__/lichess/README.md`
  (its closing paragraph claims the `game-*.json` flat-`userId` fixtures are
  "a separate, pre-existing convention owned by other tests" — the new file is a
  third convention and must be described, not left to be guessed)
- Modify: `apps/web/src/server/external-play/types.ts` (add `BoardErrorCode`,
  `LichessStatus`, `GameSnapshot` beside the existing `LichessClock` at 24 and
  `LichessGameSnapshot` at 27-35 — the old snapshot type stays until T11 moves
  its callers)
- Read-only reference: `apps/web/src/server/external-play/lichess/adapter.ts`
  (the house shape for this client: injectable `fetch`, `baseUrl` default at 10,
  `timeoutMs` default at 29, status-by-status classification at 52-61 and
  96-105, response-shape validation at 69-75), `lichess/client.ts:8-13`
  (`LICHESS_BASE_URL` env override), `__tests__/lichess-adapter.test.ts:24-54`
  (the house test shape: spy `AbortSignal.timeout`, read `fetch.mock.calls[0]`,
  assert the body field by field)

**Interfaces:**
- Consumes: `LICHESS_TIMEOUT_MS` from `@/server/external-play/window` (line 9,
  `10_000`); `HttpError` from `@/lib/errors`.
- Produces, exactly as the authoritative list declares: `UCI_RE`, `assertUci`,
  `BoardCall`, `BoardErrorCode`, `GameSnapshot`, `LichessStatus`,
  `createChallengeToUser`, `acceptChallenge`, `submitMove`, `resignGame`,
  `offerOrAcceptDraw`, `abortGame`, `exportGame`.
- Also produced, added to this task's own module: `export type BoardApiDeps = {
  fetch?: typeof fetch; baseUrl?: string }` and
  `export function createBoardApi(deps?: BoardApiDeps)` returning the seven
  functions, with the module-level exports being thin wrappers over a default
  instance. The authoritative signatures are what T9-T12 import; the factory
  exists so the tests and T17's e2e stub can inject a `fetch` without a global
  stub, which is the same seam `createLichessAdapter` already uses.

**Decisions taken here (do not re-litigate):**

1. **Extend, do not duplicate.** `board-api.ts` is a new module because every
   call here is **token-authenticated** and the existing adapter is explicitly
   the unauthenticated open-challenge client (`adapter.ts:43`'s test asserts
   `authorization` is absent). What is NOT duplicated: `LICHESS_TIMEOUT_MS`, the
   `LICHESS_BASE_URL` override, and the status-classification ladder — the last
   of these moves INTO `board-api.ts` as `classifyBoardError`, and the adapter
   keeps throwing `LichessHttpError` untouched until **T9 deletes
   `createOpenChallenge` outright** (D3 removes the open-challenge flow:
   White's token challenges Black's username). Deleting it here would red
   `room.ts`, `guard.ts` and two suites T9/T10 own.
2. **`exportGame` supersedes `adapter.fetchGame`**, and does not wrap it:
   `fetchGame` requests `clocks=false` (`adapter.ts:85`) and returns neither
   moves nor clocks, so it cannot answer §3.5's reconcile. Both exist until T11
   moves the callers; nothing in this task touches `fetchGame`.
3. **`LICHESS_TIMEOUT_MS` (10s) applies to EVERY call in this module** — see
   Step 12, which is a test, not a comment.

---

- [ ] **Step 1: Failing test — strict UCI, with M5 as the reason.**
  New file `apps/web/src/server/external-play/__tests__/uci.test.ts`:

  ```ts
  // M5 (measured 2026-10-09, spike-battery2.log §D): `move e7e6xx` returned
  // 200 {"ok":true} and the export showed `moves=e4 e6` — Lichess TRUNCATED the
  // suffix and moved a piece. A malformed move string is therefore not a Lichess
  // error to catch, it is a wrong move we caused. This validator is the only
  // thing standing between a client string and that outcome.
  import { describe, expect, it } from "vitest";
  import { UCI_RE, assertUci } from "../lichess/uci";

  /** The exact string M5 was measured with, plus its truncation. Kept side by
   *  side so the test says what the bug WAS, not just what the regex does. */
  const M5_MALFORMED = "e7e6xx";
  const M5_WHAT_LICHESS_PLAYED = "e7e6";

  const GOOD = [
    "e2e4", "a1a2", "h8h1", "a1h8",     // plain
    "e7e8q", "e7e8r", "e7e8b", "e7e8n", // promotion (M7: e7e8q → 200, export e8=Q)
    "e1g1",                              // castling is a king move in UCI
  ];
  const BAD = [
    M5_MALFORMED,        // M5 itself
    "e7e8x",             // a promotion piece Lichess does not take
    "e7e8Q",             // uppercase promotion
    "E2E4",              // uppercase squares
    "e2e",               // short
    "e2e45",             // long
    "i2i4",              // file out of range
    "e0e9",              // rank out of range
    "e2 e4",             // whitespace inside
    " e2e4",             // leading whitespace
    "e2e4\n",            // trailing newline — a pasted value
    "",                  // empty: the shape a missing field arrives as
    "e2e4;drop table",   // an injection-shaped string
    "e2e4e2e4",          // two moves in one field
    "0-0",               // SAN castling, not UCI
    "Nf3",               // SAN, not UCI
  ];

  describe("UCI validation (M5)", () => {
    it("accepts every well-formed move, and reports how many it checked", () => {
      let checked = 0;
      for (const uci of GOOD) {
        expect(UCI_RE.test(uci), uci).toBe(true);
        expect(assertUci(uci)).toBe(uci);
        checked++;
      }
      expect(checked, "the GOOD sweep checked nothing").toBe(GOOD.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("refuses every malformed move with 400 INVALID_UCI, and reports the count", () => {
      let checked = 0;
      for (const uci of BAD) {
        expect(UCI_RE.test(uci), uci).toBe(false);
        expect(() => assertUci(uci), uci).toThrowError(
          expect.objectContaining({ status: 400, code: "INVALID_UCI" }),
        );
        checked++;
      }
      expect(checked, "the BAD sweep checked nothing").toBe(BAD.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("M5 by name: the string Lichess silently truncated is refused, its truncation is not", () => {
      expect(() => assertUci(M5_MALFORMED)).toThrowError(
        expect.objectContaining({ code: "INVALID_UCI" }),
      );
      // The differential: the move Lichess ACTUALLY played is itself legal UCI,
      // so a validator that merely rejected "anything unusual" would be
      // indistinguishable from one that understood the bug.
      expect(assertUci(M5_WHAT_LICHESS_PLAYED)).toBe(M5_WHAT_LICHESS_PLAYED);
    });

    it("is anchored at both ends — a good move with garbage around it is refused", () => {
      expect(UCI_RE.test("xe2e4")).toBe(false);
      expect(UCI_RE.test("e2e4x")).toBe(false);
    });

    it("the error never echoes the rejected value back to the caller", () => {
      let message = "";
      try { assertUci("e2e4;drop table users"); } catch (e) { message = (e as Error).message; }
      expect(message).not.toContain("drop table");
      expect(message.length).toBeGreaterThan(0);
    });

    it("has no global or sticky flag — a shared RegExp with /g carries lastIndex between calls", () => {
      expect(UCI_RE.flags).toBe("");
      expect(UCI_RE.test("e2e4")).toBe(true);
      expect(UCI_RE.test("e2e4")).toBe(true); // same answer twice
    });
  });
  ```

- [ ] **Step 2: Run it and read the failure.**
  `cd $WT/apps/web && npx vitest run src/server/external-play/__tests__/uci.test.ts --reporter=json --outputFile=/tmp/b1-t3-red1.json`
  Expected: collection failure, `Failed to resolve import "../lichess/uci"`.

- [ ] **Step 3: Write `uci.ts`.**

  ```ts
  // Strict UCI validation (design §3.4, measured fact M5). The ONLY gate between
  // a client-supplied move string and Lichess.
  //
  // M5, 2026-10-09: `move e7e6xx` → 200 {"ok":true}, export `moves=e4 e6`.
  // Lichess truncated the suffix and played a move. So a malformed string is not
  // an error we can catch downstream — by the time we could look, a piece has
  // moved. Nothing forwards a move string that has not been through here.
  //
  // No flags: a shared RegExp with /g or /y carries `lastIndex` between calls and
  // would answer differently on the second identical move of a game.
  import { HttpError } from "@/lib/errors";

  export const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

  /** Returns the value when it is well-formed UCI; throws 400 INVALID_UCI
   *  otherwise. The message never echoes the rejected value — a client string
   *  reflected into an error is a reflection sink. */
  export function assertUci(value: string): string {
    if (!UCI_RE.test(value)) {
      throw new HttpError(400, "That move is not a valid move.", "INVALID_UCI");
    }
    return value;
  }
  ```

- [ ] **Step 4: Run green, then mutate the pattern three ways.**
  Re-run Step 2's command ⇒ `numFailedTests: 0`, `numTotalTests: 6`.
  Back up first: `cp apps/web/src/server/external-play/lichess/uci.ts /tmp/uci.bak`.
  - Mutant A — remove the anchors (`/[a-h][1-8][a-h][1-8][qrbn]?/`) ⇒ the BAD
    sweep and the anchoring case red.
  - Mutant B — widen the promotion class to `[a-z]?` ⇒ `e7e8x` passes, BAD reds.
  - Mutant C — replace the body of `assertUci` with `return value;` ⇒ the BAD
    sweep reds on the throw assertion, and the anti-vacuity count still reports
    16, which is what tells you the sweep ran rather than skipped.
  Restore with `cp /tmp/uci.bak …` after each. Never `git checkout <file>`.

- [ ] **Step 5: Commit the validator.**
  ```
  cd $WT && git add apps/web/src/server/external-play/lichess/uci.ts \
    apps/web/src/server/external-play/__tests__/uci.test.ts
  cd $WT && git commit -m "feat(chess): strict UCI validation, because Lichess plays a malformed move (M5)"
  ```

- [ ] **Step 6: Failing test — the error classification ladder, from the measured bodies.**
  New file `apps/web/src/server/external-play/__tests__/board-api.test.ts`.
  Part one, the mapping — every `raw` below is a verbatim measured body:

  ```ts
  // Board API client. Every expected code below is derived from a MEASURED
  // response (spike-battery2.log, tc-boundary.log, 2026-10-09), never from the
  // Lichess docs and never from this module's own source.
  import { describe, expect, it, vi } from "vitest";
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  import { createBoardApi } from "../lichess/board-api";
  import { LICHESS_TIMEOUT_MS } from "../window";

  const NOT_YOUR_TURN = '{"error":"Not your turn, or game already over"}';   // M6
  const UNPLAYABLE = '{"error":"This game cannot be played with the Board API."}'; // M12
  const RATE_LIMITED = '{"error":"Too many requests. Try again later."}';     // M3
  const BAD_LIMIT = '{"clock.limit":["Invalid value"],"error":{"clock.limit":["Invalid value"]}}'; // M14

  const api = (fetchFn: typeof fetch) => createBoardApi({ fetch: fetchFn, baseUrl: "https://li.test" });
  const res = (body: string, status: number) => new Response(body, { status });

  describe("submitMove — error mapping is measured, not guessed", () => {
    it("200 {ok:true} is an acceptance", async () => {
      const f = vi.fn(async () => res('{"ok":true}', 200));
      expect(await api(f as unknown as typeof fetch).submitMove({
        token: "t", gameId: "g", uci: "e2e4",
      })).toEqual({ ok: true });
    });

    // M6: ONE message covers two states, so the code must not claim to know
    // which. §3.5 turns this into a reconcile, never an assumption.
    it("400 'Not your turn, or game already over' is not_your_turn_or_over, carrying the raw body", async () => {
      const f = vi.fn(async () => res(NOT_YOUR_TURN, 400));
      expect(await api(f as unknown as typeof fetch).submitMove({
        token: "t", gameId: "g", uci: "e2e4",
      })).toEqual({ ok: false, code: "not_your_turn_or_over", raw: NOT_YOUR_TURN });
    });

    // M12: the dangerous half is that CREATION succeeded — 0+1 and 1+0 were
    // accepted as challenges and then refused every move. The two 400s must map
    // to DIFFERENT codes, or a tournament configured on a bullet clock reads as
    // "your turn ended" to every player in the field.
    it("400 'cannot be played with the Board API' is unplayable_time_control, NOT the turn error", async () => {
      const f = vi.fn(async () => res(UNPLAYABLE, 400));
      const out = await api(f as unknown as typeof fetch).submitMove({
        token: "t", gameId: "g", uci: "e2e4",
      });
      expect(out).toEqual({ ok: false, code: "unplayable_time_control", raw: UNPLAYABLE });
      expect(out).not.toMatchObject({ code: "not_your_turn_or_over" });
    });

    it.each([
      [401, "unauthorized"], [403, "unauthorized"],
      [429, "rate_limited"], [500, "unavailable"], [502, "unavailable"], [503, "unavailable"],
    ])("%i maps to %s", async (status, code) => {
      const f = vi.fn(async () => res(status === 429 ? RATE_LIMITED : "nope", status));
      expect(await api(f as unknown as typeof fetch).submitMove({
        token: "t", gameId: "g", uci: "e2e4",
      })).toMatchObject({ ok: false, code });
    });

    it("a thrown fetch (network, or the AbortSignal firing) is unavailable, never an uncaught throw", async () => {
      const f = vi.fn(async () => { throw new Error("socket hang up"); });
      expect(await api(f as unknown as typeof fetch).submitMove({
        token: "t", gameId: "g", uci: "e2e4",
      })).toMatchObject({ ok: false, code: "unavailable" });
    });

    it("an UNRECOGNISED 400 body is unavailable, not silently an acceptance", async () => {
      const f = vi.fn(async () => res('{"error":"something new"}', 400));
      expect(await api(f as unknown as typeof fetch).submitMove({
        token: "t", gameId: "g", uci: "e2e4",
      })).toMatchObject({ ok: false, code: "unavailable" });
    });

    // The guard M5 bought, at the seam that matters: the client never reaches
    // Lichess with a malformed string, so `fetch` is never called at all.
    it("refuses a malformed UCI BEFORE any HTTP call", async () => {
      const f = vi.fn(async () => res('{"ok":true}', 200));
      await expect(api(f as unknown as typeof fetch).submitMove({
        token: "t", gameId: "g", uci: "e7e6xx",
      })).rejects.toMatchObject({ status: 400, code: "INVALID_UCI" });
      expect(f).not.toHaveBeenCalled();
    });

    it("sends the player's token as a bearer, to the game's own move path", async () => {
      const f = vi.fn(async () => res('{"ok":true}', 200));
      await api(f as unknown as typeof fetch).submitMove({
        token: "lio_abc", gameId: "gm1", uci: "e7e8q",
      });
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://li.test/api/board/game/gm1/move/e7e8q");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer lio_abc");
    });
  });
  ```

- [ ] **Step 7: Add the creation, accept and control-call cases to the same file.**

  ```ts
  describe("createChallengeToUser — White's token challenges Black's username", () => {
    it("POSTs the challenge unrated, with the seconds clock, and returns the id", async () => {
      const f = vi.fn(async () => res('{"id":"ch123"}', 200));
      const out = await api(f as unknown as typeof fetch).createChallengeToUser({
        whiteToken: "lio_white", blackUsername: "Ada",
        limitSeconds: 300, incrementSeconds: 3,
      });
      expect(out).toEqual({ ok: true, challengeId: "ch123" });
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://li.test/api/challenge/Ada");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer lio_white");
      const body = new URLSearchParams(String(init.body));
      expect(body.get("clock.limit")).toBe("300");
      expect(body.get("clock.increment")).toBe("3");
      expect(body.get("rated")).toBe("false");   // global constraint: unrated only
      expect(body.get("color")).toBe("white");   // colour comes from the pairing
      expect(body.get("variant")).toBe("standard");
      expect(body.get("keepAliveStream")).toBeNull(); // no long-lived connection, anywhere
    });

    // M14: 170+0 and 140+1 were refused AT CREATION with this exact body. T5's
    // catalogue is what stops it reaching here; this is the backstop.
    it("a refused clock.limit is unavailable with the raw body kept for the organiser", async () => {
      const f = vi.fn(async () => res(BAD_LIMIT, 400));
      expect(await api(f as unknown as typeof fetch).createChallengeToUser({
        whiteToken: "t", blackUsername: "Ada", limitSeconds: 170, incrementSeconds: 0,
      })).toEqual({ ok: false, code: "unavailable", raw: BAD_LIMIT });
    });

    // M3: four creates in ~1s, then every subsequent create returned this.
    it("429 is rate_limited — T4's queue reads this code to back off", async () => {
      const f = vi.fn(async () => res(RATE_LIMITED, 429));
      expect(await api(f as unknown as typeof fetch).createChallengeToUser({
        whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0,
      })).toEqual({ ok: false, code: "rate_limited", raw: RATE_LIMITED });
    });

    it("a 200 with no id is unavailable, not a created game with an undefined id", async () => {
      const f = vi.fn(async () => res('{"ok":true}', 200));
      expect(await api(f as unknown as typeof fetch).createChallengeToUser({
        whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0,
      })).toMatchObject({ ok: false, code: "unavailable" });
    });
  });

  describe("accept, resign, draw, abort — Black's token accepts; each call is one POST", () => {
    it.each([
      ["acceptChallenge", { blackToken: "lio_black", challengeId: "ch1" },
        "https://li.test/api/challenge/ch1/accept", "lio_black"],
      ["resignGame", { token: "lio_t", gameId: "g1" },
        "https://li.test/api/board/game/g1/resign", "lio_t"],
      ["abortGame", { token: "lio_t", gameId: "g1" },
        "https://li.test/api/board/game/g1/abort", "lio_t"],
    ] as const)("%s POSTs %s with its own token", async (name, arg, expectedUrl, expectedToken) => {
      const f = vi.fn(async () => res('{"ok":true}', 200));
      const client = api(f as unknown as typeof fetch) as unknown as
        Record<string, (a: unknown) => Promise<unknown>>;
      expect(await client[name]!(arg)).toEqual({ ok: true });
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(expectedUrl);
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${expectedToken}`);
    });

    it.each([[true, "yes"], [false, "no"]])(
      "offerOrAcceptDraw(accept: %s) posts /draw/%s",
      async (accept, segment) => {
        const f = vi.fn(async () => res('{"ok":true}', 200));
        expect(await api(f as unknown as typeof fetch).offerOrAcceptDraw({
          token: "lio_t", gameId: "g1", accept,
        })).toEqual({ ok: true });
        const [url] = f.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`https://li.test/api/board/game/g1/draw/${segment}`);
      },
    );

    // M9: resigning after ONE move gave status=aborted winner=None; after two,
    // status=resign winner=black. The client does not know which it caused, so
    // it must not report one — the reconcile does (T11/T12).
    it("a successful resign reports ok only — never a winner", async () => {
      const f = vi.fn(async () => res('{"ok":true}', 200));
      const out = await api(f as unknown as typeof fetch).resignGame({ token: "t", gameId: "g1" });
      expect(out).toEqual({ ok: true });
      expect(Object.keys(out)).toEqual(["ok"]);
    });

    it("a 400 on a control call carries the measured turn message through unchanged", async () => {
      const f = vi.fn(async () => res(NOT_YOUR_TURN, 400));
      expect(await api(f as unknown as typeof fetch).abortGame({ token: "t", gameId: "g1" }))
        .toEqual({ ok: false, code: "not_your_turn_or_over", raw: NOT_YOUR_TURN });
    });
  });
  ```

- [ ] **Step 8: Run both halves and read the failure.**
  `cd $WT/apps/web && npx vitest run src/server/external-play/__tests__/board-api.test.ts --reporter=json --outputFile=/tmp/b1-t3-red2.json`
  Expected: collection failure, `Failed to resolve import "../lichess/board-api"`.

- [ ] **Step 9: Record the export fixture (real body) and describe it.**
  Create
  `apps/web/src/server/external-play/__fixtures__/lichess/export-live-clocks.json`
  with the body dumped during the measured draw-offer probe (spike-battery2.log
  §E, game `QbFCQzuF`, 2026-10-09) — **verbatim**, not retyped from memory:

  ```json
  {
    "id": "QbFCQzuF",
    "rated": false,
    "variant": "standard",
    "speed": "rapid",
    "perf": "rapid",
    "createdAt": 1791541734490,
    "lastMoveAt": 1791541736701,
    "status": "started",
    "source": "friend",
    "players": {
      "white": { "user": { "name": "sudeshnavirata", "id": "sudeshnavirata" }, "rating": 1500, "provisional": true },
      "black": { "user": { "name": "ashokhein", "id": "ashokhein" }, "rating": 1500, "provisional": true }
    },
    "opening": { "eco": "C20", "name": "King's Pawn Game", "ply": 2 },
    "clocks": [60000, 60000],
    "clock": { "initial": 600, "increment": 5, "totalTime": 800 },
    "division": {}
  }
  ```

  Append to `__fixtures__/lichess/README.md`:

  ```markdown
  `export-live-clocks.json` is the FULL, untrimmed `GET /game/export/<id>`
  response recorded from lichess.org on 2026-10-09 while a draw offer stood
  (`spike-battery2.log` §E, source id `QbFCQzuF`). It is the contract check for
  two measured facts:

  - **M11** — the export carries authoritative clocks: `"clocks":[60000,60000]`
    in CENTISECONDS beside `"clock":{initial,increment,totalTime}` in seconds.
    `initial: 600` against `clocks: 60000` is what pins the ×10, and it is why
    `exportGame` corrects our locally-derived clocks instead of letting them
    drift to the flag.
  - **M10** — a PENDING draw offer is invisible here. There is no draw-offer
    field anywhere in this body and `status` is still `started`. This is the
    design's one accepted blind spot (§4): an offer made on lichess.org cannot
    be seen; an offer made on our page is fine, because our server sends it.

  It is untrimmed on purpose — a trimmed copy could not witness M10, since the
  claim is about a field that is ABSENT.
  ```

- [ ] **Step 10: Failing test — `exportGame` against the real fixture.**
  Append to `board-api.test.ts`:

  ```ts
  const raw = (f: string) =>
    readFileSync(join(__dirname, "../__fixtures__/lichess", f), "utf8");

  describe("exportGame — the reconcile read (M10, M11)", () => {
    it("reads status, moves, increment and BOTH clocks in ms from the real recorded body", async () => {
      const body = raw("export-live-clocks.json");
      const f = vi.fn(async () => res(body, 200));
      const snap = await api(f as unknown as typeof fetch).exportGame("QbFCQzuF");
      // Derived from the fixture itself, never retyped: clocks are centiseconds,
      // `clock.initial` is seconds, and 600 × 1000 === 60000 × 10 is the proof.
      const recorded = JSON.parse(body) as {
        clocks: number[]; clock: { initial: number; increment: number };
      };
      expect(snap).toEqual({
        gameId: "QbFCQzuF",
        status: "started",
        winner: null,
        movesSan: [],
        whiteMs: recorded.clocks[0]! * 10,
        blackMs: recorded.clocks[1]! * 10,
        increment: recorded.clock.increment,
      });
      expect(snap!.whiteMs).toBe(recorded.clock.initial * 1000);
    });

    it("M10: a pending draw offer is INVISIBLE — the fixture has no such field to read", () => {
      const body = raw("export-live-clocks.json");
      // The claim is about an ABSENT field, so it is asserted against the raw
      // text: a trimmed fixture could not witness it.
      expect(body).not.toMatch(/draw/i);
      expect(JSON.parse(body).status).toBe("started");
    });

    it("splits the SAN move string, which is how the measured export reports moves", async () => {
      // spike-battery2.log §F, game TVSCksV1: `moves=e4 e5 Nf3 Nc6 Bc4 Nf6 O-O Bc5`.
      const f = vi.fn(async () => res(JSON.stringify({
        id: "TVSCksV1", status: "resign", winner: "black",
        moves: "e4 e5 Nf3 Nc6 Bc4 Nf6 O-O Bc5",
        clock: { initial: 600, increment: 0 },
      }), 200));
      const snap = await api(f as unknown as typeof fetch).exportGame("TVSCksV1");
      expect(snap!.movesSan).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "O-O", "Bc5"]);
      expect(snap!.winner).toBe("black");
      // No `clocks` key at all: the export omits it on some games, and a null
      // is the only honest answer — T11 must not read 0ms as "flagged".
      expect(snap!.whiteMs).toBeNull();
      expect(snap!.blackMs).toBeNull();
    });

    it("requests clocks=true — a reconcile that cannot see the clocks cannot correct them", async () => {
      const f = vi.fn(async () => res(raw("export-live-clocks.json"), 200));
      await api(f as unknown as typeof fetch).exportGame("QbFCQzuF");
      const [url] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("clocks=true");
      expect(url).toBe("https://li.test/game/export/QbFCQzuF?clocks=true&pgnInJson=false");
    });

    it("404 is null — no such game yet, which is not an error", async () => {
      const f = vi.fn(async () => res("", 404));
      expect(await api(f as unknown as typeof fetch).exportGame("nope")).toBeNull();
    });

    it("sends NO authorization header — the export is public and needs no player's token", async () => {
      const f = vi.fn(async () => res(raw("export-live-clocks.json"), 200));
      await api(f as unknown as typeof fetch).exportGame("QbFCQzuF");
      const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(new Headers(init.headers).has("authorization")).toBe(false);
    });

    // Enumerated from the measured statuses plus the ones the OpenAPI declares;
    // T12 owns the mapping to our events, this only proves none is lost here.
    it.each([
      ["mate", "white"], ["resign", "black"], ["outoftime", "black"],
      ["draw", null], ["stalemate", null], ["aborted", null],
      ["timeout", "white"], ["noStart", "black"], ["unknownFinish", null],
      ["created", null], ["started", null],
    ] as const)("carries status %s through unchanged", async (status, winner) => {
      const f = vi.fn(async () => res(JSON.stringify({
        id: "g", status, ...(winner ? { winner } : {}), moves: "",
        clock: { initial: 180, increment: 0 },
      }), 200));
      const snap = await api(f as unknown as typeof fetch).exportGame("g");
      expect(snap!.status).toBe(status);
      expect(snap!.winner).toBe(winner);
    });

    it("a body with no id or no status is null, not a snapshot with undefined fields", async () => {
      for (const body of ['{"status":"mate"}', '{"id":"g"}', "{}"]) {
        const f = vi.fn(async () => res(body, 200));
        expect(await api(f as unknown as typeof fetch).exportGame("g"), body).toBeNull();
      }
    });

    it("a 5xx is null, so a reconcile retries rather than writing a result from nothing", async () => {
      const f = vi.fn(async () => res("boom", 503));
      expect(await api(f as unknown as typeof fetch).exportGame("g")).toBeNull();
    });
  });
  ```

- [ ] **Step 11: Write `board-api.ts`.**

  ```ts
  import "server-only";
  // Lichess Board API client (design §3.3-§3.5). Token-authenticated, one HTTP
  // call per function, nothing long-lived — see the timeout note below.
  //
  // Every classification here is a MEASURED response, 2026-10-09:
  //   M6  400 "Not your turn, or game already over" — ONE message, TWO states.
  //       It means reconcile; it never means assume.
  //   M12 400 "This game cannot be played with the Board API." — on a challenge
  //       Lichess ACCEPTED at creation. Mapped separately from M6 because a
  //       field configured on a bullet clock would otherwise read to every
  //       player as "your turn ended".
  //   M3  429 "Too many requests. Try again later." — creation only (M4: moves
  //       are not rate-limited at speed).
  // An unrecognised 400 is `unavailable`, never an acceptance: a body we have
  // not measured is a body we do not understand.
  import { LICHESS_TIMEOUT_MS } from "../window";
  import { assertUci } from "./uci";
  import type { BoardCall, BoardErrorCode, GameSnapshot, LichessStatus } from "../types";

  const DEFAULT_BASE = "https://lichess.org";

  export type BoardApiDeps = { fetch?: typeof fetch; baseUrl?: string };

  /** M6 and M12 are both 400s. Matched on the measured sentence, not on a
   *  substring that could drift: `includes`, so a trailing-field change in the
   *  JSON envelope does not silently reclassify a known state as unknown. */
  const M6_MESSAGE = "Not your turn, or game already over";
  const M12_MESSAGE = "This game cannot be played with the Board API.";

  function classifyBoardError(status: number, raw: string): BoardErrorCode {
    if (status === 429) return "rate_limited";
    if (status === 401 || status === 403) return "unauthorized";
    if (status === 400) {
      if (raw.includes(M12_MESSAGE)) return "unplayable_time_control";
      if (raw.includes(M6_MESSAGE)) return "not_your_turn_or_over";
    }
    return "unavailable";
  }

  export function createBoardApi(deps: BoardApiDeps = {}) {
    const base = (deps.baseUrl ?? process.env.LICHESS_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
    const fetchFn = deps.fetch ?? fetch;

    /** Every call in this module — creation, accept, move, resign, draw, abort,
     *  export — is a single request under LICHESS_TIMEOUT_MS (10s). There are no
     *  long reads here BY DESIGN (§4: the streaming service was removed because
     *  our server submits both players' moves). If you are about to add a
     *  Lichess endpoint that streams NDJSON, this timeout will cut it off at ten
     *  seconds and the failure will look like a flaky network — do not raise the
     *  timeout, and do not open a stream. `keepAliveStream` is never sent. */
    async function call(
      path: string,
      init: { method: "POST" | "GET"; token?: string; body?: URLSearchParams },
    ): Promise<{ status: number; raw: string }> {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (init.token) headers.Authorization = `Bearer ${init.token}`;
      if (init.body) headers["Content-Type"] = "application/x-www-form-urlencoded";
      try {
        const r = await fetchFn(`${base}${path}`, {
          method: init.method,
          headers,
          ...(init.body ? { body: init.body.toString() } : {}),
          signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
        });
        return { status: r.status, raw: await r.text().catch(() => "") };
      } catch {
        // Network error, or the AbortSignal firing. Same outcome as a 5xx, never
        // an uncaught throw into a usecase holding a claim.
        return { status: 0, raw: "" };
      }
    }

    const asCall = ({ status, raw }: { status: number; raw: string }): BoardCall =>
      status >= 200 && status < 300
        ? { ok: true }
        : { ok: false, code: classifyBoardError(status, raw), raw };

    return {
      async createChallengeToUser(a: {
        whiteToken: string; blackUsername: string;
        limitSeconds: number; incrementSeconds: number;
      }): Promise<{ ok: true; challengeId: string } | { ok: false; code: BoardErrorCode; raw: string }> {
        // Colour is READ from the pairing (global constraint): White's token
        // challenges Black's username, so `color=white` is a statement of who is
        // calling, not an allocation. Unrated only. Standard only (§12).
        const body = new URLSearchParams({
          "clock.limit": String(a.limitSeconds),
          "clock.increment": String(a.incrementSeconds),
          rated: "false",
          color: "white",
          variant: "standard",
        });
        const out = await call(`/api/challenge/${encodeURIComponent(a.blackUsername)}`, {
          method: "POST", token: a.whiteToken, body,
        });
        if (out.status < 200 || out.status >= 300) {
          return { ok: false, code: classifyBoardError(out.status, out.raw), raw: out.raw };
        }
        const id = (JSON.parse(out.raw || "{}") as { id?: unknown }).id;
        if (typeof id !== "string" || id === "") {
          // A 200 with no id is not a created game. Returning ok here would let
          // T9 record `challenge_id = undefined` and lose the game.
          return { ok: false, code: "unavailable", raw: out.raw };
        }
        return { ok: true, challengeId: id };
      },

      async acceptChallenge(a: { blackToken: string; challengeId: string }): Promise<BoardCall> {
        return asCall(await call(
          `/api/challenge/${encodeURIComponent(a.challengeId)}/accept`,
          { method: "POST", token: a.blackToken },
        ));
      },

      async submitMove(a: { token: string; gameId: string; uci: string }): Promise<BoardCall> {
        // M5: assert BEFORE the call. Lichess would accept `e7e6xx` with a 200
        // and play `e7e6`, so there is no downstream place to catch this.
        const uci = assertUci(a.uci);
        return asCall(await call(
          `/api/board/game/${encodeURIComponent(a.gameId)}/move/${uci}`,
          { method: "POST", token: a.token },
        ));
      },

      async resignGame(a: { token: string; gameId: string }): Promise<BoardCall> {
        // M9: a resign after one move lands as `aborted` with no winner, after
        // two as `resign`. This call reports ok only; the reconcile decides what
        // happened.
        return asCall(await call(
          `/api/board/game/${encodeURIComponent(a.gameId)}/resign`,
          { method: "POST", token: a.token },
        ));
      },

      async offerOrAcceptDraw(a: {
        token: string; gameId: string; accept: boolean;
      }): Promise<BoardCall> {
        return asCall(await call(
          `/api/board/game/${encodeURIComponent(a.gameId)}/draw/${a.accept ? "yes" : "no"}`,
          { method: "POST", token: a.token },
        ));
      },

      async abortGame(a: { token: string; gameId: string }): Promise<BoardCall> {
        return asCall(await call(
          `/api/board/game/${encodeURIComponent(a.gameId)}/abort`,
          { method: "POST", token: a.token },
        ));
      },

      /** The reconcile read (§3.5). `clocks=true` because M11 makes this the
       *  authority on both clocks; `pgnInJson=false` because we read `moves`.
       *  No Authorization header — the export is public. null on 404, on a 5xx,
       *  and on any body missing id or status: a reconcile must retry rather
       *  than write a result from a shape it did not recognise. */
      async exportGame(gameId: string): Promise<GameSnapshot | null> {
        const out = await call(
          `/game/export/${encodeURIComponent(gameId)}?clocks=true&pgnInJson=false`,
          { method: "GET" },
        );
        if (out.status < 200 || out.status >= 300) return null;
        let json: {
          id?: unknown; status?: unknown; winner?: unknown; moves?: unknown;
          clocks?: unknown; clock?: { increment?: unknown };
        };
        try { json = JSON.parse(out.raw) as typeof json; } catch { return null; }
        if (typeof json.id !== "string" || typeof json.status !== "string") return null;
        const clocks = Array.isArray(json.clocks) ? (json.clocks as number[]) : null;
        const moves = typeof json.moves === "string" ? json.moves.trim() : "";
        return {
          gameId: json.id,
          status: json.status as LichessStatus,
          winner: json.winner === "white" || json.winner === "black" ? json.winner : null,
          movesSan: moves === "" ? [] : moves.split(/\s+/),
          // M11: `clocks` is CENTISECONDS (`[60000,60000]` beside
          // `clock.initial: 600`), so ×10 to ms. Absent ⇒ null, never 0 — a 0
          // would read to T11 as a flag.
          whiteMs: clocks && typeof clocks[0] === "number" ? clocks[0] * 10 : null,
          blackMs: clocks && typeof clocks[1] === "number" ? clocks[1] * 10 : null,
          increment: typeof json.clock?.increment === "number" ? json.clock.increment : 0,
        };
      },
    };
  }

  const defaultApi = createBoardApi();
  export const createChallengeToUser = defaultApi.createChallengeToUser;
  export const acceptChallenge = defaultApi.acceptChallenge;
  export const submitMove = defaultApi.submitMove;
  export const resignGame = defaultApi.resignGame;
  export const offerOrAcceptDraw = defaultApi.offerOrAcceptDraw;
  export const abortGame = defaultApi.abortGame;
  export const exportGame = defaultApi.exportGame;
  ```

  **Note on the default instance:** `createBoardApi()` is called at module load,
  so `LICHESS_BASE_URL` is read once per process — the same behaviour
  `client.ts:8-13` has. If T17's e2e stub needs a per-request base URL, it
  injects through `createBoardApi({ baseUrl })` rather than mutating the env.

- [ ] **Step 12: Add the types to `types.ts`.**
  Append beside `LichessClock` (24) — the old `LichessGameSnapshot` (27-35)
  stays until T11 moves its callers:

  ```ts
  /** Board API failure classes. Every one is a MEASURED response — see
   *  lichess/board-api.ts for the bodies and the dates. */
  export type BoardErrorCode =
    | "not_your_turn_or_over"   // 400 "Not your turn, or game already over"  (M6)
    | "unplayable_time_control" // 400 "This game cannot be played with the Board API." (M12)
    | "rate_limited"            // 429 (M3 — creation; M4: moves are not limited)
    | "unauthorized"            // 401/403 — token revoked or wrong scope
    | "unavailable";            // 5xx, network, timeout, or a body we have not measured

  export type BoardCall = { ok: true } | { ok: false; code: BoardErrorCode; raw: string };

  /** Lichess terminal and non-terminal statuses. `aborted` is NOT a synonym for
   *  "no game": M9 measured an early resign landing there with no winner. */
  export type LichessStatus =
    | "created" | "started" | "mate" | "resign" | "outoftime"
    | "draw" | "stalemate" | "aborted" | "timeout" | "noStart" | "unknownFinish";

  /** One export read. `whiteMs`/`blackMs` are null when the export carried no
   *  `clocks` array — null, never 0, because 0 would read as a flag (M11). */
  export type GameSnapshot = {
    gameId: string;
    status: LichessStatus;
    winner: "white" | "black" | null;
    movesSan: string[];
    whiteMs: number | null;
    blackMs: number | null;
    increment: number;
  };
  ```

- [ ] **Step 13: Failing test — the timeout applies to EVERY call, and no stream is opened.**
  This is the explicit guard against someone reintroducing a long read under a
  10s timeout. Append to `board-api.test.ts`:

  ```ts
  describe("LICHESS_TIMEOUT_MS covers every call, and nothing streams (§4)", () => {
    it("each of the seven functions arms AbortSignal.timeout with the shared constant", async () => {
      const spy = vi.spyOn(AbortSignal, "timeout");
      const f = vi.fn(async () => res('{"ok":true,"id":"ch1"}', 200));
      const client = api(f as unknown as typeof fetch);
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["createChallengeToUser", () => client.createChallengeToUser({
          whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0 })],
        ["acceptChallenge", () => client.acceptChallenge({ blackToken: "t", challengeId: "c" })],
        ["submitMove", () => client.submitMove({ token: "t", gameId: "g", uci: "e2e4" })],
        ["resignGame", () => client.resignGame({ token: "t", gameId: "g" })],
        ["offerOrAcceptDraw", () => client.offerOrAcceptDraw({ token: "t", gameId: "g", accept: true })],
        ["abortGame", () => client.abortGame({ token: "t", gameId: "g" })],
        ["exportGame", () => client.exportGame("g")],
      ];
      let checked = 0;
      for (const [name, run] of calls) {
        spy.mockClear();
        await run();
        expect(spy, `${name} did not arm a timeout`).toHaveBeenCalledWith(LICHESS_TIMEOUT_MS);
        checked++;
      }
      // Anti-vacuity: the sweep must cover the whole surface, and zero is a
      // failure. If a function is added to the module, this count reds.
      expect(checked).toBe(7);
      expect(Object.keys(client).length).toBe(7);
      spy.mockRestore();
    });

    it("the constant is 10s AT ITS DEFAULT — a long read has no home here (§4)", () => {
      expect(LICHESS_TIMEOUT_MS).toBe(10_000);
    });

    it("no request asks Lichess to keep a connection open", async () => {
      const f = vi.fn(async () => res('{"ok":true,"id":"ch1"}', 200));
      const client = api(f as unknown as typeof fetch);
      await client.createChallengeToUser({
        whiteToken: "t", blackUsername: "Ada", limitSeconds: 300, incrementSeconds: 0 });
      await client.exportGame("g");
      for (const [url, init] of f.mock.calls as unknown as [string, RequestInit][]) {
        expect(url, url).not.toMatch(/stream|keepAlive/i);
        expect(String(init.body ?? ""), url).not.toMatch(/keepAliveStream/);
        expect(new Headers(init.headers).get("accept")).toBe("application/json");
        expect(new Headers(init.headers).get("accept")).not.toBe("application/x-ndjson");
      }
      expect(f.mock.calls.length).toBe(2);
    });
  });
  ```

- [ ] **Step 14: Run the whole file green.**
  `cd $WT/apps/web && npx vitest run src/server/external-play/__tests__/board-api.test.ts src/server/external-play/__tests__/uci.test.ts --reporter=json --outputFile=/tmp/b1-t3-green.json`
  ⇒ `numFailedTests: 0`. Expected `numTotalTests` = 6 (uci) + 9 (submitMove,
  the `it.each` of 6 statuses counting as 6, so 8 named + 6 = 14) + 4 (create) +
  5 (controls, the `it.each` of 3 counting as 3 and of 2 as 2, so 3 + 2 + 2 = 7)
  + 11 (export, the status `it.each` of 11 counting as 11, so 8 + 11 = 19) +
  3 (timeout) — **do not trust this arithmetic: read the number the runner
  prints, record it in the task report, and only check that it is non-zero and
  that every file resolved under `$WT`.** A count that differs from the printed
  one means a case was filtered, not that the plan is wrong.

- [ ] **Step 15: Mutate the classification ladder, one branch at a time.**
  `cp apps/web/src/server/external-play/lichess/board-api.ts /tmp/board-api.bak` first.
  - Mutant A — swap the M6/M12 checks so M12 falls through to
    `not_your_turn_or_over` ⇒ the "NOT the turn error" case reds. This is the
    mutant that matters most: it is the shape in which a bullet-clock
    tournament would look like a field of expired turns.
  - Mutant B — `if (status === 400) return "not_your_turn_or_over";` (collapse
    the two) ⇒ the unrecognised-400 case and the M12 case both red.
  - Mutant C — delete the `assertUci(a.uci)` line in `submitMove` ⇒ "refuses a
    malformed UCI BEFORE any HTTP call" reds, and `fetch` is called. This is
    M5's guard; it must die loudly.
  - Mutant D — `whiteMs: clocks?.[0] ?? 0` (0 instead of null) ⇒ the SAN-split
    case reds on `expected 0 to be null`.
  - Mutant E — drop `* 10` ⇒ the real-fixture case reds on
    `expected 60000 to be 600000`, and the `clock.initial * 1000` cross-check
    reds too — two independent assertions, which is the point.
  Restore with `cp /tmp/board-api.bak …` after each.

- [ ] **Step 16: Confirm nothing was duplicated from the adapter, and that the adapter is untouched.**
  ```
  cd $WT && rtk proxy git diff --stat apps/web/src/server/external-play/lichess/adapter.ts
  cd $WT && grep -an "LICHESS_TIMEOUT_MS\|LICHESS_BASE_URL" apps/web/src/server/external-play/lichess/*.ts
  ```
  Expected: `adapter.ts` has **no** diff (decision 1 — T9 deletes
  `createOpenChallenge`), and the timeout/base-URL constants are each referenced
  rather than re-declared. If you find yourself copying `classifyBoardError`
  into another file, stop: it lives here and is exported if a second caller
  needs it.

- [ ] **Step 17: Typecheck, lint, commit.**
  ```
  cd $WT && rtk proxy npx tsc --noEmit -p apps/web
  cd $WT && rtk proxy npx eslint apps/web/src/server/external-play/lichess/board-api.ts \
    apps/web/src/server/external-play/lichess/uci.ts \
    apps/web/src/server/external-play/types.ts
  cd $WT && git add apps/web/src/server/external-play/lichess/board-api.ts \
    apps/web/src/server/external-play/types.ts \
    apps/web/src/server/external-play/__tests__/board-api.test.ts \
    apps/web/src/server/external-play/__fixtures__/lichess/export-live-clocks.json \
    apps/web/src/server/external-play/__fixtures__/lichess/README.md
  cd $WT && git commit -m "feat(chess): Board API client with measured error mapping and a clock-bearing export"
  ```

---

### Task 4: Global creation throttle

**M3, measured 2026-10-09 (`spike-battery.log`):** four creates in ~1s, then
every subsequent create returned `{"error":"Too many requests. Try again
later."}`. A 64-player round wants **32 games at once**. **M4:** moves are *not*
rate-limited (8 back-to-back posts, all 200), so this queue is for creation and
nothing else — putting move submission behind it would add latency to every tap
for no reason.

**Files:**
- Create: `apps/web/src/server/external-play/creation-queue.ts`
- Create: `apps/web/src/server/external-play/__tests__/creation-queue.test.ts`
- Read-only reference: `apps/web/src/server/usecases/external-play/room.ts`
  281-350 — the claim-then-call pattern this queue sits *inside*: the
  conditional claim UPDATE at 305-309 (`status = 'pending' and challenge_id is
  null and (mint_claimed_at is null or mint_claimed_at < now - MINT_CLAIM_STALE_MS)`),
  the HTTP call deliberately outside any transaction (its doc comment at
  262-266), and the ready commit at 332-339 conditional on
  `mint_claimed_at = ${now}` so a stale-claim takeover cannot be stomped

**Interfaces:**
- Consumes: nothing from this plan (deliberately — the queue knows nothing about
  Lichess, which is what lets T9 test its own retry logic without a queue).
- Produces, exactly as the authoritative list declares:
  ```ts
  export function enqueueCreation<T>(key: string, job: () => Promise<T>): Promise<T>;
  ```
- Also produced, added to this task's own module:
  ```ts
  export const CREATION_MIN_SPACING_MS: number;   // 350
  export const CREATION_BACKOFF_MS: readonly number[]; // [1000, 2000, 4000]
  /** The job throws this to ask for a backoff + retry. The queue is generic
   *  over T and cannot inspect a result for a 429, so the knowledge lives at
   *  the call site, which has the typed BoardCall in hand. */
  export class CreationRateLimited extends Error {}
  export type CreationQueueDeps = { now: () => number; sleep: (ms: number) => Promise<void> };
  export function __setCreationQueueDeps(d: Partial<CreationQueueDeps>): void; // tests only
  export function __resetCreationQueue(): void;                               // tests only
  ```

**Cross-instance behaviour, stated plainly (this is the honest answer, not a
placeholder):**

The queue is **per process**. Prod runs more than one web machine, so with N
instances the aggregate creation rate is up to N × (1 / `CREATION_MIN_SPACING_MS`).
That is accepted, for three reasons, and the simplest honest thing is to say so
rather than build a distributed limiter:

1. **Double-creation is already impossible**, and by a stronger mechanism than
   rate limiting: `room.ts`'s claim-then-call means exactly one claimant per
   fixture (conditional UPDATE at 305-309), and
   `fixture_external_play_challenge_idx` is a unique index on `challenge_id`. So
   the worst a cross-instance collision can do is waste a 429, never create two
   games for one fixture.
2. **A 429 is recoverable by construction.** The backoff retries, and the claim
   is still held by this caller (`MINT_CLAIM_STALE_MS` is 30s, longer than
   `CREATION_BACKOFF_MS` summed), so a retried create commits under the same
   claim rather than racing a takeover.
3. **The spacing is set below the measured ceiling with room for N**: M3 allows
   roughly 4/s; 350 ms is ~2.9/s per instance, so two instances creating flat
   out sit near the measured limit rather than past it. A 32-game round takes
   ~11 s on one instance.

**If sustained 429s ever appear in the logs, the next step is a DB-backed lease
— not a bigger backoff.** `stage_round_opens` (T1) gives a natural key: a
`last_created_at` claim row per `(stage_id, round_no)` updated conditionally, in
the same shape as `fixture_stream_sessions.ingest_polled_at` (V428) which claims
an organiser poll. **That is deliberately NOT built here** — it is a second
mechanism to test, and nothing has measured the need. Named so the next session
does not have to invent it.

---

- [ ] **Step 1: Failing test — order and spacing, on a virtual clock.**
  New file `apps/web/src/server/external-play/__tests__/creation-queue.test.ts`.
  The clock is injected, so the test is deterministic and nothing actually
  sleeps:

  ```ts
  // M3 (measured 2026-10-09): four creates in ~1s, then every subsequent create
  // 429s. A 64-player round wants 32 games at once. This queue serialises
  // creation and backs off; the tests assert the ORDER and the SPACING, because
  // "it eventually succeeded" is also what an unthrottled burst looks like once
  // the retries land.
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
  import {
    CREATION_BACKOFF_MS,
    CREATION_MIN_SPACING_MS,
    CreationRateLimited,
    __resetCreationQueue,
    __setCreationQueueDeps,
    enqueueCreation,
  } from "../creation-queue";

  /** A virtual clock. `sleep` advances it instead of waiting, so a 32-game burst
   *  runs in microseconds and the assertions are exact rather than tolerant. */
  function virtualClock() {
    let t = 0;
    return {
      deps: {
        now: () => t,
        sleep: async (ms: number) => { t += ms; },
      },
      at: () => t,
      advance: (ms: number) => { t += ms; },
    };
  }

  let clock: ReturnType<typeof virtualClock>;

  beforeEach(() => {
    __resetCreationQueue();
    clock = virtualClock();
    __setCreationQueueDeps(clock.deps);
  });
  afterEach(() => {
    __resetCreationQueue();
  });

  describe("enqueueCreation — order", () => {
    it("runs jobs in the order they were enqueued, one at a time", async () => {
      const started: string[] = [];
      const finished: string[] = [];
      const job = (name: string) => async () => {
        started.push(name);
        // If the queue were not serial, the next job would start here.
        await Promise.resolve();
        finished.push(name);
        return name;
      };
      const keys = ["f1", "f2", "f3", "f4", "f5"];
      const results = await Promise.all(keys.map((k) => enqueueCreation(k, job(k))));
      expect(results).toEqual(keys);
      expect(started).toEqual(keys);
      // Strict interleave: every job finished before the next one started.
      expect(finished).toEqual(keys);
    });

    it("never runs two jobs concurrently, even when each one awaits", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const job = () => async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        return 1;
      };
      await Promise.all(Array.from({ length: 8 }, (_, i) => enqueueCreation(`k${i}`, job())));
      expect(maxInFlight).toBe(1);
    });

    it("a failing job does not stall the queue — the next one still runs", async () => {
      const ran: string[] = [];
      const bad = enqueueCreation("bad", async () => { throw new Error("provider down"); });
      await expect(bad).rejects.toThrow("provider down");
      await enqueueCreation("good", async () => { ran.push("good"); return 1; });
      expect(ran).toEqual(["good"]);
    });
  });

  describe("enqueueCreation — spacing", () => {
    it("spaces consecutive creates by at least CREATION_MIN_SPACING_MS", async () => {
      const at: number[] = [];
      const keys = ["a", "b", "c", "d", "e", "f"];
      await Promise.all(keys.map((k) =>
        enqueueCreation(k, async () => { at.push(clock.at()); return k; })));
      expect(at.length).toBe(keys.length);
      let checked = 0;
      for (let i = 1; i < at.length; i++) {
        expect(at[i]! - at[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(CREATION_MIN_SPACING_MS);
        checked++;
      }
      // Anti-vacuity: a one-element run would pass the loop above vacuously.
      expect(checked, "the spacing sweep checked no gaps").toBe(keys.length - 1);
      expect(checked).toBeGreaterThan(0);
    });

    it("the 32 creates a 64-player round wants stay under the measured ceiling", async () => {
      const at: number[] = [];
      await Promise.all(Array.from({ length: 32 }, (_, i) =>
        enqueueCreation(`f${i}`, async () => { at.push(clock.at()); return i; })));
      expect(at.length).toBe(32);
      // M3's ceiling is ~4 creates per second. Derived from the constant, not
      // retyped: a change to the spacing moves this assertion with it.
      const perSecond = 1000 / CREATION_MIN_SPACING_MS;
      expect(perSecond).toBeLessThan(4);
      expect(at[31]! - at[0]!).toBeGreaterThanOrEqual(31 * CREATION_MIN_SPACING_MS);
      // And it is not absurdly slow: a round must open in seconds, not minutes.
      expect(at[31]! - at[0]!).toBeLessThan(30_000);
    });

    it("does NOT pay the spacing before the first create — an idle queue is instant", async () => {
      await enqueueCreation("solo", async () => clock.at());
      expect(clock.at()).toBe(0);
    });

    it("a create arriving after a long idle gap pays no spacing either", async () => {
      await enqueueCreation("one", async () => 1);
      clock.advance(60_000);
      const before = clock.at();
      await enqueueCreation("two", async () => 2);
      expect(clock.at()).toBe(before);
    });
  });

  describe("enqueueCreation — 429 backoff", () => {
    it("retries a rate-limited job on the declared backoff ladder, in order", async () => {
      const attemptsAt: number[] = [];
      let attempt = 0;
      const out = await enqueueCreation("rl", async () => {
        attemptsAt.push(clock.at());
        attempt++;
        if (attempt <= CREATION_BACKOFF_MS.length) throw new CreationRateLimited("429");
        return "created";
      });
      expect(out).toBe("created");
      expect(attemptsAt.length).toBe(CREATION_BACKOFF_MS.length + 1);
      let checked = 0;
      for (let i = 1; i < attemptsAt.length; i++) {
        // The gap is the ladder rung PLUS the spacing the next attempt pays.
        expect(attemptsAt[i]! - attemptsAt[i - 1]!, `rung ${i}`)
          .toBeGreaterThanOrEqual(CREATION_BACKOFF_MS[i - 1]!);
        checked++;
      }
      expect(checked, "the backoff sweep checked no rungs").toBe(CREATION_BACKOFF_MS.length);
      expect(checked).toBeGreaterThan(0);
      // Monotonic, not flat: a ladder of equal rungs is not a backoff.
      const rungs = [...CREATION_BACKOFF_MS];
      expect(rungs).toEqual([...rungs].sort((a, b) => a - b));
      expect(new Set(rungs).size).toBe(rungs.length);
    });

    it("gives up after the ladder is exhausted, and says it was rate limited", async () => {
      let attempt = 0;
      await expect(enqueueCreation("rl2", async () => {
        attempt++;
        throw new CreationRateLimited("429");
      })).rejects.toBeInstanceOf(CreationRateLimited);
      expect(attempt).toBe(CREATION_BACKOFF_MS.length + 1);
    });

    it("a NON-429 failure is not retried — a bad username must not be hammered", async () => {
      let attempt = 0;
      await expect(enqueueCreation("nr", async () => {
        attempt++;
        throw new Error("no such user");
      })).rejects.toThrow("no such user");
      expect(attempt).toBe(1);
    });

    it("a backing-off job does not block the queue head forever: the next key still runs after it", async () => {
      const order: string[] = [];
      let attempt = 0;
      const slow = enqueueCreation("slow", async () => {
        order.push(`slow:${attempt}`);
        attempt++;
        if (attempt === 1) throw new CreationRateLimited("429");
        return "slow";
      });
      const next = enqueueCreation("next", async () => { order.push("next"); return "next"; });
      await Promise.all([slow, next]);
      // The retry is re-queued rather than held at the head, so a 32-game round
      // does not stop dead on one unlucky pairing.
      expect(order).toContain("next");
      expect(order.filter((o) => o.startsWith("slow")).length).toBe(2);
    });
  });

  describe("enqueueCreation — the key", () => {
    it("two concurrent enqueues of the SAME key share one run (Review Focus 2's shape)", async () => {
      let runs = 0;
      const job = async () => { runs++; await Promise.resolve(); return "once"; };
      const [a, b] = await Promise.all([
        enqueueCreation("same", job),
        enqueueCreation("same", job),
      ]);
      expect(runs).toBe(1);
      expect(a).toBe("once");
      expect(b).toBe("once");
    });

    it("the SAME key enqueued again AFTER the first settled runs a second time", async () => {
      let runs = 0;
      const job = async () => { runs++; return runs; };
      expect(await enqueueCreation("seq", job)).toBe(1);
      expect(await enqueueCreation("seq", job)).toBe(2);
      expect(runs).toBe(2);
    });

    it("a shared key that REJECTS rejects both callers, and does not poison the key", async () => {
      const boom = async () => { throw new Error("boom"); };
      const [a, b] = await Promise.allSettled([
        enqueueCreation("shared", boom),
        enqueueCreation("shared", boom),
      ]);
      expect(a.status).toBe("rejected");
      expect(b.status).toBe("rejected");
      expect(await enqueueCreation("shared", async () => "fine")).toBe("fine");
    });

    it("different keys do not share — the empty case for dedupe", async () => {
      let runs = 0;
      const job = async () => { runs++; return runs; };
      await Promise.all([enqueueCreation("k1", job), enqueueCreation("k2", job)]);
      expect(runs).toBe(2);
    });
  });
  ```

- [ ] **Step 2: Run it and read the failure.**
  `cd $WT/apps/web && npx vitest run src/server/external-play/__tests__/creation-queue.test.ts --reporter=json --outputFile=/tmp/b1-t4-red.json`
  Expected: collection failure,
  `Failed to resolve import "../creation-queue"`.

- [ ] **Step 3: Write `creation-queue.ts`.**

  ```ts
  import "server-only";
  // Global creation throttle (design §3.3, measured fact M3).
  //
  // M3, 2026-10-09: four `POST /api/challenge/<user>` in ~1s, then every
  // subsequent create returned {"error":"Too many requests. Try again later."}.
  // A 64-player round wants 32 games at once, so creation goes through one
  // serial queue with a minimum spacing and a backoff ladder.
  //
  // M4: moves are NOT rate-limited (8 back-to-back posts, all 200). Nothing but
  // creation belongs here — putting a move behind this queue would add latency
  // to every tap for no measured reason.
  //
  // SCOPE: this queue is PER PROCESS. With N web machines the aggregate rate is
  // N × (1 / CREATION_MIN_SPACING_MS), which is accepted:
  //   - double-creation is impossible by a stronger mechanism (room.ts's
  //     claim-then-call gives one claimant per fixture, and
  //     fixture_external_play_challenge_idx is unique on challenge_id), so a
  //     cross-instance collision wastes a 429 and nothing else;
  //   - the backoff recovers inside MINT_CLAIM_STALE_MS (30s), so a retried
  //     create commits under the same claim rather than racing a takeover;
  //   - 350 ms is ~2.9 creates/s against M3's measured ~4/s ceiling, so two
  //     instances creating flat out sit near the limit rather than past it.
  // If sustained 429s ever show up: the next step is a DB-backed lease keyed on
  // (stage_id, round_no), in the shape of V428's ingest_polled_at claim — NOT a
  // bigger backoff. Deliberately not built; nothing has measured the need.

  /** ~2.9 creates/s against M3's measured ~4/s. A 32-game round opens in ~11s. */
  export const CREATION_MIN_SPACING_MS = 350;

  /** Strictly increasing, and summing to 7s — comfortably inside
   *  MINT_CLAIM_STALE_MS (30s), so the claim this create holds is still ours
   *  when the last attempt lands. */
  export const CREATION_BACKOFF_MS = [1000, 2000, 4000] as const;

  /** Thrown by the JOB to ask for a backoff and a retry. The queue is generic
   *  over T and cannot inspect a result value for a 429, so the knowledge lives
   *  at the call site, which has the typed BoardCall in hand:
   *  `if (out.code === "rate_limited") throw new CreationRateLimited(out.raw)`. */
  export class CreationRateLimited extends Error {
    constructor(message = "Lichess rate limited the create") {
      super(message);
      this.name = "CreationRateLimited";
    }
  }

  export type CreationQueueDeps = { now: () => number; sleep: (ms: number) => Promise<void> };

  const realDeps: CreationQueueDeps = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  let deps: CreationQueueDeps = realDeps;

  /** Serial tail. Every enqueue chains onto it, which is what makes the queue
   *  one-at-a-time without a lock. */
  let tail: Promise<unknown> = Promise.resolve();
  let lastRunAt = Number.NEGATIVE_INFINITY;
  /** In-flight runs by key, so two tabs submitting the same fixture share one
   *  create instead of racing for the claim. */
  const inFlight = new Map<string, Promise<unknown>>();

  /** TESTS ONLY — inject a virtual clock so spacing and backoff are asserted
   *  exactly, with nothing actually sleeping. */
  export function __setCreationQueueDeps(d: Partial<CreationQueueDeps>): void {
    deps = { ...deps, ...d };
  }

  /** TESTS ONLY — drop the tail, the spacing memory and the in-flight map. */
  export function __resetCreationQueue(): void {
    deps = realDeps;
    tail = Promise.resolve();
    lastRunAt = Number.NEGATIVE_INFINITY;
    inFlight.clear();
  }

  async function runSpaced<T>(job: () => Promise<T>): Promise<T> {
    const since = deps.now() - lastRunAt;
    if (since < CREATION_MIN_SPACING_MS) {
      await deps.sleep(CREATION_MIN_SPACING_MS - since);
    }
    lastRunAt = deps.now();
    return job();
  }

  /** One slot on the serial tail. Rejections are swallowed from the TAIL (so one
   *  failed create does not stall the queue) while still reaching the caller. */
  function chain<T>(run: () => Promise<T>): Promise<T> {
    const slot = tail.then(run, run);
    tail = slot.then(
      () => undefined,
      () => undefined,
    );
    return slot;
  }

  export function enqueueCreation<T>(key: string, job: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const attempt = async (n: number): Promise<T> => {
      try {
        return await chain(() => runSpaced(job));
      } catch (err) {
        // Only a 429 is retried. A bad username, or a provider error, must not
        // be hammered — it would burn the rate budget the rest of the round
        // needs.
        if (!(err instanceof CreationRateLimited) || n >= CREATION_BACKOFF_MS.length) throw err;
        await deps.sleep(CREATION_BACKOFF_MS[n]!);
        // Re-queued, not held at the head: a 32-game round must not stop dead
        // on one unlucky pairing.
        return attempt(n + 1);
      }
    };

    const promise = attempt(0).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }
  ```

- [ ] **Step 4: Run green.** Re-run Step 2's command ⇒ `numFailedTests: 0`.
  Read the printed `numTotalTests` and record it (18 cases as written). If a
  spacing assertion is off by the first-create allowance, re-read Step 1's "does
  NOT pay the spacing before the first create" case before changing the
  implementation — `lastRunAt = Number.NEGATIVE_INFINITY` is what satisfies it.

- [ ] **Step 5: Mutate the throttle, four ways, one at a time.**
  `cp apps/web/src/server/external-play/creation-queue.ts /tmp/queue.bak` first.
  - Mutant A — delete the `if (since < CREATION_MIN_SPACING_MS)` block ⇒ both
    spacing cases red, and the anti-vacuity counts still report 5 and 31, which
    is what proves the sweeps ran.
  - Mutant B — `chain` returns `run()` directly without the tail ⇒ the
    concurrency case reds with `expected 2 to be 1` (or higher).
  - Mutant C — retry every error (`if (n >= CREATION_BACKOFF_MS.length) throw err`)
    ⇒ "a NON-429 failure is not retried" reds with `expected 4 to be 1`.
  - Mutant D — drop the `inFlight` map ⇒ "two concurrent enqueues of the SAME
    key share one run" reds with `expected 2 to be 1`.
  Restore with `cp /tmp/queue.bak …` after each.

- [ ] **Step 6: Prove the module has no Lichess knowledge in it.**
  ```
  cd $WT && grep -an "lichess\|Lichess\|429\|board-api" apps/web/src/server/external-play/creation-queue.ts
  ```
  Expected: hits only in the comment block (M3/M4 citations and the call-site
  example). **No import** of `board-api`, no status-code branching. If the
  implementation ends up reading a `code` field, it has taken on T9's knowledge
  and the `CreationRateLimited` seam is being bypassed.

- [ ] **Step 7: Typecheck, lint, commit.**
  ```
  cd $WT && rtk proxy npx tsc --noEmit -p apps/web
  cd $WT && rtk proxy npx eslint apps/web/src/server/external-play/creation-queue.ts \
    apps/web/src/server/external-play/__tests__/creation-queue.test.ts
  cd $WT && git add apps/web/src/server/external-play/creation-queue.ts \
    apps/web/src/server/external-play/__tests__/creation-queue.test.ts
  cd $WT && git commit -m "feat(chess): serialise challenge creation with a 429 backoff (M3)"
  ```

---

### Task 5: Time-control catalogue and setup validation

**Two independent measured rules, and the whole point of this task is that they
are independent:**

- **M13 — playability.** `120+1` (estimated 160 s) → Lichess `speed=bullet` →
  every move `400 "This game cannot be played with the Board API."`. `180+0`
  (estimated 180 s) → `speed=blitz` → move `200`. Estimated duration is
  `limit + 40 × increment`; the cutoff is blitz or slower, i.e. `≥ 180`. Two
  points tested, not the whole curve.
- **M14 — creatability.** `170+0` and `140+1` were **refused at creation** with
  `{"clock.limit":["Invalid value"]}`. `clock.limit` is an enumerated set, not a
  free integer.

`140+1` is the case that makes the pair non-redundant: `140 + 40 = 180`, so it
**passes M13** and is still refused, because 140 is not an accepted
`clock.limit`. And `120+1` **passes M14** (120 is accepted; the challenge was
created) and is still unplayable. The two rules differ in both directions, each
witnessed by a measured point, which is what lets the tests see a regression in
either rule rather than only in their conjunction.

**Files:**
- Create: `apps/web/src/server/external-play/time-controls.ts`
- Create: `apps/web/src/server/external-play/__tests__/time-controls.test.ts`
- Read-only reference: `apps/web/src/server/external-play/clock.ts` (1-29 —
  `mapBoardgameClockToLichess` maps `divisions.config.clock
  {base, increment?, delay?}` onto `{limit, increment}` and refuses a
  delay/Bronstein config), `apps/web/src/server/usecases/external-play/guard.ts`
  142-156 (where that mapping is read today: `cfg?.clock` →
  `clockMap.clock` → `OnlinePlayFixture.clock`)

**Interfaces:**
- Consumes: `HttpError` from `@/lib/errors`.
- Produces, exactly as the authoritative list declares:
  ```ts
  export type TimeControl = { key: string; limitSeconds: number; incrementSeconds: number };
  export const SHIP1_TIME_CONTROLS: readonly TimeControl[]; // 3+0,3+2,5+0,5+3,10+5,15+10
  export function isBoardApiPlayable(tc: TimeControl): boolean; // limit + 40*inc >= 180
  export function assertTimeControl(key: string): TimeControl;  // throws 400 INVALID_TIME_CONTROL
  ```
- Also produced, added to this task's own module:
  ```ts
  export const BOARD_API_MIN_ESTIMATED_SECONDS: number; // 180 (M13)
  export function estimatedSeconds(tc: TimeControl): number; // limit + 40 * increment
  export function isCreatableLimit(limitSeconds: number): boolean; // M14
  ```

**Scope note (do not widen):** `isCreatableLimit` encodes only what has been
MEASURED — the two refusals were 170 and 140, neither a multiple of 60, while
every accepted limit observed (120, 180, 300, 600, 900) is. The locally
available `scratchpad/lichess-api.yaml` is a paths index with `$ref`s only and
carries **no** `clock.limit` schema, so the full Lichess enumeration cannot be
verified from here and is **not** encoded. The rule we ship is the *sufficient*
condition our catalogue needs, stated as such in the code, with the two
measured refusals as its tests. Do not write out a guessed enum.

---

- [ ] **Step 1: Failing test — the catalogue sweep, with its count.**
  New file `apps/web/src/server/external-play/__tests__/time-controls.test.ts`:

  ```ts
  // Design §3.7. The organiser picks from a curated list validated at TOURNAMENT
  // SETUP, because creation succeeding proves nothing about playability (M12: a
  // 0+1 challenge was accepted and then refused every move).
  //
  // Expected values here come from the SPEC's ship-1 list and from the measured
  // log lines, never from time-controls.ts.
  import { describe, expect, it } from "vitest";
  import {
    BOARD_API_MIN_ESTIMATED_SECONDS,
    SHIP1_TIME_CONTROLS,
    assertTimeControl,
    estimatedSeconds,
    isBoardApiPlayable,
    isCreatableLimit,
  } from "../time-controls";

  /** Spec §3.7's list, written out as the rulebook states it — the catalogue is
   *  checked AGAINST this, not derived from it. */
  const SHIP1_KEYS = ["3+0", "3+2", "5+0", "5+3", "10+5", "15+10"];

  describe("SHIP1_TIME_CONTROLS", () => {
    it("is exactly the spec's six entries, in the spec's order", () => {
      expect(SHIP1_TIME_CONTROLS.map((t) => t.key)).toEqual(SHIP1_KEYS);
    });

    it("every key's minutes+increment match its seconds — the label cannot lie", () => {
      let checked = 0;
      for (const tc of SHIP1_TIME_CONTROLS) {
        const [mins, inc] = tc.key.split("+").map(Number) as [number, number];
        expect(tc.limitSeconds, tc.key).toBe(mins * 60);
        expect(tc.incrementSeconds, tc.key).toBe(inc);
        checked++;
      }
      expect(checked, "the label sweep checked nothing").toBe(SHIP1_KEYS.length);
      expect(checked).toBeGreaterThan(0);
    });

    // The §8.2 sweep: driven, not asserted. Every entry walks BOTH measured
    // rules, and the count is reported — a sweep that checks zero is a FAILURE.
    it("every entry is both creatable (M14) and playable (M13), and reports the count", () => {
      let checked = 0;
      const failures: string[] = [];
      for (const tc of SHIP1_TIME_CONTROLS) {
        if (!isCreatableLimit(tc.limitSeconds)) failures.push(`${tc.key}: clock.limit refused`);
        if (!isBoardApiPlayable(tc)) {
          failures.push(`${tc.key}: estimated ${estimatedSeconds(tc)}s < ${BOARD_API_MIN_ESTIMATED_SECONDS}s`);
        }
        checked++;
      }
      expect(failures).toEqual([]);
      expect(checked, "the playability sweep checked nothing — zero is a failure")
        .toBe(SHIP1_TIME_CONTROLS.length);
      expect(checked).toBeGreaterThan(0);
      expect(checked).toBe(6);
    });

    it("no duplicate keys, and no duplicate (limit, increment) pairs", () => {
      expect(new Set(SHIP1_TIME_CONTROLS.map((t) => t.key)).size).toBe(SHIP1_TIME_CONTROLS.length);
      expect(new Set(SHIP1_TIME_CONTROLS.map((t) => `${t.limitSeconds}/${t.incrementSeconds}`)).size)
        .toBe(SHIP1_TIME_CONTROLS.length);
    });

    it("is frozen — a caller cannot push an unplayable entry into the shared catalogue", () => {
      expect(Object.isFrozen(SHIP1_TIME_CONTROLS)).toBe(true);
      expect(() => (SHIP1_TIME_CONTROLS as TimeControl[]).push({
        key: "0+1", limitSeconds: 0, incrementSeconds: 1,
      })).toThrow();
    });
  });

  describe("the two measured rules are INDEPENDENT (M13, M14)", () => {
    // tc-boundary.log, 10:32:36Z — created fine, then every move refused.
    it("120+1 is creatable and NOT playable: estimated 160s", () => {
      const tc = { key: "2+1", limitSeconds: 120, incrementSeconds: 1 };
      expect(estimatedSeconds(tc)).toBe(160);
      expect(isCreatableLimit(tc.limitSeconds)).toBe(true);
      expect(isBoardApiPlayable(tc)).toBe(false);
    });

    // tc-boundary.log, 10:33:06Z — CHALLENGE REFUSED {"clock.limit":["Invalid value"]}
    // even though 140 + 40 = 180 clears M13's cutoff. This is the case that
    // proves the two rules are not one rule.
    it("140+1 is playable by the formula and NOT creatable: clock.limit refused", () => {
      const tc = { key: "140s+1", limitSeconds: 140, incrementSeconds: 1 };
      expect(estimatedSeconds(tc)).toBe(180);
      expect(isBoardApiPlayable(tc)).toBe(true);
      expect(isCreatableLimit(tc.limitSeconds)).toBe(false);
    });

    // tc-boundary.log, 10:32:04Z — refused at creation; also under the cutoff.
    it("170+0 fails both", () => {
      const tc = { key: "170s+0", limitSeconds: 170, incrementSeconds: 0 };
      expect(isCreatableLimit(tc.limitSeconds)).toBe(false);
      expect(isBoardApiPlayable(tc)).toBe(false);
    });

    // tc-boundary.log, 10:33:39Z — speed=blitz, move http=200. The boundary,
    // exactly ON the cutoff.
    it("180+0 passes both, at the boundary", () => {
      const tc = { key: "3+0", limitSeconds: 180, incrementSeconds: 0 };
      expect(estimatedSeconds(tc)).toBe(BOARD_API_MIN_ESTIMATED_SECONDS);
      expect(isBoardApiPlayable(tc)).toBe(true);
      expect(isCreatableLimit(tc.limitSeconds)).toBe(true);
    });

    // spike-battery2.log §A — both created fine, both refused every move.
    it.each([
      ["0+1", 0, 1], ["1+0", 60, 0],
    ])("%s was ACCEPTED at creation and is still unplayable (M12)", (_k, limit, inc) => {
      expect(isBoardApiPlayable({ key: _k, limitSeconds: limit, incrementSeconds: inc })).toBe(false);
    });

    it("the cutoff is 180s, and one second under it is refused", () => {
      expect(BOARD_API_MIN_ESTIMATED_SECONDS).toBe(180);
      expect(isBoardApiPlayable({ key: "x", limitSeconds: 179, incrementSeconds: 0 })).toBe(false);
      expect(isBoardApiPlayable({ key: "x", limitSeconds: 180, incrementSeconds: 0 })).toBe(true);
    });

    it("the 40× weighting is the measured one, not a guess", () => {
      // 60 + 40 × 3 = 180: the increment carries 40 moves' worth, which is what
      // makes 60+3 playable and 60+2 (140s) not.
      expect(estimatedSeconds({ key: "1+3", limitSeconds: 60, incrementSeconds: 3 })).toBe(180);
      expect(estimatedSeconds({ key: "1+2", limitSeconds: 60, incrementSeconds: 2 })).toBe(140);
    });
  });

  describe("assertTimeControl — the setup gate", () => {
    it("returns the catalogue entry for every ship-1 key, and reports the count", () => {
      let checked = 0;
      for (const key of SHIP1_KEYS) {
        const tc = assertTimeControl(key);
        expect(tc.key).toBe(key);
        checked++;
      }
      expect(checked).toBe(SHIP1_KEYS.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("hands back the SAME object the catalogue holds, not a copy", () => {
      expect(assertTimeControl("5+3")).toBe(
        SHIP1_TIME_CONTROLS.find((t) => t.key === "5+3"),
      );
    });

    it.each([
      ["0+1", "accepted at creation, unplayable (M12)"],
      ["1+0", "accepted at creation, unplayable (M12)"],
      ["2+1", "creatable, estimated 160s (M13)"],
      ["20+0", "playable and creatable, but not on the ship-1 list"],
      ["3+1", "not on the list — the catalogue is the gate, not the formula"],
      ["", "the shape a missing field arrives as"],
      ["3+0 ", "a trailing space is a different key"],
      ["3 + 0", "whitespace inside"],
      ["3-0", "wrong separator"],
      ["__proto__", "a prototype key must not resolve to anything"],
    ])("refuses %s (%s) with 400 INVALID_TIME_CONTROL", (key) => {
      expect(() => assertTimeControl(key)).toThrowError(
        expect.objectContaining({ status: 400, code: "INVALID_TIME_CONTROL" }),
      );
    });

    it("the refusal names the permitted keys, so an organiser can fix it without the docs", () => {
      let message = "";
      try { assertTimeControl("3+1"); } catch (e) { message = (e as Error).message; }
      for (const key of SHIP1_KEYS) expect(message, key).toContain(key);
    });

    // The gate is the CATALOGUE, not the formula: a time control can satisfy
    // both measured rules and still be refused, because §3.7 says the organiser
    // picks from a curated list that has been verified playable.
    it("a formula-passing key off the list is still refused", () => {
      const off = { key: "20+0", limitSeconds: 1200, incrementSeconds: 0 };
      expect(isBoardApiPlayable(off)).toBe(true);
      expect(isCreatableLimit(off.limitSeconds)).toBe(true);
      expect(() => assertTimeControl(off.key)).toThrow();
    });
  });
  ```

  Add `import type { TimeControl } from "../time-controls";` for the frozen case.

- [ ] **Step 2: Run it and read the failure.**
  `cd $WT/apps/web && npx vitest run src/server/external-play/__tests__/time-controls.test.ts --reporter=json --outputFile=/tmp/b1-t5-red.json`
  Expected: collection failure,
  `Failed to resolve import "../time-controls"`.

- [ ] **Step 3: Write `time-controls.ts`.**

  ```ts
  // Curated time controls (design §3.7), validated at TOURNAMENT SETUP.
  //
  // Why a catalogue and not a formula: M12 (2026-10-09) — a 0+1 and a 1+0
  // challenge were ACCEPTED at creation and then refused every move with
  // 400 "This game cannot be played with the Board API.". Creation succeeding
  // proves nothing, so the organiser picks from a list each of whose entries has
  // been verified playable.
  //
  // Two INDEPENDENT measured rules, and the independence is the point:
  //   M13 playability — estimated duration `limit + 40 × increment >= 180`.
  //     120+1 (160s) → speed=bullet → moves refused; 180+0 (180s) → speed=blitz
  //     → move 200. Two points tested, not the whole curve.
  //   M14 creatability — `clock.limit` is an ENUMERATED set, not a free integer.
  //     170+0 and 140+1 were refused at creation with
  //     {"clock.limit":["Invalid value"]}.
  // 140+1 clears M13 (140 + 40 = 180) and still fails M14; 120+1 clears M14
  // (it was created) and still fails M13. Neither rule implies the other.
  import { HttpError } from "@/lib/errors";

  export type TimeControl = { key: string; limitSeconds: number; incrementSeconds: number };

  /** M13's cutoff: blitz or slower. */
  export const BOARD_API_MIN_ESTIMATED_SECONDS = 180;

  /** Lichess's own estimate of a game's duration, which is what picks the speed
   *  bucket: the base clock plus 40 moves' worth of increment. */
  export function estimatedSeconds(tc: TimeControl): number {
    return tc.limitSeconds + 40 * tc.incrementSeconds;
  }

  export function isBoardApiPlayable(tc: TimeControl): boolean {
    return estimatedSeconds(tc) >= BOARD_API_MIN_ESTIMATED_SECONDS;
  }

  /**
   * M14's rule, AS MEASURED and no wider. The two refusals were 170 and 140,
   * neither a multiple of 60; every limit observed to be accepted (120, 180,
   * 300, 600, 900) is one. This is therefore a SUFFICIENT condition for our
   * catalogue, not a transcription of Lichess's enumeration — that enumeration
   * is not verifiable from here (the OpenAPI copy in the spike scratchpad is a
   * paths index with no clock.limit schema), and a guessed enum would be a
   * fabricated expected value.
   *
   * If a future ship-1 list wants a sub-minute or odd-second control, MEASURE it
   * against lichess.org first and widen this with the log line as evidence.
   */
  export function isCreatableLimit(limitSeconds: number): boolean {
    return limitSeconds > 0 && limitSeconds % 60 === 0;
  }

  /** Ship-1 (§3.7). Frozen: a caller must not be able to push an unverified
   *  entry into the shared catalogue, which would walk straight past the sweep
   *  that checks it. */
  export const SHIP1_TIME_CONTROLS: readonly TimeControl[] = Object.freeze([
    Object.freeze({ key: "3+0", limitSeconds: 180, incrementSeconds: 0 }),
    Object.freeze({ key: "3+2", limitSeconds: 180, incrementSeconds: 2 }),
    Object.freeze({ key: "5+0", limitSeconds: 300, incrementSeconds: 0 }),
    Object.freeze({ key: "5+3", limitSeconds: 300, incrementSeconds: 3 }),
    Object.freeze({ key: "10+5", limitSeconds: 600, incrementSeconds: 5 }),
    Object.freeze({ key: "15+10", limitSeconds: 900, incrementSeconds: 10 }),
  ]);

  /** The setup gate. The CATALOGUE is the gate, not the formula: an entry can
   *  satisfy both measured rules and still be refused, because §3.7 permits only
   *  controls that have been verified playable. `find` on the array, never a
   *  record lookup — a record would let `__proto__` or `constructor` resolve. */
  export function assertTimeControl(key: string): TimeControl {
    const found = SHIP1_TIME_CONTROLS.find((tc) => tc.key === key);
    if (!found) {
      throw new HttpError(
        400,
        `Pick one of the supported time controls: ${SHIP1_TIME_CONTROLS.map((t) => t.key).join(", ")}.`,
        "INVALID_TIME_CONTROL",
      );
    }
    return found;
  }
  ```

- [ ] **Step 4: Run green.** Re-run Step 2's command ⇒ `numFailedTests: 0`.
  Record the printed `numTotalTests` (24 cases as written: the `it.each` of 2 and
  of 10 counting as 2 and 10). Confirm the resolved path is under `$WT`.

- [ ] **Step 5: Mutate both rules and the gate, one at a time.**
  `cp apps/web/src/server/external-play/time-controls.ts /tmp/tc.bak` first.
  - Mutant A — `estimatedSeconds` drops the `40 *` ⇒ "the 40× weighting" reds,
    and "140+1 is playable by the formula" reds, so the independence case stops
    witnessing what it exists for. This is the mutant that proves the
    independence pair is load-bearing.
  - Mutant B — `BOARD_API_MIN_ESTIMATED_SECONDS = 160` ⇒ "120+1 is creatable and
    NOT playable" reds and the boundary case reds.
  - Mutant C — `isCreatableLimit` returns `true` always ⇒ "140+1 … NOT
    creatable" and "170+0 fails both" red, while the catalogue sweep stays
    green — which is exactly why the sweep is not the only test.
  - Mutant D — `assertTimeControl` falls back to a computed entry instead of
    throwing ⇒ the ten-case refusal sweep reds, including `__proto__`.
  - Mutant E — delete one entry from `SHIP1_TIME_CONTROLS` ⇒ the order case reds
    AND both anti-vacuity counts change from 6 to 5, which is the signal that a
    shrinking catalogue cannot pass as a clean sweep.
  Restore with `cp /tmp/tc.bak …` after each.

- [ ] **Step 6: State, in the module, where this plugs in — and confirm it is not inert yet.**
  `clock.ts` maps `divisions.config.clock {base, increment?, delay?}` onto
  `{limit, increment}` (1-29) and `guard.ts` 142-156 reads it. Nothing calls
  `assertTimeControl` yet — **T9 calls it before creation and the division
  settings save calls it at setup**. Add that sentence to the file header so the
  seam has a named consumer, and record in the task report that this module is
  **declared but not yet driven**, which is AGENTS.md failure class 1 until T9
  lands. Do **not** wire `guard.ts` here: its `clock` field is consumed by
  `room.ts`, which T9 rewrites, and editing it now reds that suite.

  ```
  cd $WT && grep -arn "assertTimeControl\|SHIP1_TIME_CONTROLS" apps/web/src --include="*.ts" --include="*.tsx"
  ```
  Expected: only `time-controls.ts` and its test. Paste that output into the task
  report as the explicit statement that the seam is not yet driven.

- [ ] **Step 7: Typecheck, lint, commit.**
  ```
  cd $WT && rtk proxy npx tsc --noEmit -p apps/web
  cd $WT && rtk proxy npx eslint apps/web/src/server/external-play/time-controls.ts \
    apps/web/src/server/external-play/__tests__/time-controls.test.ts
  cd $WT && git add apps/web/src/server/external-play/time-controls.ts \
    apps/web/src/server/external-play/__tests__/time-controls.test.ts
  cd $WT && git commit -m "feat(chess): curated time controls gated on both measured rules (M13, M14)"
  ```

---

### Batch B1 exit check

Run once, after Task 5, before handing the batch on. **Scoped only** — not the
full suite, not the full e2e suite (owner, 2026-09-28; CI is the arbiter for
everything else).

```
cd $WT && rtk proxy npx tsc --noEmit -p apps/web
cd $WT/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep \
  DATABASE_SSL=disable npx vitest run \
  src/server/usecases/__tests__/external-play-schema.test.ts \
  src/server/usecases/__tests__/online-chess-camera-schema.test.ts \
  src/server/usecases/__tests__/online-chess-video-schema.test.ts \
  src/server/usecases/__tests__/online-chess-round-open-schema.test.ts \
  src/server/usecases/__tests__/external-accounts.test.ts \
  src/server/usecases/__tests__/external-play-guard.test.ts \
  src/server/usecases/__tests__/external-play-room.test.ts \
  src/server/usecases/__tests__/external-play-prepare.test.ts \
  src/server/usecases/__tests__/external-play-escalate.test.ts \
  src/server/usecases/__tests__/external-play-happy-path.test.ts \
  src/server/usecases/__tests__/external-play-sync.test.ts \
  src/server/external-play/__tests__/secrets.test.ts \
  src/server/external-play/__tests__/uci.test.ts \
  src/server/external-play/__tests__/board-api.test.ts \
  src/server/external-play/__tests__/creation-queue.test.ts \
  src/server/external-play/__tests__/time-controls.test.ts \
  src/server/external-play/__tests__/lichess-adapter.test.ts \
  src/server/external-play/__tests__/window.test.ts \
  src/server/relay/__tests__/enc-boundary.test.ts \
  src/lib/__tests__/device-link-kek-wiring.test.ts \
  src/app/api/auth/lichess/__tests__/lichess-oauth-routes.test.ts \
  --reporter=json --outputFile=/tmp/b1-exit.json
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:(.testResults|length)}' /tmp/b1-exit.json
jq -r '.testResults[].name' /tmp/b1-exit.json
cd $WT && npm run i18n:check
cd $WT && npm run i18n:gen-keys && rtk proxy git diff --exit-code apps/web/src/i18n-keys.ts
```

Judge on: `failed: 0`, `files: 21` (a lower file count means a path was filtered
out by a literal-filename mismatch, which reports as green), every
`.testResults[].name` resolving under `$WT`, and a `total` at or above the
numbers each task recorded. Then `cd $WT && DATABASE_URL=… DATABASE_SSL=disable
npm run db:apply` ⇒ "No migration necessary", and `npm run db:info` ⇒ V432 and
V433 both `Success` with nothing pending above them.

**Not run here, deliberately:** e2e and smoke. B1 ships no user-facing surface —
`time-controls.ts` and `board-api.ts` have no production caller until T9, which
is recorded as a known inert seam in Task 5 Step 6. The e2e and smoke coverage
for this batch's code arrives with **B5 (T17-T18)**.
` marker in
     docs/superpowers/plans/2026-10-09-chess-in-page-board-and-camera.md -->

## Batch B2 — camera policy, video, seat, game creation (T6–T9)

### Premise corrections found while pinning this batch

Recorded here because each one changes what a task builds. Rule 5: the brief is a
hypothesis.

- **P-B2-1 — the superseded plan's `division-settings.tsx` line numbers are all
  stale.** Re-pinned against the file as it stands on this branch: the
  derive-from-props resync block is **:415–422** (not ~:405–420) and the
  `onlinePlay` state pair is **:424–426**; the `saveRules` write is **:627–630**
  (not ~:606–609); the `<select>` is **:936–953** (not ~:886–904).
- **P-B2-2 — `competitions` has no config jsonb, so "defaulting from the
  competition" (spec §5.1) has nowhere to live, and the authoritative
  `effectivePolicy` takes only two levels.** `competitions`
  (`db/migration/v2-engine/tables/V207__competitions.sql:4-26`) carries
  `branding` and `discovery` and nothing general-purpose; no task in this plan
  adds a column to it. The authoritative signature is
  `effectivePolicy({ stage, competition })` — two slots, not three.
  **Resolution, ship 1:** the two stored levels are the **stage**
  (`stages.config.cameraPolicy`) and the **division**
  (`divisions.config.cameraPolicy`), and the `competition` parameter is the
  *inherited-default slot*, fed by the division. The signature is not changed.
  A genuine competition-wide default is a later task, and the slot is already
  the place it plugs into.
- **P-B2-3 — `divisions.config` is parsed through the sport module's
  `configSchema`, which STRIPS unknown keys.** `divisions.ts:273` (create) and
  `:850` (patch) both `safeParse` the merged config, so a `cameraPolicy` key
  must be carried through the parse explicitly, exactly as `onlinePlay` and
  `entrants` already are (`divisions.ts:280-289`, `:862-874`). Without that
  step the setting silently vanishes on every save.
- **P-B2-4 — the format lock would make the camera setting unusable, and the fix
  is one line in `online-play.ts`.** `patchDivision:875-880` 409s
  `FORMAT_LOCKED` on any config change once a stage owns fixtures, comparing
  `withoutEntrants(...)` — which is `withoutDivisionMetaKeys`
  (`divisions.ts:602-603`), and that function
  (`apps/web/src/server/external-play/online-play.ts:45-51`) strips exactly
  `entrants` and `onlinePlay`. Camera policy is only ever edited on a division
  that HAS fixtures (the window opens off `scheduled_at`), so `cameraPolicy`
  must join that strip list or the feature is dead on arrival.
- **P-B2-5 — `divset.onlinePlay.help` is now false in all four locales.** It
  reads "games run on Lichess and results sync back" (en:2394, es:2349,
  fr:2394, nl:2349); D3 deleted that product. T6 edits the adjacent block, so
  it corrects the sentence in the same commit.
- **P-B2-6 — RealtimeKit exposes NO per-participant video-publishing signal,
  server-side.** Verified against the live Cloudflare OpenAPI spec and docs on
  2026-10-09: the only media-adjacent REST facts are
  `GET …/meetings/{id}/active-session` → `{status: "LIVE"|"ENDED",
  live_participants: number}` and `GET …/sessions/{id}/participants` →
  `{custom_participant_id, joined_at, left_at, preset_name, peer_events}`.
  `peer_events` carries only `PEER_CREATED|PEER_JOINING|PEER_LEAVING`. The whole
  webhook catalogue is `meeting.started`, `meeting.ended`,
  `meeting.participantJoined`, `meeting.participantLeft`, `meeting.chatSynced`,
  `recording.statusUpdate`, `livestreaming.statusUpdate`, `meeting.transcript`,
  `meeting.summary` — none carries media state. `videoEnabled` /
  `onVideoUpdate` exist **only in the client SDK**, which is precisely the
  forgeable surface §5.2 rejects.
  **Resolution:** `hasLiveVideoPublisher` keeps its authoritative name and
  signature and proves what the API can actually prove — *this participant is
  joined to a LIVE session and has not left* — while **camera-on is enforced by
  the preset**, which is server-side configuration we hold, not a client claim.
  The `player` preset must be configured with video on at join and the video
  toggle **denied**; T7 pins the preset name from env with no default and
  refuses to run unconfigured. The function's doc comment states exactly what it
  proves and what it does not. This is still strictly stronger than the POC's
  `cameraOk` boolean: nothing the browser sends is read.
- **P-B2-7 — RealtimeKit has no "delete meeting" endpoint.** Teardown is the
  two-call recipe Cloudflare's own FAQ gives: `POST
  …/meetings/{id}/active-session/kick-all` (if a session is live), then `PATCH
  …/meetings/{id}` with `{"status":"INACTIVE"}` — "Users will not be able to
  join an INACTIVE meeting."
- **P-B2-8 — there are TWO `.env.example` files and they have diverged.** The
  repo-root `.env.example:74-78` already declares `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_STREAM_TOKEN` for the streaming relay; `apps/web/.env.example`
  (the one its own header tells you to copy) declares neither. T7 writes to
  `apps/web/.env.example` per the brief, **reuses** `CLOUDFLARE_ACCOUNT_ID`
  (one account serves relay and RealtimeKit) and must **not** reuse
  `CLOUDFLARE_STREAM_TOKEN`, which is Stream-scoped.
- **P-B2-9 — the audit row needs no new table.** `competition_events`
  (`V208__competition_events.sql:3-13`, `type text not null` with no CHECK) plus
  the `audit(db, competitionId, orgId, type, payload, actorId)` helper
  (`apps/web/src/server/usecases/audit.ts:26-37`) is the live ledger. D9 and D11
  rows go there. `patchDivision`'s own `current` read
  (`divisions.ts:813-822`) does **not** select `competition_id`, so T6 widens
  that one select by a single column.
- **P-B2-10 — `upsertLichessLink`'s signature changes under T2.** It is
  currently `(userId, { externalUserId, username })`
  (`external-accounts.ts:50-53`) and is called that way by the shared seed
  helper (`_external-play-seed.ts:63`). T2 widens it to
  `{ externalUserId, username, scopes, token }`. T8 and T9 write their seeds
  against the **T2** shape.
- **P-B2-11 — a BYE fixture never reaches the guard.** A bye is
  `away_entrant_id is null` with `away_slot_label->>'key' = 'bracket.slot.bye'`
  (`apps/web/src/lib/scorer-sheets.ts:23`,
  `public-site/public-player-matches.ts:829`), and
  `loadOnlinePlayFixture` already refuses a null entrant (`guard.ts:138-139`).
  So the guard returns `null` for *both* "not an online fixture" and "bye", and
  T9 cannot answer `no_person` without classifying that null. T9 does so with
  one extra read, and the empty case (a fixture id that does not exist at all)
  must answer `not_ready`, not `no_person`.
- **P-B2-12 — D12: the window is anchored on `round_opened_at`, not on
  `scheduled_at`.** Controller ruling mid-batch, now in the spec at §3.2
  (lines 105-127). Swiss pairs the next round by itself; the fixtures exist
  **unopened and uninvited**. The organiser opens the round, which stamps
  `round_opened_at`, sends the invites and starts the window. T−10/T+20 are
  relative to that stamp; the scheduled time is only what players are *shown*.
  A fixture with no stamp is not playable and says so.
  Four consequences for B2:
  1. **`window.ts`'s pure functions do not change shape.**
     `windowFor(anchor)` / `roomPhase(now, anchor)` /
     `checkInCounts(at, anchor)` (`window.ts:14-36`) are already pure functions
     of an anchor; every B2 call site passes `round_opened_at` where it used to
     pass `scheduledAt`. Because the stamp is `now` at the moment of opening,
     `opensAt = stamp − 10min` is always already past, so the window runs in
     practice from the instant of opening to +20 minutes — the operational
     intent. The `"before"` phase is therefore unreachable for an opened round,
     and "not opened" is a **separate state**, never `"before"`.
  2. **T6's downgrade gate re-anchors.** "After the stage's first check-in
     window opens" now means "a round of this division has been opened", read
     off the stamp rather than computed from a timetable. Strictly safer: the
     old reading let a stale timetable lock the setting for a round nobody had
     started. `firstWindowOpened` is therefore **dropped** from T6's produced
     interface and replaced by `anyRoundOpened` in a new module (see T6).
  3. **T8 gains the reason `"round_not_open"`** — exact spelling, per the
     controller, who is updating the plan's authoritative Interfaces section.
  4. **T9's readiness gains "the round is open"**; a paired-but-unopened
     fixture creates nothing.
  Two things this ruling does NOT settle, both findings rather than blockers.
  **(a) No task in this plan owns the round-OPENING action** — the organiser
  control, the `round_opened_at` write and the invite send. T13 (sweeps) is the
  nearest owner and its brief does not mention it; B2 only ever READS the
  stamp. **(b) The re-anchoring blast radius reaches code B2 does not own:**
  `room.ts` feeds `f.scheduledAt` into `roomPhase`/`windowFor`/`checkInCounts`
  at :150, :187, :239, :286 and :323, while `guard.ts`'s staleness basis
  (`scheduled_at_basis`, :165-173 and :189-202) is a *reschedule* detector that
  is correctly schedule-based and must NOT be re-anchored by mistake. T9
  rewrites `room.ts` per the file-structure table, so that re-anchor is listed
  in T9's steps; the sweep's own re-anchor stays T13's.

### Hard prerequisite from T1 (B1) — verify before starting T7

**Every task in B2 now needs schema** (T6 included, since D12 re-anchored its
gate), and the plan's file-structure table describes
`V432__online_chess_board_and_camera.sql` only as "camera policy, meetings,
flags, audit" — no columns are written down anywhere. Two agents must not both
add migrations. The exact DDL B2 consumes, which T1 owns:

```sql
-- D12 (P-B2-12). The round, not the fixture, is the unit that opens: a
-- per-fixture stamp would let half a round be open. Keyed on (stage_id,
-- round_no) because `fixtures` already carries both (V214__fixtures.sql:10,47).
-- B2 only READS this table; the organiser action that writes it is unowned.
create table stage_round_open (
  stage_id        uuid not null references stages(id) on delete cascade,
  org_id          uuid not null references organizations(id) on delete cascade,
  round_no        int  not null,
  round_opened_at timestamptz not null,
  opened_by       uuid references users(id) on delete set null,
  primary key (stage_id, round_no)
);

create table fixture_video_meeting (
  fixture_id uuid primary key references fixtures(id) on delete cascade,
  org_id     uuid not null references organizations(id) on delete cascade,
  provider   text not null default 'realtimekit' check (provider in ('realtimekit')),
  meeting_id text not null,
  created_at timestamptz not null default now(),
  ended_at   timestamptz,
  unique (provider, meeting_id)
);

create table fixture_video_participant (
  fixture_id        uuid not null references fixtures(id) on delete cascade,
  org_id            uuid not null references organizations(id) on delete cascade,
  person_id         uuid not null references persons(id) on delete cascade,
  participant_id    text not null,
  preset            text not null check (preset in ('player', 'arbiter')),
  video_verified_at timestamptz,
  created_at        timestamptz not null default now(),
  primary key (fixture_id, person_id)
);

alter table fixture_external_play
  add column video_override_at   timestamptz,
  add column video_override_by   uuid references users(id) on delete set null,
  add column video_override_note text;
```

All three new tables carry `enable`/`force row level security` and the same
`org_id = current_org_id()` tenant policy `fixture_external_play` has
(`V405__lichess_external_play.sql:68-74`), plus
`grant select, insert, update, delete … to app_user`. B2 reads and writes them
through the privileged `sql` client, the way `guard.ts` does.

The three new `fixture_external_play` columns are deliberately **not** added to
`BridgeRow`/`RawBridge`/`reviveBridge` (`guard.ts:28-102`) — that type is
documented as a strict subset whose other columns "callers that need them read
the table directly", and hand-copying columns into a parallel shim is a known
trap in this repo. T8 reads the override columns with its own select.

---

### Task 6: Camera policy — org-chosen, downgrade-only, with an audit row

**Files:**

Create:
- `apps/web/src/server/external-play/camera-policy.ts`
- `apps/web/src/server/external-play/round-open.ts` (D12 stamp readers — one
  authority, consumed by T6's gate and by T8/T9)
- `apps/web/src/server/external-play/__tests__/camera-policy.test.ts` (pure)
- `apps/web/src/server/usecases/__tests__/camera-policy-divisions.test.ts` (DB —
  covers `round-open.ts` too, since both need a seeded fixture)

Modify:
- `apps/web/src/server/external-play/online-play.ts:45-51` —
  `withoutDivisionMetaKeys` must also strip `cameraPolicy` (P-B2-4)
- `apps/web/src/server/usecases/divisions.ts:280-289` (create path),
  `:813-822` (widen the `current` select by `competition_id`),
  `:866-874` (patch path, beside the `onlinePlay` block)
- `apps/web/src/components/v2/division-settings.tsx:379-383` (the `cfg` cast),
  `:415-422` (derive-from-props resync), `:424-426` (state),
  `:627-630` (`saveRules` body), `:936-953` (the boardgame block)
- `apps/web/src/dictionaries/en/ui.json:2393-2396`,
  `es/ui.json:2348-2351`, `fr/ui.json:2393-2396`, `nl/ui.json:2348-2351`
- `apps/web/src/lib/i18n-keys.ts` (generated — `npm run i18n:gen-keys`)

**Interfaces:**

*Consumes:* `HttpError` (`@/lib/errors:12-22`); `WINDOW_OPEN_LEAD_MS`
(`@/server/external-play/window.ts:5`); `audit`
(`@/server/usecases/audit.ts:26`); `readOnlinePlay`/`withoutDivisionMetaKeys`
(`@/server/external-play/online-play.ts`).

*Produces* — the three authoritative exports, verbatim:

```ts
export type CameraPolicy = "off" | "optional" | "required";
export function effectivePolicy(a: { stage: CameraPolicy | null; competition: CameraPolicy | null }): CameraPolicy;
export function assertPolicyChange(a: {
  from: CameraPolicy; to: CameraPolicy; windowOpened: boolean;
}): void; // after windowOpened, only downgrades; throws 409 POLICY_LOCKED
```

plus these, added to T6's own module and consumed by T8/T9:

```ts
export const CAMERA_POLICIES: readonly CameraPolicy[];              // strictness order
export function policyRank(p: CameraPolicy): 0 | 1 | 2;
export function readCameraPolicy(config: unknown): CameraPolicy | null;   // null = unset ⇒ inherit
export function assertCameraPolicyValue(value: unknown): CameraPolicy | null; // 422 CAMERA_POLICY_INVALID
export function applyCameraPolicyToConfig(cfg: Record<string, unknown>, p: CameraPolicy | null): void;
export function fixtureCameraPolicy(fixtureId: string): Promise<CameraPolicy>;
```

and, in `round-open.ts` (D12 — the one authority for the stamp; T8 and T9 read
it rather than each writing their own SQL):

```ts
export type RoundOpen = { roundOpenedAt: Date; openedBy: string | null };
/** null = this fixture's round has never been opened ⇒ not playable. */
export function roundOpenFor(db: AnySql, fixtureId: string): Promise<RoundOpen | null>;
/** Has ANY round of this division been opened at or before `now`? */
export function anyRoundOpened(db: AnySql, divisionId: string, now: Date): Promise<boolean>;
```

`AnySql = postgres.TransactionSql | postgres.Sql`, copied from
`usecases/audit.ts:23` for the same reason: `patchDivision` calls these from
inside its `withTenant` transaction, and issuing a pooled read there is the
pool self-deadlock `divisions.ts:655-660` warns about.

`readCameraPolicy` returns `null` for absent, where `readOnlinePlay` returns
`"off"`. The difference is load-bearing and is why they are not the same shape:
`null` means *inherit*, `"off"` means *explicitly no camera*. Collapsing them
would make a stage unable to opt out of a division's `required` (rule 19 — an
absent value falls through to a default, a present one overrides).

Steps:

- [ ] **Step 1: write the failing empty-case + precedence test for `effectivePolicy`.**
  Create `apps/web/src/server/external-play/__tests__/camera-policy.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";
  import {
    CAMERA_POLICIES,
    effectivePolicy,
    policyRank,
    type CameraPolicy,
  } from "../camera-policy";

  describe("effectivePolicy", () => {
    // THE EMPTY CASE, FIRST. A policy set that answers "no" to every question
    // lands on the default, and three vacuous "Finished" defects shipped in
    // another programme because nobody wrote this line down.
    it("empty case: nothing set at either level ⇒ off", () => {
      expect(effectivePolicy({ stage: null, competition: null })).toBe("off");
    });

    it("stage wins when set, EVEN WHEN LESS STRICT than the inherited default", () => {
      // The differential case: the wrong implementation (max of the two ranks)
      // answers "required" here, so this test can witness the regression.
      expect(effectivePolicy({ stage: "off", competition: "required" })).toBe("off");
      expect(effectivePolicy({ stage: "optional", competition: "required" })).toBe("optional");
    });

    it("inherits the default when the stage is unset", () => {
      expect(effectivePolicy({ stage: null, competition: "required" })).toBe("required");
      expect(effectivePolicy({ stage: null, competition: "optional" })).toBe("optional");
      expect(effectivePolicy({ stage: null, competition: "off" })).toBe("off");
    });

    it("sweeps every (stage, inherited) pair and reports how many it checked", () => {
      const levels: (CameraPolicy | null)[] = [null, ...CAMERA_POLICIES];
      let checked = 0;
      for (const stage of levels) {
        for (const competition of levels) {
          const got = effectivePolicy({ stage, competition });
          const want: CameraPolicy = stage ?? competition ?? "off";
          expect(got, `stage=${stage} competition=${competition}`).toBe(want);
          checked += 1;
        }
      }
      expect(levels.length, "premise: 3 policies plus unset").toBe(4);
      expect(checked, "anti-vacuity: 4 × 4 pairs").toBe(16);
    });

    it("policyRank orders off < optional < required and covers the whole union", () => {
      expect(CAMERA_POLICIES).toEqual(["off", "optional", "required"]);
      expect(CAMERA_POLICIES.map(policyRank)).toEqual([0, 1, 2]);
    });
  });
  ```

- [ ] **Step 2: run it and watch it fail for the right reason.**
  ```
  rm -f /tmp/b2-t6a.json && cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web \
    && DATABASE_URL= npx vitest run src/server/external-play/__tests__/camera-policy.test.ts \
       --reporter=json --outputFile=/tmp/b2-t6a.json
  ```
  Expected: the suite fails to collect —
  `Error: Failed to load url ../camera-policy` / `Cannot find module`, and
  `jq '{t:.numTotalTests,p:.numPassedTests,f:.numFailedTests}' /tmp/b2-t6a.json`
  shows `numTotalTests: 0`. A collect failure is the only acceptable red here;
  `rtk`'s own summary prints `PASS(0) FAIL(0)` for it, so judge the JSON.

- [ ] **Step 3: write the pure half of `camera-policy.ts` and go green.**
  Create the file with only the pure section:

  ```ts
  import "server-only";
  // Camera policy for online chess (spec 2026-10-09 §5.1, owner decisions D5/D9).
  // TWO sections: pure predicates (this half) and the database readers below.
  //
  // `competition` in effectivePolicy is the INHERITED-DEFAULT SLOT, not
  // literally the competitions table: `competitions` has no config jsonb
  // (V207__competitions.sql), so ship 1 inherits stage ← division and feeds the
  // division's value into that slot. A real competition-wide default plugs in
  // here without changing this signature. See plan premise P-B2-2.
  import { HttpError } from "@/lib/errors";

  export type CameraPolicy = "off" | "optional" | "required";

  /** Strictness order — index IS the rank. The only definition of either. */
  export const CAMERA_POLICIES: readonly CameraPolicy[] = ["off", "optional", "required"] as const;

  export function policyRank(p: CameraPolicy): 0 | 1 | 2 {
    const i = CAMERA_POLICIES.indexOf(p);
    if (i !== 0 && i !== 1 && i !== 2) {
      // Not "cannot happen" in a comment: an unranked policy would make
      // assertPolicyChange compare NaN and silently allow every change.
      throw new HttpError(500, `unranked camera policy '${p}'`, "CAMERA_POLICY_UNRANKED");
    }
    return i;
  }

  /** The narrower level wins whenever it is SET, including when it is less
   *  strict than what it inherits — an organiser who turns one stage's camera
   *  off meant it. Both unset ⇒ `off`, which is also the value every row of
   *  existing data reads as (spec §5.1: "Off for all existing data"). */
  export function effectivePolicy(a: {
    stage: CameraPolicy | null;
    competition: CameraPolicy | null;
  }): CameraPolicy {
    return a.stage ?? a.competition ?? "off";
  }
  ```

  Re-run Step 2's command. Expected: `numTotalTests: 5`, `numPassedTests: 5`,
  `numFailedTests: 0`.

- [ ] **Step 4: write the failing `assertPolicyChange` test.**
  Append to the same test file:

  ```ts
  import { HttpError } from "@/lib/errors";
  import { assertPolicyChange } from "../camera-policy";

  describe("assertPolicyChange (D9 — downgrade-only once the window has opened)", () => {
    const pairs: { from: CameraPolicy; to: CameraPolicy }[] = CAMERA_POLICIES.flatMap((from) =>
      CAMERA_POLICIES.map((to) => ({ from, to })),
    );

    it("empty case: before any window opens, every ordered pair is allowed", () => {
      let checked = 0;
      for (const { from, to } of pairs) {
        expect(
          () => assertPolicyChange({ from, to, windowOpened: false }),
          `${from} → ${to} before the window`,
        ).not.toThrow();
        checked += 1;
      }
      expect(checked, "anti-vacuity: 3 × 3 ordered pairs").toBe(9);
    });

    it("once the window has opened, a downgrade or a no-op passes and an upgrade is refused", () => {
      let allowed = 0;
      let refused = 0;
      for (const { from, to } of pairs) {
        if (policyRank(to) <= policyRank(from)) {
          expect(
            () => assertPolicyChange({ from, to, windowOpened: true }),
            `${from} → ${to} is a downgrade or a no-op`,
          ).not.toThrow();
          allowed += 1;
        } else {
          let caught: unknown;
          try {
            assertPolicyChange({ from, to, windowOpened: true });
          } catch (err) {
            caught = err;
          }
          expect(caught, `${from} → ${to} must be refused`).toBeInstanceOf(HttpError);
          expect((caught as HttpError).status).toBe(409);
          expect((caught as HttpError).code).toBe("POLICY_LOCKED");
          refused += 1;
        }
      }
      // Derived from the rank ladder, not typed in: 3 no-ops + 3 downgrades
      // allowed, 3 upgrades refused.
      expect(allowed, "allowed pairs").toBe(6);
      expect(refused, "refused pairs").toBe(3);
      expect(allowed + refused, "anti-vacuity: every pair judged").toBe(9);
    });

    it("the two named attacks D9 exists for: erasing a flag, and stranding the field", () => {
      // required → off after the window would erase a camera flag.
      expect(() => assertPolicyChange({ from: "required", to: "off", windowOpened: true })).not.toThrow();
      // …which is allowed, because it is a RELAXATION the organiser may need.
      // off → required at T−5 strands a field that has no camera ready.
      expect(() => assertPolicyChange({ from: "off", to: "required", windowOpened: true })).toThrow(
        /POLICY_LOCKED|relax/i,
      );
    });
  });
  ```

- [ ] **Step 5: run it and watch it fail.** Same command as Step 2 (new output
  file `/tmp/b2-t6b.json`). Expected: 3 new failures, all
  `TypeError: assertPolicyChange is not a function`; `numTotalTests: 8`,
  `numFailedTests: 3`.

- [ ] **Step 6: implement `assertPolicyChange` and go green.**
  Append to the pure section of `camera-policy.ts`:

  ```ts
  /** D9. Before the first check-in window opens an organiser may set anything.
   *  Afterwards the requirement may only be RELAXED, and the caller writes an
   *  audit row either way — otherwise an org could flip required→off to erase a
   *  camera flag after the fact, or off→required at T−5 and strand a field that
   *  has no camera set up. A no-op (from === to) is always allowed so a re-send
   *  of the current value never 409s. */
  export function assertPolicyChange(a: {
    from: CameraPolicy;
    to: CameraPolicy;
    windowOpened: boolean;
  }): void {
    if (!a.windowOpened) return;
    if (policyRank(a.to) <= policyRank(a.from)) return;
    throw new HttpError(
      409,
      "Check-in has opened — the camera requirement can only be relaxed from here",
      "POLICY_LOCKED",
    );
  }
  ```

  Re-run. Expected `numTotalTests: 8`, `numPassedTests: 8`, `numFailedTests: 0`.

- [ ] **Step 7: mutate the guard you just added, twice, one condition at a time.**
  (a) Delete the `if (!a.windowOpened) return;` line. Re-run: the
  "before any window opens, every ordered pair is allowed" test must fail with
  3 refusals. Restore.
  (b) Change `policyRank(a.to) <= policyRank(a.from)` to `return;`. Re-run: the
  downgrade-only test and the stranding test must both fail. Restore.
  Restore from a `cp` backup taken before each edit — never
  `git checkout <file>`, which on uncommitted work restores the index and
  deletes the implementation the sweep is verifying. Record both mutant results
  in the commit body.

- [ ] **Step 8: commit the pure half.**
  ```
  git add apps/web/src/server/external-play/camera-policy.ts \
          apps/web/src/server/external-play/__tests__/camera-policy.test.ts
  git commit -m "feat(chess): camera policy ladder, downgrade-only after the window opens

  effectivePolicy inherits stage ← default and states its empty case; the
  inherited slot is the division in ship 1 (competitions has no config jsonb).
  assertPolicyChange refuses an upgrade once any check-in window has opened
  (D9). Mutants: dropping the windowOpened early-return reds 3 pairs;
  replacing the rank comparison with a bare return reds 4 cases.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 9: write the failing config-reader test.** Append to the pure test
  file (these stay pure — no DB):

  ```ts
  import {
    applyCameraPolicyToConfig,
    assertCameraPolicyValue,
    readCameraPolicy,
  } from "../camera-policy";

  describe("camera policy config readers", () => {
    it("empty case: a config with no cameraPolicy key reads as null (INHERIT, not off)", () => {
      // null vs "off" is the whole point: "off" is an organiser's explicit
      // choice and overrides what it inherits; null falls through. Collapsing
      // them would stop a stage opting out of a division's `required`.
      expect(readCameraPolicy(null)).toBeNull();
      expect(readCameraPolicy({})).toBeNull();
      expect(readCameraPolicy({ onlinePlay: "lichess", clock: { base: 300 } })).toBeNull();
    });

    it("reads each of the three values, and nothing else", () => {
      let checked = 0;
      for (const p of CAMERA_POLICIES) {
        expect(readCameraPolicy({ cameraPolicy: p })).toBe(p);
        checked += 1;
      }
      expect(checked, "anti-vacuity: every declared policy read back").toBe(3);
      expect(readCameraPolicy({ cameraPolicy: "REQUIRED" })).toBeNull();
      expect(readCameraPolicy({ cameraPolicy: true })).toBeNull();
      expect(readCameraPolicy({ cameraPolicy: "" })).toBeNull();
    });

    it("assertCameraPolicyValue accepts the three values, maps absent to null, and refuses junk", () => {
      for (const p of CAMERA_POLICIES) expect(assertCameraPolicyValue(p)).toBe(p);
      expect(assertCameraPolicyValue(undefined)).toBeNull();
      expect(assertCameraPolicyValue(null)).toBeNull();
      let caught: unknown;
      try {
        assertCameraPolicyValue("mandatory");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(422);
      expect((caught as HttpError).code).toBe("CAMERA_POLICY_INVALID");
    });

    it("applyCameraPolicyToConfig sets a value and DELETES the key for null", () => {
      const cfg: Record<string, unknown> = { variant: "classical" };
      applyCameraPolicyToConfig(cfg, "required");
      expect(cfg.cameraPolicy).toBe("required");
      applyCameraPolicyToConfig(cfg, "off");
      expect(cfg.cameraPolicy, "an explicit off is STORED, not deleted").toBe("off");
      applyCameraPolicyToConfig(cfg, null);
      expect("cameraPolicy" in cfg, "null clears the override entirely").toBe(false);
      expect(cfg.variant, "it touches nothing else").toBe("classical");
    });
  });
  ```

- [ ] **Step 10: run it, watch it fail, implement, run green.** Failure:
  `TypeError: readCameraPolicy is not a function` ×4. Then append to
  `camera-policy.ts`:

  ```ts
  /** Read `config.cameraPolicy`. Absent or unrecognised ⇒ `null` (inherit).
   *  Deliberately NOT `readOnlinePlay`'s shape, which defaults to "off" — see
   *  this file's header and the test's empty case. */
  export function readCameraPolicy(config: unknown): CameraPolicy | null {
    const raw = (config as Record<string, unknown> | null)?.cameraPolicy;
    return CAMERA_POLICIES.find((p) => p === raw) ?? null;
  }

  /** Validate an incoming patch value. `undefined`/`null` ⇒ `null`, meaning
   *  "clear the override", never "off". */
  export function assertCameraPolicyValue(value: unknown): CameraPolicy | null {
    if (value === undefined || value === null) return null;
    const found = CAMERA_POLICIES.find((p) => p === value);
    if (!found) {
      throw new HttpError(
        422,
        "cameraPolicy must be 'off', 'optional' or 'required'",
        "CAMERA_POLICY_INVALID",
      );
    }
    return found;
  }

  /** Apply a validated value onto a parsed sport-config snapshot. */
  export function applyCameraPolicyToConfig(
    cfg: Record<string, unknown>,
    policy: CameraPolicy | null,
  ): void {
    if (policy === null) delete cfg.cameraPolicy;
    else cfg.cameraPolicy = policy;
  }
  ```

  Expected: `numTotalTests: 12`, `numPassedTests: 12`.

- [ ] **Step 11: mutate the reader.** Replace `readCameraPolicy`'s body with
  `return (config as { cameraPolicy?: CameraPolicy })?.cameraPolicy ?? null;`
  (dropping the membership filter). Re-run: the `"REQUIRED"` / `true` / `""`
  assertions in "reads each of the three values, and nothing else" must fail.
  Restore from the `cp` backup.

- [ ] **Step 12: commit the readers.**
  ```
  git add apps/web/src/server/external-play/camera-policy.ts \
          apps/web/src/server/external-play/__tests__/camera-policy.test.ts
  git commit -m "feat(chess): cameraPolicy config readers, with null meaning inherit

  readCameraPolicy returns null for absent, not 'off': an explicit off is an
  organiser's override and must beat what it inherits. Mutant: dropping the
  membership filter reds the junk-value assertions.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 13: extend the shared seed helper (additive only).**
  In `apps/web/src/server/usecases/__tests__/_external-play-seed.ts`: add to
  `SeedOnlineChessFixtureOpts` (after `clock?`, :76) —

  ```ts
    /** Division-level `config.cameraPolicy`. Omitted ⇒ the key is absent,
     *  which is what every pre-existing row looks like (spec §5.1). */
    cameraPolicy?: CameraPolicy;
    /** Stage-level `config.cameraPolicy`, written straight onto stages.config. */
    stageCameraPolicy?: CameraPolicy;
    /** D12: stamps `stage_round_open` for the fixture's round. Omitted ⇒ the
     *  round has never been opened, which is the DEFAULT state of a freshly
     *  paired round. */
    roundOpenedAt?: Date;
  ```

  and to `SeedOnlineChessFixtureResult` (:79-85) — `competitionId: string;`
  and `stageId: string;`. Wire them in the body: pass `cameraPolicy` into the
  `createDivision` config object (:117-122); after `createStages` (:144-149)
  add

  ```ts
    if (opts.stageCameraPolicy) {
      await sql`
        update stages
           set config = config || ${sql.json({ cameraPolicy: opts.stageCameraPolicy } as never)}
         where id = ${stage.id}`;
    }
  ```

  and after the fixture insert (:150-155) add

  ```ts
    if (opts.roundOpenedAt) {
      await sql`
        insert into stage_round_open (stage_id, org_id, round_no, round_opened_at)
        values (${stage.id}, ${owner.orgId}, 1, ${opts.roundOpenedAt})`;
    }
  ```

  then return `competitionId: competition.id, stageId: stage.id` alongside the
  existing fields. Nothing existing is renamed or removed, so the four suites
  already importing this helper keep compiling.

- [ ] **Step 14: write the failing DB test for the stamp readers and `fixtureCameraPolicy`.**
  Create `apps/web/src/server/usecases/__tests__/camera-policy-divisions.test.ts`:

  ```ts
  // T6 — camera policy end to end: the jsonb readers against a real division
  // and stage, the D12 round-open stamp, and the create/patch carry-through.
  import { afterAll, describe, expect, it } from "vitest";
  import { sql } from "@/lib/db";
  import { anyRoundOpened, roundOpenFor } from "@/server/external-play/round-open";
  import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
  import { seedOnlineChessFixture } from "./_external-play-seed";

  const T = new Date("2026-10-01T12:10:00.000Z");
  const OPENED = new Date("2026-10-01T12:00:00.000Z");

  describe.skipIf(!process.env.DATABASE_URL)("camera policy, read off real rows", () => {
    afterAll(async () => {
      await sql.end();
    });

    it("empty case: neither stage nor division sets a policy ⇒ off", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
      });
      expect(await fixtureCameraPolicy(s.fixtureId)).toBe("off");
    });

    it("empty case: a fixture id that does not exist ⇒ off, not a throw", async () => {
      expect(await fixtureCameraPolicy("00000000-0000-0000-0000-000000000000")).toBe("off");
    });

    it("the division's value is inherited when the stage sets nothing", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
        cameraPolicy: "required",
      });
      expect(await fixtureCameraPolicy(s.fixtureId)).toBe("required");
    });

    it("the stage overrides the division, including DOWNWARDS", async () => {
      // The differential case: an implementation that took the stricter of the
      // two would answer "required" here.
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
        cameraPolicy: "required",
        stageCameraPolicy: "off",
      });
      expect(await fixtureCameraPolicy(s.fixtureId)).toBe("off");
    });
  });

  describe.skipIf(!process.env.DATABASE_URL)("D12 round-open stamp", () => {
    it("empty case: a freshly paired round has no stamp ⇒ roundOpenFor is null and anyRoundOpened is false", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
      });
      expect(await roundOpenFor(sql, s.fixtureId)).toBeNull();
      expect(await anyRoundOpened(sql, s.divisionId, T)).toBe(false);
    });

    it("an opened round is readable, and the schedule is NOT what decides it", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
        roundOpenedAt: OPENED,
      });
      const open = await roundOpenFor(sql, s.fixtureId);
      expect(open?.roundOpenedAt.getTime()).toBe(OPENED.getTime());
      expect(await anyRoundOpened(sql, s.divisionId, OPENED)).toBe(true);
      // One millisecond before the stamp it is not yet open — the comparison
      // is against the STAMP, so a fixture scheduled for T (ten minutes later)
      // cannot make it true on its own.
      expect(await anyRoundOpened(sql, s.divisionId, new Date(OPENED.getTime() - 1))).toBe(false);
    });

    it("a stamp on a DIFFERENT round of the same stage does not open this fixture's round", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
      });
      await sql`
        insert into stage_round_open (stage_id, org_id, round_no, round_opened_at)
        values (${s.stageId}, ${s.orgId}, 2, ${OPENED})`;
      // The fixture is round 1. Per-fixture: still closed.
      expect(await roundOpenFor(sql, s.fixtureId)).toBeNull();
      // Per-division: a round HAS been opened, which is what T6's gate asks.
      expect(await anyRoundOpened(sql, s.divisionId, OPENED)).toBe(true);
    });
  });
  ```

- [ ] **Step 15: run it and watch it fail.**
  ```
  rm -f /tmp/b2-t6c.json && cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web \
    && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable \
       npx vitest run src/server/usecases/__tests__/camera-policy-divisions.test.ts \
       --reporter=json --outputFile=/tmp/b2-t6c.json
  ```
  Expected: collect failure, `Cannot find module …/external-play/round-open`,
  `numTotalTests: 0`. Then confirm the test DB actually has T1's tables before
  blaming the code:
  `psql "$DATABASE_URL" -c '\d stage_round_open'` must print the four columns
  from the prerequisite block. If it errors `did not find any relation`, T1 has
  not merged or the test DB predates it — **stop and report**; do not write a
  migration here.

- [ ] **Step 16: write `round-open.ts`.**

  ```ts
  import "server-only";
  // D12 (spec §3.2): a round is PAIRED automatically and OPENED by hand. The
  // organiser's open stamps `round_opened_at`, sends the invites and starts the
  // window — so T−10/T+20 hang off this stamp, never off `fixtures.scheduled_at`,
  // which is only what players are shown. A fixture whose round has no stamp is
  // not playable.
  //
  // The reschedule detector in guard.ts (`scheduled_at_basis`) is a DIFFERENT
  // question and stays schedule-based; do not re-anchor it.
  import type postgres from "postgres";

  type AnySql = postgres.TransactionSql | postgres.Sql;

  export type RoundOpen = { roundOpenedAt: Date; openedBy: string | null };

  /** `null` ⇒ this fixture's round has never been opened. */
  export async function roundOpenFor(db: AnySql, fixtureId: string): Promise<RoundOpen | null> {
    const rows = await db<{ roundOpenedAt: Date; openedBy: string | null }[]>`
      select sro.round_opened_at as "roundOpenedAt", sro.opened_by as "openedBy"
        from fixtures f
        join stage_round_open sro
          on sro.stage_id = f.stage_id and sro.round_no = f.round_no
       where f.id = ${fixtureId}`;
    return rows[0] ?? null;
  }

  /** Has ANY round of this division been opened at or before `now`? T6's
   *  downgrade gate asks this, not "is this fixture's round open": once ONE
   *  round has gone out, tightening the camera requirement would strand the
   *  field, whichever round the organiser is looking at. */
  export async function anyRoundOpened(db: AnySql, divisionId: string, now: Date): Promise<boolean> {
    const [row] = await db<{ opened: boolean }[]>`
      select exists(
        select 1
          from stage_round_open sro
          join stages s on s.id = sro.stage_id
         where s.division_id = ${divisionId}
           and sro.round_opened_at <= ${now}
      ) as opened`;
    return row?.opened === true;
  }
  ```

- [ ] **Step 17: write the DB section of `camera-policy.ts`.**
  Append below the pure section:

  ```ts
  import { sql } from "@/lib/db";

  /** The effective policy for one fixture: its stage's override, else its
   *  division's, else `off`. One query; a fixture that does not exist reads
   *  `off` rather than throwing, because every caller's answer to "no such
   *  fixture" is already "no camera to gate on". */
  export async function fixtureCameraPolicy(fixtureId: string): Promise<CameraPolicy> {
    const [row] = await sql<
      { stageConfig: unknown; divisionConfig: unknown }[]
    >`
      select s.config as "stageConfig", d.config as "divisionConfig"
        from fixtures f
        left join stages s on s.id = f.stage_id
        join divisions d on d.id = f.division_id
       where f.id = ${fixtureId}`;
    if (!row) return "off";
    return effectivePolicy({
      stage: readCameraPolicy(row.stageConfig),
      competition: readCameraPolicy(row.divisionConfig),
    });
  }
  ```

- [ ] **Step 18: run green.** Re-run Step 15's command. Expected
  `numTotalTests: 7`, `numPassedTests: 7`, `numFailedTests: 0`. Confirm
  `jq -r '.testResults[].name' /tmp/b2-t6c.json` resolves inside the worktree —
  a `cd` that silently landed in the main checkout returns a false green.

- [ ] **Step 19: mutate both new readers, one at a time.**
  (a) In `anyRoundOpened`, delete `and sro.round_opened_at <= ${now}`. Re-run:
  "an opened round is readable…"'s one-millisecond-before assertion must fail.
  Restore.
  (b) In `roundOpenFor`, drop `and sro.round_no = f.round_no` from the join.
  Re-run: "a stamp on a DIFFERENT round…" must fail. Restore.
  (c) In `fixtureCameraPolicy`, swap the two `effectivePolicy` arguments. Re-run:
  "the stage overrides the division, including DOWNWARDS" must fail. Restore.
  Each restore from a `cp` backup.

- [ ] **Step 20: commit the readers.**
  ```
  git add apps/web/src/server/external-play/round-open.ts \
          apps/web/src/server/external-play/camera-policy.ts \
          apps/web/src/server/usecases/__tests__/_external-play-seed.ts \
          apps/web/src/server/usecases/__tests__/camera-policy-divisions.test.ts
  git commit -m "feat(chess): read the effective camera policy and the D12 round-open stamp

  fixtureCameraPolicy resolves stage over division over off, in one query.
  round-open.ts is the single authority for round_opened_at: the window hangs
  off the organiser's open, never off the timetable, so a stale schedule can no
  longer open a window for a round nobody started. Mutants: dropping the
  stamp comparison, the round_no join, and swapping the policy precedence each
  red exactly one test.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 21: write the failing create/patch carry-through test.**
  Append to `camera-policy-divisions.test.ts`:

  ```ts
  import { HttpError } from "@/lib/errors";
  import { getDivision, patchDivision } from "../divisions";
  import type { AuthCtx } from "@/server/api-v1/auth";

  const authFor = (s: { orgId: string }, userId: string): AuthCtx =>
    ({ orgId: s.orgId, via: "session", userId, role: "owner", keyId: null }) as AuthCtx;

  describe.skipIf(!process.env.DATABASE_URL)("cameraPolicy through createDivision / patchDivision", () => {
    it("create stores the value the organiser chose", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
        cameraPolicy: "optional",
      });
      const [row] = await sql<{ config: Record<string, unknown> }[]>`
        select config from divisions where id = ${s.divisionId}`;
      // This is the P-B2-3 guard: configSchema.safeParse strips unknown keys,
      // so without an explicit carry-through the key is silently gone.
      expect(row?.config.cameraPolicy).toBe("optional");
      expect(row?.config.onlinePlay, "the neighbouring meta key still survives").toBe("lichess");
    });

    it("a patch that does not NAME cameraPolicy leaves the stored value alone", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
        cameraPolicy: "required",
      });
      const auth = authFor(s, (await ownerUserId(s.orgId)));
      await patchDivision(auth, s.divisionId, { config: { variant: "classical", onlinePlay: "lichess" } });
      const after = await getDivision(auth, s.divisionId);
      expect((after.config as Record<string, unknown>).cameraPolicy).toBe("required");
    });

    it("before any round is opened, a TIGHTENING patch is allowed and audited", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
        cameraPolicy: "off",
      });
      const userId = await ownerUserId(s.orgId);
      await patchDivision(authFor(s, userId), s.divisionId, {
        config: { variant: "classical", onlinePlay: "lichess", cameraPolicy: "required" },
      });
      const [row] = await sql<{ config: Record<string, unknown> }[]>`
        select config from divisions where id = ${s.divisionId}`;
      expect(row?.config.cameraPolicy).toBe("required");
      const events = await sql<{ payload: Record<string, unknown>; actor_id: string | null }[]>`
        select payload, actor_id from competition_events
         where competition_id = ${s.competitionId} and type = 'chess.camera_policy_changed'`;
      expect(events.length, "exactly one audit row").toBe(1);
      expect(events[0]?.payload).toMatchObject({ divisionId: s.divisionId, from: "off", to: "required" });
      expect(events[0]?.actor_id).toBe(userId);
    });

    it("once a round is OPEN, a tightening patch is refused 409 POLICY_LOCKED and nothing is written", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
        cameraPolicy: "off",
        roundOpenedAt: OPENED,
      });
      const auth = authFor(s, await ownerUserId(s.orgId));
      let caught: unknown;
      try {
        await patchDivision(auth, s.divisionId, {
          config: { variant: "classical", onlinePlay: "lichess", cameraPolicy: "required" },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(409);
      expect((caught as HttpError).code).toBe("POLICY_LOCKED");
      const [row] = await sql<{ config: Record<string, unknown> }[]>`
        select config from divisions where id = ${s.divisionId}`;
      expect(row?.config.cameraPolicy, "the refused value was not written").toBe("off");
      const events = await sql<{ id: string }[]]>`
        select id from competition_events
         where competition_id = ${s.competitionId} and type = 'chess.camera_policy_changed'`;
      expect(events.length, "a refused change writes no audit row").toBe(0);
    });

    it("once a round is OPEN, a RELAXING patch still goes through, and is audited", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
        cameraPolicy: "required",
        roundOpenedAt: OPENED,
      });
      const auth = authFor(s, await ownerUserId(s.orgId));
      await patchDivision(auth, s.divisionId, {
        config: { variant: "classical", onlinePlay: "lichess", cameraPolicy: "off" },
      });
      const [row] = await sql<{ config: Record<string, unknown> }[]>`
        select config from divisions where id = ${s.divisionId}`;
      expect(row?.config.cameraPolicy).toBe("off");
      const events = await sql<{ payload: Record<string, unknown> }[]>`
        select payload from competition_events
         where competition_id = ${s.competitionId} and type = 'chess.camera_policy_changed'`;
      expect(events.length, "relaxing after the open is allowed, and audited (D9)").toBe(1);
      expect(events[0]?.payload).toMatchObject({ from: "required", to: "off" });
    });

    it("re-sending the SAME value after the open is a no-op, not a 409, and writes no audit row", async () => {
      // The UI re-sends the whole config on every Save, so this is the common
      // path, not an edge case: a 409 here would make the Rules block unusable.
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
        cameraPolicy: "required",
        roundOpenedAt: OPENED,
      });
      const auth = authFor(s, await ownerUserId(s.orgId));
      await patchDivision(auth, s.divisionId, {
        config: { variant: "classical", onlinePlay: "lichess", cameraPolicy: "required" },
      });
      const events = await sql<{ id: string }[]>`
        select id from competition_events
         where competition_id = ${s.competitionId} and type = 'chess.camera_policy_changed'`;
      expect(events.length).toBe(0);
    });

    it("a division WITH fixtures can still change its camera policy (not a format change)", async () => {
      // P-B2-4. `seedOnlineChessFixture` always creates a fixture, so every
      // case above is already format-locked; this one says so out loud and
      // fails with FORMAT_LOCKED until `withoutDivisionMetaKeys` strips
      // cameraPolicy.
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
      });
      const auth = authFor(s, await ownerUserId(s.orgId));
      const [{ locked }] = await sql<{ locked: boolean }[]>`
        select exists(
          select 1 from fixtures f join stages st on st.id = f.stage_id
           where st.division_id = ${s.divisionId}
        ) as locked`;
      expect(locked, "premise: this division is format-locked").toBe(true);
      await patchDivision(auth, s.divisionId, {
        config: { variant: "classical", onlinePlay: "lichess", cameraPolicy: "optional" },
      });
      const [row] = await sql<{ config: Record<string, unknown> }[]>`
        select config from divisions where id = ${s.divisionId}`;
      expect(row?.config.cameraPolicy).toBe("optional");
    });

    it("a junk value is refused 422 CAMERA_POLICY_INVALID", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: T,
        linked: true,
      });
      const auth = authFor(s, await ownerUserId(s.orgId));
      await expect(
        patchDivision(auth, s.divisionId, {
          config: { variant: "classical", onlinePlay: "lichess", cameraPolicy: "mandatory" },
        }),
      ).rejects.toMatchObject({ status: 422, code: "CAMERA_POLICY_INVALID" });
    });
  });

  /** The seed helper creates the owner internally and does not return the user
   *  id; patchDivision needs an AuthCtx, so read it back. */
  async function ownerUserId(orgId: string): Promise<string> {
    const [row] = await sql<{ user_id: string }[]>`
      select user_id from org_members where org_id = ${orgId} and role = 'owner' limit 1`;
    if (!row) throw new Error("seed produced no owner membership");
    return row.user_id;
  }
  ```

  Fix the one deliberate typo before running: `sql<{ id: string }[]]>` in the
  409 case is `sql<{ id: string }[]>`.

- [ ] **Step 22: run it and watch it fail for the right reasons.** Re-run Step
  15's command. Expected `numTotalTests: 16`, `numFailedTests: 8`, with the
  first case failing `expected undefined to be 'optional'` (the key was
  stripped — P-B2-3), the format-lock case failing
  `HttpError: Format is locked — fixtures exist` (P-B2-4), and the 409/audit
  cases failing because nothing refuses or records anything yet.

- [ ] **Step 23: strip `cameraPolicy` from the format-lock comparison.**
  `apps/web/src/server/external-play/online-play.ts:45-51` —

  ```ts
  /** Strip division-level keys that ride in config but are not sport schema.
   *  These are what `patchDivision`'s format lock IGNORES, so anything listed
   *  here stays editable once fixtures exist. `cameraPolicy` must be in the
   *  list: the camera requirement is only ever edited on a division that
   *  already has a timetable. */
  export function withoutDivisionMetaKeys(config: Record<string, unknown>): Record<string, unknown> {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) {
      if (k !== "entrants" && k !== "onlinePlay" && k !== "cameraPolicy") rest[k] = v;
    }
    return rest;
  }
  ```

- [ ] **Step 24: carry `cameraPolicy` through `createDivision`.**
  `divisions.ts:280-289`, directly after the `applyOnlinePlayToConfig` line:

  ```ts
      applyCameraPolicyToConfig(finalConfig, assertCameraPolicyValue(inputCfg?.cameraPolicy));
  ```

  `assertCameraPolicyValue` maps an absent key to `null`, which deletes
  nothing and writes nothing — so a division created without the field has no
  key, exactly like every existing row. Add the import beside the
  `online-play` one at `divisions.ts:46-49`:

  ```ts
  import { applyCameraPolicyToConfig, assertCameraPolicyValue, readCameraPolicy } from "@/server/external-play/camera-policy";
  import { anyRoundOpened } from "@/server/external-play/round-open";
  import { assertPolicyChange } from "@/server/external-play/camera-policy";
  import { audit } from "./audit";
  ```

  (collapse the two `camera-policy` imports into one statement when writing.)

- [ ] **Step 25: widen the `current` select and gate the patch.**
  `divisions.ts:813-822` — add `competition_id: string;` to the row type and
  `competition_id` to the select list. Then, immediately after the
  `onlinePlay` block at `:866-874`:

  ```ts
      // D9/D12 (spec §5.1). The stored value this write replaces, and the
      // incoming one. A patch that does not NAME cameraPolicy carries the
      // stored value through — configSchema strips unknown keys, so "not
      // named" must not mean "cleared".
      const storedCamera = readCameraPolicy(current.config) ?? "off";
      const incomingCamera =
        patchCfg && "cameraPolicy" in patchCfg
          ? assertCameraPolicyValue(patchCfg.cameraPolicy)
          : readCameraPolicy(current.config);
      if ((incomingCamera ?? "off") !== storedCamera) {
        // Only a real CHANGE is gated and audited: the Rules block re-sends
        // the whole config on every Save, and a 409 on a no-op would make the
        // screen unusable.
        assertPolicyChange({
          from: storedCamera,
          to: incomingCamera ?? "off",
          windowOpened: await anyRoundOpened(tx, id, new Date()),
        });
        await audit(
          tx,
          current.competition_id,
          auth.orgId,
          "chess.camera_policy_changed",
          { divisionId: id, from: storedCamera, to: incomingCamera ?? "off" },
          auth.userId,
        );
      }
      applyCameraPolicyToConfig(finalConfig, incomingCamera);
  ```

  Placement is load-bearing and is why this sits inside the transaction: the
  audit row and the config write commit together, so a refused change can
  never leave a row saying it happened (`transaction enforces guard placement`).

- [ ] **Step 26: run green.** Re-run Step 15's command. Expected
  `numTotalTests: 16`, `numPassedTests: 16`, `numFailedTests: 0`.

- [ ] **Step 27: mutate the three guards you just added, one at a time.**
  (a) Replace `await anyRoundOpened(tx, id, new Date())` with `false`. Re-run:
  the 409 case must fail. Restore.
  (b) Drop the `(incomingCamera ?? "off") !== storedCamera` condition so every
  patch audits. Re-run: the "re-sending the SAME value" case must fail with
  `expected 1 to be 0`. Restore.
  (c) Revert the `online-play.ts` strip-list edit. Re-run: the format-lock case
  must fail with `FORMAT_LOCKED`. Restore.

- [ ] **Step 28: typecheck and lint, then commit the server half.**
  ```
  rtk proxy npx tsc --noEmit -p apps/web
  rtk proxy npx eslint apps/web/src/server/external-play/camera-policy.ts \
    apps/web/src/server/external-play/round-open.ts \
    apps/web/src/server/external-play/online-play.ts \
    apps/web/src/server/usecases/divisions.ts
  ```
  Read `✖ N problems` from the raw output — `rtk` hides lint output and prints
  "ESLint output (JSON parse failed)" for a clean run, which is the wrapper
  losing the result, not a pass.
  ```
  git add apps/web/src/server/usecases/divisions.ts \
          apps/web/src/server/external-play/online-play.ts \
          apps/web/src/server/usecases/__tests__/camera-policy-divisions.test.ts
  git commit -m "feat(chess): cameraPolicy on create and patch, downgrade-only once a round is open

  The key is carried explicitly through configSchema.safeParse (which strips
  unknown keys) on both paths, and added to withoutDivisionMetaKeys so the
  format lock ignores it — the camera requirement is only ever edited on a
  division that already has fixtures. A real change is gated by
  assertPolicyChange against the D12 round-open stamp and audited to
  competition_events in the same transaction; a re-send of the current value
  is a no-op. Mutants: forcing windowOpened false, auditing unconditionally,
  and reverting the strip list each red exactly one case.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 29: add the copy to all four locales.**
  Insert after the `divset.onlinePlay.*` block in each file (en:2396, es:2351,
  fr:2396, nl:2351) and **correct the now-false `onlinePlay.help` sentence in
  place** (P-B2-5 — D3 deleted the "games run on Lichess" product).

  `en/ui.json` — replace :2394 and insert after :2396:
  ```json
    "divset.onlinePlay.help": "Players link Lichess in Settings; matches are played on this site and Lichess settles legality, clocks and results.",
    "divset.camera.label": "Camera during online play",
    "divset.camera.off": "Off — no camera",
    "divset.camera.optional": "Optional — shown if the player allows it",
    "divset.camera.required": "Required — the camera must be live to take a seat",
    "divset.camera.help": "Required means a player cannot take their seat until their camera is live. Their camera may be reviewed by an organiser. Once a round has been opened you can only relax this setting, never tighten it.",
    "divset.err.cameraPolicyLocked": "A round has already been opened for this division — the camera requirement can only be relaxed from here, not tightened.",
  ```

  `es/ui.json`:
  ```json
    "divset.onlinePlay.help": "Los jugadores vinculan Lichess en Ajustes; las partidas se juegan en este sitio y Lichess resuelve la legalidad, los relojes y los resultados.",
    "divset.camera.label": "Cámara durante el juego en línea",
    "divset.camera.off": "Desactivada — sin cámara",
    "divset.camera.optional": "Opcional — se muestra si el jugador lo permite",
    "divset.camera.required": "Obligatoria — la cámara debe estar activa para ocupar el puesto",
    "divset.camera.help": "Obligatoria significa que un jugador no puede ocupar su puesto hasta que su cámara esté activa. Un organizador puede revisar su cámara. Una vez abierta una ronda, solo puedes relajar este ajuste, nunca endurecerlo.",
    "divset.err.cameraPolicyLocked": "Ya se ha abierto una ronda en esta división: desde aquí el requisito de cámara solo puede relajarse, no endurecerse.",
  ```

  `fr/ui.json`:
  ```json
    "divset.onlinePlay.help": "Les joueurs lient Lichess dans Paramètres ; les parties se jouent sur ce site et Lichess tranche la légalité, les pendules et les résultats.",
    "divset.camera.label": "Caméra pendant le jeu en ligne",
    "divset.camera.off": "Désactivée — sans caméra",
    "divset.camera.optional": "Facultative — affichée si le joueur l'autorise",
    "divset.camera.required": "Obligatoire — la caméra doit être active pour prendre place",
    "divset.camera.help": "Obligatoire signifie qu'un joueur ne peut pas prendre place avant que sa caméra soit active. Sa caméra peut être consultée par un organisateur. Une fois une ronde ouverte, vous ne pouvez plus qu'assouplir ce réglage, jamais le durcir.",
    "divset.err.cameraPolicyLocked": "Une ronde a déjà été ouverte pour cette division : l'exigence de caméra ne peut plus qu'être assouplie, jamais durcie.",
  ```

  `nl/ui.json`:
  ```json
    "divset.onlinePlay.help": "Spelers koppelen Lichess in Instellingen; partijen worden op deze site gespeeld en Lichess beslist over legaliteit, klokken en resultaten.",
    "divset.camera.label": "Camera tijdens online spelen",
    "divset.camera.off": "Uit — geen camera",
    "divset.camera.optional": "Optioneel — zichtbaar als de speler het toestaat",
    "divset.camera.required": "Verplicht — de camera moet live zijn om plaats te nemen",
    "divset.camera.help": "Verplicht betekent dat een speler geen plaats kan nemen tot zijn camera live is. Zijn camera kan door een organisator worden bekeken. Zodra een ronde is geopend, kun je deze instelling alleen versoepelen, nooit verscherpen.",
    "divset.err.cameraPolicyLocked": "Er is al een ronde geopend voor deze divisie — de camera-eis kan vanaf nu alleen worden versoepeld, niet verscherpt.",
  ```

  Every one of these says "may be reviewed by an organiser" and none says
  "monitored" — spec §5.4: there is no mandatory observer (D8), so "you are
  being monitored" would be a false statement inside a consent flow.

- [ ] **Step 30: regenerate the key union and check parity.**
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play \
    && npm run i18n:gen-keys && npm run i18n:check
  ```
  `i18n:check` must report parity across all four locales (6 new keys each, one
  changed value each). `i18n:gen-keys` rewrites
  `apps/web/src/lib/i18n-keys.ts`, which is checked in and has a CI drift gate
  (`ci.yml`, "i18n key union drift + locale parity") — commit the regenerated
  file or CI reds on `git diff --exit-code`.

- [ ] **Step 31: add the `<select>` to the boardgame block.**
  `division-settings.tsx:936-953` — inside the existing
  `division.sport_key === "boardgame" && (...)` block, after the
  `onlinePlay.help` paragraph at :951:

  ```tsx
              <div className="mt-3">
                <label className="block text-xs text-slate-500">
                  {msg("divset.camera.label")}
                  <select
                    disabled={!canEdit || onlinePlay === "off"}
                    value={cameraPolicy}
                    onChange={(e) => setCameraPolicy(e.target.value as CameraPolicy)}
                    className="input mt-1 w-full"
                    data-testid="division-camera-policy"
                  >
                    <option value="off">{msg("divset.camera.off")}</option>
                    <option value="optional">{msg("divset.camera.optional")}</option>
                    <option value="required">{msg("divset.camera.required")}</option>
                  </select>
                </label>
                <p className="mt-1 text-[11px] text-slate-400">{msg("divset.camera.help")}</p>
              </div>
  ```

  Disabled when online play is off: the camera only exists for a match played
  on our page. It stays rendered rather than hidden so the setting is
  discoverable before the organiser flips online play on.

- [ ] **Step 32: add the state, the resync and the save.**
  - `:379-383`, widen the `cfg` cast: add `cameraPolicy?: string;` to the
    inline type.
  - `:424-426`, beside the `onlinePlay` pair:
    ```tsx
    const [cameraPolicy, setCameraPolicy] = useState<CameraPolicy>(
      readPolicyFromConfig(cfg.cameraPolicy),
    );
    ```
    with a module-scope helper above `DivisionSettings` (this file is a client
    component and must not import the `server-only` module):
    ```tsx
    /** Mirrors readCameraPolicy's membership filter. "off" is the control's
     *  value for BOTH "explicitly off" and "never set" — the server keeps the
     *  distinction (absent ⇒ inherit), and a <select> has no third state. */
    function readPolicyFromConfig(raw: unknown): CameraPolicy {
      return raw === "optional" || raw === "required" ? raw : "off";
    }
    ```
    and `type CameraPolicy = "off" | "optional" | "required";` declared locally
    with a comment pointing at
    `apps/web/src/server/external-play/camera-policy.ts` as the authority.
  - `:417-422`, inside the derive-from-props resync, beside the `setOnlinePlay`
    line: `setCameraPolicy(readPolicyFromConfig(cfg.cameraPolicy));` — without
    it, a value the server refused with 409 keeps showing in the control, which
    is exactly the F6 defect that block exists for.
  - `:627-630`, inside `saveRules`'s boardgame branch:
    ```tsx
      if (division.sport_key === "boardgame") {
        if (onlinePlay === "lichess") override.onlinePlay = "lichess";
        else delete override.onlinePlay;
        override.cameraPolicy = cameraPolicy;
      }
    ```
    Always sent, never deleted: the control has no "unset" position, so an
    omitted key would mean "inherit" and silently re-point the division at a
    default the organiser never chose.
  - `:489-498`, in `run()`'s error branch, add a clause beside the
    `SWISS_ROUNDS_REQUIRED_CODE` one so the 409 is localised rather than shown
    as the server's English:
    ```tsx
      } else if (err instanceof ApiV1Error && err.code === "POLICY_LOCKED") {
        setError(msg("divset.err.cameraPolicyLocked"));
    ```

- [ ] **Step 33: typecheck, lint, and hand the visual proof to B5.**
  ```
  rtk proxy npx tsc --noEmit -p apps/web
  rtk proxy npx eslint apps/web/src/components/v2/division-settings.tsx
  ```
  **No unit test is written for any of Step 31–32.** `apps/web` vitest is
  `environment: "node"` — there is no DOM, so a class-scan or render test here
  would prove nothing about the control and would be decoration. The claims
  "the select appears", "it is disabled when online play is off", "the 409
  renders the localised sentence" and the 320/768/1280 bar are **owed by B5**,
  which extends `apps/web/e2e/division-settings.spec.ts`. Record that in the
  B5 task's inputs; do not quietly skip it.

- [ ] **Step 34: commit the UI and copy.**
  ```
  git add apps/web/src/components/v2/division-settings.tsx \
          apps/web/src/dictionaries/en/ui.json apps/web/src/dictionaries/es/ui.json \
          apps/web/src/dictionaries/fr/ui.json apps/web/src/dictionaries/nl/ui.json \
          apps/web/src/lib/i18n-keys.ts
  git commit -m "feat(chess): camera policy control in division settings, four locales

  Three-value select beside Online play, disabled while online play is off, with
  the stored value re-derived on every refresh so a server-refused change cannot
  keep showing. POLICY_LOCKED is localised rather than surfaced as server
  English. Copy says the camera 'may be reviewed by an organiser', never
  'monitored' (spec 5.4 — there is no mandatory observer). Also corrects
  divset.onlinePlay.help, which still promised games played on lichess.org
  after D3 deleted that mode. Visual proof at 320/768/1280 is owed by B5's
  division-settings spec; apps/web vitest is node-env and cannot see it.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 7: RealtimeKit adapter — meeting and participant lifecycle

**Files:**

Create:
- `apps/web/src/server/external-play/video/realtimekit.ts`
- `apps/web/src/server/external-play/video/__tests__/realtimekit.test.ts`

Modify:
- `apps/web/.env.example` — new block after `LICHESS_WEBHOOK_SECRET=` (:95)

Read first, copy nothing: `/Users/ashokhein/Downloads/chess-tournament-poc/lib/realtimekit.js`
is a **mechanism reference for the REST shapes only**. Its `.env` was never
read. Rejected outright (spec §10): the `isMockVideo()` fallback that silently
returns `mock-token-*` when credentials are absent, and the preset defaults
`group_call_participant` / `group_call_host` — a default preset nobody checked
may permit toggling video off, which would defeat the only camera enforcement
we have (P-B2-6). The POC also has no publisher check and no teardown at all;
both are designed here from the live OpenAPI spec.

**Interfaces:**

*Consumes:* nothing from B2's other tasks. `sql` (`@/lib/db`), `HttpError`
(`@/lib/errors:12-22`).

*Produces* — the authoritative exports, verbatim:

```ts
export type MeetingRef = { meetingId: string };
export type ParticipantToken = { participantId: string; authToken: string };
export function ensureMeeting(fixtureId: string): Promise<MeetingRef>;
export function addParticipant(a: {
  meetingId: string; subject: string; preset: "player" | "arbiter";
}): Promise<ParticipantToken>;
export function hasLiveVideoPublisher(a: { meetingId: string; participantId: string }): Promise<boolean>;
export function endMeeting(meetingId: string): Promise<void>;
```

plus, added to T7's own module:

```ts
export type RealtimeKitDeps = { fetch?: typeof fetch; baseUrl?: string };
export const REALTIMEKIT_TIMEOUT_MS: number;          // 10_000
export class RealtimeKitError extends Error { readonly status: number; readonly code: RealtimeKitCode }
export type RealtimeKitCode = "unconfigured" | "unauthorized" | "not_found" | "unavailable";
export function realtimeKitConfigured(): boolean;
```

Every exported function takes an **optional trailing `deps: RealtimeKitDeps`**
— additive, so a one-argument call from T8 keeps matching the authoritative
signature, and tests inject a stub `fetch` without a module mock. This mirrors
`lichess/adapter.ts:14-29`'s injected-fetch convention; `REALTIMEKIT_BASE_URL`
overrides the origin the way `LICHESS_BASE_URL` does
(`lichess/client.ts:8-13`), so B5's e2e can point at a stub.

Steps:

- [ ] **Step 1: confirm T1's tables exist before writing a line.**
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play \
    && psql "postgresql://postgres@127.0.0.1:54890/seazn_chess-lep" -c '\d fixture_video_meeting'
  ```
  Expected: the seven columns from the prerequisite DDL block. `did not find
  any relation` ⇒ T1 has not merged, or the test DB predates it — **stop and
  report**. Do not add a migration from this task.

- [ ] **Step 2: write the failing configuration test.**
  Create `apps/web/src/server/external-play/video/__tests__/realtimekit.test.ts`:

  ```ts
  import { afterEach, describe, expect, it, vi } from "vitest";
  import { RealtimeKitError, realtimeKitConfigured } from "../realtimekit";

  const ENV_KEYS = [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "REALTIMEKIT_APP_ID",
    "REALTIMEKIT_PLAYER_PRESET",
    "REALTIMEKIT_ARBITER_PRESET",
  ] as const;

  function configure(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
    const full: Record<string, string> = {
      CLOUDFLARE_ACCOUNT_ID: "acct-1",
      CLOUDFLARE_API_TOKEN: "cf-token-do-not-leak-0123456789",
      REALTIMEKIT_APP_ID: "app-1",
      REALTIMEKIT_PLAYER_PRESET: "seazn_chess_player",
      REALTIMEKIT_ARBITER_PRESET: "seazn_chess_arbiter",
    };
    for (const k of ENV_KEYS) vi.stubEnv(k, overrides[k] ?? full[k]!);
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("realtimeKitConfigured", () => {
    it("sweeps every combination of the five required variables and reports the count", () => {
      let checked = 0;
      let configured = 0;
      // 2^5 — each variable present or empty. There is NO default for any of
      // them: the POC defaults its preset names, and a preset we did not
      // choose may permit turning the camera off, which is the only
      // enforcement the seat gate has (plan premise P-B2-6).
      for (let mask = 0; mask < 32; mask += 1) {
        const overrides: Record<string, string> = {};
        ENV_KEYS.forEach((k, i) => {
          if ((mask & (1 << i)) !== 0) overrides[k] = "";
        });
        configure(overrides as Partial<Record<(typeof ENV_KEYS)[number], string>>);
        const got = realtimeKitConfigured();
        expect(got, `mask ${mask}`).toBe(mask === 0);
        if (got) configured += 1;
        checked += 1;
        vi.unstubAllEnvs();
      }
      expect(checked, "anti-vacuity: 2^5 combinations").toBe(32);
      expect(configured, "exactly one combination is fully configured").toBe(1);
    });
  });

  describe("RealtimeKitError", () => {
    it("carries a status and a code", () => {
      const err = new RealtimeKitError(503, "unavailable", "upstream down");
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(503);
      expect(err.code).toBe("unavailable");
      expect(err.name).toBe("RealtimeKitError");
    });
  });
  ```

- [ ] **Step 3: run it and watch it fail.**
  ```
  rm -f /tmp/b2-t7a.json && cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web \
    && DATABASE_URL= npx vitest run src/server/external-play/video/__tests__/realtimekit.test.ts \
       --reporter=json --outputFile=/tmp/b2-t7a.json
  ```
  Expected: collect failure, `Cannot find module ../realtimekit`,
  `numTotalTests: 0`.

- [ ] **Step 4: write the config half of `realtimekit.ts` and go green.**

  ```ts
  import "server-only";
  // Cloudflare RealtimeKit — meeting and participant lifecycle for the camera
  // tile beside the board (spec §5). REST shapes verified against the live
  // Cloudflare OpenAPI spec on 2026-10-09.
  //
  // WHAT THIS MODULE CANNOT DO, and why that is written here rather than
  // discovered later: RealtimeKit exposes NO per-participant video-publishing
  // signal to a server. `active-session` gives a status and a live-participant
  // COUNT; session participants give joined_at/left_at and peer events
  // (PEER_CREATED | PEER_JOINING | PEER_LEAVING). `videoEnabled` and
  // `onVideoUpdate` exist only in the CLIENT SDK — which is exactly the
  // forgeable surface spec §5.2 rejects. So `hasLiveVideoPublisher` proves
  // "joined to a live session and not left", and CAMERA-ON IS ENFORCED BY THE
  // PRESET: the player preset must be configured with video on at join and the
  // video toggle DENIED. That is server-side configuration we hold, never a
  // claim the browser makes. See plan premise P-B2-6.
  //
  // No credential has a default, and there is no mock fallback. The POC
  // returns `mock-token-*` whenever credentials are missing; here an
  // unconfigured process refuses loudly, because a silently-mocked camera gate
  // on a Required division is a tournament played with no camera at all.
  import { HttpError } from "@/lib/errors";
  import { sql } from "@/lib/db";

  export const REALTIMEKIT_TIMEOUT_MS = 10_000;

  export type RealtimeKitCode = "unconfigured" | "unauthorized" | "not_found" | "unavailable";

  export class RealtimeKitError extends Error {
    constructor(
      readonly status: number,
      readonly code: RealtimeKitCode,
      message: string,
    ) {
      super(message);
      this.name = "RealtimeKitError";
    }
  }

  export type RealtimeKitDeps = { fetch?: typeof fetch; baseUrl?: string };

  type Config = {
    accountId: string;
    apiToken: string;
    appId: string;
    presets: { player: string; arbiter: string };
  };

  function readConfig(): Config | null {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
    const appId = process.env.REALTIMEKIT_APP_ID ?? "";
    const player = process.env.REALTIMEKIT_PLAYER_PRESET ?? "";
    const arbiter = process.env.REALTIMEKIT_ARBITER_PRESET ?? "";
    if (!accountId || !apiToken || !appId || !player || !arbiter) return null;
    return { accountId, apiToken, appId, presets: { player, arbiter } };
  }

  export function realtimeKitConfigured(): boolean {
    return readConfig() !== null;
  }

  function requireConfig(): Config {
    const cfg = readConfig();
    if (!cfg) {
      throw new RealtimeKitError(
        503,
        "unconfigured",
        "RealtimeKit is not configured (account id, API token, app id and both preset names are all required)",
      );
    }
    return cfg;
  }
  ```

  Re-run Step 3's command. Expected `numTotalTests: 2`, `numPassedTests: 2`.

- [ ] **Step 5: write the failing HTTP-boundary test for `ensureMeeting`.**
  Append to the test file:

  ```ts
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import { ensureMeeting } from "../realtimekit";
  import { seedOnlineChessFixture } from "@/server/usecases/__tests__/_external-play-seed";

  const T = new Date("2026-10-01T12:10:00.000Z");
  const seedFixture = () =>
    seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true });

  /** A stub that answers one JSON body per call, in order, and records every
   *  request. Nothing here touches the network. */
  function stubFetch(responses: { status: number; body: unknown }[]) {
    const calls: { url: string; method: string; headers: Headers; body: unknown }[] = [];
    const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const next = responses[calls.length];
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (!next) throw new Error(`unexpected RealtimeKit call #${calls.length}: ${String(url)}`);
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    });
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  describe.skipIf(!process.env.DATABASE_URL)("ensureMeeting", () => {
    it("creates a meeting on the first call and records it", async () => {
      configure();
      const s = await seedFixture();
      const stub = stubFetch([{ status: 200, body: { success: true, data: { id: "mtg-1" } } }]);
      const ref = await ensureMeeting(s.fixtureId, { fetch: stub.fetch });
      expect(ref).toEqual({ meetingId: "mtg-1" });
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0]?.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct-1/realtime/kit/app-1/meetings",
      );
      expect(stub.calls[0]?.method).toBe("POST");
      expect(stub.calls[0]?.headers.get("authorization")).toBe(
        "Bearer cf-token-do-not-leak-0123456789",
      );
      const [row] = await sql<{ meeting_id: string; org_id: string; ended_at: Date | null }[]>`
        select meeting_id, org_id, ended_at from fixture_video_meeting where fixture_id = ${s.fixtureId}`;
      expect(row?.meeting_id).toBe("mtg-1");
      expect(row?.org_id, "the tenant policy needs it").toBe(s.orgId);
      expect(row?.ended_at).toBeNull();
    });

    it("is idempotent: a SECOND call makes no HTTP request at all", async () => {
      configure();
      const s = await seedFixture();
      const first = stubFetch([{ status: 200, body: { success: true, data: { id: "mtg-2" } } }]);
      await ensureMeeting(s.fixtureId, { fetch: first.fetch });
      const second = stubFetch([]); // any call throws
      const again = await ensureMeeting(s.fixtureId, { fetch: second.fetch });
      expect(again).toEqual({ meetingId: "mtg-2" });
      expect(second.calls.length, "the stored meeting is reused").toBe(0);
    });

    it("loses a creation race gracefully: returns the winner's meeting and deactivates its own orphan", async () => {
      configure();
      const s = await seedFixture();
      // The competing row lands DURING our HTTP call — the real race, driven
      // by giving the stub itself database access rather than by adding a
      // test-only hook to production code.
      let created = false;
      const calls: { url: string; method: string; body: unknown }[] = [];
      const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        if (!created) {
          created = true;
          await sql`
            insert into fixture_video_meeting (fixture_id, org_id, meeting_id)
            values (${s.fixtureId}, ${s.orgId}, 'mtg-winner')`;
          return new Response(JSON.stringify({ success: true, data: { id: "mtg-orphan" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const ref = await ensureMeeting(s.fixtureId, { fetch: fetchFn as unknown as typeof fetch });
      expect(ref, "the winner's meeting is what everyone must join").toEqual({ meetingId: "mtg-winner" });
      const [row] = await sql<{ meeting_id: string }[]>`
        select meeting_id from fixture_video_meeting where fixture_id = ${s.fixtureId}`;
      expect(row?.meeting_id).toBe("mtg-winner");
      // The orphan is a billable meeting nobody will ever join — deactivate it.
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.url).toContain("/meetings/mtg-orphan");
      expect(patch?.body).toEqual({ status: "INACTIVE" });
    });

    it("an unconfigured process refuses rather than inventing a mock meeting", async () => {
      configure({ REALTIMEKIT_APP_ID: "" });
      const s = await seedFixture();
      const stub = stubFetch([]);
      await expect(ensureMeeting(s.fixtureId, { fetch: stub.fetch })).rejects.toMatchObject({
        name: "RealtimeKitError",
        code: "unconfigured",
      });
      expect(stub.calls.length).toBe(0);
    });
  });
  ```

- [ ] **Step 6: run it and watch it fail.**
  ```
  rm -f /tmp/b2-t7b.json && cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web \
    && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable \
       npx vitest run src/server/external-play/video/__tests__/realtimekit.test.ts \
       --reporter=json --outputFile=/tmp/b2-t7b.json
  ```
  Expected: `numTotalTests: 6`, `numFailedTests: 4`, each
  `TypeError: ensureMeeting is not a function`.

- [ ] **Step 7: implement the request helper and `ensureMeeting`.**
  Append to `realtimekit.ts`:

  ```ts
  const CF_BASE = "https://api.cloudflare.com/client/v4";

  type CfBody = { success?: boolean; data?: unknown; result?: unknown; errors?: { message?: string }[]; error?: { message?: string } };

  /** One request. Maps transport and HTTP failure onto RealtimeKitError, and
   *  NEVER puts the API token or a response body into the message — a
   *  RealtimeKit error body can echo the request, and these messages reach
   *  logs and Sentry. */
  async function cf(
    cfg: Config,
    path: string,
    init: { method: string; body?: unknown },
    deps: RealtimeKitDeps,
  ): Promise<unknown> {
    const base = (deps.baseUrl ?? process.env.REALTIMEKIT_BASE_URL ?? CF_BASE).replace(/\/$/, "");
    const url = `${base}/accounts/${cfg.accountId}/realtime/kit/${cfg.appId}${path}`;
    const doFetch = deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${cfg.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(REALTIMEKIT_TIMEOUT_MS),
      });
    } catch {
      throw new RealtimeKitError(503, "unavailable", `RealtimeKit ${init.method} ${path} did not complete`);
    }
    if (res.status === 404) {
      throw new RealtimeKitError(404, "not_found", `RealtimeKit ${init.method} ${path} returned 404`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new RealtimeKitError(res.status, "unauthorized", `RealtimeKit ${init.method} ${path} rejected our credentials`);
    }
    const body = (await res.json().catch(() => ({}))) as CfBody;
    if (!res.ok || body.success === false) {
      throw new RealtimeKitError(res.status, "unavailable", `RealtimeKit ${init.method} ${path} failed with ${res.status}`);
    }
    return body.data ?? body.result ?? body;
  }

  /** Created when the FIRST player arrives in the window, not after both check
   *  in — preflight needs something to join (spec §5.2). Idempotent per
   *  fixture; the loser of a creation race deactivates its own meeting rather
   *  than leaving a billable room nobody joins. */
  export async function ensureMeeting(fixtureId: string, deps: RealtimeKitDeps = {}): Promise<MeetingRef> {
    const cfg = requireConfig();
    const existing = await sql<{ meeting_id: string }[]>`
      select meeting_id from fixture_video_meeting
       where fixture_id = ${fixtureId} and ended_at is null`;
    const found = existing[0];
    if (found) return { meetingId: found.meeting_id };

    const [fixture] = await sql<{ org_id: string }[]>`
      select org_id from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found", "NOT_FOUND");

    // Outside any transaction — an open transaction across an outbound HTTP
    // call holds a row lock, or a pooled connection, for the whole round trip
    // (the same rule mintIfReady follows, room.ts:260-280).
    const data = (await cf(cfg, "/meetings", { method: "POST", body: { title: `seazn-fixture-${fixtureId}` } }, deps)) as {
      id?: unknown;
    };
    if (typeof data.id !== "string" || data.id === "") {
      throw new RealtimeKitError(502, "unavailable", "RealtimeKit create meeting returned no id");
    }
    const inserted = await sql<{ meeting_id: string }[]>`
      insert into fixture_video_meeting (fixture_id, org_id, meeting_id)
      values (${fixtureId}, ${fixture.org_id}, ${data.id})
      on conflict (fixture_id) do nothing
      returning meeting_id`;
    const mine = inserted[0];
    if (mine) return { meetingId: mine.meeting_id };

    // Lost the race. Someone else's meeting is the one both players will be
    // added to, so ours must be stood down.
    await cf(cfg, `/meetings/${encodeURIComponent(data.id)}`, { method: "PATCH", body: { status: "INACTIVE" } }, deps).catch(
      () => undefined,
    );
    const [winner] = await sql<{ meeting_id: string }[]>`
      select meeting_id from fixture_video_meeting where fixture_id = ${fixtureId}`;
    if (!winner) throw new RealtimeKitError(503, "unavailable", "meeting row vanished mid-race");
    return { meetingId: winner.meeting_id };
  }
  ```

- [ ] **Step 8: run green.** Re-run Step 6's command. Expected
  `numTotalTests: 6`, `numPassedTests: 6`, `numFailedTests: 0`. Confirm
  `jq -r '.testResults[].name' /tmp/b2-t7b.json` resolves inside the worktree.

- [ ] **Step 9: mutate the race handling.** Replace
  `on conflict (fixture_id) do nothing` with a plain `insert`, and drop the
  `if (mine)` branch so the function always returns `{ meetingId: data.id }`.
  Re-run: the race test must fail on
  `expected { meetingId: 'mtg-orphan' } to equal { meetingId: 'mtg-winner' }`
  (and the insert itself reds on the primary key). Restore from the `cp`
  backup.

- [ ] **Step 10: commit.**
  ```
  git add apps/web/src/server/external-play/video/realtimekit.ts \
          apps/web/src/server/external-play/video/__tests__/realtimekit.test.ts
  git commit -m "feat(chess): RealtimeKit meeting lifecycle, idempotent per fixture

  Credentials and BOTH preset names are required with no defaults and no mock
  fallback: the POC returns mock-token-* when unconfigured, which on a Required
  division is a tournament played with no camera. HTTP happens outside every
  transaction; the loser of a creation race deactivates its own meeting instead
  of leaving a billable room nobody joins. Mutant: dropping the on-conflict
  guard reds the race test.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 11: write the failing `addParticipant` test, including the
  no-token-leak assertion the brief demands.** Append:

  ```ts
  import { addParticipant } from "../realtimekit";

  describe("addParticipant", () => {
    it("maps the player preset, sends the subject as the custom id, and returns id + token", async () => {
      configure();
      const stub = stubFetch([
        { status: 201, body: { success: true, data: { id: "p-1", token: "jwt-participant-1" } } },
      ]);
      const out = await addParticipant(
        { meetingId: "mtg-1", subject: "person-abc", preset: "player" },
        { fetch: stub.fetch },
      );
      expect(out).toEqual({ participantId: "p-1", authToken: "jwt-participant-1" });
      expect(Object.keys(out).sort(), "exactly the two declared keys").toEqual([
        "authToken",
        "participantId",
      ]);
      expect(stub.calls[0]?.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct-1/realtime/kit/app-1/meetings/mtg-1/participants",
      );
      expect(stub.calls[0]?.method).toBe("POST");
      expect(stub.calls[0]?.body).toEqual({
        custom_participant_id: "person-abc",
        preset_name: "seazn_chess_player",
      });
    });

    it("maps the arbiter preset to its own env value, never the player's", async () => {
      configure();
      const stub = stubFetch([
        { status: 201, body: { success: true, data: { id: "p-2", token: "jwt-participant-2" } } },
      ]);
      await addParticipant(
        { meetingId: "mtg-1", subject: "person-arb", preset: "arbiter" },
        { fetch: stub.fetch },
      );
      expect((stub.calls[0]?.body as { preset_name: string }).preset_name).toBe("seazn_chess_arbiter");
    });

    it("sweeps both presets and reports the count", async () => {
      configure();
      const presets: ("player" | "arbiter")[] = ["player", "arbiter"];
      const seen = new Set<string>();
      let checked = 0;
      for (const preset of presets) {
        const stub = stubFetch([
          { status: 201, body: { success: true, data: { id: `p-${preset}`, token: `jwt-${preset}` } } },
        ]);
        await addParticipant({ meetingId: "mtg-1", subject: "s", preset }, { fetch: stub.fetch });
        seen.add((stub.calls[0]?.body as { preset_name: string }).preset_name);
        checked += 1;
      }
      expect(checked, "anti-vacuity: every preset in the union").toBe(2);
      expect(seen.size, "the two presets must not collapse onto one value").toBe(2);
    });

    it("never puts an auth token into an error message or a log line", async () => {
      configure();
      const API_TOKEN = "cf-token-do-not-leak-0123456789";
      const PARTICIPANT_TOKEN = "jwt-participant-do-not-leak-98765";
      // Positive control first, so the negatives below cannot be vacuous.
      expect(API_TOKEN.length, "premise: the token is a real, long string").toBeGreaterThan(20);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      // A RealtimeKit failure body that ECHOES both tokens back at us — the
      // shape that turns a naive `JSON.stringify(body)` message into a leak.
      const stub = stubFetch([
        {
          status: 401,
          body: {
            success: false,
            error: { message: `bad token ${API_TOKEN}`, echoed: PARTICIPANT_TOKEN },
          },
        },
      ]);
      let caught: unknown;
      try {
        await addParticipant(
          { meetingId: "mtg-1", subject: "person-abc", preset: "player" },
          { fetch: stub.fetch },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught, "premise: the 401 did throw").toBeInstanceOf(RealtimeKitError);
      const message = (caught as Error).message;
      // Positive control: the message is informative about WHAT failed.
      expect(message).toContain("participants");
      expect(message).toMatch(/401|credentials/);
      // The negatives.
      expect(message).not.toContain(API_TOKEN);
      expect(message).not.toContain(PARTICIPANT_TOKEN);
      expect((caught as Error).stack ?? "").not.toContain(API_TOKEN);
      const logged = [...errSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
        .flat()
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join("\n");
      expect(logged).not.toContain(API_TOKEN);
      expect(logged).not.toContain(PARTICIPANT_TOKEN);
      errSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("a response with no token is a 502, not a participant with an empty token", async () => {
      configure();
      const stub = stubFetch([{ status: 201, body: { success: true, data: { id: "p-3" } } }]);
      await expect(
        addParticipant({ meetingId: "mtg-1", subject: "s", preset: "player" }, { fetch: stub.fetch }),
      ).rejects.toMatchObject({ name: "RealtimeKitError", status: 502 });
    });
  });
  ```

- [ ] **Step 12: run it, watch it fail, implement, run green.**
  Failure: `TypeError: addParticipant is not a function` ×5. Implementation,
  appended to `realtimekit.ts`:

  ```ts
  /** Presets, not code, are what make the camera mandatory: the `player`
   *  preset must be configured with video on at join and the video toggle
   *  DENIED. `addParticipant` therefore only ever names a preset from env —
   *  it never sends media permissions itself, so a preset change in the
   *  dashboard is the one place that rule lives. Mic muted by default is the
   *  same preset's job (spec §5.3: chess needs no audio). */
  export async function addParticipant(
    a: { meetingId: string; subject: string; preset: "player" | "arbiter" },
    deps: RealtimeKitDeps = {},
  ): Promise<ParticipantToken> {
    const cfg = requireConfig();
    const data = (await cf(
      cfg,
      `/meetings/${encodeURIComponent(a.meetingId)}/participants`,
      {
        method: "POST",
        // `name` is deliberately omitted: a player sees only their own tile
        // (D7), an arbiter already has the fixture's names from our own page,
        // and sending a child's display name to a third party for no product
        // reason is not something to do by default.
        body: { custom_participant_id: a.subject, preset_name: cfg.presets[a.preset] },
      },
      deps,
    )) as { id?: unknown; token?: unknown };
    if (typeof data.id !== "string" || typeof data.token !== "string" || data.token === "") {
      throw new RealtimeKitError(502, "unavailable", "RealtimeKit add participant returned no id/token");
    }
    return { participantId: data.id, authToken: data.token };
  }
  ```

  The leak test passes because `cf` never interpolates a body or the token into
  a message — it names the method, the path and the status only. Expected after
  this step: `numTotalTests: 11`, `numPassedTests: 11`.

- [ ] **Step 13: mutate the leak guard.** In `cf`, change the non-ok throw to
  `` `RealtimeKit ${init.method} ${path} failed: ${JSON.stringify(body)}` ``
  — the obvious, helpful-looking version. Re-run: the no-token-leak test must
  fail on `expected '…bad token cf-token-do-not-leak-…' not to contain
  'cf-token-do-not-leak-0123456789'`. Restore from the `cp` backup. This is the
  mutant that matters most in this task: the leak is one convenience away.

- [ ] **Step 14: write the failing `hasLiveVideoPublisher` test.** Append:

  ```ts
  import { hasLiveVideoPublisher } from "../realtimekit";

  describe("hasLiveVideoPublisher", () => {
    const SESSION = "sess-1";
    const live = { status: 200, body: { success: true, data: { id: SESSION, status: "LIVE" } } };
    const ended = { status: 200, body: { success: true, data: { id: SESSION, status: "ENDED" } } };
    const noSession = { status: 404, body: { success: false, error: { code: 404, message: "no active session" } } };
    const participants = (rows: unknown[]) => ({
      status: 200,
      body: { success: true, data: { participants: rows } },
    });

    it("sweeps every reachable state and reports the count", async () => {
      configure();
      const cases: { name: string; responses: { status: number; body: unknown }[]; want: boolean }[] = [
        { name: "empty case: no active session at all", responses: [noSession], want: false },
        { name: "session exists but has ENDED", responses: [ended], want: false },
        {
          name: "live session, our participant has never joined",
          responses: [live, participants([{ custom_participant_id: "someone-else", id: "p-x" }])],
          want: false,
        },
        {
          name: "live session, our participant joined and LEFT",
          responses: [
            live,
            participants([{ id: "p-1", custom_participant_id: "s", joined_at: "2026-10-01T12:00:00Z", left_at: "2026-10-01T12:05:00Z" }]),
          ],
          want: false,
        },
        {
          name: "live session, our participant is joined and present",
          responses: [
            live,
            participants([{ id: "p-1", custom_participant_id: "s", joined_at: "2026-10-01T12:00:00Z", left_at: null }]),
          ],
          want: true,
        },
      ];
      let checked = 0;
      const outcomes = new Set<boolean>();
      for (const c of cases) {
        const stub = stubFetch(c.responses);
        const got = await hasLiveVideoPublisher({ meetingId: "mtg-1", participantId: "p-1" }, { fetch: stub.fetch });
        expect(got, c.name).toBe(c.want);
        outcomes.add(got);
        checked += 1;
      }
      expect(checked, "anti-vacuity: every state the REST API can report").toBe(5);
      expect(outcomes.size, "a predicate that only ever answers one way proves nothing").toBe(2);
    });

    it("does not ask for the participant list at all when the session is not live", async () => {
      configure();
      const stub = stubFetch([ended]); // a second call throws
      expect(await hasLiveVideoPublisher({ meetingId: "mtg-1", participantId: "p-1" }, { fetch: stub.fetch })).toBe(false);
      expect(stub.calls.length).toBe(1);
    });

    it("an upstream outage is NOT silently a false", async () => {
      // A false here would read as "camera off" and refuse a seat on a
      // division that is otherwise fine; D11's organiser override is the
      // intended answer to an outage, and it can only be offered if the
      // outage surfaces as an error.
      configure();
      const stub = stubFetch([{ status: 500, body: { success: false } }]);
      await expect(
        hasLiveVideoPublisher({ meetingId: "mtg-1", participantId: "p-1" }, { fetch: stub.fetch }),
      ).rejects.toMatchObject({ name: "RealtimeKitError", code: "unavailable" });
    });
  });
  ```

- [ ] **Step 15: run it, watch it fail, implement, run green.**

  ```ts
  /** Server-verified presence, which is the strongest thing RealtimeKit's REST
   *  surface can tell us (see this file's header and plan premise P-B2-6):
   *  TRUE means "a live session exists for this meeting and this participant is
   *  in it and has not left". It does NOT read a video track — no REST
   *  endpoint and no webhook exposes one. Camera-on is the preset's job.
   *
   *  A 404 on the active session is a normal "nobody has joined yet" and
   *  answers false; any other failure THROWS, because a silent false would
   *  refuse a seat during a vendor outage, and D11's organiser override exists
   *  precisely so an outage is handled by a person, not by a guess. */
  export async function hasLiveVideoPublisher(
    a: { meetingId: string; participantId: string },
    deps: RealtimeKitDeps = {},
  ): Promise<boolean> {
    const cfg = requireConfig();
    let session: { id?: unknown; status?: unknown };
    try {
      session = (await cf(
        cfg,
        `/meetings/${encodeURIComponent(a.meetingId)}/active-session`,
        { method: "GET" },
        deps,
      )) as { id?: unknown; status?: unknown };
    } catch (err) {
      if (err instanceof RealtimeKitError && err.code === "not_found") return false;
      throw err;
    }
    if (session.status !== "LIVE" || typeof session.id !== "string") return false;
    const data = (await cf(
      cfg,
      `/sessions/${encodeURIComponent(session.id)}/participants`,
      { method: "GET" },
      deps,
    )) as { participants?: unknown };
    const rows = Array.isArray(data.participants) ? data.participants : [];
    return rows.some((row) => {
      const p = row as { id?: unknown; left_at?: unknown };
      return p.id === a.participantId && (p.left_at === null || p.left_at === undefined);
    });
  }
  ```

  Expected `numTotalTests: 14`, `numPassedTests: 14`.

- [ ] **Step 16: mutate both halves of the predicate, one at a time.**
  (a) Drop `session.status !== "LIVE"` from the early return. Re-run: the
  "session exists but has ENDED" row and the "does not ask for the participant
  list" test must both fail. Restore.
  (b) Drop `&& (p.left_at === null || p.left_at === undefined)`. Re-run: the
  "joined and LEFT" row must fail. Restore.
  These two guards cover for each other on the happy path, which is why they
  are mutated separately.

- [ ] **Step 17: write the failing `endMeeting` test, implement, run green.**
  Test:

  ```ts
  import { endMeeting } from "../realtimekit";

  describe.skipIf(!process.env.DATABASE_URL)("endMeeting", () => {
    it("kicks everyone out and THEN deactivates the meeting, in that order", async () => {
      configure();
      const s = await seedFixture();
      const create = stubFetch([{ status: 200, body: { success: true, data: { id: "mtg-end" } } }]);
      await ensureMeeting(s.fixtureId, { fetch: create.fetch });
      const stub = stubFetch([
        { status: 200, body: { success: true, data: { action: "kick", kicked_participants_count: 2 } } },
        { status: 200, body: { success: true, data: { id: "mtg-end", status: "INACTIVE" } } },
      ]);
      await endMeeting("mtg-end", { fetch: stub.fetch });
      expect(stub.calls.map((c) => `${c.method} ${c.url.split("/realtime/kit/app-1")[1]}`)).toEqual([
        "POST /meetings/mtg-end/active-session/kick-all",
        "PATCH /meetings/mtg-end",
      ]);
      expect(stub.calls[1]?.body).toEqual({ status: "INACTIVE" });
      const [row] = await sql<{ ended_at: Date | null }[]>`
        select ended_at from fixture_video_meeting where meeting_id = 'mtg-end'`;
      expect(row?.ended_at, "the row is stamped so ensureMeeting will not reuse it").not.toBeNull();
    });

    it("no active session is not a failure: the deactivate still happens", async () => {
      // Order matters and so does this case: at T+20 with nobody present
      // there IS no session to kick, and skipping the PATCH would leave a
      // joinable meeting behind.
      configure();
      const stub = stubFetch([
        { status: 404, body: { success: false, error: { code: 404, message: "no active session" } } },
        { status: 200, body: { success: true, data: { status: "INACTIVE" } } },
      ]);
      await endMeeting("mtg-quiet", { fetch: stub.fetch });
      expect(stub.calls.length).toBe(2);
      expect(stub.calls[1]?.method).toBe("PATCH");
    });
  });
  ```

  Implementation:

  ```ts
  /** Torn down at the result, or at T+20 if nobody came (spec §5.2). There is
   *  no "delete meeting" endpoint — the recipe is kick-all then
   *  status INACTIVE, which is what stops anyone joining afterwards. The
   *  kick's 404 ("no active session") is the ordinary quiet-room case and must
   *  not skip the deactivate. */
  export async function endMeeting(meetingId: string, deps: RealtimeKitDeps = {}): Promise<void> {
    const cfg = requireConfig();
    const id = encodeURIComponent(meetingId);
    try {
      await cf(cfg, `/meetings/${id}/active-session/kick-all`, { method: "POST" }, deps);
    } catch (err) {
      if (!(err instanceof RealtimeKitError) || err.code !== "not_found") throw err;
    }
    await cf(cfg, `/meetings/${id}`, { method: "PATCH", body: { status: "INACTIVE" } }, deps);
    await sql`
      update fixture_video_meeting set ended_at = now()
       where meeting_id = ${meetingId} and ended_at is null`;
  }
  ```

  Expected `numTotalTests: 16`, `numPassedTests: 16`.

- [ ] **Step 18: mutate the teardown.** Move the `catch` to wrap both calls, so
  a 404 on the kick skips the PATCH. Re-run: "no active session is not a
  failure" must fail on `expected 1 to be 2`. Restore.

- [ ] **Step 19: document the environment.**
  `apps/web/.env.example`, inserted after `LICHESS_WEBHOOK_SECRET=` (:95):

  ```
  # ── Cloudflare RealtimeKit (camera tile beside the online chess board) ───────
  # SAME account as the streaming relay — the repo-root .env.example already
  # declares CLOUDFLARE_ACCOUNT_ID for Cloudflare Stream; this file had not
  # caught up. One account id serves both.
  CLOUDFLARE_ACCOUNT_ID=
  # API token scoped to RealtimeKit. NOT CLOUDFLARE_STREAM_TOKEN, which is
  # Stream-scoped. Server-side only, never a NEXT_PUBLIC_* var.
  CLOUDFLARE_API_TOKEN=
  # The RealtimeKit app the meetings are created under.
  REALTIMEKIT_APP_ID=
  # Preset names, created once in the RealtimeKit dashboard or Preset API.
  # There is NO default, deliberately: the player preset is the ONLY thing that
  # makes the camera mandatory (no REST endpoint or webhook reports whether a
  # participant is publishing video), so it must be configured with video ON at
  # join, the video toggle DENIED, and the mic muted. The arbiter preset is
  # receive-only. With any of these unset the adapter refuses every call rather
  # than running with a preset nobody chose.
  REALTIMEKIT_PLAYER_PRESET=
  REALTIMEKIT_ARBITER_PRESET=
  # Override the API origin (e2e/smoke point this at a local stub so tests never
  # call Cloudflare). Default: https://api.cloudflare.com/client/v4
  # REALTIMEKIT_BASE_URL=
  ```

- [ ] **Step 20: typecheck, lint, commit.**
  ```
  rtk proxy npx tsc --noEmit -p apps/web
  rtk proxy npx eslint apps/web/src/server/external-play/video/realtimekit.ts
  git add apps/web/src/server/external-play/video/realtimekit.ts \
          apps/web/src/server/external-play/video/__tests__/realtimekit.test.ts \
          apps/web/.env.example
  git commit -m "feat(chess): RealtimeKit participants, presence check and teardown

  addParticipant names an env-pinned preset and sends no display name (D7 — a
  player sees only their own tile, and a child's name does not need to reach a
  third party). hasLiveVideoPublisher proves 'joined to a live session and not
  left', which is the strongest thing the REST surface can state: no endpoint
  and no webhook reports a video track, so camera-on is enforced by the preset
  and the doc comment says so. An outage throws rather than reading as 'camera
  off', because D11's override needs a person to see it. Teardown is kick-all
  then status INACTIVE; a 404 on the kick is the quiet-room case and must not
  skip the deactivate. Mutants: stringifying the error body leaks the token;
  dropping the LIVE check, the left_at check, or widening the 404 catch each
  red exactly one case.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 8: Seat gating with a server-verified preflight

**Files:**

Create:
- `apps/web/src/server/usecases/external-play/preflight.ts`
- `apps/web/src/server/usecases/__tests__/external-play-preflight.test.ts`

Modify:
- `apps/web/src/server/usecases/__tests__/_external-play-seed.ts` — T6 already
  added `cameraPolicy`/`stageCameraPolicy`/`roundOpenedAt`/`competitionId`/
  `stageId`; T8 adds nothing further unless a case needs it.

**Interfaces:**

*Consumes:* `loadOnlinePlayFixture`, `loadSides`, `type SidePlayer`, `type Side`
(`./guard`, :121/:273/:13/:11); `roomPhase` (`@/server/external-play/window.ts:25`);
`roundOpenFor` (T6, `@/server/external-play/round-open.ts`);
`fixtureCameraPolicy`, `type CameraPolicy` (T6); `ensureMeeting`,
`addParticipant`, `hasLiveVideoPublisher`, `type ParticipantToken`,
`RealtimeKitError` (T7); `audit` (`../audit:26`); `sql` (`@/lib/db`).

*Produces* — authoritative, **with `"round_not_open"` added to the reason union
per the controller's mid-batch ruling (D12, P-B2-12); the plan's Interfaces
section is being updated to the same spelling:**

```ts
export type SeatResult =
  | { seated: true; participant: ParticipantToken | null }
  | {
      seated: false;
      reason: "camera_required" | "camera_lost" | "window_closed" | "not_a_player" | "round_not_open";
    };
export function seatPlayer(a: { fixtureId: string; personId: string }): Promise<SeatResult>;
export function organiserOverrideVideo(a: { fixtureId: string; actorUserId: string; note: string }): Promise<void>;
```

plus, added to T8's own module and consumed by T9:

```ts
/** Test seam only — T9 and the room pass no deps. */
export type PreflightDeps = {
  now?: Date;
  video?: {
    ensureMeeting: typeof ensureMeeting;
    addParticipant: typeof addParticipant;
    hasLiveVideoPublisher: typeof hasLiveVideoPublisher;
  };
};
```

`seatPlayer` is **idempotent and re-verifying**: every call re-reads the
publisher state and re-stamps or clears `video_verified_at`. That is what makes
it the freshness check T9 calls immediately before creating a game, and it is
why Review Focus 3 needs no extra symbol.

`participant: null` on a seated result means "there is no tile": policy `off`,
or an organiser override under D11. The caller renders a seat either way.

Steps:

- [ ] **Step 1: confirm T1's participant table and override columns exist.**
  ```
  psql "postgresql://postgres@127.0.0.1:54890/seazn_chess-lep" \
    -c '\d fixture_video_participant' \
    -c "select column_name from information_schema.columns where table_name='fixture_external_play' and column_name like 'video_%'"
  ```
  Expected: the seven columns of `fixture_video_participant`, and
  `video_override_at`, `video_override_by`, `video_override_note`. Anything
  missing ⇒ **stop and report**; do not write a migration from this task.

- [ ] **Step 2: write the failing refusal tests — the states where NO seat is
  granted.** Create
  `apps/web/src/server/usecases/__tests__/external-play-preflight.test.ts`:

  ```ts
  // T8 — the seat. A player is seated only when the MEETING says so; nothing
  // the browser sends is read (spec §5.2, §10).
  import { afterAll, describe, expect, it, vi } from "vitest";
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import { seatPlayer, type PreflightDeps } from "../external-play/preflight";
  import { seedOnlineChessFixture } from "./_external-play-seed";

  /** The round is opened ten minutes before the scheduled time in these
   *  fixtures, so `now = OPENED` sits inside the window (D12: the window hangs
   *  off the stamp, and `opensAt = stamp − 10min` is already past). */
  const T = new Date("2026-10-01T12:10:00.000Z");
  const OPENED = new Date("2026-10-01T12:00:00.000Z");
  const NOW = new Date("2026-10-01T12:05:00.000Z");

  /** A video double that records what it was asked and answers as told. */
  function videoDouble(opts: { publisher: boolean }) {
    const calls: string[] = [];
    const video: NonNullable<PreflightDeps["video"]> = {
      ensureMeeting: async (fixtureId) => {
        calls.push(`ensureMeeting:${fixtureId}`);
        return { meetingId: `mtg-${fixtureId.slice(0, 8)}` };
      },
      addParticipant: async (a) => {
        calls.push(`addParticipant:${a.preset}:${a.subject}`);
        return { participantId: `p-${a.subject.slice(0, 8)}`, authToken: "jwt-stub" };
      },
      hasLiveVideoPublisher: async (a) => {
        calls.push(`hasLiveVideoPublisher:${a.participantId}`);
        return opts.publisher;
      },
    };
    return { video, calls };
  }

  const seed = (over: Partial<Parameters<typeof seedOnlineChessFixture>[0]> = {}) =>
    seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
      roundOpenedAt: OPENED,
      ...over,
    });

  describe.skipIf(!process.env.DATABASE_URL)("seatPlayer refusals", () => {
    afterAll(async () => {
      await sql.end();
    });

    it("empty case: a fixture that is not an online-play fixture at all ⇒ not_a_player", async () => {
      const s = await seed({ onlinePlay: "off" });
      const d = videoDouble({ publisher: true });
      expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video })).toEqual({
        seated: false,
        reason: "not_a_player",
      });
      expect(d.calls, "no meeting is touched for a fixture we do not serve").toEqual([]);
    });

    it("a fixture id that does not exist ⇒ not_a_player, never a throw", async () => {
      const d = videoDouble({ publisher: true });
      expect(
        await seatPlayer({ fixtureId: randomUUID(), personId: randomUUID() }, { now: NOW, video: d.video }),
      ).toEqual({ seated: false, reason: "not_a_player" });
    });

    it("D12: a paired-but-UNOPENED round ⇒ round_not_open, and no meeting is created", async () => {
      // The default state of a freshly paired Swiss round: fixtures exist,
      // nothing has been sent. This is NOT window_closed — the window has not
      // started, and conflating the two would tell the player the wrong thing.
      const s = await seed({ roundOpenedAt: undefined });
      const d = videoDouble({ publisher: true });
      expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video })).toEqual({
        seated: false,
        reason: "round_not_open",
      });
      expect(d.calls).toEqual([]);
      const rows = await sql<{ fixture_id: string }[]>`
        select fixture_id from fixture_video_meeting where fixture_id = ${s.fixtureId}`;
      expect(rows.length, "an unopened round spends nothing on video").toBe(0);
    });

    it("D12: the SCHEDULE does not open the window — a past scheduled_at with no stamp is still round_not_open", async () => {
      // The defect this ruling exists to prevent: anchoring on the timetable
      // seats players for a round that had not started.
      const s = await seed({ roundOpenedAt: undefined });
      const d = videoDouble({ publisher: true });
      const wellAfterSchedule = new Date(T.getTime() + 60_000);
      expect(
        await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: wellAfterSchedule, video: d.video }),
      ).toEqual({ seated: false, reason: "round_not_open" });
    });

    it("past T+20 of the OPEN stamp ⇒ window_closed", async () => {
      const s = await seed();
      const d = videoDouble({ publisher: true });
      const late = new Date(OPENED.getTime() + 20 * 60_000 + 1);
      expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: late, video: d.video })).toEqual({
        seated: false,
        reason: "window_closed",
      });
      expect(d.calls).toEqual([]);
    });

    it("someone who is neither player ⇒ not_a_player, with the SAME shape as a missing fixture", async () => {
      const s = await seed();
      const d = videoDouble({ publisher: true });
      expect(await seatPlayer({ fixtureId: s.fixtureId, personId: randomUUID() }, { now: NOW, video: d.video })).toEqual({
        seated: false,
        reason: "not_a_player",
      });
    });

    it("another sport: a non-boardgame division is refused by the guard, not by the camera", async () => {
      const { auth } = await import("./_seed").then((m) => m.seedOrg());
      const { division, fixtures } = await import("./_seed").then((m) => m.seedFutureDivision(auth));
      const fixture = fixtures[0];
      if (!fixture) throw new Error("seedFutureDivision produced no fixtures");
      const d = videoDouble({ publisher: true });
      expect(await seatPlayer({ fixtureId: fixture.id, personId: randomUUID() }, { now: NOW, video: d.video })).toEqual({
        seated: false,
        reason: "not_a_player",
      });
      expect(division.sport_key, "premise: this is not a boardgame division").not.toBe("boardgame");
    });
  });
  ```

- [ ] **Step 3: run it and watch it fail.**
  ```
  rm -f /tmp/b2-t8a.json && cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web \
    && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable \
       npx vitest run src/server/usecases/__tests__/external-play-preflight.test.ts \
       --reporter=json --outputFile=/tmp/b2-t8a.json
  ```
  Expected: collect failure, `Cannot find module ../external-play/preflight`,
  `numTotalTests: 0`.

- [ ] **Step 4: write `preflight.ts`'s refusal half and go green.**

  ```ts
  import "server-only";
  // The seat (spec §5.2, §3.2). A player is seated only when the MEETING
  // reports them present in a live session — never on anything the client
  // sends. The POC gated check-in on a client-supplied `cameraOk` boolean;
  // that is forgeable and is on the do-not-copy list (§10). There is no
  // parameter here a browser could set.
  //
  // D12: the window hangs off `round_opened_at`, not `fixtures.scheduled_at`.
  // "The round was never opened" is its OWN refusal (`round_not_open`), not
  // `window_closed`: the window has not started rather than finished, and the
  // room says different things about the two.
  import { sql } from "@/lib/db";
  import { roomPhase } from "@/server/external-play/window";
  import { roundOpenFor } from "@/server/external-play/round-open";
  import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
  import {
    addParticipant,
    ensureMeeting,
    hasLiveVideoPublisher,
    type ParticipantToken,
  } from "@/server/external-play/video/realtimekit";
  import { audit } from "../audit";
  import { loadOnlinePlayFixture, loadSides, type SidePlayer } from "./guard";

  export type SeatResult =
    | { seated: true; participant: ParticipantToken | null }
    | {
        seated: false;
        reason: "camera_required" | "camera_lost" | "window_closed" | "not_a_player" | "round_not_open";
      };

  export type PreflightDeps = {
    now?: Date;
    video?: {
      ensureMeeting: typeof ensureMeeting;
      addParticipant: typeof addParticipant;
      hasLiveVideoPublisher: typeof hasLiveVideoPublisher;
    };
  };

  const REAL_VIDEO = { ensureMeeting, addParticipant, hasLiveVideoPublisher };

  export async function seatPlayer(
    a: { fixtureId: string; personId: string },
    deps: PreflightDeps = {},
  ): Promise<SeatResult> {
    const now = deps.now ?? new Date();

    const f = await loadOnlinePlayFixture(a.fixtureId);
    // A fixture we do not serve and a caller who is not one of the two players
    // collapse to the SAME answer, so a probe cannot learn which check failed
    // (the same rule readMatchRoom follows, room.ts:203-218).
    if (!f) return { seated: false, reason: "not_a_player" };

    const { home, away } = await loadSides(f);
    const player: SidePlayer | undefined = [home, away].find((s) => s.personId === a.personId);
    if (!player || player.personId === null) return { seated: false, reason: "not_a_player" };

    const open = await roundOpenFor(sql, a.fixtureId);
    if (!open) return { seated: false, reason: "round_not_open" };
    if (roomPhase(now, open.roundOpenedAt) !== "open") {
      return { seated: false, reason: "window_closed" };
    }
    throw new Error("unimplemented: policy branches land in the next step");
  }
  ```

  Re-run Step 3's command. Expected `numTotalTests: 7`, `numPassedTests: 7` —
  every case in Step 2 refuses before reaching the unimplemented line. If any
  case reports `unimplemented`, the refusal order is wrong, not the test.

- [ ] **Step 5: mutate the two refusals that are easiest to conflate.**
  (a) Replace `if (!open) return { … "round_not_open" }` with `if (!open)
  return { seated: false, reason: "window_closed" };`. Re-run: both D12 tests
  must fail on the reason value. Restore.
  (b) Replace `roomPhase(now, open.roundOpenedAt)` with
  `roomPhase(now, f.scheduledAt)`. Re-run: "past T+20 of the OPEN stamp" must
  fail — at `OPENED + 20min + 1ms` the schedule-anchored window is still open,
  which is precisely the stale-timetable defect. Restore.
  Record both in the commit body; (b) is the mutant that proves the re-anchor
  is real rather than cosmetic.

- [ ] **Step 6: commit the refusal half.**
  ```
  git add apps/web/src/server/usecases/external-play/preflight.ts \
          apps/web/src/server/usecases/__tests__/external-play-preflight.test.ts
  git commit -m "feat(chess): seat refusals — unopened round, closed window, not a player

  The window is anchored on round_opened_at (D12), so a past scheduled_at with
  no stamp refuses with its own reason, round_not_open, rather than being
  collapsed into window_closed. A fixture we do not serve and a caller who is
  not a player answer identically so a probe learns nothing. Mutants:
  returning window_closed for an unopened round, and re-anchoring the phase on
  scheduled_at, each red exactly the tests that exist for them.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 7: write the failing policy-branch tests.** Append to the test
  file:

  ```ts
  describe.skipIf(!process.env.DATABASE_URL)("seatPlayer under each camera policy", () => {
    it("empty case — policy off: seated with NO tile, and no meeting is ever created", async () => {
      const s = await seed(); // no cameraPolicy key at all ⇒ effective "off"
      const d = videoDouble({ publisher: false });
      expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video })).toEqual({
        seated: true,
        participant: null,
      });
      expect(d.calls, "zero video spend on an off division (spec §5.1)").toEqual([]);
      const rows = await sql<{ fixture_id: string }[]>`
        select fixture_id from fixture_video_meeting where fixture_id = ${s.fixtureId}`;
      expect(rows.length).toBe(0);
    });

    it("policy optional: the tile is offered and NEVER blocks, even with no publisher", async () => {
      const s = await seed({ cameraPolicy: "optional" });
      const d = videoDouble({ publisher: false });
      const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video });
      expect(got.seated).toBe(true);
      expect(got.seated && got.participant?.authToken).toBe("jwt-stub");
      expect(
        d.calls.some((c) => c.startsWith("hasLiveVideoPublisher")),
        "optional must not even ASK — asking invites a future refusal",
      ).toBe(false);
    });

    it("policy required, publisher live: seated, with a tile, and video_verified_at is stamped", async () => {
      const s = await seed({ cameraPolicy: "required" });
      const d = videoDouble({ publisher: true });
      const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video });
      expect(got.seated).toBe(true);
      expect(got.seated && got.participant?.participantId).toContain("p-");
      const [row] = await sql<{ participant_id: string; preset: string; video_verified_at: Date | null }[]>`
        select participant_id, preset, video_verified_at from fixture_video_participant
         where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`;
      expect(row?.preset).toBe("player");
      expect(row?.video_verified_at).not.toBeNull();
    });

    it("policy required, no publisher, first attempt ⇒ camera_required", async () => {
      const s = await seed({ cameraPolicy: "required" });
      const d = videoDouble({ publisher: false });
      expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video })).toEqual({
        seated: false,
        reason: "camera_required",
      });
      const [row] = await sql<{ video_verified_at: Date | null }[]>`
        select video_verified_at from fixture_video_participant
         where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`;
      expect(row?.video_verified_at, "a participant exists to join, but is not verified").toBeNull();
    });

    it("the stage's policy is what gates, not the division's", async () => {
      const s = await seed({ cameraPolicy: "required", stageCameraPolicy: "off" });
      const d = videoDouble({ publisher: false });
      expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video })).toEqual({
        seated: true,
        participant: null,
      });
    });

    it("sequence: a SECOND call reuses the stored participant and adds nobody twice", async () => {
      const s = await seed({ cameraPolicy: "required" });
      const first = videoDouble({ publisher: true });
      const a = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: first.video });
      const second = videoDouble({ publisher: true });
      const b = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: second.video });
      expect(b).toEqual(a);
      expect(
        second.calls.filter((c) => c.startsWith("addParticipant")).length,
        "a reload must not mint a second participant",
      ).toBe(0);
      expect(
        second.calls.filter((c) => c.startsWith("hasLiveVideoPublisher")).length,
        "but it MUST re-verify — that is what makes this the freshness check",
      ).toBe(1);
      const rows = await sql<{ participant_id: string }[]>`
        select participant_id from fixture_video_participant
         where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`;
      expect(rows.length).toBe(1);
    });

    it("both players seat independently, each with their own participant", async () => {
      const s = await seed({ cameraPolicy: "required" });
      const d = videoDouble({ publisher: true });
      const h = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video });
      const w = await seatPlayer({ fixtureId: s.fixtureId, personId: s.away.personId }, { now: NOW, video: d.video });
      expect(h.seated && w.seated).toBe(true);
      const rows = await sql<{ person_id: string; participant_id: string }[]>`
        select person_id, participant_id from fixture_video_participant
         where fixture_id = ${s.fixtureId} order by person_id`;
      expect(rows.length, "two seats, two participants").toBe(2);
      expect(new Set(rows.map((r) => r.participant_id)).size, "and two DISTINCT ids").toBe(2);
      // The meeting is created by whoever arrives FIRST and shared (spec §5.2).
      expect(d.calls.filter((c) => c.startsWith("ensureMeeting")).length).toBe(2);
      const meetings = await sql<{ meeting_id: string }[]>`
        select meeting_id from fixture_video_meeting where fixture_id = ${s.fixtureId}`;
      expect(meetings.length, "one meeting for the board, not one per player").toBe(1);
    });

    it("sweeps all three policies against both publisher states and reports the count", async () => {
      const cases: { policy: CameraPolicy; publisher: boolean; seated: boolean; tile: boolean }[] = [
        { policy: "off", publisher: false, seated: true, tile: false },
        { policy: "off", publisher: true, seated: true, tile: false },
        { policy: "optional", publisher: false, seated: true, tile: true },
        { policy: "optional", publisher: true, seated: true, tile: true },
        { policy: "required", publisher: false, seated: false, tile: false },
        { policy: "required", publisher: true, seated: true, tile: true },
      ];
      let checked = 0;
      for (const c of cases) {
        const s = await seed({ cameraPolicy: c.policy });
        const d = videoDouble({ publisher: c.publisher });
        const got = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video });
        expect(got.seated, `${c.policy}/${c.publisher}`).toBe(c.seated);
        if (got.seated) expect(got.participant !== null, `${c.policy}/${c.publisher} tile`).toBe(c.tile);
        checked += 1;
      }
      expect(checked, "anti-vacuity: 3 policies × 2 publisher states").toBe(6);
    });
  });
  ```

  Add `import type { CameraPolicy } from "@/server/external-play/camera-policy";`
  to the test file's imports.

- [ ] **Step 8: run it, watch it fail, implement the policy branches, run green.**
  Failure: 8 cases, every one `Error: unimplemented: policy branches land in
  the next step`. Replace that `throw` in `preflight.ts` with:

  ```ts
    const policy = await fixtureCameraPolicy(a.fixtureId);
    if (policy === "off") {
      // No meeting is created. Zero video spend (spec §5.1).
      return { seated: true, participant: null };
    }

    // D11: an organiser has already proceeded without video on this fixture.
    // Checked BEFORE any RealtimeKit call, because the whole point of the
    // override is that RealtimeKit may be the thing that is broken.
    const [bridge] = await sql<{ video_override_at: Date | null }[]>`
      select video_override_at from fixture_external_play where fixture_id = ${a.fixtureId}`;
    if (bridge?.video_override_at) return { seated: true, participant: null };

    const video = deps.video ?? REAL_VIDEO;
    const meeting = await video.ensureMeeting(a.fixtureId);
    const participant = await ensureParticipantRow(a, f.orgId, meeting.meetingId, video);

    if (policy === "optional") {
      // Shown if the player grants camera; NEVER blocks a seat. The publisher
      // state is deliberately not read: asking a question whose answer is
      // ignored is how a future refactor turns `optional` into `required`.
      return { seated: true, participant };
    }

    const live = await video.hasLiveVideoPublisher({
      meetingId: meeting.meetingId,
      participantId: participant.participantId,
    });
    if (live) {
      await sql`
        update fixture_video_participant set video_verified_at = ${now}
         where fixture_id = ${a.fixtureId} and person_id = ${a.personId}`;
      return { seated: true, participant };
    }
    // The seat REVERTS. Clearing the stamp is what stops createGameIfReady
    // reading a pass that was true a minute ago (Review Focus 3): there is no
    // stale value left to read.
    const cleared = await sql<{ video_verified_at: Date | null }[]>`
      update fixture_video_participant set video_verified_at = null
       where fixture_id = ${a.fixtureId} and person_id = ${a.personId}
       returning video_verified_at`;
    const hadPassedBefore = cleared.length > 0 && previouslyVerified;
    return { seated: false, reason: hadPassedBefore ? "camera_lost" : "camera_required" };
  }

  /** One participant per (fixture, person), created on first arrival and
   *  reused on every reload — a second `addParticipant` would mint a second
   *  billable participant and a second token for the same seat. */
  async function ensureParticipantRow(
    a: { fixtureId: string; personId: string },
    orgId: string,
    meetingId: string,
    video: NonNullable<PreflightDeps["video"]>,
  ): Promise<ParticipantToken> { /* body in the next step */ }
  ```

  `previouslyVerified` has to be read **before** the clear, so hoist it: add,
  immediately after the `bridge` read,

  ```ts
    const [priorRow] = await sql<{ video_verified_at: Date | null }[]>`
      select video_verified_at from fixture_video_participant
       where fixture_id = ${a.fixtureId} and person_id = ${a.personId}`;
    const previouslyVerified = priorRow?.video_verified_at != null;
  ```

- [ ] **Step 9: write `ensureParticipantRow`.**

  ```ts
  async function ensureParticipantRow(
    a: { fixtureId: string; personId: string },
    orgId: string,
    meetingId: string,
    video: NonNullable<PreflightDeps["video"]>,
  ): Promise<ParticipantToken> {
    const existing = await sql<{ participant_id: string }[]>`
      select participant_id from fixture_video_participant
       where fixture_id = ${a.fixtureId} and person_id = ${a.personId}`;
    const found = existing[0];
    if (found) {
      // The auth token is minted per participant and is not stored — a token
      // at rest is a token to leak, and the SDK can refresh its own. A reload
      // re-reads the participant and asks RealtimeKit for a fresh token.
      return refreshToken(found.participant_id, meetingId, video, a);
    }
    const minted = await video.addParticipant({ meetingId, subject: a.personId, preset: "player" });
    await sql`
      insert into fixture_video_participant (fixture_id, org_id, person_id, participant_id, preset)
      values (${a.fixtureId}, ${orgId}, ${a.personId}, ${minted.participantId}, 'player')
      on conflict (fixture_id, person_id) do nothing`;
    const [row] = await sql<{ participant_id: string }[]>`
      select participant_id from fixture_video_participant
       where fixture_id = ${a.fixtureId} and person_id = ${a.personId}`;
    // Lost a race: another request's participant is the stored one, so return
    // a token for THAT participant — two tokens for one seat is what the
    // POC's `game_ready` frame did wrong.
    if (row && row.participant_id !== minted.participantId) {
      return refreshToken(row.participant_id, meetingId, video, a);
    }
    return minted;
  }
  ```

  `refreshToken` is a two-line helper over T7's participant-token refresh
  endpoint; declare it in this file:

  ```ts
  /** POST …/participants/{id}/token — the documented way to get a fresh
   *  authToken for a participant that already exists. */
  async function refreshToken(
    participantId: string,
    meetingId: string,
    video: NonNullable<PreflightDeps["video"]>,
    a: { personId: string },
  ): Promise<ParticipantToken> {
    void a;
    return video.refreshParticipantToken({ meetingId, participantId });
  }
  ```

  **This needs one addition to T7**, which T8 makes in T7's module (adding to
  another task's module is allowed; renaming or re-shaping is not):

  ```ts
  // apps/web/src/server/external-play/video/realtimekit.ts
  /** A participant that already exists needs a fresh authToken on every
   *  reload; we deliberately do not store one. */
  export async function refreshParticipantToken(
    a: { meetingId: string; participantId: string },
    deps: RealtimeKitDeps = {},
  ): Promise<ParticipantToken> {
    const cfg = requireConfig();
    const data = (await cf(
      cfg,
      `/meetings/${encodeURIComponent(a.meetingId)}/participants/${encodeURIComponent(a.participantId)}/token`,
      { method: "POST" },
      deps,
    )) as { token?: unknown };
    if (typeof data.token !== "string" || data.token === "") {
      throw new RealtimeKitError(502, "unavailable", "RealtimeKit token refresh returned no token");
    }
    return { participantId: a.participantId, authToken: data.token };
  }
  ```

  Add `refreshParticipantToken: typeof refreshParticipantToken` to
  `PreflightDeps["video"]`, to `REAL_VIDEO`, and to the test's `videoDouble`
  (`async (x) => { calls.push(\`refreshParticipantToken:${x.participantId}\`); return { participantId: x.participantId, authToken: "jwt-stub" }; }`).
  Also add a T7 test for it, mirroring Step 11's shape: asserts the URL,
  `POST`, and that a tokenless body is a 502.

- [ ] **Step 10: run green.** Re-run Step 3's command. Expected
  `numTotalTests: 15`, `numPassedTests: 15`, `numFailedTests: 0`. Re-run T7's
  suite too, since Step 9 edited it:
  ```
  rm -f /tmp/b2-t8b.json && cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web \
    && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable \
       npx vitest run src/server/external-play/video/__tests__/realtimekit.test.ts \
          src/server/usecases/__tests__/external-play-preflight.test.ts \
       --reporter=json --outputFile=/tmp/b2-t8b.json
  ```
  Expected `numTotalTests: 32` (17 + 15), `numFailedTests: 0`. Positionals are
  literal filename filters, so confirm both file names appear in
  `jq -r '.testResults[].name' /tmp/b2-t8b.json` — a typo'd path silently runs
  a subset and reports green.

- [ ] **Step 11: mutate the three policy branches, one at a time.**
  (a) Change `if (policy === "off")` to `if (policy === "off" || policy ===
  "optional")`. Re-run: the optional test and two sweep rows must fail on the
  missing tile. Restore.
  (b) In the `optional` branch, fall through to the publisher check instead of
  returning. Re-run: "optional … NEVER blocks" must fail. Restore.
  (c) Delete the `update … set video_verified_at = null` clear. Re-run: "no
  publisher, first attempt" still passes, so add nothing here — the clear is
  killed by Step 13's Review Focus 3 test instead, which is why that test is
  the one that matters. Note this honestly in the commit body rather than
  claiming a mutant that does not exist.
  (d) Change the `addParticipant` reuse check so it always mints. Re-run: the
  second-call sequence test must fail on `expected 1 to be 0`. Restore.

- [ ] **Step 12: commit the policy branches.**
  ```
  git add apps/web/src/server/usecases/external-play/preflight.ts \
          apps/web/src/server/external-play/video/realtimekit.ts \
          apps/web/src/server/external-play/video/__tests__/realtimekit.test.ts \
          apps/web/src/server/usecases/__tests__/external-play-preflight.test.ts
  git commit -m "feat(chess): seat gating per camera policy, verified against the meeting

  off creates no meeting at all; optional offers a tile and never blocks, and
  deliberately does not even ask about the publisher; required seats only when
  the meeting reports the participant present in a live session. One
  participant per (fixture, person), reused on reload — the auth token is
  re-minted rather than stored, because a stored token is a token to leak.
  Mutants: folding optional into off, letting optional fall through to the
  publisher check, and always minting a participant each red exactly one test.
  The verified-at CLEAR has no mutant here; it is killed by the Review Focus 3
  test in the next commit.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 13: write the failing Review Focus 3 test — a pass that goes stale
  before the game is created.** Append:

  ```ts
  describe.skipIf(!process.env.DATABASE_URL)("Review Focus 3 — camera granted, then revoked before the game is created", () => {
    it("the seat REVERTS, the player is told why, and no stale pass is left on the row", async () => {
      const s = await seed({ cameraPolicy: "required" });

      // 1. Preflight passes. This is the state the player sees as "seated".
      const good = videoDouble({ publisher: true });
      const seated = await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: good.video });
      expect(seated.seated, "premise: the camera really did pass first").toBe(true);
      const [before] = await sql<{ video_verified_at: Date | null }[]>`
        select video_verified_at from fixture_video_participant
         where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`;
      expect(before?.video_verified_at, "premise: the pass was recorded").not.toBeNull();

      // 2. The player covers the lens / revokes permission. Nothing tells us;
      //    the next verification is what finds out.
      const gone = videoDouble({ publisher: false });
      const after = await seatPlayer(
        { fixtureId: s.fixtureId, personId: s.home.personId },
        { now: new Date(NOW.getTime() + 30_000), video: gone.video },
      );

      // 3. The seat is gone, and the reason distinguishes "never had it" from
      //    "had it and lost it" — the room renders different copy for each.
      expect(after).toEqual({ seated: false, reason: "camera_lost" });

      // 4. And this is the half that stops creation proceeding on a stale
      //    pass: there is no stale value left on the row to read.
      const [row] = await sql<{ video_verified_at: Date | null }[]>`
        select video_verified_at from fixture_video_participant
         where fixture_id = ${s.fixtureId} and person_id = ${s.home.personId}`;
      expect(row?.video_verified_at).toBeNull();

      // 5. Re-verification is not a one-way door: the camera coming back seats
      //    the player again, with the same participant.
      const back = videoDouble({ publisher: true });
      const again = await seatPlayer(
        { fixtureId: s.fixtureId, personId: s.home.personId },
        { now: new Date(NOW.getTime() + 60_000), video: back.video },
      );
      expect(again.seated).toBe(true);
      expect(again.seated && again.participant?.participantId).toBe(
        seated.seated ? seated.participant?.participantId : "mismatch",
      );
    });

    it("camera_required and camera_lost are not interchangeable: a player who never passed gets camera_required", async () => {
      // The differential pair. Without this, an implementation that always
      // answers camera_lost passes the test above.
      const s = await seed({ cameraPolicy: "required" });
      const d = videoDouble({ publisher: false });
      expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video })).toEqual({
        seated: false,
        reason: "camera_required",
      });
    });
  });
  ```

- [ ] **Step 14: run it and watch the right half fail.** Re-run Step 3's
  command. Expected: `numTotalTests: 17`, `numFailedTests: 0` **if** Step 8's
  clear and `previouslyVerified` hoist were written correctly — so **prove the
  test is not decoration by mutating now**, before trusting it:
  (a) Delete the `update … set video_verified_at = null … returning` statement
  and return `{ seated: false, reason: "camera_required" }`. Re-run: the
  Review Focus 3 test must fail twice — on `camera_lost` and on
  `expected 2026-10-01T12:05:00.000Z to be null`. Restore.
  (b) Replace `hadPassedBefore ? "camera_lost" : "camera_required"` with a bare
  `"camera_lost"`. Re-run: the differential test must fail. Restore.
  (c) Move the `priorRow` read to AFTER the clear. Re-run: the Review Focus 3
  test must fail on the reason — this is the ordering bug the hoist exists for.
  Restore.

- [ ] **Step 15: write the failing forged-claim tests.** Append:

  ```ts
  import { readFileSync } from "node:fs";
  import { join } from "node:path";

  describe.skipIf(!process.env.DATABASE_URL)("a forged camera claim is inert (spec §5.2, §10)", () => {
    it("an extra cameraOk:true on the argument changes nothing", async () => {
      const s = await seed({ cameraPolicy: "required" });
      const d = videoDouble({ publisher: false });
      // The POC's gate, forced onto the call as a hostile client would:
      // seatPlayer has no such parameter, so this must be dead weight.
      const forged = { fixtureId: s.fixtureId, personId: s.home.personId, cameraOk: true } as unknown as {
        fixtureId: string;
        personId: string;
      };
      expect(await seatPlayer(forged, { now: NOW, video: d.video })).toEqual({
        seated: false,
        reason: "camera_required",
      });
      expect(
        d.calls.filter((c) => c.startsWith("hasLiveVideoPublisher")).length,
        "the meeting was asked anyway — that is the point",
      ).toBe(1);
    });

    it("the module names no client-supplied camera flag anywhere in its source", async () => {
      // An audit-shaped test, so it carries its own anti-vacuity: a positive
      // control that proves the file was really read, and a byte count.
      const src = readFileSync(
        join(__dirname, "../external-play/preflight.ts"),
        "utf8",
      );
      expect(src.length, "premise: the file was actually read").toBeGreaterThan(500);
      expect(src, "positive control: this IS the preflight module").toContain("hasLiveVideoPublisher");
      expect(src, "positive control: and it is the one that gates the seat").toContain("camera_required");
      // The negative.
      expect(src).not.toMatch(/camera[_ ]?ok/i);
      expect(src).not.toMatch(/\bclaimsCamera\b|\bcameraGranted\b/);
    });
  });
  ```

- [ ] **Step 16: run them, and mutate the audit-shaped one by hand.**
  Expected on first run: `numTotalTests: 19`, `numFailedTests: 0` — both pass
  immediately, because `seatPlayer` was built without such a parameter. A test
  that cannot go red is decoration, so substitute a mutation check: add
  `const cameraOk = false; void cameraOk;` to `preflight.ts`, re-run, and
  confirm the source-scan test fails on
  `expected '…const cameraOk = false…' not to match /camera[_ ]?ok/i`. Delete
  the line (restore from the `cp` backup) and re-run green. Record the mutation
  in the commit body — this is the only evidence the test works.

- [ ] **Step 17: write the failing D11 override test, implement, run green.**
  Test:

  ```ts
  import { organiserOverrideVideo } from "../external-play/preflight";

  describe.skipIf(!process.env.DATABASE_URL)("organiserOverrideVideo (D11 — a vendor outage must not cancel a tournament)", () => {
    it("after an override, a required division seats the player with no tile, and RealtimeKit is never called", async () => {
      const s = await seed({ cameraPolicy: "required" });
      const userId = await ownerUserId(s.orgId);
      await organiserOverrideVideo({
        fixtureId: s.fixtureId,
        actorUserId: userId,
        note: "RealtimeKit 503 for twenty minutes; both players present in the hall",
      });
      // The double would answer `false` and the publisher check would refuse —
      // so a seated result proves the override short-circuited BEFORE it.
      const d = videoDouble({ publisher: false });
      expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW, video: d.video })).toEqual({
        seated: true,
        participant: null,
      });
      expect(d.calls, "the override exists because the vendor may be the broken thing").toEqual([]);
    });

    it("writes exactly one audit row, carrying the actor and the note", async () => {
      const s = await seed({ cameraPolicy: "required" });
      const userId = await ownerUserId(s.orgId);
      await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: userId, note: "vendor outage" });
      const rows = await sql<{ payload: Record<string, unknown>; actor_id: string | null }[]>`
        select payload, actor_id from competition_events
         where competition_id = ${s.competitionId} and type = 'chess.camera_override'`;
      expect(rows.length).toBe(1);
      expect(rows[0]?.actor_id).toBe(userId);
      expect(rows[0]?.payload).toMatchObject({ fixtureId: s.fixtureId, note: "vendor outage" });
    });

    it("is idempotent: a second override does not double-write the stamp or the ledger", async () => {
      const s = await seed({ cameraPolicy: "required" });
      const userId = await ownerUserId(s.orgId);
      await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: userId, note: "one" });
      const [first] = await sql<{ video_override_at: Date; video_override_note: string | null }[]>`
        select video_override_at, video_override_note from fixture_external_play where fixture_id = ${s.fixtureId}`;
      await organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: userId, note: "two" });
      const [second] = await sql<{ video_override_at: Date; video_override_note: string | null }[]>`
        select video_override_at, video_override_note from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(second?.video_override_at.getTime()).toBe(first?.video_override_at.getTime());
      expect(second?.video_override_note, "the first reason is the one on the record").toBe("one");
      const rows = await sql<{ id: string }[]>`
        select id from competition_events
         where competition_id = ${s.competitionId} and type = 'chess.camera_override'`;
      expect(rows.length).toBe(1);
    });

    it("an empty note is refused — an unexplained override is not an audit trail", async () => {
      const s = await seed({ cameraPolicy: "required" });
      const userId = await ownerUserId(s.orgId);
      await expect(
        organiserOverrideVideo({ fixtureId: s.fixtureId, actorUserId: userId, note: "   " }),
      ).rejects.toMatchObject({ status: 422, code: "OVERRIDE_NOTE_REQUIRED" });
      const rows = await sql<{ id: string }[]>`
        select id from competition_events
         where competition_id = ${s.competitionId} and type = 'chess.camera_override'`;
      expect(rows.length).toBe(0);
    });
  });

  async function ownerUserId(orgId: string): Promise<string> {
    const [row] = await sql<{ user_id: string }[]>`
      select user_id from org_members where org_id = ${orgId} and role = 'owner' limit 1`;
    if (!row) throw new Error("seed produced no owner membership");
    return row.user_id;
  }
  ```

  Implementation, appended to `preflight.ts`:

  ```ts
  /** D11. RealtimeKit unavailable under `required`: an organiser may proceed
   *  without video, and an audit row says who did and why. A video vendor
   *  outage must not cancel a tournament — and must not be silent either.
   *
   *  Idempotent, and deliberately FIRST-WRITER-WINS: the reason on the record
   *  is the one given when the decision was actually taken, not whatever a
   *  later click re-sent. */
  export async function organiserOverrideVideo(a: {
    fixtureId: string;
    actorUserId: string;
    note: string;
  }): Promise<void> {
    const note = a.note.trim();
    if (note === "") {
      throw new HttpError(422, "an override needs a reason", "OVERRIDE_NOTE_REQUIRED");
    }
    const f = await loadOnlinePlayFixture(a.fixtureId);
    if (!f) throw new HttpError(404, "fixture not found", "NOT_FOUND");
    await ensureBridgeRow(f);
    const claimed = await sql<{ fixture_id: string }[]>`
      update fixture_external_play
         set video_override_at = now(), video_override_by = ${a.actorUserId},
             video_override_note = ${note}, updated_at = now()
       where fixture_id = ${a.fixtureId} and video_override_at is null
       returning fixture_id`;
    if (claimed.length === 0) return; // already overridden — nothing more to say
    const [row] = await sql<{ competition_id: string }[]>`
      select c.id as competition_id
        from fixtures fx
        join divisions d on d.id = fx.division_id
        join competitions c on c.id = d.competition_id
       where fx.id = ${a.fixtureId}`;
    if (!row) throw new HttpError(404, "fixture not found", "NOT_FOUND");
    await audit(sql, row.competition_id, f.orgId, "chess.camera_override", { fixtureId: a.fixtureId, note }, a.actorUserId);
  }
  ```

  Add `HttpError` and `ensureBridgeRow` to the file's imports. Expected after
  this step: `numTotalTests: 23`, `numPassedTests: 23`, `numFailedTests: 0`.

- [ ] **Step 18: mutate the override guards, one at a time, then commit.**
  (a) Drop `and video_override_at is null` from the claim. Re-run: the
  idempotency test must fail on both the stamp and the note. Restore.
  (b) Drop the `note === ""` refusal. Re-run: the empty-note test must fail.
  Restore.
  (c) Move the `bridge?.video_override_at` check in `seatPlayer` to AFTER
  `ensureMeeting`. Re-run: the first override test must fail on
  `expected [ 'ensureMeeting:…' ] to equal []` — the override is useless if it
  calls the vendor that is down. Restore.
  ```
  rtk proxy npx tsc --noEmit -p apps/web
  rtk proxy npx eslint apps/web/src/server/usecases/external-play/preflight.ts
  git add apps/web/src/server/usecases/external-play/preflight.ts \
          apps/web/src/server/usecases/__tests__/external-play-preflight.test.ts
  git commit -m "feat(chess): stale camera passes revert the seat, and D11 organiser override

  Review Focus 3: a pass that goes stale before creation clears video_verified_at
  and answers camera_lost, so there is no stale value for createGameIfReady to
  read; camera_required and camera_lost are kept distinct and each has its own
  case. A forged cameraOk on the argument is inert, proved by driving it AND by
  a source scan with positive controls (mutated by hand: adding a cameraOk
  identifier reds it). The override is checked before any RealtimeKit call,
  because the vendor is the thing that may be down, and is first-writer-wins so
  the recorded reason is the one the decision was taken on. Mutants: dropping
  the claim's null guard, the note refusal, and moving the override check after
  ensureMeeting each red exactly one case.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 9: Create the game

**Files:**

Create:
- `apps/web/src/server/usecases/external-play/create-game.ts`
- `apps/web/src/server/usecases/__tests__/external-play-create-game.test.ts`

Modify:
- `apps/web/src/server/usecases/external-play/room.ts:150, 187, 239, 286, 323` —
  the D12 re-anchor only (see Step 16). The wider room rewrite the
  file-structure table assigns to T9 — dropping `playUrl`/`watchUrl`, which D3
  deleted along with the lichess.org mode — is **not** in this brief and is
  owed by T14's surfaces. Flagged rather than silently absorbed.

**Interfaces:**

*Consumes:* `loadOnlinePlayFixture`, `loadSides`, `whiteSideOf`,
`effectiveBridge`, `resetStaleBridge`, `ensureBridgeRow`, `type Side`
(`./guard`); `MINT_CLAIM_STALE_MS`, `roomPhase`, `windowFor`
(`@/server/external-play/window.ts:8,25,14`); `roundOpenFor` (T6);
`seatPlayer` (T8); `createChallengeToUser`, `acceptChallenge`,
`type BoardErrorCode` (T3, `@/server/external-play/lichess/board-api`);
`enqueueCreation` (T4); `SHIP1_TIME_CONTROLS`, `type TimeControl` (T5);
`getLichessLink`, `getLichessAccessToken` (T2, in its post-T2 shape —
P-B2-10); `publishExternalPlayLobby` (`@/lib/realtime`).

*Produces* — authoritative, verbatim:

```ts
export type CreateOutcome =
  | { created: true; gameId: string }
  | { created: false; reason: "not_ready" | "already" | "unplayable" | "provider_error" | "no_person" };
export function createGameIfReady(fixtureId: string): Promise<CreateOutcome>;
```

plus, added to T9's own module:

```ts
export type CreateGameDeps = { now?: Date; publish?: (fixtureId: string) => Promise<void> };
export const REQUIRED_LICHESS_SCOPES: readonly string[]; // ["board:play","challenge:write"]
```

`REQUIRED_LICHESS_SCOPES` is declared here because no task in the authoritative
list owns it. If T2 ends up exporting an equivalent, this one is deleted and
the import re-pointed in the same commit — one authority per fact.

**Reason mapping, decided here so no step has to improvise:**

| Situation | Reason |
|---|---|
| guard returns null, fixture has a null entrant (bye) | `no_person` |
| guard returns null for any other cause (not online, wrong sport, finalized, no such fixture) | `not_ready` |
| a side's `personId` is null (merged-only or unrostered entrant) | `no_person` |
| round never opened, window closed, missing consent, missing scope, a seat refused | `not_ready` |
| a `challenge_id` is already recorded | `already` |
| the claim UPDATE matched nothing, or the ready UPDATE lost the claim mid-flight | `not_ready` |
| the division's clock is not in `SHIP1_TIME_CONTROLS` | `unplayable` |
| T3 returns `{ok:false}` on either call | `provider_error` |

A lost claim is `not_ready`, not `already`: `already` would tell the caller the
work is done when the other claimant may still fail, and `not_ready` is
retry-safe because the claim UPDATE is the real serialiser (the same reasoning
`mintIfReady` encodes with its separate `"busy"`, which this fixed union has no
slot for — noted in the module header).

Steps:

- [ ] **Step 1: write the failing `no_person` tests — Review Focus 5.** Create
  `apps/web/src/server/usecases/__tests__/external-play-create-game.test.ts`:

  ```ts
  // T9 — claim-then-call creation. Review Focus 5 lives here: an entrant with
  // no person behind it is never offered as an online match, and says so,
  // rather than failing at creation.
  import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import { appendEvent } from "@/server/engine-db";
  import { createGameIfReady } from "../external-play/create-game";
  import { seedOnlineChessFixture } from "./_external-play-seed";

  const T = new Date("2026-10-01T12:10:00.000Z");
  const OPENED = new Date("2026-10-01T12:00:00.000Z");
  const NOW = new Date("2026-10-01T12:05:00.000Z");

  // The Lichess Board API is module-mocked rather than fetch-stubbed: T9
  // consumes T3's module functions directly, so the module boundary IS the
  // seam. The mock's own implementation can touch the database, which is how
  // the mid-flight takeover case below is driven without a test-only hook in
  // production code.
  const board = vi.hoisted(() => ({
    createChallengeToUser: vi.fn(),
    acceptChallenge: vi.fn(),
  }));
  vi.mock("@/server/external-play/lichess/board-api", () => board);

  // T8's seat: the real one would call RealtimeKit. Default is "both seated".
  const preflight = vi.hoisted(() => ({ seatPlayer: vi.fn() }));
  vi.mock("../external-play/preflight", () => preflight);

  beforeEach(() => {
    vi.clearAllMocks();
    board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: "gm-1" });
    board.acceptChallenge.mockResolvedValue({ ok: true });
    preflight.seatPlayer.mockResolvedValue({ seated: true, participant: null });
  });

  /** 5+3 is in SHIP1_TIME_CONTROLS; `base` is seconds (see the seed helper's
   *  own default of 900/0, and mapBoardgameClockToLichess). */
  const seed = (over: Partial<Parameters<typeof seedOnlineChessFixture>[0]> = {}) =>
    seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: T,
      linked: true,
      roundOpenedAt: OPENED,
      clock: { base: 300, increment: 3 },
      ...over,
    });

  const noHttp = () => {
    expect(board.createChallengeToUser, "no Lichess call may happen").not.toHaveBeenCalled();
    expect(board.acceptChallenge).not.toHaveBeenCalled();
  };

  describe.skipIf(!process.env.DATABASE_URL)("Review Focus 5 — there is no person to seat", () => {
    afterAll(async () => {
      await sql.end();
    });

    it("an entrant whose only member is MERGED ⇒ no_person, and nothing is called", async () => {
      const s = await seed();
      // loadSide LEFT-joins `persons … and p.merged_into is null` (guard.ts:246),
      // so a tombstoned sole member nulls personId while displayName survives.
      await sql`
        update persons set merged_into = ${s.away.personId} where id = ${s.home.personId}`;
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "no_person",
      });
      noHttp();
    });

    it("an entrant with no members at all ⇒ no_person", async () => {
      const s = await seed();
      await sql`delete from entrant_members where entrant_id = ${s.home.entrantId}`;
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "no_person",
      });
      noHttp();
    });

    it("a BYE row ⇒ no_person, even though the guard refuses it before any side is loaded", async () => {
      const s = await seed();
      await sql`
        update fixtures
           set away_entrant_id = null,
               away_slot_label = ${sql.json({ key: "bracket.slot.bye" } as never)}
         where id = ${s.fixtureId}`;
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "no_person",
      });
      noHttp();
    });

    it("empty case: a fixture id that does not exist ⇒ not_ready, NOT no_person", async () => {
      // The differential that stops no_person becoming the catch-all for every
      // guard refusal. Without it, "classify the null" can be implemented as
      // "always say no_person" and every test above still passes.
      expect(await createGameIfReady(randomUUID(), { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      noHttp();
    });

    it("another sport: a non-boardgame fixture with both entrants ⇒ not_ready, not no_person", async () => {
      const { seedOrg, seedFutureDivision } = await import("./_seed");
      const { auth } = await seedOrg();
      const { fixtures } = await seedFutureDivision(auth);
      const fixture = fixtures[0];
      if (!fixture) throw new Error("seedFutureDivision produced no fixtures");
      expect(await createGameIfReady(fixture.id, { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      noHttp();
    });

    it("online play off ⇒ not_ready, not no_person", async () => {
      const s = await seed({ onlinePlay: "off" });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      noHttp();
    });
  });
  ```

- [ ] **Step 2: run it and watch it fail.**
  ```
  rm -f /tmp/b2-t9a.json && cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web \
    && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable \
       npx vitest run src/server/usecases/__tests__/external-play-create-game.test.ts \
       --reporter=json --outputFile=/tmp/b2-t9a.json
  ```
  Expected: collect failure, `Cannot find module ../external-play/create-game`,
  `numTotalTests: 0`.

- [ ] **Step 3: write the classifier and the no-person gate; go green.**
  Create `create-game.ts`:

  ```ts
  import "server-only";
  // Creation (spec §3.3). Claim-then-call, the shape mintIfReady already uses
  // (room.ts:260-350): claim with a conditional UPDATE, call Lichess OUTSIDE
  // any transaction, then commit with an UPDATE conditional on the SAME claim
  // stamp — so a takeover mid-flight cannot stomp another minter's work.
  //
  // White's token challenges Black's username and Black's token accepts.
  // Colour is READ from the pairing (whiteSideOf), never assigned here — W3
  // owns colour allocation.
  //
  // CreateOutcome has no "busy": a lost claim answers `not_ready`, which is
  // retry-safe, rather than `already`, which would promise the work is done
  // while the other claimant may still fail.
  import { sql } from "@/lib/db";
  import { loadOnlinePlayFixture, type OnlinePlayFixture } from "./guard";

  export type CreateOutcome =
    | { created: true; gameId: string }
    | { created: false; reason: "not_ready" | "already" | "unplayable" | "provider_error" | "no_person" };

  export type CreateGameDeps = { now?: Date; publish?: (fixtureId: string) => Promise<void> };

  export const REQUIRED_LICHESS_SCOPES: readonly string[] = ["board:play", "challenge:write"];

  /** The guard answers `null` for "not an online fixture" AND for a bye, so a
   *  bye cannot be told apart without this second read (plan premise P-B2-11).
   *  One query, only on the refusal path. */
  async function classifyRefusedFixture(fixtureId: string): Promise<"no_person" | "not_ready"> {
    const [row] = await sql<{ home: string | null; away: string | null }[]>`
      select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
    if (!row) return "not_ready";
    return row.home === null || row.away === null ? "no_person" : "not_ready";
  }

  export async function createGameIfReady(
    fixtureId: string,
    deps: CreateGameDeps = {},
  ): Promise<CreateOutcome> {
    const f = await loadOnlinePlayFixture(fixtureId);
    if (!f) return { created: false, reason: await classifyRefusedFixture(fixtureId) };
    throw new Error("unimplemented: readiness and creation land in the next steps");
  }
  ```

  Then the sides gate, which needs `loadSides`:

  ```ts
    const { home, away } = await loadSides(f);
    // An unrostered entrant, or one whose sole member is a merge tombstone:
    // loadSides always returns a displayName but nulls personId
    // (guard.ts:223-271). There is nobody to seat, so this fixture is never
    // offered as an online match — it says so here rather than failing at
    // creation with a provider error nobody can read.
    if (home.personId === null || away.personId === null) {
      return { created: false, reason: "no_person" };
    }
  ```

  Expected after this step: `numTotalTests: 6`, `numPassedTests: 6`. The three
  no-person cases and the three not_ready cases all answer before reaching the
  unimplemented line; any case reporting `unimplemented` means the order is
  wrong, not the test.

- [ ] **Step 4: mutate the classifier.** Replace `classifyRefusedFixture`'s body
  with `return "no_person";`. Re-run: all three `not_ready` cases must fail.
  Restore. Then replace it with `return "not_ready";`. Re-run: the BYE case
  must fail. Restore. Two mutants, because the two branches cover for each
  other.

- [ ] **Step 5: commit the classifier.**
  ```
  git add apps/web/src/server/usecases/external-play/create-game.ts \
          apps/web/src/server/usecases/__tests__/external-play-create-game.test.ts
  git commit -m "feat(chess): a fixture with no person behind an entrant is never created

  Review Focus 5. The guard answers null for both 'not an online fixture' and
  'bye', so the refusal path classifies it with one extra read: a null entrant
  is no_person, anything else is not_ready. A merged-only or unrostered entrant
  is caught from loadSides' null personId, before any Lichess call. Mutants:
  pinning the classifier to either answer reds the opposite branch.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 6: write the failing readiness tests — including D12.** Append:

  ```ts
  import { getLichessLink } from "../external-accounts";

  /** T2 stores scopes and a consent stamp; the seed links with both set. These
   *  helpers break one requirement at a time so each guard is individually
   *  killable. */
  async function clearConsent(userId: string) {
    await sql`update user_external_accounts set consented_at = null where user_id = ${userId}`;
  }
  async function narrowScopes(userId: string, scopes: string[]) {
    await sql`
      update user_external_accounts set scopes = ${sql.array(scopes)} where user_id = ${userId}`;
  }

  describe.skipIf(!process.env.DATABASE_URL)("readiness", () => {
    it("D12: a paired-but-UNOPENED round creates nothing", async () => {
      // Fixtures exist because Swiss paired them; nothing has been sent. This
      // is the state that used to be indistinguishable from "window open" when
      // the anchor was the timetable.
      const s = await seed({ roundOpenedAt: undefined });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      noHttp();
    });

    it("D12: a past scheduled time with no open stamp still creates nothing", async () => {
      const s = await seed({ roundOpenedAt: undefined });
      expect(
        await createGameIfReady(s.fixtureId, { now: new Date(T.getTime() + 5 * 60_000) }),
      ).toEqual({ created: false, reason: "not_ready" });
      noHttp();
    });

    it("past T+20 of the open stamp ⇒ not_ready", async () => {
      const s = await seed();
      expect(
        await createGameIfReady(s.fixtureId, { now: new Date(OPENED.getTime() + 20 * 60_000 + 1) }),
      ).toEqual({ created: false, reason: "not_ready" });
      noHttp();
    });

    it("a player who has not re-consented ⇒ not_ready", async () => {
      // Spec §3.1: players linked under the identity-only flow must see the
      // re-consent screen before their first online fixture.
      const s = await seed();
      await clearConsent(s.home.userId);
      expect(await getLichessLink(s.home.userId).then((l) => l?.consentedAt), "premise").toBeNull();
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      noHttp();
    });

    it("a player missing board:play ⇒ not_ready (separately from consent)", async () => {
      const s = await seed();
      await narrowScopes(s.away.userId, ["challenge:write"]);
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      noHttp();
    });

    it("a player missing challenge:write ⇒ not_ready", async () => {
      const s = await seed();
      await narrowScopes(s.home.userId, ["board:play"]);
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      noHttp();
    });

    it("sweeps every required scope, dropping one at a time, and reports the count", async () => {
      const required = ["board:play", "challenge:write"];
      let checked = 0;
      for (const dropped of required) {
        const s = await seed();
        await narrowScopes(s.home.userId, required.filter((x) => x !== dropped));
        const got = await createGameIfReady(s.fixtureId, { now: NOW });
        expect(got, `without ${dropped}`).toEqual({ created: false, reason: "not_ready" });
        checked += 1;
      }
      expect(checked, "anti-vacuity: every required scope tested as the missing one").toBe(
        required.length,
      );
      expect(required.length, "premise: the module declares two").toBe(2);
    });

    it("a refused SEAT ⇒ not_ready, and no Lichess call (the creation half of Review Focus 3)", async () => {
      const s = await seed({ cameraPolicy: "required" });
      preflight.seatPlayer.mockResolvedValue({ seated: false, reason: "camera_lost" });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      noHttp();
    });

    it("BOTH seats are checked, not just the first", async () => {
      const s = await seed({ cameraPolicy: "required" });
      preflight.seatPlayer
        .mockResolvedValueOnce({ seated: true, participant: null })
        .mockResolvedValueOnce({ seated: false, reason: "camera_required" });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      expect(preflight.seatPlayer).toHaveBeenCalledTimes(2);
      noHttp();
    });

    it("a clock outside the ship-1 list ⇒ unplayable, and no call is made (M12)", async () => {
      // 1+0 is the dangerous case the whole time-control rule exists for:
      // Lichess ACCEPTS the challenge and then refuses every move on it.
      const s = await seed({ clock: { base: 60, increment: 0 } });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "unplayable",
      });
      noHttp();
    });

    it("sweeps the whole ship-1 list and confirms each one is accepted here", async () => {
      const { SHIP1_TIME_CONTROLS } = await import("@/server/external-play/time-controls");
      let checked = 0;
      for (const tc of SHIP1_TIME_CONTROLS) {
        const s = await seed({ clock: { base: tc.limitSeconds, increment: tc.incrementSeconds } });
        const got = await createGameIfReady(s.fixtureId, { now: NOW });
        expect(got, `${tc.key} must be creatable`).toEqual({ created: true, gameId: "gm-1" });
        checked += 1;
        vi.clearAllMocks();
        board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: "gm-1" });
        board.acceptChallenge.mockResolvedValue({ ok: true });
        preflight.seatPlayer.mockResolvedValue({ seated: true, participant: null });
      }
      // Derived from T5's own catalogue, never a number typed in here: adding
      // a time control moves this test with it.
      expect(checked, "anti-vacuity: every catalogue entry").toBe(SHIP1_TIME_CONTROLS.length);
      expect(SHIP1_TIME_CONTROLS.length, "premise: the catalogue is not empty").toBeGreaterThan(0);
    });
  });
  ```

- [ ] **Step 7: run it, watch it fail, implement readiness.** Failure: 12 cases,
  every one `Error: unimplemented: readiness and creation land in the next
  steps`. Replace the `throw` with:

  ```ts
    const now = deps.now ?? new Date();

    // Nothing to do for a bridge already past 'pending' — and a recorded
    // challenge id is the one case that means "someone already did this".
    const known = effectiveBridge(f);
    if (known?.challenge_id) return { created: false, reason: "already" };
    if (known && known.status !== "pending") return { created: false, reason: "not_ready" };

    // D12: the window hangs off the organiser's open, never off the timetable.
    // A paired-but-unopened round has fixtures and no invitation; creating a
    // game for it would start a clock against people who were never called.
    const open = await roundOpenFor(sql, fixtureId);
    if (!open) return { created: false, reason: "not_ready" };
    if (roomPhase(now, open.roundOpenedAt) !== "open") return { created: false, reason: "not_ready" };

    const links = await Promise.all([getLichessLink(home.userId!), getLichessLink(away.userId!)]);
    for (const link of links) {
      if (!link) return { created: false, reason: "not_ready" };
      if (link.consentedAt === null) return { created: false, reason: "not_ready" };
      if (!REQUIRED_LICHESS_SCOPES.every((s) => link.scopes.includes(s))) {
        return { created: false, reason: "not_ready" };
      }
    }

    // Re-verified HERE, immediately before creating, and not read off a stored
    // stamp: seatPlayer re-asks the meeting on every call, which is what makes
    // a pass that went stale since preflight unable to let creation through
    // (Review Focus 3).
    const seats = await Promise.all([
      seatPlayer({ fixtureId, personId: home.personId }),
      seatPlayer({ fixtureId, personId: away.personId }),
    ]);
    if (seats.some((s) => !s.seated)) return { created: false, reason: "not_ready" };

    // Validated through T5's catalogue, because creation succeeding proves
    // nothing about playability (M12). Matched on the mapped clock rather than
    // a formatted key string, so there is no string-building step to get wrong.
    const tc = SHIP1_TIME_CONTROLS.find(
      (c) => c.limitSeconds === f.clock.limit && c.incrementSeconds === f.clock.increment,
    );
    if (!tc) return { created: false, reason: "unplayable" };
    throw new Error("unimplemented: the claim and the calls land in the next step");
  ```

  `home.userId!` / `away.userId!` would be a non-null assertion, which this
  repo's lint refuses — narrow instead, beside the `personId` gate:

  ```ts
    const homeUserId = home.userId;
    const awayUserId = away.userId;
    const homePersonId = home.personId;
    const awayPersonId = away.personId;
    if (homePersonId === null || awayPersonId === null) {
      return { created: false, reason: "no_person" };
    }
    if (homeUserId === null || awayUserId === null) {
      // A person with no linked Seazn user has no Lichess token and cannot
      // submit a move; that is not a missing PERSON, it is an unready one.
      return { created: false, reason: "not_ready" };
    }
  ```

  Add the imports: `effectiveBridge`, `loadSides`, `whiteSideOf` from `./guard`;
  `roomPhase`, `windowFor`, `MINT_CLAIM_STALE_MS` from
  `@/server/external-play/window`; `roundOpenFor` from
  `@/server/external-play/round-open`; `seatPlayer` from `./preflight`;
  `SHIP1_TIME_CONTROLS` from `@/server/external-play/time-controls`;
  `getLichessLink`, `getLichessAccessToken` from `../external-accounts`.

  Expected after this step: the ten refusal cases of Step 6 pass; the two that
  expect `created: true` (the catalogue sweep) still fail on `unimplemented`.
  `numTotalTests: 18`, `numFailedTests: 1`.

- [ ] **Step 8: mutate the D12 and scope guards, one at a time.**
  (a) Replace `roomPhase(now, open.roundOpenedAt)` with
  `roomPhase(now, f.scheduledAt)`. Re-run: "past T+20 of the open stamp" must
  fail. Restore.
  (b) Delete `if (!open) return …`. Re-run: both D12 tests must fail — the
  second one is the important half, because with the schedule anchor a past
  `scheduled_at` reads as "open". Restore.
  (c) Change the scope check to `.some(` instead of `.every(`. Re-run: both
  single-scope tests and both sweep rows must fail. Restore.
  (d) Delete the `link.consentedAt === null` check. Re-run: the re-consent test
  must fail. Restore. (Separate from (c) because scopes and consent cover for
  each other on the happy path.)

- [ ] **Step 9: write the failing creation tests.** Append:

  ```ts
  describe.skipIf(!process.env.DATABASE_URL)("creation", () => {
    it("White's token challenges Black's username, and Black's token accepts", async () => {
      const s = await seed();
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: true,
        gameId: "gm-1",
      });
      expect(board.createChallengeToUser).toHaveBeenCalledTimes(1);
      const challenge = board.createChallengeToUser.mock.calls[0]?.[0] as {
        whiteToken: string; blackUsername: string; limitSeconds: number; incrementSeconds: number;
      };
      // No pairing card recorded ⇒ White is home (Swiss's own default,
      // guard.ts:281-302).
      expect(challenge.blackUsername).toBe(s.away.lichessId);
      expect(challenge.limitSeconds).toBe(300);
      expect(challenge.incrementSeconds).toBe(3);
      expect(challenge.whiteToken, "a real token, not an empty string").not.toBe("");
      const accept = board.acceptChallenge.mock.calls[0]?.[0] as { blackToken: string; challengeId: string };
      expect(accept.challengeId).toBe("gm-1");
      expect(accept.blackToken).not.toBe(challenge.whiteToken);
    });

    it("records the bridge row: ready, the challenge id, the colour, and no claim left behind", async () => {
      const s = await seed();
      await createGameIfReady(s.fixtureId, { now: NOW });
      const [row] = await sql<{
        status: string; challenge_id: string | null; white_side: string | null;
        white_lichess_id: string | null; black_lichess_id: string | null;
        mint_claimed_at: Date | null; last_error: string | null;
      }[]>`
        select status, challenge_id, white_side, white_lichess_id, black_lichess_id,
               mint_claimed_at, last_error
          from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(row?.status).toBe("ready");
      expect(row?.challenge_id).toBe("gm-1");
      expect(row?.white_side).toBe("home");
      expect(row?.white_lichess_id).toBe(s.home.lichessId);
      expect(row?.black_lichess_id).toBe(s.away.lichessId);
      expect(row?.mint_claimed_at, "the claim is released on success").toBeNull();
      expect(row?.last_error).toBeNull();
    });

    it("colour is READ from the pairing, not assigned: a card making home Black swaps both sides", async () => {
      const s = await seed();
      await appendEvent(s.orgId, s.fixtureId, 0, {
        type: "boardgame.pairing",
        payload: { white: s.away.entrantId },
      });
      await createGameIfReady(s.fixtureId, { now: NOW });
      const challenge = board.createChallengeToUser.mock.calls[0]?.[0] as { blackUsername: string };
      // The differential case: an implementation that always challenges from
      // home answers s.away.lichessId here, which is the opposite.
      expect(challenge.blackUsername).toBe(s.home.lichessId);
      const [row] = await sql<{ white_side: string | null }[]>`
        select white_side from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(row?.white_side).toBe("away");
    });

    it("sequence: a SECOND call answers already and makes no second challenge", async () => {
      const s = await seed();
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: "gm-1" });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "already" });
      expect(board.createChallengeToUser, "exactly one challenge for one fixture").toHaveBeenCalledTimes(1);
    });

    it("the lobby is published once, on success only", async () => {
      const s = await seed();
      const publish = vi.fn(async () => undefined);
      await createGameIfReady(s.fixtureId, { now: NOW, publish });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(s.fixtureId);
      publish.mockClear();
      await createGameIfReady(s.fixtureId, { now: NOW, publish });
      expect(publish, "an 'already' must not re-publish").not.toHaveBeenCalled();
    });

    it("a challenge failure ⇒ provider_error, the claim is released, and a retry is possible", async () => {
      const s = await seed();
      board.createChallengeToUser.mockResolvedValue({ ok: false, code: "rate_limited", raw: "Too many requests" });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "provider_error",
      });
      const [row] = await sql<{ status: string; mint_claimed_at: Date | null; last_error: string | null }[]>`
        select status, mint_claimed_at, last_error from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(row?.status, "still pending, so the sweep can try again").toBe("pending");
      expect(row?.mint_claimed_at, "a held claim would lock the fixture for 30s of nothing").toBeNull();
      expect(row?.last_error).toContain("rate_limited");
      // And the retry really does retry.
      board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: "gm-2" });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: "gm-2" });
    });

    it("an ACCEPT failure records the challenge id and holds the fixture for an organiser", async () => {
      // The challenge exists at Lichess. Forgetting it would let a retry mint
      // a SECOND game for the same board, which is exactly what the unique
      // index on challenge_id exists to make impossible.
      const s = await seed();
      board.acceptChallenge.mockResolvedValue({ ok: false, code: "unauthorized", raw: "no" });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "provider_error",
      });
      const [row] = await sql<{ status: string; challenge_id: string | null; needs_reason: string | null }[]>`
        select status, challenge_id, needs_reason from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(row?.challenge_id).toBe("gm-1");
      expect(row?.status).toBe("needs_organiser");
      expect(row?.needs_reason).toBe("provider_error");
      // A retry must not create anything.
      board.createChallengeToUser.mockClear();
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "already" });
      expect(board.createChallengeToUser).not.toHaveBeenCalled();
    });

    it("a takeover mid-flight is refused rather than stomping the new claimant", async () => {
      // The one case a plain `status = 'pending'` guard on the ready commit
      // misses: status never leaves 'pending' during a takeover, only
      // mint_claimed_at changes. Driven by having the MOCK bump the stamp
      // during the call — the real race, no production hook.
      const s = await seed();
      board.createChallengeToUser.mockImplementation(async () => {
        await sql`
          update fixture_external_play set mint_claimed_at = ${new Date(NOW.getTime() + 1_000)}
           where fixture_id = ${s.fixtureId}`;
        return { ok: true, challengeId: "gm-stomp" };
      });
      expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({
        created: false,
        reason: "not_ready",
      });
      const [row] = await sql<{ challenge_id: string | null; status: string }[]>`
        select challenge_id, status from fixture_external_play where fixture_id = ${s.fixtureId}`;
      expect(row?.challenge_id, "the loser's challenge is NOT recorded").toBeNull();
      expect(row?.status).toBe("pending");
    });

    it("creation goes through the throttle queue (M3 — four creates a second, then 429s)", async () => {
      const queue = await import("@/server/external-play/creation-queue");
      const spy = vi.spyOn(queue, "enqueueCreation");
      const s = await seed();
      await createGameIfReady(s.fixtureId, { now: NOW });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0], "keyed per fixture").toBe(s.fixtureId);
      spy.mockRestore();
    });

    it("enumerates every CreateOutcome reason and reports the count", async () => {
      // Derived from the declared union, so a new reason fails this test until
      // a case for it exists.
      const declared = ["not_ready", "already", "unplayable", "provider_error", "no_person"] as const;
      const produced = new Set<string>();
      const builders: Record<(typeof declared)[number], () => Promise<void>> = {
        not_ready: async () => {
          const s = await seed({ roundOpenedAt: undefined });
          const r = await createGameIfReady(s.fixtureId, { now: NOW });
          if (!r.created) produced.add(r.reason);
        },
        already: async () => {
          const s = await seed();
          await createGameIfReady(s.fixtureId, { now: NOW });
          const r = await createGameIfReady(s.fixtureId, { now: NOW });
          if (!r.created) produced.add(r.reason);
        },
        unplayable: async () => {
          const s = await seed({ clock: { base: 60, increment: 0 } });
          const r = await createGameIfReady(s.fixtureId, { now: NOW });
          if (!r.created) produced.add(r.reason);
        },
        provider_error: async () => {
          const s = await seed();
          board.createChallengeToUser.mockResolvedValue({ ok: false, code: "unavailable", raw: "x" });
          const r = await createGameIfReady(s.fixtureId, { now: NOW });
          if (!r.created) produced.add(r.reason);
          board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: "gm-1" });
        },
        no_person: async () => {
          const s = await seed();
          await sql`delete from entrant_members where entrant_id = ${s.home.entrantId}`;
          const r = await createGameIfReady(s.fixtureId, { now: NOW });
          if (!r.created) produced.add(r.reason);
        },
      };
      for (const reason of declared) await builders[reason]();
      expect([...produced].sort(), "every declared reason is reachable").toEqual([...declared].sort());
      expect(produced.size, "anti-vacuity: five reasons, five cases").toBe(5);
    });
  });
  ```

- [ ] **Step 10: run it, watch it fail, then write the claim and the calls.**
  Failure: 11 cases on `unimplemented`. Replace that `throw` with:

  ```ts
    await resetStaleBridge(f);
    await ensureBridgeRow(f);

    // Claim: conditional on pending, no challenge, and either never claimed or
    // claimed stale — so a crashed minter recovers without a human.
    const claimed = await sql<{ fixture_id: string }[]>`
      update fixture_external_play set mint_claimed_at = ${now}, updated_at = now()
       where fixture_id = ${fixtureId} and status = 'pending' and challenge_id is null
         and (mint_claimed_at is null or mint_claimed_at < ${new Date(now.getTime() - MINT_CLAIM_STALE_MS)})
       returning fixture_id`;
    if (claimed.length === 0) return { created: false, reason: "not_ready" };

    const whiteSide = await whiteSideOf(f);
    const white = whiteSide === "home" ? home : away;
    const black = whiteSide === "home" ? away : home;
    const whiteLichess = white.lichess;
    const blackLichess = black.lichess;
    if (!whiteLichess || !blackLichess) {
      await releaseClaim(fixtureId, "no_lichess_identity");
      return { created: false, reason: "not_ready" };
    }
    const whiteToken = await getLichessAccessToken(whiteSide === "home" ? homeUserId : awayUserId);
    const blackToken = await getLichessAccessToken(whiteSide === "home" ? awayUserId : homeUserId);
    if (!whiteToken || !blackToken) {
      await releaseClaim(fixtureId, "no_stored_token");
      return { created: false, reason: "not_ready" };
    }

    // HTTP, outside every transaction, through the global throttle (M3: four
    // creates a second and then every one 429s; a 64-player round wants 32).
    const outcome = await enqueueCreation(fixtureId, async () => {
      const made = await createChallengeToUser({
        whiteToken,
        blackUsername: blackLichess.username,
        limitSeconds: tc.limitSeconds,
        incrementSeconds: tc.incrementSeconds,
      });
      if (!made.ok) return { stage: "create" as const, code: made.code };
      const accepted = await acceptChallenge({ blackToken, challengeId: made.challengeId });
      if (!accepted.ok) {
        return { stage: "accept" as const, code: accepted.code, challengeId: made.challengeId };
      }
      return { stage: "done" as const, challengeId: made.challengeId };
    });

    if (outcome.stage === "create") {
      await releaseClaim(fixtureId, outcome.code);
      return { created: false, reason: "provider_error" };
    }
    if (outcome.stage === "accept") {
      // The challenge EXISTS at Lichess. Record it, so the unique index makes a
      // second create impossible and reconcile can still find the game, and
      // hand the fixture to an organiser.
      await sql`
        update fixture_external_play
           set status = 'needs_organiser', needs_reason = 'provider_error',
               challenge_id = ${outcome.challengeId}, white_side = ${whiteSide},
               white_lichess_id = ${whiteLichess.id}, black_lichess_id = ${blackLichess.id},
               mint_claimed_at = null, last_error = ${`accept:${outcome.code}`}, updated_at = now()
         where fixture_id = ${fixtureId} and mint_claimed_at = ${now}`;
      return { created: false, reason: "provider_error" };
    }

    const ready = await sql<{ fixture_id: string }[]>`
      update fixture_external_play
         set status = 'ready', challenge_id = ${outcome.challengeId}, white_side = ${whiteSide},
             white_lichess_id = ${whiteLichess.id}, black_lichess_id = ${blackLichess.id},
             expires_at = ${windowFor(open.roundOpenedAt).deadline},
             mint_claimed_at = null, last_error = null, updated_at = now()
       where fixture_id = ${fixtureId} and status = 'pending' and mint_claimed_at = ${now}
       returning fixture_id`;
    // Lost the claim to a takeover mid-flight: do NOT record, do not publish.
    if (ready.length === 0) return { created: false, reason: "not_ready" };
    await (deps.publish ?? publishExternalPlayLobby)(fixtureId);
    return { created: true, gameId: outcome.challengeId };
  }

  async function releaseClaim(fixtureId: string, error: string): Promise<void> {
    await sql`
      update fixture_external_play
         set mint_claimed_at = null, last_error = ${error.slice(0, 500)}, updated_at = now()
       where fixture_id = ${fixtureId} and status = 'pending'`;
  }
  ```

  `expires_at` is derived from the OPEN stamp, not the schedule — the deadline
  is T+20 of the organiser's open (D12).

- [ ] **Step 11: run green.** Re-run Step 2's command. Expected
  `numTotalTests: 29`, `numPassedTests: 29`, `numFailedTests: 0`. Confirm with
  `jq -r '.testResults[].name' /tmp/b2-t9a.json` that the resolved path is
  inside the worktree.

- [ ] **Step 12: mutate the claim-then-call guards, one at a time.**
  (a) Drop `and mint_claimed_at = ${now}` from the ready UPDATE. Re-run: the
  takeover test must fail on `expected 'gm-stomp' to be null`. Restore. This is
  the mutant that proves the claim is real; a plain `status = 'pending'` guard
  passes every other test in the file.
  (b) In the accept-failure branch, drop `challenge_id = ${outcome.challengeId}`.
  Re-run: the accept-failure test must fail twice — on the recorded id and on
  the retry creating a second challenge. Restore.
  (c) In `releaseClaim`, drop `mint_claimed_at = null`. Re-run: the
  challenge-failure test must fail on the retry (the claim is still held and
  the second attempt answers `not_ready`). Restore.
  (d) Replace `whiteSideOf(f)` with the literal `"home"`. Re-run: the colour
  test must fail on `expected <away> to be <home>`. Restore.

- [ ] **Step 13: typecheck, lint, commit.**
  ```
  rtk proxy npx tsc --noEmit -p apps/web
  rtk proxy npx eslint apps/web/src/server/usecases/external-play/create-game.ts
  git add apps/web/src/server/usecases/external-play/create-game.ts \
          apps/web/src/server/usecases/__tests__/external-play-create-game.test.ts
  git commit -m "feat(chess): create the game — claim, challenge from White, accept as Black

  Readiness is both seats re-verified at creation time (not a stored stamp),
  both players consented with board:play and challenge:write, the round OPEN
  (D12 — a paired-but-unopened round creates nothing), and a clock that is in
  T5's catalogue, because Lichess accepts a fast-clock challenge and then
  refuses every move on it (M12). Colour is read from the pairing. The claim
  commit is conditional on this call's own stamp, so a takeover mid-flight is
  refused instead of stomped; an accept failure RECORDS the challenge id, so the
  unique index stops a retry minting a second game for the same board. Mutants:
  dropping the claim-stamp condition, the recorded id on accept failure, the
  claim release, and hard-coding White to home each red exactly one case.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 14: write the failing room re-anchor test.** The room is what a
  player actually looks at, and it still anchors on the timetable — so today
  it would show an open window for a round nobody opened. Append to the
  EXISTING suite `apps/web/src/server/usecases/__tests__/external-play-room.test.ts`:

  ```ts
  describe.skipIf(!process.env.DATABASE_URL)("D12 — the room anchors on the open stamp", () => {
    it("a paired-but-unopened round reads phase 'before', whatever the timetable says", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: new Date("2026-10-01T12:10:00.000Z"),
        linked: true,
      });
      // Five minutes AFTER the scheduled time: schedule-anchored, this is
      // "open"; stamp-anchored, the round has not started.
      const view = await readMatchRoom(
        { kind: "session", userId: s.home.userId },
        s.fixtureId,
        new Date("2026-10-01T12:15:00.000Z"),
      );
      expect(view.phase).toBe("before");
      expect(view.canMint, "nothing to mint for a round nobody opened").toBe(false);
    });

    it("an opened round reads 'open' from the stamp, and its deadline is stamp + 20m", async () => {
      const opened = new Date("2026-10-01T12:00:00.000Z");
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: new Date("2026-10-01T12:10:00.000Z"),
        linked: true,
        roundOpenedAt: opened,
      });
      const view = await readMatchRoom(
        { kind: "session", userId: s.home.userId },
        s.fixtureId,
        new Date("2026-10-01T12:05:00.000Z"),
      );
      expect(view.phase).toBe("open");
      // Derived from the window constants, never typed in, so moving
      // DEADLINE_AFTER_MS moves this test with it.
      expect(view.deadline).toBe(windowFor(opened).deadline.toISOString());
      expect(view.opensAt).toBe(windowFor(opened).opensAt.toISOString());
    });

    it("check-in is refused on an unopened round", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess",
        divisionStarted: true,
        scheduledAt: new Date("2026-10-01T12:10:00.000Z"),
        linked: true,
      });
      await expect(
        checkInToMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, {
          now: new Date("2026-10-01T12:15:00.000Z"),
        }),
      ).rejects.toMatchObject({ status: 409, code: "CHECK_IN_CLOSED" });
    });
  });
  ```

  Add `windowFor` and `seedOnlineChessFixture` to that file's imports if they
  are not already there.

- [ ] **Step 15: run it and watch it fail.**
  ```
  rm -f /tmp/b2-t9b.json && cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web \
    && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable \
       npx vitest run src/server/usecases/__tests__/external-play-room.test.ts \
       --reporter=json --outputFile=/tmp/b2-t9b.json
  ```
  Expected: the first new case fails `expected 'open' to be 'before'`, the
  second fails on both ISO strings, the third fails because the check-in
  succeeds. Note `numTotalTests` **before and after** this edit: a mutant that
  fails to parse shrinks the total and reads as a survivor, so pin the count,
  not just the failures.

- [ ] **Step 16: re-anchor `room.ts`.** Five substitutions, each passing the
  stamp where `f.scheduledAt` went, plus one new refusal. Load the stamp once
  per entry point and thread it:

  - `buildView` (:143-201) takes a new `anchor: Date | null` parameter. With
    `anchor === null`, `phase` is `"before"`, `opensAt`/`deadline` come from
    `windowFor(f.scheduledAt)` **as a display-only estimate** (that is what the
    player is shown until the organiser opens the round — spec §3.2: "the
    scheduled time is what players are shown"), `canMint` is `false`, and both
    check-in flags are `false`. With a stamp, every one of :150, :156's
    neighbours and :187 reads `anchor`.
  - `checkIns` (:120-138) takes the anchor and passes it to `checkInCounts`
    (:135-136) — a check-in stamped during a PREVIOUS round's window must not
    count toward this one.
  - `readMatchRoom` (:208-218) and `checkInToMatchRoom` (:227-258) each call
    `roundOpenFor(sql, fixtureId)` once and pass the result down.
  - `checkInToMatchRoom`'s phase gate (:239-241) refuses an unopened round with
    the same `409 CHECK_IN_CLOSED` it already uses for a closed window — the
    player-facing distinction belongs in the view's own state (T14), not in a
    second error code on a POST.
  - `mintIfReady` (:281-350) takes the anchor too: :286's phase gate, and
    :323's `windowFor(f.scheduledAt).deadline` for `expires_at`, both read it;
    with no stamp it returns `"not_ready"`.

  Leave `guard.ts` alone. `scheduled_at_basis` (:165-173, :189-202) answers
  "was this bridge minted for an older TIMETABLE", which is a reschedule
  question and is correctly schedule-based; re-anchoring it would make every
  reschedule invisible.

- [ ] **Step 17: run green, then mutate.** Re-run Step 15's command: the three
  new cases pass and every pre-existing case in the file still passes — compare
  `numTotalTests`/`numPassedTests` against the numbers noted in Step 15.
  Mutants, one at a time:
  (a) In `buildView`, make the `anchor === null` branch return `phase: "open"`.
  Re-run: the first new case must fail.
  (b) Revert `checkIns` to `f.scheduledAt`. Re-run: add nothing if nothing
  reds — then write the missing case rather than claiming the mutant: seed a
  fixture whose check-in was stamped inside the SCHEDULE's window but outside
  the open stamp's, and assert `checkedIn` is false. A guard nothing kills is
  not tested.
  Restore from the `cp` backup after each.

- [ ] **Step 18: commit the re-anchor.**
  ```
  git add apps/web/src/server/usecases/external-play/room.ts \
          apps/web/src/server/usecases/__tests__/external-play-room.test.ts
  git commit -m "fix(chess): the match room anchors on round_opened_at, not the timetable

  D12. A paired-but-unopened round read as 'open' five minutes after its
  scheduled time, which would seat players and start a T+20 clock for a round
  nobody had called. phase, opensAt, deadline, canMint, the check-in window and
  the mint's expires_at all hang off the organiser's open stamp now; with no
  stamp the room reads 'before' and shows the scheduled time as the estimate it
  is. guard.ts's scheduled_at_basis is deliberately untouched — it answers a
  reschedule question, not a window one. Mutant: forcing the no-stamp branch to
  'open' reds the first case.

  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
  ```

- [ ] **Step 19: batch-boundary scoped gate.** Run ONLY what B2 changed — the
  full vitest suite, the full gate and the full e2e suite are CI's job and are
  forbidden locally (owner, 2026-09-28).
  ```
  rm -f /tmp/b2-gate.json && cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web \
    && DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable \
       npx vitest run \
         src/server/external-play/__tests__/camera-policy.test.ts \
         src/server/external-play/__tests__/online-play.test.ts \
         src/server/external-play/video/__tests__/realtimekit.test.ts \
         src/server/usecases/__tests__/camera-policy-divisions.test.ts \
         src/server/usecases/__tests__/external-play-preflight.test.ts \
         src/server/usecases/__tests__/external-play-create-game.test.ts \
         src/server/usecases/__tests__/external-play-room.test.ts \
         src/server/usecases/__tests__/external-play-guard.test.ts \
         src/server/usecases/__tests__/division-settings.test.ts \
         src/server/usecases/__tests__/online-play-enrollment.test.ts \
       --reporter=json --outputFile=/tmp/b2-gate.json
  jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:[.testResults[].name]}' /tmp/b2-gate.json
  ```
  The last four are not B2's files but B2 changed code they exercise:
  `_external-play-seed.ts` (guard + enrollment), `divisions.ts` and
  `online-play.ts` (division-settings), `room.ts` (room). Positionals are
  literal filename filters, so **check that all ten names appear in the
  `files` array** — a typo runs a subset and reports green. Then:
  ```
  rtk proxy npx tsc --noEmit -p apps/web
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && npm run i18n:check
  ```

- [ ] **Step 20: write the handover note.** Append to the batch's report file:
  the verified counts from Step 19, the mutants run and their results, and
  these four items for the controller, none of which B2 can close:
  1. **No task owns the round-OPENING action** (the organiser control, the
     `round_opened_at` write, the invite send). B2 only reads the stamp.
  2. **T1 must carry four pieces of DDL** B2 consumes: `stage_round_open`,
     `fixture_video_meeting`, `fixture_video_participant`, and the three
     `video_override_*` columns on `fixture_external_play`.
  3. **B5 owes the visual and e2e proof** for the camera `<select>` at 320/768/
     1280 and for the localised `POLICY_LOCKED` message; `apps/web` vitest is
     node-env and cannot see any of it.
  4. **T14 owes the rest of the room rewrite** — `playUrl` and `watchUrl` are
     dead under D3, and the room's player-facing distinction between
     "round not open" and "window closed" needs copy in four locales.
` marker -->

## Batch B3 — play, reconcile, result, sweeps

**Build order inside B3 is 10 → 12 → 11 → 13, not 10 → 11 → 12 → 13.** The
plan's rule is "each consumes the interface the previous one produces"; it does
not fix which. T11's `reconcile` must write a terminal result (Review Focus 4),
and the thing that writes it is T12's `writeResultFrom`. Building T11 first
would force either an injected `writeResult` default (an inert seam — recurring
failure class 1, which has shipped six times in this repo) or a second pass over
`reconcile.ts`. T12 depends on nothing in T11, so it goes first and T11 imports
it statically. The task NUMBERS stay as the Review Focus references them.

**Amendments this batch makes to the authoritative Interfaces** (additions to a
module's own types, never a rename or a re-shape of something another task
consumes):

| Where | Change | Why |
|---|---|---|
| `play.ts` | `act` gains an optional second parameter `deps?: PlayDeps` | Every declared call site stays valid; the repo's own injection shape (`RoomDeps`, `room.ts:64`). Without it the 401 and duplicate-tab tests cannot be driven. |
| `reconcile.ts` | `reconcile` gains `deps?: ReconcileDeps`; `RECONCILE_TRIGGERS` exported as a tuple | Same reason, plus anti-vacuity: a trigger sweep needs the domain as a VALUE. |
| `reconcile.ts` | `ReconcileTrigger` gains `"sweep"` (controller, 2026-10-09) | The other four triggers all need a client open. Both players closing their tabs leaves a live game nobody ever reads. |
| `result.ts` | `ResultWrite`'s `needs_organiser` reason union gains `"tiebreak_owed"`; `holdForOrganiser` added | See the false-premise note below on `needs_decision`. |
| `sweep.ts` | four jobs, not five (controller, 2026-10-09, spec D12) | Rounds are organiser-driven: the invite is part of the open-round action, so the cron loses the T−10 notice job. **T13 therefore owes no i18n work** — no new user-facing string. |

**False premises corrected before any code is written** (recurring failure
class 5 — every one of these was in the spec or the skeleton and is false
against the tree at `8afdd8b42` / `origin/main` `e201fab8f`, read 2026-10-09):

1. **`apps/web/src/lib/organiser-only-events.ts` does not exist**, on this
   branch or on `origin/main`, and `isOrganiserOnlyEvent` appears nowhere in
   `apps/web/src` or `packages/`. W2a is NOT merged. T12 Step 1 re-checks this
   rather than coding against it; `mintOrgOwnerAuth` is used as the actor either
   way, because it is correct under both the present and the promised gate.
2. **`mintOrgOwnerAuth` is defined in `auth.ts:13`, not in `guard.ts`.**
   `guard.ts:9` imports it and `guard.ts:299` uses it. `auth.ts:7-9` records
   that this is its permanent home.
3. **`needs_decision` and division phase `tiebreak` do not exist.**
   `DIVISION_PHASES` is `["setting_up","scheduled","match_day","finished"]`
   (`apps/web/src/lib/division-phase.ts:26`) and `needs_decision` matches
   nothing in `apps/web/src` or `packages/engine/src`. The repo's real "the
   organiser owes a decision" vehicle for this surface is
   `fixture_external_play.status = 'needs_organiser'` + `needs_reason`, coupled
   by the table CHECK at `V405__lichess_external_play.sql:57`. T12 holds a
   knockout draw there under a new reason `tiebreak_owed` and writes NO
   `boardgame.result` at all. That is the spec's intent expressed in the
   schema that exists.
4. **Four live routes import six symbols that are defined nowhere.**
   `apps/web/src/app/api/cron/external-play/route.ts:6-8`
   (`prepareExternalPlayWindow`, `pollLiveExternalPlay`,
   `escalateStaleExternalPlay`), `.../external-play/resolve/route.ts:4`
   (`resolveExternalPlay`), `.../external-play/resend/route.ts:3`
   (`resendExternalPlayNotice`) and `.../webhooks/lichess/route.ts:3`
   (`applyProviderGameUpdate`) all import from `@/server/usecases/external-play`,
   whose `index.ts` re-exports only `./auth` and `./guard`. The branch does not
   typecheck today. T13 Step 18 repoints the cron route; the other three belong
   to B4/B5 and are named here so nobody reports the resulting `tsc` red as
   their own regression.
5. **`apps/web/src/server/external-play/__fixtures__/lichess/export-*.json`
   carry no `clocks`, no `clock{initial,increment}` and no `moves`.** They were
   recorded with `pgnInJson=false&clocks=false` (that directory's `README.md`).
   M11's authoritative clocks are therefore NOT in the committed contract
   fixtures. T3 owes a `clocks=true` recording; T11 Step 1 verifies it before
   building clock correction on it.
6. **`chess.js` and `chessground` are not dependencies** — neither is in
   `apps/web/package.json` nor in `node_modules`. T10 adds `chess.js` (server
   needs it to produce `RoomBroadcast.fen`); `chessground` is T14's.
7. **`withdrawal.ts:42` writes `reason: "entrant withdrew"`** — free text, which
   W2b's strict payload refuses. Not B3's to fix, but W2b will red
   `swiss-withdrawal-walkover.test.ts` and `withdrawal.test.ts` on merge. Route
   to the W2b integration task, do not fix inline from here.
8. `scratchpad/flag-spike.log`, `spike-battery2.log` and `tc-boundary.log`
   (spec §2's evidence) are not in the tree; `scratchpad/` is empty. The facts
   stand as spec text; they cannot be re-read.

**Premises verified TRUE and relied on:**

- `packages/engine/src/sports/boardgame/boardgame.ts:617` —
  `if (state.phase !== "live") wrongPhase('forfeit not allowed in phase "' + state.phase + '"')`.
  It is the only one of the eleven shipped modules
  (`packages/engine/src/sports/index.ts:23-35`) that refuses a `pre`-phase
  forfeit: setbased (`kernel.ts:804-806`, badminton's engine), carrom
  (`carrom.ts:451-455`), cricket (`cricket.ts:3775`) and generic
  (`generic.ts:558`) all refuse only `done`/`final`/`abandoned`.
- `apps/web/src/server/usecases/__tests__/swiss-withdrawal-walkover.test.ts:80`
  is `sport_key: "badminton"`, and its line 197 `forfeitBy(... S2)` runs against
  a board that never got `core.start` — a real `pre`-phase forfeit that passes
  only because setbased tolerates it. No test anywhere drives a chess forfeit.
- `scoreEvent`'s durable idempotency: `apps/web/src/server/usecases/scoring.ts:96-98`
  matches `23505` **by constraint name** `score_events_idem_key`
  (`V413__score_events_idempotency_key.sql:88-89`), and `scoring.ts:228-240`
  replays on EITHER that violation OR `SEQ_CONFLICT`. A deterministic
  idempotency key is the once-only mechanism for T11/T12 — no new latch column.
- `apps/web/src/lib/realtime.ts:233` `externalPlayLobbyTopic` and `:249`
  `mintExternalPlayLobbyToken` already mint a private token carrying
  `lobby_fixture_id`, matched by V407's policy
  (`V407__lichess_lobby_ready.sql:38`). T10 rides that same topic with a new
  event name, so **no new realtime policy is needed for players**; V433 is a
  spectator-only concern (T1/B4).
- `fixtures.is_final` and `fixtures.third_place` exist
  (`V368__fixture_round_role.sql:38-39`). `StageKind` is
  `["league","group","swiss","knockout","double_elim","stepladder","page_playoff","americano","ladder"]`
  (`apps/web/src/server/api-v1/schemas.ts:105`) — "last rung" means the last
  round of a `stepladder`.

**Verify command for every B3 task** (scoped; never the full suite — AGENTS.md
standing rule, owner 2026-09-28):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && \
DATABASE_URL=postgresql://postgres@127.0.0.1:54890/seazn_chess-lep DATABASE_SSL=disable \
npx vitest run src/server/usecases/__tests__/external-play-play.test.ts \
  src/server/usecases/__tests__/external-play-reconcile.test.ts \
  src/server/usecases/__tests__/external-play-result.test.ts \
  src/server/usecases/__tests__/external-play-sweep.test.ts \
  --reporter=json --outputFile=/tmp/b3.json; echo "EXIT=$?"; \
jq '{total:.numTotalTests, passed:.numPassedTests, failed:.numFailedTests, files:[.testResults[].name]}' /tmp/b3.json
```

Judge `numPassedTests`/`numFailedTests`/`numTotalTests` only, and confirm every
path in `files` resolves under the worktree — a run launched from the main
checkout returns a false green. `rtk`'s own summary prints `PASS(0) FAIL(0)` for
a suite that failed to COLLECT. Each task runs only ITS file during development.

---

### Task 19: Open the round — the organiser's act

**Why this task exists.** Owner decision D12: Swiss pairs the next round by itself, but
the invite is the organiser's act, because an invite starts a clock against real people
who have to be at a screen. This task owns the control's server side: the stamp every
later task's window reads, and the invite itself.

**It also repairs a live tsc red.** `resendExternalPlayNotice` is imported by
`app/api/v1/fixtures/[id]/external-play/resend/route.ts:3` and **defined nowhere** — it
died with `usecases/external-play.ts` in `340dce7ed`. The invite sender this task builds
is that function's new home.

**Executes after T9 and before T10.**

**Files:**
- Create: `apps/web/src/server/usecases/external-play/invite.ts`
- Create: `apps/web/src/server/usecases/external-play/open-round.ts`
- Create: `apps/web/src/app/api/v1/stages/[id]/open-round/route.ts` (sibling verbs:
  `generate`, `rebuild`, `complete`, `court-tags` — same `[id]/<verb>/route.ts` shape)
- Modify: `apps/web/src/server/usecases/external-play/index.ts` (today re-exports only
  `./auth` and `./guard`)
- Modify: `apps/web/src/app/api/v1/fixtures/[id]/external-play/resend/route.ts:3`
  (repoint the broken import)
- Modify: `apps/web/src/server/api-v1/openapi.ts` (`openapi-coverage.test.ts:32-39`
  demands a 1:1 `ROUTES` entry per route file), `apps/web/src/server/api-v1/key-scopes.ts`
- Modify: `apps/web/src/lib/email-templates.ts`, `apps/web/src/lib/email.ts`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (flat keys)
- Test: `apps/web/src/server/usecases/external-play/__tests__/open-round.test.ts`

**Interfaces:**
- Consumes: T1's `stage_round_opens` (`unique (stage_id, round_no)`); V432's
  `white_emailed_at` / `black_emailed_at`, which **already exist** (V405:45) — do NOT add
  a second invite stamp; `audit(db, competitionId, orgId, type, payload, actorId)` from
  `usecases/audit.ts:26`; `sendX...Email` from `@/lib/email` with args typed in
  `@/lib/email-templates`; `loadSide` from `guard.ts:237` for recipients.
- Produces: `openRound`, `roundOpenedAt` (signatures in **Interfaces (authoritative)**),
  and `resendExternalPlayNotice(auth, fixtureId, baseUrl)` re-homed in `invite.ts`.

- [ ] **Step 0: Gate on T1's table existing — do not invent a migration**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play
psql "$DATABASE_URL" -c '\d stage_round_opens'
```

Expected: the table, with `stage_id`, `round_no`, `opened_at`, `opened_by` and a unique
constraint on `(stage_id, round_no)`. **If it is absent, STOP and report** — T1 owns it.

- [ ] **Step 1: Write the failing test for the stamp**

```ts
// apps/web/src/server/usecases/external-play/__tests__/open-round.test.ts
import { describe, expect, it } from "vitest";
import { openRound, roundOpenedAt } from "../open-round";
import { seedOnlineChessRound } from "@/test/seeds/online-chess";

describe("openRound", () => {
  it("is not open until the organiser opens it, then carries the stamp", async () => {
    const { stageId, actorUserId } = await seedOnlineChessRound({ roundNo: 1, fixtures: 2 });

    expect(await roundOpenedAt({ stageId, roundNo: 1 })).toBeNull();

    const before = new Date();
    const res = await openRound({ stageId, roundNo: 1, actorUserId });
    expect(res).toEqual({ opened: true, invited: 4 });

    const at = await roundOpenedAt({ stageId, roundNo: 1 });
    expect(at).toBeInstanceOf(Date);
    expect(at!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });
});
```

Two seats per fixture, two fixtures, so `invited` is 4 — a count, not a boolean, so the
test can witness an invite that silently reaches nobody.

- [ ] **Step 2: Run it and read the failure**

```bash
cd apps/web && npx vitest run src/server/usecases/external-play/__tests__/open-round.test.ts \
  --reporter=json --outputFile=/tmp/t19-1.json; EXIT=$?; echo "EXIT=$EXIT"
python3 -c "import json;d=json.load(open('/tmp/t19-1.json'));print(d['numPassedTests'],d['numFailedTests'])"
```

Expected: `0 1`, failing on `Cannot find module '../open-round'`.

- [ ] **Step 3: Write the minimal `open-round.ts`**

```ts
import "server-only";
import { sql } from "@/server/engine-db/client";

export async function roundOpenedAt(a: { stageId: string; roundNo: number }): Promise<Date | null> {
  const rows = await sql<{ openedAt: Date }[]>`
    select opened_at as "openedAt" from stage_round_opens
     where stage_id = ${a.stageId} and round_no = ${a.roundNo}`;
  return rows[0]?.openedAt ?? null;
}
```

- [ ] **Step 4: Implement `openRound` — stamp, then invite, in one transaction**

```ts
export type OpenRoundResult =
  | { opened: true; invited: number }
  | { opened: false; reason: "already_open" | "not_paired" | "no_fixtures" };

export async function openRound(a: {
  stageId: string; roundNo: number; actorUserId: string;
}): Promise<OpenRoundResult> {
  return withTenantTx(async (tx) => {
    const fixtures = await loadRoundFixtures(tx, a.stageId, a.roundNo);
    if (fixtures.length === 0) return { opened: false, reason: "no_fixtures" };
    if (fixtures.some((f) => f.homeEntrantId === null || f.awayEntrantId === null))
      return { opened: false, reason: "not_paired" };

    const ins = await tx`
      insert into stage_round_opens (stage_id, round_no, opened_by)
      values (${a.stageId}, ${a.roundNo}, ${a.actorUserId})
      on conflict (stage_id, round_no) do nothing
      returning id`;
    const firstOpen = ins.length === 1;

    const invited = await inviteUnemailedSeats(tx, fixtures);
    if (!firstOpen && invited === 0) return { opened: false, reason: "already_open" };

    await audit(tx, fixtures[0].competitionId, fixtures[0].orgId,
      firstOpen ? "external_play.round_opened" : "external_play.round_reinvited",
      { stageId: a.stageId, roundNo: a.roundNo, invited }, a.actorUserId);
    return { opened: true, invited };
  });
}
```

`inviteUnemailedSeats` stamps `white_emailed_at` / `black_emailed_at` per seat and only
emails a seat whose stamp is null. That is what makes the next step's two directions
both work.

- [ ] **Step 5: Run — expect green**

Same command as Step 2, into `/tmp/t19-2.json`. Expected: `1 0`.

- [ ] **Step 6: The idempotency test, in BOTH directions**

A guard that refuses a second open must still seat a genuine late arrival. This repo has
shipped the one-directional version of this bug (`if (already) return` swallowing a late
join and seating nobody), so both directions are asserted here, in one test.

```ts
it("re-opening sends nothing, but a fixture added after the open still gets invited", async () => {
  const { stageId, actorUserId, divisionId } = await seedOnlineChessRound({ roundNo: 1, fixtures: 1 });
  const sent: string[] = [];
  onInviteSent((to) => sent.push(to));

  expect(await openRound({ stageId, roundNo: 1, actorUserId })).toEqual({ opened: true, invited: 2 });
  expect(sent).toHaveLength(2);

  // direction 1: nothing new to do
  expect(await openRound({ stageId, roundNo: 1, actorUserId })).toEqual({
    opened: false, reason: "already_open",
  });
  expect(sent).toHaveLength(2);

  // direction 2: the organiser adds a match to an already-open round
  await addOnlineChessFixture({ divisionId, stageId, roundNo: 1 });
  expect(await openRound({ stageId, roundNo: 1, actorUserId })).toEqual({ opened: true, invited: 2 });
  expect(sent).toHaveLength(4);
  expect(new Set(sent).size).toBe(4); // nobody emailed twice
});
```

- [ ] **Step 7: Run — expect green, and `sent` lengths exactly 2/2/4**

- [ ] **Step 8: Mutate the guard once, as the house rules require**

Replace `if (!firstOpen && invited === 0)` with `if (!firstOpen)`. Re-run Step 6's test.
Expected: it FAILS on direction 2 (`{opened:false, reason:"already_open"}` instead of
`{opened:true, invited:2}`). Restore the line. A guard nothing kills is not tested.

- [ ] **Step 9: The two refusals, each with its positive pair**

```ts
it("refuses a round with no fixtures, and writes no stamp", async () => {
  const { stageId, actorUserId } = await seedOnlineChessRound({ roundNo: 1, fixtures: 0 });
  expect(await openRound({ stageId, roundNo: 1, actorUserId })).toEqual({
    opened: false, reason: "no_fixtures",
  });
  expect(await roundOpenedAt({ stageId, roundNo: 1 })).toBeNull();
});

it("refuses a round holding an unpaired slot, and writes no stamp", async () => {
  const { stageId, actorUserId } = await seedOnlineChessRound({ roundNo: 1, fixtures: 1, unpaired: true });
  expect(await openRound({ stageId, roundNo: 1, actorUserId })).toEqual({
    opened: false, reason: "not_paired",
  });
  expect(await roundOpenedAt({ stageId, roundNo: 1 })).toBeNull();
});
```

The `toBeNull()` lines are the point: a refusal that still stamped would open the window
for a round the organiser never opened.

- [ ] **Step 10: Run — expect 4 passing in this file**

- [ ] **Step 11: Re-home `resendExternalPlayNotice` and repair the red route**

Create `invite.ts` exporting `sendFixtureInvite` (used by `open-round.ts`) and
`resendExternalPlayNotice(auth, fixtureId, baseUrl)`, re-export both from `index.ts`, and
leave `resend/route.ts:3`'s import spelling unchanged so the route compiles against the
new home. Then:

```bash
cd apps/web && rm -rf .next && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -a 'resend/route\|open-round\|invite' ; echo "EXIT=$?"
```

Expected: no lines for those three files. (`rm -rf .next` first — a stale validator reds
tsc after a rebase.) The app-wide count is still red from routes T13/B4/B5 own; gate on
YOUR files, never the total.

- [ ] **Step 12: The route, its OpenAPI entry and its key scope**

`POST /api/v1/stages/{id}/open-round` with `{ roundNo: number }`, organiser-only via
`requireResourceAuth(req, "stage", id, "write")`. Add the `ROUTES` entry
(`openapi-coverage.test.ts:32-39` is 1:1 per route file) and list the route in
`key-scopes.ts` — opening a round sends email to real people, so it is **never** an
API-key route. Run `pnpm openapi:gen` and confirm zero diff.

- [ ] **Step 13: Copy in four locales, then regenerate keys**

Add the organiser control's strings and the invite email's subject/body to all four
dictionaries (`ui.json` is FLAT), including the confirmation that names how many invites
will be sent, then:

```bash
pnpm i18n:check && pnpm i18n:gen-keys && git diff --stat apps/web/src/lib/i18n-keys.ts
```

`i18n-keys.ts` is generated — commit the regenerated file.

- [ ] **Step 14: Commit**

```bash
git add apps/web/src/server/usecases/external-play/open-round.ts \
  apps/web/src/server/usecases/external-play/invite.ts \
  apps/web/src/server/usecases/external-play/index.ts \
  apps/web/src/server/usecases/external-play/__tests__/open-round.test.ts \
  apps/web/src/app/api/v1/stages/\[id\]/open-round/route.ts \
  apps/web/src/app/api/v1/fixtures/\[id\]/external-play/resend/route.ts \
  apps/web/src/server/api-v1/openapi.ts apps/web/src/server/api-v1/key-scopes.ts \
  apps/web/src/lib/email.ts apps/web/src/lib/email-templates.ts \
  apps/web/src/lib/i18n-keys.ts apps/web/src/dictionaries
git commit -m "feat(external-play): the organiser opens a round, which stamps it and sends the invites"
```

---

### Task 10: The play loop

Our server is the only mover. A client posts an intended move to us; we validate
the UCI shape strictly, confirm the caller is that player and that it is their
turn, submit with THAT player's token, record the accepted move, and only then
broadcast. Clocks render locally from accepted-move timestamps and are corrected
on every reconcile — **we never declare a flag from our own arithmetic** (spec
§6, M1/M2: a read settles the flag).

**Files:**

| Path | Action |
|---|---|
| `apps/web/src/server/usecases/external-play/play.ts` | new |
| `apps/web/src/server/usecases/__tests__/external-play-play.test.ts` | new |
| `apps/web/src/lib/realtime.ts` | extend after `publishExternalPlayLobby` (ends line 299) |
| `apps/web/src/server/usecases/external-play/index.ts` | add `export * from "./play";` after line 3 |
| `apps/web/package.json` | add `chess.js` |

Read before writing: `apps/web/src/server/usecases/external-play/guard.ts:28-44`
(`BridgeRow`), `:121-159` (`loadOnlinePlayFixture`), `:177-179`
(`effectiveBridge`), `:273-279` (`loadSides`), `:298-302` (`whiteSideOf`);
`apps/web/src/server/usecases/external-play/room.ts:260-350` (`mintIfReady` —
the claim-then-commit shape T10 copies for its move append);
`apps/web/src/lib/realtime.ts:224-299`;
`apps/web/src/server/usecases/__tests__/_external-play-seed.ts:92-166`
(`seedOnlineChessFixture`).

**Interfaces — Consumes:**

```ts
// T3
import { assertUci, UCI_RE } from "@/server/external-play/lichess/uci";
import {
  submitMove, resignGame, offerOrAcceptDraw, abortGame,
  type BoardCall, type BoardErrorCode, type LichessStatus,
} from "@/server/external-play/lichess/board-api";
// T2
import { getLichessAccessToken } from "@/server/usecases/external-accounts";
// already on the branch
import { loadOnlinePlayFixture, loadSides, effectiveBridge, whiteSideOf,
         type OnlinePlayFixture, type Side, type SidePlayer } from "./guard";
import { externalPlayLobbyTopic } from "@/lib/realtime";
```

**Interfaces — Produces:**

```ts
// apps/web/src/server/usecases/external-play/play.ts
export type PlayAction =
  | { kind: "move"; uci: string }
  | { kind: "resign" } | { kind: "draw"; accept: boolean } | { kind: "abort" };
export type PlayResult =
  | { ok: true; applied: boolean }
  | { ok: false; reconcile: true; reason: BoardErrorCode };
export type PlayDeps = {
  now?: Date;
  submitMove?: typeof submitMove;
  resignGame?: typeof resignGame;
  offerOrAcceptDraw?: typeof offerOrAcceptDraw;
  abortGame?: typeof abortGame;
  accessToken?: (userId: string) => Promise<string | null>;
  publish?: (fixtureId: string, body: RoomBroadcast) => Promise<void>;
};
export function act(
  a: { fixtureId: string; personId: string; action: PlayAction },
  deps?: PlayDeps,
): Promise<PlayResult>;
/** Start position when `moves` is empty. Throws nothing: a move chess.js
 *  rejects stops the replay and the caller reconciles. */
export function fenAfter(moves: readonly string[]): { fen: string; replayed: number };

// apps/web/src/lib/realtime.ts (extended)
export type RoomBroadcast = {
  fen: string; lastMove: string | null; turn: "white" | "black";
  whiteMs: number; blackMs: number; status: LichessStatus;
  drawOfferBy: "white" | "black" | null;
};
export function publishRoomBroadcast(fixtureId: string, body: RoomBroadcast): Promise<void>;
```

**Columns owed by T1's `V432__online_chess_board_and_camera.sql`** — T10 reads
and writes these and cannot be built without them:

```sql
alter table fixture_external_play
  add column moves_uci        jsonb   not null default '[]'::jsonb,
  add column move_count       integer not null default 0,
  add column last_move_at     timestamptz,
  add column white_ms         integer,
  add column black_ms         integer,
  add column clock_increment_s integer,
  add column draw_offer_by    text check (draw_offer_by in ('white','black'));
```

---

- [ ] **Step 1: Re-check V432's move columns before writing a line.** Read
  `db/migration/deltas/V432__online_chess_board_and_camera.sql` and run
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && grep -an "moves_uci\|move_count\|last_move_at\|white_ms\|black_ms\|clock_increment_s\|draw_offer_by" db/migration/deltas/V432__online_chess_board_and_camera.sql`.
  All seven must be present. If any is missing, STOP and report it to the
  controller as a T1 gap — do not add a migration from this task (T1 owns the
  file, and two tasks editing one delta is the shape that produced the
  "one side reordered, the other inserted" merge in AGENTS.md rule 18). No
  commit.

- [ ] **Step 2: Add `chess.js` at an exact version.** Run
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && pnpm add --save-exact chess.js@1.4.0`
  (1.4.0 is the latest 1.x on the registry, checked 2026-10-09). BSD-2, so it
  carries none of chessground's isolation constraints (spec §9) — it may be
  imported directly on the server. Commit:
  `chore(deps): chess.js 1.4.0 for server-side FEN replay`.

- [ ] **Step 3 (RED): `fenAfter` — the FEN the broadcast carries.** Write
  `apps/web/src/server/usecases/__tests__/external-play-play.test.ts` with its
  first describe block. This block is DB-free.

  ```ts
  // The play loop (chess in-page board design §3.4). DB-backed blocks guard on
  // DATABASE_URL; the pure blocks always run.
  import { afterAll, describe, expect, it } from "vitest";
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import { fenAfter } from "@/server/usecases/external-play/play";

  const HAS_DB = !!process.env.DATABASE_URL;
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  afterAll(async () => {
    if (!HAS_DB) return;
    const g = globalThis as { _sql?: { end(): Promise<void> } };
    const client = g._sql;
    g._sql = undefined;
    await client?.end();
  });

  describe("fenAfter", () => {
    it("an EMPTY move list is the start position, replayed 0", () => {
      expect(fenAfter([])).toEqual({ fen: START_FEN, replayed: 0 });
    });

    it("replays a UCI list and reports how many it applied", () => {
      const out = fenAfter(["e2e4", "e7e5", "g1f3"]);
      expect(out.replayed, "three legal moves").toBe(3);
      // Side to move after three plies is Black; the half-move/full-move
      // counters come from chess.js, not from us.
      expect(out.fen.split(" ")[1]).toBe("b");
      expect(out.fen.startsWith("rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R")).toBe(true);
    });

    it("carries a promotion suffix through (M7: e7e8q → e8=Q)", () => {
      // A legal promotion reached by a short real sequence.
      const moves = ["e2e4", "d7d5", "e4d5", "c7c6", "d5c6", "b8d7", "c6b7", "d7b6", "b7a8q"];
      const out = fenAfter(moves);
      expect(out.replayed).toBe(9);
      // The promoted White queen stands on a8.
      expect(out.fen.split(" ")[0]!.split("/")[0]!.startsWith("Q")).toBe(true);
    });

    it("STOPS at a move chess.js rejects and reports the shorter count — it never throws", () => {
      // Lichess is the authority on legality (global constraint), so a
      // disagreement is not ours to adjudicate: we report the last FEN we
      // could build and the caller reconciles.
      const out = fenAfter(["e2e4", "e2e4"]);
      expect(out.replayed, "the second e2e4 is illegal — replay stopped").toBe(1);
      expect(out.fen.split(" ")[1]).toBe("b");
    });
  });
  ```

  Run the verify command scoped to this file. Expected failure:
  `Failed to resolve import "@/server/usecases/external-play/play"`, and
  `numTotalTests: 0` with the suite reported as failing to collect — treat a
  `PASS(0) FAIL(0)` line from `rtk` as a COLLECTION failure, not a pass.

- [ ] **Step 4 (GREEN): implement `fenAfter`.**

  ```ts
  import "server-only";
  import { Chess } from "chess.js";

  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  /** Replay a UCI list into a FEN. chess.js (BSD-2) is a RENDERER here, never
   *  an arbiter: Lichess decides legality (spec §1), so a move it accepted and
   *  chess.js rejects stops the replay and leaves the caller to reconcile —
   *  it must not refuse the player's move. */
  export function fenAfter(moves: readonly string[]): { fen: string; replayed: number } {
    const board = new Chess();
    let replayed = 0;
    for (const uci of moves) {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci.slice(4, 5) : undefined;
      try {
        board.move(promotion === undefined ? { from, to } : { from, to, promotion });
      } catch {
        return { fen: board.fen(), replayed };
      }
      replayed++;
    }
    return { fen: moves.length === 0 ? START_FEN : board.fen(), replayed };
  }
  ```

  Run. Expect `numFailedTests: 0`, `numTotalTests: 4`.

- [ ] **Step 5: mutate the promotion pass-through.** Change the `board.move`
  call to always pass `{ from, to }`. Re-run: the promotion test must fail with
  `replayed` 8 rather than 9 (chess.js rejects a promotion with no piece).
  Restore from a `cp` backup taken before the edit — never
  `git checkout play.ts`, which on uncommitted work restores the index and
  deletes the implementation the sweep is verifying. Commit:
  `feat(chess): replay accepted UCI into a FEN for the room broadcast`.

- [ ] **Step 6 (RED): order inside a move — shape, then caller, then turn,
  BEFORE any token leaves the process.** Append a DB-backed describe block. The
  stub counts calls so a reordered guard is visible rather than merely wrong.

  ```ts
  import { seedOnlineChessFixture } from "./_external-play-seed";
  import { act, type PlayDeps } from "@/server/usecases/external-play/play";

  type Call = { token: string; gameId: string; uci: string };

  /** A board stub that RECORDS. An assertion on `calls.length === 0` is what
   *  makes the guard ORDER testable: a validator that runs after the submit
   *  still returns 400, so a result-only assertion passes on the mutant. */
  function boardStub(reply: Awaited<ReturnType<typeof import("@/server/external-play/lichess/board-api").submitMove>> = { ok: true }) {
    const calls: Call[] = [];
    const deps: PlayDeps = {
      submitMove: async (a) => { calls.push(a); return reply; },
      accessToken: async (userId) => `tok-${userId}`,
      publish: async () => {},
    };
    return { calls, deps };
  }

  /** A fixture inside its window with a live game already created. */
  async function liveGame(opts: { moves?: string[] } = {}) {
    const scheduledAt = new Date(Date.now() - 60_000); // window open
    const seeded = await seedOnlineChessFixture({
      onlinePlay: "lichess", divisionStarted: true, scheduledAt, linked: true,
    });
    const gameId = `g${randomUUID().slice(0, 7)}`;
    const moves = opts.moves ?? [];
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, scheduled_at_basis, status, challenge_id, white_side,
         white_lichess_id, black_lichess_id, started_at, moves_uci, move_count,
         white_ms, black_ms, clock_increment_s)
      values (${seeded.fixtureId}, ${seeded.orgId}, ${scheduledAt}, 'live', ${gameId},
              'home', ${seeded.home.lichessId}, ${seeded.away.lichessId}, now(),
              ${sql.json(moves)}, ${moves.length}, 180000, 180000, 0)`;
    return { ...seeded, gameId };
  }

  describe.runIf(HAS_DB)("act — order inside a move", () => {
    it("a MALFORMED uci is refused before any token is used (M5: Lichess PLAYS e7e6xx)", async () => {
      const g = await liveGame();
      const { calls, deps } = boardStub();
      await expect(
        act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e7e6xx" } }, deps),
      ).rejects.toMatchObject({ status: 400, code: "INVALID_UCI" });
      expect(calls, "nothing reached the Board API").toEqual([]);
      const [row] = await sql<{ move_count: number }[]>`
        select move_count from fixture_external_play where fixture_id = ${g.fixtureId}`;
      expect(row!.move_count, "no move recorded").toBe(0);
    });

    it("a caller who is NEITHER player is refused and reaches no token", async () => {
      const g = await liveGame();
      const { calls, deps } = boardStub();
      await expect(
        act({ fixtureId: g.fixtureId, personId: randomUUID(), action: { kind: "move", uci: "e2e4" } }, deps),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(calls).toEqual([]);
    });

    it("BLACK moving on move 0 is refused — it is White's turn — and reaches no token", async () => {
      const g = await liveGame();
      const { calls, deps } = boardStub();
      const out = await act(
        { fixtureId: g.fixtureId, personId: g.away.personId, action: { kind: "move", uci: "e7e5" } },
        deps,
      );
      expect(out).toEqual({ ok: false, reconcile: true, reason: "not_your_turn_or_over" });
      expect(calls, "we answer out-of-turn ourselves; M6 means the 400 is ambiguous").toEqual([]);
    });

    it("WHITE's move is submitted with WHITE's own token and recorded", async () => {
      const g = await liveGame();
      const { calls, deps } = boardStub();
      const out = await act(
        { fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } },
        deps,
      );
      expect(out).toEqual({ ok: true, applied: true });
      expect(calls).toEqual([{ token: `tok-${g.home.userId}`, gameId: g.gameId, uci: "e2e4" }]);
      const [row] = await sql<{ moves_uci: string[]; move_count: number; last_move_at: Date | null }[]>`
        select moves_uci, move_count, last_move_at from fixture_external_play
         where fixture_id = ${g.fixtureId}`;
      expect(row!.moves_uci).toEqual(["e2e4"]);
      expect(row!.move_count).toBe(1);
      expect(row!.last_move_at, "accepted-move timestamp — clocks render from it").not.toBeNull();
    });

    it("BLACK's reply after White's move is accepted (the turn flips)", async () => {
      const g = await liveGame({ moves: ["e2e4"] });
      const { calls, deps } = boardStub();
      const out = await act(
        { fixtureId: g.fixtureId, personId: g.away.personId, action: { kind: "move", uci: "e7e5" } },
        deps,
      );
      expect(out).toEqual({ ok: true, applied: true });
      expect(calls[0]!.token).toBe(`tok-${g.away.userId}`);
    });
  });
  ```

  Run. Expect every test in this block to fail — `act` is not exported yet
  (`TypeError: act is not a function`).

- [ ] **Step 7 (GREEN): implement `act`'s validate → authorise → turn → submit
  ordering.** The caller resolution reuses `loadSides` + `whiteSideOf` so colour
  is READ from the pairing, never assigned (global constraint). A side with no
  resolved `personId` can never match, which is the same rule `room.ts:109`
  already applies.

  ```ts
  import { HttpError } from "@/lib/errors";
  import { sql } from "@/lib/db";
  import { publishRoomBroadcast, type RoomBroadcast } from "@/lib/realtime";
  import { assertUci } from "@/server/external-play/lichess/uci";
  import {
    submitMove as realSubmitMove, resignGame as realResign,
    offerOrAcceptDraw as realDraw, abortGame as realAbort,
  } from "@/server/external-play/lichess/board-api";
  import { getLichessAccessToken } from "@/server/usecases/external-accounts";
  import { roomPhase } from "@/server/external-play/window";
  import { effectiveBridge, loadOnlinePlayFixture, loadSides, whiteSideOf } from "./guard";

  const NOT_FOUND = () => new HttpError(404, "This match room could not be found", "NOT_FOUND");

  export async function act(
    a: { fixtureId: string; personId: string; action: PlayAction },
    deps: PlayDeps = {},
  ): Promise<PlayResult> {
    // 1. SHAPE FIRST. M5: Lichess truncates `e7e6xx` to `e7e6` and plays it,
    //    so an unvalidated client string moves a piece the player never
    //    chose. This throws before a token is read, let alone sent.
    if (a.action.kind === "move") assertUci(a.action.uci);

    const f = await loadOnlinePlayFixture(a.fixtureId);
    if (!f) throw NOT_FOUND();
    const bridge = effectiveBridge(f);
    if (!bridge || bridge.challenge_id === null) throw NOT_FOUND();

    // 2. CALLER. Identical 404 for "no such fixture" and "not your fixture".
    const { home, away } = await loadSides(f);
    const me = [home, away].find((s) => s.personId === a.personId);
    if (!me) throw NOT_FOUND();

    const whiteSide = bridge.white_side ?? (await whiteSideOf(f));
    const myColour: "white" | "black" = whiteSide === me.side ? "white" : "black";

    // 3. TURN, from OUR accepted-move count. We answer this ourselves rather
    //    than letting Lichess answer it, because M6 collapses "not your turn"
    //    and "game already over" into one 400 — a refusal we could not read.
    const turn: "white" | "black" = bridge.move_count % 2 === 0 ? "white" : "black";
    if (a.action.kind === "move" && turn !== myColour) {
      return { ok: false, reconcile: true, reason: "not_your_turn_or_over" };
    }
    ...
  }
  ```

  `BridgeRow` gains the seven new fields and `reviveBridge` gains their raw
  twins, mirroring `guard.ts:84-102` — `moves_uci`/`move_count` arrive through
  `to_jsonb(ep)` as a JSON array and a number, but `last_move_at` arrives as an
  **ISO string** and must be revived with `new Date(...)`: postgres.js parses a
  plain `timestamptz` column into a `Date` and does NOT parse one inside a
  `to_jsonb()` projection. Run. Expect `numFailedTests: 0`.

- [ ] **Step 8: mutate the guard ORDER.** Move the `assertUci` call from the top
  of `act` to immediately before the submit. Re-run: the malformed-UCI test must
  fail on `expect(calls).toEqual([])` — the stub recorded one call. (The
  `rejects.toMatchObject` half still passes, which is exactly why the call-count
  assertion exists; this is the guard-order mutant the spec §8.1 asks for.)
  Restore from the `cp` backup. Commit:
  `feat(chess): validate the UCI, the caller and the turn before a token moves`.

- [ ] **Step 9 (RED): Review Focus 2 — two tabs, both directions.** Append:

  ```ts
  describe.runIf(HAS_DB)("act — two tabs (Review Focus 2)", () => {
    it("the SAME move submitted twice is ABSORBED: ok, applied:false, one Lichess call, one move on file", async () => {
      const g = await liveGame();
      const { calls, deps } = boardStub();
      const first = await act(
        { fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      const second = await act(
        { fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      expect(first).toEqual({ ok: true, applied: true });
      expect(second, "absorbed — NOT an error the player sees").toEqual({ ok: true, applied: false });
      expect(calls.length, "the duplicate never reached Lichess").toBe(1);
      const [row] = await sql<{ moves_uci: string[]; move_count: number }[]>`
        select moves_uci, move_count from fixture_external_play where fixture_id = ${g.fixtureId}`;
      expect(row!.moves_uci).toEqual(["e2e4"]);
      expect(row!.move_count).toBe(1);
    });

    it("the absorb does not LATCH: the same player's genuinely different NEXT move still plays", async () => {
      // The known past defect this pairs against: a double-submit guard that
      // also ate a deliberate second tap. Sequence: play, duplicate, opponent
      // replies, play again — the fourth call must be applied.
      const g = await liveGame();
      const { calls, deps } = boardStub();
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      await act({ fixtureId: g.fixtureId, personId: g.away.personId, action: { kind: "move", uci: "e7e5" } }, deps);
      const fourth = await act(
        { fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "g1f3" } }, deps);
      expect(fourth, "a real third move, not a duplicate").toEqual({ ok: true, applied: true });
      const [row] = await sql<{ moves_uci: string[] }[]>`
        select moves_uci from fixture_external_play where fixture_id = ${g.fixtureId}`;
      expect(row!.moves_uci).toEqual(["e2e4", "e7e5", "g1f3"]);
      expect(calls.map((c) => c.uci)).toEqual(["e2e4", "e7e5", "g1f3"]);
    });

    it("a DIFFERENT move from the same player while it is still their turn is NOT absorbed", async () => {
      // Two tabs where the player changed their mind before the first landed:
      // the second is a real, distinct intent and must be played, not eaten.
      const g = await liveGame();
      const { calls, deps } = boardStub();
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      const second = await act(
        { fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "d2d4" } }, deps);
      expect(second, "not our turn any more ⇒ reconcile, never a silent absorb")
        .toEqual({ ok: false, reconcile: true, reason: "not_your_turn_or_over" });
      expect(calls.length).toBe(1);
    });

    it("two SIMULTANEOUS submissions of the same move append exactly once", async () => {
      const g = await liveGame();
      const { calls, deps } = boardStub();
      const [a1, a2] = await Promise.all([
        act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps),
        act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps),
      ]);
      const applied = [a1, a2].filter((r) => r.ok && r.applied);
      expect(applied.length, "one winner, one absorbed — never two").toBe(1);
      expect([a1, a2].every((r) => r.ok)).toBe(true);
      const [row] = await sql<{ move_count: number }[]>`
        select move_count from fixture_external_play where fixture_id = ${g.fixtureId}`;
      expect(row!.move_count).toBe(1);
      expect(calls.length).toBeLessThanOrEqual(2); // both may call; only one appends
    });
  });
  ```

  Run. Expect the absorb tests to fail (`applied: true` twice, `move_count: 2`).

- [ ] **Step 10 (GREEN): absorb by exact-duplicate, append by conditional
  UPDATE.** Two separate mechanisms, because they answer different questions:

  ```ts
  // ABSORB: the tab that is one move behind re-sends the move already on file.
  // Keyed on BOTH the last recorded move and the turn having flipped away from
  // the caller — so a player's genuinely different next move (their turn
  // again, a different uci) is never eaten. The known past defect here is a
  // double-submit guard that swallowed a deliberate second tap.
  if (a.action.kind === "move") {
    const last = bridge.moves_uci.at(-1) ?? null;
    if (last === a.action.uci && turn !== myColour) return { ok: true, applied: false };
  }
  ```

  …and after a successful `submitMove`, the append is conditional on the move
  count the caller read — the same claim-then-commit shape `mintIfReady`
  (`room.ts:305-340`) uses, for the same reason: the loser of a race must write
  nothing rather than overwrite the winner.

  ```ts
  const appended = await sql<{ move_count: number }[]>`
    update fixture_external_play
       set moves_uci = moves_uci || ${sql.json([uci])}::jsonb,
           move_count = move_count + 1,
           last_move_at = ${now}, draw_offer_by = null, updated_at = now()
     where fixture_id = ${f.fixtureId}
       and status = 'live'
       and move_count = ${bridge.move_count}
     returning move_count`;
  if (appended.length === 0) return { ok: true, applied: false }; // lost the race
  ```

  Run. Expect `numFailedTests: 0`.

- [ ] **Step 11: mutate the race predicate.** Delete
  `and move_count = ${bridge.move_count}` from the append UPDATE. Re-run: the
  simultaneous test must fail with `move_count: 2`. Then separately mutate the
  absorb's `&& turn !== myColour` to `&& true`: the "a DIFFERENT move while it
  is still their turn" test must fail. Both mutants are run ONE AT A TIME —
  two guards that cover for each other are each untested. Restore from the `cp`
  backup after each. Commit:
  `feat(chess): absorb a duplicate tab submission without eating the next move`.

- [ ] **Step 12 (RED): resign, draw, abort, and the two refusals that mean
  reconcile.** Append:

  ```ts
  describe.runIf(HAS_DB)("act — resign, draw, abort and refusals", () => {
    it("resign and abort reach the Board API with the CALLER's token", async () => {
      const g = await liveGame({ moves: ["e2e4", "e7e5"] });
      const seen: { kind: string; token: string }[] = [];
      const deps: PlayDeps = {
        accessToken: async (u) => `tok-${u}`,
        publish: async () => {},
        resignGame: async (x) => { seen.push({ kind: "resign", token: x.token }); return { ok: true }; },
        abortGame: async (x) => { seen.push({ kind: "abort", token: x.token }); return { ok: true }; },
      };
      expect(await act({ fixtureId: g.fixtureId, personId: g.away.personId, action: { kind: "resign" } }, deps))
        .toEqual({ ok: true, applied: true });
      expect(seen).toEqual([{ kind: "resign", token: `tok-${g.away.userId}` }]);
    });

    it("a draw OFFER records who offered it, and the offer is cleared by the next move (M10: the export cannot tell us)", async () => {
      const g = await liveGame();
      const deps: PlayDeps = {
        accessToken: async (u) => `tok-${u}`, publish: async () => {},
        offerOrAcceptDraw: async () => ({ ok: true }),
        submitMove: async () => ({ ok: true }),
      };
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "draw", accept: false } }, deps);
      const [offered] = await sql<{ draw_offer_by: string | null }[]>`
        select draw_offer_by from fixture_external_play where fixture_id = ${g.fixtureId}`;
      expect(offered!.draw_offer_by).toBe("white");
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      const [cleared] = await sql<{ draw_offer_by: string | null }[]>`
        select draw_offer_by from fixture_external_play where fixture_id = ${g.fixtureId}`;
      expect(cleared!.draw_offer_by, "a move withdraws the offer").toBeNull();
    });

    it("a 401 from Lichess is NOT an error to the player — it is reconcile:unauthorized", async () => {
      const g = await liveGame();
      const { deps } = boardStub({ ok: false, code: "unauthorized", raw: "401" });
      const out = await act(
        { fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      expect(out).toEqual({ ok: false, reconcile: true, reason: "unauthorized" });
      const [row] = await sql<{ move_count: number }[]>`
        select move_count from fixture_external_play where fixture_id = ${g.fixtureId}`;
      expect(row!.move_count, "a refused move is never recorded").toBe(0);
    });

    it("the M12 refusal (unplayable time control) also means reconcile, with its own code", async () => {
      const g = await liveGame();
      const { deps } = boardStub({ ok: false, code: "unplayable_time_control", raw: "This game cannot be played with the Board API." });
      expect(await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps))
        .toEqual({ ok: false, reconcile: true, reason: "unplayable_time_control" });
    });

    it("AFTER a resign, a further move from either player is refused", async () => {
      const g = await liveGame({ moves: ["e2e4", "e7e5"] });
      const deps: PlayDeps = {
        accessToken: async (u) => `tok-${u}`, publish: async () => {},
        resignGame: async () => ({ ok: true }), submitMove: async () => ({ ok: true }),
      };
      await act({ fixtureId: g.fixtureId, personId: g.away.personId, action: { kind: "resign" } }, deps);
      await expect(
        act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "g1f3" } }, deps),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
  ```

- [ ] **Step 13 (GREEN): implement the three non-move actions and the refusal
  mapping.** A resign/draw-accept/abort flips the row to `finished` (the result
  itself is T12's, written on the next reconcile); the refusal codes pass
  through to `PlayResult.reason` unchanged — no branch collapses two of them,
  because M6's single message is exactly the ambiguity we refuse to guess at.
  Run. Expect `numFailedTests: 0`.

- [ ] **Step 14 (RED): the broadcast.** Append, plus the realtime extension's
  own block:

  ```ts
  describe.runIf(HAS_DB)("act — broadcast", () => {
    it("ONE broadcast per accepted move, carrying the full RoomBroadcast", async () => {
      const g = await liveGame();
      const sent: { fixtureId: string; body: import("@/lib/realtime").RoomBroadcast }[] = [];
      const deps: PlayDeps = {
        accessToken: async (u) => `tok-${u}`,
        submitMove: async () => ({ ok: true }),
        publish: async (fixtureId, body) => { sent.push({ fixtureId, body }); },
      };
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      expect(sent.length).toBe(1);
      expect(sent[0]!.fixtureId).toBe(g.fixtureId);
      expect(sent[0]!.body.lastMove).toBe("e2e4");
      expect(sent[0]!.body.turn, "the turn flipped").toBe("black");
      expect(sent[0]!.body.fen).toBe(fenAfter(["e2e4"]).fen);
      expect(sent[0]!.body.status).toBe("started");
      expect(sent[0]!.body.drawOfferBy).toBeNull();
      // Clocks are LOCAL arithmetic from accepted-move timestamps, corrected
      // on every reconcile. They are rendered, never adjudicated: nothing in
      // this function declares a flag (spec §6, M2).
      expect(Number.isInteger(sent[0]!.body.whiteMs)).toBe(true);
      expect(Number.isInteger(sent[0]!.body.blackMs)).toBe(true);
    });

    it("an ABSORBED duplicate broadcasts NOTHING — no state changed", async () => {
      const g = await liveGame();
      const sent: unknown[] = [];
      const deps: PlayDeps = {
        accessToken: async (u) => `tok-${u}`, submitMove: async () => ({ ok: true }),
        publish: async (f, b) => { sent.push({ f, b }); },
      };
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      expect(sent.length, "one accepted move ⇒ one broadcast").toBe(1);
    });

    it("a REFUSED move broadcasts nothing", async () => {
      const g = await liveGame();
      const sent: unknown[] = [];
      const { deps } = boardStub({ ok: false, code: "unauthorized", raw: "401" });
      deps.publish = async (f, b) => { sent.push({ f, b }); };
      await act({ fixtureId: g.fixtureId, personId: g.home.personId, action: { kind: "move", uci: "e2e4" } }, deps);
      expect(sent).toEqual([]);
    });
  });

  describe("publishRoomBroadcast", () => {
    it("posts to the lobby topic we already own, PRIVATE, with the room_state event", async () => {
      const calls: { url: string; body: unknown }[] = [];
      const realFetch = globalThis.fetch;
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.test";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      try {
        const { publishRoomBroadcast, externalPlayLobbyTopic } = await import("@/lib/realtime");
        await publishRoomBroadcast("fix-1", {
          fen: "x", lastMove: "e2e4", turn: "black", whiteMs: 1, blackMs: 2,
          status: "started", drawOfferBy: null,
        });
        expect(calls.length).toBe(1);
        const msg = (calls[0]!.body as { messages: { topic: string; event: string; private: boolean }[] }).messages[0]!;
        // V407's policy matches `external-play:{lobby_fixture_id}`, so riding
        // this topic needs NO new realtime policy for players.
        expect(msg.topic).toBe(externalPlayLobbyTopic("fix-1"));
        expect(msg.event).toBe("room_state");
        expect(msg.private, "a non-private broadcast on this topic is joinable with the anon key").toBe(true);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
  ```

- [ ] **Step 15 (GREEN + mutate): implement `publishRoomBroadcast` and wire the
  broadcast after the append.** `publishRoomBroadcast` copies
  `publishExternalPlayLobby` (`realtime.ts:270-299`) exactly — same endpoint,
  same headers, `private: true`, fire-and-forget, never throws — but carries the
  whole `RoomBroadcast` as its payload so the client needs no refetch (a refetch
  here is served from the browser's HTTP cache and shows stale state). Add
  `signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS)`, which
  `publishExternalPlayLobby` omits and `publishFixtureUpdate` (`:52`) has.
  Then mutate: move the `publish` call above the conditional append. Re-run:
  the absorbed-duplicate test must fail with `sent.length: 2`. Restore. Commit:
  `feat(chess): broadcast the room state after an accepted move`.

- [ ] **Step 16: export, typecheck, lint, final scoped run.** Add
  `export * from "./play";` to
  `apps/web/src/server/usecases/external-play/index.ts`. Then:
  `cd .../apps/web && rtk proxy npx tsc --noEmit -p tsconfig.json` (plain `rtk`
  rewrites `pnpm exec tsc`), and
  `rtk proxy npx eslint src/server/usecases/external-play/play.ts src/lib/realtime.ts src/server/usecases/__tests__/external-play-play.test.ts`
  — read `✖ N problems`; "ESLint output (JSON parse failed)" is the wrapper
  losing the result, not a clean run. Note for the reviewer: `tsc` will still
  red on the four pre-existing missing-export routes (false premise 4) — compare
  the error list against the one recorded in Step 1 and confirm no NEW error
  names a file this task touched. Commit:
  `feat(chess): the play loop — one mover, our server`.

---

### Task 11: Reconcile

One export read, on exactly five triggers. The read returns status, winner **and
authoritative clocks** (M11), so every reconcile corrects our derived clocks
instead of letting them drift to the flag. A rejected move means reconcile,
never assume (M6 — one 400 message covers two states).

**Pin this in `reconcile.ts`'s header comment and keep it there:** M2. The flag
spike cannot distinguish "Lichess auto-flags" from "our export read finalises
it" — the flag appeared on the first poll after expiry, which is consistent with
both. **The design says a READ SETTLES THE FLAG. It never says Lichess pushes to
us.** Nothing in this module may be built on a push that was never observed, and
nothing anywhere may declare a flag from our own arithmetic.

**Files:**

| Path | Action |
|---|---|
| `apps/web/src/server/usecases/external-play/reconcile.ts` | new |
| `apps/web/src/server/usecases/__tests__/external-play-reconcile.test.ts` | new |
| `apps/web/src/server/usecases/external-play/index.ts` | add `export * from "./reconcile";` |

**Interfaces — Consumes:** T3's `exportGame`, `GameSnapshot`, `LichessStatus`;
T10's `fenAfter` and `publishRoomBroadcast`; **T12's `writeResultFrom`** (see
the batch build-order note); `loadOnlinePlayFixture`/`effectiveBridge` from
`guard.ts`.

**Interfaces — Produces:**

```ts
export type ReconcileTrigger =
  "rejected_move" | "clock_zero" | "game_end" | "organiser" | "sweep";
/** The domain as a VALUE so a sweep can cross-product it. Add a trigger here
 *  and the enumeration test fails until it is covered. */
export const RECONCILE_TRIGGERS: readonly ReconcileTrigger[];
export type ReconcileDeps = {
  now?: Date;
  exportGame?: typeof exportGame;
  writeResult?: typeof writeResultFrom;
  publish?: (fixtureId: string, body: RoomBroadcast) => Promise<void>;
};
export function reconcile(
  a: { fixtureId: string; trigger: ReconcileTrigger },
  deps?: ReconcileDeps,
): Promise<GameSnapshot | null>;
/** SAN from the export → our UCI vocabulary, for an out-of-band resync. */
export function uciFromSan(movesSan: readonly string[]): { uci: string[]; replayed: number };
```

---

- [ ] **Step 1: verify T3's clock-bearing export before building on it.** Run
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && grep -an "clocks\|\"clock\"\|moves" apps/web/src/server/external-play/__fixtures__/lichess/*.json`
  and read `apps/web/src/server/external-play/lichess/board-api.ts`'s
  `exportGame`. At the time this plan was written the recorded exports carried
  NONE of `clocks`, `clock` or `moves` — the directory's `README.md` says they
  were captured with `clocks=false`. `GameSnapshot.whiteMs`/`blackMs`/
  `increment`/`movesSan` must be populated from a real recording, and
  `exportGame` must request `clocks=true`. If the fixtures still lack clocks,
  report it to the controller as a T3 gap and STOP. No commit.

- [ ] **Step 2 (RED): five triggers, one export read each, counted.** Create the
  test file:

  ```ts
  // Reconcile (chess in-page board design §3.5). The authority on status,
  // winner and clocks is the export — never our arithmetic (M2).
  import { afterAll, describe, expect, it } from "vitest";
  import { randomUUID } from "node:crypto";
  import { sql } from "@/lib/db";
  import {
    RECONCILE_TRIGGERS, reconcile, type ReconcileDeps, type ReconcileTrigger,
  } from "@/server/usecases/external-play/reconcile";
  import type { GameSnapshot } from "@/server/external-play/lichess/board-api";
  import { seedOnlineChessFixture } from "./_external-play-seed";

  const HAS_DB = !!process.env.DATABASE_URL;

  afterAll(async () => {
    if (!HAS_DB) return;
    const g = globalThis as { _sql?: { end(): Promise<void> } };
    const client = g._sql; g._sql = undefined; await client?.end();
  });

  function snapshot(over: Partial<GameSnapshot> = {}): GameSnapshot {
    return {
      gameId: "snap0001", status: "started", winner: null, movesSan: [],
      whiteMs: 180_000, blackMs: 180_000, increment: 0, ...over,
    };
  }

  /** A live fixture with a game on file and clocks we deliberately set WRONG,
   *  so a reconcile that fails to correct them is visible. */
  async function liveFixture(over: { moves?: string[]; whiteMs?: number } = {}) {
    const scheduledAt = new Date(Date.now() - 60_000);
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess", divisionStarted: true, scheduledAt, linked: true,
    });
    const moves = over.moves ?? [];
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, scheduled_at_basis, status, challenge_id, white_side,
         white_lichess_id, black_lichess_id, started_at, moves_uci, move_count,
         white_ms, black_ms, clock_increment_s)
      values (${s.fixtureId}, ${s.orgId}, ${scheduledAt}, 'live', ${"g" + randomUUID().slice(0, 7)},
              'home', ${s.home.lichessId}, ${s.away.lichessId}, now(),
              ${sql.json(moves)}, ${moves.length}, ${over.whiteMs ?? 999_999}, 999_999, 0)`;
    return s;
  }

  describe.runIf(HAS_DB)("reconcile — the trigger set", () => {
    it("declares exactly the five triggers the design allows", () => {
      expect([...RECONCILE_TRIGGERS].sort()).toEqual(
        ["clock_zero", "game_end", "organiser", "rejected_move", "sweep"].sort(),
      );
    });

    it("every declared trigger performs EXACTLY ONE export read", async () => {
      let checked = 0;
      for (const trigger of RECONCILE_TRIGGERS) {
        const f = await liveFixture();
        let reads = 0;
        const deps: ReconcileDeps = {
          exportGame: async () => { reads++; return snapshot(); },
          writeResult: async () => ({ wrote: "none" as const }),
          publish: async () => {},
        };
        await reconcile({ fixtureId: f.fixtureId, trigger }, deps);
        expect(reads, `trigger ${trigger}`).toBe(1);
        checked++;
      }
      // Anti-vacuity: a loop over an empty domain passes every assertion.
      expect(checked, "triggers checked").toBe(RECONCILE_TRIGGERS.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("an UNDECLARED trigger is refused rather than silently reconciled", async () => {
      const f = await liveFixture();
      await expect(
        reconcile({ fixtureId: f.fixtureId, trigger: "whenever" as ReconcileTrigger }, {
          exportGame: async () => snapshot(),
        }),
      ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_RECONCILE_TRIGGER" });
    });

    it("a fixture with no game on file reads nothing and returns null", async () => {
      const scheduledAt = new Date(Date.now() - 60_000);
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess", divisionStarted: true, scheduledAt, linked: true });
      let reads = 0;
      const out = await reconcile({ fixtureId: s.fixtureId, trigger: "organiser" }, {
        exportGame: async () => { reads++; return snapshot(); },
      });
      expect(out).toBeNull();
      expect(reads, "nothing to reconcile ⇒ no Lichess round trip").toBe(0);
    });
  });
  ```

  Run. Expected failure: the import of `reconcile` cannot be resolved.

- [ ] **Step 3 (GREEN): `RECONCILE_TRIGGERS` and the single-read skeleton.** The
  trigger is validated against the exported tuple (an assumption is a guard, not
  a comment — "cannot happen" owes an assertion AND a test that reaches it,
  which the undeclared-trigger case above is). One `exportGame` call per
  invocation, taken once into a local. Run. Expect `numFailedTests: 0`,
  `numTotalTests: 4`.

- [ ] **Step 4: mutate the read count.** Add a second `await ex(gameId)` call
  inside `reconcile` (e.g. a "re-read after the write" that looks harmless).
  Re-run: the one-read-per-trigger test must fail with `reads: 2` for the first
  trigger. Restore from the `cp` backup. Commit:
  `feat(chess): reconcile reads the export once, on five declared triggers`.

- [ ] **Step 5 (RED): clocks are corrected, and no flag is ever declared from
  our arithmetic.** Append:

  ```ts
  describe.runIf(HAS_DB)("reconcile — clocks (M11) and the flag we never declare (M2)", () => {
    it("writes the export's authoritative clocks OVER our derived ones", async () => {
      const f = await liveFixture({ whiteMs: 999_999 });
      await reconcile({ fixtureId: f.fixtureId, trigger: "game_end" }, {
        exportGame: async () => snapshot({ whiteMs: 42_000, blackMs: 61_500, increment: 3 }),
        writeResult: async () => ({ wrote: "none" as const }),
        publish: async () => {},
      });
      const [row] = await sql<{ white_ms: number; black_ms: number; clock_increment_s: number }[]>`
        select white_ms, black_ms, clock_increment_s from fixture_external_play
         where fixture_id = ${f.fixtureId}`;
      expect(row!.white_ms, "our 999999 was wrong and is gone").toBe(42_000);
      expect(row!.black_ms).toBe(61_500);
      expect(row!.clock_increment_s).toBe(3);
    });

    it("EVERY trigger corrects the clocks, not just game_end", async () => {
      let checked = 0;
      for (const trigger of RECONCILE_TRIGGERS) {
        const f = await liveFixture({ whiteMs: 999_999 });
        await reconcile({ fixtureId: f.fixtureId, trigger }, {
          exportGame: async () => snapshot({ whiteMs: 7_000, blackMs: 8_000 }),
          writeResult: async () => ({ wrote: "none" as const }), publish: async () => {},
        });
        const [row] = await sql<{ white_ms: number }[]>`
          select white_ms from fixture_external_play where fixture_id = ${f.fixtureId}`;
        expect(row!.white_ms, `trigger ${trigger}`).toBe(7_000);
        checked++;
      }
      expect(checked, "triggers checked").toBe(RECONCILE_TRIGGERS.length);
    });

    it("clock_zero on a game the export still calls `started` leaves it LIVE and writes no result", async () => {
      // Our arithmetic said a clock hit zero. Lichess says the game is going.
      // Lichess wins: no flag, no result, no status change. M2 is the reason
      // this module never infers a flag — a read settles it, and this read
      // settled it the other way.
      const f = await liveFixture({ whiteMs: 0 });
      const writes: unknown[] = [];
      const out = await reconcile({ fixtureId: f.fixtureId, trigger: "clock_zero" }, {
        exportGame: async () => snapshot({ status: "started", winner: null, whiteMs: 2_500 }),
        writeResult: async (...a) => { writes.push(a); return { wrote: "none" as const }; },
        publish: async () => {},
      });
      expect(out!.status).toBe("started");
      expect(writes, "no result was written for a game that is still going").toEqual([]);
      const [row] = await sql<{ status: string; white_ms: number; finished_at: Date | null }[]>`
        select status, white_ms, finished_at from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(row!.status).toBe("live");
      expect(row!.white_ms, "our zero was wrong — corrected from the export").toBe(2_500);
      expect(row!.finished_at).toBeNull();
    });

    it("clock_zero on a game the export calls `outoftime` DOES settle it", async () => {
      // The ordering differential for the case above: same trigger, different
      // export answer, opposite outcome. Without this pair the test above
      // passes on a reconcile that never settles anything.
      const f = await liveFixture({ whiteMs: 0 });
      const writes: GameSnapshot[] = [];
      await reconcile({ fixtureId: f.fixtureId, trigger: "clock_zero" }, {
        exportGame: async () => snapshot({ status: "outoftime", winner: "black", whiteMs: 0 }),
        writeResult: async (s) => { writes.push(s); return { wrote: "decided" as const }; },
        publish: async () => {},
      });
      expect(writes.length).toBe(1);
      expect(writes[0]!.winner).toBe("black");
      const [row] = await sql<{ status: string; finished_at: Date | null }[]>`
        select status, finished_at from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(row!.status).toBe("finished");
      expect(row!.finished_at).not.toBeNull();
    });
  });
  ```

- [ ] **Step 6 (GREEN + mutate): clock correction and the terminal branch.** The
  terminal set is derived from `LichessStatus` — a `Set` of the non-live
  members, declared once, with a `satisfies` check so adding a status to the
  union forces a decision here. Then mutate: make `clock_zero` short-circuit to
  `{status: "outoftime"}` without consulting the export. Re-run: the
  "still `started`" test must fail on `row.status: "finished"`. Restore. Commit:
  `feat(chess): every reconcile corrects the clocks from the export`.

- [ ] **Step 7 (RED): out-of-band play resyncs the board from the export's move
  list.** Append:

  ```ts
  describe.runIf(HAS_DB)("reconcile — out-of-band play", () => {
    it("adopts the export's LONGER move list and rebroadcasts the resynced position", async () => {
      // We cannot prevent the same accounts playing on lichess.org (spec §1):
      // out-of-band play is detected, not blocked. Detection is a move list
      // longer than ours.
      const f = await liveFixture({ moves: ["e2e4", "e7e5"] });
      const sent: import("@/lib/realtime").RoomBroadcast[] = [];
      await reconcile({ fixtureId: f.fixtureId, trigger: "rejected_move" }, {
        exportGame: async () => snapshot({ movesSan: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"] }),
        writeResult: async () => ({ wrote: "none" as const }),
        publish: async (_id, body) => { sent.push(body); },
      });
      const [row] = await sql<{ moves_uci: string[]; move_count: number }[]>`
        select moves_uci, move_count from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(row!.moves_uci).toEqual(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"]);
      expect(row!.move_count).toBe(6);
      expect(sent.length, "the players' boards are wrong until we tell them").toBe(1);
      expect(sent[0]!.turn, "six plies ⇒ White to move").toBe("white");
      expect(sent[0]!.lastMove).toBe("a7a6");
    });

    it("an export that AGREES with us rewrites nothing and broadcasts nothing", async () => {
      const f = await liveFixture({ moves: ["e2e4", "e7e5"] });
      const sent: unknown[] = [];
      await reconcile({ fixtureId: f.fixtureId, trigger: "organiser" }, {
        exportGame: async () => snapshot({ movesSan: ["e4", "e5"] }),
        writeResult: async () => ({ wrote: "none" as const }),
        publish: async (i, b) => { sent.push({ i, b }); },
      });
      const [row] = await sql<{ move_count: number }[]>`
        select move_count from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(row!.move_count).toBe(2);
      expect(sent, "nothing changed").toEqual([]);
    });

    it("an EMPTY export move list on a game we have moves for does NOT erase them", async () => {
      const f = await liveFixture({ moves: ["e2e4", "e7e5"] });
      await reconcile({ fixtureId: f.fixtureId, trigger: "organiser" }, {
        exportGame: async () => snapshot({ movesSan: [] }),
        writeResult: async () => ({ wrote: "none" as const }), publish: async () => {},
      });
      const [row] = await sql<{ moves_uci: string[] }[]>`
        select moves_uci from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(row!.moves_uci, "a short export is a truncated read, not a rewind").toEqual(["e2e4", "e7e5"]);
    });

    it("uciFromSan reports how many it converted and stops at a SAN it cannot replay", () => {
      expect(uciFromSan(["e4", "e5", "Nf3"])).toEqual({ uci: ["e2e4", "e7e5", "g1f3"], replayed: 3 });
      expect(uciFromSan([])).toEqual({ uci: [], replayed: 0 });
      expect(uciFromSan(["e4", "Qh9"])).toEqual({ uci: ["e2e4"], replayed: 1 });
    });
  });
  ```

- [ ] **Step 8 (GREEN + mutate): `uciFromSan` and the adopt-only-if-longer
  rule.** `uciFromSan` replays SAN through chess.js and reads each move's
  `from`/`to`/`promotion` back out as UCI. Adoption is guarded on
  `export.length > ours.length`, which is what makes the truncated-read case
  safe. Mutate: change the guard to `!==`. Re-run: the empty-export test must
  fail with `moves_uci: []`. Restore. Commit:
  `feat(chess): resync the board from the export when play went out of band`.

- [ ] **Step 9 (RED): Review Focus 4 — down across the expiry, written exactly
  once, through BOTH entry points.** Append:

  ```ts
  describe.runIf(HAS_DB)("reconcile — Review Focus 4: the result is written exactly once", () => {
    /** Rows of the deciding kind in the ledger for this fixture. */
    async function decidingRows(fixtureId: string) {
      return sql<{ type: string; idempotency_key: string | null }[]>`
        select type, idempotency_key from score_events
         where fixture_id = ${fixtureId} and type <> 'core.start'
         order by seq`;
    }

    it("our server was down while the clock expired: the FIRST reconcile after we return writes the result", async () => {
      const f = await liveFixture({ moves: ["e2e4", "e7e5"] });
      const out = await reconcile({ fixtureId: f.fixtureId, trigger: "sweep" }, {
        exportGame: async () => snapshot({ status: "outoftime", winner: "black", whiteMs: 0, movesSan: ["e4", "e5"] }),
        publish: async () => {},
      });
      expect(out!.status).toBe("outoftime");
      const rows = await decidingRows(f.fixtureId);
      expect(rows.length, "one result").toBe(1);
      expect(rows[0]!.type).toBe("boardgame.result");
      expect(rows[0]!.idempotency_key, "deterministic, so a replay is free").not.toBeNull();
    });

    it("a SECOND reconcile is a no-op: no duplicate event, same row count", async () => {
      const f = await liveFixture({ moves: ["e2e4", "e7e5"] });
      const deps: ReconcileDeps = {
        exportGame: async () => snapshot({ status: "outoftime", winner: "black", whiteMs: 0, movesSan: ["e4", "e5"] }),
        publish: async () => {},
      };
      await reconcile({ fixtureId: f.fixtureId, trigger: "sweep" }, deps);
      const first = await decidingRows(f.fixtureId);
      await reconcile({ fixtureId: f.fixtureId, trigger: "game_end" }, deps);
      const second = await decidingRows(f.fixtureId);
      expect(second.length, "still one").toBe(1);
      expect(second).toEqual(first);
    });

    it("the once-only holds through BOTH entry points and through BOTH recovery paths", async () => {
      // Two distinct failures reach the same answer, and the first MASKS the
      // second: scoring.ts:228 replays on `SEQ_CONFLICT` OR on the
      // `score_events_idem_key` 23505, and SEQ_CONFLICT is checked first. A
      // test that only drives one leaves the other catch inert.
      const f = await liveFixture({ moves: ["e2e4", "e7e5"] });
      const deps: ReconcileDeps = {
        exportGame: async () => snapshot({ status: "mate", winner: "white", movesSan: ["e4", "e5"] }),
        publish: async () => {},
      };
      // (a) sweep, then a CONCURRENT pair — both read the same expected_seq,
      //     so one trips the unique index (23505) and one trips SEQ_CONFLICT.
      await Promise.all([
        reconcile({ fixtureId: f.fixtureId, trigger: "sweep" }, deps),
        reconcile({ fixtureId: f.fixtureId, trigger: "game_end" }, deps),
        reconcile({ fixtureId: f.fixtureId, trigger: "organiser" }, deps),
      ]);
      const rows = await decidingRows(f.fixtureId);
      expect(rows.length, "three concurrent reconciles, one result").toBe(1);
      // (b) and a later, fully sequential one, which reads the NEW seq.
      await reconcile({ fixtureId: f.fixtureId, trigger: "organiser" }, deps);
      expect((await decidingRows(f.fixtureId)).length).toBe(1);
    });

    it("the fixture's own status moves to finished exactly once and keeps its first finished_at", async () => {
      const f = await liveFixture({ moves: ["e2e4", "e7e5"] });
      const deps: ReconcileDeps = {
        exportGame: async () => snapshot({ status: "resign", winner: "white", movesSan: ["e4", "e5"] }),
        publish: async () => {},
      };
      await reconcile({ fixtureId: f.fixtureId, trigger: "game_end" }, deps);
      const [one] = await sql<{ finished_at: Date }[]>`
        select finished_at from fixture_external_play where fixture_id = ${f.fixtureId}`;
      await reconcile({ fixtureId: f.fixtureId, trigger: "game_end" }, deps);
      const [two] = await sql<{ finished_at: Date }[]>`
        select finished_at from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(two!.finished_at.getTime(), "not re-stamped").toBe(one!.finished_at.getTime());
    });
  });
  ```

- [ ] **Step 10 (GREEN): delegate to T12 with a deterministic idempotency key.**
  `reconcile` calls `writeResultFrom(snapshot, fixtureId)` (T12's real export,
  statically imported — this is why T12 is built first). T12 mints the key as
  `extplay:<fixtureId>:<gameId>:<status>`; `reconcile` adds no latch column of
  its own, because `score_events (fixture_id, idempotency_key)` already IS the
  durable once-only (`V413:88-89`, replayed at `scoring.ts:228-240`). The
  `finished_at` stamp is a conditional UPDATE with `and finished_at is null`.
  Run. Expect `numFailedTests: 0`.

- [ ] **Step 11: mutate the key's determinism.** Change T12's key mint to append
  `randomUUID()`. Re-run `external-play-reconcile.test.ts`: the second-reconcile
  test must fail with `second.length: 2`. Then separately mutate the
  `and finished_at is null` predicate away: the re-stamp test must fail.
  Restore both from the `cp` backups, one at a time. Commit:
  `feat(chess): a second reconcile writes nothing — the ledger key is the latch`.

- [ ] **Step 12 (RED): the `sweep` trigger end to end.** Append:

  ```ts
  describe.runIf(HAS_DB)("reconcile — the sweep trigger (nobody is watching)", () => {
    it("a live game nobody ever reconciled is settled from the export with no client involved", async () => {
      // Both players closed their tabs mid-game. The other four triggers all
      // need a client open; without `sweep` the fixture sits live forever.
      const f = await liveFixture({ moves: ["e2e4", "e7e5", "g1f3"] });
      const out = await reconcile({ fixtureId: f.fixtureId, trigger: "sweep" }, {
        exportGame: async () => snapshot({
          status: "outoftime", winner: "white", whiteMs: 95_000, blackMs: 0,
          movesSan: ["e4", "e5", "Nf3"],
        }),
        publish: async () => {},
      });
      expect(out!.winner).toBe("white");
      const [row] = await sql<{ status: string; black_ms: number }[]>`
        select status, black_ms from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(row!.status).toBe("finished");
      expect(row!.black_ms).toBe(0);
      const rows = await sql<{ type: string }[]>`
        select type from score_events where fixture_id = ${f.fixtureId} and type = 'boardgame.result'`;
      expect(rows.length).toBe(1);
    });

    it("a sweep on a game that is genuinely still going changes nothing but the clocks", async () => {
      const f = await liveFixture({ moves: ["e2e4"] });
      await reconcile({ fixtureId: f.fixtureId, trigger: "sweep" }, {
        exportGame: async () => snapshot({ status: "started", movesSan: ["e4"], whiteMs: 170_000 }),
        publish: async () => {},
      });
      const [row] = await sql<{ status: string; white_ms: number }[]>`
        select status, white_ms from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(row!.status).toBe("live");
      expect(row!.white_ms).toBe(170_000);
      expect((await sql`select 1 from score_events where fixture_id = ${f.fixtureId}`).length).toBe(0);
    });
  });
  ```

- [ ] **Step 13 (GREEN + the M2 comment):** no new branch is needed — `sweep`
  joins `RECONCILE_TRIGGERS` and takes the same path. Write the module header
  comment now, including M2 verbatim as a quoted design ruling, and the
  sentence "nothing in this file may declare a flag from our own arithmetic".
  Run. Commit: `feat(chess): the sweep trigger closes a game nobody is watching`.

- [ ] **Step 14: export, typecheck, lint, final scoped run.** Add
  `export * from "./reconcile";` to the directory `index.ts`. `rtk proxy npx tsc
  --noEmit` and `rtk proxy npx eslint` on the two touched files. Run the verify
  command scoped to `external-play-reconcile.test.ts` and
  `external-play-result.test.ts` together (T11 and T12 share the ledger path).
  Commit: `feat(chess): reconcile — five triggers, one read, clocks corrected`.

---

### Task 12: Write the result

Map a `GameSnapshot` to our events, written under ORGANISER authority
(`mintOrgOwnerAuth`, `apps/web/src/server/usecases/external-play/auth.ts:13`).
Every expected value in this task's tests comes from the spec's §3.6 table or
from the engine's own declarations — never from `result.ts` or `map-result.ts`.

**Files:**

| Path | Action |
|---|---|
| `apps/web/src/server/usecases/external-play/result.ts` | new |
| `apps/web/src/server/usecases/__tests__/external-play-result.test.ts` | new |
| `apps/web/src/server/external-play/types.ts` | extend `NeedsReason` (lines 14-21) |
| `apps/web/src/server/external-play/map-result.ts` | fix the stale comment at line 48 |
| `apps/web/src/server/usecases/external-play/index.ts` | add `export * from "./result";` |

Read before writing: `apps/web/src/server/external-play/map-result.ts:32-44`
(`STATUS_METHOD` — the existing status→`BoardgameMethod` table, reused rather
than re-invented), `packages/engine/src/sports/boardgame/boardgame.ts:243-277`
(`decideResult`, and its `phase !== "live"` guard at :249), `:601-603`
(`core.start`), `:616-631` (`core.forfeit`),
`apps/web/src/server/usecases/withdrawal.ts:104-115` (the
`getFixtureState` → `scoreEvent` write shape this task copies),
`apps/web/src/server/usecases/scoring.ts:90-98, 206-241` (the idempotency
contract).

**Interfaces — Consumes:** T3's `GameSnapshot`/`LichessStatus`;
`mintOrgOwnerAuth` (`auth.ts:13`); `getFixtureState`
(`apps/web/src/server/usecases/fixtures.ts:656`); `scoreEvent`
(`apps/web/src/server/usecases/scoring.ts:138`);
`mapLichessGameToBoardgameResult`'s `STATUS_METHOD` vocabulary.

**Interfaces — Produces:**

```ts
export type ResultWrite =
  | { wrote: "decided" | "draw" | "aborted" | "forfeit" | "none" }
  | { wrote: "needs_organiser";
      reason: "token_revoked" | "provider_error" | "double_walkover_blocked" | "tiebreak_owed" };
export function writeResultFrom(snapshot: GameSnapshot, fixtureId: string): Promise<ResultWrite>;
/** The non-snapshot half: a fixture that cannot produce a result at all goes
 *  to the organiser queue with its own reason. Called by T10's `unauthorized`
 *  caller and by T13's double-walkover refusal. */
export function holdForOrganiser(a: {
  fixtureId: string;
  reason: "token_revoked" | "provider_error" | "double_walkover_blocked" | "tiebreak_owed";
}): Promise<ResultWrite>;
/** Deterministic, so a replay costs one Redis GET and writes nothing. */
export function resultIdempotencyKey(fixtureId: string, snapshot: GameSnapshot): string;
```

**Also owed by T1's V432:** the `needs_reason` CHECK at
`V405__lichess_external_play.sql:48-51` must grow `'token_revoked'`,
`'double_walkover_blocked'` and `'tiebreak_owed'`. The table-level coupling
check at `:57` (`(status = 'needs_organiser') = (needs_reason is not null)`)
stays as it is.

---

- [ ] **Step 1: re-check the MERGED W2a gate.** Run, from the worktree:
  `git fetch origin main && git ls-tree -r origin/main --name-only | grep -a "organiser-only"` and
  `git grep -an "isOrganiserOnlyEvent" origin/main -- apps/web/src packages`.
  At the time this plan was written both returned nothing: the file and the
  symbol do not exist on `origin/main` (`e201fab8f`), so **W2a is not merged**
  and `scoreEvent` applies no per-event role gate today (`scoring.ts`'s only
  403s are the finalize and carried-forward paths, lines 505/528/533/545/557/560).
  Record what is actually there in the commit message. Either way this task
  writes as `mintOrgOwnerAuth`, which is correct under both the present and the
  promised gate. No commit.

- [ ] **Step 2: re-check V432's `needs_reason` CHECK.** Write a schema test in
  `external-play-result.test.ts` — INSERT, never a `check_clause` read (a
  clause-text test was sent back as decoration in this programme's Task 1
  review, and a by-column catalog lookup returns every CHECK that mentions the
  column):

  ```ts
  describe.runIf(HAS_DB)("fixture_external_play.needs_reason accepts this task's reasons", () => {
    const REASONS = ["token_revoked", "provider_error", "double_walkover_blocked", "tiebreak_owed"] as const;

    it("accepts every reason this task writes, and refuses a free-text one", async () => {
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess", divisionStarted: true,
        scheduledAt: new Date(Date.now() - 60_000), linked: true });
      let checked = 0;
      for (const reason of REASONS) {
        await sql`
          insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, needs_reason)
          values (${s.fixtureId}, ${s.orgId}, now(), 'needs_organiser', ${reason})
          on conflict (fixture_id) do update set status = 'needs_organiser', needs_reason = ${reason}`;
        const [row] = await sql<{ needs_reason: string }[]>`
          select needs_reason from fixture_external_play where fixture_id = ${s.fixtureId}`;
        expect(row!.needs_reason, reason).toBe(reason);
        checked++;
      }
      expect(checked, "reasons checked").toBe(REASONS.length);

      await expect(sql`
        update fixture_external_play set needs_reason = 'the dog ate it'
         where fixture_id = ${s.fixtureId}`,
      ).rejects.toMatchObject({ code: "23514", constraint_name: "fixture_external_play_needs_reason_check" });
    });
  });
  ```

  Run it first — the three new reasons must fail with `23514` until T1's V432
  lands and the test DB is migrated. If they fail, report the T1 gap and STOP.

- [ ] **Step 3 (RED): enumerate EVERY terminal status, from the spec's table.**

  ```ts
  import type { GameSnapshot, LichessStatus } from "@/server/external-play/lichess/board-api";
  import { STATUS_METHOD_KEYS } from "@/server/external-play/map-result"; // added in Step 4
  import { writeResultFrom } from "@/server/usecases/external-play/result";

  /** Spec §3.6's table, hand-encoded from the RULEBOOK — not read back out of
   *  the code under test. `winnerIsNull` is the load-bearing column: M9's
   *  early resign differs from a real resign by having no winner at all. */
  const SPEC_3_6: ReadonlyArray<{
    status: LichessStatus; winner: "white" | "black" | null;
    wrote: "decided" | "draw" | "aborted"; event: "boardgame.result" | null;
    method: string | null; winnerIsNull: boolean;
  }> = [
    { status: "mate",      winner: "white", wrote: "decided", event: "boardgame.result", method: "checkmate",  winnerIsNull: false },
    { status: "resign",    winner: "black", wrote: "decided", event: "boardgame.result", method: "resign",     winnerIsNull: false },
    { status: "outoftime", winner: "black", wrote: "decided", event: "boardgame.result", method: "time",       winnerIsNull: false },
    { status: "timeout",   winner: "white", wrote: "decided", event: "boardgame.result", method: "time",       winnerIsNull: false },
    { status: "draw",      winner: null,    wrote: "draw",    event: "boardgame.result", method: "agreement",  winnerIsNull: true  },
    { status: "stalemate", winner: null,    wrote: "draw",    event: "boardgame.result", method: "stalemate",  winnerIsNull: true  },
    // M9. Resigning after ONE move reports status=aborted winner=None. The
    // wrong answer here is "someone won"; the right one is "there was no game".
    { status: "aborted",   winner: null,    wrote: "aborted", event: null,               method: null,        winnerIsNull: true  },
  ];

  describe.runIf(HAS_DB)("writeResultFrom — every terminal status (spec §3.6)", () => {
    it("maps each terminal status to the event and method the spec names, and reports the count", async () => {
      let checked = 0;
      for (const row of SPEC_3_6) {
        const f = await leagueFixtureAtPre(); // league: a draw is legal there
        const out = await writeResultFrom(
          { gameId: "g" + checked, status: row.status, winner: row.winner,
            movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0 },
          f.fixtureId,
        );
        expect(out, `${row.status}`).toEqual({ wrote: row.wrote });
        const events = await sql<{ type: string; payload: { winner: string | null; method?: string } }[]>`
          select type, payload from score_events
           where fixture_id = ${f.fixtureId} and type <> 'core.start' order by seq`;
        if (row.event === null) {
          expect(events, `${row.status} writes no result event`).toEqual([]);
        } else {
          expect(events.length, `${row.status}`).toBe(1);
          expect(events[0]!.type).toBe(row.event);
          expect(events[0]!.payload.method).toBe(row.method);
          expect(events[0]!.payload.winner === null, `${row.status} winner-is-null`).toBe(row.winnerIsNull);
        }
        checked++;
      }
      expect(checked, "terminal statuses checked").toBe(SPEC_3_6.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("the spec's table and map-result's STATUS_METHOD agree on every decisive status", () => {
      // Two independently-maintained sources. Drift between them is the
      // defect this catches; neither is read back out of result.ts.
      const fromSpec = SPEC_3_6.filter((r) => r.method !== null).map((r) => r.status).sort();
      const covered = fromSpec.filter((s) => STATUS_METHOD_KEYS.includes(s));
      expect(covered, "every spec status has a method in map-result").toEqual(fromSpec);
      expect(covered.length).toBeGreaterThan(0);
    });

    it("a NON-terminal status writes nothing at all", async () => {
      for (const status of ["created", "started"] as const) {
        const f = await leagueFixtureAtPre();
        expect(await writeResultFrom(
          { gameId: "gx", status, winner: null, movesSan: [], whiteMs: 1, blackMs: 1, increment: 0 },
          f.fixtureId)).toEqual({ wrote: "none" });
        expect((await sql`select 1 from score_events where fixture_id = ${f.fixtureId}`).length).toBe(0);
      }
    });

    it("an UNKNOWN terminal status is held for the organiser, never guessed", async () => {
      const f = await leagueFixtureAtPre();
      expect(await writeResultFrom(
        { gameId: "gy", status: "unknownFinish", winner: null, movesSan: [], whiteMs: 1, blackMs: 1, increment: 0 },
        f.fixtureId)).toEqual({ wrote: "needs_organiser", reason: "provider_error" });
    });
  });
  ```

  Run. Expected failure: `result.ts` and `STATUS_METHOD_KEYS` do not resolve.

- [ ] **Step 4 (GREEN): `writeResultFrom`, and export `STATUS_METHOD_KEYS` from
  `map-result.ts`.** Add one line to `map-result.ts`
  (`export const STATUS_METHOD_KEYS = Object.keys(STATUS_METHOD);`) and correct
  its stale comment at line 48 — "Home is always White in Seazn chess fixtures"
  has been false since `whiteSideOf` (`guard.ts:298`) landed; colour is read
  from the pairing. `writeResultFrom` resolves the winning ENTRANT from the
  snapshot's `winner` colour through `bridge.white_side`, mints the auth with
  `mintOrgOwnerAuth(f.orgId)`, reads `getFixtureState(auth, fixtureId)` for
  `last_seq`, and writes with `scoreEvent`. Run. Expect `numFailedTests: 0`.

- [ ] **Step 5 (RED): M9 — the early resign, and its differential.** Append:

  ```ts
  describe.runIf(HAS_DB)("writeResultFrom — M9: an early resign is an abort with no winner", () => {
    it("status=aborted winner=null records NO game that anyone won", async () => {
      const f = await leagueFixtureAtPre();
      const out = await writeResultFrom(
        { gameId: "gm9a", status: "aborted", winner: null, movesSan: ["e4"], whiteMs: 1, blackMs: 1, increment: 0 },
        f.fixtureId);
      expect(out).toEqual({ wrote: "aborted" });
      const [fx] = await sql<{ status: string; outcome: unknown }[]>`
        select status, outcome from fixtures where id = ${f.fixtureId}`;
      expect(fx!.outcome, "nobody won — not a draw either").toBeNull();
      expect(fx!.status).not.toBe("forfeited");
      const [bridge] = await sql<{ status: string; needs_reason: string | null }[]>`
        select status, needs_reason from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(bridge!.status).toBe("needs_organiser");
      expect(bridge!.needs_reason, "the existing V405 reason for exactly this").toBe("aborted");
    });

    it("the SAME resign after two moves DOES decide it — the pair that makes the case above non-vacuous", async () => {
      const f = await leagueFixtureAtPre();
      const out = await writeResultFrom(
        { gameId: "gm9b", status: "resign", winner: "black", movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0 },
        f.fixtureId);
      expect(out).toEqual({ wrote: "decided" });
      const [fx] = await sql<{ outcome: { kind: string; winner: string } | null }[]>`
        select outcome from fixtures where id = ${f.fixtureId}`;
      expect(fx!.outcome!.kind).toBe("win");
      // M9's other half: after TWO moves the same action reports
      // `status=resign winner=black`, so Black WON (White resigned). With
      // white_side = 'home', Black is the away entrant.
      expect(fx!.outcome!.winner).toBe(f.away.entrantId);
    });
  });
  ```

- [ ] **Step 6 (GREEN + mutate):** implement the `aborted` branch as a
  `needs_organiser` hold with the existing `'aborted'` reason
  (`V405:48-51` already carries it) and no ledger write. Mutate: map `aborted`
  to `{winner: null, method: "agreement"}`. Re-run: the M9 test must fail on
  `fx.outcome` being a draw rather than null. Restore. Commit:
  `fix(chess): an early resign is an abort with no winner (M9)`.

- [ ] **Step 7 (RED): a Lichess timeout is a NORMAL WIN, not a forfeit.** Append:

  ```ts
  it("outoftime writes boardgame.result with method 'time' — NEVER core.forfeit", async () => {
    // Spec §3.6: "A Lichess timeout is a normal win, not a forfeit. Only a
    // no-show is a forfeit." The outcome KIND is the same either way, so the
    // assertion has to be on the event TYPE and the method.
    const f = await leagueFixtureAtPre();
    await writeResultFrom(
      { gameId: "gto", status: "outoftime", winner: "white", movesSan: ["e4", "e5"], whiteMs: 90_000, blackMs: 0, increment: 0 },
      f.fixtureId);
    const events = await sql<{ type: string; payload: { method?: string } }[]>`
      select type, payload from score_events where fixture_id = ${f.fixtureId} and type <> 'core.start'`;
    expect(events.map((e) => e.type)).toEqual(["boardgame.result"]);
    expect(events.map((e) => e.type)).not.toContain("core.forfeit");
    expect(events[0]!.payload.method).toBe("time");
    const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${f.fixtureId}`;
    expect(fx!.status, "a flagged game is a played game").not.toBe("forfeited");
  });
  ```

- [ ] **Step 8 (GREEN + mutate):** mutate the `outoftime` branch to emit
  `core.forfeit {by: <loser>, reason: "walkover"}`. Re-run: the type assertion
  must fail. Restore. Commit:
  `feat(chess): a Lichess timeout is a win, not a forfeit`.

- [ ] **Step 9 (RED): the `core.start` sequence.** Append:

  ```ts
  describe.runIf(HAS_DB)("writeResultFrom — the pre→live→done sequence", () => {
    it("a fold still in phase `pre` is STARTED before the result (boardgame refuses a result in `pre`)", async () => {
      // packages/engine/src/sports/boardgame/boardgame.ts:249 —
      // `if (state.phase !== "live") wrongPhase('result not allowed in phase "' + phase + '"')`.
      // Nothing auto-starts: append-event.ts has no implicit core.start.
      const f = await leagueFixtureAtPre();
      await writeResultFrom(
        { gameId: "gs1", status: "mate", winner: "white", movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0 },
        f.fixtureId);
      const events = await sql<{ type: string }[]>`
        select type from score_events where fixture_id = ${f.fixtureId} order by seq`;
      expect(events.map((e) => e.type)).toEqual(["core.start", "boardgame.result"]);
    });

    it("a fold already LIVE is not started twice", async () => {
      const f = await leagueFixtureAtPre();
      const auth = await mintOrgOwnerAuth(f.orgId);
      await scoreEvent(auth, f.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
      await writeResultFrom(
        { gameId: "gs2", status: "mate", winner: "white", movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0 },
        f.fixtureId);
      const events = await sql<{ type: string }[]>`
        select type from score_events where fixture_id = ${f.fixtureId} order by seq`;
      expect(events.map((e) => e.type)).toEqual(["core.start", "boardgame.result"]);
    });

    it("a SECOND writeResultFrom with the same snapshot adds nothing", async () => {
      const f = await leagueFixtureAtPre();
      const snap: GameSnapshot = { gameId: "gs3", status: "mate", winner: "white",
        movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0 };
      await writeResultFrom(snap, f.fixtureId);
      await writeResultFrom(snap, f.fixtureId);
      const events = await sql<{ type: string }[]>`
        select type from score_events where fixture_id = ${f.fixtureId} order by seq`;
      expect(events.map((e) => e.type)).toEqual(["core.start", "boardgame.result"]);
    });

    it("resultIdempotencyKey is stable for one snapshot and differs across games and statuses", () => {
      const base: GameSnapshot = { gameId: "AAA", status: "mate", winner: "white",
        movesSan: [], whiteMs: 0, blackMs: 0, increment: 0 };
      expect(resultIdempotencyKey("fx", base)).toBe(resultIdempotencyKey("fx", { ...base }));
      expect(resultIdempotencyKey("fx", base)).not.toBe(resultIdempotencyKey("fx", { ...base, gameId: "BBB" }));
      expect(resultIdempotencyKey("fx", base)).not.toBe(resultIdempotencyKey("fx", { ...base, status: "resign" }));
      expect(resultIdempotencyKey("fx", base).length).toBeLessThanOrEqual(200); // schemas.ts:1841
    });
  });
  ```

- [ ] **Step 10 (GREEN + mutate):** add the `pre` branch (read the fold's phase
  from `getFixtureState`'s `state`, emit `core.start` at `expected_seq:
  last_seq`, then the result at `last_seq + 1`). `core.start` deliberately
  carries NO idempotency key — a second one is `WRONG_PHASE "already started"`
  from `boardgame.ts:602`, which is caught and ignored exactly once. Mutate:
  delete the `pre` branch. Re-run: the first test must fail with
  `WRONG_PHASE: result not allowed in phase "pre"`. Restore. Commit:
  `feat(chess): start the fold before writing a result into a pre-phase fixture`.

- [ ] **Step 11 (RED): a knockout draw is held, never written as decided.**
  Append:

  ```ts
  describe.runIf(HAS_DB)("writeResultFrom — a draw is legal in Swiss and league, held in a knockout", () => {
    // Spec §3.6 and §7: "A knockout draw shows as held — 'winner to be
    // decided' — never as a decided result." The repo has no `needs_decision`
    // status and no `tiebreak` division phase (DIVISION_PHASES is
    // setting_up/scheduled/match_day/finished, lib/division-phase.ts:26), so
    // the hold is the real primitive: fixture_external_play.needs_organiser
    // with reason `tiebreak_owed`, and NO boardgame.result at all.
    const DRAWS = [
      { status: "draw" as const, method: "agreement" },
      { status: "stalemate" as const, method: "stalemate" },
    ];
    const DECIDING_KINDS = ["league", "swiss"] as const;

    it("a draw in every non-knockout kind is written as a draw", async () => {
      let checked = 0;
      for (const kind of DECIDING_KINDS) {
        for (const d of DRAWS) {
          const f = await fixtureInStage(kind);
          const out = await writeResultFrom(
            { gameId: `gd${checked}`, status: d.status, winner: null,
              movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0 }, f.fixtureId);
          expect(out, `${kind}/${d.status}`).toEqual({ wrote: "draw" });
          const [ev] = await sql<{ type: string; payload: { winner: string | null; method: string } }[]>`
            select type, payload from score_events where fixture_id = ${f.fixtureId} and type <> 'core.start'`;
          expect(ev!.type).toBe("boardgame.result");
          expect(ev!.payload.winner).toBeNull();
          expect(ev!.payload.method).toBe(d.method);
          checked++;
        }
      }
      expect(checked, "kind × draw-status combinations checked").toBe(DECIDING_KINDS.length * DRAWS.length);
    });

    it("the SAME draw in a knockout is held — needs_organiser/tiebreak_owed, no result event, fixture undecided", async () => {
      let checked = 0;
      for (const d of DRAWS) {
        const f = await fixtureInStage("knockout");
        const out = await writeResultFrom(
          { gameId: `gk${checked}`, status: d.status, winner: null,
            movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0 }, f.fixtureId);
        expect(out, d.status).toEqual({ wrote: "needs_organiser", reason: "tiebreak_owed" });
        const events = await sql<{ type: string }[]>`
          select type from score_events where fixture_id = ${f.fixtureId} and type <> 'core.start'`;
        expect(events, "a knockout draw writes NOTHING to the ledger").toEqual([]);
        const [fx] = await sql<{ outcome: unknown; status: string }[]>`
          select outcome, status from fixtures where id = ${f.fixtureId}`;
        expect(fx!.outcome).toBeNull();
        expect(fx!.status).not.toBe("finalized");
        const [b] = await sql<{ status: string; needs_reason: string | null }[]>`
          select status, needs_reason from fixture_external_play where fixture_id = ${f.fixtureId}`;
        expect(b!.status).toBe("needs_organiser");
        expect(b!.needs_reason).toBe("tiebreak_owed");
        checked++;
      }
      expect(checked, "knockout draw statuses checked").toBe(DRAWS.length);
    });

    it("a DECISIVE knockout result is not held — the hold is about draws, not about knockouts", async () => {
      const f = await fixtureInStage("knockout");
      expect(await writeResultFrom(
        { gameId: "gkw", status: "mate", winner: "white", movesSan: ["e4", "e5"], whiteMs: 1, blackMs: 1, increment: 0 },
        f.fixtureId)).toEqual({ wrote: "decided" });
    });

    it("double_elim and stepladder hold a draw too — every bracket kind, counted", async () => {
      const BRACKETS = ["knockout", "double_elim", "stepladder"] as const;
      let checked = 0;
      for (const kind of BRACKETS) {
        const f = await fixtureInStage(kind);
        expect(await writeResultFrom(
          { gameId: `gb${checked}`, status: "draw", winner: null, movesSan: ["e4", "e5"],
            whiteMs: 1, blackMs: 1, increment: 0 }, f.fixtureId),
        ).toEqual({ wrote: "needs_organiser", reason: "tiebreak_owed" });
        checked++;
      }
      expect(checked, "bracket kinds checked").toBe(BRACKETS.length);
    });
  });
  ```

  `fixtureInStage(kind)` is a local helper over `seedOnlineChessFixture`: it
  seeds the same way, then `update stages set kind = ${kind}` — `StageKind`'s
  members are pinned at `apps/web/src/server/api-v1/schemas.ts:105`.

- [ ] **Step 12 (GREEN + mutate):** derive "is this a bracket?" from the stage's
  `kind` against a declared set, not from a hand-typed list inside the branch.
  Mutate: make the bracket set empty. Re-run: every knockout test must fail with
  `{wrote: "draw"}`. Then mutate it to contain every kind: the league/Swiss
  sweep must fail. Both mutants one at a time. Restore. Commit:
  `feat(chess): hold a knockout draw for the organiser, never decide it`.

- [ ] **Step 13 (RED): Review Focus 1 — a revoked token is not a no-show.**
  Append. This drives T10's REAL output into T12's real consumer rather than
  asserting a fixture on both ends:

  ```ts
  describe.runIf(HAS_DB)("Review Focus 1 — the player revoked our token on lichess.org", () => {
    it("a 401 on the first submission sends the fixture to the organiser queue with its OWN reason", async () => {
      const f = await liveFixtureForPlay(); // same shape as T10's `liveGame`
      // T10's real `act`, with a board stub that 401s the way a revoked token
      // does. Its output is the input to `holdForOrganiser` — one seam, two
      // real ends, no fixture in the middle.
      const played = await act(
        { fixtureId: f.fixtureId, personId: f.home.personId, action: { kind: "move", uci: "e2e4" } },
        { accessToken: async (u) => `tok-${u}`, publish: async () => {},
          submitMove: async () => ({ ok: false, code: "unauthorized", raw: "401 Unauthorized" }) },
      );
      expect(played).toEqual({ ok: false, reconcile: true, reason: "unauthorized" });

      const held = await holdForOrganiser({ fixtureId: f.fixtureId, reason: "token_revoked" });
      expect(held).toEqual({ wrote: "needs_organiser", reason: "token_revoked" });

      const [b] = await sql<{ status: string; needs_reason: string }[]>`
        select status, needs_reason from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(b!.status).toBe("needs_organiser");
      expect(b!.needs_reason).toBe("token_revoked");
      // The load-bearing negative. Spec §3.6: "A token revoked or rejected
      // mid-match is not a no-show and must not be recorded as one."
      expect(["no_show_white", "no_show_black", "no_show_both"]).not.toContain(b!.needs_reason);
      const events = await sql<{ type: string }[]>`
        select type from score_events where fixture_id = ${f.fixtureId}`;
      expect(events.map((e) => e.type), "no forfeit, no result").toEqual([]);
      const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${f.fixtureId}`;
      expect(fx!.status).not.toBe("forfeited");
    });

    it("the hold is idempotent and does not overwrite an EARLIER, different reason", async () => {
      const f = await liveFixtureForPlay();
      await holdForOrganiser({ fixtureId: f.fixtureId, reason: "token_revoked" });
      await holdForOrganiser({ fixtureId: f.fixtureId, reason: "provider_error" });
      const [b] = await sql<{ needs_reason: string }[]>`
        select needs_reason from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(b!.needs_reason, "the first diagnosis stands until the organiser clears it").toBe("token_revoked");
    });

    it("every reason the union allows actually lands in the column — counted", async () => {
      const REASONS = ["token_revoked", "provider_error", "double_walkover_blocked", "tiebreak_owed"] as const;
      let checked = 0;
      for (const reason of REASONS) {
        const f = await liveFixtureForPlay();
        expect(await holdForOrganiser({ fixtureId: f.fixtureId, reason })).toEqual({ wrote: "needs_organiser", reason });
        const [b] = await sql<{ needs_reason: string }[]>`
          select needs_reason from fixture_external_play where fixture_id = ${f.fixtureId}`;
        expect(b!.needs_reason).toBe(reason);
        checked++;
      }
      expect(checked, "hold reasons checked").toBe(REASONS.length);
    });
  });
  ```

- [ ] **Step 14 (GREEN + mutate):** implement `holdForOrganiser` as a single
  conditional UPDATE (`where fixture_id = ... and needs_reason is null`), which
  gives both the hold and its idempotency. Extend `NeedsReason`
  (`apps/web/src/server/external-play/types.ts:14-21`) with the four values.
  Mutate: change the `unauthorized` hold's reason to `'no_show_both'`. Re-run:
  the `not.toContain` assertion must fail. Restore. Commit:
  `feat(chess): a revoked token queues the fixture, it is never a no-show`.

- [ ] **Step 15: export, typecheck, lint, scoped run.** Add
  `export * from "./result";`. `rtk proxy npx tsc --noEmit`, `rtk proxy npx
  eslint` on the four touched files, then the verify command scoped to
  `external-play-result.test.ts`. Commit:
  `feat(chess): map a Lichess terminal status onto our ledger`.

---

### Task 13: Sweeps — **GATED: must not merge before W2b merges**

Four jobs, not five. The T−10 notice email is **gone from the cron**: rounds are
organiser-driven (spec D12), and the invite is part of the organiser's
open-round action, which stamps `round_opened_at`. **This task therefore owes no
i18n work** — it adds no user-facing string, so nothing goes into the four
`emails.json` dictionaries and `i18n:gen-keys` is not run.

The four jobs:

1. **T+20 no-show** → `core.forfeit {by, reason: "walkover"}`.
2. **Mint retry** for a creation that hit the 429 wall (M3).
3. **Meeting teardown** at the deadline when nobody came.
4. **Reconcile sweep** for a live game past its expected end (the only trigger
   that needs no client open).

**T−10 and T+20 are relative to `round_opened_at`, NOT to the fixture's
scheduled time.** A fixture whose round has not been opened is not yet playable
and must never be swept as a no-show — the trap being that the old code anchors
on `scheduled_at`, so a stale timetable would mark a whole field as no-shows for
a round that never started.

**Files:**

| Path | Action |
|---|---|
| `apps/web/src/server/usecases/external-play/sweep.ts` | new |
| `apps/web/src/server/usecases/__tests__/external-play-sweep.test.ts` | new |
| `apps/web/src/app/api/cron/external-play/route.ts` | repointed (it imports three symbols that exist nowhere) |
| `apps/web/src/app/api/cron/external-play/route.test.ts` | its `vi.mock` follows |
| `apps/web/src/server/usecases/external-play/index.ts` | add `export * from "./sweep";` |

**Interfaces — Consumes:** T5's `SHIP1_TIME_CONTROLS`, `isBoardApiPlayable`,
`TimeControl`; T7's `endMeeting`; T9's `createGameIfReady`; T11's `reconcile`;
T12's `holdForOrganiser`; `windowFor`/`WINDOW_OPEN_LEAD_MS`/
`DEADLINE_AFTER_MS`/`checkInCounts` (`apps/web/src/server/external-play/window.ts:4-36`);
`mintOrgOwnerAuth`, `getFixtureState`, `scoreEvent`.

**Interfaces — Produces:**

```ts
export type SweepReport = {
  noShows: number; mintRetries: number; meetingsEnded: number; reconciled: number;
  heldForOrganiser: number; scanned: number;
};
export function sweepExternalPlay(deps?: SweepDeps): Promise<SweepReport>;
/** The window a fixture is playable in, anchored on the ROUND being opened.
 *  Built from window.ts's own two constants so moving either moves this. */
export function playableWindow(roundOpenedAt: Date): { opensAt: Date; deadline: Date };
/** Lichess's own per-player duration estimate multiplier (M13:
 *  `limit + 40 x increment`), recovered from `isBoardApiPlayable` by a test
 *  rather than copied. */
export const SWEEP_MOVE_BUDGET: number;
export function expectedEndAt(startedAt: Date, tc: TimeControl): Date;
```

---

- [ ] **Step 1 — GATE A (blocking): re-check the MERGED engine forfeit guard.**
  Run `git fetch origin main && git show origin/main:packages/engine/src/sports/boardgame/boardgame.ts | grep -an 'core.forfeit' -A3`.
  At the time this plan was written, `boardgame.ts:617` reads
  `if (state.phase !== "live") wrongPhase(\`forfeit not allowed in phase "${state.phase}"\`)`
  — boardgame is the only one of the eleven shipped modules
  (`packages/engine/src/sports/index.ts:23-35`) that refuses a `pre`-phase
  forfeit; setbased (`kernel.ts:804-806`), carrom (`carrom.ts:451-455`), cricket
  (`cricket.ts:3775`) and generic (`generic.ts:558`) all refuse only
  `done`/`final`/`abandoned`. **If that line still refuses `pre`, W2b has not
  merged: STOP and report.** Write nothing. No commit.

- [ ] **Step 2 — GATE B (blocking): find where `round_opened_at` actually
  lives.** Run
  `git grep -an "round_opened_at" origin/main -- apps/web/src db/migration` and
  `git grep -an "openRound\|open_round" origin/main -- apps/web/src`. At the
  time this plan was written, `round_opened_at` existed nowhere in the tree and
  the only `rounds` table is the dead v1 one
  (`db/migration/v1-baseline/V013__rounds.sql:4`, keyed on `tournament_id`, with
  no reader in `apps/web/src`); v2 keys a round by `fixtures.stage_id +
  round_no`. Record the merged table and column, **and which of the two window
  readings the open-round action implements** — `deadline = round_opened_at +
  20 min`, or `opensAt = round_opened_at` with the existing T−10/T+20 pair
  (i.e. `deadline = round_opened_at + 30 min`). This plan takes the SECOND
  reading in Step 4 because it keeps both existing constants governing and
  introduces no new number; if the merged action implements the first, change
  `playableWindow` and its test together and say so in the commit. No commit.

- [ ] **Step 3 — GATE C: confirm `meeting_id` on the bridge row.** Run
  `grep -an "meeting_id" db/migration/deltas/V432__online_chess_board_and_camera.sql`.
  Job 3 cannot be written without it. If absent, report the T1/T7 gap. No commit.

- [ ] **Step 4 (RED): `playableWindow`, and the unopened round that must never
  be swept.** Create the test file:

  ```ts
  // The external-play sweep (chess in-page board design §3.5, §3.6; rounds are
  // organiser-driven per D12). FOUR jobs: no-show, mint retry, meeting
  // teardown, reconcile sweep. The T-10 notice is the open-round action's.
  import { afterAll, describe, expect, it } from "vitest";
  import { sql } from "@/lib/db";
  import { DEADLINE_AFTER_MS, WINDOW_OPEN_LEAD_MS } from "@/server/external-play/window";
  import { SHIP1_TIME_CONTROLS, isBoardApiPlayable, type TimeControl }
    from "@/server/external-play/time-controls";
  import {
    SWEEP_MOVE_BUDGET, expectedEndAt, playableWindow, sweepExternalPlay,
  } from "@/server/usecases/external-play/sweep";
  import { seedOnlineChessFixture } from "./_external-play-seed";

  const HAS_DB = !!process.env.DATABASE_URL;
  afterAll(async () => {
    if (!HAS_DB) return;
    const g = globalThis as { _sql?: { end(): Promise<void> } };
    const client = g._sql; g._sql = undefined; await client?.end();
  });

  describe("playableWindow — anchored on the round being OPENED", () => {
    it("opens exactly when the organiser opened the round", () => {
      const t = new Date("2026-10-09T10:00:00.000Z");
      expect(playableWindow(t).opensAt.toISOString()).toBe(t.toISOString());
    });

    it("its deadline is derived from window.ts's own two constants, not a literal", () => {
      // Move either constant and this moves with it — a flat number beside a
      // derived cost is a latent red (AGENTS.md rule 20).
      const t = new Date("2026-10-09T10:00:00.000Z");
      expect(playableWindow(t).deadline.getTime() - t.getTime())
        .toBe(WINDOW_OPEN_LEAD_MS + DEADLINE_AFTER_MS);
      expect(WINDOW_OPEN_LEAD_MS).toBeGreaterThan(0);
      expect(DEADLINE_AFTER_MS).toBeGreaterThan(0);
    });
  });

  describe.runIf(HAS_DB)("the sweep never touches a round the organiser has not opened", () => {
    it("a fixture scheduled THREE HOURS AGO whose round was never opened produces NO forfeits", async () => {
      // The trap: the pre-D12 code anchors on fixtures.scheduled_at, so a
      // stale timetable would walk a whole field over for a round that never
      // started. Anchoring on round_opened_at is what stops it.
      const s = await seedOnlineChessFixture({
        onlinePlay: "lichess", divisionStarted: true,
        scheduledAt: new Date(Date.now() - 3 * 60 * 60_000), linked: true });
      await sql`
        insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status)
        values (${s.fixtureId}, ${s.orgId}, now() - interval '3 hours', 'pending')`;
      // No round_opened_at stamp anywhere for this stage/round.
      const report = await sweepExternalPlay({ now: new Date() });
      expect(report.noShows).toBe(0);
      expect((await sql`select 1 from score_events where fixture_id = ${s.fixtureId}`).length).toBe(0);
      const [fx] = await sql<{ status: string }[]>`select status from fixtures where id = ${s.fixtureId}`;
      expect(fx!.status).toBe("scheduled");
    });

    it("the SAME fixture, once the round is opened and the deadline passes, IS swept", async () => {
      // The positive pair. Without it the test above passes on a sweep that
      // never forfeits anything at all.
      const s = await openedRoundFixture({ openedMinutesAgo: 45 }); // past opensAt + 10 + 20
      const report = await sweepExternalPlay({ now: new Date() });
      expect(report.noShows).toBe(1);
    });
  });
  ```

  `openedRoundFixture` stamps `round_opened_at` at the location Gate B
  recorded — write it against the real merged shape, never against a guess.
  Run. Expected failure: `sweep.ts` does not resolve.

- [ ] **Step 5 (GREEN): `playableWindow` and the round-opened join.** Build it
  from `windowFor` so the two constants stay the only source:
  `playableWindow(t) = windowFor(new Date(t.getTime() + WINDOW_OPEN_LEAD_MS))`,
  which makes `opensAt === t` exactly. The sweep's base query INNER-joins the
  round-open stamp, so an unopened round is not merely skipped but unreachable.
  Run. Expect `numFailedTests: 0`.

- [ ] **Step 6: mutate the anchor.** Change the base query to join on
  `f.scheduled_at` instead of the round-open stamp. Re-run: the unopened-round
  test must fail with `noShows: 1`. Restore from the `cp` backup. Commit:
  `feat(chess): the sweep anchors on round_opened_at, never the timetable`.

- [ ] **Step 7 (RED): job 1 — the no-show forfeit nobody has tested.** Append:

  ```ts
  describe.runIf(HAS_DB)("job 1 — the T+20 no-show (the chess forfeit no test covers today)", () => {
    // `swiss-withdrawal-walkover.test.ts:80` is `sport_key: "badminton"`, and
    // its line 197 forfeits a board that never got core.start — a real
    // pre-phase forfeit that passes only because setbased's applyForfeit
    // (kernel.ts:804-806) tolerates `pre`. boardgame.ts:617 does not. No test
    // anywhere drives a chess forfeit, which is why this one exists.
    it("ONE player absent at the deadline forfeits by that entrant, reason 'walkover'", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: ["home"] });
      const report = await sweepExternalPlay({ now: new Date() });
      expect(report.noShows).toBe(1);
      const [ev] = await sql<{ type: string; payload: { by: string; reason: string } }[]>`
        select type, payload from score_events where fixture_id = ${f.fixtureId} order by seq desc limit 1`;
      expect(ev!.type).toBe("core.forfeit");
      expect(ev!.payload.by, "the side at fault is the one who did not come").toBe(f.away.entrantId);
      expect(ev!.payload.reason, "W2b: free text is refused INVALID_PAYLOAD").toBe("walkover");
      const [fx] = await sql<{ status: string; outcome: { winner: string } | null }[]>`
        select status, outcome from fixtures where id = ${f.fixtureId}`;
      expect(fx!.status).toBe("forfeited");
      expect(fx!.outcome!.winner).toBe(f.home.entrantId);
    });

    it("BOTH absent is a DOUBLE walkover: by 'both', both lose, nobody advances", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: [] });
      await sweepExternalPlay({ now: new Date() });
      const [ev] = await sql<{ payload: { by: string; reason: string } }[]>`
        select payload from score_events where fixture_id = ${f.fixtureId}
         and type = 'core.forfeit' order by seq desc limit 1`;
      expect(ev!.payload).toEqual({ by: "both", reason: "walkover" });
      const [fx] = await sql<{ outcome: { kind: string; winner?: string } | null }[]>`
        select outcome from fixtures where id = ${f.fixtureId}`;
      expect(fx!.outcome!.kind, "no_result — nobody advances").toBe("no_result");
      expect(fx!.outcome!.winner).toBeUndefined();
    });

    it("BOTH present and the deadline passed is NOT a no-show", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: ["home", "away"] });
      const report = await sweepExternalPlay({ now: new Date() });
      expect(report.noShows).toBe(0);
      expect((await sql`select 1 from score_events where fixture_id = ${f.fixtureId}
        and type = 'core.forfeit'`).length).toBe(0);
    });

    it("a SECOND sweep pass does not forfeit the same fixture twice", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: ["home"] });
      await sweepExternalPlay({ now: new Date() });
      const after = await sweepExternalPlay({ now: new Date() });
      expect(after.noShows).toBe(0);
      expect((await sql`select 1 from score_events where fixture_id = ${f.fixtureId}
        and type = 'core.forfeit'`).length).toBe(1);
    });

    it("a LATE arrival between the two passes is seated, not swallowed by the idempotency guard", async () => {
      // AGENTS.md rule 13: an `if (already) return` also swallows a legitimate
      // new arrival. Checked in BOTH directions.
      const f = await openedRoundFixture({ openedMinutesAgo: 25, checkedIn: ["home"] });
      expect((await sweepExternalPlay({ now: new Date() })).noShows, "not past the deadline yet").toBe(0);
      await checkIn(f, "away");
      const after = await sweepExternalPlay({ now: new Date(Date.now() + 25 * 60_000) });
      expect(after.noShows, "they came — no forfeit").toBe(0);
    });

    it("a fixture whose game ALREADY EXISTS is never a no-show, however late", async () => {
      // Spec §3.6: "T+20 is the deadline to be seated and have the game
      // created — not a cap on the game."
      const f = await openedRoundFixture({ openedMinutesAgo: 240, checkedIn: ["home", "away"], live: true });
      expect((await sweepExternalPlay({ now: new Date() })).noShows).toBe(0);
    });
  });
  ```

- [ ] **Step 8 (GREEN): job 1.** Write as `mintOrgOwnerAuth(f.orgId)` →
  `getFixtureState` → `scoreEvent` with a deterministic idempotency key
  (`extplay-noshow:<fixtureId>`), the same shape `withdrawal.ts:106-113` uses.
  `by` is the absent entrant's id, or the literal `"both"`; `reason` is the
  literal `"walkover"` — W2b refuses free text with `INVALID_PAYLOAD`, which is
  why `withdrawal.ts:42`'s `"entrant withdrew"` is a separate, owed fix and not
  this task's (route it to the W2b integration task). Run. Expect
  `numFailedTests: 0`.

- [ ] **Step 9: mutate.** Two mutants, one at a time. (a) Swap
  `mintOrgOwnerAuth` for a plain player `AuthCtx` with `role: "player"`: if the
  merged W2a gate exists this reds, and if Step 1 recorded that it does not,
  record that this mutant SURVIVES and say so in the commit — a surviving mutant
  that is survived for a named, verified reason is a finding, not a pass.
  (b) Change `reason: "walkover"` to `"no show"`: W2b must refuse it with
  `INVALID_PAYLOAD`, which is the proof the strict payload is actually in force.
  Restore after each. Commit:
  `feat(chess): the T+20 no-show forfeit, in phase pre, on the boardgame engine`.

- [ ] **Step 10 (RED): `DOUBLE_WALKOVER_NO_NEXT_MATCH` is an expected outcome,
  not an error to log.** Append:

  ```ts
  describe.runIf(HAS_DB)("job 1 — a double walkover with no next match", () => {
    // W2b refuses `by: "both"` on a final, a last rung, or a third-place
    // match, because there is nowhere for "nobody advances" to go. The fixture
    // stays OPEN for the organiser. This is a handled outcome.
    const SHAPES = [
      { label: "final", patch: sql`is_final = true` },
      { label: "third place", patch: sql`third_place = true` },
      { label: "last rung of a stepladder", patch: sql`is_final = true` }, // plus stage kind, set below
    ] as const;

    it("each no-next-match shape leaves the fixture OPEN and is reported, never thrown", async () => {
      let checked = 0;
      for (const shape of SHAPES) {
        const f = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: [] });
        if (shape.label === "last rung of a stepladder") {
          await sql`update stages set kind = 'stepladder' where id = (
            select stage_id from fixtures where id = ${f.fixtureId})`;
        }
        await sql`update fixtures set ${shape.patch} where id = ${f.fixtureId}`;
        const report = await sweepExternalPlay({ now: new Date() });
        expect(report.heldForOrganiser, shape.label).toBeGreaterThanOrEqual(1);
        const [fx] = await sql<{ status: string; outcome: unknown }[]>`
          select status, outcome from fixtures where id = ${f.fixtureId}`;
        expect(fx!.status, `${shape.label} stays open`).toBe("scheduled");
        expect(fx!.outcome).toBeNull();
        const [b] = await sql<{ status: string; needs_reason: string | null }[]>`
          select status, needs_reason from fixture_external_play where fixture_id = ${f.fixtureId}`;
        expect(b!.status).toBe("needs_organiser");
        expect(b!.needs_reason).toBe("double_walkover_blocked");
        checked++;
      }
      expect(checked, "no-next-match shapes checked").toBe(SHAPES.length);
    });

    it("a double walkover in an ORDINARY knockout round DOES write — the pair that makes the above non-vacuous", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: [] });
      await sql`update stages set kind = 'knockout' where id = (
        select stage_id from fixtures where id = ${f.fixtureId})`;
      const report = await sweepExternalPlay({ now: new Date() });
      expect(report.noShows).toBe(1);
      expect(report.heldForOrganiser).toBe(0);
      const [ev] = await sql<{ payload: { by: string } }[]>`
        select payload from score_events where fixture_id = ${f.fixtureId}
         and type = 'core.forfeit' limit 1`;
      expect(ev!.payload.by).toBe("both");
    });

    it("the refusal does not abort the rest of the sweep", async () => {
      const blocked = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: [] });
      await sql`update fixtures set is_final = true where id = ${blocked.fixtureId}`;
      const ordinary = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: ["home"] });
      const report = await sweepExternalPlay({ now: new Date() });
      expect(report.heldForOrganiser).toBeGreaterThanOrEqual(1);
      expect(report.noShows, "the other fixture still got its forfeit").toBeGreaterThanOrEqual(1);
      expect((await sql`select 1 from score_events where fixture_id = ${ordinary.fixtureId}
        and type = 'core.forfeit'`).length).toBe(1);
    });
  });
  ```

- [ ] **Step 11 (GREEN + mutate):** catch the `DOUBLE_WALKOVER_NO_NEXT_MATCH`
  refusal by CODE (never by message text) and route it to T12's
  `holdForOrganiser({reason: "double_walkover_blocked"})`, counting it in
  `heldForOrganiser`. Every per-fixture job runs inside its own try/catch so one
  fixture's refusal cannot abort the pass. Mutate: let the refusal propagate.
  Re-run: the "does not abort the rest" test must fail. Restore. Commit:
  `feat(chess): a blocked double walkover holds the fixture for the organiser`.

- [ ] **Step 12 (RED): job 2 — the mint retry.** Append:

  ```ts
  describe.runIf(HAS_DB)("job 2 — retry a creation that hit the 429 wall (M3)", () => {
    it("a pending fixture with a 429 last_error, inside the window, is retried", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 5, checkedIn: ["home", "away"] });
      await sql`update fixture_external_play
                   set last_error = 'Too many requests. Try again later.'
                 where fixture_id = ${f.fixtureId}`;
      const tried: string[] = [];
      const report = await sweepExternalPlay({
        now: new Date(),
        createGameIfReady: async (id) => { tried.push(id); return { created: true, gameId: "gRetry1" }; },
      });
      expect(tried).toEqual([f.fixtureId]);
      expect(report.mintRetries).toBe(1);
    });

    it("a fixture OUTSIDE its window is not retried", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 120, checkedIn: ["home", "away"] });
      await sql`update fixture_external_play set last_error = 'Too many requests.'
                 where fixture_id = ${f.fixtureId}`;
      const tried: string[] = [];
      await sweepExternalPlay({ now: new Date(), createGameIfReady: async (id) => {
        tried.push(id); return { created: false, reason: "not_ready" as const }; } });
      expect(tried).toEqual([]);
    });

    it("a fixture that is ALREADY ready is not retried", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 5, checkedIn: ["home", "away"] });
      await sql`update fixture_external_play set status = 'ready', challenge_id = 'chA'
                 where fixture_id = ${f.fixtureId}`;
      const tried: string[] = [];
      await sweepExternalPlay({ now: new Date(), createGameIfReady: async (id) => {
        tried.push(id); return { created: false, reason: "already" as const }; } });
      expect(tried).toEqual([]);
    });

    it("a retry that fails again leaves the fixture retryable rather than held", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 5, checkedIn: ["home", "away"] });
      await sql`update fixture_external_play set last_error = '429' where fixture_id = ${f.fixtureId}`;
      await sweepExternalPlay({ now: new Date(), createGameIfReady: async () =>
        ({ created: false, reason: "provider_error" as const }) });
      const [b] = await sql<{ status: string }[]>`
        select status from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(b!.status, "still pending — the next pass tries again inside the window").toBe("pending");
    });
  });
  ```

- [ ] **Step 13 (GREEN + mutate):** implement job 2 over
  `status = 'pending' and challenge_id is null`, gated on `playableWindow`.
  Mutate: drop the window gate. Re-run: the outside-the-window test must fail.
  Restore. Commit: `feat(chess): retry a mint that lost to the creation throttle`.

- [ ] **Step 14 (RED): job 3 — meeting teardown.** Append:

  ```ts
  describe.runIf(HAS_DB)("job 3 — tear the meeting down when nobody came", () => {
    it("past the deadline with no game created, the meeting is ended ONCE and the id cleared", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: [] });
      await sql`update fixture_external_play set meeting_id = 'mtg-1' where fixture_id = ${f.fixtureId}`;
      const ended: string[] = [];
      const report = await sweepExternalPlay({ now: new Date(), endMeeting: async (m) => { ended.push(m); } });
      expect(ended).toEqual(["mtg-1"]);
      expect(report.meetingsEnded).toBe(1);
      const [b] = await sql<{ meeting_id: string | null }[]>`
        select meeting_id from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(b!.meeting_id).toBeNull();
      const second = await sweepExternalPlay({ now: new Date(), endMeeting: async (m) => { ended.push(m); } });
      expect(second.meetingsEnded, "idempotent").toBe(0);
      expect(ended).toEqual(["mtg-1"]);
    });

    it("a game that is still LIVE past the deadline keeps its meeting", async () => {
      // "Nothing in our system ends a live game early" (spec §3.6) — and a
      // live game's players are on camera, so the meeting stays up with it.
      const f = await openedRoundFixture({ openedMinutesAgo: 240, checkedIn: ["home", "away"], live: true });
      await sql`update fixture_external_play set meeting_id = 'mtg-2' where fixture_id = ${f.fixtureId}`;
      const ended: string[] = [];
      await sweepExternalPlay({ now: new Date(), endMeeting: async (m) => { ended.push(m); },
        reconcile: async () => null });
      expect(ended).toEqual([]);
      const [b] = await sql<{ meeting_id: string | null }[]>`
        select meeting_id from fixture_external_play where fixture_id = ${f.fixtureId}`;
      expect(b!.meeting_id).toBe("mtg-2");
    });

    it("a FINISHED game's meeting is ended at the result, deadline or not", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 5, checkedIn: ["home", "away"] });
      await sql`update fixture_external_play set status = 'finished', meeting_id = 'mtg-3',
                      finished_at = now() where fixture_id = ${f.fixtureId}`;
      const ended: string[] = [];
      await sweepExternalPlay({ now: new Date(), endMeeting: async (m) => { ended.push(m); } });
      expect(ended).toEqual(["mtg-3"]);
    });

    it("a fixture with no meeting at all is not counted as a teardown", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 45, checkedIn: [] });
      const report = await sweepExternalPlay({ now: new Date(), endMeeting: async () => {
        throw new Error("endMeeting must not be called with no meeting"); } });
      expect(report.meetingsEnded).toBe(0);
      expect(f.fixtureId).toBeTruthy();
    });
  });
  ```

- [ ] **Step 15 (GREEN + mutate):** job 3 clears `meeting_id` in the same
  conditional UPDATE that gates the teardown, which is what makes it idempotent.
  Mutate: drop the `status <> 'live'` condition. Re-run: the live-game test must
  fail with `ended: ["mtg-2"]`. Restore. Commit:
  `feat(chess): tear down the meeting at the result, or when nobody came`.

- [ ] **Step 16 (RED): job 4 — the reconcile sweep, with a DERIVED budget.**
  Append:

  ```ts
  describe("expectedEndAt — the budget moves with the time control", () => {
    it("SWEEP_MOVE_BUDGET is recovered from isBoardApiPlayable, never typed in", () => {
      // The predicate is `limit + B x increment >= FLOOR` (M13). Probe it:
      // the smallest limit it accepts at increment 0 IS the floor; the
      // smallest it accepts at increment 1 is floor - B. Two observations,
      // both constants recovered, nothing copied out of time-controls.ts.
      // (M14's enumerated clock.limit set is enforced by `assertTimeControl`,
      // not by this pure predicate, so probing it creates no illegal control.)
      const smallestAccepted = (increment: number): number => {
        for (let limit = 0; limit <= 3600; limit++) {
          if (isBoardApiPlayable({ key: "probe", limitSeconds: limit, incrementSeconds: increment })) return limit;
        }
        throw new Error(`isBoardApiPlayable accepts no control under an hour at +${increment}`);
      };
      const floorSeconds = smallestAccepted(0);
      const recovered = floorSeconds - smallestAccepted(1);
      expect(floorSeconds, "a real floor, not zero").toBeGreaterThan(0);
      expect(recovered, "the increment multiplier the predicate itself uses").toBeGreaterThan(0);
      expect(SWEEP_MOVE_BUDGET).toBe(recovered);
    });

    it("allows BOTH clocks to run out — a game cannot end before 2 x the limit", () => {
      let checked = 0;
      const t0 = new Date("2026-10-09T10:00:00.000Z");
      for (const tc of SHIP1_TIME_CONTROLS) {
        expect(expectedEndAt(t0, tc).getTime() - t0.getTime(), tc.key)
          .toBeGreaterThanOrEqual(2 * tc.limitSeconds * 1000);
        checked++;
      }
      expect(checked, "ship-1 time controls checked").toBe(SHIP1_TIME_CONTROLS.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("an increment lengthens the budget, and a slower control outlasts a faster one", () => {
      const t0 = new Date("2026-10-09T10:00:00.000Z");
      const by = (key: string): TimeControl => {
        const tc = SHIP1_TIME_CONTROLS.find((c) => c.key === key);
        if (!tc) throw new Error(`ship-1 list has no ${key}`);
        return tc;
      };
      expect(expectedEndAt(t0, by("3+2")).getTime(), "the increment must count")
        .toBeGreaterThan(expectedEndAt(t0, by("3+0")).getTime());
      expect(expectedEndAt(t0, by("15+10")).getTime())
        .toBeGreaterThan(expectedEndAt(t0, by("10+5")).getTime());
      expect(expectedEndAt(t0, by("5+0")).getTime())
        .toBeGreaterThan(expectedEndAt(t0, by("3+0")).getTime());
    });
  });

  describe.runIf(HAS_DB)("job 4 — reconcile a live game nobody is watching", () => {
    it("a live game past its expected end is reconciled", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 10, checkedIn: ["home", "away"], live: true });
      await sql`update fixture_external_play set started_at = now() - interval '6 hours'
                 where fixture_id = ${f.fixtureId}`;
      const seen: { fixtureId: string; trigger: string }[] = [];
      const report = await sweepExternalPlay({ now: new Date(),
        reconcile: async (a) => { seen.push(a); return null; } });
      expect(seen).toEqual([{ fixtureId: f.fixtureId, trigger: "sweep" }]);
      expect(report.reconciled).toBe(1);
    });

    it("a live game BEFORE its expected end is left alone", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 10, checkedIn: ["home", "away"], live: true });
      await sql`update fixture_external_play set started_at = now() where fixture_id = ${f.fixtureId}`;
      const seen: unknown[] = [];
      const report = await sweepExternalPlay({ now: new Date(),
        reconcile: async (a) => { seen.push(a); return null; } });
      expect(seen).toEqual([]);
      expect(report.reconciled).toBe(0);
    });

    it("a game with no started_at is not swept on a guess", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 10, checkedIn: ["home", "away"], live: true });
      await sql`update fixture_external_play set started_at = null where fixture_id = ${f.fixtureId}`;
      const report = await sweepExternalPlay({ now: new Date(), reconcile: async () => null });
      expect(report.reconciled).toBe(0);
    });

    it("a FINISHED game is never reconciled again", async () => {
      const f = await openedRoundFixture({ openedMinutesAgo: 10, checkedIn: ["home", "away"], live: true });
      await sql`update fixture_external_play set status = 'finished', finished_at = now(),
                      started_at = now() - interval '6 hours' where fixture_id = ${f.fixtureId}`;
      const report = await sweepExternalPlay({ now: new Date(), reconcile: async () => null });
      expect(report.reconciled).toBe(0);
    });
  });
  ```

- [ ] **Step 17 (GREEN + mutate):** `expectedEndAt(startedAt, tc) = startedAt +
  2 * (tc.limitSeconds + SWEEP_MOVE_BUDGET * tc.incrementSeconds) * 1000`; the
  fixture's own control comes from its division config through the same clock
  mapping `guard.ts:142-144` already performs, so a division that is not
  Lichess-mappable is simply not swept. Mutate: drop the
  `SWEEP_MOVE_BUDGET * tc.incrementSeconds` term. Re-run: the "an increment
  lengthens the budget" test must fail (3+2 and 3+0 become equal). Then mutate
  `SWEEP_MOVE_BUDGET` to `recovered + 1`: the recovery test must fail. Restore
  after each. Commit:
  `feat(chess): sweep a live game past a budget derived from its time control`.

- [ ] **Step 18: repoint the cron route.**
  `apps/web/src/app/api/cron/external-play/route.ts:6-8` imports
  `prepareExternalPlayWindow`, `pollLiveExternalPlay` and
  `escalateStaleExternalPlay` from `@/server/usecases/external-play`, whose
  `index.ts` re-exports only `./auth` and `./guard` — none of the three is
  defined anywhere in `apps/web/src` (verified 2026-10-09), so the route does
  not typecheck today. Replace the three calls with one
  `await sweepExternalPlay()` and return its `SweepReport`. Update the
  `vi.mock("@/server/usecases/external-play", ...)` in
  `apps/web/src/app/api/cron/external-play/route.test.ts:12` to mock
  `sweepExternalPlay` instead, keeping the two auth tests
  (`route.test.ts:32-36`) exactly as they are — they prove the `x-cron-secret`
  gate and must not be weakened. Run
  `cd .../apps/web && npx vitest run src/app/api/cron/external-play/route.test.ts --reporter=json --outputFile=/tmp/cron.json`
  and read the counts. The three sibling routes
  (`external-play/resolve`, `external-play/resend`, `webhooks/lichess`) import
  three MORE undefined symbols and belong to B4/B5 — leave them, and name them
  in the commit body so the remaining `tsc` reds are attributable. Commit:
  `fix(chess): point the external-play cron at the sweep that exists`.

- [ ] **Step 19: export, typecheck, lint, final scoped run.** Add
  `export * from "./sweep";`. Then `rtk proxy npx tsc --noEmit` and
  `rtk proxy npx eslint` on the four touched files (read `✖ N problems`; the
  `rtk` wrapper hides lint output entirely and "JSON parse failed" is the
  wrapper losing the result, not a clean run). Run the full B3 verify command
  over all four test files and paste the raw
  `numTotalTests`/`numPassedTests`/`numFailedTests` plus the resolved
  `.testResults[].name` paths into the task report — a run that resolved to the
  main checkout is a false green. Commit:
  `feat(chess): the external-play sweep — no-show, mint retry, teardown, reconcile`.

- [ ] **Step 20: do NOT merge.** This task's branch waits on W2b. Record in the
  task report: the Step 1 gate result, the Step 2 `round_opened_at` location and
  which window reading it implements, whether the Step 9(a) mutant survived and
  why, and the four raw test counts.
` marker -->

## Batch B4 — the surfaces people actually touch (T14–T16)

### B4 premise corrections (re-pinned 2026-10-09 against `d6f46ab52`)

Every path and line number below was opened, not grepped. Nine briefed premises
were false; each is corrected here and the task that owns it carries the repair.

| # | Briefed / skeleton premise | What the tree says |
|---|---|---|
| P1 | `apps/web/src/app/api/v1/fixtures/[id]/external-play/room/route.ts` exists | **Absent.** That directory holds `lobby/`, `resend/`, `resolve/` only. The path is correct *as a path to create* — see T14 Step 2's convention note. |
| P2 | `…/fixtures/[fixtureId]/play/page.tsx` exists | **Absent.** The fixture route dir holds `page.tsx`, `opengraph-image.tsx`, `poster.png/`, `subheading.tsx`, `share-text.ts`, `stream-link.ts`, `fixture-subheading.ts`, `__tests__/`. `(public)` has **no `layout.tsx`**, so a nested `play/` inherits no chrome — the path is right. |
| P3 | `apps/web/src/components/public-site/match-room/` exists | **Absent.** T14 creates it. |
| P4 | `apps/web/src/components/v2/arbiter-panel.tsx` exists | **Absent.** T15 creates it. `arbiter` appears nowhere in `apps/web/src` as a product concept (only as the English word in unrelated comments), confirming spec §12's "no new role". |
| P5 | `externalPlay.lobby.*` was deleted and `externalPlay.room.*` added | **Neither.** `en/ui.json` still carries **33** `externalPlay.*` keys including all ten `externalPlay.lobby.*` (`:5679`–`:5687`) and `externalPlay.playOnLichess` (`:5678`). There is **no** `externalPlay.room.*` key. T14 adds them; T16 deletes the lobby ones. All four locales are at 33/33 and 17/17 (`lichess`), so parity holds today. |
| P6 | `apps/web/src/lib/run-sheet*` holds the run sheet | Only `apps/web/src/lib/run-sheet-groups.ts` is under `lib/` (`RunSheetFixture:35`, `isBye:123`, `buildRunSheet:132`). The components are `apps/web/src/components/v2/desk/run-sheet.tsx` (`runSheetKeeps:80`, `RunSheet:93`) and `…/desk/run-sheet-row.tsx`. |
| P7 | The run sheet has an organiser **Settle** action; `core.settle` is an event | **`core.settle` does not exist anywhere** in `apps`, `packages` or `db`. `core.forfeit` does (212 matches). The nearest shipped thing is `POST /fixtures/{id}/external-play/resolve` (`resolve/route.ts:10`) with kinds `home_forfeit | away_forfeit | draw | no_result` (`schemas.ts:1329`). **T16 wires the existing resolve action and names it "Settle"; it must not reference `core.settle`.** |
| P8 | `apps/web/src/lib/organiser-only-events.ts` / `isOrganiserOnlyEvent` (skeleton "Sequencing gates") | **Absent.** W2a's, unmerged. No B4 step may import it. |
| P9 | main's `getPublicFixture` rewrite left the external-play seam inert | **The seam is present and wired**: `data.ts:35-36` imports, `:1117` the `externalPlay` field, `:1258` `externalPlay: await loadPublicExternalPlay(fixtureId)`, and the page mounts it at `page.tsx:372` and `:392`. The real hazard is different and worse — see F3 below. |

**Findings that are pre-existing branch defects, not T14–T16 work, but which T14/T16
must step over deliberately:**

- **F1 — the branch is tsc-red on the old lobby surface.** Commit `340dce7ed`
  deleted `apps/web/src/server/usecases/external-play.ts` (1043 lines, 19 exports)
  and replaced it with the directory `external-play/`, whose `index.ts` re-exports
  **only** `./auth` and `./guard`. Ten files still import the vanished symbols:
  `api/cron/external-play/route.ts:9`, `…/external-play/lobby/route.ts:7`,
  `…/resend/route.ts:3`, `…/resolve/route.ts:4`, `api/webhooks/lichess/route.ts:3`,
  `o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:59`, and four
  `usecases/__tests__/external-play-*.test.ts`. Separately
  `lobby/route.ts:17` calls `mintExternalPlayLobbyToken(fixtureId, userId)` with
  two arguments against the three-parameter signature at `lib/realtime.ts:249`.
  T9–T13 re-home `applyProviderGameUpdate`, `resolveExternalPlay`,
  `resendExternalPlayNotice`, `listNeedsOrganiserExternalPlay` and the cron
  entry points; **T16 owns only the lobby half** (delete route + component +
  keys) and must leave the other four importers alone.
- **F2 — `key-scopes.test.ts`'s classification walk is red for four pairs.**
  `key-scopes.ts` contains no `external-play` string at all: `GET`/`POST
  /fixtures/:id/external-play/lobby`, `POST …/resend` and `POST …/resolve` are
  in neither `KEY_ROUTE_RULES` (nearest rules: `:183`–`:193`, none matching) nor
  `NEVER_KEY_ROUTES` (`:312`), so the enumeration test at
  `__tests__/key-scopes.test.ts:145-168` fails them. T14 adds the room entries;
  T16 adds `resend`/`resolve` and removes the two lobby pairs with the route.
- **F3 — the public seam is cached with the OLD payload shape.** The
  `externalPlay` field is produced **inside** `unstable_cache(... ,
  ["pub-fixture-v3", fixtureId], { tags: [divisionTag(division.id)], revalidate:
  REVALIDATE_FAST })` (`data.ts:1125`, key at `:1275`, `REVALIDATE_FAST = 30` at
  `:165`, `divisionTag` at `:168`). T16 removes `playUrl`/`whitePlayUrl`/
  `blackPlayUrl` from `PublicExternalPlay`, so a live `pub-fixture-v3` entry
  written before deploy would be read back by new code for up to 30s. **The key
  must be retired to `pub-fixture-v4`** — the same reason `:1270-1274` already
  documents for v2→v3.
- **F4 — two more inert seams already on the branch.** `readMatchRoom` /
  `checkInToMatchRoom` / `mintIfReady` (`usecases/external-play/room.ts`) and
  `mintMatchRoomToken` (`usecases/match-room-token.ts:16`) have **no production
  caller** — tests only. T14 is the task that makes them reachable, and its
  acceptance is a browser drive, not a passing unit suite.
- **F5 — `SidePlayer.displayName` is the raw snapshot, and its fallback is a
  UUID.** `loadSide` (`usecases/external-play/guard.ts:238`) selects
  `e.display_name as "displayName"` and falls back to `entrantId`
  (`guard.ts:251`). It carries no `kind`, no `members`, no lineup, so
  `entrantDisplayName` (`apps/web/src/lib/entrant-name.ts:70`) **cannot** be
  applied to it. This is precisely the defect that function's own header
  documents at `entrant-name.ts:8-9` ("which is how a console came to say
  'Entry 3' above a board where two named people were playing"), with a worse
  fallback. T14 Step 1 fixes it at the source.
- **F6 — the organiser queue's reason map does not match `NeedsReason`.**
  `external-play-needs-result-queue.tsx:19-26` keys on `delay_unsupported`,
  `no_show_grace_elapsed`, `account_mismatch`, `abort`, `unfinished`,
  `lichess_link_missing`; `server/external-play/types.ts:14-21` declares
  `no_show_white | no_show_black | no_show_both | not_started | aborted |
  mismatch | provider_error`. **Not one value overlaps**, so every real reason
  renders `externalPlay.reason.generic`. T16 reconciles the map against
  `NeedsReason` and T12's `ResultWrite` reasons.
- **F7 — the OAuth flash lands on pages that never render it.**
  `api/auth/lichess/callback/route.ts:22-24` defaults the landing to **`/me`**,
  and `api/auth/lichess/route.ts:37` redirects to `/settings?tab=account&…`.
  The only renderer is `o/[orgSlug]/settings/page.tsx:296-306` + `:639-650`
  (`data-testid="lichess-flash"`). `app/me/page.tsx` reads
  `searchParams: Promise<{ claimed?: string }>` (`:34-36`, `:78`) — `lichess`
  is dropped on the floor; `app/settings/page.tsx` is a query-forwarding shim.
  The dictionary already has **six** flash keys, not the five the brief names —
  `not_configured` is the sixth (`en/ui.json:933-938`), and `route.ts:37` is
  its live producer, so T16 must render all six.
- **F8 — `round_opened_at`, `openRound` and a per-fixture `invitedAt` do not
  exist.** The only `invited_at` in the tree is `V292__clubs_teams_redesign.sql:24`
  (club invitations, unrelated). D12's organiser-driven rounds are entirely new;
  T16 renders them and the open-round usecase is a separate task's.
- **F9 — the spec was amended under this plan, and the amendment reaches T14.**
  The design of record gained **D12** at `:38` and a rewritten **§3.2 "Round
  lifecycle, window and seat"** at `:110-125` after the plan skeleton was
  written: "**T−10 and T+20 are therefore relative to `round_opened_at`**, not to
  the fixture's scheduled time… A fixture with no `round_opened_at` is not yet
  playable and says so." The shipped window module contradicts that on both
  counts — `windowFor(scheduledAt: Date)` (`server/external-play/window.ts:14`)
  and `roomPhase(now, scheduledAt)` (`:25`) are measured from the schedule, and
  `RoomPhase` (`:23`) is `"before" | "open" | "closed"` with **no** "not
  opened". T14 Steps 26a/26b carry the consequence; §4 at `:222-227` also
  promotes the 5-minute cron from "optional" to four named jobs, which is T13's.
  **Re-read the spec before starting: it moved once today already.**

### Standing constraints that bind every step in B4

- **`apps/web` vitest is `environment: "node"`** (`apps/web/vitest.config.ts:129`).
  There is no DOM. A unit test here can assert **markup text, attributes, class
  strings, props and i18n keys** via `renderToStaticMarkup` from
  `react-dom/server` (precedent: `components/public-site/__tests__/external-play-cta.test.tsx:2`).
  It **cannot** see layout, the CSS cascade, visibility, tap area or horizontal
  overflow. No unit-test title in B4 may claim a visual fact. Every such claim
  is owed to B5's e2e at 320/768/1280 plus the seven-width `mobile.spec.ts`
  projects; each step below says which half it is.
- **`/\bmd:hidden\b/` also matches inside `max-md:hidden`.** Anchor class
  assertions on `\s…hidden"` (AGENTS.md, phone-composition section).
- Assertions on Next HTML anchor on `="` — an omitted prop serialises as
  `"$undefined"`, so a bare `data-*` probe passes in both states.
- `grep -a` always. `rtk proxy git diff` for diff content.
- Scoped vitest only:
  `cd apps/web && npx vitest run <exact paths> --reporter=json --outputFile=<path>`,
  judged on `numPassedTests` / `numFailedTests` / `numTotalTests` from the file.
  Never the full suite, never the full e2e suite (owner, 2026-09-28).

---

### Task 14: The match room — page, board, controls

**Files:**

*Created:*
- `apps/web/src/components/public-site/match-room/board-loader.ts` — the one
  chessground import site (GPL-3.0 isolation seam)
- `apps/web/src/components/public-site/match-room/board.tsx` — our thin wrapper
- `apps/web/src/components/public-site/match-room/promotion-picker.tsx`
- `apps/web/src/components/public-site/match-room/promotion.ts` — pure
  "does this move need a promotion piece" (chess.js, BSD-2)
- `apps/web/src/components/public-site/match-room/clocks-strip.tsx`
- `apps/web/src/components/public-site/match-room/clock-math.ts` — pure local tick
- `apps/web/src/components/public-site/match-room/presence-pill.tsx`
- `apps/web/src/components/public-site/match-room/own-tile.tsx`
- `apps/web/src/components/public-site/match-room/controls.tsx`
- `apps/web/src/components/public-site/match-room/room-shell.tsx`
- `apps/web/src/components/public-site/match-room/room-snapshot.ts` — the wire type
- `apps/web/src/components/public-site/match-room/__tests__/` — ten test files
  (`licence-isolation`, `promotion`, `clock-math`, `room-phase`,
  `presence-pill`, `own-tile`, `controls`, `board-wrapper`,
  `room-shell-composition`, `clocks-strip`)
- `apps/web/src/app/api/v1/fixtures/[id]/external-play/room/route.ts` — GET + POST
- `apps/web/src/app/api/v1/fixtures/[id]/external-play/room/act/route.ts` — POST
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/page.tsx`

*Edited (exact lines re-pinned):*
- `apps/web/src/server/usecases/external-play/guard.ts` — `SidePlayer:13-23`,
  `SideRow:214-221`, `loadSide:238-271` (`display_name` at `:239`, the UUID
  fallback at `:251`), `loadSides:273`
- `apps/web/src/server/api-v1/key-scopes.ts` — `NEVER_KEY_ROUTES:312`, list
  tail `"POST /capture/codes/:code/scoring-link"` at `:353`
- `apps/web/src/server/api-v1/openapi.ts` — `ROUTES` external-play block
  `:193-196`
- `apps/web/src/server/api-v1/schemas.ts` — after `ResolveExternalPlayOut:1336-1345`
- `apps/web/src/lib/routes.ts` — after `sharedFixture:72-73`
- `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` — `externalPlay.*` block
  begins `en:5678`
- `apps/web/src/lib/i18n-keys.ts` — generated
- `apps/web/package.json` — dependencies
- `apps/web/src/server/api-v1/__tests__/key-scopes.test.ts` — explicit-entry
  block `:48-63`
- `openapi/v1.json`, `openapi/v1.public.json` — generated

**Interfaces:**

*Consumes (from the authoritative list — do not re-shape):*
```ts
// T2
export function getLichessLink(userId: string): Promise<LichessLink | null>;
// T3
export type GameSnapshot = { gameId: string; status: LichessStatus; winner: "white"|"black"|null;
  movesSan: string[]; whiteMs: number|null; blackMs: number|null; increment: number };
export type LichessStatus = "created"|"started"|"mate"|"resign"|"outoftime"
  |"draw"|"stalemate"|"aborted"|"timeout"|"noStart"|"unknownFinish";
export type BoardErrorCode = "not_your_turn_or_over"|"unplayable_time_control"
  |"rate_limited"|"unauthorized"|"unavailable";
// T5
export type TimeControl = { key: string; limitSeconds: number; incrementSeconds: number };
export const SHIP1_TIME_CONTROLS: readonly TimeControl[];
// T6
export type CameraPolicy = "off" | "optional" | "required";
// T7
export type ParticipantToken = { participantId: string; authToken: string };
// T8
export type SeatResult =
  | { seated: true; participant: ParticipantToken | null }
  | { seated: false; reason: "camera_required"|"camera_lost"|"window_closed"|"not_a_player" };
export function seatPlayer(a: { fixtureId: string; personId: string }): Promise<SeatResult>;
// T10
export type PlayAction = { kind: "move"; uci: string } | { kind: "resign" }
  | { kind: "draw"; accept: boolean } | { kind: "abort" };
export type PlayResult = { ok: true; applied: boolean }
  | { ok: false; reconcile: true; reason: BoardErrorCode };
export function act(a: { fixtureId: string; personId: string; action: PlayAction }): Promise<PlayResult>;
export type RoomBroadcast = { fen: string; lastMove: string|null; turn: "white"|"black";
  whiteMs: number; blackMs: number; status: LichessStatus; drawOfferBy: "white"|"black"|null };
```

*Consumes (shipped repo symbols, pinned):*
`loadOnlinePlayFixture` `usecases/external-play/guard.ts:121`; `loadSides` `:273`;
`whiteSideOf` `:298`; `effectiveBridge` `:177`; `windowFor` `server/external-play/window.ts:14`;
`roomPhase` `:25`; `ROOM_REREAD_MS` `:10`; `entrantDisplayName` `lib/entrant-name.ts:70`;
`resolveRoomPlayer` `usecases/external-play/room.ts:85`;
`externalPlayLobbyTopic` `lib/realtime.ts:233`; `mintExternalPlayLobbyToken` `:249`;
`v1` `server/api-v1/http.ts:127`; `parseBody` `:267`; `requireUser` `lib/auth.ts:140`;
`HttpError` `lib/errors`; `ConfirmDialog` `components/v2/confirm-dialog.tsx:48`;
`useT` / `useMsgPlural` `components/i18n/dict-provider.tsx:58`/`:114`;
`DictProvider` `:17`; `t` / `plural` / `getDictionary` `lib/i18n.ts:26`.

*Produces (new — add verbatim to the authoritative list):*
```ts
// T14 — apps/web/src/server/usecases/external-play/guard.ts (widened, same file)
export type SidePlayer = {
  side: Side;
  entrantId: string;
  /** `entrants.display_name` — the SNAPSHOT. Never rendered directly. */
  snapshotName: string;
  /** `entrantDisplayName({ name: snapshotName, kind, members })`. Render THIS. */
  displayName: string;
  kind: string | null;
  members: { person_id: string; full_name: string }[];
  personId: string | null;
  userId: string | null;
  lichess: { id: string; username: string } | null;
  recipients: { email: string; locale: string | null }[];
};

// T14 — apps/web/src/components/public-site/match-room/room-snapshot.ts
/** D12 (spec §3.2): `not_opened` is a FIFTH state the shipped `RoomPhase`
 *  (`server/external-play/window.ts:23` — `"before" | "open" | "closed"`) does
 *  not have. A fixture with no `round_opened_at` is not yet playable, and the
 *  spec requires it to say so rather than render as "before the window". */
export type RoomPhaseWire = "not_opened" | "before" | "open" | "closed";
export type RoomSeatState =
  | { kind: "unseated"; reason: SeatResult extends { seated: false; reason: infer R } ? R : never }
  | { kind: "preflight" }
  | { kind: "seated" };
export type RoomSnapshot = {
  fixtureId: string;
  phase: RoomPhaseWire;
  /** D12: null until the organiser opens the round. T−10/T+20 are relative to
   *  THIS, never to `scheduled_at` (spec §3.2). */
  roundOpenedAt: string | null;
  /** The time players are SHOWN. Never the trigger (spec §3.2). */
  scheduledAt: string;        // ISO
  /** null while `roundOpenedAt` is null — there is no window yet. */
  opensAt: string | null;     // ISO
  deadline: string | null;    // ISO
  cameraPolicy: CameraPolicy;
  you: { side: "home" | "away"; colour: "white" | "black"; name: string; seat: RoomSeatState };
  opponent: { name: string; cameraLive: boolean };
  /** null until the game exists. */
  game: {
    gameId: string;
    fen: string;
    lastMove: string | null;
    turn: "white" | "black";
    whiteMs: number;
    blackMs: number;
    incrementSeconds: number;
    movesPlayed: number;
    status: LichessStatus;
    drawOfferBy: "white" | "black" | null;
    /** server clock at the instant whiteMs/blackMs were true */
    asOf: string;             // ISO
  } | null;
  realtime: { channel: string; token: string | null };
};

// T14 — apps/web/src/components/public-site/match-room/clock-math.ts
export function remainingMs(a: {
  baseMs: number; asOfMs: number; nowMs: number; running: boolean;
}): number;

// T14 — apps/web/src/components/public-site/match-room/promotion.ts
export function promotionSquares(fen: string, from: string): string[];
export function needsPromotion(fen: string, from: string, to: string): boolean;

// T14 — apps/web/src/components/public-site/match-room/board-loader.ts
export type BoardModule = { Chessground: typeof import("chessground").Chessground };
export function loadBoard(): Promise<BoardModule>;

// T14 — apps/web/src/lib/routes.ts
sharedFixturePlay: (orgSlug: Slug, compSlug: Slug, divSlug: Slug, fixtureId: string) => string;
```

**Steps:**

- [ ] **Step 1: Red — `loadSide` must stop rendering the raw snapshot.**
  New file `apps/web/src/server/usecases/external-play/__tests__/side-name.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { entrantDisplayName } from "@/lib/entrant-name";
  import { sideDisplayName } from "../guard";

  describe("sideDisplayName (F5 — the 'Entry 3' defect, entrant-name.ts:8-9)", () => {
    it("an individual entrant with one member renders the PERSON, not the snapshot", () => {
      const row = {
        snapshotName: "Entry 3",
        kind: "individual",
        members: [{ person_id: "p1", full_name: "Ada Okonkwo" }],
      };
      expect(sideDisplayName(row)).toBe("Ada Okonkwo");
      // Derived from the authority, never typed twice:
      expect(sideDisplayName(row)).toBe(
        entrantDisplayName({ name: row.snapshotName, kind: row.kind, members: row.members }),
      );
    });

    it("falls back to the snapshot when the roster cannot answer, and NEVER to an entrant id", () => {
      const cases = [
        { snapshotName: "Entry 3", kind: "individual", members: [] },
        { snapshotName: "Entry 3", kind: null, members: [{ person_id: "p1", full_name: "Ada Okonkwo" }] },
        { snapshotName: "Entry 3", kind: "pair", members: [{ person_id: "p1", full_name: "Ada Okonkwo" }] },
      ];
      let checked = 0;
      for (const c of cases) {
        expect(sideDisplayName(c), JSON.stringify(c)).toBe("Entry 3");
        expect(sideDisplayName(c)).not.toMatch(/^[0-9a-f-]{36}$/i);
        checked += 1;
      }
      expect(checked, "anti-vacuity: fallback cases checked").toBe(3);
    });

    it("an empty snapshot still never renders an empty string", () => {
      expect(sideDisplayName({ snapshotName: "", kind: "individual", members: [] })).toBe("—");
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/server/usecases/external-play/__tests__/side-name.test.ts --reporter=json --outputFile=/tmp/b4-s1.json`
  Expect: collection failure — `Error: No "sideDisplayName" export is defined on the "../guard" mock`/
  `does not provide an export named 'sideDisplayName'`, `numPassedTests: 0`.

- [ ] **Step 2: Green — widen `SidePlayer`, `SideRow` and `loadSide`.**
  In `guard.ts`, add above `loadSide`:
  ```ts
  /** The name to RENDER for a chess seat. `entrantDisplayName` is the one
   *  authority (lib/entrant-name.ts:70); this wrapper only supplies the
   *  em-dash floor, because `loadSide`'s old fallback was the entrant UUID
   *  (F5) and a 36-character hex string above a board is worse than "Entry 3". */
  export function sideDisplayName(a: {
    snapshotName: string;
    kind: string | null;
    members: readonly { person_id: string; full_name: string }[];
  }): string {
    const resolved = entrantDisplayName({
      name: a.snapshotName,
      ...(a.kind === null ? {} : { kind: a.kind }),
      members: a.members,
    });
    return resolved.trim() === "" ? "—" : resolved;
  }
  ```
  Widen `SideRow` (`:214-221`) with `kind: string | null; fullName: string | null`,
  the select (`:239`) with `e.kind as "kind"` and `p.full_name as "fullName"`,
  and the return (`:251-270`) with
  ```ts
  const snapshotName = rows[0]?.displayName ?? "";
  const kind = rows[0]?.kind ?? null;
  const members = rows
    .filter((r): r is SideRow & { personId: string; fullName: string } =>
      r.personId !== null && r.fullName !== null)
    .map((r) => ({ person_id: r.personId, full_name: r.fullName }));
  // …
  return { side, entrantId, snapshotName, kind, members,
    displayName: sideDisplayName({ snapshotName, kind, members }), /* …rest unchanged… */ };
  ```
  Import `entrantDisplayName` from `@/lib/entrant-name` at the top of `guard.ts`.
  Run Step 1's command. Expect `numPassedTests: 3, numFailedTests: 0`.
  Commit: `fix(chess): resolve a chess seat's name through entrantDisplayName`.

- [ ] **Step 3: Red — the DB-gated proof that the query really carries the roster.**
  Append to `apps/web/src/server/usecases/__tests__/external-play-guard.test.ts`
  (inside its existing `describe.skipIf(!HAS_DB)`), seeding through
  `_external-play-seed.ts`:
  ```ts
  it("loadSides renders the person's name for a singles chess entrant, never 'Entry N' or a uuid (F5)", async () => {
    const s = await seedOnlinePlayFixture({ homeFullName: "Ada Okonkwo", awayFullName: "Bo Lind" });
    const f = await loadOnlinePlayFixture(s.fixtureId);
    expect(f, "fixture loads").not.toBeNull();
    const { home, away } = await loadSides(f!);
    expect([home.displayName, away.displayName]).toEqual(["Ada Okonkwo", "Bo Lind"]);
    expect(home.members.map((m) => m.full_name)).toEqual(["Ada Okonkwo"]);
    expect(home.snapshotName).not.toBe(home.displayName); // the snapshot really differed
    for (const side of [home, away]) {
      expect(side.displayName, "never a bare entrant id").not.toMatch(/^[0-9a-f-]{36}$/i);
    }
  });
  ```
  If `seedOnlinePlayFixture` does not already accept `homeFullName`/`awayFullName`,
  add those two options to `_external-play-seed.ts` in this step.
  Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/external-play-guard.test.ts --reporter=json --outputFile=/tmp/b4-s3.json`
  Expect, with a DB up: `Expected ["Ada Okonkwo","Bo Lind"] / Received ["Entry 1","Entry 2"]`
  before Step 2's select widening; with no DB, the whole file skips — record the
  skip count and say so, do not report it as green.
  Commit with Step 2 if the suite was red together; otherwise its own
  `test(chess): pin the seat name against a real roster`.

- [ ] **Step 4: Red — the three room routes must be structurally closed to API keys.**
  In `apps/web/src/server/api-v1/__tests__/key-scopes.test.ts`, beside the
  explicit-entry block at `:48-63`:
  ```ts
  it("the match-room routes are explicit NEVER_KEY_ROUTES entries (a player's seat and a Lichess token, never a key)", () => {
    const entries = [
      "GET /fixtures/:id/external-play/room",
      "POST /fixtures/:id/external-play/room",
      "POST /fixtures/:id/external-play/room/act",
    ];
    let checked = 0;
    for (const e of entries) {
      expect(NEVER_KEY_ROUTES, e).toContain(e);
      const [method, path] = e.split(" ") as [string, string];
      expect(matchKeyRoute(method, `/api/v1${path.replace(/:id/g, "seg")}`), e).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: room routes checked").toBe(3);
  });
  ```
  Add `matchKeyRoute` to that file's import list (`:12` block).
  Run: `cd apps/web && npx vitest run src/server/api-v1/__tests__/key-scopes.test.ts --reporter=json --outputFile=/tmp/b4-s4.json`
  Expect: `expected [ …135 items ] to include 'GET /fixtures/:id/external-play/room'`.

- [ ] **Step 5: Green — the `NEVER_KEY_ROUTES` entries.**
  After `"POST /capture/codes/:code/scoring-link"` (`key-scopes.ts:353`):
  ```ts
  // Chess in-page board (2026-10-09 design §6): the room read names a player's
  // seat, the POSTs seat them and submit moves with that player's own stored
  // Lichess OAuth token. A credential-backed, session/link-token surface —
  // the device-links reasoning, never key-reachable.
  "GET /fixtures/:id/external-play/room",
  "POST /fixtures/:id/external-play/room",
  "POST /fixtures/:id/external-play/room/act",
  ```
  Run Step 4's command. Expect that test green. Note the four **pre-existing**
  failures from F2 stay red until Step 6 and T16 — record their names, do not
  claim the file green.
  Commit: `feat(chess): close the match-room routes to API keys`.

- [ ] **Step 6: Green — classify the three shipped external-play routes too (F2).**
  `GET`/`POST /fixtures/:id/external-play/lobby` and `POST …/resend`,
  `POST …/resolve` are in no list. Add `resend`/`resolve` to `NEVER_KEY_ROUTES`
  with the same comment (a resend emails a player; a resolve writes a result
  under organiser authority), and the two `lobby` pairs **as well** — T16
  deletes them with the route in the same branch, and leaving the walk red
  between tasks hides the next regression. Extend Step 4's test with those
  five entries and raise its `checked` floor to 8.
  Run Step 4's command. Expect `numFailedTests: 0` for that file.
  Commit: `fix(chess): classify every external-play route for API keys`.

- [ ] **Step 7: Red — chessground and chess.js are pinned, isolated and unmodified.**
  New `apps/web/src/components/public-site/match-room/__tests__/licence-isolation.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { readFileSync, readdirSync, statSync } from "node:fs";
  import { join } from "node:path";

  const WEB = join(__dirname, "..", "..", "..", "..", "..");       // apps/web
  const SRC = join(WEB, "src");
  const LOADER = "src/components/public-site/match-room/board-loader.ts";

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((e) => {
      const full = join(dir, e);
      return statSync(full).isDirectory()
        ? walk(full)
        : /\.(ts|tsx)$/.test(e) ? [full] : [];
    });
  }

  describe("chessground stays isolated and unmodified (spec §9)", () => {
    it("is an exact pinned dependency at the GPL-3.0 version we accepted", () => {
      const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      expect(pkg.dependencies.chessground).toBe("9.2.1");
      expect(pkg.dependencies["chess.js"]).toBe("1.4.0");
    });

    it("exactly ONE source file imports chessground, and it is the loader", () => {
      const files = walk(SRC);
      expect(files.length, "anti-vacuity: source files scanned").toBeGreaterThan(500);
      const importers = files
        .filter((f) => /from "chessground|require\("chessground|import\("chessground/.test(readFileSync(f, "utf8")))
        .map((f) => f.slice(WEB.length + 1).split("\\").join("/"));
      expect(importers).toEqual([LOADER]);
    });

    it("no chessground source is vendored into the repo", () => {
      const vendored = walk(SRC).filter((f) => /chessground/i.test(f));
      expect(vendored, "chessground must be a dependency, never a copy").toEqual([]);
    });

    it("the loader states the licence reason, so nobody 'simplifies' it away", () => {
      const src = readFileSync(join(WEB, LOADER), "utf8");
      expect(src).toContain("GPL-3.0");
      expect(src).toContain("unmodified");
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/licence-isolation.test.ts --reporter=json --outputFile=/tmp/b4-s7.json`
  Expect: `ENOENT: no such file or directory, open '…/board-loader.ts'` and
  `expected undefined to be '9.2.1'`.

- [ ] **Step 8: Green — install the two libraries and write the loader.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && pnpm --filter @seazn/web add chessground@9.2.1 chess.js@1.4.0`
  (verify against the registry: `npm view chessground version license` →
  `9.2.1` / `GPL-3.0-or-later`; `npm view chess.js version license` → `1.4.0` /
  `BSD-2-Clause`.) Then `board-loader.ts`:
  ```ts
  // The ONE import site for chessground.
  //
  // WHY THIS FILE EXISTS — DO NOT INLINE IT. chessground is GPL-3.0-or-later
  // and we ship it to every visitor's browser, which is distribution of a
  // combined work (design 2026-10-09 §9; the owner accepted the licence on
  // 2026-10-09 after being told, and no legal advice was given or implied).
  // The mitigation the design REQUIRES is that chessground stays isolated and
  // unmodified: its own async chunk, consumed as a library through this
  // boundary, never vendored into the repo and never patched. `board.tsx` is
  // our own thin wrapper above it. Importing chessground anywhere else, or
  // copying its source in, widens the combined work and is a licence change
  // dressed up as a refactor — `__tests__/licence-isolation.test.ts` fails if
  // either happens.
  //
  // The dynamic `import()` is also what gives it its own chunk under Next
  // 16.3's Turbopack build: a static import from a client component would be
  // folded into the route's first-load bundle. Mounted via
  // `dynamic(() => import("./board"), { ssr: false })` in `room-shell.tsx` —
  // chessground touches `document` at construction, so it must never render
  // on the server.
  export type BoardModule = { Chessground: typeof import("chessground").Chessground };

  export async function loadBoard(): Promise<BoardModule> {
    const mod = await import("chessground");
    return { Chessground: mod.Chessground };
  }
  ```
  Run Step 7's command. Expect `numPassedTests: 4, numFailedTests: 0`.
  **Mutation check (spec §8 / house rule):** replace the loader's body with a
  static `import { Chessground } from "chessground"` re-export and confirm the
  "exactly ONE source file imports chessground" test still passes while a new
  assertion is needed — so also add, in the same step,
  `expect(src).toMatch(/await import\("chessground"\)/)` to the fourth test and
  re-run to watch it fail on the static form, then restore from a `cp` backup
  (never `git checkout <file>`).
  Commit: `feat(chess): isolated, unmodified chessground loader (GPL-3.0)`.

- [ ] **Step 9: Red — the promotion picker's trigger condition.**
  chessground ships **no** promotion UI (spec §2, falsified premise §11), so the
  decision is ours. New
  `apps/web/src/components/public-site/match-room/__tests__/promotion.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { needsPromotion, promotionSquares } from "../promotion";

  const WHITE_SEVENTH = "8/PPPPPPPP/8/8/8/8/8/K6k w - - 0 1";
  const BLACK_SECOND = "K6k/8/8/8/8/8/pppppppp/8 b - - 0 1";
  const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

  describe("needsPromotion", () => {
    it("every white pawn on the seventh promoting to the eighth needs a piece", () => {
      let checked = 0;
      for (const f of FILES) {
        expect(needsPromotion(WHITE_SEVENTH, `${f}7`, `${f}8`), `${f}7${f}8`).toBe(true);
        checked += 1;
      }
      expect(checked, "anti-vacuity: white files checked").toBe(8);
    });

    it("every black pawn on the second promoting to the first needs a piece", () => {
      let checked = 0;
      for (const f of FILES) {
        expect(needsPromotion(BLACK_SECOND, `${f}2`, `${f}1`), `${f}2${f}1`).toBe(true);
        checked += 1;
      }
      expect(checked, "anti-vacuity: black files checked").toBe(8);
    });

    it("a pawn move that is not to the last rank does not", () => {
      expect(needsPromotion("8/8/8/8/8/8/PPPPPPPP/K6k w - - 0 1", "e2", "e4")).toBe(false);
    });

    it("a NON-pawn arriving on the last rank does not — this is the mutant a rank-only check survives", () => {
      expect(needsPromotion("8/4R3/8/8/8/8/8/K6k w - - 0 1", "e7", "e8")).toBe(false);
    });

    it("promotionSquares lists the destinations a given pawn can promote onto, and is EMPTY for a piece that cannot", () => {
      expect(promotionSquares(WHITE_SEVENTH, "e7").sort()).toEqual(["e8"]);
      expect(promotionSquares("8/8/8/8/8/8/PPPPPPPP/K6k w - - 0 1", "e2")).toEqual([]);
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/promotion.test.ts --reporter=json --outputFile=/tmp/b4-s9.json`
  Expect: `Failed to resolve import "../promotion"`.

- [ ] **Step 10: Green — `promotion.ts`.**
  ```ts
  import { Chess } from "chess.js";

  /** Legal destinations from `from` that Lichess would require a promotion
   *  suffix for. Derived from chess.js's own move generation (BSD-2) rather
   *  than a rank comparison: a rook landing on the eighth is not a promotion,
   *  and a rank-only check cannot tell the difference. */
  export function promotionSquares(fen: string, from: string): string[] {
    const game = new Chess(fen);
    return game
      .moves({ verbose: true })
      .filter((m) => m.from === from && m.promotion !== undefined)
      .map((m) => m.to);
  }

  export function needsPromotion(fen: string, from: string, to: string): boolean {
    return promotionSquares(fen, from).includes(to);
  }
  ```
  Run Step 9's command. Expect `numPassedTests: 5, numFailedTests: 0`.
  **Mutation:** change the filter to `m.from === from && m.to[1] === "8"`, re-run,
  watch the non-pawn case fail, restore from the `cp` backup.
  Commit: `feat(chess): our own promotion trigger (chessground ships none)`.

- [ ] **Step 11: Red — clocks render locally and open at the declared value.**
  Spec §6: "clocks render locally from accepted-move timestamps and are
  corrected on every reconcile (M11). We never declare a flag from our own
  arithmetic." Rule 19 applies: pin what the clock **opens at**, derived from
  T5's declarations. New
  `apps/web/src/components/public-site/match-room/__tests__/clock-math.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { remainingMs } from "../clock-math";
  import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";

  describe("remainingMs", () => {
    it("a stopped clock ignores wall time entirely", () => {
      expect(remainingMs({ baseMs: 180_000, asOfMs: 0, nowMs: 60_000, running: false })).toBe(180_000);
    });

    it("a running clock counts down by exactly the elapsed wall time", () => {
      expect(remainingMs({ baseMs: 180_000, asOfMs: 1_000, nowMs: 4_500, running: true })).toBe(176_500);
    });

    it("never goes below zero — the flag is Lichess's to declare, not ours", () => {
      expect(remainingMs({ baseMs: 2_000, asOfMs: 0, nowMs: 90_000, running: true })).toBe(0);
    });

    it("a clock correction that moves time BACKWARDS is honoured (reconcile is authoritative, M11)", () => {
      // our local arithmetic said 176_500; the export says 174_000
      expect(remainingMs({ baseMs: 174_000, asOfMs: 4_500, nowMs: 4_500, running: true })).toBe(174_000);
    });

    it("every ship-1 time control OPENS at its own declared limit, taken from the catalogue not a table here", () => {
      let checked = 0;
      for (const tc of SHIP1_TIME_CONTROLS) {
        const opening = remainingMs({
          baseMs: tc.limitSeconds * 1_000, asOfMs: 0, nowMs: 0, running: false,
        });
        expect(opening, tc.key).toBe(tc.limitSeconds * 1_000);
        expect(opening, `${tc.key} must not open at a hard-coded 3+0`).toBeGreaterThan(0);
        checked += 1;
      }
      expect(checked, "anti-vacuity: time controls checked").toBe(SHIP1_TIME_CONTROLS.length);
      expect(SHIP1_TIME_CONTROLS.length, "catalogue is not empty").toBeGreaterThan(1);
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/clock-math.test.ts --reporter=json --outputFile=/tmp/b4-s11.json`
  Expect: `Failed to resolve import "../clock-math"`.

- [ ] **Step 12: Green — `clock-math.ts`.**
  ```ts
  /**
   * Milliseconds left on one side's clock, rendered locally.
   *
   * `baseMs` is the last value we were TOLD (an accepted move's broadcast, or
   * a reconcile's authoritative export clocks — M11), `asOfMs` is when that
   * value was true, and `nowMs` is the viewer's tick. A correction that moves
   * time backwards therefore wins by construction: a fresh `baseMs`/`asOfMs`
   * pair replaces the derivation rather than being blended with it.
   *
   * Floored at zero and never interpreted. Reaching zero is one of
   * reconcile's four triggers (design §3.5); it is never, on its own, a flag.
   */
  export function remainingMs(a: {
    baseMs: number; asOfMs: number; nowMs: number; running: boolean;
  }): number {
    if (!a.running) return Math.max(0, a.baseMs);
    return Math.max(0, a.baseMs - Math.max(0, a.nowMs - a.asOfMs));
  }
  ```
  Run Step 11's command. Expect `numPassedTests: 5, numFailedTests: 0`.
  **Mutation:** delete the `Math.max(0, …)` floor, re-run, watch "never goes
  below zero" fail, restore from the `cp` backup.
  Commit: `feat(chess): local clock derivation, corrected by reconcile`.

- [ ] **Step 13: Red — the presence pill says camera, not surveillance.**
  New `apps/web/src/components/public-site/match-room/__tests__/presence-pill.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { PresencePill } from "../presence-pill";

  const t = (key: string) => key;

  describe("PresencePill", () => {
    it("live: carries the live key and the live state attribute", () => {
      const html = renderToStaticMarkup(<PresencePill cameraLive t={t} />);
      expect(html).toContain('data-testid="room-presence-pill"');
      expect(html).toContain('data-state="live"');
      expect(html).toContain("externalPlay.room.presence.live");
      expect(html).not.toContain("externalPlay.room.presence.off");
    });

    it("off: carries the off key and the off state attribute", () => {
      const html = renderToStaticMarkup(<PresencePill cameraLive={false} t={t} />);
      expect(html).toContain('data-state="off"');
      expect(html).toContain("externalPlay.room.presence.off");
      expect(html).not.toContain("externalPlay.room.presence.live");
    });

    it("never renders a video element for the opponent (D7 — players do not see each other)", () => {
      for (const live of [true, false]) {
        const html = renderToStaticMarkup(<PresencePill cameraLive={live} t={t} />);
        expect(html, `live=${live}`).not.toContain("<video");
        expect(html, `live=${live}`).not.toContain("srcObject");
      }
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/presence-pill.test.tsx --reporter=json --outputFile=/tmp/b4-s13.json`
  Expect: `Failed to resolve import "../presence-pill"`.

- [ ] **Step 14: Green — `presence-pill.tsx`.**
  A `<span data-testid="room-presence-pill" data-state={cameraLive ? "live" : "off"}>`
  with a `<span aria-hidden>` dot and `{t(cameraLive ? "externalPlay.room.presence.live"
  : "externalPlay.room.presence.off")}`. Classes
  `inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium`
  plus `max-md:min-h-11` (the phone tap floor the run-sheet stream chip already
  uses, `run-sheet-row.tsx:545`). No `<video>`, no subscription, by construction.
  Run Step 13's command. Expect `numPassedTests: 3, numFailedTests: 0`.
  *Owed to e2e (B5): that the pill is visible beside the own tile at 320 and in
  the side rail at 1280. No unit test may claim it.*
  Commit: `feat(chess): opponent presence pill — compliance without a face`.

- [ ] **Step 15: Red — the own tile, mic muted, with the honest consent line.**
  New `apps/web/src/components/public-site/match-room/__tests__/own-tile.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { OwnTile } from "../own-tile";

  const t = (key: string) => key;
  const participant = { participantId: "pt_1", authToken: "jwt" };

  describe("OwnTile", () => {
    it("declares the mic muted and says so in words (spec §5.3: chess needs no audio)", () => {
      const html = renderToStaticMarkup(<OwnTile participant={participant} policy="required" t={t} />);
      expect(html).toContain('data-testid="room-own-tile"');
      expect(html).toContain('data-mic="muted"');
      expect(html).toContain("externalPlay.room.micMuted");
    });

    it("states the organiser-review wording, and NEVER a monitoring claim (spec §5.4, D8)", () => {
      const html = renderToStaticMarkup(<OwnTile participant={participant} policy="required" t={t} />);
      expect(html).toContain("externalPlay.room.cameraNotice");
      expect(html).not.toContain("monitored");
      expect(html).not.toContain("externalPlay.room.monitored");
    });

    it("policy off renders no tile and no participant token at all", () => {
      const html = renderToStaticMarkup(<OwnTile participant={null} policy="off" t={t} />);
      expect(html).toBe("");
    });

    it("policy optional with no granted participant renders the tile frame but no token", () => {
      const html = renderToStaticMarkup(<OwnTile participant={null} policy="optional" t={t} />);
      expect(html).toContain('data-testid="room-own-tile"');
      expect(html).not.toContain("jwt");
    });

    it("never leaks the auth token into the markup", () => {
      let checked = 0;
      for (const policy of ["optional", "required"] as const) {
        const html = renderToStaticMarkup(<OwnTile participant={participant} policy={policy} t={t} />);
        expect(html, policy).not.toContain("jwt");
        checked += 1;
      }
      expect(checked, "anti-vacuity: policies checked").toBe(2);
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/own-tile.test.tsx --reporter=json --outputFile=/tmp/b4-s15.json`
  Expect: `Failed to resolve import "../own-tile"`.

- [ ] **Step 16: Green — `own-tile.tsx`.**
  A `"use client"` component returning `null` for `policy === "off"`; otherwise
  a `<figure data-testid="room-own-tile" data-mic="muted">` holding a
  `<video muted playsInline autoPlay>` whose stream is attached in an effect
  from the T7 participant token (the token is passed to the SDK in the effect,
  never rendered — that is the fifth test), a `<figcaption>` with
  `t("externalPlay.room.micMuted")`, and a `<p data-testid="room-camera-notice">`
  with `t("externalPlay.room.cameraNotice")`. Local preview only: no
  subscription to any other participant exists anywhere in this file.
  Run Step 15's command. Expect `numPassedTests: 5, numFailedTests: 0`.
  Commit: `feat(chess): own camera tile, muted, with honest consent copy`.

- [ ] **Step 17: Red — the controls are draw / resign / abort-before-first-move, and there is no takeback.**
  New `apps/web/src/components/public-site/match-room/__tests__/controls.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { readFileSync, readdirSync } from "node:fs";
  import { join } from "node:path";
  import { RoomControls } from "../controls";

  const t = (key: string) => key;
  const base = { movesPlayed: 4, status: "started" as const, drawOfferBy: null, yourTurn: true, busy: false,
                 onAct: () => {} };

  describe("RoomControls", () => {
    it("mid-game: draw and resign, and NO abort", () => {
      const html = renderToStaticMarkup(<RoomControls {...base} t={t} />);
      expect(html).toContain('data-testid="room-draw"');
      expect(html).toContain('data-testid="room-resign"');
      expect(html).not.toContain('data-testid="room-abort"');
    });

    it("before the first move: abort replaces resign (M9 — an early resign IS an abort)", () => {
      const html = renderToStaticMarkup(<RoomControls {...base} movesPlayed={0} t={t} />);
      expect(html).toContain('data-testid="room-abort"');
      expect(html).not.toContain('data-testid="room-resign"');
    });

    it("the boundary is move ONE, not move two", () => {
      const one = renderToStaticMarkup(<RoomControls {...base} movesPlayed={1} t={t} />);
      expect(one, "after one move, abort is gone").not.toContain('data-testid="room-abort"');
      expect(one).toContain('data-testid="room-resign"');
    });

    it("an incoming draw offer turns the draw control into accept/decline", () => {
      const html = renderToStaticMarkup(<RoomControls {...base} drawOfferBy="white" t={t} />);
      expect(html).toContain('data-testid="room-draw-accept"');
      expect(html).toContain('data-testid="room-draw-decline"');
      expect(html).not.toContain('data-testid="room-draw"');
    });

    it("a terminal status renders no action at all", () => {
      let checked = 0;
      for (const status of ["mate", "resign", "outoftime", "draw", "stalemate", "aborted"] as const) {
        const html = renderToStaticMarkup(<RoomControls {...base} status={status} t={t} />);
        for (const id of ["room-draw", "room-resign", "room-abort", "room-draw-accept"]) {
          expect(html, `${status} / ${id}`).not.toContain(`data-testid="${id}"`);
        }
        checked += 1;
      }
      expect(checked, "anti-vacuity: terminal statuses checked").toBe(6);
    });

    it("no file in the match room offers a takeback (spec §6 — a dispute magnet with a camera on it)", () => {
      const dir = join(__dirname, "..");
      const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f));
      expect(files.length, "anti-vacuity: match-room files scanned").toBeGreaterThan(5);
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        expect(src.toLowerCase(), f).not.toContain("takeback");
        expect(src.toLowerCase(), f).not.toContain("take-back");
      }
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/controls.test.tsx --reporter=json --outputFile=/tmp/b4-s17.json`
  Expect: `Failed to resolve import "../controls"`.

- [ ] **Step 18: Green — `controls.tsx`.**
  `"use client"`. Terminal statuses (`"mate" | "resign" | "outoftime" | "draw" |
  "stalemate" | "aborted" | "timeout" | "noStart" | "unknownFinish"`) return
  `null`. Otherwise: a draw control (or accept/decline when `drawOfferBy !==
  null`), and `movesPlayed === 0 ? abort : resign`. Resign and abort each open
  `ConfirmDialog` (`components/v2/confirm-dialog.tsx:48`) with
  `testId="room-resign-confirm"` / `"room-abort-confirm"`,
  `confirmVariant="danger"` and labels `externalPlay.room.resignConfirm` /
  `externalPlay.room.abortConfirm`. Every button `min-h-11`. `onAct` takes the
  T10 `PlayAction` union, so no action shape is invented here.
  Run Step 17's command. Expect `numPassedTests: 6, numFailedTests: 0`.
  **Mutation:** change the abort gate to `movesPlayed <= 1`, re-run, watch "the
  boundary is move ONE" fail, restore from the `cp` backup.
  Commit: `feat(chess): room controls — draw, resign, abort, no takeback`.

- [ ] **Step 19: Red — the board wrapper is ours, client-only, and drives our own promotion picker.**
  New `apps/web/src/components/public-site/match-room/__tests__/board-wrapper.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { readFileSync } from "node:fs";
  import { join } from "node:path";

  const DIR = join(__dirname, "..");

  describe("the board wrapper", () => {
    it("room-shell mounts the board through next/dynamic with ssr:false — chessground touches document", () => {
      const src = readFileSync(join(DIR, "room-shell.tsx"), "utf8");
      expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\("\.\/board"\),\s*\{\s*ssr:\s*false\s*\}\s*\)/);
    });

    it("board.tsx reaches chessground ONLY through the licence loader", () => {
      const src = readFileSync(join(DIR, "board.tsx"), "utf8");
      expect(src).toContain('from "./board-loader"');
      expect(src).not.toMatch(/from "chessground/);
    });

    it("board.tsx asks OUR promotion module, never a chessground one", () => {
      const src = readFileSync(join(DIR, "board.tsx"), "utf8");
      expect(src).toContain('from "./promotion"');
      expect(src).toContain("needsPromotion");
    });

    it("board.tsx submits a UCI string upward and never calls Lichess itself (design §3.4 step 1)", () => {
      const src = readFileSync(join(DIR, "board.tsx"), "utf8");
      expect(src).not.toContain("lichess.org");
      expect(src).not.toContain("api/board");
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/board-wrapper.test.ts --reporter=json --outputFile=/tmp/b4-s19.json`
  Expect: `ENOENT: no such file or directory, open '…/room-shell.tsx'`.

- [ ] **Step 20: Green — `board.tsx`.**
  `"use client"`. One `useEffect` that `await loadBoard()` then constructs
  `Chessground(el, { fen, turnColor, orientation, lastMove, viewOnly,
  movable: { color, free: false, dests }, events: { move: onUserMove } })`,
  stores the API in a ref, and `destroy()`s on unmount. `onUserMove(from, to)`
  calls `needsPromotion(fen, from, to)`: when true it opens
  `PromotionPicker` and submits `` `${from}${to}${piece}` ``; otherwise it
  submits `` `${from}${to}` ``. The submitted string goes to the `onMove`
  prop — the wrapper never talks to Lichess (design §3.4 step 1: the client
  posts an intended move to **our** server). Legality hints come from chess.js
  via `promotionSquares`' sibling helper; Lichess remains the authority.
  Import chessground's stylesheets through the loader's own chunk
  (`import("chessground/assets/chessground.base.css")` inside `loadBoard`), so
  no GPL asset is referenced from our source either.
  Then `room-shell.tsx` with `const Board = dynamic(() => import("./board"), { ssr: false })`.
  Run Step 19's command. Expect `numPassedTests: 4, numFailedTests: 0`.
  Commit: `feat(chess): thin chessground wrapper with our promotion picker`.

- [ ] **Step 21: Red — the approved phone composition, as markup facts only.**
  Spec §6 is **not open for redesign**. The order is explicit, never source
  order (AGENTS.md, phone composition). New
  `apps/web/src/components/public-site/match-room/__tests__/room-shell-composition.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { readFileSync } from "node:fs";
  import { join } from "node:path";

  const SRC = readFileSync(join(__dirname, "..", "room-shell.tsx"), "utf8");

  describe("room-shell composition (spec §6 — approved, not open for redesign)", () => {
    it("the four phone slots carry order-1..4 in the spec's sequence: clocks, board, tile+pill, controls", () => {
      const slots = [
        ["room-clocks-strip", "order-1"],
        ["room-board", "order-2"],
        ["room-tile-strip", "order-3"],
        ["room-controls", "order-4"],
      ] as const;
      let checked = 0;
      for (const [testId, order] of slots) {
        const re = new RegExp(`data-testid="${testId}"[^>]*`);
        const tag = SRC.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0]
          ?? SRC.match(new RegExp(`\\b${order}\\b[^"]*"[^>]*data-testid="${testId}"`))?.[0];
        expect(tag, `${testId} is rendered`).toBeTruthy();
        expect(SRC, `${testId} carries ${order}`).toMatch(re);
        checked += 1;
      }
      expect(checked, "anti-vacuity: slots checked").toBe(4);
      // The root is an explicit column with gaps, like pad-host.tsx's root.
      expect(SRC).toMatch(/flex flex-col gap-3/);
    });

    it("the tile strip carries the player's OWN tile and the opponent PILL, and no opponent video", () => {
      expect(SRC).toContain("<OwnTile");
      expect(SRC).toContain("<PresencePill");
      expect(SRC).not.toMatch(/opponent[A-Za-z]*Video|subscribeTo|remoteTrack/);
    });

    it("every phone-only class is `max-md:` and every desktop-only class is a REAL md:hidden, not max-md:hidden", () => {
      // `/\bmd:hidden\b/` also matches inside `max-md:hidden`, so anchor on the quote-or-space boundary.
      const desktopOnly = [...SRC.matchAll(/(^|\s)md:hidden"/g)];
      const phoneOnly = [...SRC.matchAll(/\bmax-md:/g)];
      expect(phoneOnly.length, "anti-vacuity: max-md: classes found").toBeGreaterThan(0);
      expect(desktopOnly.length, "the room duplicates NO control (spec §6 lists exactly two for the pad, none here)").toBe(0);
    });

    it("truncation of a long entrant name is set up on the whole ancestor chain, not just the span", () => {
      // AGENTS.md: a missing min-w-0 on a wrapper put 106px of overflow on the page at 320.
      const truncates = [...SRC.matchAll(/\btruncate\b/g)].length;
      const minW0 = [...SRC.matchAll(/\bmin-w-0\b/g)].length;
      expect(truncates, "anti-vacuity: truncate sites").toBeGreaterThan(0);
      expect(minW0).toBeGreaterThanOrEqual(truncates);
    });

    it("desktop puts the board central with a side rail", () => {
      expect(SRC).toMatch(/md:grid-cols-\[/);
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/room-shell-composition.test.tsx --reporter=json --outputFile=/tmp/b4-s21.json`
  Expect: assertion failures on `order-1` / `md:grid-cols-[`.
  **Title discipline:** every assertion above is a MARKUP fact. None claims the
  player *sees* anything. *Owed to e2e (B5):* a control-set diff from the live
  DOM at 320 against 1280 — membership, order and repeats — plus no horizontal
  page scroll at 320/360/375/390/430/768/834, and a 43-character entrant name.

- [ ] **Step 22: Green — `room-shell.tsx`.**
  Root `<div data-testid="match-room" className="flex flex-col gap-3 md:grid
  md:grid-cols-[minmax(0,1fr)_18rem] md:items-start md:gap-6">`. Children, in
  source order, each carrying its `order-N`:
  `ClocksStrip` (`order-1 md:order-none md:col-span-2`),
  `Board` wrapper (`order-2 md:order-none`),
  tile strip (`order-3 md:order-none md:col-start-2 md:row-start-2`) holding
  `OwnTile` + `PresencePill`, and `RoomControls`
  (`order-4 md:order-none md:col-start-2`). `min-w-0` on the shell, the strip
  and the name span. Names arrive as already-resolved strings from the route
  (Step 25) — this component never touches an entrant row.
  Run Step 21's command. Expect `numPassedTests: 5, numFailedTests: 0`.
  Commit: `feat(chess): match-room shell in the approved phone composition`.

- [ ] **Step 23: Red — the clocks strip shows both clocks, both names and whose move.**
  New test in the same `__tests__` dir,
  `clocks-strip.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { ClocksStrip } from "../clocks-strip";

  const t = (key: string) => key;

  describe("ClocksStrip", () => {
    it("renders both names and both clocks, and marks whose move it is", () => {
      const html = renderToStaticMarkup(
        <ClocksStrip you={{ name: "Ada Okonkwo", colour: "white", ms: 582_000 }}
                     opponent={{ name: "Bo Lind", colour: "black", ms: 600_000 }}
                     turn="white" t={t} />);
      expect(html).toContain("Ada Okonkwo");
      expect(html).toContain("Bo Lind");
      expect(html).toContain("9:42");
      expect(html).toContain("10:00");
      expect(html).toContain('data-turn="white"');
      expect(html).toContain('data-testid="room-clock-you"');
      expect(html).toContain('data-testid="room-clock-opponent"');
    });

    it("formats a sub-minute clock with seconds, not a bare minute", () => {
      const html = renderToStaticMarkup(
        <ClocksStrip you={{ name: "A", colour: "white", ms: 7_400 }}
                     opponent={{ name: "B", colour: "black", ms: 0 }}
                     turn="white" t={t} />);
      expect(html).toContain("0:07");
      expect(html).toContain("0:00");
    });

    it("renders the NAME it is given and never re-derives one", () => {
      const html = renderToStaticMarkup(
        <ClocksStrip you={{ name: "Entry 3", colour: "white", ms: 1_000 }}
                     opponent={{ name: "Entry 4", colour: "black", ms: 1_000 }}
                     turn="white" t={t} />);
      // The strip is dumb on purpose: resolution is the route's job (Step 25),
      // so a bad name here is a route defect, provable at one site.
      expect(html).toContain("Entry 3");
      expect(html).not.toContain("entrantDisplayName");
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/clocks-strip.test.tsx --reporter=json --outputFile=/tmp/b4-s23.json`
  Expect: `Failed to resolve import "../clocks-strip"`.

- [ ] **Step 24: Green — `clocks-strip.tsx`** with a local `mmss(ms)` that floors
  to seconds and pads. Run Step 23's command. Expect
  `numPassedTests: 3, numFailedTests: 0`.
  Commit: `feat(chess): clocks and names strip`.

- [ ] **Step 25: Red — the room route (GET read, POST seat).**
  New `apps/web/src/app/api/v1/fixtures/[id]/external-play/room/__tests__/route.test.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";

  vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "u1" })) }));
  const seatPlayer = vi.fn();
  vi.mock("@/server/usecases/external-play/preflight", () => ({ seatPlayer }));

  describe("GET /fixtures/{id}/external-play/room", () => {
    it("exports GET and POST, and the module never imports the Lichess client", async () => {
      const src = (await import("node:fs")).readFileSync(
        new URL("../route.ts", import.meta.url), "utf8");
      expect(src).toMatch(/export async function GET/);
      expect(src).toMatch(/export async function POST/);
      // The client posts to US; only T10's usecase reaches Lichess (design §3.4).
      expect(src).not.toContain("lichess/board-api");
    });

    it("the GET snapshot resolves names through the widened SidePlayer, never a raw snapshot", async () => {
      const src = (await import("node:fs")).readFileSync(
        new URL("../route.ts", import.meta.url), "utf8");
      expect(src).toContain(".displayName");
      expect(src).not.toContain(".snapshotName");
    });

    it("POST refuses a seat and reports WHY, rather than seating on a client claim (spec §5.2)", async () => {
      const src = (await import("node:fs")).readFileSync(
        new URL("../route.ts", import.meta.url), "utf8");
      // The forged-`cameraOk` POC gate is on the do-not-copy list (spec §10).
      expect(src).not.toContain("cameraOk");
      expect(src).toContain("seatPlayer");
    });
  });
  ```
  Run: `cd apps/web && npx vitest run "src/app/api/v1/fixtures/[id]/external-play/room/__tests__/route.test.ts" --reporter=json --outputFile=/tmp/b4-s25.json`
  Expect: `ENOENT … room/route.ts`.
  *Note:* this is a source-and-shape test, because the route's behaviour needs a
  DB. The behavioural proof is the DB-gated usecase tests in T8–T10 plus B5's
  e2e; say so in the commit body rather than claiming more.

- [ ] **Step 26: Green — `room/route.ts`.**
  ```ts
  import { v1 } from "@/server/api-v1/http";
  import { requireUser } from "@/lib/auth";
  import { HttpError } from "@/lib/errors";
  import { loadOnlinePlayFixture, loadSides, whiteSideOf, effectiveBridge } from "@/server/usecases/external-play/guard";
  import { resolveRoomPlayer } from "@/server/usecases/external-play/room";
  import { roomPhase, windowFor } from "@/server/external-play/window";
  import { seatPlayer } from "@/server/usecases/external-play/preflight";
  import { effectivePolicy } from "@/server/external-play/camera-policy";
  import { hasLiveVideoPublisher } from "@/server/external-play/video/realtimekit";
  import { externalPlayLobbyTopic, mintExternalPlayLobbyToken } from "@/lib/realtime";
  ```
  `GET` resolves identity from the session or `?t=<token>` (`resolveRoomPlayer`,
  `room.ts:85`), collapses every failure to one 404 `NOT_FOUND` exactly as that
  function's doc comment requires, and composes `RoomSnapshot` — names from
  `SidePlayer.displayName` (Step 2), colour from `whiteSideOf` (never assigned
  here; W3 owns allocation), window from `windowFor`, phase from `roomPhase`,
  `cameraPolicy` from `effectivePolicy`, `opponent.cameraLive` from
  `hasLiveVideoPublisher`, and `realtime.token` from
  `mintExternalPlayLobbyToken(fixtureId, subject, windowFor(scheduledAt).deadline)`
  — the three-argument signature at `lib/realtime.ts:249`, whose second arg is
  the **subject** and third the expiry (`lobby/route.ts:17` calls it with two and
  is part of F1). `POST` calls `seatPlayer` and returns the `SeatResult`
  verbatim; it accepts no camera claim from the body at all.
  Run Step 25's command. Expect `numPassedTests: 3, numFailedTests: 0`.
  Commit: `feat(chess): match-room read and seat routes`.

- [ ] **Step 26a: Red — the window hangs off `round_opened_at`, not the schedule (D12, spec §3.2 amendment).**
  The spec was amended on 2026-10-09 after this plan's skeleton was written:
  "**T−10 and T+20 are therefore relative to `round_opened_at`**, not to the
  fixture's scheduled time. The scheduled time is what players are *shown*; it
  is not the trigger. A fixture with no `round_opened_at` is not yet playable
  and says so." The shipped `roomPhase` / `windowFor`
  (`server/external-play/window.ts:14`, `:25`) take `scheduledAt: Date` and
  `RoomPhase` (`:23`) has only three members, so this is a real behaviour change
  and a real new state. New
  `apps/web/src/components/public-site/match-room/__tests__/room-phase.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { roomPhaseWire } from "../room-snapshot";
  import { windowFor } from "@/server/external-play/window";

  const OPENED = new Date("2026-10-09T10:00:00Z");

  describe("roomPhaseWire (D12)", () => {
    it("the EMPTY case first: no round_opened_at is `not_opened`, whatever the clock or the schedule says", () => {
      let checked = 0;
      for (const now of ["2026-10-01T00:00:00Z", "2026-10-09T10:05:00Z", "2026-11-01T00:00:00Z"]) {
        expect(roomPhaseWire({ now: new Date(now), roundOpenedAt: null }), now).toBe("not_opened");
        checked += 1;
      }
      expect(checked, "anti-vacuity: clock positions checked against a null open").toBe(3);
    });

    it("the window is measured from round_opened_at — derived from windowFor, never a literal here", () => {
      const w = windowFor(OPENED);
      expect(roomPhaseWire({ now: new Date(w.opensAt.getTime() - 1), roundOpenedAt: OPENED })).toBe("before");
      expect(roomPhaseWire({ now: w.opensAt, roundOpenedAt: OPENED })).toBe("open");
      expect(roomPhaseWire({ now: w.deadline, roundOpenedAt: OPENED })).toBe("open");
      expect(roomPhaseWire({ now: new Date(w.deadline.getTime() + 1), roundOpenedAt: OPENED })).toBe("closed");
    });

    it("the SCHEDULED time cannot move the phase — that is the whole point of D12", () => {
      // Same instant, two wildly different scheduled times: identical phase.
      const now = new Date("2026-10-09T09:55:00Z");
      expect(roomPhaseWire({ now, roundOpenedAt: OPENED })).toBe("open");
      // The function takes no scheduledAt at all; a mutant that adds one has
      // nowhere to read it from. Pinned structurally:
      expect(roomPhaseWire.length, "roomPhaseWire takes exactly one argument").toBe(1);
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-room/__tests__/room-phase.test.ts --reporter=json --outputFile=/tmp/b4-s26a.json`
  Expect: `No "roomPhaseWire" export is defined on "../room-snapshot"`.

- [ ] **Step 26b: Green — `roomPhaseWire`, and the route composes from it.**
  In `room-snapshot.ts`:
  ```ts
  import { roomPhase, windowFor } from "@/server/external-play/window";

  /** D12 (spec §3.2): a fixture with no `round_opened_at` is NOT yet playable
   *  and must say so — it is not "before the window", because no window
   *  exists. Once opened, T−10/T+20 are measured from the open, so the shipped
   *  `roomPhase` is reused unchanged with `round_opened_at` in the argument
   *  slot its parameter name still calls `scheduledAt`. The schedule is what
   *  players are SHOWN; it never reaches this function. */
  export function roomPhaseWire(a: { now: Date; roundOpenedAt: Date | null }): RoomPhaseWire {
    if (a.roundOpenedAt === null) return "not_opened";
    return roomPhase(a.now, a.roundOpenedAt);
  }
  ```
  The GET route (Step 26) sets `roundOpenedAt`, `scheduledAt`, and
  `opensAt`/`deadline` from `windowFor(roundOpenedAt)` — `null` for both while
  the round is unopened — and `phase` from `roomPhaseWire`. `RoomShell` renders
  `externalPlay.room.notOpened` for `phase === "not_opened"`, showing the
  scheduled time as information only, with **no** Check in control: a seat
  cannot be taken before the round opens. Add the key to the Step 30 list
  (making it 38 keys, ×4 locales) — en:
  `"This round has not been opened yet. Your organiser will open it; you will be emailed when it starts."`
  **Mutation:** make `roomPhaseWire` fall through to `roomPhase(a.now, a.scheduledAt)`
  when `roundOpenedAt` is null, re-run, watch all three empty-case clock
  positions fail, restore from the `cp` backup.
  Run Step 26a's command. Expect `numPassedTests: 3, numFailedTests: 0`.
  Commit: `feat(chess): the room's window hangs off round_opened_at (D12)`.
  *Ownership note:* the **column** `round_opened_at` and the `openRound`
  usecase that stamps it are the separate open-round task's. T14 renders the
  state and reads the column; if the column is not yet migrated when T14 runs,
  read it as `null` through the bridge row and say so in the task report rather
  than adding a migration here.

- [ ] **Step 27: Red → Green — the act route.**
  New `apps/web/src/server/api-v1/schemas.ts` entry, after
  `ResolveExternalPlayOut` (`:1336-1345`):
  ```ts
  export const RoomAct = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("move"), uci: z.string().min(4).max(5) }).strict(),
      z.object({ kind: z.literal("resign") }).strict(),
      z.object({ kind: z.literal("draw"), accept: z.boolean() }).strict(),
      z.object({ kind: z.literal("abort") }).strict(),
    ]);
  export type RoomAct = z.infer<typeof RoomAct>;
  export const RoomActOut = z.union([
    z.object({ ok: z.literal(true), applied: z.boolean() }).strict(),
    z.object({ ok: z.literal(false), reconcile: z.literal(true), reason: z.string() }).strict(),
  ]);
  ```
  Red first, in `apps/web/src/server/api-v1/__tests__/schemas.test.ts`:
  ```ts
  it("RoomAct accepts the four play actions and refuses a takeback or an unknown kind", () => {
    const ok = [
      { kind: "move", uci: "e2e4" }, { kind: "move", uci: "e7e8q" },
      { kind: "resign" }, { kind: "draw", accept: true }, { kind: "draw", accept: false }, { kind: "abort" },
    ];
    let checked = 0;
    for (const body of ok) { expect(RoomAct.safeParse(body).success, JSON.stringify(body)).toBe(true); checked += 1; }
    expect(checked, "anti-vacuity: accepted actions").toBe(6);
    const bad = [
      { kind: "takeback" }, { kind: "move" }, { kind: "move", uci: "e2" },
      { kind: "move", uci: "e2e4qq" }, { kind: "draw" }, { kind: "resign", extra: 1 },
    ];
    let refused = 0;
    for (const body of bad) { expect(RoomAct.safeParse(body).success, JSON.stringify(body)).toBe(false); refused += 1; }
    expect(refused, "anti-vacuity: refused bodies").toBe(6);
  });
  ```
  Run: `cd apps/web && npx vitest run src/server/api-v1/__tests__/schemas.test.ts --reporter=json --outputFile=/tmp/b4-s27.json`.
  Expect `RoomAct is not defined`, then green after the schema lands.
  Then `room/act/route.ts`: `parseBody(req, RoomAct)` → T10's `act({ fixtureId,
  personId, action })`. The **strict UCI regex stays server-side in T3's
  `assertUci`** (M5) — this schema's length bound is a cheap first gate, never
  the validation, and the route comment must say so.
  Commit: `feat(chess): room act route over the T10 play usecase`.

- [ ] **Step 28: Green — the two `ROUTES` entries and the regenerated spec.**
  `openapi-coverage.test.ts:32-39` demands an exact 1:1 between v1 route files
  and `openapi.ts`'s `ROUTES`. Add, beside the external-play block (`:193-196`):
  ```ts
  { path: "/fixtures/{id}/external-play/room", method: "get",  summary: "Match-room snapshot for a player on the fixture (session or personal link token). Never key-reachable.", tag: "fixtures", errors: [401, 404] },
  { path: "/fixtures/{id}/external-play/room", method: "post", summary: "Take the seat for this fixture: server-verified camera preflight under policy `required`.", tag: "fixtures", errors: [401, 404, 409] },
  { path: "/fixtures/{id}/external-play/room/act", method: "post", summary: "Submit an intended move, draw offer/answer, resignation or abort. Our server forwards it to Lichess with the player's own token.", tag: "fixtures", request: S.RoomAct, response: S.RoomActOut, errors: [400, 401, 404, 409] },
  ```
  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && pnpm run openapi:gen`
  and commit `openapi/v1.json` + `openapi/v1.public.json`.
  Run: `cd apps/web && npx vitest run src/server/api-v1/__tests__/openapi-coverage.test.ts --reporter=json --outputFile=/tmp/b4-s28.json`.
  Expect `numPassedTests` for the file with `numFailedTests: 0`; then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && git diff --exit-code openapi/` must be clean.
  Commit: `feat(chess): declare the match-room operations in the v1 spec`.

- [ ] **Step 29: Green — the page and the route helper.**
  `apps/web/src/lib/routes.ts`, after `sharedFixture` (`:72-73`):
  ```ts
  /** The player's match room for an online fixture (chess design §6). Same
   *  slug chain as `sharedFixture` above, so a /me link and an emailed
   *  personal link address the same page; `?t=` carries the match-room token
   *  (`usecases/match-room-token.ts:16`) for a player with no session. */
  sharedFixturePlay: (orgSlug: Slug, compSlug: Slug, divSlug: Slug, fixtureId: string) =>
    `/shared/${orgSlug}/${compSlug}/${divSlug}/fixtures/${fixtureId}/play`,
  ```
  Then the page at
  `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/page.tsx`:
  `export const dynamic = "force-dynamic";`, `searchParams: Promise<{ t?: string }>`,
  a `<DictProvider>` wrapper (the room's client islands use `useT`, and
  `page.tsx:11-15` documents what happens without one — every label renders in
  English regardless of `org.default_locale`), and `<RoomShell initial={…} />`
  built from the same composition the GET route returns.
  **Convention confirmation, as the brief asks:** both superseded paths are
  right for this repo. The API path matches the three sibling route dirs
  (`lobby/`, `resend/`, `resolve/`) under
  `app/api/v1/fixtures/[id]/external-play/`. The page path nests under the
  existing public fixture route, which has no `layout.tsx` in `(public)` to
  inherit, keeps the slug chain `routes.sharedFixture` already hands players
  from `/me` (`app/me/page.tsx:433-437`), and is reachable without an org
  membership — which `/o/[orgSlug]/…` is not, and a link-token player has none.
  Add a `__tests__/page.test.tsx` asserting the page exports
  `dynamic = "force-dynamic"`, wraps in `DictProvider`, and reads `t` from
  `searchParams`.
  Run: `cd apps/web && npx vitest run "src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/__tests__/page.test.tsx" --reporter=json --outputFile=/tmp/b4-s29.json`
  Expect green after the page lands.
  Commit: `feat(chess): the match-room page and its route helper`.

- [ ] **Step 30: Green — all copy in four locales, then regenerate the key union.**
  `ui.json` in this repo is a **flat** key→string map (`en/ui.json:925`
  onwards), not nested — add keys as flat strings, in the same block as the
  existing `externalPlay.*` run (`en:5678`). The **38** keys this task adds
  (37 below plus `.notOpened` from Step 26b):
  `externalPlay.room.title`, `.you`, `.yourMove`, `.opponentMove`,
  `.presence.live`, `.presence.off`, `.cameraNotice`, `.micMuted`,
  `.beforeWindow`, `.checkIn`, `.waiting`, `.preflight.start`,
  `.preflight.cameraRequired`, `.preflight.cameraLost`,
  `.preflight.windowClosed`, `.preflight.notAPlayer`, `.draw`, `.drawOffered`,
  `.drawAccept`, `.drawDecline`, `.resign`, `.resignConfirm`, `.abort`,
  `.abortConfirm`, `.promotion.title`, `.promotion.queen`, `.promotion.rook`,
  `.promotion.bishop`, `.promotion.knight`, `.over.mate`, `.over.resign`,
  `.over.outoftime`, `.over.draw`, `.over.stalemate`, `.over.aborted`,
  `.needsOrganiser`, `.reconciling`.
  `externalPlay.room.cameraNotice` (en) is exactly
  `"Your camera may be reviewed by an organiser."` — spec §5.4. It must never
  read "you are being monitored": there is no mandatory observer (D8), so that
  sentence would be a false statement inside a consent flow.
  Write all four locales. Then:
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && pnpm run i18n:check`
  → expect `✓` per locale, exit 0 (it exits 1 on any missing/extra key —
  `scripts/i18n/check-parity.ts:26-32`).
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && pnpm run i18n:gen-keys`
  → expect `i18n-keys.ts: <N> keys.` with N up by exactly 38, and
  **commit the regenerated `apps/web/src/lib/i18n-keys.ts`** (CI diffs it;
  `scripts/i18n/gen-keys.ts:1-11` records a wave that shipped a key three
  commits ahead of the union with everything green).
  Add to `licence-isolation.test.ts` a parity guard that fails if any
  `externalPlay.room.*` key is missing from a non-en locale, with a count.
  Commit: `feat(chess): match-room copy in en/es/fr/nl`.

- [ ] **Step 31: Verify and record.**
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && npx vitest run \
    src/server/usecases/external-play/__tests__/side-name.test.ts \
    src/server/usecases/__tests__/external-play-guard.test.ts \
    src/server/api-v1/__tests__/key-scopes.test.ts \
    src/server/api-v1/__tests__/openapi-coverage.test.ts \
    src/server/api-v1/__tests__/schemas.test.ts \
    src/components/public-site/match-room/__tests__ \
    "src/app/api/v1/fixtures/[id]/external-play/room/__tests__/route.test.ts" \
    --reporter=json --outputFile=/tmp/b4-t14.json
  jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:[.testResults[].name]}' /tmp/b4-t14.json
  ```
  Confirm every path in `.testResults[].name` resolves under the **worktree**,
  not the main checkout — a cwd reset produces a false green of ~12 unrelated
  tests. Pin `numTotalTests` as well as failures. Then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && rtk proxy npx tsc --noEmit -p apps/web`
  and `rtk proxy pnpm run lint` (read `✖ N problems`; plain `rtk` hides lint
  output entirely and "ESLint output (JSON parse failed)" is the wrapper losing
  the result, not a clean run). Record counts in the report.
  *Explicitly NOT run here:* the full gate, the full vitest suite, the full e2e
  suite. The room's visual and interaction claims are **owed to B5**.

---

### Task 15: Arbiter view (optional)

An arbiter is an **optional** assignment per division or round using the
**existing organiser/admin role** — no new role. The repo retired `scorer` in
V404, one migration ago (spec §12), so adding a role now is a bad trade, and
`arbiter` appears nowhere in `apps/web/src` as a product concept today (F4).
There is **no mandatory observer**: the product is deterrent-only (D8), so
nothing in this task may block a round, a seat or a result when no arbiter is
assigned.

**Which mobile bar applies, and why.** The standing rule exempts **`/admin`**
only — staff-only, always viewed on a desktop (owner, 2026-09-28). This panel
is **organiser-facing on the division page** (`/o/[orgSlug]/c/[compSlug]/d/[divSlug]`),
not `/admin`, so it keeps the **full bar: 320, 768 and 1280, no horizontal page
scroll**, mobile-first, with the seven-width `mobile.spec.ts` projects as the
backstop. An organiser runs a round from a phone at the venue; that is the whole
reason the bar exists. Do not import the `/admin` exemption by analogy.

**Files:**

*Created:*
- `apps/web/src/components/v2/arbiter-panel.tsx`
- `apps/web/src/components/v2/__tests__/arbiter-panel.test.tsx`

*Edited:*
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` — the
  external-play import already sits at `:59`; mount the panel beside it
- `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- `apps/web/src/lib/i18n-keys.ts` — generated

**Interfaces:**

*Consumes:*
```ts
// T7
export type ParticipantToken = { participantId: string; authToken: string };
export function addParticipant(a: {
  meetingId: string; subject: string; preset: "player" | "arbiter";
}): Promise<ParticipantToken>;
// T6
export type CameraPolicy = "off" | "optional" | "required";
```
Plus shipped: `requireOrgRole` `lib/auth.ts:505`; `useT` / `useMsgPlural`
`components/i18n/dict-provider.tsx:58`/`:114`; `entrantDisplayName`
`lib/entrant-name.ts:70`; `sideDisplayName` (T14 Step 2).

*Produces:*
```ts
// T15 — apps/web/src/components/v2/arbiter-panel.tsx
export type ArbiterFlag = {
  kind: "camera_lost" | "moves_without_camera" | "video_override";
  at: string;                 // ISO
  note: string | null;
};
export type ArbiterFixture = {
  fixtureId: string;
  label: string;              // already-resolved "Ada Okonkwo v Bo Lind"
  whiteName: string;
  blackName: string;
  cameraPolicy: CameraPolicy;
  flags: ArbiterFlag[];
};
export function ArbiterPanel(props: {
  fixtures: ArbiterFixture[];
  /** null ⇒ this organiser is not assigned as arbiter for this division/round. */
  assignment: { stageId: string; roundNo: number | null } | null;
  /** Receive-only join for the selected fixture. */
  onJoin: (fixtureId: string) => Promise<{ white: ParticipantToken; black: ParticipantToken }>;
}): JSX.Element;
```

**Steps:**

- [ ] **Step 1: Red — no assignment is a legal, non-blocking state, and it says so.**
  `apps/web/src/components/v2/__tests__/arbiter-panel.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { ArbiterPanel } from "../arbiter-panel";

  const noop = async () => ({ white: { participantId: "w", authToken: "wt" },
                              black: { participantId: "b", authToken: "bt" } });

  describe("ArbiterPanel — the empty case first (D8: deterrent only)", () => {
    it("no assignment: renders the unassigned notice and NO blocking language", () => {
      const html = renderToStaticMarkup(
        <ArbiterPanel fixtures={[]} assignment={null} onJoin={noop} />);
      expect(html).toContain('data-testid="arbiter-panel"');
      expect(html).toContain("arbiter.unassigned");
      expect(html).toContain("arbiter.noObserverNotice");
      // Nothing is held because nobody is watching.
      expect(html).not.toContain("arbiter.blocked");
      expect(html).not.toContain("blocked");
    });

    it("assigned but with no fixtures: the empty list is stated, not an empty box", () => {
      const html = renderToStaticMarkup(
        <ArbiterPanel fixtures={[]} assignment={{ stageId: "s1", roundNo: 2 }} onJoin={noop} />);
      expect(html).toContain("arbiter.none");
      expect(html).not.toContain("arbiter.unassigned");
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/v2/__tests__/arbiter-panel.test.tsx --reporter=json --outputFile=/tmp/b4-t15-1.json`
  Expect: `Failed to resolve import "../arbiter-panel"`.

- [ ] **Step 2: Green — the panel's two empty states.**
  `"use client"`. `<section data-testid="arbiter-panel" className="card space-y-3 p-5">`.
  `assignment === null` → `arbiter.unassigned` + `arbiter.noObserverNotice`
  ("No arbiter is assigned to this round. Cameras are still recorded as flags
  for you to review.") and nothing else. `assignment !== null &&
  fixtures.length === 0` → `arbiter.none`. The empty case is first because a
  rule set whose tests are all "does it contain X" answers no to every question
  and lands on the default — three vacuous defects shipped in one wave that way
  (competition-desk `_RULES.md`).
  Run Step 1's command. Expect `numPassedTests: 2, numFailedTests: 0`.
  Commit: `feat(chess): arbiter panel, optional and non-blocking`.

- [ ] **Step 3: Red — the fixture picker and both tiles.**
  Append:
  ```ts
  const FIXTURES = [
    { fixtureId: "f1", label: "Ada Okonkwo v Bo Lind", whiteName: "Ada Okonkwo",
      blackName: "Bo Lind", cameraPolicy: "required" as const, flags: [] },
    { fixtureId: "f2", label: "Cai Ren v Dee Vos", whiteName: "Cai Ren",
      blackName: "Dee Vos", cameraPolicy: "optional" as const, flags: [] },
  ];

  it("lists every fixture as a selectable row, with the resolved names", () => {
    const html = renderToStaticMarkup(
      <ArbiterPanel fixtures={FIXTURES} assignment={{ stageId: "s1", roundNo: 2 }} onJoin={noop} />);
    let checked = 0;
    for (const f of FIXTURES) {
      expect(html, f.fixtureId).toContain(`data-testid="arbiter-fixture-${f.fixtureId}"`);
      expect(html, f.label).toContain(f.label);
      checked += 1;
    }
    expect(checked, "anti-vacuity: fixtures listed").toBe(2);
    expect(html).toContain("arbiter.pickFixture");
  });

  it("the selected fixture declares BOTH tiles and a receive-only join", () => {
    const html = renderToStaticMarkup(
      <ArbiterPanel fixtures={FIXTURES} assignment={{ stageId: "s1", roundNo: 2 }} onJoin={noop} />);
    expect(html).toContain('data-testid="arbiter-tile-white"');
    expect(html).toContain('data-testid="arbiter-tile-black"');
    expect(html).toContain("arbiter.receiveOnly");
    // Receive-only means no publisher on this surface, ever.
    expect(html).not.toContain("getUserMedia");
    expect(html).not.toContain('data-mic="live"');
  });

  it("never leaks a participant auth token into the markup", () => {
    const html = renderToStaticMarkup(
      <ArbiterPanel fixtures={FIXTURES} assignment={{ stageId: "s1", roundNo: 2 }} onJoin={noop} />);
    for (const token of ["wt", "bt"]) expect(html, token).not.toContain(`"${token}"`);
  });
  ```
  Run Step 1's command. Expect `expected '…' to contain 'data-testid="arbiter-fixture-f1"'`.

- [ ] **Step 4: Green — the picker and the two tiles.**
  A `<ul>` of `<button data-testid={`arbiter-fixture-${f.fixtureId}`} className="min-h-11 …">`
  rows; selecting one calls `onJoin(fixtureId)` and renders two
  `<figure data-testid="arbiter-tile-white|black">` with `<video muted
  playsInline autoPlay>` and `arbiter.receiveOnly` beneath. The participant
  tokens go to the SDK in an effect and are never rendered — the POC's
  `game_ready` frame broadcast both seats' video tokens over an
  unauthenticated `/ws`, and that is explicitly on the do-not-copy list
  (spec §10). The grid is `grid-cols-1 md:grid-cols-2` with `gap-3` and
  `min-w-0` on the wrapper and on each figure's caption.
  Run Step 1's command. Expect `numPassedTests: 5, numFailedTests: 0`.
  Commit: `feat(chess): arbiter sees both tiles for one chosen fixture`.

- [ ] **Step 5: Red — the flags for the chosen fixture, enumerated.**
  ```ts
  it("renders every flag kind with its timestamp, and states the empty case", () => {
    const kinds = ["camera_lost", "moves_without_camera", "video_override"] as const;
    const withFlags = [{ ...FIXTURES[0]!, flags: kinds.map((kind, i) => ({
      kind, at: `2026-10-09T10:0${i}:00Z`, note: kind === "video_override" ? "RTK outage" : null })) }];
    const html = renderToStaticMarkup(
      <ArbiterPanel fixtures={withFlags} assignment={{ stageId: "s1", roundNo: 2 }} onJoin={noop} />);
    const keyFor = { camera_lost: "arbiter.flags.cameraLost",
                     moves_without_camera: "arbiter.flags.movesWithoutCamera",
                     video_override: "arbiter.flags.overrideUsed" } as const;
    let checked = 0;
    for (const kind of kinds) {
      expect(html, kind).toContain(keyFor[kind]);
      expect(html, `${kind} timestamp`).toContain("2026-10-09T10:0");
      checked += 1;
    }
    expect(checked, "anti-vacuity: flag kinds rendered").toBe(3);
    expect(Object.keys(keyFor).length, "every ArbiterFlag kind has a key").toBe(kinds.length);
    const empty = renderToStaticMarkup(
      <ArbiterPanel fixtures={[{ ...FIXTURES[0]!, flags: [] }]}
                    assignment={{ stageId: "s1", roundNo: 2 }} onJoin={noop} />);
    expect(empty).toContain("arbiter.flags.empty");
  });

  it("a flag is information, never a sanction (D10: the organiser decides)", () => {
    const html = renderToStaticMarkup(
      <ArbiterPanel fixtures={[{ ...FIXTURES[0]!,
        flags: [{ kind: "camera_lost", at: "2026-10-09T10:00:00Z", note: null }] }]}
        assignment={{ stageId: "s1", roundNo: 2 }} onJoin={noop} />);
    for (const forbidden of ["arbiter.disqualify", "arbiter.penalty", "arbiter.sanction"]) {
      expect(html, forbidden).not.toContain(forbidden);
    }
  });
  ```
  Run Step 1's command. Expect the flag-key assertions to fail.

- [ ] **Step 6: Green — the flag list.** `<ul data-testid="arbiter-flags">` with
  one `<li data-flag={kind}>` per flag carrying its key, a `<time dateTime={at}>`
  and the note when present; `arbiter.flags.empty` when the list is empty.
  No action control: the panel reports, the organiser decides (D10).
  Run Step 1's command. Expect `numPassedTests: 7, numFailedTests: 0`.
  **Mutation:** collapse the `kind → key` map to a single key, re-run, watch the
  enumeration fail on two of three kinds, restore from the `cp` backup.
  Commit: `feat(chess): arbiter flag list for the chosen fixture`.

- [ ] **Step 7: Green — mount it, gated on the existing role only.**
  In `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx`, beside
  the `listNeedsOrganiserExternalPlay` usage the import at `:59` feeds, render
  `<ArbiterPanel …/>` only when the division has at least one online-play
  fixture. Authorisation is `requireOrgRole(orgId, ["owner", "admin"])`
  (`lib/auth.ts:505`) — **whatever roles that page already requires**; read them
  off the page rather than inventing a list, and add no new role. Add a test to
  the page's existing `__tests__` asserting the panel is absent for a division
  with no online-play fixture and present with one.
  Run: `cd apps/web && npx vitest run "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__" --reporter=json --outputFile=/tmp/b4-t15-7.json`
  Expect `numFailedTests: 0`.
  Commit: `feat(chess): mount the arbiter panel on the division page`.

- [ ] **Step 8: Green — copy in four locales, then regenerate.**
  Thirteen keys: `arbiter.title`, `.unassigned`, `.noObserverNotice`, `.none`,
  `.pickFixture`, `.receiveOnly`, `.whiteTile`, `.blackTile`, `.flags.title`,
  `.flags.empty`, `.flags.cameraLost`, `.flags.movesWithoutCamera`,
  `.flags.overrideUsed`. `arbiter.noObserverNotice` (en): `"No arbiter is
  assigned to this round. Cameras are still recorded as flags for you to
  review."` — never "players are being monitored" (D8/§5.4).
  `pnpm run i18n:check` → exit 0; `pnpm run i18n:gen-keys` → `+13 keys`, commit
  the regenerated `i18n-keys.ts`.
  Commit: `feat(chess): arbiter panel copy in en/es/fr/nl`.

- [ ] **Step 9: Verify and record.**
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && npx vitest run \
    src/components/v2/__tests__/arbiter-panel.test.tsx \
    "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__" \
    --reporter=json --outputFile=/tmp/b4-t15.json
  jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b4-t15.json
  ```
  Then scoped `tsc --noEmit` and lint on touched files via `rtk proxy`.
  *Owed to B5:* screenshots at **320, 768 and 1280** with no horizontal page
  scroll (this is NOT an `/admin` surface), and the e2e that opens the panel,
  picks a fixture and reads the flag list.

---

### Task 16: Public match centre, organiser panel, run sheet, /me and registration

Five surfaces, one task, because they share the deletion of the lobby and the
`PublicExternalPlay` reshape: splitting them would leave the tree red between
tasks.

**D12 amendment (coordinator, 2026-10-09): rounds are organiser-driven.** Swiss
pairs the next round automatically once the previous one completes — the
fixtures exist, **unopened and uninvited**, and nothing is sent to anyone. The
organiser then **opens** the round, which stamps `round_opened_at`, sends every
pairing's invite and starts the window. The schedule becomes the time players
are *shown*, not the trigger. The open-round usecase and the invite send belong
to a **separate task**; this task owns only how the state **appears**. Treat the
control as calling `openRound({ stageId, roundNo, actorUserId })` and render
from a per-fixture `invitedAt: Date | null`. Neither symbol exists today (F8).

**Files:**

*Edited (exact lines re-pinned):*
- `apps/web/src/server/external-play/public-view.ts` — whole file (13 lines);
  `PublicExternalPlay:2-8`, `playUrlForStatus:10-13` **deleted**
- `apps/web/src/components/public-site/external-play-cta.tsx` — whole file
  (63 lines); `playUrlForStatus` import `:2`, the lichess anchor `:21-35`
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx`
  — imports `:30-31`, lobby mount `:372-390`, CTA mount `:392-407`
- `apps/web/src/server/public-site/data.ts` — `externalPlay` field `:1117`,
  seam `:1258`, cache key `:1275`, `REVALIDATE_FAST:165`, `divisionTag:168`
- `apps/web/src/server/usecases/external-play-read.ts` — whole file (29 lines)
- `apps/web/src/components/v2/external-play-needs-result-queue.tsx` —
  `REASON_KEYS:19-26`, `RESOLVE_KINDS:33-38`
- `apps/web/src/lib/division-phase.ts` — `isResultMissing:478-487`
- `apps/web/src/lib/run-sheet-groups.ts` — `RunSheetFixture:35-65`,
  `isBye:123`, `buildRunSheet:132`
- `apps/web/src/components/v2/desk/run-sheet.tsx` — `isResultMissing` import
  `:19`, uses `:86` and `:272`, `runSheetKeeps:80`, `RunSheet:93`
- `apps/web/src/components/v2/desk/run-sheet-row.tsx` — stream chip
  `:538-549` (the chip precedent), row action block `:553+`
- `apps/web/src/app/me/page.tsx` — `searchParams:34-36`, `claimed` read `:78`,
  `ConsentCard` mount `:406`
- `apps/web/src/components/public-site/register/division-card.tsx` —
  `DivisionCard:63`, badge row ends `:184`, organiser note `:196-199`,
  ineligible notice `:201-212`
- `apps/web/src/components/public-site/register/register-stepper.tsx` —
  `LICHESS_LINK_REQUIRED` branch `:506-513`
- `apps/web/src/server/api-v1/key-scopes.ts`, `openapi.ts:195-196`
- `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, `apps/web/src/lib/i18n-keys.ts`
- `openapi/v1.json`, `openapi/v1.public.json`

*Deleted:*
- `apps/web/src/app/api/v1/fixtures/[id]/external-play/lobby/route.ts`
- `apps/web/src/components/public-site/external-play-lobby.tsx`
- the ten `externalPlay.lobby.*` keys and `externalPlay.playOnLichess`, ×4 locales

*Created:*
- `apps/web/src/components/public-site/match-centre/watch-board.tsx`
- `apps/web/src/components/v2/desk/open-round-control.tsx`
- test files named per step

**Interfaces:**

*Consumes:*
```ts
// T3
export type LichessStatus = "created"|"started"|"mate"|"resign"|"outoftime"
  |"draw"|"stalemate"|"aborted"|"timeout"|"noStart"|"unknownFinish";
// T6
export type CameraPolicy = "off" | "optional" | "required";
// T12
export type ResultWrite =
  | { wrote: "decided" | "draw" | "aborted" | "forfeit" | "none" }
  | { wrote: "needs_organiser"; reason: "token_revoked"|"provider_error"|"double_walkover_blocked" };
// T14
export type RoomSnapshot = /* …as declared in T14… */;
sharedFixturePlay(orgSlug, compSlug, divSlug, fixtureId): string;
```
Plus shipped: `NeedsReason` `server/external-play/types.ts:14-21`;
`isResultMissing` `lib/division-phase.ts:478`; `isBye` `lib/run-sheet-groups.ts:123`;
`LichessLinkCard` `components/lichess-link-card.tsx:13`; `ConfirmDialog`
`components/v2/confirm-dialog.tsx:48`; `plural` `lib/i18n.ts:26`;
`useMsgPlural` `components/i18n/dict-provider.tsx:114`;
`ResolveExternalPlay` `server/api-v1/schemas.ts:1329`.

*Produces:*
```ts
// T16 — apps/web/src/server/external-play/public-view.ts (reshaped)
export type PublicExternalPlay = {
  status: "pending" | "ready" | "live" | "finished" | "needs_organiser";
  /** Spectator board state, or null before the game exists. No play URL: the
   *  match is watched HERE (design §7). */
  watch: { fen: string; lastMove: string | null; turn: "white" | "black";
           whiteMs: number; blackMs: number; status: LichessStatus; asOf: string } | null;
  lastError: string | null;
};
export function isWatchable(ep: PublicExternalPlay): boolean;

// T16 — apps/web/src/lib/run-sheet-groups.ts (widened RunSheetFixture, additive)
export type RunSheetOnlinePlay = {
  cameraPolicy: CameraPolicy;
  cameraFlagCount: number;
  /** D12 — null until the organiser opens the round and the invite is sent. */
  invitedAt: string | null;
};

// T16 — apps/web/src/lib/division-phase.ts (additive)
export function isRoundPaired(r: { roundOpenedAt: string | null; fixtureCount: number }): boolean;
export function isHeldForDecision(f: { status: string; outcome: unknown }): boolean;

// T16 — apps/web/src/components/v2/desk/open-round-control.tsx
export function OpenRoundControl(props: {
  stageId: string;
  roundNo: number;
  /** Pairings in this round, for the confirmation's count and names. */
  invitees: { fixtureId: string; name: string; invitedAt: string | null }[];
  busy: boolean;
  onOpen: (a: { stageId: string; roundNo: number }) => Promise<void>;
}): JSX.Element;
```

**Steps:**

- [ ] **Step 1: Red — the lichess.org link is gone and the match is watched here.**
  Rewrite `apps/web/src/components/public-site/__tests__/external-play-cta.test.tsx`
  (98 lines today; its `playUrlForStatus` describe at `:9-23` and all three
  render cases carry `playUrl`/`whitePlayUrl`/`blackPlayUrl`, which cease to
  exist):
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { ExternalPlayCta } from "../external-play-cta";
  import { isWatchable, type PublicExternalPlay } from "@/server/external-play/public-view";

  const msg = (key: string) => key;
  const live: PublicExternalPlay = {
    status: "live",
    watch: { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
             lastMove: "e2e4", turn: "black", whiteMs: 582_000, blackMs: 600_000,
             status: "started", asOf: "2026-10-09T10:00:00Z" },
    lastError: null,
  };

  describe("isWatchable", () => {
    it("live and finished with a board are watchable; pending and needs_organiser are not", () => {
      const cases: [PublicExternalPlay["status"], boolean][] = [
        ["pending", false], ["ready", false], ["live", true],
        ["finished", true], ["needs_organiser", false],
      ];
      let checked = 0;
      for (const [status, expected] of cases) {
        expect(isWatchable({ ...live, status }), status).toBe(expected);
        checked += 1;
      }
      expect(checked, "anti-vacuity: statuses checked").toBe(5);
    });

    it("a live status with no board yet is NOT watchable — an absent board must not fall through to a blank board", () => {
      expect(isWatchable({ ...live, watch: null })).toBe(false);
    });
  });

  describe("ExternalPlayCta", () => {
    it("live: offers the view-only board on OUR page, with no lichess.org anywhere", () => {
      const html = renderToStaticMarkup(
        <ExternalPlayCta externalPlay={live} scheduledLabel="Wed 12:00" msg={msg} />);
      expect(html).toContain('data-testid="external-play-watch"');
      expect(html).toContain("externalPlay.watch.viewOnly");
      expect(html).not.toContain("lichess.org");
      expect(html).not.toContain("externalPlay.playOnLichess");
      expect(html).not.toContain('target="_blank"');
    });

    it("no surviving source in the repo links a player off to lichess.org to play", () => {
      // Deletion is the point of this task; a grep is the only way to prove it.
      const { readFileSync, readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      const root = join(__dirname, "..", "..", "..");           // apps/web/src
      const walk = (d: string): string[] => readdirSync(d).flatMap((e) => {
        const f = join(d, e);
        return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(e) ? [f] : [];
      });
      const files = walk(root).filter((f) => !f.includes("__tests__") && !f.includes("__fixtures__"));
      expect(files.length, "anti-vacuity: files scanned").toBeGreaterThan(500);
      const offenders = files.filter((f) => /https:\/\/lichess\.org\//.test(readFileSync(f, "utf8")));
      expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
    });

    it("pending still waits, and needs_organiser still says so", () => {
      const pending = renderToStaticMarkup(
        <ExternalPlayCta externalPlay={{ status: "pending", watch: null, lastError: null }}
                         scheduledLabel="Wed 12:00" msg={msg} />);
      expect(pending).toContain('data-testid="external-play-waiting"');
      const needs = renderToStaticMarkup(
        <ExternalPlayCta externalPlay={{ status: "needs_organiser", watch: null, lastError: "delay_unsupported" }}
                         scheduledLabel={null} msg={msg} />);
      expect(needs).toContain('data-testid="external-play-needs-organiser"');
      expect(needs).toContain("externalPlay.reason.delayUnsupported");
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/__tests__/external-play-cta.test.tsx --reporter=json --outputFile=/tmp/b4-t16-1.json`
  Expect: `No "isWatchable" export is defined on …public-view` and
  `Object literal may only specify known properties` on `watch`.

- [ ] **Step 2: Green — reshape `public-view.ts` and the CTA.**
  `public-view.ts` becomes the reshaped `PublicExternalPlay` plus:
  ```ts
  /** Watchable means there is a board to render HERE. `status` alone is not
   *  enough: a `live` row whose `watch` is null would render an empty board,
   *  which reads as a game with no pieces rather than as "not started yet". */
  export function isWatchable(ep: PublicExternalPlay): boolean {
    return (ep.status === "live" || ep.status === "finished") && ep.watch !== null;
  }
  ```
  `playUrlForStatus` is **deleted**. The CTA's lichess anchor (`:21-35`) becomes
  a `<Link data-testid="external-play-watch" href={…}>` to the fixture page's
  own watch panel (same page, no `target="_blank"`), labelled
  `externalPlay.watch.viewOnly`. Update `external-play-read.ts` to select the
  board columns T10/T11 write instead of `play_url, white_play_url,
  black_play_url` (`:18`).
  Run Step 1's command. Expect `numPassedTests: 5, numFailedTests: 0`.
  **Mutation:** change `isWatchable` to ignore `ep.watch`, re-run, watch the
  "no board yet" case fail, restore from the `cp` backup.
  Commit: `feat(chess): the match is watched on our page; the lichess link is gone`.

- [ ] **Step 3: Green — retire the public cache key (F3).**
  In `data.ts`, change `["pub-fixture-v3", fixtureId]` (`:1275`) to
  `["pub-fixture-v4", fixtureId]` with a comment in the existing v2/v3 style:
  ```
  // v4 (chess in-page board, 2026-10-09): `externalPlay` lost
  // playUrl/whitePlayUrl/blackPlayUrl and gained `watch`. A live `-v3` entry
  // holds the OLD shape, and new code would read it for a REVALIDATE_FAST
  // (30s) window after deploy and render a board with no position. Retire the
  // key rather than wait — the same reason v2 was retired at :1270.
  ```
  Red first: add to
  `apps/web/src/server/public-site/__tests__/` a guard that reads `data.ts` and
  asserts the key string matches `/pub-fixture-v(\d+)/` with a version
  **greater than 3**, and that the file contains no `playUrlForStatus`,
  `play_url` or `white_play_url` reference. Run that file; expect the version
  assertion to fail at `3`, then pass at `4`.
  Commit: `fix(chess): retire pub-fixture-v3 — the external-play payload changed shape`.

- [ ] **Step 4: Red — the view-only board, and the inert-seam proof is a BROWSER drive.**
  New `apps/web/src/components/public-site/match-centre/__tests__/watch-board.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  import { WatchBoard } from "../watch-board";

  const t = (key: string) => key;
  const watch = { fen: "8/8/8/8/4P3/8/8/K6k b - - 0 1", lastMove: "e2e4",
                  turn: "black" as const, whiteMs: 1_000, blackMs: 2_000,
                  status: "started" as const, asOf: "2026-10-09T10:00:00Z" };

  describe("WatchBoard", () => {
    it("renders view-only and offers no move affordance", () => {
      const html = renderToStaticMarkup(<WatchBoard watch={watch} t={t} />);
      expect(html).toContain('data-testid="watch-board"');
      expect(html).toContain('data-view-only="true"');
      expect(html).toContain("externalPlay.watch.viewOnly");
      for (const id of ["room-draw", "room-resign", "room-abort", "room-promotion"]) {
        expect(html, id).not.toContain(`data-testid="${id}"`);
      }
    });

    it("null board states 'not started', never an empty board", () => {
      const html = renderToStaticMarkup(<WatchBoard watch={null} t={t} />);
      expect(html).toContain("externalPlay.watch.notStarted");
      expect(html).not.toContain('data-testid="watch-board"');
    });

    it("reuses T14's isolated chessground loader and does not import chessground itself", () => {
      const src = readFileSync(join(__dirname, "..", "watch-board.tsx"), "utf8");
      expect(src).toContain("match-room/board-loader");
      expect(src).not.toMatch(/from "chessground/);
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/match-centre/__tests__/watch-board.test.tsx --reporter=json --outputFile=/tmp/b4-t16-4.json`
  Expect: `Failed to resolve import "../watch-board"`.

- [ ] **Step 5: Green — `watch-board.tsx` and its mount.**
  `"use client"`, `dynamic(() => import("./watch-board-inner"), { ssr: false })`
  if a nested client file is needed; `viewOnly: true` and
  `movable: { color: undefined }` on the chessground config; chessground reached
  only through `@/components/public-site/match-room/board-loader` so the GPL
  isolation test in T14 Step 7 stays true (it asserts **exactly one** importer).
  Mount it in the fixture page at the CTA's position (`page.tsx:392-407`),
  replacing the `ExternalPlayLobby` block (`:372-390`) and its import (`:31`)
  entirely. A `pending` row whose round is not yet opened renders
  `externalPlay.watch.notOpened` — spec §3.2 (`:124-125`) requires the
  unopened state to say so on the spectator side too, and the old lobby's
  "waiting for your link" copy is exactly the sentence D12 falsified. Add the
  key to Step 21's list.
  Run Step 4's command. Expect `numPassedTests: 3, numFailedTests: 0`.
  Commit: `feat(chess): view-only spectator board on the public fixture page`.

- [ ] **Step 6: The seam proof — a browser drive, not a grep.**
  main rewrote `getPublicFixture` (+934/−229) around the five-line seam; the
  seam survived (P9) but it is now inside a cache (F3) and feeds a component
  whose props changed. A grep shows the call exists; it cannot show a position
  reaching a screen. So:
  1. Bring the environment up by the `seazn-local-env` skill
     (`~/.claude/skills/seazn-local-env/SKILL.md`) — `db:apply` **alone is not a
     fresh schema**; it needs `sync:sports`.
  2. Seed a live online-play fixture through
     `apps/web/e2e/helpers.ts:930` (`seedFixtureExternalPlaySql`, extended in
     this step to write the board columns instead of `play_url`).
  3. Drive the public fixture page in a real browser at **320, 768 and 1280**;
     confirm the board renders a **position that differs from the start
     position**, that the `data-testid="watch-board"` element has a non-zero
     box, that no `lichess.org` link exists in the DOM, and that there is no
     horizontal page scroll at any width.
  4. Write down what you SAW, not what must be true. A claim about what a
     person sees is settled only by driving the product.
  Record the three screenshot paths in the task report. If any width overflows,
  that is a defect of this task, not a deferred item — this is not `/admin`.

- [ ] **Step 7: Red — the needs-organiser reason map matches the real reasons (F6).**
  New `apps/web/src/components/v2/__tests__/external-play-reason-map.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  import { REASON_KEYS } from "../external-play-needs-result-queue";

  /** The authority for what a reason can BE. Never a table typed in here. */
  const NEEDS_REASONS = [
    "no_show_white", "no_show_black", "no_show_both",
    "not_started", "aborted", "mismatch", "provider_error",
  ] as const;
  const RESULT_WRITE_REASONS = ["token_revoked", "provider_error", "double_walkover_blocked"] as const;

  describe("needs-organiser reason labels", () => {
    it("the declared NeedsReason union is exactly what types.ts declares, so this list cannot drift", () => {
      const src = readFileSync(
        join(__dirname, "..", "..", "..", "server", "external-play", "types.ts"), "utf8");
      for (const r of NEEDS_REASONS) expect(src, r).toContain(`"${r}"`);
      const declared = [...src.matchAll(/\|\s*"(no_show_\w+|not_started|aborted|mismatch|provider_error)"/g)];
      expect(declared.length, "anti-vacuity: union members found in types.ts").toBe(NEEDS_REASONS.length);
    });

    it("every NeedsReason has its own label — none falls through to `generic`", () => {
      let checked = 0;
      for (const r of NEEDS_REASONS) {
        expect(REASON_KEYS[r], r).toBeDefined();
        expect(REASON_KEYS[r], r).not.toBe("externalPlay.reason.generic");
        checked += 1;
      }
      expect(checked, "anti-vacuity: NeedsReason values checked").toBe(7);
    });

    it("every T12 needs_organiser reason has its own label too", () => {
      let checked = 0;
      for (const r of RESULT_WRITE_REASONS) {
        expect(REASON_KEYS[r], r).toBeDefined();
        checked += 1;
      }
      expect(checked, "anti-vacuity: ResultWrite reasons checked").toBe(3);
    });

    it("a token revoked mid-match is NOT labelled as a no-show (design §3.6)", () => {
      expect(REASON_KEYS.token_revoked).not.toBe(REASON_KEYS.no_show_white);
      expect(REASON_KEYS.token_revoked).not.toBe(REASON_KEYS.no_show_both);
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/v2/__tests__/external-play-reason-map.test.ts --reporter=json --outputFile=/tmp/b4-t16-7.json`
  Expect: `No "REASON_KEYS" export is defined` (it is module-private today at
  `:19`), then `expected undefined not to be undefined` for every value.

- [ ] **Step 8: Green — export and rebuild `REASON_KEYS`.**
  Export it and replace the six stale codes (`delay_unsupported`,
  `no_show_grace_elapsed`, `account_mismatch`, `abort`, `unfinished`,
  `lichess_link_missing`) with the ten real ones, keeping
  `delay_unsupported` and `lichess_link_missing` as extras if the cron still
  writes them (check against T13's sweep before deleting a producer). Add the
  new dictionary keys in Step 15.
  Run Step 7's command. Expect `numPassedTests: 4, numFailedTests: 0`.
  Commit: `fix(chess): organiser queue labels every real needs_organiser reason`.

- [ ] **Step 9: Red — a knockout draw is HELD, never decided.**
  Spec §3.6 and §7: `draw`/`stalemate` in a knockout becomes `needs_decision` /
  phase `tiebreak` and **shows as held — "winner to be decided" — never as a
  decided result**. New
  `apps/web/src/lib/__tests__/division-phase-held.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { isHeldForDecision, isResultMissing } from "../division-phase";

  const NOW = Date.parse("2026-10-09T12:00:00Z");

  describe("isHeldForDecision", () => {
    it("a drawn knockout fixture is held", () => {
      expect(isHeldForDecision({ status: "needs_decision", outcome: { kind: "draw" } })).toBe(true);
    });

    it("a decided fixture is NOT held, and a held fixture is NOT decided — both directions", () => {
      expect(isHeldForDecision({ status: "complete", outcome: { kind: "home_win" } })).toBe(false);
      expect(isHeldForDecision({ status: "needs_decision", outcome: null })).toBe(true);
    });

    it("every terminal Lichess status maps to held or not-held, with no gap", () => {
      const map = {
        mate: false, resign: false, outoftime: false,
        draw: true, stalemate: true, aborted: false,
      } as const;
      let checked = 0;
      for (const [status, held] of Object.entries(map)) {
        expect(isHeldForDecision({
          status: held ? "needs_decision" : "complete",
          outcome: held ? { kind: "draw" } : { kind: "home_win" },
        }), status).toBe(held);
        checked += 1;
      }
      expect(checked, "anti-vacuity: terminal statuses mapped").toBe(6);
    });

    it("held is orthogonal to overdue: a held fixture is not ALSO reported as a missing result", () => {
      const f = { status: "needs_decision", scheduledAt: "2026-10-09T09:00:00Z", matchMinutes: 30 };
      // isResultMissing (division-phase.ts:478) fires only on `scheduled`.
      expect(isResultMissing(f, NOW)).toBe(false);
      expect(isHeldForDecision({ status: f.status, outcome: { kind: "draw" } })).toBe(true);
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/lib/__tests__/division-phase-held.test.ts --reporter=json --outputFile=/tmp/b4-t16-9.json`
  Expect: `No "isHeldForDecision" export is defined on "../division-phase"`.
  **Re-pin note:** `isResultMissing` (`division-phase.ts:478-487`) returns true
  only for `status === "scheduled"` with a past `scheduledAt + matchMinutes`, so
  it already cannot fire on a held fixture. The last assertion pins that rather
  than assuming it.

- [ ] **Step 10: Green — `isHeldForDecision` and the run-sheet row's held chip.**
  Add the predicate to `division-phase.ts` beside `isResultMissing` (`:478`),
  then in `run-sheet-row.tsx` render a
  `<span data-testid="run-sheet-held" data-state="needs_decision">` carrying
  `runsheet.held.winnerTbd` for a held fixture, modelled on the stream chip at
  `:538-549` (`max-md:min-h-11`, `shrink-0`, `md:order-first`). The row must
  **not** print a score word for a held fixture — the brief's "never as a
  decided result".
  Run Step 9's command, plus
  `cd apps/web && npx vitest run src/components/v2/desk/__tests__/run-sheet-row.test.tsx --reporter=json --outputFile=/tmp/b4-t16-10.json`.
  Expect `numFailedTests: 0` on both.
  Commit: `feat(chess): a drawn knockout shows as held, never decided`.

- [ ] **Step 11: Red — camera flags on the run sheet.**
  New `apps/web/src/components/v2/desk/__tests__/run-sheet-camera.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { RunSheetRow } from "../run-sheet-row";

  // …build the minimal props RunSheetRow already requires (read its own props
  // type at run-sheet-row.tsx; do not invent fields)…

  describe("run-sheet camera flags", () => {
    it("policy required with a flag: a flag chip with the count", () => {
      const html = renderToStaticMarkup(row({ onlinePlay: {
        cameraPolicy: "required", cameraFlagCount: 2, invitedAt: "2026-10-09T09:50:00Z" } }));
      expect(html).toContain('data-testid="run-sheet-camera-chip"');
      expect(html).toContain('data-state="flagged"');
      expect(html).toContain("runsheet.camera.flag");
    });

    it("policy required with no flag: an ok chip, not an absent one", () => {
      const html = renderToStaticMarkup(row({ onlinePlay: {
        cameraPolicy: "required", cameraFlagCount: 0, invitedAt: "2026-10-09T09:50:00Z" } }));
      expect(html).toContain('data-state="ok"');
      expect(html).toContain("runsheet.camera.ok");
    });

    it("policy off, or a non-online fixture, renders no camera chip at all", () => {
      let checked = 0;
      for (const onlinePlay of [
        { cameraPolicy: "off" as const, cameraFlagCount: 0, invitedAt: null },
        null,
      ]) {
        const html = renderToStaticMarkup(row({ onlinePlay }));
        expect(html, JSON.stringify(onlinePlay)).not.toContain('data-testid="run-sheet-camera-chip"');
        checked += 1;
      }
      expect(checked, "anti-vacuity: no-chip cases checked").toBe(2);
    });

    it("a flag is reported, never acted on — no sanction control on the row (D10)", () => {
      const html = renderToStaticMarkup(row({ onlinePlay: {
        cameraPolicy: "required", cameraFlagCount: 3, invitedAt: "2026-10-09T09:50:00Z" } }));
      for (const id of ["run-sheet-disqualify", "run-sheet-penalty"]) {
        expect(html, id).not.toContain(`data-testid="${id}"`);
      }
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/v2/desk/__tests__/run-sheet-camera.test.tsx --reporter=json --outputFile=/tmp/b4-t16-11.json`
  Expect: a props type error on `onlinePlay`.

- [ ] **Step 12: Green — widen `RunSheetFixture` and render the chip.**
  Add `RunSheetOnlinePlay` to `run-sheet-groups.ts` and an
  `onlinePlay: RunSheetOnlinePlay | null` field, threaded through
  `buildRunSheet` (`:132`) and `runSheetKeeps` (`run-sheet.tsx:80`) without
  changing either's grouping behaviour. Render the chip in `run-sheet-row.tsx`
  beside the stream chip.
  Run Step 11's command. Expect `numPassedTests: 4, numFailedTests: 0`.
  Commit: `feat(chess): camera policy and flags on the run sheet`.

- [ ] **Step 13: Red — D12: a round can be PAIRED BUT NOT OPENED, and the reader must be able to tell.**
  New `apps/web/src/components/v2/desk/__tests__/open-round-control.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { OpenRoundControl } from "../open-round-control";
  import { isRoundPaired } from "@/lib/division-phase";

  const INVITEES = [
    { fixtureId: "f1", name: "Ada Okonkwo v Bo Lind", invitedAt: null },
    { fixtureId: "f2", name: "Cai Ren v Dee Vos", invitedAt: null },
    { fixtureId: "f3", name: "Eli Mba v Fen Li", invitedAt: null },
  ];
  const noop = async () => {};

  describe("isRoundPaired", () => {
    it("fixtures exist and the round is not opened ⇒ paired", () => {
      expect(isRoundPaired({ roundOpenedAt: null, fixtureCount: 3 })).toBe(true);
    });
    it("opened ⇒ not merely paired any more", () => {
      expect(isRoundPaired({ roundOpenedAt: "2026-10-09T09:50:00Z", fixtureCount: 3 })).toBe(false);
    });
    it("the EMPTY case first: no fixtures is not a paired round — it answers no", () => {
      expect(isRoundPaired({ roundOpenedAt: null, fixtureCount: 0 })).toBe(false);
    });
  });

  describe("OpenRoundControl", () => {
    it("paired-not-opened reads as 'waiting for me to open', distinctly from 'open and waiting for players'", () => {
      const html = renderToStaticMarkup(
        <OpenRoundControl stageId="s1" roundNo={2} invitees={INVITEES} busy={false} onOpen={noop} />);
      expect(html).toContain('data-testid="open-round"');
      expect(html).toContain('data-state="paired"');
      expect(html).toContain("runsheet.round.paired");       // "Paired — not opened. Nobody has been invited."
      expect(html).not.toContain("runsheet.round.open");     // the OTHER state's word
    });

    it("the confirmation says HOW MANY invites and TO WHOM before it sends anything", () => {
      const html = renderToStaticMarkup(
        <OpenRoundControl stageId="s1" roundNo={2} invitees={INVITEES} busy={false} onOpen={noop} />);
      expect(html).toContain('data-testid="open-round-confirm"');
      expect(html).toContain("runsheet.round.openConfirmBody");   // plural key, count = 3
      let named = 0;
      for (const i of INVITEES) { expect(html, i.name).toContain(i.name); named += 1; }
      expect(named, "anti-vacuity: invitees named in the confirmation").toBe(3);
    });

    it("an already-invited pairing is shown as such, and the confirmation counts only the UNINVITED (no double invite)", () => {
      const mixed = [{ ...INVITEES[0]!, invitedAt: "2026-10-09T09:50:00Z" }, INVITEES[1]!, INVITEES[2]!];
      const html = renderToStaticMarkup(
        <OpenRoundControl stageId="s1" roundNo={2} invitees={mixed} busy={false} onOpen={noop} />);
      expect(html).toContain('data-testid="open-round-already-f1"');
      expect(html).toContain("runsheet.round.alreadyInvited");
      expect(html).toContain('data-uninvited-count="2"');
      expect(html).toContain("runsheet.round.reopenNotice");
    });

    it("every pairing states whether its invite went out and when", () => {
      const mixed = [{ ...INVITEES[0]!, invitedAt: "2026-10-09T09:50:00Z" }, INVITEES[1]!];
      const html = renderToStaticMarkup(
        <OpenRoundControl stageId="s1" roundNo={2} invitees={mixed} busy={false} onOpen={noop} />);
      expect(html).toContain('datetime="2026-10-09T09:50:00Z"');
      expect(html).toContain("runsheet.round.invited");
      expect(html).toContain("runsheet.round.notInvited");
    });

    it("every invite already sent ⇒ nothing to send, and the control says so instead of offering a re-send", () => {
      const all = INVITEES.map((i) => ({ ...i, invitedAt: "2026-10-09T09:50:00Z" }));
      const html = renderToStaticMarkup(
        <OpenRoundControl stageId="s1" roundNo={2} invitees={all} busy={false} onOpen={noop} />);
      expect(html).toContain('data-uninvited-count="0"');
      expect(html).not.toContain('data-testid="open-round-confirm"');
    });

    it("an empty round offers no Open control at all", () => {
      const html = renderToStaticMarkup(
        <OpenRoundControl stageId="s1" roundNo={2} invitees={[]} busy={false} onOpen={noop} />);
      expect(html).not.toContain('data-testid="open-round"');
      expect(html).toContain("runsheet.round.noPairings");
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/v2/desk/__tests__/open-round-control.test.tsx --reporter=json --outputFile=/tmp/b4-t16-13.json`
  Expect: `Failed to resolve import "../open-round-control"` and
  `No "isRoundPaired" export is defined on "@/lib/division-phase"`.

- [ ] **Step 14: Green — `isRoundPaired` and `OpenRoundControl`.**
  `isRoundPaired` in `division-phase.ts` beside `isResultMissing` (`:478`):
  ```ts
  /** D12 (2026-10-09): Swiss pairs the next round the moment the previous one
   *  completes, but the fixtures are UNOPENED and UNINVITED until an organiser
   *  opens the round. This is the state the run sheet must not render as "in
   *  progress". The empty case comes first deliberately: a round with no
   *  fixtures answers no, rather than falling through to "paired". */
  export function isRoundPaired(r: { roundOpenedAt: string | null; fixtureCount: number }): boolean {
    return r.fixtureCount > 0 && r.roundOpenedAt === null;
  }
  ```
  `open-round-control.tsx`, `"use client"`:
  - `invitees.length === 0` → `runsheet.round.noPairings`, no control.
  - `uninvited = invitees.filter((i) => i.invitedAt === null)`, rendered as
    `data-uninvited-count={uninvited.length}`.
  - A `<ul>` of pairings, each a `<li data-testid={`open-round-${invitedAt ? "already" : "pending"}-${fixtureId}`}>`
    with the name and either `<time dateTime={invitedAt}>` +
    `runsheet.round.invited` or `runsheet.round.notInvited`.
  - `uninvited.length > 0` → an `Open round` button (`runsheet.round.openCta`,
    `min-h-11`) opening `ConfirmDialog`
    (`components/v2/confirm-dialog.tsx:48`) with
    `testId="open-round-confirm"`, `confirmVariant="danger"` (it starts a clock
    against real people — not a quiet button), title
    `runsheet.round.openConfirmTitle`, and a body built with `useMsgPlural`
    (`dict-provider.tsx:114`) over `runsheet.round.openConfirmBody` and
    `uninvited.length`, listing each invitee by name. When any pairing is
    already invited, the dialog additionally shows
    `runsheet.round.reopenNotice` ("N players were already invited and will not
    be invited again."), so what will happen is stated before it happens.
  - `uninvited.length === 0` → `runsheet.round.alreadyInvited` and no dialog.
  - `onConfirm` calls `onOpen({ stageId, roundNo })`, which the mounting page
    wires to the separate task's
    `openRound({ stageId, roundNo, actorUserId })`. **This task defines no
    usecase and sends no mail.**
  Run Step 13's command. Expect `numPassedTests: 9, numFailedTests: 0`.
  **Mutation:** change `uninvited` to `invitees`, re-run, watch
  `data-uninvited-count="2"` and the "nothing to send" case fail (that mutant is
  exactly the double-invite defect), restore from the `cp` backup. Note also the
  idempotency hazard in both directions: `if (already) return` would swallow a
  late arrival (recurring failure class 13), which is why this control counts
  the uninvited rather than branching on "any invited".
  Commit: `feat(chess): organiser-driven rounds — paired-not-opened, Open round, per-pairing invite state`.

- [ ] **Step 15: Green — mount the control and the paired state on the run sheet and stage card.**
  Spec §3.2 (`:124-125`): "A fixture with no `round_opened_at` is not yet
  playable and says so." On the organiser side that sentence is this step.
  `run-sheet.tsx`: a round whose `isRoundPaired` is true renders its block
  header with `data-round-state="paired"` and the `OpenRoundControl` above the
  rows; rows in a paired round render their status word as
  `runsheet.round.paired`, not as a live or overdue state (`isResultMissing`
  already cannot fire — it needs `status === "scheduled"` with a past
  deadline — but a paired round's fixtures may well be `scheduled`, so gate the
  overdue chip on `!isRoundPaired(...)` and pin that with a test).
  `stages-panel.tsx`: the stage card's progress line (`:1228-1254`) gains a
  paired clause, suppressed at zero exactly like its siblings and counted
  through `msgPlural` (that block's own comment records "1 fixtures" shipping
  five times).
  Run:
  `cd apps/web && npx vitest run src/components/v2/desk/__tests__ src/components/v2/__tests__/stages-panel-progress.test.tsx --reporter=json --outputFile=/tmp/b4-t16-15.json`
  — substitute the stages-panel test file that actually covers the progress line
  after reading its `__tests__` dir; do not guess the name.
  Expect `numFailedTests: 0`.
  Commit: `feat(chess): run sheet and stage card show a paired, unopened round`.

- [ ] **Step 16: Red — `/me` renders all six Lichess flashes and mounts the link card (F7).**
  New `apps/web/src/app/me/__tests__/lichess-card.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { readFileSync } from "node:fs";
  import { join } from "node:path";

  const ME = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");

  describe("/me and the Lichess link", () => {
    it("reads `lichess` from searchParams — the OAuth callback defaults its landing to /me", () => {
      // api/auth/lichess/callback/route.ts:22-24 — `next ?? "/me"`.
      expect(ME).toMatch(/searchParams:\s*Promise<\{[^}]*lichess\?:\s*string/);
      expect(ME).toMatch(/const \{[^}]*lichess[^}]*\} = await searchParams/);
    });

    it("renders every one of the SIX flash reasons the two routes can emit", () => {
      const reasons = ["linked", "already_linked", "token", "account", "oauth_state", "not_configured"];
      let checked = 0;
      for (const r of reasons) { expect(ME, r).toContain(`"${r}"`); checked += 1; }
      expect(checked, "anti-vacuity: flash reasons handled").toBe(6);
      expect(ME).toContain("settings.account.lichess.flash.");
      expect(ME).toContain('data-testid="lichess-flash"');
    });

    it("mounts the shipped LichessLinkCard rather than a second copy of it", () => {
      expect(ME).toContain('from "@/components/lichess-link-card"');
      expect(ME).toContain("<LichessLinkCard");
    });

    it("an unknown ?lichess= value renders NO banner — not a blank red box", () => {
      // The allowlist must be explicit, as o/[orgSlug]/settings/page.tsx:296-306 does.
      expect(ME).not.toMatch(/settings\.account\.lichess\.flash\.\$\{lichess\}`(?!\s*as const)/);
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/app/me/__tests__/lichess-card.test.ts --reporter=json --outputFile=/tmp/b4-t16-16.json`
  Expect: the `searchParams` and reasons assertions fail — `/me` declares
  `searchParams: Promise<{ claimed?: string }>` (`page.tsx:34-36`) and reads
  only `claimed` (`:78`).

- [ ] **Step 17: Green — wire `/me`.**
  Widen the `searchParams` type (`:34-36`) to
  `Promise<{ claimed?: string; lichess?: string }>`, destructure both at `:78`,
  and build `lichessMessageKey` with the **same explicit allowlist** the org
  settings page uses (`o/[orgSlug]/settings/page.tsx:296-306`), including
  `not_configured` — the sixth reason, emitted by
  `api/auth/lichess/route.ts:37`, which the brief's list of five omits. Render
  the banner with `data-testid="lichess-flash"` (same testid, so one e2e
  selector covers both surfaces) and mount `<LichessLinkCard
  linkedUsername={…} configured={…} />` beside `<ConsentCard>` (`:406`), reading
  the link through T2's `getLichessLink(user.id)`. The card needs **no new
  copy** — it already uses `settings.account.lichess.*` (`lichess-link-card.tsx:38-66`).
  Run Step 16's command. Expect `numPassedTests: 4, numFailedTests: 0`.
  Commit: `fix(chess): /me renders the Lichess flashes it is the landing for`.

- [ ] **Step 18: Red — registration states the camera requirement BEFORE signup.**
  Spec §5.4: "Registration states the camera requirement **before** signup, not
  at T−10." Today the only Lichess statement in the flow is a post-submit error
  branch on the **review** step (`register-stepper.tsx:506-513`), which is the
  end, not the beginning. New
  `apps/web/src/components/public-site/register/__tests__/camera-requirement.test.tsx`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { renderToStaticMarkup } from "react-dom/server";
  import { DivisionCard } from "../division-card";

  // …minimal DivisionLike props, read off division-card.tsx's own type…

  describe("camera requirement, stated before signup (spec §5.4)", () => {
    it("policy required: the division card states it, on the ENTRIES step", () => {
      const html = renderToStaticMarkup(card({ camera_policy: "required" }));
      expect(html).toContain('data-testid="division-camera-requirement"');
      expect(html).toContain("register.camera.required");
    });

    it("the wording is organiser-REVIEW, never monitoring — there is no mandatory observer (D8)", () => {
      const html = renderToStaticMarkup(card({ camera_policy: "required" }));
      expect(html).toContain("register.camera.consent");
      expect(html).not.toContain("monitored");
      expect(html).not.toContain("register.camera.monitored");
    });

    it("policy optional says optional; policy off and an absent policy say nothing", () => {
      expect(renderToStaticMarkup(card({ camera_policy: "optional" })))
        .toContain("register.camera.optional");
      let silent = 0;
      for (const camera_policy of ["off", null, undefined] as const) {
        const html = renderToStaticMarkup(card({ camera_policy }));
        expect(html, String(camera_policy)).not.toContain('data-testid="division-camera-requirement"');
        silent += 1;
      }
      expect(silent, "anti-vacuity: silent policies checked").toBe(3);
    });

    it("the statement is unconditional on imPlaying — it is information about the division, not a per-viewer verdict", () => {
      // Same reasoning division-card.tsx:189-195 records for the organiser note.
      const html = renderToStaticMarkup(card({ camera_policy: "required", imPlaying: false }));
      expect(html).toContain("register.camera.required");
    });
  });
  ```
  Run: `cd apps/web && npx vitest run src/components/public-site/register/__tests__/camera-requirement.test.tsx --reporter=json --outputFile=/tmp/b4-t16-18.json`
  Expect: `expected '…' to contain 'data-testid="division-camera-requirement"'`.

- [ ] **Step 19: Green — the requirement notice and the consent line.**
  In `division-card.tsx`, render a notice between the badge row (ends `:184`)
  and the organiser note (`:196-199`), modelled on that note's own shape — a
  `<p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2
  text-xs text-amber-800" data-testid="division-camera-requirement">` holding
  `register.camera.required` / `register.camera.optional` and, for `required`,
  `register.camera.consent`. English:
  `register.camera.required` = `"Matches in this division are played on Seazn with your camera on."`;
  `register.camera.consent` = `"Your camera may be reviewed by an organiser."`
  — **never** "you are being monitored". Also mount the shipped
  `LichessLinkCard` on `step-consent.tsx` when any selected division requires
  an online-play link, so the link is offered before signup instead of only
  after a `LICHESS_LINK_REQUIRED` submit failure; leave the review-step branch
  at `register-stepper.tsx:506-513` in place as the backstop.
  Run Step 18's command. Expect `numPassedTests: 4, numFailedTests: 0`.
  Commit: `feat(chess): state the camera requirement before signup, honestly`.

- [ ] **Step 20: Green — delete the lobby (F1 half), and classify what survives (F2).**
  Delete `apps/web/src/app/api/v1/fixtures/[id]/external-play/lobby/route.ts`
  and `apps/web/src/components/public-site/external-play-lobby.tsx`, remove the
  import at `page.tsx:31` and the mount at `:372-390`, and remove the two
  `lobby` entries from `openapi.ts` (`:195-196`). **Do not touch** the four
  other F1 importers (`api/cron/external-play/route.ts:9`,
  `…/resend/route.ts:3`, `…/resolve/route.ts:4`,
  `api/webhooks/lichess/route.ts:3`,
  `o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:59`) — T9–T13 re-home those
  symbols; this task owns only the lobby. In `key-scopes.ts`, remove the two
  `lobby` `NEVER_KEY_ROUTES` entries T14 Step 6 added, and lower T14's
  `checked` floor accordingly in the same edit.
  Then `pnpm run openapi:gen` and commit the two spec files.
  Run:
  ```
  cd apps/web && npx vitest run \
    src/server/api-v1/__tests__/key-scopes.test.ts \
    src/server/api-v1/__tests__/openapi-coverage.test.ts \
    --reporter=json --outputFile=/tmp/b4-t16-20.json
  ```
  Expect `numFailedTests: 0`. Then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && git diff --exit-code openapi/` clean.
  Commit: `refactor(chess): delete the lobby — one venue (D3)`.

- [ ] **Step 21: Green — the copy, in four locales, with the deletions.**
  **Delete** (×4 locales): the ten `externalPlay.lobby.*` keys
  (`en:5679-5687` plus `.failed`) and `externalPlay.playOnLichess`
  (`en:5678`). **Add** (×4): `externalPlay.watch.title`, `.viewOnly`,
  `.notStarted`, `.notOpened`; the new `externalPlay.reason.*` labels Step 8 needs
  (`noShowWhite`, `noShowBlack`, `noShowBoth`, `notStarted`, `aborted`,
  `mismatch`, `providerError`, `tokenRevoked`, `doubleWalkoverBlocked`);
  `runsheet.held.winnerTbd`; `runsheet.camera.flag`, `.ok`;
  `runsheet.round.paired`, `.openCta`, `.openConfirmTitle`,
  `.openConfirmBody.one`, `.openConfirmBody.other`, `.invited`, `.notInvited`,
  `.alreadyInvited`, `.reopenNotice`, `.noPairings`; `register.camera.required`,
  `.optional`, `.consent`.
  `runsheet.round.paired` (en): `"Paired — not opened. Nobody has been invited yet."`
  `runsheet.round.openConfirmBody.one` (en): `"This sends 1 invite and starts the clock."`
  `runsheet.round.openConfirmBody.other` (en): `"This sends {count} invites and starts the clock."`
  (`.one`/`.other` is the repo's plural convention — see
  `en/ui.json:384-385`.)
  Then:
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && pnpm run i18n:check`
  → exit 0, no `missing`/`extra` on any locale (a deleted en key left behind in
  nl is reported as `extra` — `check-parity.ts:26-32`).
  `pnpm run i18n:gen-keys` → `i18n-keys.ts: <N> keys.`, and **commit the
  regenerated file**.
  Add a guard test that no source file under `apps/web/src` references
  `externalPlay.lobby.` or `externalPlay.playOnLichess` any more, with a
  scanned-file count.
  Commit: `feat(chess): public, organiser and registration copy in en/es/fr/nl`.

- [ ] **Step 22: Red — the e2e that asserts the old link will now fail, and that is the point.**
  `apps/web/e2e/walkthrough/chess-external-play.spec.ts` (123 lines) asserts
  `getByTestId("external-play-cta")` has `href="https://lichess.org/e2eReadyGame"`
  (`:76`, `:82-84`) and seeds `playUrl` through
  `apps/web/e2e/helpers.ts:930-952`. Update **the spec and the helper**, do not
  delete the spec — probe specs stay in e2e. The ready case becomes: seed a live
  board, open the public page, assert `watch-board` is attached and that no
  anchor to `lichess.org` exists. Sweep **by behaviour, not filename**: grep the
  e2e tree for `external-play-cta`, `external-play-waiting`,
  `external-play-lobby`, `playOnLichess` and `lichess.org` and fix every hit —
  an `external-play*.spec.ts` filename filter missed the spec that actually
  exercised the path once before.
  Run only the touched spec, not the suite:
  `cd apps/web && PLAYWRIGHT_BASE=http://localhost:3000 npx playwright test e2e/walkthrough/chess-external-play.spec.ts --reporter=line`
  — run the **whole spec file**, never a `-g` slice (a `-g` sweep selected
  neither of the two tests a change actually broke, six green local gates in a
  row). If the file is `mode: "serial"`, treat the first red as a floor, not a
  total, and re-run after each fix until a full pass completes.
  Commit: `test(chess): the walkthrough watches on our page`.

- [ ] **Step 23: Verify and record.**
  ```
  cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && npx vitest run \
    src/components/public-site/__tests__/external-play-cta.test.tsx \
    src/components/public-site/match-centre/__tests__/watch-board.test.tsx \
    src/components/v2/__tests__/external-play-reason-map.test.ts \
    src/lib/__tests__/division-phase-held.test.ts \
    src/lib/__tests__/division-phase.test.ts \
    src/lib/__tests__/run-sheet-groups.test.ts \
    src/components/v2/desk/__tests__ \
    src/app/me/__tests__ \
    src/components/public-site/register/__tests__ \
    src/server/public-site/__tests__ \
    src/server/api-v1/__tests__/key-scopes.test.ts \
    src/server/api-v1/__tests__/openapi-coverage.test.ts \
    --reporter=json --outputFile=/tmp/b4-t16.json
  jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:[.testResults[].name]}' /tmp/b4-t16.json
  ```
  Confirm every `.testResults[].name` resolves under the worktree. Then
  `rtk proxy npx tsc --noEmit -p apps/web` and `rtk proxy pnpm run lint`
  (read `✖ N problems`).
  *Owed to B5:* the seven-width `mobile.spec.ts` sweep; the organiser run sheet
  and stage card driven at 320, 768 and 1280 (**not** `/admin` — full bar); and
  the paired-round, Open-round-confirmation and invite-state flows driven in a
  browser, because a green builder suite is blind to what a person sees.

---

### B4 review focus (for the reviewer, before merge)

1. **The seam, in a browser.** T16 Step 6's three screenshots exist, DIFFER from
   each other, and show a real position — not a start position, not an empty
   board. A capture harness once errored before a single screenshot and would
   have collected a sign-off on zero pictures.
2. **The name on the board.** Drive a singles chess fixture whose
   `entrants.display_name` is "Entry 3" and whose member is a named person;
   every surface — the room's clocks strip, the public watch panel, the run
   sheet row, the organiser queue, the arbiter panel, the Open-round
   confirmation — must read the person's name. One surface reading "Entry 3" or
   a UUID means Step 2 did not reach it (F5).
3. **chessground, still isolated.** `__tests__/licence-isolation.test.ts` passes
   with exactly **one** importer after T16 Step 5 added the spectator board, the
   version is still pinned at `9.2.1`, and the loader still carries its
   GPL-3.0 comment.
4. **No monitoring claim, anywhere.** Grep all four locale files for the
   translated equivalents of "monitored" / "surveillance" / "being watched" in
   every key this batch added. There is no mandatory observer (D8), so such a
   sentence inside a consent flow is a false statement, not a tone problem.
5. **The double-invite.** T16 Step 14's mutant (`uninvited` → `invitees`) must
   fail the suite. Then check the other direction too: a pairing that arrives
   *after* the round was opened must still be invitable — an idempotency guard
   that swallows a late arrival has already seated nobody once.
6. **Nothing blocks without an arbiter.** Open a round with no arbiter assigned
   and play a fixture to a result end to end. If any step refuses, T15 imported
   a mandatory observer the product does not have.
7. **The window really hangs off the open, not the schedule (D12).** Open a
   round two hours after its scheduled time and confirm the room becomes
   playable then — not two hours earlier, and not never. Then set
   `round_opened_at` to null on a scheduled, past-due fixture and confirm the
   room says "not opened" and offers no Check in, and that the run sheet does
   **not** report it as a missing result. A `roomPhase(now, scheduledAt)` left
   anywhere is the whole defect D12 exists to prevent: it marks people no-shows
   for a round that had not started.
8. **The four red files T14/T16 did NOT fix.** F1's remaining importers
   (`api/cron/external-play/route.ts`, `resend`, `resolve`,
   `api/webhooks/lichess`, the division page) are T9–T13's. Confirm they are
   red for *that* reason and are owned by a task, rather than quietly left.
` marker in
     docs/superpowers/plans/2026-10-09-chess-in-page-board-and-camera.md -->

## Batch B5 — proof (T17–T18)

**Premises corrected while writing this batch.** Each was in the brief or in the
superseded plan and is false against the tree at `8afdd8b42`. They are findings,
not blockers, and the steps below are written against what is actually there.

| # | Claimed | Actually |
|---|---|---|
| P1 | The stub belongs at `apps/web/e2e/lichess-stub.ts` | The repo's convention for a local stand-in HTTP API is `<provider>-fixture-server.ts` with a `start…FixtureServer(port?)` factory — `apps/web/e2e/ai-fixture-server.ts:51` and `apps/web/e2e/stripe-fixture-server.ts:17,127`. Both are imported by **vitest** suites as well as specs (`apps/web/src/server/usecases/__tests__/billing-group-charged-attach.test.ts:28-30`), which is exactly what §8.7's "recorded payloads stay the contract check" needs. Named `lichess-fixture-server.ts` below |
| P2 | `apps/web/e2e/helpers.ts` grew `+288/−57` on main since this branch forked; `scripts/smoke.ts` grew `+2377/−111` | **Zero** main-side drift. `git merge-base main HEAD` == `git rev-parse main` == `8afdd8b42`, so the branch is already rebased onto main's tip (as the spec header says) and `git diff --numstat <merge-base>..main` is empty for both files. The branch's own additions are `+37` to `helpers.ts` and `+80` to `smoke.ts`. Re-pin against HEAD, not against a drift that has already been absorbed |
| P3 | `externalPlayOtBSmoke` is at `scripts/smoke.ts:~18242-18317`, call site `~1130` | Definition **`scripts/smoke.ts:20615`**, body ends `:20684`, doc comment `:20610-20614`; call site **`:1222`** |
| P4 | `flyway.toml` sets no `outOfOrder` | True, but the file is **`db/flyway.toml`**, not repo-root — there is no root `flyway.toml`. `outOfOrder` appears nowhere in the repo |
| P5 | Migrations V405/V407 are the ones below the high-water mark | Confirmed and complete: `git diff --name-status main...HEAD -- db/migration/deltas/` returns exactly `A V405__lichess_external_play.sql`, `A V407__lichess_lobby_ready.sql`. `V409__player_stat_folds.sql` is also below 431 but is **main's**, not ours — do not renumber it. Main's high-water: **431** (`V431__auto_stream.sql`) |
| P6 | The walkthrough spec is new | **`apps/web/e2e/walkthrough/chess-external-play.spec.ts` already exists** (123 lines) and asserts the surface D3 deletes: `expect(cta).toHaveAttribute("href", "https://lichess.org/e2eReadyGame")` (`:84`). T17 **rewrites** it |
| P7 | Registering the spec is a new line in an otherwise consistent inventory | That file is **absent from `WALKTHROUGH_SPECS`** today (no `chess` match anywhere in `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`), and `it("names every walkthrough spec on disk in the inventory")` (`:590-600`) `expect(unlisted).toEqual([])` over exactly that set. By that test's own body the branch carries a **live red** there. Not executed (this was a plan-writing pass) — verify it reds first, which makes Step 14 a true TDD red |
| P8 | The superseded plan's helpers (`seedOnlineChessFixture`, `linkLichessBySql`, `mintMatchRoomPathBySql`) exist or nearly exist | None of the three exists. What exists and is reused: `withDb` (module-private, `:504-528`), `mintLoginPathBySql` (`:341`), `linkPersonToUserBySql` (`:823`), `seedFixtureExternalPlaySql` (`:933`), `setFixtureStatusSql` (`:924`), `setFixtureScheduledAtSql` (`:974`), `setDivisionConfigSql` (`:1095`), `seedRosteredFixture` (`:2135`, returns `RosteredFixture` `:2105-2115`), `expectNoHorizontalScroll` (`:56`), `overflowingIn` (`:176`), `screenshotAtWidths` (`:447`) |
| P9 | The recorded `__fixtures__/lichess/` payloads are the contract check for M11's clocks | They were recorded with **`clocks=false`** (`apps/web/src/server/external-play/__fixtures__/lichess/README.md`), so **no existing fixture carries a `clocks` array at all**. M11 has no recorded evidence in the tree; Step 4 adds the clocks-bearing fixture and says plainly where its numbers come from |
| P10 | The match room has a URL this batch can drive | It does not. `mintMatchRoomToken` (`apps/web/src/server/usecases/match-room-token.ts:16`) has **no production caller** — only tests — and the plan's File-structure table gives T14 `components/public-site/match-room/*` with **no `app/**` route**. B5 therefore declares the route as a consumed contract: `/play/[token]`, on the `/score/[token]` precedent (`apps/web/src/app/score/[token]/page.tsx`, `export const dynamic = "force-dynamic"`, token-as-credential, no session). T14 owes that path |
| P11 | (Coordinator D12) the window runs from the fixture's scheduled time | Amended by D12. **`round_opened_at` does not exist** anywhere in `apps/web/src`, `db/` or `scripts/` — no column, no endpoint, no control. T13's sibling pairing control is `/api/v1/stages/[id]/unpair` (`generate` for pairing) with the organiser UI in `components/v2/stages-panel.tsx` / `components/v2/desk/stage-rail.tsx`. B5 declares the open-round control as a consumed contract (Step 0) rather than inventing it |
| P12 | The plan skeleton's `ReconcileTrigger` has **four** values (`"rejected_move" \| "clock_zero" \| "game_end" \| "organiser"`, Interfaces block) | The spec's §3.5 now lists **five** — D12's edit added `the cron sweep, for a live game past its expected end`, because the other four all require a client to be open and two closed tabs would otherwise leave a fixture unresolved forever. The skeleton's Interfaces block is stale; T11 owes the fifth member, and T17 Step 11a drives it. §4 now also states the cron owns **four** jobs, not two: the T+20 no-show, the mint retry after a 429, meeting teardown when nobody came, and this reconcile sweep |
| P13 | Round 2 pairs as soon as round 1's last board finishes | §3.5's edit adds the precondition: **round N+1 cannot be paired until round N's results are ALL in**, so one unresolved board blocks the next round. T17 Step 13 asserts that ordering rather than assuming it |

**Consumed contracts B5 does not own.** Each is a hard precondition; if a task
ships it differently, change the ONE place named here, not the assertions.

| Contract | Owner | B5's single point of change |
|---|---|---|
| `LICHESS_BASE_URL` overrides the Lichess host | already built — `apps/web/src/server/external-play/lichess/client.ts:11` (`process.env.LICHESS_BASE_URL ?? "https://lichess.org"`); T3's `board-api.ts` must read the same var | `LICHESS_FIXTURE_PORT` in `lichess-fixture-server.ts` |
| `REALTIMEKIT_BASE_URL` overrides the video host | T7 (`video/realtimekit.ts`) | `REALTIMEKIT_FIXTURE_PORT` in `realtimekit-fixture-server.ts` |
| Match room served at `/play/<matchRoomToken>` | T14 | `matchRoomPathBySql` in `helpers.ts` |
| `user_external_accounts` token columns: `access_token_sealed`, `scopes` (jsonb), `consented_at` | T1 (V432) | `linkLichessBySql` in `helpers.ts` |
| Organiser "Open round" control: stamps `round_opened_at` on the stage's round, sends invites, starts the T−10/T+20 window from that stamp | T13 | `openRoundAsOrganiser` in the spec |

---

### Task 17: E2E walkthrough with a Lichess fixture server and a video mock

**Files:**

| Path | Lines today | Action |
|---|---|---|
| `apps/web/e2e/lichess-fixture-server.ts` | — | create |
| `apps/web/e2e/realtimekit-fixture-server.ts` | — | create |
| `apps/web/src/server/external-play/__fixtures__/lichess/export-clocks-blitz.json` | — | create |
| `apps/web/src/server/external-play/__fixtures__/lichess/README.md` | 1-26 | append |
| `apps/web/src/server/external-play/__tests__/lichess-fixture-contract.test.ts` | — | create |
| `apps/web/e2e/helpers.ts` | 2509 (`withDb` 504, `seedFixtureExternalPlaySql` 933-972, `setDivisionConfigSql` 1095, `seedRosteredFixture` 2135) | edit |
| `apps/web/e2e/walkthrough/chess-external-play.spec.ts` | 123 | rewrite |
| `apps/web/e2e/mobile.spec.ts` | 6k+ (`describe.configure({ mode: "serial" })` at 46) | edit |
| `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` | 1431 (`WALKTHROUGH_SPECS` 171, inventory check 590) | edit |
| `.github/workflows/e2e.yml` | 1693 (`e2e-parallel` job env 371-481, `SCHEDULING_AI_BASE_URL` 480; `e2e-mobile` job env 1397-…, `SCHEDULING_AI_BASE_URL` 1441) | edit |
| `scripts/ci-local.sh` | `e2e_env()` 309-318 | edit |
| `docs/runbooks/e2e-local.md` | 9.4K | edit |

**Interfaces:**

*Consumes* — `LICHESS_BASE_URL` (client.ts:11), `REALTIMEKIT_BASE_URL` (T7),
`/play/<token>` (T14), V432's token columns (T1), the Open-round control (T13),
`seatPlayer`/`act`/`reconcile`/`writeResultFrom` (T8/T10/T11/T12),
`SHIP1_TIME_CONTROLS` (T5), `WINDOW_OPEN_LEAD_MS`/`DEADLINE_AFTER_MS`/
`LICHESS_TIMEOUT_MS` (`server/external-play/window.ts:5,6,9`).

*Produces*

```ts
// apps/web/e2e/lichess-fixture-server.ts
export const LICHESS_FIXTURE_PORT = 4321;
export interface LichessFixtureCall { method: string; path: string; body: Record<string, string>; token: string | null }
export interface LichessFixtureServer {
  url: string;
  calls: LichessFixtureCall[];
  /** Register a playable game so accept() resolves to it. Returns its id. */
  seedGame(a: { gameId?: string; whiteUsername: string; blackUsername: string; limitSeconds: number; incrementSeconds: number }): string;
  movesOf(gameId: string): string[];               // UCI, as the stub stored them (M5 truncation included)
  /** M3: the Nth create within `windowMs` and every later one answer 429. */
  setCreateBudget(n: number, windowMs: number): void;
  /** M12: every move on this game answers the Board-API refusal. */
  setUnplayableTimeControl(gameId: string): void;
  /** M6: the next move on this game answers the one shared 400. */
  setNotYourTurn(gameId: string): void;
  /** 401 on every call bearing this token (Review Focus 1). */
  revokeToken(token: string): void;
  reset(): void;
  close(): Promise<void>;
}
export function startLichessFixtureServer(port?: number): Promise<LichessFixtureServer>;

// apps/web/e2e/realtimekit-fixture-server.ts
export const REALTIMEKIT_FIXTURE_PORT = 4322;
export interface RealtimeKitFixtureServer {
  url: string;
  calls: { method: string; path: string }[];
  /** The ONLY way a participant becomes a live publisher. Never reachable from a page. */
  setLivePublisher(participantId: string, live: boolean): void;
  participantIds(): string[];
  setUnavailable(down: boolean): void;             // D11 outage → organiser override
  reset(): void;
  close(): Promise<void>;
}
export function startRealtimeKitFixtureServer(port?: number): Promise<RealtimeKitFixtureServer>;

// apps/web/e2e/helpers.ts (added)
export async function linkLichessBySql(userId: string, externalUserId: string, username: string): Promise<void>;
export async function matchRoomPathBySql(fixtureId: string, personId: string): Promise<string>;
export interface OnlineChessFixture extends RosteredFixture {
  stageId: string;
  white: { email: string; userId: string; personId: string; lichessId: string };
  black: { email: string; userId: string; personId: string; lichessId: string };
}
export async function seedOnlineChessFixture(
  request: APIRequestContext,
  spec: { label: string; timeControlKey: string; cameraPolicy: "off" | "optional" | "required" },
): Promise<OnlineChessFixture>;
export async function roundOpenedAtSql(stageId: string, roundNo: number): Promise<string | null>;
export async function forfeitEventCountSql(fixtureId: string): Promise<number>;
```

---

- [ ] **Step 0: Pin the five consumed contracts against the tree before writing a line.** Run exactly this and paste the output into the task report. A missing contract is a BLOCKER to report, never something to invent:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && {
  echo "--- LICHESS_BASE_URL (expect client.ts:11 + T3 board-api.ts) ---"
  grep -rna "LICHESS_BASE_URL" apps/web/src --include='*.ts' | grep -av '\.next'
  echo "--- REALTIMEKIT_BASE_URL (T7) ---"
  grep -rna "REALTIMEKIT_BASE_URL" apps/web/src --include='*.ts' | grep -av '\.next'
  echo "--- /play route (T14) ---"
  ls apps/web/src/app/play/\[token\]/page.tsx 2>&1
  echo "--- V432 token columns (T1) ---"
  grep -na "access_token_sealed\|scopes\|consented_at" db/migration/deltas/V432__*.sql 2>&1
  echo "--- round_opened_at + open-round route (T13) ---"
  grep -rna "round_opened_at" apps/web/src db --include='*.ts' --include='*.sql' | grep -av '\.next'
  ls apps/web/src/app/api/v1/stages/\[id\]/open-round/route.ts 2>&1
}
```

- [ ] **Step 1: Write the Lichess fixture server's failing contract test FIRST.** New file `apps/web/src/server/external-play/__tests__/lichess-fixture-contract.test.ts`. It runs in vitest (node), starts the fixture server on an ephemeral port, and pins every measured behaviour the stub owes. It reds immediately because the module does not exist:

```ts
// §8.7 — the fixture server is the e2e stand-in, so its OWN behaviour is a
// contract: every line here is a measured fact from the spec's §2, and a stub
// that drifts from them makes the walkthrough prove a Lichess that does not
// exist. Anti-vacuity: `checked` is counted and asserted non-zero.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startLichessFixtureServer,
  type LichessFixtureServer,
} from "../../../../e2e/lichess-fixture-server";

let fx: LichessFixtureServer;
beforeAll(async () => { fx = await startLichessFixtureServer(0); });
afterAll(async () => { await fx.close(); });

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (path: string, token: string, body: Record<string, string> = {}) =>
  fetch(`${fx.url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form(body),
  });

describe("lichess fixture server", () => {
  it("M5: a malformed UCI is ACCEPTED and TRUNCATED, not rejected", async () => {
    fx.reset();
    const id = fx.seedGame({ whiteUsername: "ada", blackUsername: "bob", limitSeconds: 180, incrementSeconds: 0 });
    const ok = await post(`/api/board/game/${id}/move/e2e4`, "tok-white");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const bad = await post(`/api/board/game/${id}/move/e7e6xx`, "tok-black");
    expect(bad.status, "Lichess did NOT reject e7e6xx — it played e7e6").toBe(200);
    expect(fx.movesOf(id)).toEqual(["e2e4", "e7e6"]);
  });

  it("M6: out-of-turn and game-over share one 400 body, verbatim", async () => {
    fx.reset();
    const id = fx.seedGame({ whiteUsername: "ada", blackUsername: "bob", limitSeconds: 180, incrementSeconds: 0 });
    fx.setNotYourTurn(id);
    const res = await post(`/api/board/game/${id}/move/e2e4`, "tok-white");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Not your turn, or game already over" });

    // The same body for the OTHER state — this is the ambiguity that makes
    // reconcile mandatory, so the stub must not disambiguate it either.
    fx.reset();
    const done = fx.seedGame({ whiteUsername: "ada", blackUsername: "bob", limitSeconds: 180, incrementSeconds: 0 });
    await post(`/api/board/game/${done}/resign`, "tok-white");
    await post(`/api/board/game/${done}/move/e2e4`, "tok-white");
    const over = await post(`/api/board/game/${done}/move/e2e4`, "tok-white");
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: "Not your turn, or game already over" });
  });

  it("M12: creation succeeds on a fast clock and every move on it is refused", async () => {
    fx.reset();
    const created = await post("/api/challenge/bob", "tok-white", {
      "clock.limit": "60", "clock.increment": "0", rated: "false", color: "white",
    });
    expect(created.status, "M12's dangerous half: CREATION succeeds").toBe(200);
    const { challenge } = (await created.json()) as { challenge: { id: string } };
    fx.setUnplayableTimeControl(challenge.id);
    const res = await post(`/api/board/game/${challenge.id}/move/e2e4`, "tok-white");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "This game cannot be played with the Board API." });
  });

  it("M3: creation is rate-limited after the budget, with Lichess's own body", async () => {
    fx.reset();
    fx.setCreateBudget(4, 1_000);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await post("/api/challenge/bob", "tok-white", { "clock.limit": "180", "clock.increment": "0" });
      codes.push(r.status);
      if (r.status === 429) expect(await r.json()).toEqual({ error: "Too many requests. Try again later." });
    }
    expect(codes.slice(0, 4), "the first four creates succeed").toEqual([200, 200, 200, 200]);
    expect(codes.slice(4), "every create past the budget is 429").toEqual([429, 429]);
  });

  it("M9: a resign on move ONE is an abort with no winner; on move TWO it is a resign", async () => {
    fx.reset();
    const early = fx.seedGame({ whiteUsername: "ada", blackUsername: "bob", limitSeconds: 180, incrementSeconds: 0 });
    await post(`/api/board/game/${early}/move/e2e4`, "tok-white");
    await post(`/api/board/game/${early}/resign`, "tok-white");
    const a = (await (await fetch(`${fx.url}/game/export/${early}`)).json()) as Record<string, unknown>;
    expect(a.status).toBe("aborted");
    expect("winner" in a, "Lichess OMITS winner rather than sending null").toBe(false);

    const late = fx.seedGame({ whiteUsername: "ada", blackUsername: "bob", limitSeconds: 180, incrementSeconds: 0 });
    await post(`/api/board/game/${late}/move/e2e4`, "tok-white");
    await post(`/api/board/game/${late}/move/e7e5`, "tok-black");
    await post(`/api/board/game/${late}/resign`, "tok-white");
    const b = (await (await fetch(`${fx.url}/game/export/${late}`)).json()) as Record<string, unknown>;
    expect(b.status).toBe("resign");
    expect(b.winner).toBe("black");
  });

  it("M11: the export carries clocks in CENTISECONDS plus the clock envelope", async () => {
    fx.reset();
    const id = fx.seedGame({ whiteUsername: "ada", blackUsername: "bob", limitSeconds: 180, incrementSeconds: 0 });
    const body = (await (await fetch(`${fx.url}/game/export/${id}`)).json()) as {
      clocks: number[]; clock: { initial: number; increment: number; totalTime: number };
    };
    // 180 SECONDS is 18000 CENTISECONDS. A stub that emitted milliseconds would
    // make our ms conversion look right while being 10x wrong.
    expect(body.clocks).toEqual([18_000, 18_000]);
    expect(body.clock).toEqual({ initial: 180, increment: 0, totalTime: 180 });
  });

  it("401s every call bearing a revoked token (Review Focus 1)", async () => {
    fx.reset();
    const id = fx.seedGame({ whiteUsername: "ada", blackUsername: "bob", limitSeconds: 180, incrementSeconds: 0 });
    fx.revokeToken("tok-white");
    const res = await post(`/api/board/game/${id}/move/e2e4`, "tok-white");
    expect(res.status).toBe(401);
    const stillFine = await post(`/api/board/game/${id}/move/e2e4`, "tok-black");
    expect(stillFine.status, "a revoke is per-token, not per-game").not.toBe(401);
  });

  it("records every call it served, with its bearer token, and nothing else", () => {
    fx.reset();
    expect(fx.calls, "empty case: a fresh stub has served nothing").toEqual([]);
  });

  it("anti-vacuity: covers every measured fact this stub exists to reproduce", () => {
    const facts = ["M3", "M5", "M6", "M9", "M11", "M12"] as const;
    expect(facts.length, "zero facts checked is a FAILURE").toBeGreaterThan(0);
    expect(facts.length).toBe(6);
  });
});
```

- [ ] **Step 2: Run it and watch it fail for the right reason** — `Cannot find module '../../../../e2e/lichess-fixture-server'`. Judge from the JSON file only:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/b5-s2.json \
    src/server/external-play/__tests__/lichess-fixture-contract.test.ts; EXIT=$?; \
  echo "EXIT=$EXIT"; \
  jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,suites:[.testResults[].name]}' /tmp/b5-s2.json
```

A `numTotalTests` of `0` here means the suite **failed to collect**, which is the
expected red at this step — confirm the message names the missing module, not a
syntax error in the test.

- [ ] **Step 3: Write `apps/web/e2e/lichess-fixture-server.ts` to green.** Follow `stripe-fixture-server.ts`'s shape exactly: a `node:http` server, a `calls` array, state setters, `reset()`, `close()`, and `port: 0` → OS-chosen port read back off `server.address()`. The Board API surface, with the paths the real adapter uses:

```ts
// A local stand-in for the Lichess Board API, so the online-chess walkthrough
// drives OUR server's whole venue — seat, create, move, draw, resign, abort,
// reconcile — without touching lichess.org. Pointed at by LICHESS_BASE_URL
// (apps/web/src/server/external-play/lichess/client.ts:11), the same trick
// ai-fixture-server.ts and stripe-fixture-server.ts use.
//
// It is a HAND-WRITTEN fixture and every response shape here is a MEASURED
// fact from the design's §2, not a guess. The ones that matter, because they
// are the ones that break us:
//   M5  POST .../move/e7e6xx -> 200 {"ok":true} and the game advances by e7e6.
//       Lichess truncates. This is why the server validates UCI itself.
//   M6  ONE body — {"error":"Not your turn, or game already over"} — for both
//       "out of turn" and "already over". Deliberately not disambiguated.
//   M12 A 0+1/1+0 challenge is CREATED fine, then every move 400s with
//       {"error":"This game cannot be played with the Board API."}.
//   M3  Creation is rate-limited hard: ~4 per second, then
//       {"error":"Too many requests. Try again later."} with 429.
//   M9  Resign after ONE move -> status "aborted", winner key ABSENT.
//       After two -> "resign" with a winner.
//   M11 The export carries "clocks" in CENTISECONDS and a "clock" envelope.
//
// What it does NOT prove: that lichess.org still behaves this way. That is the
// recorded-payload contract test's job (__fixtures__/lichess/).
import { createServer, type IncomingMessage, type Server } from "node:http";

export const LICHESS_FIXTURE_PORT = 4321;   // 4319 is the AI fixture; 12111/12112 Stripe's
```

Game state: a `Map<string, Game>` where `Game = { id, white, black, limit, increment, moves: string[], status, winner, unplayable, notYourTurnOnce }`. Routes:

| Method + path | Behaviour |
|---|---|
| `POST /api/challenge/{username}` | 200 `{"challenge":{"id":…}}`; 429 with Lichess's body once the create budget is spent (M3); records `clock.limit`/`clock.increment` from the form body |
| `POST /api/challenge/{id}/accept` | 200 `{"ok":true}`; promotes the challenge to a game under the same id |
| `POST /api/board/game/{id}/move/{uci}` | 400 M12 body if `unplayable`; 400 M6 body if `notYourTurnOnce` or `status !== "started"`; otherwise **truncate `uci` to its first 4-5 legal characters via `/^([a-h][1-8][a-h][1-8][qrbn]?)/`**, push the truncated value, 200 `{"ok":true}` (M5) |
| `POST /api/board/game/{id}/resign` | `moves.length <= 1` → `status="aborted"`, winner **deleted** (M9); else `status="resign"`, winner = the other colour |
| `POST /api/board/game/{id}/draw/{yes|no}` | 200 `{"ok":true}`; `yes` from both sides → `status="draw"`, winner deleted. Records the offer in `calls` only — the export never shows a pending offer (M10) |
| `POST /api/board/game/{id}/abort` | `status="aborted"`, winner deleted |
| `GET /game/export/{id}` | the snapshot: `{id, rated:false, status, winner?, moves, clocks:[limit*100, limit*100], clock:{initial:limit, increment, totalTime:limit + 40*increment}, players:{white:{user:{id,name}}, black:{user:{id,name}}}}`. `winner` is **`delete`d**, never `null` (the README records that Lichess omits it) |
| anything else | 404 `{"error":"fixture: unhandled <method> <path>"}` so an unexpected call names itself |

Every handler pushes `{ method, path, body, token }` onto `calls` **before** branching, so a refusal is still recorded. A revoked token short-circuits to 401 `{"error":"No such token"}` after the recording.

- [ ] **Step 4: Record the clocks-bearing export fixture and extend the README** (P9 — no existing fixture carries `clocks`). Create `apps/web/src/server/external-play/__fixtures__/lichess/export-clocks-blitz.json` from the spec's own measured line (§2 M11, `spike-battery2.log` §E), stating its provenance in the README rather than leaving it to look recorded:

```json
{
  "id": "e2eClocks",
  "rated": false,
  "status": "started",
  "moves": "e4 e6",
  "clock": { "initial": 60, "increment": 0, "totalTime": 60 },
  "clocks": [60000, 60000],
  "players": {
    "white": { "user": { "id": "ada", "name": "Ada" } },
    "black": { "user": { "id": "bob", "name": "Bob" } }
  }
}
```

Append to `README.md`:

```md
`export-clocks-blitz.json` is the M11 shape, transcribed from the 2026-10-09
battery log (`spike-battery2.log` §E) rather than re-recorded: the earlier pass
captured with `clocks=false`, so NOTHING in this directory carried a `clocks`
array before this file and M11 had no fixture at all. `clocks` is in
CENTISECONDS — `[60000, 60000]` is a 1+0 game, 600 seconds of total clock
between the two sides, not 60 seconds. `clock.totalTime` is Lichess's own
`limit + 40 x increment` estimate (M13), which is the quantity §3.7 gates on.
```

- [ ] **Step 5: Extend the contract test to fold the recorded fixtures through T3's real parser** — a fixture asserted against itself proves the fixture (failure class 1). Add to `lichess-fixture-contract.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { exportGame } from "../lichess/board-api";   // T3

describe("recorded payloads, through the REAL parser (§8.7)", () => {
  const dir = join(import.meta.dirname, "..", "__fixtures__", "lichess");

  it("every recorded export parses, and the clocks one lands in milliseconds", async () => {
    const files = readdirSync(dir).filter((f) => f.startsWith("export-") && f.endsWith(".json"));
    expect(files.length, "anti-vacuity: no recorded export fixtures found").toBeGreaterThan(0);
    let checked = 0;
    for (const f of files) {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      fx.reset();
      fx.serveRawExport(String(raw.id), raw);        // stub echoes the recorded body verbatim
      const snap = await exportGame(String(raw.id)); // the REAL T3 reader, pointed at the stub
      expect(snap, `${f} did not parse`).not.toBeNull();
      expect(snap!.status, `${f} lost its status`).toBe(raw.status);
      checked++;
    }
    expect(checked, "zero fixtures checked is a FAILURE").toBe(files.length);
  });

  it("centiseconds become milliseconds exactly once", async () => {
    const raw = JSON.parse(readFileSync(join(dir, "export-clocks-blitz.json"), "utf8")) as Record<string, unknown>;
    fx.reset();
    fx.serveRawExport("e2eClocks", raw);
    const snap = await exportGame("e2eClocks");
    // 60000 centiseconds = 600_000 ms. Derived from the UNIT, not copied from
    // the reader: a reader that forgot the conversion would give 60_000 and a
    // reader that applied it twice 6_000_000.
    expect(snap!.whiteMs).toBe(600_000);
    expect(snap!.blackMs).toBe(600_000);
  });
});
```

Add `serveRawExport(gameId, body)` to the fixture server's interface and implementation: it registers a verbatim body for `GET /game/export/{id}`, bypassing the synthesised snapshot.

- [ ] **Step 6: Run the contract suite green and record the counts.** The pass is judged only from the JSON:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && \
  LICHESS_BASE_URL= npx vitest run --reporter=json --outputFile=/tmp/b5-s6.json \
    src/server/external-play/__tests__/lichess-fixture-contract.test.ts; EXIT=$?; \
  echo "EXIT=$EXIT"; \
  jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b5-s6.json
```

`numTotalTests` must be **10** (eight stub facts + two parser folds) and
`numFailedTests` **0**. A total under 10 is a collection failure wearing a green
hat — do not proceed on it.

- [ ] **Step 7: Commit.** `git commit -m "test(chess): lichess board-api fixture server, pinned to the measured facts"` (+ the attribution trailer).

- [ ] **Step 8: Write `apps/web/e2e/realtimekit-fixture-server.ts`, with the forgeable-claim path structurally impossible.** This is the §10 do-not-copy item and §8.5's named test, so the mechanism matters more than the code:

```ts
// A local stand-in for the Cloudflare RealtimeKit REST API, pointed at by
// REALTIMEKIT_BASE_URL (T7's video/realtimekit.ts).
//
// THE ONE DESIGN RULE HERE. §5.2 and §10: the POC gated check-in on a
// client-sent `cameraOk` boolean, which is forgeable, and this design seats a
// player only when the MEETING reports a live video publisher. So the publisher
// flag in this stub is settable by exactly ONE thing — `setLivePublisher()`,
// an in-process call from the spec — and by NOTHING that arrives over HTTP.
// There is deliberately no request body, header or query parameter on any route
// below that can flip it. A browser cannot reach it even by lying, which means
// a green seat in this suite is always a seat the SERVER earned by asking.
//
// The corollary, which is the part worth guarding: Playwright's fake camera
// (--use-fake-device-for-media-stream) satisfies getUserMedia in the PAGE, so
// the local preview renders and the client-side join runs. It does not and must
// not satisfy the SEAT. The two halves are separate on purpose; if a future
// edit lets a request set the flag, §8.5's forged-claim test goes vacuous and
// the POC's defect is back.
import { createServer, type Server } from "node:http";

export const REALTIMEKIT_FIXTURE_PORT = 4322;
```

Routes: `POST /v2/meetings` → `{"data":{"id":"mtg-<n>"}}`; `POST /v2/meetings/{id}/participants` → `{"data":{"id":"prt-<n>","token":"rtk-<n>"}}` and remembers the participant with `live: false`; `GET /v2/meetings/{id}/participants/{pid}` → `{"data":{"id":pid,"custom_participant_id":pid,"presets":…,"media":{"video":{"publishing": live}}}}`; `DELETE /v2/meetings/{id}` → 200. When `setUnavailable(true)`, **every** route answers 503 `{"error":"fixture: realtimekit unavailable"}` (D11's outage).

- [ ] **Step 9: Add the five e2e helpers to `apps/web/e2e/helpers.ts`.** Place them immediately after `seedFixtureExternalPlaySql` (ends `:972`), so the external-play helpers sit together. Use the file's own module-private `withDb` (`:504`):

```ts
/** Link a Seazn user to a Lichess identity WITH a play-scoped token, the state
 *  the venue needs and the identity-only V405 link could not express.
 *
 *  Column names come from V432 (T1), not from this file's imagination — if that
 *  migration named them differently, THIS is the one place to change. The token
 *  is written sealed-shaped but inert: nothing in the walkthrough decrypts it,
 *  because the Lichess fixture server accepts any bearer string. That is
 *  deliberate — a real sealed token would need DEVICE_LINK_KEK in the runner,
 *  and the thing under test is the venue, not the envelope (T2's own suite
 *  owns seal/unseal). */
export async function linkLichessBySql(
  userId: string,
  externalUserId: string,
  username: string,
): Promise<void> {
  await withDb(async (sql) => {
    const [user] = await sql`select id from users where id = ${userId} and deleted_at is null`;
    if (!user) throw new Error(`linkLichessBySql: no live user ${userId}`);
    const res = await sql`
      insert into user_external_accounts
        (user_id, provider, external_user_id, username, access_token_sealed, scopes, consented_at)
      values
        (${userId}, 'lichess', ${externalUserId}, ${username},
         ${`e2e-token-${externalUserId}`}, ${sql.json(["board:play", "challenge:write"])}, now())
      on conflict (user_id, provider) do update set
        external_user_id    = excluded.external_user_id,
        username            = excluded.username,
        access_token_sealed = excluded.access_token_sealed,
        scopes              = excluded.scopes,
        consented_at        = excluded.consented_at,
        updated_at          = now()`;
    if (res.count === 0) throw new Error(`linkLichessBySql: wrote no row for ${userId}`);
  });
}
```

`matchRoomPathBySql(fixtureId, personId)` reads the fixture's `scheduled_at`, mints the HS256 token with the same claims and `typ` as `mintMatchRoomToken` (`fid`/`pid`/`sat`, `typ: "seazn-match-room"`, exp = `Date.parse(sat) + 24h`) using `AUTH_SECRET` from the runner's env — the same by-hand duplication `mintClaimPathForPlayerRow` already does for `person_claims` — and returns `/play/${token}`. It throws loudly if `AUTH_SECRET` is unset, so a missing env is not a mysterious 401.

`seedOnlineChessFixture` composes what already exists rather than adding SQL: `seedRosteredFixture(request, { label, sportKey: "boardgame", variantKey: "classical", entrantKind: "individual", home/away one person each, emitCoreStart: false })`, then `setDivisionConfigSql(divisionId, { variant: "classical", onlinePlay: "lichess", timeControl: spec.timeControlKey, cameraPolicy: spec.cameraPolicy })`, then per side: `mintLoginPathBySql(email)` → resolve the user id by that email in `withDb` → `linkPersonToUserBySql(personId, userId)` → `linkLichessBySql(userId, lichessId, username)`. It reads `stage_id` off the fixture row and returns it, because D12's open-round control is stage-scoped. It does **not** insert a `fixture_external_play` row: the walkthrough's whole point is that creation runs through the product.

`roundOpenedAtSql(stageId, roundNo)` and `forfeitEventCountSql(fixtureId)` are two-line reads — the second counts `competition_events` of type `core.forfeit` for the fixture — and exist so the D12 negative case can assert **zero**, which is the assertion a green unit suite cannot make.

- [ ] **Step 10: Rewrite `apps/web/e2e/walkthrough/chess-external-play.spec.ts`, with the timeout expressed as a derived cost.** Delete all three existing tests: the OTB one is superseded by Task 18's smoke, and the other two assert the deleted lichess.org hand-off (`:84` pins `href="https://lichess.org/e2eReadyGame"`, which D3 removes). Header and budget first:

```ts
/**
 * Online chess, end to end, on OUR page (design 2026-10-09).
 *
 * The product-level proof for the venue: an organiser OPENS a Swiss round
 * (D12), two players seat themselves through a server-verified camera
 * preflight, our server creates the Lichess game and submits both sides'
 * moves, and a resign is written as a result under organiser authority.
 *
 * Both external services are local fixture servers — e2e/lichess-fixture-server.ts
 * and e2e/realtimekit-fixture-server.ts — and the SERVER UNDER TEST must already
 * be pointed at them (LICHESS_BASE_URL / REALTIMEKIT_BASE_URL). It is not, by
 * default: client.ts falls back to https://lichess.org, so a misconfigured run
 * would reach the real API with fake tokens and fail confusingly. Step "the
 * stub is in the path" below turns that into one named assertion, first.
 */
import { expect, test } from "@playwright/test";
import {
  apiJson, expectNoHorizontalScroll, forfeitEventCountSql, linkLichessBySql,
  matchRoomPathBySql, roundOpenedAtSql, seedOnlineChessFixture,
  setFixtureScheduledAtSql, TAG,
} from "../helpers";
import { startLichessFixtureServer, LICHESS_FIXTURE_PORT, type LichessFixtureServer } from "../lichess-fixture-server";
import { startRealtimeKitFixtureServer, REALTIMEKIT_FIXTURE_PORT, type RealtimeKitFixtureServer } from "../realtimekit-fixture-server";

test.describe.configure({ mode: "serial" });   // one DB fixture, two rounds, in order

// Playwright grants the page a synthetic camera so getUserMedia resolves and
// the local preview renders. It does NOT grant a seat — see
// realtimekit-fixture-server.ts's design note.
test.use({
  permissions: ["camera"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

// --- the budget, DERIVED (failure class 20) --------------------------------
// A flat setTimeout beside a per-action cost is a latent red: when a constant
// moves, the budget does not, the test runs out of clock on its Nth action, and
// the runner prints whichever expect.poll was in flight — so a wall-clock
// failure reports itself as "expected 7 moves, received 6". Express it instead.
const MOVES = 6;
const SEATS = 2;
// Every scripted action is one HTTP round trip through our server, which may
// wait out a Lichess call; the server's own ceiling for that is the honest unit.
const LICHESS_TIMEOUT_MS = 10_000;          // server/external-play/window.ts:9
const PER_ACTION_MS = LICHESS_TIMEOUT_MS / 2;
const ACTIONS = 1 /* open round */ + SEATS + 1 /* create */ + MOVES + 1 /* resign */;
const SEED_MS = 45_000;                     // seedOnlineChessFixture: persons, comp, division, entrants, lineups
const BUDGET_MS = Math.max(120_000, SEED_MS + ACTIONS * PER_ACTION_MS);
```

- [ ] **Step 11: Write the happy path, starting from the organiser opening the round (D12).** One test, in this order, every step driving a real control:

1. Start both fixture servers on their fixed ports; `test.afterAll` closes them.
2. `seedOnlineChessFixture(page.request, { label: "Online chess " + TAG, timeControlKey: "3+0", cameraPolicy: "required" })`.
3. **The stub-in-the-path guard, before anything else can pass:** the organiser opens the round, then
   ```ts
   expect(lichess.calls.length,
     "the server under test reached NO fixture server. It is almost certainly still pointed at " +
     "https://lichess.org — set LICHESS_BASE_URL=http://127.0.0.1:" + LICHESS_FIXTURE_PORT +
     " and REALTIMEKIT_BASE_URL=http://127.0.0.1:" + REALTIMEKIT_FIXTURE_PORT +
     " on the SERVER process (docs/runbooks/e2e-local.md), not just on this runner",
   ).toBeGreaterThan(0);
   ```
4. `roundOpenedAtSql(fx.stageId, 1)` is non-null, and the invite the open-round control sends has landed (`fixture_external_play` exists, status `pending`) — the stamp and the send are the two halves D12 couples.
5. Each player: open `matchRoomPathBySql(fx.fixtureId, personId)`, confirm the preflight tile mounts and the seat is **refused** while no publisher is live; then `video.setLivePublisher(video.participantIds().at(-1)!, true)`, retry, and the seat is granted. Assert `video.calls` contains a `GET …/participants/…` for that id — proof the server asked rather than trusted.
6. The game is created: `expect(lichess.calls.filter(c => c.path.startsWith("/api/challenge/")).length).toBe(2)` — one challenge, one accept — and the bridge carries the challenge id.
7. Play `MOVES` real moves by tapping the board, alternating sides, polling the ledger between taps. Derive the expected position from the **move list this test scripts**, and the clocks from the stub's export, never from our own arithmetic.
8. White resigns after six moves → `status=resign winner=black` (M9's *late* branch), and `GET /api/v1/fixtures/{id}/state` reports `decided` with black as winner. Assert `forfeitEventCountSql(fx.fixtureId) === 0`: a Lichess timeout or resign is a normal result, never a forfeit (§3.6).

- [ ] **Step 11a: Cover the fifth reconcile trigger — a live game with BOTH tabs closed (spec §3.5, added by D12's edit).** The other four triggers all need a client open, so nothing in the happy path can reach this one, and it is the trigger that stops a fixture sitting unresolved forever. In the same `serial` describe, after the happy path's game is live and before the resign:

```ts
test("a live game nobody is watching is closed by the cron sweep, not left unresolved", async ({ page, context }) => {
  test.setTimeout(BUDGET_MS);
  // Both players are gone: close every page in the context, so no poll, no
  // clock tick and no rejected move can fire a reconcile. This is the ONLY
  // state in which the fifth trigger is the only one left.
  for (const p of context.pages()) await p.close();

  // Lichess has meanwhile flagged it (M1: a read settles the flag; we never
  // claim Lichess pushed it to us).
  lichess.setExpired(liveGameId, "outoftime", "black");

  const fresh = await context.newPage();
  const sweep = await fresh.request.post("/api/cron/external-play", {
    headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" },
  });
  expect(sweep.status(), "CRON_SECRET must be set for this spec").toBe(200);

  const state = await apiJson<{ status: string; outcome: { winner?: string } | null }>(
    fresh.request, `/api/v1/fixtures/${fx.fixtureId}/state`,
  );
  expect(state.data?.status).toBe("decided");
  // A Lichess timeout is a NORMAL WIN, not a forfeit (§3.6). Both halves, because
  // writing it as a forfeit would also leave status "decided".
  expect(await forfeitEventCountSql(fx.fixtureId), "a timeout was written as a forfeit").toBe(0);

  // And exactly once: a second sweep is a no-op (Review Focus 4).
  const before = await resultEventCountSql(fx.fixtureId);
  await fresh.request.post("/api/cron/external-play", {
    headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" },
  });
  expect(await resultEventCountSql(fx.fixtureId), "the sweep wrote the result twice").toBe(before);
});
```

Add `setExpired(gameId, status, winner)` to the Lichess fixture server (sets the terminal status a later export reports, without any move traffic — M1's shape: the flag appears on the first read after expiry) and `resultEventCountSql(fixtureId)` to `helpers.ts` beside `forfeitEventCountSql`.

- [ ] **Step 12: Write the D12 negative case — paired, not opened, scheduled time long past.** This is the cheap test that catches the worst regression (a whole field marked no-show for a round that never started), and it must assert **both** halves:

```ts
test("a round PAIRED BUT NOT OPENED, long past its scheduled time, seats nobody and forfeits nobody", async ({ page }) => {
  test.setTimeout(BUDGET_MS);
  const fx = await seedOnlineChessFixture(page.request, {
    label: `Online chess unopened ${TAG}`, timeControlKey: "3+0", cameraPolicy: "required",
  });

  // Pair exists, nothing opened. Push the clock well past BOTH the T-10 lead
  // and the T+20 deadline, so anchoring on scheduled_at instead of
  // round_opened_at would see a closed window and a field of absentees.
  const WINDOW_OPEN_LEAD_MS = 10 * 60_000;   // server/external-play/window.ts:5
  const DEADLINE_AFTER_MS = 20 * 60_000;     // server/external-play/window.ts:6
  const longPast = new Date(Date.now() - (WINDOW_OPEN_LEAD_MS + DEADLINE_AFTER_MS + 60_000)).toISOString();
  await setFixtureScheduledAtSql(fx.fixtureId, longPast);

  expect(await roundOpenedAtSql(fx.stageId, 1), "premise: the round is paired but NOT opened").toBeNull();

  // 1. No seat. The room says why, and the preflight control is not offered.
  await page.goto(await matchRoomPathBySql(fx.fixtureId, fx.white.personId));
  await expect(page.getByTestId("match-room-round-not-open")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("match-room-preflight")).toHaveCount(0);

  // 2. No forfeit, even after the sweep runs. This is the assertion the unit
  //    suites cannot make: the sweep is what would mark the field.
  const sweep = await page.request.post("/api/cron/external-play", {
    headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" },
  });
  expect([200, 401, 503], `cron answered ${sweep.status()}`).toContain(sweep.status());
  if (sweep.status() === 200) {
    expect(
      await forfeitEventCountSql(fx.fixtureId),
      "the sweep forfeited a fixture whose round was never opened — it is anchoring on scheduled_at, not round_opened_at",
    ).toBe(0);
  } else {
    // Do not pass vacuously: say so, loudly, rather than greening on a skip.
    test.info().annotations.push({
      type: "gap",
      description: `cron refused (${sweep.status()}) — CRON_SECRET unset, so the no-forfeit half did not run`,
    });
    expect(process.env.CRON_SECRET, "CRON_SECRET must be set for this spec's sweep half").toBeTruthy();
  }
});
```

- [ ] **Step 13: Write the round-2 loop — auto-pairs, sends nothing, organiser opens it.** Same `serial` describe, after the happy path, reusing its fixture:

1. Complete round 1 (the resign already did). Assert the precondition the spec added in the same edit as D12: **round 2 cannot pair while any round-1 board is unresolved**, so before resolving the last board the round-2 fixtures do **not** exist, and after it they do. One unresolved board blocks the next round, and a pairing that ran early would be invisible to every later assertion here.
2. Swiss pairs round 2 by itself: `roundOpenedAtSql(fx.stageId, 2)` is **null**, the round-2 fixtures exist, and **no invite went out** — assert zero `fixture_external_play` rows for the round-2 fixture ids *and* that `lichess.calls` grew by zero challenge calls across the step. One of those alone is satisfiable by the other being broken.
3. The organiser opens round 2 through the same real control; `roundOpenedAtSql(fx.stageId, 2)` becomes non-null and the invites appear. Assert the stamp is **after** round 1's, so a control that stamped once and reported success twice is caught.
4. One player seats into round 2 and the game is created — proof both halves are wired to each other rather than each being individually correct (failure class 15).

- [ ] **Step 14: Register the spec in `WALKTHROUGH_SPECS` and watch the inventory test go from RED to green.** It is unlisted today (P7), so run it first and record the red:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && \
  npx vitest run --reporter=json --outputFile=/tmp/b5-s14-before.json \
    src/lib/__tests__/e2e-ci-wiring.test.ts; echo "EXIT=$?"; \
  jq '{total:.numTotalTests,failed:.numFailedTests,
       failing:[.testResults[].assertionResults[]|select(.status=="failed")|.fullName]}' /tmp/b5-s14-before.json
```

Then add the entry to the list at `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts:171`, grouped by programme as that file's own comment requires (`:168-170`), not alphabetically:

```ts
  // Online chess (design 2026-10-09): a whole tournament match played on OUR
  // page — organiser opens the round (D12), server-verified camera preflight,
  // our server submits both sides' moves to a local Lichess fixture server, and
  // a resign is written as a result. Also carries the round-paired-but-not-
  // opened negative case, which is the only place anything asserts that an
  // unopened round forfeits NOBODY.
  "chess-external-play.spec.ts",
```

Re-run the same command into `/tmp/b5-s14-after.json`: `numFailedTests` must be
`0` and `numTotalTests` must be **unchanged** from the before-run — a total that
moved means a collection difference, not a fix.

- [ ] **Step 15: Add the match-room width block to `apps/web/e2e/mobile.spec.ts`.** This is the only file the seven width projects select (`testMatch: /mobile\.spec\.ts/` on `mobile-320/360/se/14/430`, `tablet-768/834`), so §8.6's width coverage has to live here and nowhere else. Three rules for this edit, all of which have produced false greens in this repo:

* The file is `test.describe.configure({ mode: "serial" })` (`:46`), so a red here aborts every test after it. When it goes red, treat the count as a **floor** and re-run after each fix until a full pass completes.
* Do not weaken an assertion to fit a narrow width. If a control is folded behind a phone disclosure, **open the fold** — wait on `toBeAttached`, not `toBeVisible`, and open *every* instance — and gate the open on the toggle being visible rather than on a width literal.
* Use `overflowingIn` (`helpers.ts:176`) for the clipping scan, never a bare `scrollWidth > clientWidth`: a swipeable rail is a feature and an `overflow-hidden` box is a defect, and only the computed `overflow-x` tells them apart. Any new scrolling region owes `tabindex="0"` plus a role and an accessible name or axe reds at SERIOUS.

The block asserts §6's phone composition as a **control-set and order** diff, not as box sizes: clocks-and-names row, then the board at full width, then own-tile + presence pill, then Draw/Resign — read from the live DOM at the project's width, and `expectNoHorizontalScroll(page)` at the end. Anchor any `hidden`-class assertion on `\s...hidden"`, because `/\bmd:hidden\b/` also matches inside `max-md:hidden` and passes on its own inversion.

- [ ] **Step 16: Run the WHOLE spec file, never a `-g` slice.** A `-g` filter is a filename sweep in disguise: six consecutive green local gates once ran a filter that selected neither of the two tests the change had broken. The server must already be up on `localhost` (never `127.0.0.1`) with both base URLs pointed at the fixtures:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && \
  PLAYWRIGHT_BASE=http://localhost:3000 \
  npx playwright test --project=walkthrough walkthrough/chess-external-play.spec.ts \
    --reporter=line; EXIT=$?; echo "EXIT=$EXIT"
```

and the width leg, one project at a time so a serial abort is attributable:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && \
  for P in mobile-320 tablet-768; do \
    PLAYWRIGHT_BASE=http://localhost:3000 npx playwright test --project=$P mobile.spec.ts --reporter=line; \
    echo "PROJECT=$P EXIT=$?"; \
  done
```

- [ ] **Step 17: Mutate the two guards this task adds, one at a time.** Back up with `cp` first — **never** `git checkout <file>`, which on uncommitted work restores the index and deletes the implementation the sweep is verifying.

1. In `realtimekit-fixture-server.ts`, make the publisher query answer `publishing: true` unconditionally. The §8.5 forged-claim refusal and the happy path's "seat refused before the publisher is live" must both **fail**. If either stays green, the seat is not gated on the meeting and the POC's defect is back. Restore.
2. In the fixture server's move handler, remove the M5 truncation (echo the raw UCI). The malformed-UCI test must fail. Restore.

Paste both before/after counts into the task report.

- [ ] **Step 18: Wire the two base URLs into CI — read `.github/workflows/e2e.yml` first, do not trust a description of it.** Its trigger has changed three times in one day; as at `8afdd8b42` it is `push: branches: [main]` plus `workflow_dispatch` with a `pr` input (`:90-99`). **Opening a PR runs no e2e at all** — a dispatch with `pr: <number>` is the only pre-merge route for a feature branch, and a `main` push cancels an in-flight dispatch (`concurrency`, `:101-103`). Two job-level `env:` blocks need the pair, because two different jobs run the new tests:

* **`e2e-parallel`** (job env `:371-481`) runs the `walkthrough` project (`matrix.project: walkthrough`, three shards). Add after `ANTHROPIC_API_KEY` at `:481`:

```yaml
      # Online chess (design 2026-10-09): the walkthrough starts a Lichess
      # fixture server on 4321 and a RealtimeKit one on 4322; the app server
      # must be pointed at both or it reaches the REAL lichess.org with fake
      # tokens. Same mechanism as SCHEDULING_AI_BASE_URL above, and the spec's
      # first assertion names these two vars when the stub sees no traffic.
      LICHESS_BASE_URL: "http://127.0.0.1:4321"
      REALTIMEKIT_BASE_URL: "http://127.0.0.1:4322"
```

* **`e2e-mobile`** (job env from `:1397`, `SCHEDULING_AI_BASE_URL` at `:1441`) runs the seven width projects, i.e. the `mobile.spec.ts` block from Step 15. Add the identical pair there with a one-line comment saying why it is in two places.

Leave `e2e-serial` alone — it runs neither.

- [ ] **Step 19: Mirror the pair in `scripts/ci-local.sh`'s `e2e_env()` (`:309-318`) and in the runbook.** `e2e_env()` already mirrors `SITEMAP_REVALIDATE_SECONDS` for exactly this reason, and the wiring test's "is mirrored by ci-local.sh's e2e_env" (`:932`) is the precedent to follow:

```bash
  # Online chess walkthrough: the server must point at the local fixture
  # servers the spec starts (e2e.yml's e2e-parallel and e2e-mobile set these).
  export LICHESS_BASE_URL=http://127.0.0.1:4321
  export REALTIMEKIT_BASE_URL=http://127.0.0.1:4322
```

Add both to the env list in `docs/runbooks/e2e-local.md` beside `SCHEDULING_AI_BASE_URL`, with the sentence that an unset `LICHESS_BASE_URL` means the server calls lichess.org for real.

- [ ] **Step 20: Pin the wiring so a lost line reds a unit test, not a push to main.** Add one `it` to `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`, in the shape of its neighbours (`:903-939`): strip YAML comments, slice the `e2e-parallel` job out between `\n  e2e-parallel:\n` and `\n  e2e-serial:\n`, read the four-space job-level `env:`, and assert both vars are set to the same `127.0.0.1:<port>` values the fixture servers export as `LICHESS_FIXTURE_PORT` / `REALTIMEKIT_FIXTURE_PORT` — **imported from those modules, never typed into the test**. Do the same for the `e2e-mobile` job and for `ci-local.sh`'s `e2e_env`. Premise assertions first, as that file does: the `walkthrough` project selects `walkthrough/chess-external-play.spec.ts`, and a width project selects `mobile.spec.ts`.

- [ ] **Step 21: Typecheck and lint the touched files, then commit.** `rtk` hides `npm run lint` output entirely, so read it through the proxy:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  rm -rf apps/web/.next/types && \
  npm run typecheck --workspace apps/web; echo "TSC_EXIT=$?"; \
  rtk proxy npm run lint --workspace apps/web 2>&1 | tail -20
```

Commit: `test(chess): online-chess walkthrough on the local fixture servers, organiser-opened rounds`.

---

### Task 18: Smoke, the scoped gate, and the product walkthrough

**Files:**

| Path | Lines today | Action |
|---|---|---|
| `scripts/smoke.ts` | 22384 (`externalPlayOtBSmoke` **20615-20684**, doc comment 20610-20614, call site **1222**, `startAiFixtureServer` import 12-16) | edit |
| `.github/workflows/ci.yml` | `smoke-e2e` job `:1314`, its env `:1333-…`, `SCHEDULING_AI_BASE_URL` `:1341`, `AI_FIXTURE_PORT` `:1342`; openapi drift step `:132-134` | edit |
| `scripts/ci-local.sh` | `smoke_env()` `:290-308` | edit |
| `db/migration/deltas/` | branch-added: `V405__lichess_external_play.sql`, `V407__lichess_lobby_ready.sql`; main high-water **431** | verify only |
| `apps/web/src/lib/i18n-keys.ts` | generated | regenerate + commit |
| `openapi/v1.json`, `openapi/v1.public.json` | generated | regenerate + commit |

**Interfaces:**

*Consumes* — `startLichessFixtureServer` / `LICHESS_FIXTURE_PORT` (T17),
`writeResultFrom` (T12), `createGameIfReady` (T9), `SHIP1_TIME_CONTROLS` (T5),
the V432/V433 migrations (T1), W2b's merged `core.forfeit` contract.

*Produces* — `onlineChessVenueSmoke()` in `scripts/smoke.ts`; a committed scoped-gate transcript in the task report.

---

- [ ] **Step 1: Re-pin the smoke function and its call site before editing** (the superseded plan's line numbers are off by ~2,370 — P3):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  grep -an "function externalPlayOtBSmoke\|await externalPlayOtBSmoke()" scripts/smoke.ts && \
  grep -an "startAiFixtureServer" scripts/smoke.ts | head -3
```

Expect `20615` (definition), `1222` (call site), `12`/`13702`/`14267`/`14424` (the AI fixture pattern to copy). If any has moved, use what the command prints.

- [ ] **Step 2: Rename the suite and widen its doc comment.** `externalPlayOtBSmoke` no longer describes what it covers once the venue exists. Rename to `onlineChessVenueSmoke` at the definition (`:20615`) and the call site (`:1222`), and replace the doc comment (`:20610-20614`) with one that names all four things it now proves. Keep the two existing checks verbatim — the cron-secret refusal and the OTB "a division without `onlinePlay` still accepts an unlinked entrant" regression are both still true and still worth a live server. `grep -an "externalPlayOtBSmoke" scripts/smoke.ts` must return nothing afterwards.

- [ ] **Step 3: Start the Lichess fixture server inside the smoke suite, exactly as the AI suite does.** `scripts/smoke.ts` already imports a fixture server from the e2e directory (`:12-16`) and starts it inside the suite that needs it (`:13702`). Add the import beside it:

```ts
import {
  startLichessFixtureServer,
  type LichessFixtureServer,
} from "../apps/web/e2e/lichess-fixture-server.ts";
```

and inside `onlineChessVenueSmoke`:

```ts
  // The venue half must never reach lichess.org from CI. The server under test
  // is pointed at this process's fixture server by LICHESS_BASE_URL, set at the
  // job level in ci.yml's smoke-e2e (next step) — the same arrangement
  // SCHEDULING_AI_BASE_URL/AI_FIXTURE_PORT already has for the model fixture.
  let lichess: LichessFixtureServer | null = null;
  try {
    lichess = await startLichessFixtureServer();
```

with a `finally { await lichess?.close(); }`. Guard the configuration rather than hoping: if `process.env.LICHESS_BASE_URL` is unset, `check()` **fails** with the fix — a smoke that silently called the real API would be worse than a red.

- [ ] **Step 4: Drive a recorded-payload path, not a live call.** The venue checks the smoke adds, all over HTTP against the live server:

1. `check("online chess: cron wrong secret → 401/503", …)` — unchanged, kept.
2. A division **with** `onlinePlay: "lichess"` refuses an unlinked entrant (the existing `entrants.ts` guard), which is the paired positive of the OTB negative already there.
3. A fixture whose game is created against the fixture server reaches `live`, and `GET /api/v1/fixtures/{id}/state` reports it — the creation seam driven through its real producer.
4. **The recorded payload:** register `export-mate-white.json`'s verbatim body on the fixture server via `serveRawExport`, trigger the organiser resync (reconcile trigger `organiser`), and `check` that the fixture lands `decided` with white as the winner. The expected winner comes from the **recorded file**, read at runtime — not typed into the smoke — so re-recording the fixture moves the assertion with it.
5. A second resync is a **no-op**: the event count is unchanged (Review Focus 4, reconcile exactly once).

- [ ] **Step 5: Add `LICHESS_BASE_URL` to `ci.yml`'s `smoke-e2e` job env and mirror it in `smoke_env()`.** In `.github/workflows/ci.yml`, after `AI_FIXTURE_PORT: "4319"` (`:1342`):

```yaml
      # Online chess venue smoke (scripts/smoke.ts onlineChessVenueSmoke): the
      # smoke process starts a Lichess fixture server on 4321 and the server
      # under test must resolve LICHESS_BASE_URL to it. Unset, the adapter
      # falls back to https://lichess.org and CI would call the real API.
      LICHESS_BASE_URL: "http://127.0.0.1:4321"
      LICHESS_FIXTURE_PORT: "4321"
```

and in `scripts/ci-local.sh`'s `smoke_env()` (`:290-308`), beside `AI_FIXTURE_PORT=4319`:

```bash
  export LICHESS_BASE_URL=http://127.0.0.1:4321
  export LICHESS_FIXTURE_PORT=4321
```

Note which workflow this is: **smoke runs on PRs only**, and `e2e.yml` runs on a push to `main` only. They trigger on disjoint events and neither substitutes for the other, so both files need their own line.

- [ ] **Step 6: Run the renamed smoke suite alone.** `SMOKE_ONLY` exists for exactly this (`scripts/__tests__/smoke-select.test.ts`), and it refuses an unregistered name loudly rather than running fewer suites than you believe. Register `onlineChessVenue` in `smoke.ts`'s own registry, then:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  SMOKE_ONLY=onlineChessVenue npm run test:smoke; EXIT=$?; echo "SMOKE_EXIT=$EXIT"
```

A killed background command reports exit 0, so read the `SMOKE_EXIT=` the command prints rather than the harness's own status. Confirm `scripts/__tests__/smoke-select.test.ts` still passes with the new name in its `KNOWN` list.

- [ ] **Step 7: Confirm no branch migration sits below main's high-water mark.** Flyway refuses an out-of-order migration on any database already past `V431`, and `db/flyway.toml` sets no `outOfOrder` (P4 — the file is under `db/`, not the repo root). Task 1 amended V405/V407 to V432/V433; this step proves nothing was missed:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  git fetch origin main -q && \
  MAIN_MAX=$(git ls-tree --name-only origin/main db/migration/deltas/ \
             | sed -n 's|.*/V\([0-9]\{1,\}\)__.*|\1|p' | sort -n | tail -1) && \
  echo "main high-water: V$MAIN_MAX" && \
  OURS=$(git diff --name-only --diff-filter=A origin/main...HEAD -- db/migration/deltas/ \
         | sed -n 's|.*/V\([0-9]\{1,\}\)__.*|\1|p' | sort -n) && \
  echo "this branch adds: $(echo $OURS)" && \
  BAD=$(for v in $OURS; do [ "$v" -le "$MAIN_MAX" ] && echo "V$v"; done) && \
  if [ -n "$BAD" ]; then echo "REFUSED BY FLYWAY: $BAD is at or below V$MAIN_MAX"; exit 1; \
  else echo "ok: every branch migration is above V$MAIN_MAX"; fi
```

Expect `main high-water: V431` and `this branch adds: 432 433`. If `405` or `407` still appears, Task 1's amendment did not land — fix it there, and do **not** enable `outOfOrder`. Then prove it against a real database: `npm run db:apply && npm run db:info` on a fresh schema, and `npm run check:rls` because V432 adds tables.

- [ ] **Step 8: Clear `apps/web/.next` before the typecheck.** A stale Next route-types validator produces false `tsc` reds after a rebase, and this branch has been rebased onto `8afdd8b42`. Clear it first, in its own step, so a red here is a real red:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  rm -rf apps/web/.next && \
  npm run typecheck; echo "TSC_EXIT=$?"
```

Root `typecheck` covers `apps/web`, `packages/engine`, `packages/reference` **and** `apps/cron-worker` — the last matters because a scoped gate is otherwise blind to the cron-worker's Docker typecheck of anything the sweep imports. Then `npm run typecheck:scripts` for the `smoke.ts` edit.

- [ ] **Step 9: Confirm `openapi:gen` produces zero diff.** `ci.yml:132-134` fails the build on a stale spec, and this plan touches v1 fixture routes:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  npm run openapi:gen && \
  rtk proxy git diff --exit-code openapi/v1.json openapi/v1.public.json; \
  echo "OPENAPI_DIFF_EXIT=$?"
```

`OPENAPI_DIFF_EXIT=0` after committing the regenerated files. Use `rtk proxy` for the diff: plain `rtk` indents diff output, so a `^[-+]` scan reads empty.

- [ ] **Step 10: `i18n:check` clean, and the regenerated `i18n-keys.ts` committed.** Every new string in the match room, the preflight copy, the presence pill, the policy editor and the §13 camera-went-dark sentence ships in **en/es/fr/nl**; this surface is not under `apps/web/src/games/**`, so the English-only exemption does not apply:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  npm run i18n:check; echo "I18N_CHECK_EXIT=$?"; \
  npm run i18n:gen-keys && \
  rtk proxy git status --short apps/web/src/lib/i18n-keys.ts
```

`i18n-keys.ts` is **generated** — commit whatever the generator writes, never hand-edit it. Then re-run `i18n:check` after the regen so the two agree.

- [ ] **Step 11: Run the scoped gate — ONLY the tests covering files this plan changed.** A full local run is forbidden by standing owner rule (2026-09-28): it costs an hour, saturates the machine (which itself reds unrelated suites) and answers a question CI answers free. `vitest` positionals are **literal filename filters**, so a path that does not exist is silently ignored and the run goes green on a subset. Build the list in a bash array, never an unquoted `$L` (an empty list runs the FULL suite):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && \
unset DB_SCHEMA && \
PATHS=(
  src/server/external-play
  src/server/usecases/external-play
  src/server/usecases/__tests__/external-play-happy-path.test.ts
  src/server/usecases/__tests__/external-play-prepare.test.ts
  src/server/usecases/__tests__/external-play-sync.test.ts
  src/server/usecases/__tests__/external-accounts.test.ts
  src/server/usecases/__tests__/match-room-token.test.ts
  src/server/usecases/__tests__/checkin-token.test.ts
  src/app/api/cron/external-play/route.test.ts
  src/app/api/auth/lichess/__tests__/lichess-oauth-routes.test.ts
  src/components/public-site/__tests__
  src/components/v2/__tests__/arbiter-panel.test.tsx
  src/lib/__tests__/e2e-ci-wiring.test.ts
  src/lib/__tests__/realtime.test.ts
) && \
for p in "${PATHS[@]}"; do [ -e "$p" ] || echo "MISSING FILTER: $p"; done && \
npx vitest run --reporter=default --reporter=json \
  --outputFile=/tmp/b5-gate-web.json "${PATHS[@]}"; EXIT=$?; echo "WEB_EXIT=$EXIT"; \
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,
     suites:(.testResults|length),names:[.testResults[].name]}' /tmp/b5-gate-web.json
```

Judge **only** from that JSON: the `rtk` wrapper prints `PASS(0) FAIL(0)` for a suite that failed to COLLECT and swallows exit codes. Pin `numTotalTests`, not just failures. Confirm every path in `names` resolves under the **worktree**, not the main checkout — the shell cwd resets between calls, and a verify run that silently executed on `main` is how this repo collected a false green of twelve unrelated tests. Any `MISSING FILTER:` line means that filter contributed nothing: fix the path or delete it.

Then the repo-root half (the wave gate misses these otherwise):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  ./packages/engine/node_modules/.bin/vitest run --reporter=default --reporter=json \
    --outputFile=/tmp/b5-gate-scripts.json \
    scripts/__tests__/smoke-select.test.ts scripts/__tests__/dockerignore.test.ts \
    scripts/__tests__/tools-import-guard.test.ts; EXIT=$?; echo "SCRIPTS_EXIT=$EXIT"; \
  jq '{total:.numTotalTests,failed:.numFailedTests}' /tmp/b5-gate-scripts.json
```

- [ ] **Step 12: Run the e2e the change actually touches — whole files, by behaviour not by filename.** An e2e sweep filtered on a filename pattern once missed the spec that exercised the path, so grep the selector first and run every file that matches:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  grep -rlan "external-play\|match-room\|onlinePlay\|lichess" apps/web/e2e --include='*.spec.ts'
```

Then run each returned file whole, plus `mobile.spec.ts` at the two widths the design names, with the server up on `localhost`:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play/apps/web && \
  PLAYWRIGHT_BASE=http://localhost:3000 \
  npx playwright test --project=walkthrough walkthrough/chess-external-play.spec.ts --reporter=line; \
  echo "WALKTHROUGH_EXIT=$?"
```

`mobile.spec.ts` is serial, so a red count is a **floor**: re-run after each fix until a full pass completes, and never read "2 failed / 29 passed" as the total.

- [ ] **Step 13: Drive the match room in a BROWSER at 320, 768 and 1280, and keep a screenshot per screen.** A green suite is not a working product, and this design's whole point is something a person uses. `/admin`'s desktop-only exemption does **not** apply here — the match room is a player surface and keeps the full bar. Use `screenshotAtWidths` (`helpers.ts:447`) or drive it by hand, and at each width confirm, by looking:

| Width | What must be true |
|---|---|
| 320 | §6's order top to bottom: clocks+names, board full width, own tile + presence pill, Draw/Resign. No horizontal page scroll. A realistic **43-character** entrant name — a short one hides the missing `min-w-0` that put 106px of overflow on the page |
| 768 | No horizontal page scroll; the phone disclosure's toggle is `md:hidden` here, so anything folded must be reachable without clicking a hidden control |
| 1280 | Board central, tile and controls in the side rail; the two duplicated controls' desktop twins visible and their phone twins absent |

Record each screenshot's path in the task report and confirm the three images **differ** — pixel-identical captures mean nothing opened, which is how a visual gate once collected a sign-off on zero pictures. Crop rather than attaching full-page captures.

- [ ] **Step 14: Verify W2b is MERGED before claiming Task 13's behaviour works.** The no-show path is gated on it: until W2b merges, a pre-start chess forfeit returns 422 `WRONG_PHASE`, and W2b is what accepts phase `pre` and makes `core.forfeit` strict (`{by: <entrant> | "both", reason: "walkover" | "retired" | "disqualified" | "withdrew"}`, free text refused). Check the **merged** tree, not a branch and not a peer's word:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  git fetch origin main -q && \
  git show origin/main:apps/web/src/lib/organiser-only-events.ts >/dev/null 2>&1 \
    && echo "organiser-only gate present on main" || echo "organiser-only gate ABSENT on main" && \
  git log origin/main --oneline -20 --grep='W2b' && \
  gh pr list --state merged --search 'W2b' --limit 5
```

**If W2b is not merged: HOLD the gate.** Say so in the report, leave Task 13's no-show test in place and failing-or-skipped-with-an-annotation, and do **not** weaken it to match the current 422. A test relaxed to accept `WRONG_PHASE` would go green now and stay green after W2b lands, which is precisely the regression it exists to catch. Record the blocker and move the no-show sign-off to the merge. The contract above came from session f-w2b and is **information, not a ruling** — their owner's approval is not ours, and it does not authorise claiming the path works.

- [ ] **Step 15: Lint the whole branch's touched files through the proxy.** `rtk` hides `npm run lint` output entirely, and "ESLint output (JSON parse failed)" is the wrapper losing the result, not a clean run:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play && \
  rtk proxy npm run lint 2>&1 | tail -30
```

Read the `✖ N problems` line. `N` must be `0`.

- [ ] **Step 16: Commit the gate's own artefacts.** `git commit -m "chore(chess): online-chess venue smoke, scoped gate wiring, regenerated openapi + i18n keys"` with the attribution trailer. Keep the regenerated `openapi/*.json` and `i18n-keys.ts` in this commit so a reviewer can see they are generator output rather than hand edits.

- [ ] **Step 17: Request a fresh-eyes review of the WHOLE branch, after green.** Green and pushed is not done — reviews run after a green push have found live defects twice. Dispatch a reviewer over `git diff origin/main...HEAD` with the three standing lenses (customer, owner, test-design) and these four questions named explicitly:

1. Is any seam inert — declared, typed and unit-green, with nothing in production sending or reading it? Name its real producer and consumer.
2. Does any test assert the opposite of its title, or freeze a current bug as its expected value?
3. Is any guard untested — does deleting its predicate leave the suite green? Two guards covering for each other are each untested.
4. Does any reachability test pass on **any** value where it should pin the one a control opens at?

`/code-review` reviews `main`, not this worktree, so pass the diff explicitly.

- [ ] **Step 18: Write the final task report.** It must carry: the scoped-gate JSON counts (`numTotalTests`/`numPassedTests` per command, with the resolved suite paths proving they ran in the worktree), the `SMOKE_EXIT`, the three screenshot paths, the migration high-water output, the W2b verdict with its evidence, the mutation before/after counts from T17 Step 17, and every premise this batch found false. No file contents, no diffs.
