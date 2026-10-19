# Chess Lichess external play — refactor implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR #788's Ready-lobby / direct-challenge build with the approved design: check-in in a private match room, a Lichess open challenge minted when both players are checked in (T−10 → T+20), automatic no-show reasons, and no stored player tokens.

**Architecture:** Seazn stays the competition system; Lichess is the board. One guard (`loadOnlinePlayFixture`) fronts every entry point. Check-in reuses `fixture_availability`. The Lichess HTTP call never runs inside a DB transaction; a short row claim keeps one challenge per fixture. A 5-minute cron sends emails, retries mints, polls games and escalates no-shows into the existing `result_missing` attention.

**Tech Stack:** Next 16.2.9 (App Router, `apps/web`), TypeScript 7, postgres.js (`sql` / `withTenant`), Flyway migrations (`db/migration/deltas`), `jose` JWTs, Supabase Realtime (private broadcast), Vitest (node env, JSON reporter), Playwright (`walkthrough` project), `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-15-chess-lichess-external-play-design.md` (approved 2026-09-16; decisions in its §0). Read it before any task. Code maps used to write this plan: the per-symbol PR map and the seam map (session scratch; facts re-pinned in each task below — re-verify line numbers before editing, they drift).

## Global Constraints

- Worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/chess-lichess-external-play`, branch `feat/chess-lichess-external-play`. Prefix every shell command with `cd <worktree> &&` in the same call.
- Never `git stash`. Never `git checkout -- <file>` during a task. Commit with `git commit -F <msgfile>` (no heredoc, one `-F`), ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Migrations V405–V407 are **unmerged** (`origin/main` tops out at V404): amend them in place; do not add V408+.
- Time constants (spec §8.1), defined once in `apps/web/src/server/external-play/window.ts`: `EMAIL_LEAD_MS = 15 * 60_000`, `WINDOW_OPEN_LEAD_MS = 10 * 60_000`, `DEADLINE_AFTER_MS = 20 * 60_000`, `MATCH_ROOM_TOKEN_TTL_MS = 24 * 60 * 60_000`, `MINT_CLAIM_STALE_MS = 30_000`, `LICHESS_TIMEOUT_MS = 10_000`, `ROOM_REREAD_MS = 15_000`.
- `needs_reason` vocabulary (exact): `no_show_white | no_show_black | no_show_both | not_started | aborted | mismatch | provider_error`.
- Bridge `status` vocabulary (exact): `pending | ready | live | finished | needs_organiser`. Every status UPDATE carries `and status = <expected prior>` (or `in (...)`).
- No Lichess HTTP call inside `sql.begin` / `withTenant`. Every Lichess call uses `AbortSignal.timeout(LICHESS_TIMEOUT_MS)`.
- A GET never writes (match room page, room API GET, public pages).
- Boardgame clock `base` / `increment` / `delay` are **seconds** (`components/v2/match-rules.tsx:541-552`, pinned by `match-rules.test.ts:55-68`). Lichess `clock.limit` / `clock.increment` are seconds.
- Every user-facing string in en/es/fr/nl (`apps/web/src/dictionaries/<l>/ui.json` or `emails.json`), then `npm run i18n:check` and `npm run i18n:gen-keys` (commit the regenerated `apps/web/src/lib/i18n-keys.ts`). Email interpolations HTML-escaped.
- UI verified by screenshot at 1280, 768 and 320 with no horizontal page scroll. Mobile-first. Show the owner ≥2 layout options before building any new UI surface.
- Every task owes all four test types (unit, E2E, smoke, regression) — a backend task's E2E/smoke obligation is discharged by Task 14/15 tracing forward to it; each task lists which.
- Vitest: `cd apps/web && npx vitest run <paths> --reporter=json --outputFile=/tmp/<name>.json`; judge from `numPassedTests`/`numFailedTests`/`numTotalTests` and confirm `.testResults[].name` paths are under this worktree. DB tests need a fresh test DB (`seazn-local-env` skill: `npm run db:apply` **and** `npm run sync:sports`).
- Lint via `rtk proxy npm run lint --workspace apps/web` and read `✖ N problems`. Typecheck via `rtk proxy npm run typecheck`, and check the exit code.
- Before touching `lib/division-phase.ts` or `components/v2/desk/*`, read `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_RULES.md` (ladders are order; state the empty case first; counted copy via `plural()`).
- Test bodies written `/* … */` in this plan are NOT optional: the test title states the exact assertion, and the nearest fully written test in the same task shows the seeding and expectation pattern. Implement that assertion literally; if it cannot be written as titled, stop and report it (the title is the contract, AGENTS.md class 4).
- Mutation rule (AGENTS.md class 3): every guard added in a task gets one mutant (delete the predicate / `return true`) that its test must kill; record the killer test name in the task's commit message body.

---

## File structure (end state)

| Path | Responsibility |
|---|---|
| `db/migration/deltas/V405__lichess_external_play.sql` | Rewritten: `user_external_accounts` (no tokens), `fixture_external_play` (§7.2) |
| `db/migration/deltas/V406__lichess_challenge_identity.sql` | **Deleted** (folded into V405) |
| `db/migration/deltas/V407__lichess_lobby_ready.sql` | Rewritten: realtime policy on claim `lobby_fixture_id` only |
| `apps/web/src/server/external-play/window.ts` | **New.** Time constants, window maths, check-in validity, deadline reason table (pure) |
| `apps/web/src/server/external-play/types.ts` | Rewritten types: open challenge, snapshot, `NeedsReason`, `ExternalPlayStatus` |
| `apps/web/src/server/external-play/lichess/adapter.ts` | `createOpenChallenge`, `fetchGame` (404 → null), timeout |
| `apps/web/src/server/external-play/__fixtures__/lichess/export-*.json` | **New.** Raw Lichess export JSON samples |
| `apps/web/src/server/external-play/pkce.ts` | **New.** PKCE verifier / S256 challenge |
| `apps/web/src/server/external-play/online-play.ts` | `assertOnlinePlayValue` gains the clock refusal |
| `apps/web/src/server/external-play/public-view.ts` | Public-safe status shape (no Play URLs) |
| `apps/web/src/server/usecases/signing-key.ts` | **New.** `authSecretKey()` shared by QR check-in and match-room tokens |
| `apps/web/src/server/usecases/checkin-token.ts` | Imports `authSecretKey` (behaviour unchanged) |
| `apps/web/src/server/usecases/match-room-token.ts` | **New.** Mint/verify personal match-room JWT |
| `apps/web/src/server/usecases/me.ts` | Extract exported `stampFixtureCheckIn` |
| `apps/web/src/server/usecases/external-accounts.ts` | Token functions/columns removed |
| `apps/web/src/server/usecases/external-play.ts` | **Deleted**, replaced by the directory below |
| `apps/web/src/server/usecases/external-play/index.ts` | Re-exports the public surface |
| `apps/web/src/server/usecases/external-play/guard.ts` | `loadOnlinePlayFixture`, sides, colour, stale-row detection/reset |
| `apps/web/src/server/usecases/external-play/room.ts` | Match-room identity, view, check-in, `mintIfReady` |
| `apps/web/src/server/usecases/external-play/sync.ts` | `applyGameSnapshot`, `pollExternalPlay`, `pokeFixture`, scoring appends |
| `apps/web/src/server/usecases/external-play/sweep.ts` | `sendDueEmails`, `retryMints`, `escalateAtDeadline`, `runExternalPlaySweep` |
| `apps/web/src/server/usecases/external-play/organiser.ts` | `resolveExternalPlay`, `resendExternalPlayNotice`, `readOrganiserExternalPlay` |
| `apps/web/src/server/usecases/external-play-read.ts` | Public read (status + watch id only) |
| `apps/web/src/lib/realtime.ts` | Lobby token claim `lobby_fixture_id`, exp at deadline |
| `apps/web/src/lib/oauth.ts` | PKCE cookie const, scopes, `lichessConfigured` without secret |
| `apps/web/src/app/api/auth/lichess/route.ts`, `callback/route.ts` | PKCE, `next`, revoke, no token storage |
| `apps/web/src/app/api/v1/fixtures/[id]/external-play/room/route.ts` | **New** (replaces `lobby/`): GET view, POST `{action:"check_in"\|"mint"}` |
| `apps/web/src/app/api/v1/fixtures/[id]/external-play/lobby/route.ts` | **Deleted** |
| `apps/web/src/app/api/cron/external-play/route.ts` | Calls `runExternalPlaySweep` |
| `apps/web/src/app/api/webhooks/lichess/route.ts` | Body `{ fixtureId }` → `pokeFixture` |
| `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/page.tsx` | **New** match room (force-dynamic) |
| `apps/web/src/components/public-site/match-room.tsx` | **New** client room (replaces `external-play-lobby.tsx`) |
| `apps/web/src/components/public-site/external-play-lobby.tsx` | **Deleted** |
| `apps/web/src/components/public-site/external-play-cta.tsx` | Read-only public status + room link |
| `apps/web/src/components/v2/external-play-panel.tsx` | **New** organiser fixture page panel |
| `apps/web/src/components/v2/external-play-needs-result-queue.tsx` | **Deleted** |
| `apps/web/src/lib/division-phase.ts` | `isResultMissing` input `externalPlayNeedsOrganiser` |
| `apps/web/src/components/v2/desk/run-sheet*.tsx`, `lib/run-sheet-groups.ts` | Pass flag; reason chip |
| `apps/web/src/components/v2/division-settings.tsx` | TDZ fix, explicit `off`, clock refusal copy |
| `apps/web/src/app/me/page.tsx` | Mount `LichessLinkCard` |
| `apps/web/src/components/public-site/register/register-stepper.tsx` | `<Link>` with `next` |
| `apps/web/e2e/lichess-stub.ts` | **New** local Lichess stub for e2e |
| `apps/web/e2e/walkthrough/chess-external-play.spec.ts` | Rewritten |
| `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` | Add spec to `WALKTHROUGH_SPECS` |
| `apps/web/src/server/api-v1/key-scopes.ts` | Classify room/resolve/resend routes |
| `scripts/smoke.ts` | External-play smoke extended |

---

### Task 1: Amend migrations V405–V407

**Files:**
- Modify (rewrite): `db/migration/deltas/V405__lichess_external_play.sql`
- Delete: `db/migration/deltas/V406__lichess_challenge_identity.sql`
- Modify (rewrite): `db/migration/deltas/V407__lichess_lobby_ready.sql`
- Test: `apps/web/src/server/usecases/__tests__/external-play-schema.test.ts` (create)

**Interfaces:**
- Produces: tables `user_external_accounts(id, user_id, provider, external_user_id, username, created_at, updated_at)` and `fixture_external_play` with exactly the §7.2 columns listed in Step 3; realtime policy `"external play lobby read by claim"` reading `lobby_fixture_id`.

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/web/src/server/usecases/__tests__/external-play-schema.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";

describe.skipIf(!process.env.DATABASE_URL)("external play schema (V405/V407)", () => {
  afterAll(async () => {
    await sql.end();
  });

  async function columns(table: string): Promise<string[]> {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_name = ${table} order by column_name`;
    return rows.map((r) => r.column_name);
  }

  it("user_external_accounts stores identity only — no token columns", async () => {
    expect(await columns("user_external_accounts")).toEqual(
      ["created_at", "external_user_id", "id", "provider", "updated_at", "user_id", "username"],
    );
  });

  it("fixture_external_play has exactly the spec §7.2 columns", async () => {
    expect(await columns("fixture_external_play")).toEqual([
      "black_emailed_at", "black_lichess_id", "challenge_id", "created_at", "expires_at",
      "finished_at", "fixture_id", "last_error", "last_polled_at", "mint_claimed_at",
      "needs_reason", "org_id", "provider", "scheduled_at_basis", "started_at", "status",
      "updated_at", "url_black", "url_white", "white_emailed_at", "white_lichess_id", "white_side",
    ]);
  });

  it("rejects a needs_reason outside the vocabulary", async () => {
    const [c] = await sql<{ check_clause: string }[]>`
      select cc.check_clause from information_schema.check_constraints cc
        join information_schema.constraint_column_usage u using (constraint_name)
       where u.table_name = 'fixture_external_play' and u.column_name = 'needs_reason'`;
    for (const r of ["no_show_white", "no_show_black", "no_show_both", "not_started", "aborted", "mismatch", "provider_error"]) {
      expect(c.check_clause).toContain(`'${r}'`);
    }
    expect(c.check_clause).not.toContain("no_show_grace_elapsed");
  });
});
```

- [ ] **Step 2: Run it against a fresh DB built from the current branch — expect FAIL** (token columns present, old column names).

Run: `cd <worktree>/apps/web && npx vitest run src/server/usecases/__tests__/external-play-schema.test.ts --reporter=json --outputFile=/tmp/t1.json`
Expected: 3 failed.

- [ ] **Step 3: Rewrite V405**

```sql
-- =============================================================================
-- V405 — Chess Lichess external play (spec 2026-09-15, revised 2026-09-16)
--
-- user_external_accounts: a Seazn user's Lichess identity. No OAuth token is
-- kept: linking reads /api/account and revokes the token (spec §5.1). Not
-- org-scoped; FORCE RLS with no app_user policy, read via privileged `sql`.
--
-- fixture_external_play: per-fixture bridge for online play (spec §7.2).
-- Check-in is NOT here — it is fixture_availability.checked_in_at.
-- =============================================================================

create table user_external_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  provider         text not null check (provider in ('lichess')),
  external_user_id text not null,
  username         text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, provider),
  unique (provider, external_user_id)
);

create index user_external_accounts_user_idx on user_external_accounts (user_id);

alter table user_external_accounts enable row level security;
alter table user_external_accounts force row level security;

create table fixture_external_play (
  fixture_id          uuid primary key references fixtures(id) on delete cascade,
  org_id              uuid not null references organizations(id) on delete cascade,
  provider            text not null default 'lichess' check (provider in ('lichess')),
  status              text not null default 'pending' check (status in (
                        'pending', 'ready', 'live', 'finished', 'needs_organiser'
                      )),
  scheduled_at_basis  timestamptz not null,
  challenge_id        text,
  url_white           text,
  url_black           text,
  white_side          text check (white_side in ('home', 'away')),
  white_lichess_id    text,
  black_lichess_id    text,
  expires_at          timestamptz,
  mint_claimed_at     timestamptz,
  white_emailed_at    timestamptz,
  black_emailed_at    timestamptz,
  last_polled_at      timestamptz,
  needs_reason        text check (needs_reason in (
                        'no_show_white', 'no_show_black', 'no_show_both',
                        'not_started', 'aborted', 'mismatch', 'provider_error'
                      )),
  last_error          text,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((status = 'needs_organiser') = (needs_reason is not null))
);

create index fixture_external_play_org_idx on fixture_external_play (org_id);
create index fixture_external_play_poll_idx
  on fixture_external_play (last_polled_at nulls first)
  where status in ('ready', 'live');
create unique index fixture_external_play_challenge_idx
  on fixture_external_play (challenge_id)
  where challenge_id is not null;

alter table fixture_external_play enable row level security;
alter table fixture_external_play force row level security;
create policy fixture_external_play_tenant on fixture_external_play
  for all to app_user
  using (org_id = current_org_id())
  with check (org_id = current_org_id());
grant select, insert, update, delete on fixture_external_play to app_user;
```

- [ ] **Step 4: Delete V406** — `git rm db/migration/deltas/V406__lichess_challenge_identity.sql`.

- [ ] **Step 5: Rewrite V407** — keep the existing `do $migrate$` skip structure verbatim (no realtime schema / no `realtime.messages` / policy exists / `insufficient_privilege`), remove the `alter table … white_ready_at, black_ready_at` statement, and change the policy body to:

```sql
      create policy "external play lobby read by claim"
      on realtime.messages
      for select
      to authenticated
      using (
        extension = 'broadcast'
        and realtime.topic() = ('external-play:' || (select auth.jwt() ->> 'lobby_fixture_id'))
      )
```

Header comment: `-- V407 — private match-room channel external-play:{fixtureId}. The token carries lobby_fixture_id, never fixture_id, so V403's paid fixture:{id} policy cannot match it (spec §7.3).`

- [ ] **Step 6: Rebuild the test DB from scratch** (`seazn-local-env` skill: drop/create, `npm run db:apply`, `npm run sync:sports`) and re-run Step 2's command. Expected: 3 passed.

- [ ] **Step 7: Commit** — `feat(chess): amend V405-V407 to the check-in / open-challenge schema`.

Test-type ledger: unit+regression = this schema test; E2E/smoke = Tasks 14/15 run on this schema.

---

### Task 2: Pure window, check-in validity and no-show reason module

**Files:**
- Create: `apps/web/src/server/external-play/window.ts`
- Modify: `apps/web/src/server/external-play/types.ts` (add `NeedsReason`, keep `ExternalPlayStatus`)
- Test: `apps/web/src/server/external-play/__tests__/window.test.ts`

**Interfaces:**
- Produces:
  - `EMAIL_LEAD_MS, WINDOW_OPEN_LEAD_MS, DEADLINE_AFTER_MS, MATCH_ROOM_TOKEN_TTL_MS, MINT_CLAIM_STALE_MS, LICHESS_TIMEOUT_MS, ROOM_REREAD_MS: number`
  - `type PlayWindow = { emailAt: Date; opensAt: Date; deadline: Date }`
  - `windowFor(scheduledAt: Date): PlayWindow`
  - `type RoomPhase = "before" | "open" | "closed"`; `roomPhase(now: Date, scheduledAt: Date): RoomPhase`
  - `checkInCounts(checkedInAt: Date | null, scheduledAt: Date): boolean`
  - `LICHESS_NOT_STARTED: ReadonlySet<string>` = `created`; `LICHESS_ABORTED: ReadonlySet<string>` = `aborted, noStart, unknownFinish`
  - `deadlineReason(input: { whiteCheckedIn: boolean; blackCheckedIn: boolean; lichessStatus: string | null }): NeedsReason | null`
  - `type NeedsReason` (in `types.ts`)

- [ ] **Step 1: Write the failing tests** (empty case first; boundaries on both edges; the §9 table row by row)

```ts
// apps/web/src/server/external-play/__tests__/window.test.ts
import { describe, expect, it } from "vitest";
import {
  DEADLINE_AFTER_MS, EMAIL_LEAD_MS, WINDOW_OPEN_LEAD_MS,
  checkInCounts, deadlineReason, roomPhase, windowFor,
} from "../window";

const T = new Date("2026-10-01T19:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);

describe("windowFor", () => {
  it("derives every edge from the constants, not literals", () => {
    const w = windowFor(T);
    expect(w.emailAt.getTime()).toBe(T.getTime() - EMAIL_LEAD_MS);
    expect(w.opensAt.getTime()).toBe(T.getTime() - WINDOW_OPEN_LEAD_MS);
    expect(w.deadline.getTime()).toBe(T.getTime() + DEADLINE_AFTER_MS);
  });
  it("pins the owner-approved values", () => {
    expect([EMAIL_LEAD_MS, WINDOW_OPEN_LEAD_MS, DEADLINE_AFTER_MS]).toEqual([900_000, 600_000, 1_200_000]);
  });
});

describe("roomPhase", () => {
  it("is before one ms ahead of T−10, open at T−10 exactly", () => {
    expect(roomPhase(at(-WINDOW_OPEN_LEAD_MS - 1), T)).toBe("before");
    expect(roomPhase(at(-WINDOW_OPEN_LEAD_MS), T)).toBe("open");
  });
  it("is open one ms before T+20, closed at T+20 exactly", () => {
    expect(roomPhase(at(DEADLINE_AFTER_MS - 1), T)).toBe("open");
    expect(roomPhase(at(DEADLINE_AFTER_MS), T)).toBe("closed");
  });
});

describe("checkInCounts", () => {
  it("null never counts", () => {
    expect(checkInCounts(null, T)).toBe(false);
  });
  it("a stamp before the window (e.g. before a reschedule) does not count", () => {
    expect(checkInCounts(at(-WINDOW_OPEN_LEAD_MS - 1), T)).toBe(false);
  });
  it("counts from T−10 inclusive to T+20 exclusive", () => {
    expect(checkInCounts(at(-WINDOW_OPEN_LEAD_MS), T)).toBe(true);
    expect(checkInCounts(at(DEADLINE_AFTER_MS - 1), T)).toBe(true);
    expect(checkInCounts(at(DEADLINE_AFTER_MS), T)).toBe(false);
  });
});

describe("deadlineReason (spec §9)", () => {
  it("neither checked in → no_show_both", () => {
    expect(deadlineReason({ whiteCheckedIn: false, blackCheckedIn: false, lichessStatus: null })).toBe("no_show_both");
  });
  it("white only → no_show_black", () => {
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: false, lichessStatus: null })).toBe("no_show_black");
  });
  it("black only → no_show_white", () => {
    expect(deadlineReason({ whiteCheckedIn: false, blackCheckedIn: true, lichessStatus: null })).toBe("no_show_white");
  });
  it("both, no game → not_started", () => {
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: null })).toBe("not_started");
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: "created" })).toBe("not_started");
  });
  it("both, aborted-family status → aborted", () => {
    for (const s of ["aborted", "noStart", "unknownFinish"]) {
      expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: s })).toBe("aborted");
    }
  });
  it("a started or finished game is never a deadline case", () => {
    for (const s of ["started", "mate", "resign", "outoftime", "draw"]) {
      expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: s })).toBeNull();
    }
  });
  it("a missing check-in outranks a Lichess status (order differential)", () => {
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: false, lichessStatus: "aborted" })).toBe("no_show_black");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module '../window'`).

Run: `cd <worktree>/apps/web && npx vitest run src/server/external-play/__tests__/window.test.ts --reporter=json --outputFile=/tmp/t2.json`

- [ ] **Step 3: Implement**

```ts
// apps/web/src/server/external-play/types.ts — add below ExternalPlayStatus
export type NeedsReason =
  | "no_show_white"
  | "no_show_black"
  | "no_show_both"
  | "not_started"
  | "aborted"
  | "mismatch"
  | "provider_error";
```

```ts
// apps/web/src/server/external-play/window.ts
import type { NeedsReason } from "./types";

/** Spec §8.1 — the only definition of these values. */
export const EMAIL_LEAD_MS = 15 * 60_000;
export const WINDOW_OPEN_LEAD_MS = 10 * 60_000;
export const DEADLINE_AFTER_MS = 20 * 60_000;
export const MATCH_ROOM_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const MINT_CLAIM_STALE_MS = 30_000;
export const LICHESS_TIMEOUT_MS = 10_000;
export const ROOM_REREAD_MS = 15_000;

export type PlayWindow = { emailAt: Date; opensAt: Date; deadline: Date };

export function windowFor(scheduledAt: Date): PlayWindow {
  const t = scheduledAt.getTime();
  return {
    emailAt: new Date(t - EMAIL_LEAD_MS),
    opensAt: new Date(t - WINDOW_OPEN_LEAD_MS),
    deadline: new Date(t + DEADLINE_AFTER_MS),
  };
}

export type RoomPhase = "before" | "open" | "closed";

export function roomPhase(now: Date, scheduledAt: Date): RoomPhase {
  const w = windowFor(scheduledAt);
  if (now.getTime() < w.opensAt.getTime()) return "before";
  if (now.getTime() < w.deadline.getTime()) return "open";
  return "closed";
}

/** A check-in counts only inside the fixture's CURRENT window (spec §7.2). */
export function checkInCounts(checkedInAt: Date | null, scheduledAt: Date): boolean {
  if (checkedInAt === null) return false;
  return roomPhase(checkedInAt, scheduledAt) === "open";
}

export const LICHESS_NOT_STARTED: ReadonlySet<string> = new Set(["created"]);
export const LICHESS_ABORTED: ReadonlySet<string> = new Set(["aborted", "noStart", "unknownFinish"]);

/** Spec §9. Check-ins decide first; only with both present does Lichess speak. */
export function deadlineReason(input: {
  whiteCheckedIn: boolean;
  blackCheckedIn: boolean;
  lichessStatus: string | null;
}): NeedsReason | null {
  if (!input.whiteCheckedIn && !input.blackCheckedIn) return "no_show_both";
  if (!input.blackCheckedIn) return "no_show_black";
  if (!input.whiteCheckedIn) return "no_show_white";
  if (input.lichessStatus === null || LICHESS_NOT_STARTED.has(input.lichessStatus)) return "not_started";
  if (LICHESS_ABORTED.has(input.lichessStatus)) return "aborted";
  return null;
}
```

- [ ] **Step 4: Run — expect PASS** (all tests in the file). Then mutate `checkInCounts` to `return checkedInAt !== null;` → the "stamp before the window" test must fail; restore.
- [ ] **Step 5: Commit** — `feat(chess): pure play window and no-show reason table`.

Test-type ledger: unit here; regression = the order-differential case; E2E/smoke via Tasks 14/15.

---

### Task 3: Lichess adapter — open challenge, 404-as-absent, timeout, raw payloads

**Files:**
- Modify: `apps/web/src/server/external-play/types.ts` (replace `CreateChallengeInput`, `CreateChallengeResult`, `ExternalPlayAdapter`)
- Modify: `apps/web/src/server/external-play/lichess/adapter.ts`
- Create: `apps/web/src/server/external-play/__fixtures__/lichess/export-started.json`, `export-mate-white.json`, `export-created.json`
- Test: `apps/web/src/server/external-play/__tests__/lichess-adapter.test.ts` (rewrite test 1, keep 401/429 tests, add new)

**Interfaces:**
- Consumes: `LICHESS_TIMEOUT_MS` (Task 2).
- Produces:
  ```ts
  export type CreateOpenChallengeInput = { whiteUsername: string; blackUsername: string; clock: LichessClock; expiresAt: Date };
  export type OpenChallenge = { challengeId: string; urlWhite: string; urlBlack: string };
  export interface ExternalPlayAdapter {
    createOpenChallenge(input: CreateOpenChallengeInput): Promise<OpenChallenge>;
    fetchGame(gameId: string): Promise<LichessGameSnapshot | null>; // null = no such game yet (404)
  }
  export type LichessAdapterDeps = { fetch: typeof fetch; baseUrl?: string; timeoutMs?: number };
  ```
  `createLichessAdapter(deps)` unchanged name. `lichess/client.ts` default instance reads `process.env.LICHESS_BASE_URL ?? "https://lichess.org"` (needed by the e2e stub, Task 14).

- [ ] **Step 1: Record raw payloads.** Save three real Lichess export responses (`GET https://lichess.org/game/export/<id>?pgnInJson=false&clocks=false` with `Accept: application/json`) of a finished mate game, an in-progress game and a created-but-unstarted game; strip ratings/PGN to keep only `id, rated, status, players.white.user.{id,name}, players.black.user.{id,name}, winner`. If network is unavailable, hand-write them in exactly that raw shape and say so in the commit body. Example `export-mate-white.json`:

```json
{
  "id": "q7ZvsdUF",
  "rated": false,
  "status": "mate",
  "winner": "white",
  "players": {
    "white": { "user": { "id": "lichess-home", "name": "Lichess-Home" } },
    "black": { "user": { "id": "lichess-away", "name": "Lichess-Away" } }
  }
}
```

- [ ] **Step 2: Write failing tests**

```ts
// add to lichess-adapter.test.ts (replace the old direct-challenge test)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLichessAdapter } from "../lichess/adapter";
import { LICHESS_TIMEOUT_MS } from "../window";

const raw = (f: string) => readFileSync(join(__dirname, "../__fixtures__/lichess", f), "utf8");

describe("createOpenChallenge", () => {
  it("POSTs /api/challenge/open with users White-first, seconds clock, expiresAt ms, unrated, no auth", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "abcd1234", url: "https://lichess.org/abcd1234",
      urlWhite: "https://lichess.org/abcd1234?color=white", urlBlack: "https://lichess.org/abcd1234?color=black",
    }), { status: 200 }));
    const adapter = createLichessAdapter({ fetch, baseUrl: "https://li.test" });
    const expiresAt = new Date("2026-10-01T19:20:00.000Z");
    const out = await adapter.createOpenChallenge({
      whiteUsername: "Alice", blackUsername: "Bob", clock: { limit: 900, increment: 10 }, expiresAt,
    });
    expect(out).toEqual({
      challengeId: "abcd1234",
      urlWhite: "https://lichess.org/abcd1234?color=white",
      urlBlack: "https://lichess.org/abcd1234?color=black",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://li.test/api/challenge/open");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    const body = new URLSearchParams(String(init.body));
    expect(body.get("users")).toBe("Alice,Bob");
    expect(body.get("clock.limit")).toBe("900");
    expect(body.get("clock.increment")).toBe("10");
    expect(body.get("rated")).toBe("false");
    expect(body.get("expiresAt")).toBe(String(expiresAt.getTime()));
    expect(body.get("rules")).toBe("noRematch");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fetchGame", () => {
  it("parses the raw export shape (players.*.user.id)", async () => {
    const fetch = vi.fn(async () => new Response(raw("export-mate-white.json"), { status: 200 }));
    const g = await createLichessAdapter({ fetch }).fetchGame("q7ZvsdUF");
    expect(g).toEqual({
      id: "q7ZvsdUF", status: "mate", winner: "white",
      players: { white: { userId: "lichess-home" }, black: { userId: "lichess-away" } },
    });
  });
  it("returns null on 404 (challenge not yet accepted)", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 404 }));
    expect(await createLichessAdapter({ fetch }).fetchGame("nope")).toBeNull();
  });
  it("uses the shared timeout constant", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async () => new Response(raw("export-created.json"), { status: 200 }));
    await createLichessAdapter({ fetch }).fetchGame("x");
    expect(spy).toHaveBeenCalledWith(LICHESS_TIMEOUT_MS);
    spy.mockRestore();
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`createOpenChallenge is not a function`).
- [ ] **Step 4: Implement** — in `adapter.ts` replace `createChallenge` with:

```ts
async createOpenChallenge(input: CreateOpenChallengeInput): Promise<OpenChallenge> {
  const body = new URLSearchParams({
    users: `${input.whiteUsername},${input.blackUsername}`,
    "clock.limit": String(input.clock.limit),
    "clock.increment": String(input.clock.increment),
    rated: "false",
    expiresAt: String(input.expiresAt.getTime()),
    rules: "noRematch",
  });
  const res = await deps.fetch(`${base}/api/challenge/open`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new LichessHttpError(res.status, `open challenge failed: ${res.status}`);
  const json = (await res.json()) as { id?: unknown; urlWhite?: unknown; urlBlack?: unknown };
  if (typeof json.id !== "string" || typeof json.urlWhite !== "string" || typeof json.urlBlack !== "string") {
    throw new LichessHttpError(502, "open challenge response missing id/urlWhite/urlBlack");
  }
  return { challengeId: json.id, urlWhite: json.urlWhite, urlBlack: json.urlBlack };
},
```

with `const timeoutMs = deps.timeoutMs ?? LICHESS_TIMEOUT_MS;` at factory top; in `fetchGame` add `signal: AbortSignal.timeout(timeoutMs)`, `if (res.status === 404) return null;` before the `!res.ok` throw, and keep the existing `players.*.user.id ?? players.*.userId` parse. Update `types.ts` to the Interfaces block. In `lichess/client.ts`:

```ts
import { createLichessAdapter } from "./adapter";
export { createLichessAdapter };
export type { LichessAdapterDeps } from "./adapter";
export function defaultLichessAdapter() {
  return createLichessAdapter({ fetch, baseUrl: process.env.LICHESS_BASE_URL ?? "https://lichess.org" });
}
```

- [ ] **Step 5: Run — expect PASS** (whole file incl. kept 401/429 tests). Typecheck will be red in `external-play.ts` until Task 7 deletes it — that is expected; do not patch it.
- [ ] **Step 6: Commit** — `feat(chess): Lichess open-challenge adapter with timeout`.

Test-type ledger: unit here; regression = raw-shape parse + 404; E2E via stub (Task 14); smoke Task 15.

---

### Task 4: Lichess OAuth with PKCE, revoke, `next`, no stored token

**Files:**
- Create: `apps/web/src/server/external-play/pkce.ts`, test `apps/web/src/server/external-play/__tests__/pkce.test.ts`
- Modify: `apps/web/src/lib/oauth.ts` (PR part), `apps/web/src/app/api/auth/lichess/route.ts`, `apps/web/src/app/api/auth/lichess/callback/route.ts`
- Modify: `apps/web/src/server/usecases/external-accounts.ts` (drop `getLichessAccessToken`, token args) — SUPERSEDED 2026-10-09: the in-page-board design keeps the token and reinstates `getLichessAccessToken`; see `docs/superpowers/plans/2026-10-09-chess-in-page-board-and-camera.md` Task 2.
- Modify: `apps/web/.env.example` (remove `LICHESS_CLIENT_SECRET`, add `# LICHESS_BASE_URL=` comment)
- Modify: `apps/web/src/server/usecases/__tests__/external-accounts.test.ts` and every seeder calling `upsertLichessLink` with `accessToken` (escalate, happy-path, prepare, sync, online-play-enrollment tests) — drop the arg
- Test: `apps/web/src/app/api/auth/lichess/__tests__/lichess-oauth-routes.test.ts` (create)

**Interfaces:**
- Produces: `pkceVerifier(): string`, `pkceChallenge(verifier: string): string`; `LICHESS_OAUTH_VERIFIER_COOKIE = "seazn_lichess_oauth_verifier"`; `LICHESS_OAUTH_SCOPES = ""`; `lichessConfigured(): boolean` (true iff `LICHESS_CLIENT_ID` set); `upsertLichessLink(userId: string, row: { externalUserId: string; username: string }): Promise<void>`; `safeNext(raw: string | null): string | null` exported from `lib/oauth.ts`.

- [ ] **Step 1: Failing PKCE unit test (RFC 7636 Appendix B vector)**

```ts
import { describe, expect, it } from "vitest";
import { pkceChallenge, pkceVerifier } from "../pkce";

describe("PKCE S256", () => {
  it("matches RFC 7636 Appendix B", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("verifier is 43+ url-safe chars and random", () => {
    const a = pkceVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pkceVerifier()).not.toBe(a);
  });
});
```

- [ ] **Step 2: Failing route test** — mock `@/lib/auth` (`requireUser` → `{ id: "u1" }`), `next/headers` cookies (a Map-backed stub like the Google callback tests use; grep `vi.mock("next/headers"` in `apps/web/src/app/api/auth/google` for the house pattern), `@/server/usecases/external-accounts` (`upsertLichessLink: vi.fn()`), and global `fetch`:

```ts
it("start: redirects with code_challenge S256 and stores verifier + state + next cookies", async () => {
  vi.stubEnv("LICHESS_CLIENT_ID", "seazn-test");
  const res = await GET(new Request("http://localhost/api/auth/lichess?next=/shared/o/c/d/fixtures/f1/play"));
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe("https://lichess.org/oauth");
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loc.searchParams.get("code_challenge")).toBe(pkceChallenge(cookieJar.get("seazn_lichess_oauth_verifier")!));
  expect(loc.searchParams.has("client_secret")).toBe(false);
  expect(cookieJar.get("seazn_lichess_oauth_next")).toBe("/shared/o/c/d/fixtures/f1/play");
});

it("start: refuses a protocol-relative next", async () => {
  await GET(new Request("http://localhost/api/auth/lichess?next=//evil.example"));
  expect(cookieJar.has("seazn_lichess_oauth_next")).toBe(false);
});

it("callback: sends code_verifier (no secret), reads account, revokes, stores identity only, returns to next", async () => {
  cookieJar.set("seazn_lichess_oauth_state", "st"); cookieJar.set("seazn_lichess_oauth_verifier", "ver");
  cookieJar.set("seazn_lichess_oauth_next", "/shared/o/c/d/fixtures/f1/play");
  const calls: [string, RequestInit][] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    if (url.endsWith("/api/token") && init.method === "POST") return Response.json({ access_token: "tok" });
    if (url.endsWith("/api/account")) return Response.json({ id: "alice", username: "Alice" });
    if (url.endsWith("/api/token") && init.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 500 });
  }));
  const res = await CALLBACK(new Request("http://localhost/api/auth/lichess/callback?code=c&state=st"));
  const tokenBody = new URLSearchParams(String(calls[0][1].body));
  expect(tokenBody.get("code_verifier")).toBe("ver");
  expect(tokenBody.has("client_secret")).toBe(false);
  expect(calls.some(([u, i]) => u.endsWith("/api/token") && i.method === "DELETE")).toBe(true);
  expect(upsertLichessLink).toHaveBeenCalledWith("u1", { externalUserId: "alice", username: "Alice" });
  expect(new URL(res.headers.get("location")!).pathname).toBe("/shared/o/c/d/fixtures/f1/play");
});

it("callback: revokes even when the account read fails", async () => { /* account → 500; expect DELETE call and fail redirect */ });
```

- [ ] **Step 3: Run both files — expect FAIL.**
- [ ] **Step 4: Implement**

```ts
// apps/web/src/server/external-play/pkce.ts
import "server-only";
import { createHash, randomBytes } from "node:crypto";

export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
```

`lib/oauth.ts` (PR section): add `export const LICHESS_OAUTH_VERIFIER_COOKIE = "seazn_lichess_oauth_verifier";`, set `LICHESS_OAUTH_SCOPES = ""`, `lichessConfigured = () => Boolean(process.env.LICHESS_CLIENT_ID)`, and

```ts
/** Same rule as the Google flow: same-origin path only. */
export function safeNext(raw: string | null): string | null {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : null;
}
```

`auth/lichess/route.ts`: after state cookie, `const verifier = pkceVerifier();` set `LICHESS_OAUTH_VERIFIER_COOKIE` with the same cookie options as state (httpOnly, lax, secure in prod, path `/`, maxAge 600); set the next cookie only when `safeNext(url.searchParams.get("next"))` is non-null; add `code_challenge: pkceChallenge(verifier)`, `code_challenge_method: "S256"` to the params; omit `scope` when empty.

`callback/route.ts`: read + delete state, verifier and next cookies; token POST body `grant_type, code, redirect_uri, client_id, code_verifier` (no `client_secret`); read account with the token; then **always** in a `finally`:

```ts
await fetch(LICHESS_TOKEN_URL, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${accessToken}` },
  signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
}).catch(() => undefined);
```

then `upsertLichessLink(user.id, { externalUserId: account.id, username: account.username })`; redirect to `next ?? "/me?lichess=linked"`; `fail(reason)` redirects to `(next ?? "/me") + "?lichess=" + reason` (use `&` when `next` already has a query).

`external-accounts.ts`: delete `getLichessAccessToken`; `upsertLichessLink` SQL inserts/updates only `external_user_id, username, updated_at`. SUPERSEDED 2026-10-09: the row now also carries `access_token_enc`, `scopes` and `consented_at`, and `getLichessAccessToken` is back (in-page-board plan, Task 2).

- [ ] **Step 5: Run the two new files + `external-accounts.test.ts` — expect PASS.** Mutant: remove `code_challenge` param → start test fails.
- [ ] **Step 6: Commit** — `fix(chess): Lichess OAuth uses PKCE, revokes the token, keeps identity only`.

Test-type ledger: unit+regression here; E2E: Task 14 seeds links via SQL (OAuth cannot be driven against lichess.org in CI) — the route tests above are the seam proof; smoke Task 15 asserts `/api/auth/lichess` redirects to `lichess.org/oauth` with `code_challenge_method=S256`.

---

### Task 5: Shared signing key + personal match-room token

**Files:**
- Create: `apps/web/src/server/usecases/signing-key.ts`, `apps/web/src/server/usecases/match-room-token.ts`
- Modify: `apps/web/src/server/usecases/checkin-token.ts` (import `authSecretKey`, delete local `secretKey`)
- Test: `apps/web/src/server/usecases/__tests__/match-room-token.test.ts`; existing QR token tests must stay green

**Interfaces:**
- Consumes: `MATCH_ROOM_TOKEN_TTL_MS` (Task 2).
- Produces:
  ```ts
  export function authSecretKey(): Uint8Array;
  export type MatchRoomClaims = { fixtureId: string; personId: string; scheduledAt: string /* ISO */ };
  export async function mintMatchRoomToken(c: MatchRoomClaims): Promise<string>;
  export async function verifyMatchRoomToken(token: string): Promise<MatchRoomClaims>; // HttpError 401 MATCH_ROOM_EXPIRED | MATCH_ROOM_INVALID
  ```

- [ ] **Step 1: Failing tests**

```ts
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { mintMatchRoomToken, verifyMatchRoomToken } from "../match-room-token";
import { mintCheckinToken } from "../checkin-token";
import { authSecretKey } from "../signing-key";
import { MATCH_ROOM_TOKEN_TTL_MS } from "@/server/external-play/window";

const claims = { fixtureId: "f1", personId: "p1", scheduledAt: "2026-10-01T19:00:00.000Z" };

describe("match room token", () => {
  it("round-trips fid/pid/sat", async () => {
    expect(await verifyMatchRoomToken(await mintMatchRoomToken(claims))).toEqual(claims);
  });
  it("expires scheduled_at + 24h (not from mint time)", async () => {
    vi.useFakeTimers();
    const token = await mintMatchRoomToken(claims);
    vi.setSystemTime(Date.parse(claims.scheduledAt) + MATCH_ROOM_TOKEN_TTL_MS + 1000);
    await expect(verifyMatchRoomToken(token)).rejects.toMatchObject({ status: 401, code: "MATCH_ROOM_EXPIRED" });
    vi.useRealTimers();
  });
  it("refuses a QR check-in token (different typ)", async () => {
    const qr = await mintCheckinToken("f1", new Date(Date.now() + 60_000));
    await expect(verifyMatchRoomToken(qr)).rejects.toMatchObject({ code: "MATCH_ROOM_INVALID" });
  });
  it("refuses a token missing pid", async () => {
    const bad = await new SignJWT({ fid: "f1", sat: claims.scheduledAt })
      .setProtectedHeader({ alg: "HS256", typ: "seazn-match-room" }).setExpirationTime("1h").sign(authSecretKey());
    await expect(verifyMatchRoomToken(bad)).rejects.toMatchObject({ code: "MATCH_ROOM_INVALID" });
  });
});
```

(If `HttpError` exposes the code under a different property name, read `apps/web/src/lib/errors.ts` and adjust the matcher — do not change `HttpError`.)

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

```ts
// signing-key.ts
import "server-only";
export function authSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production")
      throw new Error("AUTH_SECRET environment variable is required in production");
    return new TextEncoder().encode("dev-insecure-secret-change-me");
  }
  return new TextEncoder().encode(secret);
}
```

```ts
// match-room-token.ts
import "server-only";
// Personal match-room link (spec §12.1): stateless HS256 JWT. It IDENTIFIES a
// player for one fixture; it never widens what they can do — the server window
// and Lichess expiry gate every action.
import { SignJWT, errors, jwtVerify } from "jose";
import { HttpError } from "@/lib/errors";
import { MATCH_ROOM_TOKEN_TTL_MS } from "@/server/external-play/window";
import { authSecretKey } from "./signing-key";

const TYP = "seazn-match-room";

export type MatchRoomClaims = { fixtureId: string; personId: string; scheduledAt: string };

export async function mintMatchRoomToken(c: MatchRoomClaims): Promise<string> {
  const exp = Math.floor((Date.parse(c.scheduledAt) + MATCH_ROOM_TOKEN_TTL_MS) / 1000);
  return new SignJWT({ fid: c.fixtureId, pid: c.personId, sat: c.scheduledAt })
    .setProtectedHeader({ alg: "HS256", typ: TYP })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(authSecretKey());
}

export async function verifyMatchRoomToken(token: string): Promise<MatchRoomClaims> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, authSecretKey(), { typ: TYP });
    if (protectedHeader.typ !== TYP) throw new Error("typ");
    const { fid, pid, sat } = payload as Record<string, unknown>;
    if (typeof fid !== "string" || typeof pid !== "string" || typeof sat !== "string") throw new Error("claims");
    return { fixtureId: fid, personId: pid, scheduledAt: sat };
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw new HttpError(401, "This match link has expired", "MATCH_ROOM_EXPIRED");
    }
    throw new HttpError(401, "This match link is not valid", "MATCH_ROOM_INVALID");
  }
}
```

In `checkin-token.ts` replace `secretKey()` uses with `authSecretKey()` and delete the local function.

- [ ] **Step 4: Run new file + `grep -arl "checkin-token" apps/web/src --include=*.test.ts` files — expect PASS.**
- [ ] **Step 5: Commit** — `feat(chess): personal match-room link token`.

Test-type ledger: unit+regression (QR suite unchanged); E2E Task 14 opens the room via a minted token; smoke Task 15.

---

### Task 6: Person-level check-in stamp

**Files:**
- Modify: `apps/web/src/server/usecases/me.ts:251-267`
- Test: `apps/web/src/server/usecases/__tests__/me.test.ts` (add one case; existing QR check-in cases at ~:245-257 must stay green)

**Interfaces:**
- Produces: `export async function stampFixtureCheckIn(personId: string, fixtureId: string, orgId: string): Promise<AvailabilityRow>` — the exact insert/upsert currently inside `checkInToFixture`. `checkInToFixture(userId, fixtureId)` keeps its signature and behaviour and calls it.

- [ ] **Step 1: Failing test** — reuse the file's existing seeding for a rostered person on a fixture; call `stampFixtureCheckIn(personId, fixtureId, orgId)` twice with a 5 ms gap and assert the row exists with `status = 'in'` on first insert and that the second call moves `checked_in_at` later (matches today's QR re-stamp behaviour).
- [ ] **Step 2: Run — expect FAIL** (not exported).
- [ ] **Step 3: Implement** — move the SQL block into `stampFixtureCheckIn`; `checkInToFixture` keeps its `myPersonOnFixture` lookup and finalized/cancelled 422, then `return stampFixtureCheckIn(mine.person_id, fixtureId, mine.org_id);`.
- [ ] **Step 4: Run the whole `me.test.ts` — expect PASS with the pre-existing count + 1.**
- [ ] **Step 5: Commit** — `refactor(me): expose the person-level check-in stamp`.

Test-type ledger: unit+regression here; E2E: the existing QR check-in e2e (`grep -arl "checkin" apps/web/e2e`) re-run in Task 16; smoke unchanged.

---

### Task 7: Guard, sides, colour, stale-row reset (replaces `external-play.ts`)

**Files:**
- Delete: `apps/web/src/server/usecases/external-play.ts` (first copy the fixture/division/competition/org join at its L188-213 and `loadSide` at L77-106 into the new file — they are the starting SQL)
- Create: `apps/web/src/server/usecases/external-play/index.ts`, `guard.ts`
- Test: `apps/web/src/server/usecases/__tests__/external-play-guard.test.ts`

**Interfaces:**
- Consumes: `windowFor`, types (Tasks 2–3), `mapBoardgameClockToLichess` (`server/external-play/clock.ts`).
- Produces:
  ```ts
  export type Side = "home" | "away";
  export type SidePlayer = { side: Side; entrantId: string; displayName: string; personId: string | null; userId: string | null;
    lichess: { id: string; username: string } | null; recipients: { email: string; locale: string | null }[] };
  export type BridgeRow = { status: ExternalPlayStatus; scheduled_at_basis: Date; challenge_id: string | null; url_white: string | null;
    url_black: string | null; white_side: Side | null; white_lichess_id: string | null; black_lichess_id: string | null;
    expires_at: Date | null; mint_claimed_at: Date | null; white_emailed_at: Date | null; black_emailed_at: Date | null;
    needs_reason: NeedsReason | null; started_at: Date | null; finished_at: Date | null };
  export type OnlinePlayFixture = { fixtureId: string; orgId: string; orgSlug: string; orgName: string; competitionSlug: string;
    divisionSlug: string; scheduledAt: Date; homeEntrantId: string; awayEntrantId: string; fixtureStatus: string;
    clock: LichessClock; bridge: BridgeRow | null };
  export async function loadOnlinePlayFixture(fixtureId: string): Promise<OnlinePlayFixture | null>;
  export function effectiveBridge(f: OnlinePlayFixture): BridgeRow | null; // stale (basis ≠ scheduledAt, not live/finished) ⇒ null, pure
  export async function resetStaleBridge(f: OnlinePlayFixture): Promise<void>; // writes only when stale
  export async function loadSides(f: OnlinePlayFixture): Promise<{ home: SidePlayer; away: SidePlayer }>;
  export async function whiteSideOf(f: OnlinePlayFixture): Promise<Side>;
  export async function ensureBridgeRow(f: OnlinePlayFixture): Promise<void>; // insert … on conflict do nothing
  ```

- [ ] **Step 1: Verify two facts before coding (write findings in the commit body):**
  1. Column names: `divisions.sport_key`, `divisions.status`, `persons.merged_into` — `grep -a` the V2 table migrations under `db/migration/v2-engine/tables/`.
  2. Colour source: read `getFixtureState` in `apps/web/src/server/usecases/fixtures.ts` (~:537) and the boardgame state type in `packages/engine/src/sports/boardgame/boardgame.ts` (`colorOfHome`, ~:292-302, `init` ~:591). If `getFixtureState(auth, fixtureId)` returns the folded state, `whiteSideOf` = `state.colorOfHome === "B" ? "away" : "home"` using `mintOrgOwnerAuth` (move that helper into `sync.ts` in Task 9; for now import from a local `auth.ts` in the directory). If it does not, fold via the engine the same way `getFixtureState` does. Never default silently: a fixture with no events and `colorOfHome === null` is `"home"` only because Swiss emits home = White (`packages/engine/src/scheduling/swiss.ts:42`) — assert that in a test.

- [ ] **Step 2: Failing DB tests** (seed like the PR's `external-play-sync.test.ts` `seedBoardgameSport/seedOwner/seedPlayer` helpers — move those helpers into `apps/web/src/server/usecases/__tests__/_external-play-seed.ts` and export `seedOnlineChessFixture({ onlinePlay, divisionStarted, scheduledAt, linked })` returning `{ orgId, fixtureId, home: { personId, userId }, away: { personId, userId } }`):

```ts
it("empty case: online play off ⇒ null", async () => {
  const s = await seedOnlineChessFixture({ onlinePlay: "off", divisionStarted: true, scheduledAt: T, linked: true });
  expect(await loadOnlinePlayFixture(s.fixtureId)).toBeNull();
});
it("unstarted division ⇒ null (scoreEvent would refuse)", async () => { /* divisionStarted: false */ });
it("finalized fixture ⇒ null", async () => { /* update fixtures set status='finalized' */ });
it("non-boardgame sport with onlinePlay forced into config ⇒ null", async () => { /* raw config update on a football division */ });
it("guarded fixture loads with clock in seconds and no bridge", async () => {
  const s = await seedOnlineChessFixture({ onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true });
  const f = await loadOnlinePlayFixture(s.fixtureId);
  expect(f).toMatchObject({ fixtureId: s.fixtureId, clock: { limit: 900, increment: 0 }, bridge: null });
});
it("effectiveBridge hides a row minted for an older scheduled_at; resetStaleBridge clears it; live rows are never reset", async () => { /* … */ });
it("whiteSideOf: home unless a pairing event made home Black", async () => { /* append boardgame.pairing { white: awayEntrantId } via scoreEvent, expect 'away' */ });
```

Each guard predicate in the SQL (`onlinePlay`, sport, division status, scheduled_at, both entrants, fixture status) gets its own test above — mutate each once (delete the line) and confirm exactly its test fails.

- [ ] **Step 3: Run — expect FAIL.**
- [ ] **Step 4: Implement `guard.ts`**

```ts
import "server-only";
import { sql } from "@/lib/db";
import { mapBoardgameClockToLichess } from "@/server/external-play/clock";
import type { ExternalPlayStatus, LichessClock, NeedsReason } from "@/server/external-play/types";

// (types from the Interfaces block)

export async function loadOnlinePlayFixture(fixtureId: string): Promise<OnlinePlayFixture | null> {
  const [row] = await sql<(Omit<OnlinePlayFixture, "clock" | "bridge"> & { divisionConfig: unknown; bridge: BridgeRow | null })[]>`
    select f.id as "fixtureId", o.id as "orgId", o.slug as "orgSlug", o.name as "orgName",
           c.slug as "competitionSlug", d.slug as "divisionSlug", f.scheduled_at as "scheduledAt",
           f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId",
           f.status as "fixtureStatus", d.config as "divisionConfig",
           case when ep.fixture_id is null then null else to_jsonb(ep) end as bridge
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = c.org_id
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.id = ${fixtureId}
       and d.sport_key = 'boardgame'
       and coalesce(d.config->>'onlinePlay', 'off') = 'lichess'
       and d.status not in ('setup', 'scheduled')
       and f.scheduled_at is not null
       and f.home_entrant_id is not null
       and f.away_entrant_id is not null
       and f.status not in ('finalized', 'cancelled')`;
  if (!row) return null;
  const clock = mapBoardgameClockToLichess((row.divisionConfig as { clock?: never } | null)?.clock);
  if (!clock.ok) return null; // settings save refuses this (Task 11); a legacy row is simply not online
  const { divisionConfig: _c, bridge, ...rest } = row;
  return { ...rest, clock: clock.clock, bridge: bridge ? reviveBridge(bridge) : null };
}
```

`reviveBridge` converts the jsonb timestamp strings to `Date` for every `Date` field in `BridgeRow`. `effectiveBridge`:

```ts
export function isStale(f: OnlinePlayFixture): boolean {
  const b = f.bridge;
  return !!b && b.status !== "live" && b.status !== "finished"
    && b.scheduled_at_basis.getTime() !== f.scheduledAt.getTime();
}
export function effectiveBridge(f: OnlinePlayFixture): BridgeRow | null {
  return isStale(f) ? null : f.bridge;
}
export async function resetStaleBridge(f: OnlinePlayFixture): Promise<void> {
  if (!isStale(f)) return;
  await sql`
    update fixture_external_play
       set status = 'pending', scheduled_at_basis = ${f.scheduledAt}, challenge_id = null,
           url_white = null, url_black = null, white_side = null, white_lichess_id = null,
           black_lichess_id = null, expires_at = null, mint_claimed_at = null,
           white_emailed_at = null, black_emailed_at = null, needs_reason = null,
           last_error = null, updated_at = now()
     where fixture_id = ${f.fixtureId}
       and status in ('pending', 'ready', 'needs_organiser')
       and scheduled_at_basis <> ${f.scheduledAt}`;
}
export async function ensureBridgeRow(f: OnlinePlayFixture): Promise<void> {
  await sql`
    insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis)
    values (${f.fixtureId}, ${f.orgId}, ${f.scheduledAt})
    on conflict (fixture_id) do nothing`;
}
```

`loadSides` = the PR's `loadSide` SQL plus `p.id as person_id`, `and p.merged_into is null`, and a left join `user_external_accounts uea on uea.user_id = p.user_id and uea.provider = 'lichess'`; `personId`/`userId`/`lichess` are non-null only when the entrant has exactly one member person with a user. `index.ts` re-exports everything public from `guard.ts` (and later files).

- [ ] **Step 5: Run — expect PASS.** Record the six guard mutants and their killer tests in the commit body.
- [ ] **Step 6: Commit** — `feat(chess): one online-play guard with lazy reschedule reset`.

Test-type ledger: unit(DB)+regression here; E2E Task 14 ("online play off ⇒ room 404"); smoke Task 15.

---

### Task 8: Match room usecase — identity, view, check-in, mint

**Files:**
- Create: `apps/web/src/server/usecases/external-play/room.ts`
- Modify: `apps/web/src/lib/realtime.ts` (PR section)
- Test: `apps/web/src/server/usecases/__tests__/external-play-room.test.ts`, `apps/web/src/lib/__tests__/realtime-lobby-token.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 6, 7.
- Produces:
  ```ts
  export type RoomIdentity = { kind: "session"; userId: string } | { kind: "token"; token: string };
  export type MatchRoomView = {
    fixtureId: string; phase: RoomPhase; opensAt: string; deadline: string;
    you: { side: Side; colour: "white" | "black"; checkedIn: boolean };
    opponent: { name: string; checkedIn: boolean };
    status: ExternalPlayStatus; needsReason: NeedsReason | null;
    playUrl: string | null;   // caller's own colour; only when status ready and phase open
    watchUrl: string | null;  // https://lichess.org/{challengeId} when live or finished
    canMint: boolean;         // both checked in, phase open, no challenge — client may POST mint
  };
  export async function resolveRoomPlayer(identity: RoomIdentity, f: OnlinePlayFixture): Promise<SidePlayer | null>;
  export async function readMatchRoom(identity: RoomIdentity, fixtureId: string, now?: Date): Promise<MatchRoomView>; // 404 NOT_FOUND when guard fails or caller not a player; NEVER writes
  export async function checkInToMatchRoom(identity: RoomIdentity, fixtureId: string, deps?: RoomDeps): Promise<MatchRoomView>;
  export async function mintIfReady(f: OnlinePlayFixture, deps?: RoomDeps): Promise<"minted" | "not_ready" | "busy" | "failed">;
  export type RoomDeps = { now?: Date; adapter?: ExternalPlayAdapter; publish?: (fixtureId: string) => Promise<void> };
  // realtime.ts
  export async function mintExternalPlayLobbyToken(fixtureId: string, subject: string, expiresAt: Date): Promise<string>;
  ```

- [ ] **Step 1: Failing realtime token test**

```ts
import { decodeJwt } from "jose";
it("lobby token carries lobby_fixture_id and NOT fixture_id, expiring at the given deadline", async () => {
  vi.stubEnv("SUPABASE_JWT_SECRET", "x".repeat(40)); vi.stubEnv("SUPABASE_JWT_ALG", "HS256");
  const deadline = new Date(Date.now() + 20 * 60_000);
  const claims = decodeJwt(await mintExternalPlayLobbyToken("f1", "person:p1", deadline));
  expect(claims.lobby_fixture_id).toBe("f1");
  expect("fixture_id" in claims).toBe(false);
  expect(claims.exp).toBe(Math.floor(deadline.getTime() / 1000));
});
```

(Read `resolveRealtimeMintKey` in `lib/realtime.ts` for which env vars make HS256 minting work in a unit test; adjust the stubs to them.)

- [ ] **Step 2: Failing DB tests** (adapter fake: `createOpenChallenge: vi.fn(async () => ({ challengeId: "ch1", urlWhite: "https://l/ch1?color=white", urlBlack: "https://l/ch1?color=black" })), fetchGame: vi.fn(async () => null)`; `publish: vi.fn(async () => {})`; `now` = T−5min unless stated):

```ts
it("GET never writes: reading the room twice leaves fixture_external_play and fixture_availability untouched", async () => {
  const before = await snapshotRows(s.fixtureId);
  await readMatchRoom({ kind: "session", userId: s.home.userId }, s.fixtureId, now);
  expect(await snapshotRows(s.fixtureId)).toEqual(before);
});
it("non-player session ⇒ 404", async () => { /* third user */ });
it("token for the other fixture or a stale sat ⇒ 404", async () => { /* mint token with different scheduledAt */ });
it("before T−10: check-in refused 409 CHECK_IN_CLOSED, nothing stamped", async () => { /* now = T−11min */ });
it("first check-in stamps fixture_availability, publishes, does not mint", async () => {
  const v = await checkInToMatchRoom(home, s.fixtureId, deps);
  expect(v.you.checkedIn).toBe(true); expect(v.opponent.checkedIn).toBe(false);
  expect(deps.adapter.createOpenChallenge).not.toHaveBeenCalled();
  expect(deps.publish).toHaveBeenCalledWith(s.fixtureId);
});
it("second check-in mints ONE open challenge White-first with expiresAt = deadline, and each player sees only their colour", async () => {
  await checkInToMatchRoom(home, s.fixtureId, deps);
  const v = await checkInToMatchRoom(away, s.fixtureId, deps);
  expect(deps.adapter.createOpenChallenge).toHaveBeenCalledTimes(1);
  expect(deps.adapter.createOpenChallenge).toHaveBeenCalledWith({
    whiteUsername: "Lichess-Home", blackUsername: "Lichess-Away",
    clock: { limit: 900, increment: 0 }, expiresAt: windowFor(T).deadline,
  });
  expect(v.playUrl).toBe("https://l/ch1?color=black");
  expect((await readMatchRoom(home, s.fixtureId, now)).playUrl).toBe("https://l/ch1?color=white");
});
it("token identity checks in with no session", async () => { /* identity { kind: 'token', token: mintMatchRoomToken({fixtureId, personId: away.personId, scheduledAt}) } */ });
it("concurrent mint keeps one challenge", async () => {
  // both checked in via stampFixtureCheckIn directly; adapter resolves after 50ms
  const f = (await loadOnlinePlayFixture(s.fixtureId))!;
  const results = await Promise.all([mintIfReady(f, deps), mintIfReady(f, deps), mintIfReady(f, deps)]);
  expect(results.filter((r) => r === "minted")).toHaveLength(1);
  expect(deps.adapter.createOpenChallenge).toHaveBeenCalledTimes(1);
});
it("adapter failure: stays pending, last_error set, claim released, canMint true for retry", async () => { /* adapter rejects */ });
it("live never re-mints", async () => { /* set status live; mintIfReady → not_ready; adapter not called */ });
it("colour follows whiteSideOf: after a pairing flip, home gets the Black link", async () => { /* … */ });
it("check-in after T+20 refused even with a valid token", async () => { /* now = T+20min */ });
```

- [ ] **Step 3: Run — expect FAIL.**
- [ ] **Step 4: Implement**

`realtime.ts`: change `mintExternalPlayLobbyToken` to

```ts
export async function mintExternalPlayLobbyToken(fixtureId: string, subject: string, expiresAt: Date): Promise<string> {
  const { key, alg, kid } = await resolveRealtimeMintKey();
  const header = { alg, typ: "JWT", ...(kid ? { kid } : {}) };
  // lobby_fixture_id — NEVER fixture_id: V403's paid fixture:{id} policy reads fixture_id.
  return new SignJWT({ role: "authenticated", sub: subject, lobby_fixture_id: fixtureId })
    .setProtectedHeader(header)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .setAudience("authenticated")
    .sign(key);
}
```

`room.ts` core (complete the obvious glue — view assembly is straight field mapping):

```ts
export async function resolveRoomPlayer(identity: RoomIdentity, f: OnlinePlayFixture): Promise<SidePlayer | null> {
  const { home, away } = await loadSides(f);
  if (identity.kind === "session") {
    return [home, away].find((s) => s.userId === identity.userId) ?? null;
  }
  const claims = await verifyMatchRoomToken(identity.token).catch(() => null);
  if (!claims || claims.fixtureId !== f.fixtureId) return null;
  if (Date.parse(claims.scheduledAt) !== f.scheduledAt.getTime()) return null; // rescheduled ⇒ link dead
  return [home, away].find((s) => s.personId === claims.personId) ?? null;
}

async function checkIns(f: OnlinePlayFixture, home: SidePlayer, away: SidePlayer) {
  const rows = await sql<{ person_id: string; checked_in_at: Date | null }[]>`
    select person_id, checked_in_at from fixture_availability
     where fixture_id = ${f.fixtureId}
       and person_id in ${sql([home.personId, away.personId].filter((p): p is string => !!p))}`;
  const at = (p: string | null) => rows.find((r) => r.person_id === p)?.checked_in_at ?? null;
  return { home: checkInCounts(at(home.personId), f.scheduledAt), away: checkInCounts(at(away.personId), f.scheduledAt) };
}

export async function mintIfReady(f: OnlinePlayFixture, deps: RoomDeps = {}): Promise<"minted" | "not_ready" | "busy" | "failed"> {
  const now = deps.now ?? new Date();
  if (roomPhase(now, f.scheduledAt) !== "open") return "not_ready";
  const { home, away } = await loadSides(f);
  const ci = await checkIns(f, home, away);
  if (!ci.home || !ci.away || !home.lichess || !away.lichess) return "not_ready";
  await resetStaleBridge(f);
  await ensureBridgeRow(f);
  const claimed = await sql`
    update fixture_external_play set mint_claimed_at = ${now}, updated_at = now()
     where fixture_id = ${f.fixtureId} and status = 'pending' and challenge_id is null
       and (mint_claimed_at is null or mint_claimed_at < ${new Date(now.getTime() - MINT_CLAIM_STALE_MS)})
     returning fixture_id`;
  if (claimed.length === 0) return "busy";
  const whiteSide = await whiteSideOf(f);
  const white = whiteSide === "home" ? home : away;
  const black = whiteSide === "home" ? away : home;
  const adapter = deps.adapter ?? defaultLichessAdapter();
  const deadline = windowFor(f.scheduledAt).deadline;
  try {
    const ch = await adapter.createOpenChallenge({       // outside any transaction
      whiteUsername: white.lichess!.username, blackUsername: black.lichess!.username,
      clock: f.clock, expiresAt: deadline,
    });
    await sql`
      update fixture_external_play
         set status = 'ready', challenge_id = ${ch.challengeId}, url_white = ${ch.urlWhite},
             url_black = ${ch.urlBlack}, white_side = ${whiteSide},
             white_lichess_id = ${white.lichess!.id}, black_lichess_id = ${black.lichess!.id},
             expires_at = ${deadline}, mint_claimed_at = null, last_error = null, updated_at = now()
       where fixture_id = ${f.fixtureId} and status = 'pending'`;
    await (deps.publish ?? publishExternalPlayLobby)(f.fixtureId);
    return "minted";
  } catch (err) {
    await sql`
      update fixture_external_play
         set mint_claimed_at = null, last_error = ${err instanceof Error ? err.message.slice(0, 500) : "mint_failed"}, updated_at = now()
       where fixture_id = ${f.fixtureId} and status = 'pending'`;
    return "failed";
  }
}
```

(The repo forbids `!` non-null assertions — replace `white.lichess!` with a narrowed local: `const wl = white.lichess; const bl = black.lichess; if (!wl || !bl) return "not_ready";` before the claim.)

`checkInToMatchRoom`: load guard (404 `NOT_FOUND` if null) → `resetStaleBridge` → player via `resolveRoomPlayer` (404 if null) → phase must be `open` else `HttpError(409, …, "CHECK_IN_CLOSED")` → `stampFixtureCheckIn(player.personId, f.fixtureId, f.orgId)` → `publish` → `mintIfReady` → return `readMatchRoom`.

`readMatchRoom`: guard + player (404s) → `effectiveBridge` (pure, no reset write) → check-ins → `whiteSideOf` (only if bridge has no `white_side`) → assemble view; `playUrl` only when `bridge.status === "ready" && phase === "open"`; `watchUrl` when status `live|finished`; `canMint` when both checked in, phase open, no bridge or bridge `pending` without challenge.

- [ ] **Step 5: Run both files — expect PASS.** Mutants: drop `and status = 'pending'` from the claim → concurrency test must fail; drop the phase check in `checkInToMatchRoom` → "before T−10" test must fail.
- [ ] **Step 6: Commit** — `feat(chess): match room check-in mints one open challenge outside any transaction`.

Test-type ledger: unit(DB)+regression here; E2E Task 14 drives it through two browsers; smoke Task 15.

---

### Task 9: Game sync, fair poll, poke

**Files:**
- Create: `apps/web/src/server/usecases/external-play/sync.ts` (move `mintOrgOwnerAuth`, `nextExpectedSeq`, `appendExternalResult` from the deleted file, unchanged except as noted)
- Modify: `apps/web/src/server/external-play/map-result.ts` only if its input must take stored ids (it already takes `homeLichessId/awayLichessId`)
- Test: `apps/web/src/server/usecases/__tests__/external-play-sync.test.ts` (rewrite)

**Interfaces:**
- Produces:
  ```ts
  export type SyncOutcome = "ignored" | "live" | "finished" | "needs_organiser";
  export async function applyGameSnapshot(f: OnlinePlayFixture, game: LichessGameSnapshot | null): Promise<SyncOutcome>;
  export async function pollExternalPlay(deps?: { adapter?: ExternalPlayAdapter; limit?: number; now?: Date }): Promise<{ polled: number } & Record<SyncOutcome, number>>;
  export async function pokeFixture(fixtureId: string, deps?: { adapter?: ExternalPlayAdapter }): Promise<SyncOutcome>;
  export async function mintOrgOwnerAuth(orgId: string): Promise<AuthCtx>;
  export async function appendExternalResult(orgId: string, fixtureId: string, payload: BoardgameResultPayload, idempotencyKey: string, authOverride?: AuthCtx): Promise<ScoreOutcome>;
  ```

- [ ] **Step 1: Failing DB tests** (seed a `ready` bridge through `mintIfReady` with the fake adapter, not raw SQL — the seam must be produced by the real producer):

```ts
it("created (not accepted) is NOT live", async () => {
  expect(await applyGameSnapshot(f, { ...snap, status: "created" })).toBe("ignored");
  expect((await bridge(f)).status).toBe("ready");
});
it("null game (404) is ignored", async () => { expect(await applyGameSnapshot(f, null)).toBe("ignored"); });
it("started ⇒ live + one core.start", async () => { /* count score_events type core.start = 1; second call still 1 */ });
it("mate for White ⇒ finished; result winner is the entrant on white_side; standings updated", async () => {
  // flip colours first so white_side = away; expect boardgame.result winner = awayEntrantId
});
it("stored ids mismatch ⇒ needs_organiser(mismatch), zero result events", async () => { /* … */ });
it("aborted ⇒ needs_organiser(aborted)", async () => { /* … */ });
it("status writes are conditional: a needs_organiser row is not flipped to live by a late started snapshot", async () => { /* … */ });
it("fixture already has a result ⇒ ignored, bridge finished only if it was live", async () => { /* resolve first, then mate snapshot */ });
it("poll stamps every row it looks at so 3 stuck rows cannot starve a 4th with limit 3", async () => {
  // 4 ready rows; adapter.fetchGame returns null for all; poll limit 3 twice; the 4th row's last_polled_at is non-null after the 2nd poll
});
it("poll skips a row whose division turned online play off", async () => { /* … */ });
it("pokeFixture fetches by the stored challenge id and applies", async () => { /* … */ });
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — `applyGameSnapshot` order:
  1. `b = effectiveBridge(f)`; if `!b || !b.challenge_id` → `"ignored"`.
  2. If fixture already decided (`f.fixtureStatus in ('decided','forfeited','finalized','abandoned')`) → `"ignored"`.
  3. `game === null || LICHESS_NOT_STARTED.has(game.status)` → `"ignored"`.
  4. `LICHESS_ABORTED.has(game.status)` → `markNeedsOrganiser(f, "aborted", ["ready","live"])`.
  5. Ids: `game.players.white.userId !== b.white_lichess_id || game.players.black.userId !== b.black_lichess_id` → `markNeedsOrganiser(f, "mismatch", ["ready","live"])`.
  6. Map with `mapLichessGameToBoardgameResult({ game, homeEntrantId, awayEntrantId, homeLichessId: b.white_side === "home" ? b.white_lichess_id : b.black_lichess_id, awayLichessId: b.white_side === "home" ? b.black_lichess_id : b.white_lichess_id })` — **read `map-result.ts` first**: if it assumes white = home, change it to take `whiteSide: Side` and add a map-result unit test where `whiteSide = "away"` and White wins ⇒ `winner = awayEntrantId`.
  7. `unfinished` ⇒ `markLive` (`update … set status='live', started_at=coalesce(started_at, now()) where fixture_id=$1 and status='ready' returning`; append `core.start` only if the update returned a row AND `nextExpectedSeq === 0`) → `"live"`.
  8. Finished ⇒ ensure live (step 7 logic), `appendExternalResult(… idempotency "lichess:<challengeId>")`; on throw ⇒ `markNeedsOrganiser(f, "provider_error", ["ready","live"])` with `last_error` = message; on success `update … set status='finished', finished_at=now() where fixture_id=$1 and status in ('ready','live')`.

  `markNeedsOrganiser(f, reason, from)`: `update … set status='needs_organiser', needs_reason=$reason, updated_at=now() where fixture_id=$1 and status in ${sql(from)}`.

  `pollExternalPlay`:

  ```ts
  const rows = await sql<{ fixture_id: string }[]>`
    with picked as (
      select ep.fixture_id from fixture_external_play ep
       where ep.status in ('ready', 'live')
       order by ep.last_polled_at nulls first, ep.fixture_id
       limit ${limit}
       for update skip locked
    )
    update fixture_external_play ep set last_polled_at = ${now}
      from picked where ep.fixture_id = picked.fixture_id
    returning ep.fixture_id`;
  for (const { fixture_id } of rows) {
    const f = await loadOnlinePlayFixture(fixture_id);
    const b = f ? effectiveBridge(f) : null;
    if (!f || !b?.challenge_id) { counts.ignored++; continue; }
    const game = await adapter.fetchGame(b.challenge_id).catch(() => undefined);
    if (game === undefined) { counts.ignored++; continue; }     // network error: retry next cycle
    counts[await applyGameSnapshot(f, game)]++;
  }
  ```

  (The CTE's `for update skip locked` is one statement — no HTTP inside it.)

- [ ] **Step 4: Run — expect PASS.** Mutants: remove `and status='ready'` from `markLive` → conditional-write test fails; remove the `last_polled_at` stamp → starvation test fails.
- [ ] **Step 5: Commit** — `feat(chess): conditional Lichess game sync with fair polling`.

Test-type ledger: unit(DB)+regression here; E2E Task 14 (stub game export flips the room to "in progress"); smoke Task 15.

---

### Task 10: Sweeps — per-player email, mint retry, deadline no-shows, cron + webhook routes

**Files:**
- Create: `apps/web/src/server/usecases/external-play/sweep.ts`, `organiser.ts` (move `resolveExternalPlay` + `resendExternalPlayNotice`)
- Modify: `apps/web/src/lib/email-templates/external-play-ready.ts`, `apps/web/src/lib/email.ts` (args), `apps/web/src/dictionaries/{en,es,fr,nl}/emails.json` (`externalPlayReady.*`)
- Modify: `apps/web/src/app/api/cron/external-play/route.ts`, `apps/web/src/app/api/webhooks/lichess/route.ts`, `apps/web/src/lib/routes.ts` (add `sharedFixturePlay`)
- Test: `apps/web/src/server/usecases/__tests__/external-play-sweep.test.ts` (replaces prepare + escalate tests), `apps/web/src/lib/email-templates/__tests__/external-play-ready.test.ts`, `apps/web/src/app/api/cron/external-play/route.test.ts`, `apps/web/src/app/api/webhooks/lichess/route.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function sendDueEmails(deps: { origin: string; now?: Date; send?: typeof sendExternalPlayReadyEmail; fixtureId?: string; force?: boolean }): Promise<{ emailed: number; failed: number }>;
  export async function retryMints(deps?: RoomDeps): Promise<{ minted: number; failed: number }>;
  export async function escalateAtDeadline(deps?: { now?: Date; adapter?: ExternalPlayAdapter }): Promise<{ escalated: number }>;
  export async function runExternalPlaySweep(deps: { origin: string; now?: Date; adapter?: ExternalPlayAdapter }): Promise<Record<string, unknown>>;
  export type ExternalPlayReadyArgs = { orgName: string; opponentName: string; opensAtLabel: string; deadlineLabel: string; roomUrl: string };
  // routes.ts
  sharedFixturePlay: (orgSlug: Slug, compSlug: Slug, divSlug: Slug, fixtureId: string) => string; // `${sharedFixture(...)}/play`
  ```

- [ ] **Step 1: Failing email template test**

```ts
it("escapes the opponent name and links to the room, never lichess.org", () => {
  const out = externalPlayReadyTemplate({
    orgName: "Club", opponentName: `<img src=x onerror=alert(1)>`, opensAtLabel: "18:50", deadlineLabel: "19:20",
    roomUrl: "https://seazn.test/shared/o/c/d/fixtures/f1/play?t=abc",
  }, en);
  expect(out.html).not.toContain("<img src=x");
  expect(out.html).toContain("&lt;img src=x");
  expect(out.html).toContain("https://seazn.test/shared/o/c/d/fixtures/f1/play?t=abc");
  expect(out.html).not.toContain("lichess.org");
  expect(out.text).toContain("18:50");
});
```

Run for all four locale dictionaries in a loop (each must render opens/deadline labels).

- [ ] **Step 2: Failing sweep DB tests**

```ts
it("emails at T−15 once per PLAYER with a personal room link; a failed recipient is retried next run without re-emailing the other", async () => {
  const send = vi.fn(async (to: string) => to !== "away@example.test");
  await sendDueEmails({ origin, now: at(-EMAIL_LEAD_MS), send });
  await sendDueEmails({ origin, now: at(-EMAIL_LEAD_MS + 60_000), send });
  const toHome = send.mock.calls.filter(([to]) => to === "home@example.test");
  expect(toHome).toHaveLength(1);
  const url = new URL((toHome[0][1] as ExternalPlayReadyArgs).roomUrl);
  expect(url.pathname).toMatch(/\/fixtures\/[^/]+\/play$/);
  expect(await verifyMatchRoomToken(url.searchParams.get("t") ?? "")).toMatchObject({ personId: s.home.personId });
  expect(send.mock.calls.filter(([to]) => to === "away@example.test")).toHaveLength(2);
});
it("does not email before T−15 or after the deadline", async () => { /* … */ });
it("§9 row: white checked in, black not ⇒ needs_organiser(no_show_black) — even with no bridge row", async () => { /* no ensureBridgeRow; escalate creates it */ });
it("§9 row: neither ⇒ no_show_both", async () => { /* … */ });
it("§9 row: black only ⇒ no_show_white", async () => { /* … */ });
it("§9 row: both, challenge, never started (fetchGame null) ⇒ not_started", async () => { /* … */ });
it("§9 row: both, aborted ⇒ aborted", async () => { /* … */ });
it("deadline: a game that started in the last cycle is made live by the final poll, not escalated", async () => { /* fetchGame → started */ });
it("before the deadline nothing escalates", async () => { /* now = deadline − 1ms */ });
it("retryMints mints for both-checked-in pending rows after a failure", async () => { /* … */ });
it("reschedule: a needs_organiser row for the old time is reset to pending by the sweep", async () => { /* update fixtures.scheduled_at; runExternalPlaySweep; status pending, needs_reason null */ });
it("resolve (organiser) appends through scoreEvent and clears needs_reason; re-resolve 409", async () => { /* carried from the PR escalate test 3 */ });
```

- [ ] **Step 3: Failing route tests** — cron: mock `@/server/usecases/external-play` `runExternalPlaySweep`; assert 503 unset / 401 wrong / 200 calls with `{ origin }`. Webhook: signed body `{"fixtureId":"f1"}` → `pokeFixture("f1")`; body `{"gameId":"x"}` → 422 `fixtureId required`.
- [ ] **Step 4: Run all four — expect FAIL.**
- [ ] **Step 5: Implement**
  - Template: build every interpolated value through the existing escape helper in `lib/email-templates/compose.ts` (read it; if no exported `escapeHtml`, add one there and use it — `&`, `<`, `>`, `"`, `'`). Copy keys (all 4 locales, rewrite the PR's `externalPlayReady.*`): `subject` "Your match vs {opponent} opens at {opensAt}", `title`, `body` "Check in between {opensAt} and {deadline}. When you and {opponent} have both checked in, your Lichess board appears.", `button` "Open match room", `footer`, `text`. Translate properly for es/fr/nl.
  - `sendDueEmails`: select guarded candidates with `f.scheduled_at - interval '15 minutes' <= now and now < f.scheduled_at + interval '20 minutes'` (compute bounds in TS from the constants and pass as params — never literal intervals), `limit 100`; per fixture `resetStaleBridge`, `ensureBridgeRow`, `loadSides`; for each side whose `<colour>_emailed_at` is null (or `force`): mint token `{ fixtureId, personId, scheduledAt: f.scheduledAt.toISOString() }`, `roomUrl = origin + routes.sharedFixturePlay(...) + "?t=" + encodeURIComponent(token)`, send to every recipient, and stamp that side (`white_emailed_at` when the side is White per `whiteSideOf`, else `black_emailed_at`) **only if at least one send returned true**. Side without `personId` ⇒ count `failed`, no stamp. Labels via existing `scheduledLabel` (move it from the deleted file) for `opensAt` and `deadline`.
  - `retryMints`: guarded rows `status='pending' and challenge_id is null` inside the open window ⇒ `mintIfReady`.
  - `escalateAtDeadline`: select guarded fixtures (LEFT JOIN bridge, so rows without a bridge are included) with `scheduled_at + DEADLINE_AFTER <= now` and bridge null or status in (`pending`,`ready`), limit 100. For each: `resetStaleBridge`; if bridge has a challenge ⇒ `game = await adapter.fetchGame(id).catch(() => undefined)`; if `game` started ⇒ `applyGameSnapshot` and continue; compute check-ins; `reason = deadlineReason({ whiteCheckedIn, blackCheckedIn, lichessStatus: game?.status ?? null })`; if `reason` ⇒ `ensureBridgeRow` then `markNeedsOrganiser(f, reason, ["pending","ready"])`.
  - `runExternalPlaySweep` order: `sendDueEmails` → `retryMints` → `pollExternalPlay` → `escalateAtDeadline`; return all counts keyed by step.
  - Cron route: replace the three calls with `return runExternalPlaySweep({ origin: baseUrl(req) });`.
  - Webhook: parse `{ fixtureId }` (string) else 422 `"fixtureId required"`; `return { result: await pokeFixture(fixtureId) };`.
  - `resolveExternalPlay`: final update `set status='finished', needs_reason=null, finished_at=now() where fixture_id=$1 and status='needs_organiser'` (the table check constraint requires `needs_reason` null when not `needs_organiser`).
  - `resendExternalPlayNotice(auth, fixtureId, origin)` ⇒ guard + org match (404) ⇒ `sendDueEmails({ origin, fixtureId, force: true })`.
- [ ] **Step 6: Run — expect PASS.** Mutants: remove the LEFT JOIN (use inner) → "even with no bridge row" test fails; stamp both sides together → per-player retry test fails.
- [ ] **Step 7: Delete the superseded test files** `external-play-prepare.test.ts`, `external-play-escalate.test.ts`; update `external-play-happy-path.test.ts` to: seed → check in both (token + session) → mint (fake adapter) → `pollExternalPlay` with `fetchGame` returning the raw-parsed mate fixture → assert `getStandings` shows the White entrant's win; keep its "onlinePlay off" test.
- [ ] **Step 8: Commit** — `feat(chess): per-player emails, mint retry and automatic no-show reasons`.

Test-type ledger: unit+DB+regression here; E2E Task 14 (organiser resolves a no-show created by `escalateAtDeadline` via the cron route); smoke Task 15 (cron route with secret).

---

### Task 11: Division settings — crash fix, explicit Off, clock refusal; PR scope drift

**Files:**
- Modify: `apps/web/src/components/v2/division-settings.tsx` (~:405-420 hook order; ~:606-609 save; ~:886-904 select + error)
- Modify: `apps/web/src/server/external-play/online-play.ts` (`assertOnlinePlayValue`)
- Modify: `apps/web/src/server/usecases/divisions.ts` (~:270-280 create, ~:828-836 patch)
- Modify: `apps/web/src/server/usecases/entrants.ts:217-218` (drift — see Step 5)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (`divset.onlinePlay.clockRequired`)
- Test: `apps/web/src/server/external-play/__tests__/online-play.test.ts`, `apps/web/src/server/usecases/__tests__/online-play-enrollment.test.ts`

**Interfaces:**
- Produces: `assertOnlinePlayValue(sportKey: string, value: unknown, clock: unknown): OnlinePlayMode` — throws `HttpError(422, …, "ONLINE_PLAY_CLOCK_REQUIRED")` when mode is `lichess` and `mapBoardgameClockToLichess(clock)` is not ok.

- [ ] **Step 1: Failing unit tests** (empty case first)

```ts
it("off never needs a clock", () => {
  expect(assertOnlinePlayValue("boardgame", "off", undefined)).toBe("off");
});
it("lichess without a clock ⇒ 422 ONLINE_PLAY_CLOCK_REQUIRED", () => {
  expect(() => assertOnlinePlayValue("boardgame", "lichess", undefined)).toThrow(expect.objectContaining({ code: "ONLINE_PLAY_CLOCK_REQUIRED" }));
});
it("lichess with a delay clock ⇒ 422", () => {
  expect(() => assertOnlinePlayValue("boardgame", "lichess", { base: 900, delay: 5 })).toThrow(expect.objectContaining({ code: "ONLINE_PLAY_CLOCK_REQUIRED" }));
});
it("lichess with base (+increment) is accepted", () => {
  expect(assertOnlinePlayValue("boardgame", "lichess", { base: 900, increment: 10 })).toBe("lichess");
});
```

- [ ] **Step 2: Failing DB test** in `online-play-enrollment.test.ts`: `patchDivision(... { config: { clock: { base: 900 }, onlinePlay: "lichess" } })` then `patchDivision(... { config: { clock: { base: 900 }, onlinePlay: "off" } })` ⇒ stored `config.onlinePlay` is absent. (Update the existing test that patches `onlinePlay` without a clock to include `clock: { base: 900 }`.)
- [ ] **Step 3: Run — expect FAIL.**
- [ ] **Step 4: Implement** — validator signature change; both `divisions.ts` call sites pass the merged config's `clock`. In `division-settings.tsx`: move `const [onlinePlay, setOnlinePlay] = useState<"off" | "lichess">(...)` **above** the `if (configSignature !== syncedConfigSignature)` block; in save, always send `override.onlinePlay = onlinePlay` for boardgame (so `"off"` reaches the server and `applyOnlinePlayToConfig` deletes it); render the API error code `ONLINE_PLAY_CLOCK_REQUIRED` as `t("divset.onlinePlay.clockRequired")` next to the select. Add the key in 4 locales; `npm run i18n:check && npm run i18n:gen-keys`.
- [ ] **Step 5: Scope drift.** Run `git diff origin/main -- apps/web/src/server/usecases/divisions.ts apps/web/src/server/usecases/entrants.ts`. For the `createDivision` `config.entrants` copy and the `entrants.ts` `is_captain ?? false` / `roles ?? []` defaults: check `git log origin/main -S "entrants" -- apps/web/src/server/usecases/divisions.ts` for whether main already carries the copy through another path. If the PR's copy is required by the online-play gate, keep it and add a DB regression test creating a **football** division with `config.entrants` proving the stored config equals what main stored before (compare against a division created via `git show origin/main:` behaviour described in the log). Otherwise revert those hunks to main. State which in the commit body.
- [ ] **Step 6: Run unit + DB files — expect PASS.** Keep the PR's existing enrollment block (spec §13 "Unlinked at enrollment ⇒ Block"): `online-play-enrollment.test.ts`'s unlinked-entrant 422 case must still pass unchanged; mutate the enrollment guard once and confirm that case kills it.
- [ ] **Step 7: Commit** — `fix(chess): division settings no longer crash, Off saves, Lichess needs a clock`.

Test-type ledger: unit+DB+regression here; E2E Task 14 (settings page: save a football division, reload, page renders — the TDZ crash's only witness is a browser); smoke Task 15.

---

### Task 12: Match room API, page and client — **owner layout gate first**

**Files:**
- Create: `apps/web/src/app/api/v1/fixtures/[id]/external-play/room/route.ts`
- Delete: `apps/web/src/app/api/v1/fixtures/[id]/external-play/lobby/route.ts`, `apps/web/src/components/public-site/external-play-lobby.tsx`
- Create: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/page.tsx`, `apps/web/src/components/public-site/match-room.tsx`
- Modify: `apps/web/src/server/api-v1/key-scopes.ts` (`NEVER_KEY_ROUTES`: `"GET /fixtures/:id/external-play/room"`, `"POST /fixtures/:id/external-play/room"`; keep resolve/resend classified as today or add them to `NEVER_KEY_ROUTES` if they are not already in `RULES`), `apps/web/src/server/api-v1/openapi.ts` (replace lobby entries), `apps/web/src/server/api-v1/schemas.ts` (`MatchRoomAction = z.object({ action: z.enum(["check_in", "mint"]) }).strict()`, `MatchRoomOut`)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` — delete `externalPlay.lobby.*`; add `externalPlay.room.*` (below)
- Test: `apps/web/src/app/api/v1/fixtures/[id]/external-play/room/__tests__/route.test.ts`, `apps/web/src/components/public-site/__tests__/match-room.test.tsx`

**Interfaces:**
- Consumes: `readMatchRoom`, `checkInToMatchRoom`, `mintIfReady`, `loadOnlinePlayFixture`, `mintExternalPlayLobbyToken`, `externalPlayLobbyTopic`, `getCurrentUser` (`@/lib/auth`).
- Produces: `GET /api/v1/fixtures/{id}/external-play/room?t=<token>` → `MatchRoomView & { realtime: { token: string | null; channel: string } }`; `POST` same path, body `{ action }`, token via `?t=`. Identity: token if `t` present (token wins, spec §12.1), else session, else 401.

- [ ] **Step 1: OWNER GATE — layout options.** Produce two phone-first layouts of the room at 320 and 1280 (static HTML mock or a throwaway story page, screenshots only) covering the states *Opens at*, *Check in*, *Waiting for opponent*, *Opponent checked in*, *Play as White*, *Game in progress*, *Opponent didn't show*, *Window closed*. Suggested pair: **A** single stacked card (status line → two player chips with check-in dots → one full-width primary action) and **B** two-column "you vs opponent" board with the action docked at the bottom on phones. Send both to the owner and **stop until they pick**. Record the pick in the commit body of Step 7.

- [ ] **Step 2: Copy keys** (`ui.json`, all 4 locales, translated): `externalPlay.room.title` "Match room", `opensAt` "Opens at {time}", `checkIn` "Check in", `checkedIn` "You're checked in", `waitingOpponent` "Waiting for {opponent} to check in", `opponentCheckedIn` "{opponent} has checked in", `playWhite` "Play as White on Lichess", `playBlack` "Play as Black on Lichess", `inProgress` "Game in progress", `watch` "Watch on Lichess", `finished` "Finished", `noShow` "{opponent} didn't show — the organiser will confirm", `notStarted` "The game didn't start — the organiser will confirm", `closed` "The check-in window has closed", `mintFailed` "Couldn't create the board yet — retrying", `signIn` "Sign in to open your match room", `expired` "This match link has expired". Run `i18n:check` + `i18n:gen-keys`. (Verbs agreeing with `{opponent}` are fine in en; check the desk `_RULES.md` agreement rule for es/fr/nl and phrase around it.)

- [ ] **Step 3: Failing route test** (mock the usecase module and `@/lib/auth`):

```ts
it("GET with ?t= uses the token identity even when a session exists", async () => { /* expect readMatchRoom called with {kind:'token', token:'abc'} */ });
it("GET without token or session ⇒ 401", async () => { /* getCurrentUser → null */ });
it("POST check_in ⇒ checkInToMatchRoom; POST mint ⇒ mintIfReady on the loaded fixture then readMatchRoom", async () => { /* … */ });
it("response carries a realtime token minted with exp = deadline and channel external-play:{id}", async () => { /* … */ });
it("sets Cache-Control: private, no-store and Referrer-Policy: no-referrer", async () => { /* … */ });
```

- [ ] **Step 4: Failing component test** (`renderToStaticMarkup`, one case per state; anchor attribute probes on `="`):

```ts
it("ready + open: renders ONLY the caller's colour link with rel=noreferrer", () => {
  const html = renderToStaticMarkup(<MatchRoom initial={view({ status: "ready", phase: "open", playUrl: "https://l/ch1?color=black", you: { side: "away", colour: "black", checkedIn: true } })} copy={copy} fixtureId="f1" token="abc" />);
  expect(html).toContain('href="https://l/ch1?color=black"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).not.toContain("color=white");
});
it("before: check-in button disabled and opens-at shown", () => { /* data-testid="match-room-checkin" disabled="" */ });
it("needs_organiser no_show_*: shows the no-show line, no action", () => { /* … */ });
```

- [ ] **Step 5: Run — expect FAIL.**
- [ ] **Step 6: Implement**
  - Route: `v1(async () => { … })` like the deleted lobby route; `const t = new URL(req.url).searchParams.get("t")`; identity; view; `realtime.token` = `mintExternalPlayLobbyToken(id, identity.kind === "token" ? "room:" + id : "user:" + userId, new Date(view.deadline))` inside try/catch → null; return `NextResponse.json(body, { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } })` (read `server/api-v1/http.ts` `v1` to see how to set headers; if `v1` cannot, wrap its response).
  - Page `play/page.tsx`:
    ```tsx
    export const dynamic = "force-dynamic";
    export const metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };
    ```
    Load `t` from `searchParams`; `getCurrentUser()`; if no `t` and no user ⇒ `redirect("/login?next=" + encodeURIComponent(roomPath))`; call `readMatchRoom` in try/catch: `HttpError` 404 with a session ⇒ `redirect(routes.sharedFixture(...))`; 401 token expired ⇒ render the `expired` card with a link to the public match centre. Render `<MatchRoom initial={view} copy={…} fixtureId token={t} />` using the owner-picked layout, `min-w-0` on every flex ancestor of a truncated name, ≥44px primary action.
  - Client `match-room.tsx` (`"use client"`): holds `view`; subscribes to the private channel (reuse the supabase subscribe block from the deleted `external-play-lobby.tsx` L74-99, with `setAuth(realtime.token)`) and re-fetches `GET …/room?t=` with `cache: "no-store"` on every broadcast and every `ROOM_REREAD_MS`; Check in ⇒ `POST {action:"check_in"}`; when `view.canMint && view.status === "pending"` and the last POST did not already mint ⇒ `POST {action:"mint"}` at most once per `ROOM_REREAD_MS`; Play link `<a href={view.playUrl} rel="noreferrer" target="_blank" data-testid="match-room-play">`.
  - `key-scopes.ts`, `openapi.ts`, `schemas.ts` as listed; `npm run openapi:gen`.
- [ ] **Step 7: Run route + component + `key-scopes.test.ts` + `lib/__tests__/public-isr-contract.test.ts` — expect PASS** (the ISR contract lists files explicitly; confirm it does not now cover `play/page.tsx`, and add an assertion in that test file that `play/page.tsx` exports `dynamic = "force-dynamic"` and no `revalidate`).
- [ ] **Step 8: Screenshots** at 1280/768/320 of every state (seed via Task 14 helpers against a local prod build); confirm no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`) and that images differ per state. Attach to the PR description, not the repo.
- [ ] **Step 9: Commit** — `feat(chess): private match room with check-in and own-colour Play link`.

Test-type ledger: unit+route+component here; E2E Task 14; smoke Task 15 (`cache-control` on the built page); regression = ISR contract assertion.

---

### Task 13: Public match centre status, organiser panel, "Needs result" reason, Lichess link on /me and registration

**Files:**
- Modify: `apps/web/src/server/external-play/public-view.ts` (delete `playUrlForStatus`; shape `{ status; challengeId: string | null }`), `apps/web/src/server/usecases/external-play-read.ts`, `apps/web/src/server/public-site/data.ts` (~:776-777, :858)
- Modify: `apps/web/src/components/public-site/external-play-cta.tsx`, public fixture `page.tsx` (remove lobby mount ~:344-362; CTA ~:364-381)
- Create: `apps/web/src/components/v2/external-play-panel.tsx`; Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx` (mount between ~:149 and `<FixtureConsole` ~:157, gated `canEdit`)
- Create in organiser.ts: `readOrganiserExternalPlay(auth: AuthCtx, fixtureId: string): Promise<OrganiserExternalPlay | null>`
- Delete: `apps/web/src/components/v2/external-play-needs-result-queue.tsx`; remove its import/query/mount from `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` (~:50-51, :446-450, :666-678)
- Modify: `apps/web/src/lib/division-phase.ts:392-401` (`isResultMissing`), `apps/web/src/server/usecases/competition-desk.ts` (PhaseFixture input), `apps/web/src/lib/run-sheet-groups.ts:32` + the `listDivisionFixtures` select, `apps/web/src/components/v2/desk/run-sheet.tsx:205`, `apps/web/src/components/v2/desk/run-sheet-row.tsx` (reason chip)
- Modify: `apps/web/src/app/me/page.tsx` (mount `LichessLinkCard` with `next=/me`), `apps/web/src/components/lichess-link-card.tsx` (accept `next` prop), `apps/web/src/components/public-site/register/register-stepper.tsx:506-515` (`<Link href={"/api/auth/lichess?next=" + encodeURIComponent(currentPath)} prefetch={false}>`)
- Modify dictionaries (4 locales): `externalPlay.public.{live,watch,openRoom,finished}`, `externalPlay.reason.{no_show_white,no_show_black,no_show_both,not_started,aborted,mismatch,provider_error}`, `externalPlay.panel.{title,checkedInAt,notCheckedIn,resend,resendDone}`; delete `externalPlay.queue.*`, old `externalPlay.reason.*`, `externalPlay.{waitingForLink,soon,needsOrganiser}` if unused (grep first)
- Test: `apps/web/src/lib/__tests__/division-phase.test.ts` (add), `apps/web/src/components/public-site/__tests__/external-play-cta.test.tsx` (rewrite), `apps/web/src/components/v2/__tests__/external-play-panel.test.tsx` (create), `apps/web/src/server/usecases/__tests__/external-play-organiser.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export function isResultMissing(f: { status: string; scheduledAt: string | null; matchMinutes: number; externalPlayNeedsOrganiser?: boolean }, nowMs: number): boolean;
  export type OrganiserExternalPlay = { status: ExternalPlayStatus; needsReason: NeedsReason | null; whiteSide: Side | null;
    home: { name: string; checkedInAt: string | null }; away: { name: string; checkedInAt: string | null };
    suggested: ResolveExternalPlayKind | null; lastError: string | null; watchUrl: string | null };
  // RunSheetFixture gains: external_play_needs_reason: NeedsReason | null
  ```
  `suggested`: `no_show_black` ⇒ forfeit against Black's side (`whiteSide === "home" ? "away_forfeit" : "home_forfeit"`), `no_show_white` ⇒ the mirror, `no_show_both` ⇒ `no_result`, others ⇒ null.

- [ ] **Step 1: Read `docs/superpowers/specs/2026-09-02-competition-desk-prompts/_RULES.md`.**
- [ ] **Step 2: Failing predicate tests** (empty/default case first; a differential where the flag changes the answer):

```ts
describe("isResultMissing — external play (owner decision A)", () => {
  const base = { status: "scheduled", scheduledAt: "2026-10-01T19:00:00.000Z", matchMinutes: 90 };
  const now = Date.parse("2026-10-01T19:25:00.000Z"); // past T+20, before T+90
  it("default (flag absent) is unchanged: not yet missing before matchMinutes", () => {
    expect(isResultMissing(base, now)).toBe(false);
  });
  it("needs_organiser makes it missing immediately — the differential case", () => {
    expect(isResultMissing({ ...base, externalPlayNeedsOrganiser: true }, now)).toBe(true);
  });
  it("never for a non-scheduled fixture, flag or not", () => {
    expect(isResultMissing({ ...base, status: "in_play", externalPlayNeedsOrganiser: true }, now)).toBe(false);
  });
});
```

Plus one `resolveAttention` test: a division with one online `needs_organiser` fixture at T+25 yields `{ kind: "result_missing", count: 1 }` (use the file's existing PhaseInput builders).

- [ ] **Step 3: Failing organiser usecase tests** — `readOrganiserExternalPlay` returns both check-in times, the §9 reason and `suggested` for each `no_show_*` row (colour-flipped fixture included); returns null for an OTB fixture; 404 for another org's auth.
- [ ] **Step 4: Failing component tests** — public CTA: `live` renders `href="https://lichess.org/ch1"` and `data-testid="external-play-open-room"`; **no** `color=white`/`color=black` in any state; panel: renders both `checkedInAt` times, the reason text, and the pre-selected resolve button `data-suggested="true"` on the suggested kind only.
- [ ] **Step 5: Run — expect FAIL.**
- [ ] **Step 6: Implement** — predicate:

```ts
export function isResultMissing(
  f: { status: string; scheduledAt: string | null; matchMinutes: number; externalPlayNeedsOrganiser?: boolean },
  nowMs: number,
): boolean {
  if (f.status !== "scheduled") return false;
  // Owner decision A (chess Lichess spec §12): a queued online fixture owes its
  // result now — its no-show is already known — not after matchMinutes.
  if (f.externalPlayNeedsOrganiser === true) return true;
  return f.scheduledAt !== null && Date.parse(f.scheduledAt) + f.matchMinutes * 60_000 < nowMs;
}
```

Wire the flag: `competition-desk.ts` fixture query LEFT JOINs `fixture_external_play` and sets `externalPlayNeedsOrganiser: ep.status = 'needs_organiser'` on `PhaseFixture`; `listDivisionFixtures` selects `ep.needs_reason as external_play_needs_reason`; `run-sheet.tsx` passes `externalPlayNeedsOrganiser: f.external_play_needs_reason !== null`; `run-sheet-row.tsx` renders `<span data-testid="external-play-reason" …>{t("externalPlay.reason." + reason)}</span>` when non-null (row stays one line on phones; chip wraps under the names with `max-md:basis-full`). Panel + organiser read + public CTA + `/me` card + register link as listed.

- [ ] **Step 7: Run all touched test files incl. `desk-renderings-agree.test.tsx`, `desk-ssr.test.tsx`, `division-phase.test.ts`, `fixture-row-action.test.ts` — expect PASS.**
- [ ] **Step 8: Screenshots** 1280/768/320: public match centre (live), organiser fixture page panel (no_show_black), run sheet "Needs result" with the reason chip (a 43-character entrant name), `/me` link card. No horizontal scroll.
- [ ] **Step 9: Commit** — `feat(chess): organiser sees no-shows under Needs result with the reason`.

Test-type ledger: unit+component+DB here; E2E Task 14; smoke Task 15; regression = desk suites unchanged.

---

### Task 14: E2E walkthrough with a local Lichess stub

**Files:**
- Create: `apps/web/e2e/lichess-stub.ts`
- Modify (rewrite): `apps/web/e2e/walkthrough/chess-external-play.spec.ts`
- Modify: `apps/web/e2e/helpers.ts` (`seedFixtureExternalPlaySql` → delete; add `seedOnlineChessFixture`, `linkLichessBySql(userId, id, username)`, `mintMatchRoomPathBySql`)
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` (`WALKTHROUGH_SPECS`: add `"chess-external-play.spec.ts"` under a `// Chess Lichess external play (2026-09-16)` comment, at the end of the list — wave order, not alphabetical)
- Modify: `.github/workflows/e2e.yml` — add `LICHESS_BASE_URL: http://localhost:8799` to the env of the job(s) that build/start the server for the `walkthrough` project (read the file; add it where `E2E_PROD_TARGET`/server env is set)

**Interfaces:**
- Produces: `startLichessStub(port = 8799): Promise<{ close(): Promise<void>; setGame(id: string, body: object | null): void; challenges: { users: string; expiresAt: string }[] }>` — `POST /api/challenge/open` returns `{ id, urlWhite, urlBlack }` with `id = "e2e" + n`; `GET /game/export/:id` returns the stored body or 404.

- [ ] **Step 1: Write the stub** (node `http`, no deps):

```ts
import { createServer } from "node:http";

export async function startLichessStub(port = 8799) {
  const games = new Map<string, object | null>();
  const challenges: { users: string; expiresAt: string }[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (req.method === "POST" && url.pathname === "/api/challenge/open") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = new URLSearchParams(raw);
        challenges.push({ users: body.get("users") ?? "", expiresAt: body.get("expiresAt") ?? "" });
        const id = `e2e${++n}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, url: `https://lichess.org/${id}`, urlWhite: `https://lichess.org/${id}?color=white`, urlBlack: `https://lichess.org/${id}?color=black` }));
      });
      return;
    }
    const m = url.pathname.match(/^\/game\/export\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const g = games.get(m[1]);
      if (!g) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(g));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(port, r));
  return {
    challenges,
    setGame: (id: string, body: object | null) => games.set(id, body),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 2: Write the spec** (`describe.configure({ mode: "serial" })`; two contexts via `browser.newContext({ storageState: { cookies: [], origins: [] } })`; server must run with `LICHESS_BASE_URL=http://localhost:8799` — the first test asserts the stub received a challenge, so a server without the env fails loudly rather than skipping):

  1. **"two players check in and each gets only their own colour"** — seed fixture scheduled `now + 5 min` (window open), both linked; White opens the room via `mintMatchRoomPathBySql` (token, signed out); asserts check-in button visible, clicks it, sees `You're checked in`; Black signs in with `loginUi(page, email, roomPath)` (session identity), sees `{White} has checked in` within 15 s **without reload** (realtime or 15 s re-read), clicks Check in; both pages show `match-room-play` within 15 s; White's `href` ends `color=white`, Black's `color=black`; `stub.challenges` length 1 with `users = "<whiteUsername>,<blackUsername>"`; the public match centre (fresh anonymous context) has **no** `a[href*="color="]` and shows `external-play-open-room`.
  2. **"room response is private and a non-player is redirected"** — `request.get(roomPath)` headers `cache-control` contains `private` and `no-store`; a third signed-in user opening the room lands on the public match centre URL (`waitForURL`).
  3. **"game start and finish flow from Lichess to standings"** — `stub.setGame("e2e1", started)`; POST cron with `x-cron-secret`; both rooms show `Game in progress`; `stub.setGame("e2e1", mate white)`; cron; public match centre shows the result; division standings page shows White's win.
  4. **"no-show lands under Needs result with the reason and the organiser resolves it"** — fixture scheduled `now − 25 min` via `setFixtureScheduledAtSql`, only White checked in (`stampFixtureCheckIn` via SQL helper); POST cron; organiser opens division `?tab=fixtures`, applies "Needs result", row has `[data-testid="external-play-reason"]` with the no-show text; opens the fixture page, the panel shows White's check-in time and the suggested forfeit button, clicks it; fixture state is decided.
  5. **"before T−10 check-in is disabled"** — fixture `now + 30 min`; `match-room-checkin` is disabled and shows `Opens at`.
  6. **Regression "OTB chess: no room link, pad console mounts"** — carried from the PR test 1.
  7. **Regression "division settings survive a save and reload for a non-chess sport"** — football division settings: change name, save, `page.reload()`, settings form visible, no error boundary (`page.on("pageerror")` collects nothing).

  Run every width project that includes the walkthrough spec once locally; screenshots are not asserted here.

- [ ] **Step 3: Run the WHOLE spec file (no `-g`)** against a local prod build started with `LICHESS_BASE_URL=http://localhost:8799` and `CRON_SECRET` set (`seazn-local-env` skill, prod server recipe; `E2E_PROD_TARGET`, `BASE=http://localhost:<port>`, never 127.0.0.1): `cd <worktree>/apps/web && npx playwright test e2e/walkthrough/chess-external-play.spec.ts --project=walkthrough`. Expect 7 passed. Serial mode: treat a red count as a floor; rerun after each fix until a full pass.
- [ ] **Step 4: Mutation witness** — comment out the `and status = 'pending'` claim predicate in `mintIfReady`, rebuild, rerun test 1: it must still pass (single user flow) — this proves the concurrency guard is covered by the DB test in Task 8, not here; then restore and rebuild. Comment out the reason chip render: test 4 must fail; restore and rebuild. **Kill the server and rebuild after restoring** (a stale build serves the mutant).
- [ ] **Step 5: Run `e2e-ci-wiring.test.ts` — expect PASS.**
- [ ] **Step 6: Commit** — `test(chess): two-player match room walkthrough against a Lichess stub`.

---

### Task 15: Smoke

**Files:**
- Modify: `scripts/smoke.ts` (`externalPlayOtBSmoke` ~:18242-18317 → rename `externalPlaySmoke`, call site ~:1130)

- [ ] **Step 1: Extend** — keep the three existing checks (cron 401/503, OTB division has no `onlinePlay`, unlinked OTB entrant 201). Add:
  - `GET /api/auth/lichess` (signed in via the smoke's existing session helper) ⇒ 307/302 to `https://lichess.org/oauth?…code_challenge_method=S256…` and no `client_secret` in the location.
  - A seeded online fixture (reuse the smoke's DB seeding style; boardgame division with `clock.base = 900`, `onlinePlay = "lichess"`, started) ⇒ `GET /shared/<org>/<comp>/<div>/fixtures/<id>/play?t=<token>` ⇒ 200 and `cache-control` contains `no-store`.
  - `PATCH` the division with `onlinePlay: "lichess"` and no clock ⇒ 422 `ONLINE_PLAY_CLOCK_REQUIRED`.
  - Signed cron with `CRON_SECRET` ⇒ 200 JSON containing the four sweep keys.
  - Recorded-payload sweep (spec §14): the smoke server runs with `LICHESS_BASE_URL=http://localhost:8799`; the smoke starts `startLichessStub` (import from `apps/web/e2e/lichess-stub.ts`), seeds an online fixture whose bridge is `ready` with `challenge_id = "smoke1"` and stored Lichess ids matching `__fixtures__/lichess/export-mate-white.json` (rewrite the file's `id` to `smoke1` in memory), `setGame("smoke1", thatPayload)`, runs the signed cron, and asserts the fixture now has a `boardgame.result` event whose winner is the White entrant. If `LICHESS_BASE_URL` is unset the smoke FAILS with "LICHESS_BASE_URL must point at the stub" — never skips. Add `LICHESS_BASE_URL: http://localhost:8799` to the smoke job env in `.github/workflows/` (grep `test:smoke` to find the job).
- [ ] **Step 2: Run** `npm run test:smoke` against the local prod server; paste the external-play section output into the commit body.
- [ ] **Step 3: Commit** — `test(chess): smoke the match room, PKCE start and clock refusal`.

---

### Task 16: Full gate, review loop, product walkthrough

- [ ] **Step 1: Delete dead code and keys** — `grep -arn "CHALLENGE_TTL_MS\|markExternalPlayReady\|readExternalPlayLobby\|playUrlForStatus\|listNeedsOrganiserExternalPlay\|externalPlay.lobby\|externalPlay.queue\|white_ready_at\|external_challenge_id\|LICHESS_CLIENT_SECRET" apps scripts db docs/superpowers/specs` must return nothing outside this plan/spec.
  (`getLichessAccessToken` was removed from this list on 2026-10-09: the
  2026-10-09 in-page-board design REVERSES the identity-only decision and
  reinstates the function — see that plan's Task 2. Do not re-add it.)
- [ ] **Step 2: Gates** (paste raw numbers):
  - `rtk proxy npm run typecheck` ⇒ exit 0.
  - `rtk proxy npm run lint` ⇒ `0 errors` (warnings not increased vs `origin/main`: run the same on a detached main worktree and compare).
  - Full `apps/web` vitest with JSON reporter on a fresh DB ⇒ `numFailedTests: 0`; confirm the total is ≥ main's total + new tests and that `.testResults[].name` are under this worktree.
  - `npm run i18n:check`, `npm run i18n:gen-keys` ⇒ no diff; `npm run openapi:gen` ⇒ `git diff --exit-code openapi/`.
  - Whole walkthrough spec (Task 14) + existing QR check-in e2e + `mobile.spec.ts` run in full (no `-g`) on the prod build.
  - `npm run test:smoke`.
- [ ] **Step 3: Review** — dispatch the `reviewer` agent on `git diff origin/main...HEAD` with the spec path; fix findings; repeat until no Critical/Important remain. Then run a second, adversarial review focused on: GET-never-writes, conditional status writes, HTTP-outside-transaction, token/colour leakage.
- [ ] **Step 4: Use the product** — on the local prod build: link a real Lichess test account through the OAuth flow (real lichess.org, PKCE), create an online division, pair two accounts, open two browsers, check in, click Play on both, play a quick game on lichess.org, confirm Seazn standings. Write down what you saw per screen (spec §15/§16 success criteria), with screenshots at 320/768/1280.
- [ ] **Step 5: Update PR #788 description** — summary of the redesign, owner decisions, test plan with raw counts; note CI is blocked by GitHub billing so the pasted local gates are the evidence. Ask the owner before pushing.
