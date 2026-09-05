# Stream Overlay W1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the transparent per-fixture overlay page, its pure projection, the stream-link write path and the organiser panel, so a club can put seazn's live score inside its own OBS broadcast for every sport the engine scores.

**Architecture:** One client transport (`useLiveFixture`, lifted out of `LiveScore`) feeds one pure projection (`overlayModel`) that eleven sports share; two presentational skins (`OverlayBar`, `OverlayBug`) render it at a native 1920×1080 canvas scaled with `transform: scale(min(vw/1920, vh/1080))`, themed by `sportThemeStyle(sportKey)` so the overlay inherits the pad's own palettes. A new `fixtures.stream_url` column, appended to `public_fixtures_v`, is written by `PUT /api/v1/fixtures/{id}/stream` and read by the public match page's "Watch live" link; both the overlay route and the organiser panel are gated server-side on the `streaming.overlay` entitlement, which no plan grants.

**Tech Stack:** Next.js (App Router, RSC + client islands), React 19.2.4, TypeScript, Tailwind v4 + `app/globals.css` custom properties, Zod 4, postgres.js + Flyway migrations, vitest (`environment: "node"`), Playwright, `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-05-stream-overlay-design.md`
**Wave prompt (rulings win over this plan; task ORDER below wins):** `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W1-step-one.md`
**Standing rules R1–R17:** `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_RULES.md`
**Binding design values:** `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md`
**Pinned symbols:** `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`
**Sibling wave (keep names/types compatible):** `docs/superpowers/plans/2026-09-05-stream-overlay-w2-moments.md`

## Global Constraints

- `pnpm`, never `npm install` — `npm install` fails in this repo.
- Every user-facing string lands in all four dictionaries (`apps/web/src/dictionaries/{en,fr,es,nl}/`), then `pnpm i18n:gen-keys` (`package.json:39`); `apps/web/src/lib/i18n-keys.ts` is GENERATED — never hand-edited (R14).
- Migration numbering is flat across `db/migration/**` (`db/flyway.toml:6`). Highest on this branch today is `V391`, so this plan uses **V392** (`stream_url`) and **V393** (entitlement rows); take the next free numbers at rebase and AMEND the unmerged files rather than correcting forward (R10). Record the landed numbers in `_INDEX.md`.
- OpenAPI: the new route goes into `ROUTES` (`apps/web/src/server/api-v1/openapi.ts:57`, neighbour `PATCH /fixtures/{id}` at `:142`) in the same change, then `npm run openapi:gen` (`package.json:45`) and both generated files are committed. CI's drift check is a `ci.yml` step (`:94-98`), not a hook (R7).
- Entitlement key `streaming.overlay` is granted by **no plan**, and is **NOT added to `ENTITLEMENT_DOMAINS`** (`apps/web/src/lib/entitlement-domains.ts:5`) — that omission is the mechanism that keeps it off `/pricing`, because `buildPricingSections` (`apps/web/src/lib/pricing-matrix.ts:191,199`) renders only listed keys (R1).
- `create or replace view public_fixtures_v` may only APPEND, so `stream_url` is the LAST column of a FULL redefinition copied from `db/migration/deltas/V369__public_fixtures_round_role.sql:18` (R6).
- Judge vitest green ONLY from `--reporter=json --outputFile=<file>` — read `numPassedTests`/`numTotalTests`/`numFailedTests`, and confirm `.testResults[].name` resolves under `/Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay`. `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to COLLECT and swallows exit codes.
- **Baseline:** on the fresh `ovl` DB the full `apps/web` suite is **13962 passing / 14041 total, 5 red** — 3 in `schedule-build-honours-locks.test.ts` (placement service not running; environmental) and 2 in `pass-scoping-guard.test.ts` (unclassified). Neither touches a W1 file. Every task gate compares against **this baseline**, not against zero.
- DB-backed tests need `DATABASE_URL`. Stand the env up from THIS worktree: `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl`; `eval` is refused by the session guard, so read `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label ovl` as a plain call and set the printed values inline on the command (`DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/seazn_ovl DATABASE_SSL=disable`). `db:apply` alone is NOT a fresh schema — `sync:sports` must have run.
- Playwright runs from `apps/web` with `PLAYWRIGHT_BASE` and `E2E_PROD_TARGET` set (`seazn-env.sh up --label ovl --server`); `seazn-env.sh rebuild --label ovl` after every code change — `up --server` again is a no-op that serves the OLD bundle; probe `_buildManifest.js`, not `/api/health`, and re-read the port.
- Shell cwd resets between calls: prefix every command with `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay &&` in the SAME call. Never `git stash` in this worktree. Run git as SEPARATE plain `/usr/bin/git` calls. Use `grep -a`.
- One DOM branched with `max-md:*` / `md:hidden`, phone first, identical control SET at 320 and 1280, no horizontal scroll at 320/360/375/390/430/768/834 (R15). `/\bmd:hidden\b/` also matches inside `max-md:hidden` — anchor assertions on `\s...hidden"`.
- Motion is `transform`/`opacity` only, exactly three motions in W1, nothing animates on mount, `prefers-reduced-motion` disables tick and breath (R13, `_THEMES.md` §6).
- Every subagent dispatch passes `model: opus` explicitly (`_RULES.md` §Agents, owner ruling 2026-09-05).
- JSON reports go to `/tmp/ovl-w1/` — `mkdir -p /tmp/ovl-w1` once. A second concurrent session must vary the directory (a bare `/tmp` path collides across sessions).
- Do NOT touch: `components/v2/scorepad/**` (read `sport-theme.ts`, import from it, never edit), the engine, `components/v2/fixture-console.tsx`, `ENTITLEMENT_DOMAINS`, other keys' matrix rows, any pricing surface, `LiveScore`'s render and `Props`, `proxy.ts` CSP, `app/embed/**`, `app/slideshow/**`, `.github/workflows/e2e.yml`, and anything in `stages-panel.tsx` beyond one import plus one conditional line (R11).

## File Structure

| File | Create / Modify | Responsibility |
|---|---|---|
| `apps/web/src/components/public-site/use-live-fixture.ts` | Create | The ONE public live transport: subscribe-or-poll, lifted verbatim from `live-score.tsx:60-117`. |
| `apps/web/src/components/public-site/__tests__/use-live-fixture.test.tsx` | Create | Hook branches via `renderIsland` + captured `setInterval`. |
| `apps/web/src/components/public-site/live-score.tsx` | Modify (`:8`, `:29`, `:59-117`, `:148`) | Repointed to the hook; render and `Props` unchanged. |
| `apps/web/src/lib/public-site.ts` | Modify (append after `:378`) | `battingEntrantId`, `chaseNeed` — the two summary readers the overlay needs and nothing else owns. |
| `apps/web/src/lib/__tests__/public-site-overlay-derive.test.ts` | Create | Unit cover for the two new readers. |
| `apps/web/src/lib/overlay-model.ts` | Create | Pure projection `overlayModel(input): OverlayModel`; type-only `OverlayMoment` slot for W2. |
| `apps/web/src/lib/__tests__/overlay-model.test.ts` | Create | Eleven sports folded through real modules; empty / decided / led truth table. |
| `apps/web/src/lib/stream-url.ts` | Create | `streamUrlSchema` — https + exact-hostname allowlist, `""` → `null`. |
| `apps/web/src/lib/__tests__/stream-url.test.ts` | Create | Ten accepted hosts; the six rejections named in the prompt. |
| `db/migration/deltas/V392__fixture_stream_url.sql` | Create | Column + check + full `public_fixtures_v` redefinition with `stream_url` last. |
| `db/migration/deltas/V393__streaming_overlay_entitlement.sql` | Create | `streaming.overlay` `false` on every plan key. |
| `apps/web/src/server/public-site/data.ts` | Modify (`:206`, `:711-716`, new export after `:747`) | `PublicFixture.stream_url`; the fixture SELECT gains it; `publicFixtureSlugs(fixtureId)`. |
| `apps/web/src/server/usecases/public.ts` | Modify (`:263-297`) | `publicFixture()`'s `Pick<>` and SELECT gain `stream_url`. |
| `apps/web/src/server/api-v1/schemas.ts` | Modify (after `:989`) | `PutFixtureStream`, `FixtureStream`. |
| `apps/web/src/server/usecases/fixtures.ts` | Modify (after `:176`) | `setFixtureStreamUrl(auth, id, streamUrl)`. |
| `apps/web/src/server/usecases/__tests__/fixture-stream-url.test.ts` | Create | DB-backed usecase test (`_rig.ts`, `HAS_DB` skip idiom). |
| `apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts` | Create | `PUT` — `parseBody` + `requireResourceAuth(req, "fixture", id, "write")`. |
| `apps/web/src/server/api-v1/openapi.ts` | Modify (after `:142`) | One `ROUTES` entry. |
| `apps/web/src/server/api-v1/key-scopes.ts` | Modify (after `:175`) | One `KEY_ROUTE_RULES` entry (total-classification test demands it). |
| `apps/web/openapi/v1.json`, `apps/web/openapi/v1.public.json` | Modify (generated) | `npm run openapi:gen` output. |
| `apps/web/src/lib/__tests__/entitlement-streaming-overlay.test.ts` | Create | `ENTITLEMENT_DOMAINS` does NOT list the key; DB-backed override flip. |
| `apps/web/src/app/overlay/fixtures/[fixtureId]/layout.tsx` | Create | Nested `<div>` layout: transparent `html, body`, Barlow mount, cookie banner suppressed. |
| `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx` | Create | Server: slug resolve → `getPublicFixture` → `hasFeature` → `notFound()`; `robots: { index: false }`. |
| `apps/web/src/components/overlay/overlay-stage.tsx` | Create | Client island: hook + model + scale + the three motions + `ovl-moment-slot`. |
| `apps/web/src/components/overlay/overlay-bar.tsx` | Create | Theme A per `_THEMES.md` §3. |
| `apps/web/src/components/overlay/overlay-bug.tsx` | Create | Theme B per `_THEMES.md` §4. |
| `apps/web/src/app/globals.css` | Modify (append after `:1022`) | `.ovl-*` rules + the three keyframes + the reduced-motion block. |
| `apps/web/src/components/cookie-consent.tsx` | Modify (`:84`) | One `data-testid="cookie-consent"` attribute so the overlay layout can suppress it. |
| `apps/web/src/components/v2/fixture-stream-panel.tsx` | Create | The organiser panel per `_THEMES.md` §8. |
| `apps/web/src/components/v2/stages-panel.tsx` | Modify (`:144-146`, `:399`, `:1072-1085`, `:1115-1128`, `:1167-1180`, `:1579-1604`, `:1747`) | Two new props threaded; one import + one conditional line in `FixtureLine`. |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` | Modify (`:124-138`, `:596`) | `hasFeature(auth.orgId, "streaming.overlay")` into the `Promise.all`; both props passed. |
| `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` | Modify (above `:175`) | The "Watch live" / "Replay" anchor. |
| `apps/web/src/dictionaries/{en,fr,es,nl}/public.json` | Modify | `overlay.*` keys. |
| `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` | Modify | `stream.*` keys. |
| `apps/web/src/lib/i18n-keys.ts` | Modify (generated) | `pnpm i18n:gen-keys` output. |
| `apps/web/src/lib/__tests__/overlay-dict-coverage.test.ts` | Create | Every `overlay.*`/`stream.*` key referenced in source exists in all four locales. |
| `apps/web/e2e/walkthrough/stream-overlay.spec.ts` | Create | The wave's e2e (project `walkthrough` by path regex, R9). |
| `apps/web/e2e/walkthrough/stream-overlay-capture.spec.ts` | Create | Visual gate, gated on `OVL_DIR`. |
| `scripts/smoke.ts` | Modify (after `:790`) | `streamOverlaySuite` — overlay 200/404 and the `stream_url` seam end to end. |
| `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md` | Modify | Status rows, landed migration numbers, findings. |

---

### Task 1: Extract the live transport into `useLiveFixture` and repoint `LiveScore`

**Files:**
- Create: `apps/web/src/components/public-site/use-live-fixture.ts`
- Create (Test): `apps/web/src/components/public-site/__tests__/use-live-fixture.test.tsx`
- Modify: `apps/web/src/components/public-site/live-score.tsx` — imports `:8-27`, `POLL_MS` `:29`, body `:59-117`, `subscribed` read `:148`
- Unchanged regression witness: `apps/web/src/components/public-site/__tests__/live-score.test.tsx`, `apps/web/src/components/public-site/__tests__/live-score-data.test.ts`

**Interfaces:**
- Consumes: `fetchLiveFixture(fixtureId: string): Promise<LiveFixtureData>`, `fetchPublicRealtimeToken(fixtureId: string): Promise<PublicRealtimeToken>`, `type LiveFixtureData` — all from `./live-score-data`; `supabaseBrowser()` from `@/lib/supabase-browser` (dynamic import).
- Produces:
  - `export const POLL_MS: number` (15_000)
  - `export const DEBOUNCE_MS: number` (250)
  - `export function isLiveStatus(status: string): boolean`
  - `export interface LiveFixture { data: LiveFixtureData; live: boolean; subscribed: boolean; refresh: () => Promise<void> }`
  - `export function useLiveFixture(fixtureId: string, initial: LiveFixtureData, realtime: boolean): LiveFixture`

> **Conflict with the wave prompt, recorded:** scope 1 writes the return type as bare `LiveFixtureData`. `LiveScore` renders `subscribed` at `live-score.tsx:148` (`Live{subscribed ? " · realtime" : ""}`), and the same scope requires its render to stay untouched — a bare `LiveFixtureData` return cannot satisfy both. The object return above is the minimum that does. `live` is returned because the overlay stage needs it for the live-dot breath (`_THEMES.md` §6).

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/components/public-site/__tests__/use-live-fixture.test.tsx`:

```tsx
// The public live transport, lifted out of LiveScore (W1 scope 1). vitest runs
// `environment: "node"` here (vitest.config.ts:129), so the hook is driven
// through `renderIsland` — React's dispatcher without a DOM — and the poll is
// witnessed by CAPTURING setInterval rather than faking a clock, the same
// idiom live-score.test.tsx:37-40 already uses.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import {
  isLiveStatus,
  POLL_MS,
  useLiveFixture,
  type LiveFixture,
} from "../use-live-fixture";
import type { LiveFixtureData } from "../live-score-data";

function stubFetch(payload: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status, json: async () => payload })),
  );
}

/** Captures setInterval's callback and the delay it was armed with. */
function stubInterval(): { fire: () => Promise<void>; delay: () => number | null; armed: () => number } {
  let callback: (() => void | Promise<void>) | null = null;
  let delay: number | null = null;
  let armed = 0;
  vi.stubGlobal(
    "setInterval",
    ((fn: () => void, ms?: number) => {
      callback = fn;
      delay = ms ?? null;
      armed += 1;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
  );
  vi.stubGlobal("clearInterval", (() => {}) as typeof clearInterval);
  return {
    fire: async () => {
      if (!callback) throw new Error("setInterval was never armed — the hook did not start polling");
      await callback();
    },
    delay: () => delay,
    armed: () => armed,
  };
}

const IN_PLAY: LiveFixtureData = { status: "in_play", summary: { headline: "1 — 0" }, outcome: null };
const DECIDED: LiveFixtureData = {
  status: "decided",
  summary: { headline: "2 — 0" },
  outcome: { kind: "win", winner: "e-home" },
};

/** Probe island: the harness renders COMPONENTS, so the hook is called inside
 *  one and its return captured for assertions. */
function harness(initial: LiveFixtureData, realtime: boolean) {
  let latest: LiveFixture | null = null;
  const island = renderIsland(
    (props: { fixtureId: string; initial: LiveFixtureData; realtime: boolean }) => {
      latest = useLiveFixture(props.fixtureId, props.initial, props.realtime);
      return null;
    },
    { fixtureId: "fx-1", initial, realtime },
  );
  return { island, read: (): LiveFixture => latest as unknown as LiveFixture };
}

afterEach(() => vi.unstubAllGlobals());

describe("isLiveStatus", () => {
  it("is true for the two statuses that can still move, false for the rest", () => {
    expect(isLiveStatus("in_play")).toBe(true);
    expect(isLiveStatus("scheduled")).toBe(true);
    expect(isLiveStatus("decided")).toBe(false);
    expect(isLiveStatus("finalized")).toBe(false);
    expect(isLiveStatus("cancelled")).toBe(false);
  });
});

describe("useLiveFixture", () => {
  it("arms exactly one poll at POLL_MS while in play with realtime off, and a tick replaces the data", async () => {
    const timer = stubInterval();
    stubFetch({ ok: true, data: { status: "in_play", summary: { headline: "2 — 0" }, outcome: null } });
    const { read } = harness(IN_PLAY, false);
    expect(timer.armed(), "one interval, not one per render").toBe(1);
    expect(timer.delay()).toBe(POLL_MS);
    expect(read().data.summary?.headline).toBe("1 — 0");
    await timer.fire();
    expect(read().data.summary?.headline, "the poll's payload replaced the score").toBe("2 — 0");
    expect(read().live).toBe(true);
  });

  it("never arms a poll for a fixture that is already decided at mount", () => {
    const timer = stubInterval();
    stubFetch({ ok: true, data: DECIDED });
    const { read } = harness(DECIDED, false);
    expect(timer.armed(), "a decided fixture must not poll").toBe(0);
    expect(read().live).toBe(false);
    expect(read().subscribed).toBe(false);
  });

  it("falls back to the poll when the realtime token is refused (403)", () => {
    const timer = stubInterval();
    stubFetch({ ok: false, error: "payment required" }, false, 403);
    const { read } = harness(IN_PLAY, true);
    expect(timer.armed(), "a refused token leaves subscribed false, so the poll must run").toBe(1);
    expect(read().subscribed).toBe(false);
  });

  it("keeps the last known score when a poll throws", async () => {
    const timer = stubInterval();
    stubFetch({ ok: false, error: "boom" }, false, 500);
    const { read } = harness(IN_PLAY, false);
    await timer.fire();
    expect(read().data.summary?.headline, "a transient failure must not blank the scoreboard").toBe("1 — 0");
  });

  it("stops polling once the fixture it is polling becomes decided", async () => {
    const timer = stubInterval();
    stubFetch({ ok: true, data: DECIDED });
    const { read } = harness(IN_PLAY, false);
    expect(timer.armed()).toBe(1);
    await timer.fire();
    expect(read().data.status).toBe("decided");
    expect(read().live, "live follows the DATA, not the initial prop").toBe(false);
    expect(timer.armed(), "the effect re-ran with live false and armed nothing new").toBe(1);
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/public-site/__tests__/use-live-fixture.test.tsx --reporter=json --outputFile=/tmp/ovl-w1/t1-red.json`
  Expected: the suite fails to COLLECT with `Failed to resolve import "../use-live-fixture" from "src/components/public-site/__tests__/use-live-fixture.test.tsx"`. In the JSON that is `numTotalTests: 0` with a non-empty `testResults[0].message` — a collection failure, which `rtk` would have printed as `PASS(0) FAIL(0)`. Read the JSON.

- [ ] **Step 3: Implement the hook.** Create `apps/web/src/components/public-site/use-live-fixture.ts`:

```ts
"use client";
// THE public live transport (W1 scope 1, R5). Lifted verbatim out of
// `live-score.tsx` so the public match page and the stream overlay share ONE
// subscribe-or-poll implementation instead of two copies that drift: Pro orgs
// get a Supabase Realtime push on the private channel `fixture:{id}`
// (`lib/realtime.ts:9,27,91`, event `state_changed`, payload carries no body),
// everyone else falls back to a 15 s poll of the public fixture endpoint.
// Behaviour — the interval, the 250 ms debounce, the "any failure leaves
// `subscribed` false" rule — is contract, not tuning (R5).
import { useCallback, useEffect, useState } from "react";
import {
  fetchLiveFixture,
  fetchPublicRealtimeToken,
  type LiveFixtureData,
} from "./live-score-data";

export const POLL_MS = 15_000;
/** The realtime ping carries no body, so several pings in a burst would fire
 *  several refetches; one debounced refetch answers all of them. */
export const DEBOUNCE_MS = 250;

/** The two statuses that can still change under the reader. Exported so a
 *  consumer (and the unit suite) reads the same predicate the effects do —
 *  a second `status === "in_play" || …` written elsewhere is the drift this
 *  extraction exists to prevent. */
export function isLiveStatus(status: string): boolean {
  return status === "in_play" || status === "scheduled";
}

export interface LiveFixture {
  data: LiveFixtureData;
  /** `isLiveStatus(data.status)` — recomputed from the LIVE data, never from
   *  the initial prop, so a fixture that decides while the page is open stops
   *  polling on the very next tick. */
  live: boolean;
  /** Realtime actually connected. `LiveScore` renders it as "· realtime"; the
   *  overlay ignores it (OBS shows no transport state). */
  subscribed: boolean;
  refresh: () => Promise<void>;
}

export function useLiveFixture(
  fixtureId: string,
  initial: LiveFixtureData,
  realtime: boolean,
): LiveFixture {
  const [data, setData] = useState<LiveFixtureData>(initial);

  const refresh = useCallback(async () => {
    try {
      setData(await fetchLiveFixture(fixtureId));
    } catch {
      // transient — keep the last known score
    }
  }, [fixtureId]);

  const live = isLiveStatus(data.status);

  // Realtime push (Pro orgs). Any failure — no entitlement (403), env missing,
  // websocket refused — leaves `subscribed` false and polling takes over.
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    if (!realtime || !live) return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = null;

    (async () => {
      let token: { token: string; channel: string };
      try {
        token = await fetchPublicRealtimeToken(fixtureId);
      } catch {
        return; // not entitled or server error → polling
      }
      if (cancelled) return;
      const { supabaseBrowser } = await import("@/lib/supabase-browser");
      const sb = supabaseBrowser();
      await sb.realtime.setAuth(token.token);
      channel = sb
        .channel(token.channel, { config: { private: true } })
        .on("broadcast", { event: "state_changed" }, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(refresh, DEBOUNCE_MS);
        })
        .subscribe((status: string) => {
          if (!cancelled) setSubscribed(status === "SUBSCRIBED");
        });
    })();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      channel?.unsubscribe();
      setSubscribed(false);
    };
  }, [fixtureId, realtime, live, refresh]);

  // 15 s polling fallback (Community, or realtime not connected).
  useEffect(() => {
    if (!live || subscribed) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [live, subscribed, refresh]);

  return { data, live, subscribed, refresh };
}
```

- [ ] **Step 4: Repoint `LiveScore`.** In `apps/web/src/components/public-site/live-score.tsx`, replace the import block `:8-27` and the state/effect body `:59-117` so the file reads (unchanged parts elided — Props `:32-50` and everything from `const inPlay` at `:118` down are untouched):

```tsx
"use client";
// Live scoreboard for the public match page (doc 09 §2). The subscribe-or-poll
// transport moved to `./use-live-fixture` (stream overlay W1, R5) so this page
// and the OBS overlay share one implementation; this component's Props, its
// derivations and its entire render are unchanged by that move.
import {
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
  stripLiveSetPoints,
} from "@/lib/public-site";
import { type LiveFixtureData } from "./live-score-data";
import { useLiveFixture } from "./use-live-fixture";
import {
  renderDecidedOutcome,
  shootoutScoreFromDetail,
  type DecidedOutcomeTemplates,
} from "@/lib/scoring-vocab";

export type { LiveFixtureData };
```

and the body opener:

```tsx
export function LiveScore({
  fixtureId,
  initial,
  realtime,
  entrantNames,
  sportKey,
  decidedTemplates,
}: Props) {
  const { data, subscribed } = useLiveFixture(fixtureId, initial, realtime);

  const inPlay = data.status === "in_play";
```

  Deletions: the `useCallback, useEffect, useState` import from `react`, the `fetchLiveFixture` / `fetchPublicRealtimeToken` imports, `const POLL_MS = 15_000;` (`:29`), and the whole `:59-117` block (`useState`, `refresh`, `live`, both effects).

- [ ] **Step 5: Run — expect PASS, including the untouched regression witnesses.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/public-site --reporter=json --outputFile=/tmp/ovl-w1/t1-green.json`
  Expected: `numFailedTests: 0`; `use-live-fixture.test.tsx` contributes 6 tests; `live-score.test.tsx` and `live-score-data.test.ts` pass with ZERO edits. Confirm every `.testResults[].name` starts with `/Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web/src/components/public-site/`.

- [ ] **Step 6: Mutation check (d) — delete the poll guard.** Temporarily change `if (!live || subscribed) return;` to `if (subscribed) return;` in `use-live-fixture.ts`, re-run Step 5's command. Expected red: `never arms a poll for a fixture that is already decided at mount` — `expected 1 to be 0`. Restore the guard and re-run to green. Record "mutant (d) killed by use-live-fixture.test.tsx › never arms a poll…" in the PR inventory.

- [ ] **Step 7: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/components/public-site/use-live-fixture.ts apps/web/src/components/public-site/__tests__/use-live-fixture.test.tsx apps/web/src/components/public-site/live-score.tsx`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(transport): lift LiveScore's subscribe-or-poll into useLiveFixture" -m "One transport for the public match page and the OBS overlay (R5). LiveScore's Props and render are untouched; live-score.test.tsx is the unedited regression witness." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 2: The pure projection — `overlayModel`

**Files:**
- Modify: `apps/web/src/lib/public-site.ts` — append after `disciplineLabel` (`:378`)
- Create (Test): `apps/web/src/lib/__tests__/public-site-overlay-derive.test.ts`
- Create: `apps/web/src/lib/overlay-model.ts`
- Create (Test): `apps/web/src/lib/__tests__/overlay-model.test.ts`

**Interfaces:**
- Consumes: `setBreakdown(summary: unknown, sportKey: string): SetBreakdown | null` (`public-site.ts:290`), `periodBreakdown(summary: unknown): PeriodScoreRow[] | null` (`:319`), `matchStrength(summary: unknown): string | null` (`:338`), `disciplineList(summary: unknown): DisciplineEntry[] | null` (`:352`), `servingSide(summary: unknown): "home" | "away" | null` (`:373`), `disciplineLabel(classKey: string): string` (`:377`); `renderDecidedOutcome(outcome, entrantNames: Record<string,string>, templates: DecidedOutcomeTemplates, shootoutScore?): string | null` (`scoring-vocab.ts:1345`), `shootoutScoreFromDetail(detail: unknown)` (`:1410`), `type DecidedOutcomeTemplates` (`:1296`); `type LiveFixtureData` (`live-score-data.ts:7`).
- Produces (in `public-site.ts`):
  - `export function battingEntrantId(summary: unknown): string | null`
  - `export function chaseNeed(summary: unknown): number | null`
- Produces (in `overlay-model.ts`):
  - `export type OverlayMsg = (key: string, vars?: Record<string, string | number>) => string`
  - `export interface OverlaySideInput { id: string; name: string; short?: string | null }`
  - `export interface OverlaySide { short: string; name: string; big: string; sub?: string; led: boolean; serving: boolean }`
  - `export interface OverlayCell { key: string; value: string }`
  - `export interface OverlayModel { live: boolean; decided: boolean; header: { context: string; clock?: string }; sides: [OverlaySide, OverlaySide]; cells: OverlayCell[]; detail: string[]; chase?: string; result?: string }`
  - `export interface OverlayMoment { kind: string; headline: string; line?: string; tone: "led" | "caution" | "dismissal" }` — **type only**, W2's slot (R4). W2 re-declares it in `lib/overlay-moments.ts` with an added `seq: number`; keep the four fields identically named so the widening is additive.
  - `export interface OverlayModelInput { sportKey: string; data: LiveFixtureData; sides: [OverlaySideInput, OverlaySideInput]; startLabel: string | null; msg: OverlayMsg; decidedTemplates: DecidedOutcomeTemplates }`
  - `export function shortCode(side: OverlaySideInput): string`
  - `export function splitLine(line: string): { big: string; sub?: string }`
  - `export function overlayModel(input: OverlayModelInput): OverlayModel`

> **Three deviations from the wave prompt's scope 2, each recorded as a finding:**
> 1. `msg` is typed `OverlayMsg` (a plain `string` key), not `MsgFn` (`scoring-vocab.ts:1147`). `MsgFn`'s key type is `MessageKey = keyof typeof messages` (`lib/messages.ts:12`), and `messages` is `dictionaries/en/ui.json` — the overlay's copy is the `public` namespace, so every `overlay.*` key would fail to type-check against `MsgFn`. `OverlayMsg` is structurally a supertype, so a real `MsgFn` is still assignable.
> 2. `overlayModel` also takes `decidedTemplates`. The decided sentence's one authority is `renderDecidedOutcome` (`scoring-vocab.ts:1345`), whose templates are built from **ui** keys (`fixture.decidedBy.*`) — exactly what `LiveScore` already receives as a prop. Re-implementing that sentence off `summary.headline` would be a second authority for a fact this repo already owns.
> 3. `startLabel: string | null` replaces "the localised start time in the venue zone" being computed inside the model. Timezone + locale formatting belongs to the server component that already holds both; putting `Intl.DateTimeFormat` in the model would make it a second tz authority and would make the model impure across locales.
>
> **Two open pins recorded here rather than guessed:**
> - `header.clock` stays `undefined` in W1. `_THEMES.md` §3 gives football a clock cell, but no elapsed-time field exists on the public `ScoreSummary.detail` — the readers in `lib/public-site.ts:319-373` (`periodBreakdown`, `matchStrength`) are the complete set of what that payload exposes, and neither carries a clock. The bar renders the cell only when `clock` is set, so the slot is live and empty.
> - `short` has no source. `public_entrants_v` (`db/migration/deltas/V350__person_tombstone_views.sql:18-47`) exposes `display_name` and a `team_display` jsonb of `club_id/club_name/logo_path/colors` — **no `short_name`**; `teams.short_name` exists (`V206:5`) but does not reach the public payload. Watch-list 6 therefore resolves to **the three-letter fallback**, and the panel copy says so (`ui.stream.codeNote`, Task 6).

- [ ] **Step 1: Write the failing test for the two new summary readers.** Create `apps/web/src/lib/__tests__/public-site-overlay-derive.test.ts`:

```ts
// The two ScoreSummary readers the stream overlay needs and nothing else owned
// (W1 scope 2). They live beside `servingSide`/`setBreakdown` in
// `lib/public-site.ts` for the reason R5 states: one home for every "read the
// public summary without an engine import" derivation.
//
// Driven off the REAL cricket summary shape (`packages/engine/src/sports/
// cricket/cricket.ts:3285-3325`: `detail.innings[] = { entrantId, runs,
// wickets, legalBalls, declared, closed }`), not an invented one.
import { describe, expect, it } from "vitest";
import { battingEntrantId, chaseNeed } from "@/lib/public-site";

const innings = (entrantId: string, runs: number, closed: boolean) => ({
  entrantId, runs, wickets: 2, legalBalls: 60, declared: false, closed,
});

describe("battingEntrantId", () => {
  it("names the entrant of the last innings that has not closed", () => {
    const summary = { detail: { innings: [innings("e-home", 180, true), innings("e-away", 91, false)] } };
    expect(battingEntrantId(summary)).toBe("e-away");
  });

  it("is null once every innings has closed", () => {
    const summary = { detail: { innings: [innings("e-home", 180, true), innings("e-away", 181, true)] } };
    expect(battingEntrantId(summary)).toBeNull();
  });

  it("is null for a sport whose detail carries no innings at all", () => {
    expect(battingEntrantId({ detail: { sets: [{ home: 21, away: 15, closed: true }] } })).toBeNull();
    expect(battingEntrantId({ detail: null })).toBeNull();
    expect(battingEntrantId(null)).toBeNull();
  });
});

describe("chaseNeed", () => {
  it("is the first innings' total plus one, less what the chasing side has", () => {
    const summary = { detail: { innings: [innings("e-home", 180, true), innings("e-away", 91, false)] } };
    expect(chaseNeed(summary)).toBe(90);
  });

  it("prefers an explicit revised target when the detail carries one (DLS)", () => {
    const summary = {
      detail: { target: 160, targetSource: "dls", innings: [innings("e-home", 180, true), innings("e-away", 91, false)] },
    };
    expect(chaseNeed(summary), "the revised target replaces the first innings' total, it does not add to it").toBe(69);
  });

  it("is null in the first innings, and null once the chase is complete", () => {
    expect(chaseNeed({ detail: { innings: [innings("e-home", 91, false)] } })).toBeNull();
    expect(chaseNeed({ detail: { innings: [innings("e-home", 180, true), innings("e-away", 181, true)] } })).toBeNull();
  });

  it("is null for a sport with no innings", () => {
    expect(chaseNeed({ detail: { periods: [{ phase: "H1", home: 1, away: 0 }] } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/public-site-overlay-derive.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t2a-red.json`
  Expected: collection failure — `"battingEntrantId" is not exported by "src/lib/public-site.ts"`. `numTotalTests: 0`.

- [ ] **Step 3: Implement the readers.** Append to `apps/web/src/lib/public-site.ts` immediately after `disciplineLabel` (`:377-380`):

```ts
/**
 * The entrant currently batting: the last innings on the public summary that
 * has not closed. Cricket's `summary().detail.innings[]` is the only shape in
 * the engine with this field set (`sports/cricket/cricket.ts:3306-3316`), so
 * every other sport returns null by construction rather than by a sport check.
 *
 * This is the FIRST authority for "who is in" on the public payload — nothing
 * else derives it — and it lives here, beside `servingSide`, so the overlay
 * and any later spectator surface read one implementation (R5).
 */
export function battingEntrantId(summary: unknown): string | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { innings?: unknown }).innings;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const last = raw[raw.length - 1];
  if (typeof last !== "object" || last === null) return null;
  const { entrantId, closed } = last as Record<string, unknown>;
  if (closed === true) return null;
  return typeof entrantId === "string" ? entrantId : null;
}

/**
 * Runs still needed by the side batting second, or null when there is no chase
 * in progress. A revised target (DLS, `detail.target`) REPLACES the first
 * innings' total; without one the target is that total plus one.
 *
 * Runs only, never "off N balls": the public summary carries `legalBalls` but
 * not the innings' `ballsLimit`, so balls remaining cannot be computed from
 * this payload. The spec's example line ("Need 45 off 45") is therefore
 * rendered as "Need 45" in W1 — recorded rather than approximated.
 */
export function chaseNeed(summary: unknown): number | null {
  if (typeof summary !== "object" || summary === null) return null;
  const detail = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const raw = (detail as { innings?: unknown }).innings;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const first = raw[raw.length - 2];
  const current = raw[raw.length - 1];
  if (typeof first !== "object" || first === null) return null;
  if (typeof current !== "object" || current === null) return null;
  if ((current as Record<string, unknown>).closed === true) return null;
  const chased = (current as Record<string, unknown>).runs;
  if (typeof chased !== "number") return null;
  const revised = (detail as { target?: unknown }).target;
  if (typeof revised === "number") return Math.max(0, revised - chased);
  const set = (first as Record<string, unknown>).runs;
  if (typeof set !== "number") return null;
  return Math.max(0, set + 1 - chased);
}
```

- [ ] **Step 4: Run — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/public-site-overlay-derive.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t2a-green.json`
  Expected: `numTotalTests: 7`, `numFailedTests: 0`.

- [ ] **Step 5: Write the failing projection test.** Create `apps/web/src/lib/__tests__/overlay-model.test.ts`:

```ts
// `overlayModel` — the ONE projection all eleven sports render through (R3).
//
// Every case folds a SHORT REAL ledger through the REAL module
// (`foldMatch`, packages/engine/src/core/events.ts:445, with
// `defaultLineupPair`/`makeEnvelope` from `@seazn/engine/testkit`) and projects
// the module's OWN `summary()` — the pattern
// `components/v2/scorepad/__tests__/view-model.test.ts:8-12` uses. A typed
// summary table on both ends would only prove the table.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { builtinModules } from "@seazn/engine/sports";
import { V3_SKINS } from "@/components/v2/scorepad/v3/registry";
import { overlayModel, shortCode, splitLine, type OverlayMsg } from "@/lib/overlay-model";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { LiveFixtureData } from "@/components/public-site/live-score-data";

/** A msg that returns its own key, so any literal that leaked into the model
 *  shows up as prose among keys (R14). Never the real dictionary. */
const keyMsg: OverlayMsg = (key, vars) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const TEMPLATES: DecidedOutcomeTemplates = {
  tie: "TIE",
  plain: "WIN {winner}",
  shootoutPlain: "WIN {winner} SO",
  byMethod: { regulation: "WIN {winner} REG" },
};

const SIDES: [{ id: string; name: string }, { id: string; name: string }] = [
  { id: "H", name: "Milton Keynes Rovers" },
  { id: "A", name: "Northbridge Athletic" },
];

const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}" — the skin list and the module list disagree`);
  return m;
};

/** Folds `stream` through the real module and returns the LiveFixtureData the
 *  public endpoint would serve for it. */
function payload(
  key: string,
  stream: readonly (readonly [string, unknown])[],
  status: string,
  outcome: LiveFixtureData["outcome"] = null,
): LiveFixtureData {
  const mod = moduleFor(key);
  const cfg = mod.configSchema.parse({});
  const lineups = defaultLineupPair(mod.positions);
  const events: EventEnvelope[] = stream.map(([type, p], i) =>
    makeEnvelope(i, { type, payload: p } as never),
  );
  const state = foldMatch(mod as never, cfg as never, lineups, events);
  const summary = (mod as { summary: (s: unknown) => LiveFixtureData["summary"] }).summary(state);
  return { status, summary, outcome };
}

const project = (key: string, data: LiveFixtureData, startLabel: string | null = null) =>
  overlayModel({ sportKey: key, data, sides: SIDES, startLabel, msg: keyMsg, decidedTemplates: TEMPLATES });

const CRICKET_BALL = (over: number, ball: number, runs: number) =>
  ["cricket.ball", { over, ballInOver: ball, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p1", runs: { bat: runs } }] as const;

describe("shortCode / splitLine", () => {
  it("upper-cases the first three letters when the entrant has no short name", () => {
    expect(shortCode({ id: "H", name: "Milton Keynes Rovers" })).toBe("MIL");
    expect(shortCode({ id: "A", name: "ab" })).toBe("AB");
    expect(shortCode({ id: "A", name: "  " })).toBe("—");
  });

  it("prefers an explicit short name, upper-cased", () => {
    expect(shortCode({ id: "H", name: "Milton Keynes Rovers", short: "mkr" })).toBe("MKR");
  });

  it("splits a kernel side line into its value and its trailing meta", () => {
    expect(splitLine("142/6 (20)")).toEqual({ big: "142/6", sub: "(20)" });
    expect(splitLine("3")).toEqual({ big: "3" });
  });
});

describe("overlayModel — the empty case first", () => {
  it("a scheduled fixture is not live, shows an em dash both sides and no cells", () => {
    const model = project("generic", { status: "scheduled", summary: null, outcome: null }, "Sat 14:00");
    expect(model.live).toBe(false);
    expect(model.decided).toBe(false);
    expect(model.sides[0].big).toBe("—");
    expect(model.sides[1].big).toBe("—");
    expect(model.sides[0].led).toBe(false);
    expect(model.sides[1].led).toBe(false);
    expect(model.cells).toEqual([]);
    expect(model.detail).toEqual([]);
    expect(model.result).toBeUndefined();
    expect(model.chase).toBeUndefined();
    expect(model.header.context, "the server-formatted start time, in the venue zone").toBe("Sat 14:00");
  });

  it("falls back to a dictionary key when a scheduled fixture has no start time", () => {
    const model = project("generic", { status: "scheduled", summary: null, outcome: null }, null);
    expect(model.header.context).toBe("overlay.header.notStarted");
  });
});

describe("overlayModel — every skin key projects without throwing", () => {
  it("covers all eleven V3_SKINS keys, each with an empty payload", () => {
    const keys = Object.keys(V3_SKINS).sort();
    expect(keys.length, "R3: eleven skins is the working sport-key list").toBe(11);
    for (const key of keys) {
      const model = project(key, { status: "scheduled", summary: null, outcome: null });
      expect(model.sides.length, key).toBe(2);
      expect(model.sides[0].short, key).toBe("MIL");
      expect(model.cells, key).toEqual([]);
    }
  });
});

describe("overlayModel — led and serving truth table", () => {
  it("cricket: the LED sits on the side batting, and moves when the innings does", () => {
    const first = payload("cricket", [
      ["cricket.toss", { winner: "home", decision: "bat" }],
      ["core.start", {}],
      CRICKET_BALL(0, 1, 4),
    ], "in_play");
    const a = project("cricket", first);
    expect(a.sides[0].led, "home is batting").toBe(true);
    expect(a.sides[1].led).toBe(false);
    expect(a.sides[0].serving, "cricket has no serve").toBe(false);

    const second = payload("cricket", [
      ["cricket.toss", { winner: "home", decision: "bat" }],
      ["core.start", {}],
      CRICKET_BALL(0, 1, 4),
      ["cricket.innings.close", { reason: "declared" }],
    ], "in_play");
    const b = project("cricket", second);
    expect(
      [b.sides[0].led, b.sides[1].led],
      "an ordering-differential case: the LED must FLIP with the innings, not sit on home by construction",
    ).not.toEqual([a.sides[0].led, a.sides[1].led]);
  });

  it("tennis: the LED and the serve dot follow the server", () => {
    const data = payload("tennis", [
      ["core.start", {}],
      ["tennis.point", { by: "away" }],
    ], "in_play");
    const model = project("tennis", data);
    const serving = model.sides.findIndex((s) => s.serving);
    expect(serving, "the kernel declares a server at rally fidelity").toBeGreaterThanOrEqual(0);
    expect(model.sides[serving].led, "the server carries the LED").toBe(true);
    expect(model.sides[1 - serving].led).toBe(false);
  });

  it("football: neither side is led or serving while the match is level and open", () => {
    const data = payload("football", [["core.start", {}]], "in_play");
    const model = project("football", data);
    expect(model.sides.map((s) => s.led)).toEqual([false, false]);
    expect(model.sides.map((s) => s.serving)).toEqual([false, false]);
  });

  it("boardgame, carrom and generic have no cells and no detail, by construction", () => {
    for (const key of ["boardgame", "carrom", "generic"]) {
      const data = payload(key, [["core.start", {}]], "in_play");
      const model = project(key, data);
      expect(model.cells, key).toEqual([]);
      expect(model.detail, key).toEqual([]);
    }
  });
});

describe("overlayModel — cells", () => {
  it("badminton renders one cell per game, in order, home–away", () => {
    const data = payload("badminton", [
      ["core.start", {}],
      ...Array.from({ length: 21 }, () => ["badminton.rally", { wonBy: "home" }] as const),
    ], "in_play");
    const model = project("badminton", data);
    expect(model.cells.length, "one closed game").toBeGreaterThanOrEqual(1);
    expect(model.cells[0].key).toBe("1");
    expect(model.cells[0].value).toMatch(/^\d+–\d+$/);
  });

  it("football renders one cell per period once periods exist", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "home" }],
      ["core.period.end", {}],
    ], "in_play");
    const model = project("football", data);
    for (const cell of model.cells) expect(cell.value).toMatch(/^\d+–\d+$/);
  });
});

describe("overlayModel — decided", () => {
  it("sets result from the decided templates, drops chase, and leaves the LED on the winner", () => {
    const data = payload("football", [
      ["core.start", {}],
      ["football.goal", { by: "home" }],
    ], "decided", { kind: "win", winner: "H", method: "regulation" });
    const model = project("football", data);
    expect(model.decided).toBe(true);
    expect(model.live).toBe(false);
    expect(model.result, "the ONE decided-sentence authority, renderDecidedOutcome").toBe(
      "WIN Milton Keynes Rovers REG",
    );
    expect(model.chase).toBeUndefined();
    expect(model.sides[0].led, "the winner keeps the LED").toBe(true);
    expect(model.sides[1].led).toBe(false);
  });
});

describe("overlayModel — cricket chase line", () => {
  it("renders the chase through msg, never as a typed literal", () => {
    const data: LiveFixtureData = {
      status: "in_play",
      summary: {
        headline: "180/8 (20) — 91/3 (12)",
        perSide: [{ entrantId: "H", line: "180/8 (20)" }, { entrantId: "A", line: "91/3 (12)" }],
        detail: {
          innings: [
            { entrantId: "H", runs: 180, wickets: 8, legalBalls: 120, declared: false, closed: true },
            { entrantId: "A", runs: 91, wickets: 3, legalBalls: 72, declared: false, closed: false },
          ],
        },
      },
      outcome: null,
    };
    const model = project("cricket", data);
    expect(model.chase).toBe("overlay.chase.need(runs=90)");
    expect(model.sides[1].big).toBe("91/3");
    expect(model.sides[1].sub).toBe("(12)");
    expect(model.detail, "W2 fills cricket's detail band; W1 leaves it empty (spec §2)").toEqual([]);
  });
});

describe("overlayModel — no literal escapes the dictionary", () => {
  it("every string the model produces is a msg key, a kernel value or a name", () => {
    const data = payload("volleyball", [
      ["core.start", {}],
      ["volleyball.rally", { wonBy: "home" }],
    ], "in_play");
    const model = project("volleyball", data);
    for (const line of model.detail) {
      expect(line, "detail lines are dictionary keys or engine notation, never English typed here")
        .toMatch(/^(overlay\.|[0-9]|[A-Za-z]{1,3}v[0-9])/);
    }
  });
});
```

- [ ] **Step 6: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-model.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t2b-red.json`
  Expected: collection failure — `Failed to resolve import "@/lib/overlay-model"`. `numTotalTests: 0`.

- [ ] **Step 7: Implement the projection.** Create `apps/web/src/lib/overlay-model.ts`:

```ts
// The stream overlay's ONE projection (spec §2, R3). Pure: no React, no
// `@/server/**` (the stage that calls it is a client component — a client
// component importing @/server is a BUILD failure), no engine import. Every
// derivation is imported from `@/lib/public-site`, never re-derived (R5).
//
// All eleven sports render through this. Board game, carrom and generic come
// out with `cells: []` and `detail: []` — a designed state, not an error.
import {
  battingEntrantId,
  chaseNeed,
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
} from "@/lib/public-site";
import {
  renderDecidedOutcome,
  shootoutScoreFromDetail,
  type DecidedOutcomeTemplates,
} from "@/lib/scoring-vocab";
import type { LiveFixtureData } from "@/components/public-site/live-score-data";

/**
 * A dictionary lookup over the `public` namespace. Deliberately NOT
 * `scoring-vocab.ts`'s `MsgFn`, whose key type is `keyof typeof ui.json`
 * (`lib/messages.ts:12`) and would reject every `overlay.*` key. A real
 * `MsgFn` is assignable to this.
 */
export type OverlayMsg = (key: string, vars?: Record<string, string | number>) => string;

export interface OverlaySideInput {
  id: string;
  name: string;
  /** The entrant's own short name where one ever reaches the public payload.
   *  None does today — `public_entrants_v` carries `display_name` and a
   *  `team_display` blob with no `short_name` — so this is always absent and
   *  `shortCode` falls to three letters. */
  short?: string | null;
}

export interface OverlaySide {
  short: string;
  name: string;
  big: string;
  sub?: string;
  /** The side in play: batting, or serving, or the winner once decided. */
  led: boolean;
  serving: boolean;
}

export interface OverlayCell {
  key: string;
  value: string;
}

export interface OverlayModel {
  live: boolean;
  decided: boolean;
  header: { context: string; clock?: string };
  sides: [OverlaySide, OverlaySide];
  cells: OverlayCell[];
  detail: string[];
  chase?: string;
  result?: string;
}

/**
 * W2's slot (R4). A TYPE ONLY in W1 — nothing constructs one, the stage
 * renders an empty `ovl-moment-slot`, and W2 re-declares the same four fields
 * plus `seq` in `lib/overlay-moments.ts`. Named here so W1's components can
 * leave room for it without importing a module that does not exist yet.
 */
export interface OverlayMoment {
  kind: string;
  headline: string;
  line?: string;
  tone: "led" | "caution" | "dismissal";
}

export interface OverlayModelInput {
  sportKey: string;
  data: LiveFixtureData;
  sides: [OverlaySideInput, OverlaySideInput];
  /** The kick-off, already formatted by the server in the venue zone and the
   *  reader's locale. Null when the fixture carries no time. */
  startLabel: string | null;
  msg: OverlayMsg;
  /** The decided sentence's templates — `fixture.decidedBy.*`, the `ui`
   *  namespace — resolved server-side exactly as `LiveScore` receives them. */
  decidedTemplates: DecidedOutcomeTemplates;
}

const EM_DASH = "—";

/** Three letters, upper-cased — the bug's code column. Punctuation and spaces
 *  are dropped first so "St. Ives" reads STI, not "ST.". */
export function shortCode(side: OverlaySideInput): string {
  const explicit = side.short?.trim();
  if (explicit) return explicit.toUpperCase();
  const letters = side.name.replace(/[^\p{L}\p{N}]/gu, "");
  return letters.length > 0 ? letters.slice(0, 3).toUpperCase() : EM_DASH;
}

/** Kernel side lines are "<value> <meta>" — "142/6 (20)", "3". The value is
 *  the big numeral; anything after the first space is the meta column. */
export function splitLine(line: string): { big: string; sub?: string } {
  const at = line.indexOf(" ");
  if (at < 0) return { big: line };
  const sub = line.slice(at + 1).trim();
  return sub ? { big: line.slice(0, at), sub } : { big: line.slice(0, at) };
}

function headerContext(input: OverlayModelInput, decided: boolean): string {
  const { data, msg, sportKey, startLabel } = input;
  if (decided) return msg("overlay.header.ended");
  if (data.status === "scheduled") return startLabel ?? msg("overlay.header.notStarted");
  const periods = periodBreakdown(data.summary);
  if (periods && periods.length > 0) return periods[periods.length - 1]!.phase;
  const breakdown = setBreakdown(data.summary, sportKey);
  if (breakdown) {
    const n = breakdown.sets.length;
    return breakdown.unit === "Game" ? msg("overlay.header.game", { n }) : msg("overlay.header.set", { n });
  }
  return msg("overlay.header.live");
}

function cellsOf(input: OverlayModelInput): OverlayCell[] {
  const breakdown = setBreakdown(input.data.summary, input.sportKey);
  if (breakdown) {
    return breakdown.sets.map((s, i) => ({ key: String(i + 1), value: `${s.home}–${s.away}` }));
  }
  const periods = periodBreakdown(input.data.summary);
  if (periods) return periods.map((p) => ({ key: p.phase, value: `${p.home}–${p.away}` }));
  return [];
}

/**
 * The bar's second band in W1: the serve line, the strength chip and the
 * discipline list — every one of them already on the aggregate summary.
 *
 * NO PERSON NAME is rendered here. `disciplineList` entries carry an optional
 * `person`, but a name on air needs the consent resolver (R17) and that is
 * W2's work; the class and the side are what W1 shows. Cricket's band is
 * empty in W1 by spec §2 — and comes out empty here anyway, since cricket
 * declares neither serve, strength nor discipline.
 */
function detailOf(input: OverlayModelInput, codes: [string, string], live: boolean): string[] {
  const lines: string[] = [];
  const serving = servingSide(input.data.summary);
  if (live && serving) {
    lines.push(input.msg("overlay.detail.serving", { side: serving === "home" ? codes[0] : codes[1] }));
  }
  const strength = live ? matchStrength(input.data.summary) : null;
  if (strength) lines.push(strength);
  for (const entry of disciplineList(input.data.summary) ?? []) {
    lines.push(
      input.msg("overlay.detail.card", {
        side: entry.side === "home" ? codes[0] : codes[1],
        card: disciplineLabel(entry.classKey),
      }),
    );
  }
  return lines;
}

/** Which entrant carries the LED bar: the winner once decided, else the side
 *  batting, else the side serving, else nobody. */
function ledEntrantId(input: OverlayModelInput, decided: boolean): string | null {
  if (decided) return input.data.outcome?.winner ?? null;
  const batting = battingEntrantId(input.data.summary);
  if (batting) return batting;
  const serving = servingSide(input.data.summary);
  if (serving) return serving === "home" ? input.sides[0].id : input.sides[1].id;
  return null;
}

export function overlayModel(input: OverlayModelInput): OverlayModel {
  const { data, msg, sides } = input;
  const decided = data.status === "decided" || data.status === "finalized";
  const live = data.status === "in_play";
  const codes: [string, string] = [shortCode(sides[0]), shortCode(sides[1])];
  const led = ledEntrantId(input, decided);
  const serving = servingSide(data.summary);
  // Kernel perSide order is [home, away]; a payload with anything else is a
  // payload this projection cannot place, so it falls to the em-dash state
  // rather than guessing which line belongs to which row.
  const perSide = data.summary?.perSide;
  const usable = Array.isArray(perSide) && perSide.length === 2 ? perSide : null;

  const overlaySides = ([0, 1] as const).map((row): OverlaySide => {
    const input_ = sides[row];
    const line = usable ? splitLine(usable[row]!.line) : { big: EM_DASH };
    return {
      short: codes[row],
      name: input_.name,
      big: line.big,
      ...(line.sub === undefined ? {} : { sub: line.sub }),
      led: led !== null && led === input_.id,
      serving: serving !== null && (row === 0 ? "home" : "away") === serving,
    };
  }) as [OverlaySide, OverlaySide];

  const need = decided ? null : chaseNeed(data.summary);
  const result = renderDecidedOutcome(
    data.outcome,
    { [sides[0].id]: sides[0].name, [sides[1].id]: sides[1].name },
    input.decidedTemplates,
    shootoutScoreFromDetail(data.summary?.detail),
  );

  return {
    live,
    decided,
    header: { context: headerContext(input, decided) },
    sides: overlaySides,
    cells: cellsOf(input),
    detail: input.sportKey === "cricket" ? [] : detailOf(input, codes, live),
    ...(need === null ? {} : { chase: msg("overlay.chase.need", { runs: need }) }),
    ...(result === null ? {} : { result }),
  };
}
```

- [ ] **Step 8: Run — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-model.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t2b-green.json`
  Expected: `numFailedTests: 0`, `numTotalTests: 13`. If a sport's event name in `CRICKET_BALL` / `["tennis.point", …]` / `["volleyball.rally", …]` is rejected by the fold (`WRONG_PHASE`, `UNKNOWN_TYPE`), fix the STREAM against the module's `eventSchemas`, never the assertion — a stream the engine refuses is a test that proves nothing.

- [ ] **Step 9: Mutation check (b) — swap `led` to the other side.** Change the return in `ledEntrantId` from `input.sides[0].id : input.sides[1].id` to `input.sides[1].id : input.sides[0].id`, re-run Step 8. Expected red: `tennis: the LED and the serve dot follow the server` — `expected false to be true`. Restore.

- [ ] **Step 10: Mutation check (c) — return `[]` from the cells branch.** Change `cellsOf`'s first branch to `if (breakdown) return [];`, re-run Step 8. Expected red: `badminton renders one cell per game, in order, home–away` — `expected +0 to be greater than or equal to 1`. Restore and re-run to green.

- [ ] **Step 11: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/lib/overlay-model.ts apps/web/src/lib/public-site.ts apps/web/src/lib/__tests__/overlay-model.test.ts apps/web/src/lib/__tests__/public-site-overlay-derive.test.ts`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(model): one pure projection for all eleven sports" -m "overlayModel projects the public ScoreSummary into the bar/bug shape; battingEntrantId and chaseNeed join the other public-site summary readers. Every case is folded through the real module (R3, R5)." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 3: The stream link — validation, column, view, write path, OpenAPI

**Files:**
- Create: `apps/web/src/lib/stream-url.ts`
- Create (Test): `apps/web/src/lib/__tests__/stream-url.test.ts`
- Create: `db/migration/deltas/V392__fixture_stream_url.sql`
- Modify: `apps/web/src/server/public-site/data.ts` — `PublicFixture` (`:206`), the `getPublicFixture` SELECT (`:711-716`)
- Modify: `apps/web/src/server/usecases/public.ts` — `publicFixture()`'s `Pick<>` and SELECT (`:263-297`)
- Modify: `apps/web/src/server/api-v1/schemas.ts` — after `PatchedFixture`'s neighbourhood, next to `PatchFixture` (`:964-989`)
- Modify: `apps/web/src/server/usecases/fixtures.ts` — after `patchFixture` (`:136-176`)
- Create: `apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts` (after `:142`), `apps/web/src/server/api-v1/key-scopes.ts` (after `:175`)
- Create (Test): `apps/web/src/server/usecases/__tests__/fixture-stream-url.test.ts`
- Generated: `apps/web/openapi/v1.json`, `apps/web/openapi/v1.public.json`

**Interfaces:**
- Consumes: `requireResourceAuth(req: Request, kind: "fixture", id: string, scope: "write"): Promise<AuthCtx>` (`server/api-v1/auth.ts:352`); `v1`, `parseBody` from `@/server/api-v1/http`; `withTenant(orgId, fn)` and `sql` from `@/lib/db`; `HttpError` from `@/lib/errors`; `fireDivisionRevalidate(divisionId: string, competitionId?: string): void` (`server/public-site/revalidate.ts:14`).
- Produces:
  - `export const STREAM_HOSTS: readonly string[]` (the ten hostnames, R16)
  - `export const streamUrlSchema: z.ZodType<string | null, string | null>` — parses `string | null`, returns `string | null`
  - `export function isStreamUrl(value: string): boolean`
  - `export const PutFixtureStream` / `export type PutFixtureStream = { streamUrl: string | null }` (schemas.ts)
  - `export const FixtureStream` / `export type FixtureStream = { id: string; stream_url: string | null }` (schemas.ts)
  - `export async function setFixtureStreamUrl(auth: AuthCtx, id: string, streamUrl: string | null): Promise<FixtureStreamOut>` where `export interface FixtureStreamOut { id: string; stream_url: string | null }` (usecases/fixtures.ts)
  - `PublicFixture.stream_url: string | null`

- [ ] **Step 1: Write the failing validation test.** Create `apps/web/src/lib/__tests__/stream-url.test.ts`:

```ts
// R16: exact hostname, https only. A prefix or substring test is not origin
// validation — this repo has already shipped `/\evil.com` as an open redirect
// off exactly that mistake, so the negative cases below are the point of the
// file and the positives exist only so a schema that rejected everything
// could not pass for a correct one.
import { describe, expect, it } from "vitest";
import { STREAM_HOSTS, isStreamUrl, streamUrlSchema } from "@/lib/stream-url";

const ACCEPTED = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtube.com/live/abc123",
  "https://youtu.be/abc123",
  "https://www.facebook.com/clubpage/videos/123",
  "https://facebook.com/clubpage/live",
  "https://fb.watch/aBc-1/",
  "https://www.twitch.tv/seaznclub",
  "https://twitch.tv/seaznclub",
  "https://kick.com/seaznclub",
  "https://www.kick.com/seaznclub",
];

const REJECTED: [string, string][] = [
  ["https://evil.example/www.youtube.com", "an allowed host in the PATH is not the host"],
  ["https://www.youtube.com.evil.example/", "an allowed host as a PREFIX of the host is not the host"],
  ["https://youtube.com.evil.example", "same, without the www"],
  ["https://notyoutube.com/x", "an allowed host as a SUFFIX of the host is not the host"],
  ["javascript:alert(1)", "not https"],
  ["http://www.youtube.com/x", "http is refused even on an allowed host"],
  ["https://m.youtube.com/x", "m. is not on the list (open question for the owner)"],
  [" https://youtube.com", "a leading space is not trimmed into validity"],
  ["https://user:pass@www.youtube.com/x", "credentials in the authority"],
  ["not a url at all", "unparseable"],
];

describe("STREAM_HOSTS", () => {
  it("is exactly the ten hostnames R16 names, and nothing else", () => {
    expect([...STREAM_HOSTS].sort()).toEqual([
      "facebook.com", "fb.watch", "kick.com", "twitch.tv", "www.facebook.com",
      "www.kick.com", "www.twitch.tv", "www.youtube.com", "youtu.be", "youtube.com",
    ]);
  });
});

describe("streamUrlSchema", () => {
  it.each(ACCEPTED)("accepts %s and returns it unchanged", (url) => {
    expect(streamUrlSchema.parse(url)).toBe(url);
    expect(isStreamUrl(url)).toBe(true);
  });

  it.each(REJECTED)("rejects %s — %s", (url) => {
    expect(() => streamUrlSchema.parse(url)).toThrow();
    expect(isStreamUrl(url)).toBe(false);
  });

  it("clears the link on an empty string and passes null through", () => {
    expect(streamUrlSchema.parse("")).toBeNull();
    expect(streamUrlSchema.parse("   ")).toBeNull();
    expect(streamUrlSchema.parse(null)).toBeNull();
  });

  it("names the field in its issue so the panel can render an inline error", () => {
    const parsed = streamUrlSchema.safeParse("https://evil.example/www.youtube.com");
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.code).toBe("custom");
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/stream-url.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3a-red.json`
  Expected: collection failure — `Failed to resolve import "@/lib/stream-url"`, `numTotalTests: 0`.

- [ ] **Step 3: Implement the schema.** Create `apps/web/src/lib/stream-url.ts`:

```ts
// The ONE stream-link validator (R16), shared by the write route and the
// organiser panel's inline error. No `server-only`: the panel is a client
// component and must validate before it sends.
//
// EXACT hostname comparison. Never `startsWith`, never `includes`, never a
// regex over the whole URL: `https://evil.example/www.youtube.com` and
// `https://www.youtube.com.evil.example/` both contain an allowed host and
// neither IS one. `new URL()` is what separates the authority from the rest;
// this file's whole job is to compare `url.hostname` against a fixed set.
import { z } from "zod";

export const STREAM_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "youtu.be",
  "www.facebook.com",
  "facebook.com",
  "fb.watch",
  "www.twitch.tv",
  "twitch.tv",
  "kick.com",
  "www.kick.com",
] as const;

const ALLOWED = new Set<string>(STREAM_HOSTS);

/** True when `value` is an https URL whose hostname is EXACTLY one of the ten.
 *  Credentials in the authority are refused too — a link a club pastes into a
 *  public page must not carry a username. */
export function isStreamUrl(value: string): boolean {
  if (value !== value.trim()) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return ALLOWED.has(url.hostname);
}

/**
 * `""` (or whitespace) clears the link; `null` passes through; anything else
 * must satisfy `isStreamUrl`. The transform runs BEFORE the refinement so an
 * empty string never reaches the host check.
 */
export const streamUrlSchema = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null || v.trim() === "" ? null : v))
  .refine((v) => v === null || isStreamUrl(v), {
    message: "Stream link must be an https link to YouTube, Facebook, Twitch or Kick",
  });
```

- [ ] **Step 4: Run — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/stream-url.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3a-green.json`
  Expected: `numFailedTests: 0`, `numTotalTests: 24` (10 accepted + 10 rejected + 4).

- [ ] **Step 5: Mutation check (a) — delete the hostname comparison.** Change `return ALLOWED.has(url.hostname);` to `return true;`, re-run Step 4. Expected red: all ten `rejects …` cases for the https ones — `expected [Function] to throw an error`. Restore and re-run to green. Record "mutant (a) killed by stream-url.test.ts › rejects https://evil.example/www.youtube.com".

- [ ] **Step 6: Write the migration.** Create `db/migration/deltas/V392__fixture_stream_url.sql` (renumber at rebase, R10):

```sql
-- =============================================================================
-- V392 — Stream overlay W1: the club's own broadcast link on a fixture.
--
-- A club streams the match to YouTube / Facebook / Twitch / Kick and pastes the
-- link here; the public match page turns it into "Watch live" (and "Replay"
-- once decided). Video never touches seazn — this is a text column and an
-- anchor. Exact-host validation lives in `apps/web/src/lib/stream-url.ts`
-- (R16); the CHECK below is the database's own floor, not a substitute for it.
--
-- The view is redefined IN FULL with `stream_url` appended LAST: `create or
-- replace view` may only APPEND columns (V243's note, V369's note, still true).
-- The body below is V369__public_fixtures_round_role.sql:18 verbatim plus the
-- one trailing column, which carries the same per-row "setup" redaction the
-- scheduled_at/venue/court_label columns already use — an unreleased
-- division's stream link must not leak ahead of its schedule.
-- =============================================================================

alter table fixtures add column if not exists stream_url text
  check (stream_url is null or stream_url like 'https://%');

create or replace view public_fixtures_v as
  select f.id, f.division_id, f.stage_id, f.pool_id, f.round_no, f.seq_in_round,
         f.home_entrant_id, f.away_entrant_id,
         case when d.status = 'setup' then null else f.scheduled_at end as scheduled_at,
         case when d.status = 'setup' then null else f.venue end        as venue,
         case when d.status = 'setup' then null else f.court_label end as court_label,
         f.status, f.outcome, f.created_at,
         m.summary, m.last_seq,
         case when d.officials_hide_names or d.status = 'setup'
              then '[]'::jsonb else f.officials end as officials,
         f.home_slot_label, f.away_slot_label,
         f.lane, f.is_final, f.third_place, f.conditional,
         case when d.status = 'setup' then null else f.stream_url end as stream_url
  from fixtures f
  left join match_states m on m.fixture_id = f.id
  join divisions d    on d.id = f.division_id
  join competitions c on c.id = d.competition_id
  where c.visibility in ('public','unlisted');
```

- [ ] **Step 7: Apply it and prove the column is on the view.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npm run db:apply`
  then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx tsx -e "import postgres from 'postgres'; const s = postgres(process.env.DATABASE_URL!, { ssl: false }); const r = await s\`select column_name, ordinal_position from information_schema.columns where table_name = 'public_fixtures_v' order by ordinal_position desc limit 1\`; console.log(r); await s.end();"`
  Expected: the single row is `{ column_name: 'stream_url', ordinal_position: 22 }` — LAST, which is what proves the append rule was honoured rather than assumed.

- [ ] **Step 8: Widen both hand-maintained column lists.** In `apps/web/src/server/public-site/data.ts`, add to `PublicFixture` (after `conditional`, the last field of the interface at `:206`ff):

```ts
  /** The club's own broadcast link (V392). Null unless an organiser saved one,
   *  and null for a `setup` division — the view redacts it alongside the
   *  schedule. Rendered ONLY as an `<a href target="_blank" rel="noopener">`
   *  (R16); never an iframe, never fetched. */
  stream_url: string | null;
```

  and extend the SELECT inside `getPublicFixture` (`:711-716`) so its last line reads:

```ts
               lane, is_final, third_place, conditional, stream_url
```

  In `apps/web/src/server/usecases/public.ts`, add `| "stream_url"` to `publicFixture()`'s `Pick<>` union (after `| "last_seq"`) and extend its SELECT's last line to:

```ts
             summary, last_seq, stream_url
```

- [ ] **Step 9: Add the wire schemas.** In `apps/web/src/server/api-v1/schemas.ts`, immediately after `export type PatchFixture = z.infer<typeof PatchFixture>;` (`:989`):

```ts
/** PUT /fixtures/{id}/stream (stream overlay W1). `.strict()` for the reason
 *  `PatchFixture` documents: a client sending `stream_url` (snake) instead of
 *  `streamUrl` gets a loud 400 rather than a silent no-op. The value is
 *  validated by the ONE allowlist both this route and the organiser panel
 *  share (`@/lib/stream-url`, R16) — never a second host list here. */
export const PutFixtureStream = z.object({ streamUrl: streamUrlSchema }).strict();
export type PutFixtureStream = z.infer<typeof PutFixtureStream>;

export const FixtureStream = z.object({
  id: z.string(),
  stream_url: z.string().nullable(),
});
export type FixtureStream = z.infer<typeof FixtureStream>;
```

  and add `import { streamUrlSchema } from "@/lib/stream-url";` to the file's import block.

- [ ] **Step 10: Write the failing usecase test.** Create `apps/web/src/server/usecases/__tests__/fixture-stream-url.test.ts`:

```ts
// `setFixtureStreamUrl` against a real Postgres (the `HAS_DB` skip idiom,
// add-fixture.test.ts:5-17). The point is the SEAM, not the setter: a value
// written here must arrive on `public_fixtures_v`, because `PublicFixture`'s
// column list is hand-maintained in two places and a column read everywhere /
// written nowhere is this repo's most-shipped defect class.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { seedOrg, startedDivisionWithFixture } from "./_rig";
import { setFixtureStreamUrl } from "../fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("setFixtureStreamUrl", () => {
  it("writes the link, returns it, and it arrives on the PUBLIC view", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const url = "https://www.youtube.com/watch?v=abc123";

    const saved = await setFixtureStreamUrl(auth, fixtureId, url);
    expect(saved).toEqual({ id: fixtureId, stream_url: url });

    const [base] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(base?.stream_url).toBe(url);

    const [view] = await sql<{ stream_url: string | null }[]>`
      select stream_url from public_fixtures_v where id = ${fixtureId}`;
    expect(view?.stream_url, "V392 appended the column to the view — this is the seam").toBe(url);
  });

  it("clears the link with null", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await setFixtureStreamUrl(auth, fixtureId, "https://twitch.tv/seaznclub");
    const cleared = await setFixtureStreamUrl(auth, fixtureId, null);
    expect(cleared.stream_url).toBeNull();
    const [row] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(row?.stream_url).toBeNull();
  });

  it("404s an id that is not this org's fixture, rather than writing nothing and reporting success", async () => {
    const { auth } = await seedOrg();
    const other = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(other.auth);
    await expect(setFixtureStreamUrl(auth, fixtureId, "https://kick.com/x")).rejects.toBeInstanceOf(HttpError);
  });

  it("refuses a host outside the allowlist at the usecase boundary too, not only at the route", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await expect(
      setFixtureStreamUrl(auth, fixtureId, "https://evil.example/www.youtube.com"),
    ).rejects.toBeInstanceOf(HttpError);
    const [row] = await sql<{ stream_url: string | null }[]>`
      select stream_url from fixtures where id = ${fixtureId}`;
    expect(row?.stream_url, "a refused link must leave the column untouched").toBeNull();
  });
});
```

- [ ] **Step 11: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/fixture-stream-url.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3b-red.json`
  Expected: collection failure — `"setFixtureStreamUrl" is not exported by "src/server/usecases/fixtures.ts"`. If instead you see `numTotalTests: 4, numPassedTests: 0, numPendingTests: 4`, `DATABASE_URL` is unset and the suite SKIPPED — fix the env, do not accept the skip.

- [ ] **Step 12: Implement the usecase.** In `apps/web/src/server/usecases/fixtures.ts`, immediately after `patchFixture`'s closing brace (`:176`):

```ts
/** The row `PUT /fixtures/{id}/stream` returns and the panel reads back. */
export interface FixtureStreamOut {
  id: string;
  stream_url: string | null;
}

/**
 * Set or clear a fixture's public broadcast link (stream overlay W1).
 *
 * Validated HERE as well as at the route, against the SAME schema the panel
 * uses (`@/lib/stream-url`, R16) — a usecase that trusts its caller is one
 * `parseBody` refactor away from writing an unvalidated host into a public
 * anchor. `withTenant` scopes the write; a fixture belonging to another org is
 * simply not found, which is also the answer for an id that does not exist.
 *
 * The revalidation is `fireDivisionRevalidate` (revalidate.ts:14), NOT
 * `broadcastRevalidate` — the latter is the peer primitive that helper calls
 * internally. It is what busts the `["pub-fixture", fixtureId]` cache entry
 * tagged `divisionTag(division.id)` (data.ts:742), which is the entry the
 * public match page reads the link from.
 */
export async function setFixtureStreamUrl(
  auth: AuthCtx,
  id: string,
  streamUrl: string | null,
): Promise<FixtureStreamOut> {
  rejectDeviceLink(auth);
  const parsed = streamUrlSchema.safeParse(streamUrl);
  if (!parsed.success) throw new HttpError(422, "invalid stream link");
  const value = parsed.data;
  const out = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string; stream_url: string | null; division_id: string; competition_id: string }[]>`
      update fixtures f
         set stream_url = ${value}
        from divisions d
       where f.id = ${id} and d.id = f.division_id
      returning f.id, f.stream_url, f.division_id, d.competition_id`;
    if (!row) throw new HttpError(404, "fixture not found");
    return row;
  });
  fireDivisionRevalidate(out.division_id, out.competition_id);
  return { id: out.id, stream_url: out.stream_url };
}
```

  and add to the file's imports: `import { streamUrlSchema } from "@/lib/stream-url";` and `import { fireDivisionRevalidate } from "../public-site/revalidate";`.

- [ ] **Step 13: Run — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run src/server/usecases/__tests__/fixture-stream-url.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3b-green.json`
  Expected: `numTotalTests: 4`, `numFailedTests: 0`, `numPendingTests: 0`.

- [ ] **Step 14: Add the route.** Create `apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts`:

```ts
import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutFixtureStream } from "@/server/api-v1/schemas";
import { setFixtureStreamUrl } from "@/server/usecases/fixtures";

type Ctx = { params: Promise<{ id: string }> };

/** The club's own broadcast link (stream overlay W1). Same write gate the
 *  schedule PATCH uses — `requireResourceAuth(req, "fixture", id, "write")`
 *  (fixtures/[id]/route.ts:17) — because pasting a public link on a fixture is
 *  the same authority as moving it. Returns JSON; never a redirect (R8). */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PutFixtureStream);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return setFixtureStreamUrl(auth, id, body.streamUrl);
  });
}
```

- [ ] **Step 15: Declare it in OpenAPI and in the key-scope map.** In `apps/web/src/server/api-v1/openapi.ts`, immediately after the `PATCH /fixtures/{id}` row (`:142`):

```ts
  { path: "/fixtures/{id}/stream", method: "put", summary: "Set or clear the fixture's public broadcast link (https, exact-host allowlist: YouTube, Facebook, Twitch, Kick) — surfaces as \"Watch live\" on the public match page", tag: "fixtures", request: S.PutFixtureStream, response: S.FixtureStream, errors: [403, 404, 422] },
```

  In `apps/web/src/server/api-v1/key-scopes.ts`, after `{ method: "PATCH", path: "/fixtures/:id", scope: "manage", pin: "fixture" }` (`:175`):

```ts
  { method: "PUT", path: "/fixtures/:id/stream", scope: "manage", pin: "fixture" },
```

- [ ] **Step 16: Regenerate the spec and run both classification gates.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npm run openapi:gen`
  then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/server/api-v1/__tests__/openapi-coverage.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-published.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t3c.json`
  Expected: `numFailedTests: 0`. Both are total-classification tests, so omitting either declaration reds them with the new route named in the diff — run this step BEFORE the declarations if you want to see that red first.
  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git status --porcelain apps/web/openapi` — expected: both files modified, and re-running `openapi:gen` leaves no further diff (CI's drift gate).

- [ ] **Step 17: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/lib/stream-url.ts apps/web/src/lib/__tests__/stream-url.test.ts db/migration/deltas/V392__fixture_stream_url.sql apps/web/src/server/public-site/data.ts apps/web/src/server/usecases/public.ts apps/web/src/server/api-v1/schemas.ts apps/web/src/server/usecases/fixtures.ts apps/web/src/server/usecases/__tests__/fixture-stream-url.test.ts apps/web/src/app/api/v1/fixtures/[id]/stream/route.ts apps/web/src/server/api-v1/openapi.ts apps/web/src/server/api-v1/key-scopes.ts apps/web/openapi/v1.json apps/web/openapi/v1.public.json`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(data): fixtures.stream_url, the exact-host allowlist and PUT /fixtures/{id}/stream" -m "V392 appends stream_url to public_fixtures_v (append-only, R6); both hand-maintained PublicFixture column lists gain it; the DB-backed usecase test proves the value reaches the public view rather than assuming it." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 4: The entitlement key

**Files:**
- Create: `db/migration/deltas/V393__streaming_overlay_entitlement.sql`
- Create (Test): `apps/web/src/lib/__tests__/entitlement-streaming-overlay.test.ts`
- **Not modified, deliberately:** `apps/web/src/lib/entitlement-domains.ts`, `apps/web/src/lib/pricing-matrix.ts`, every pricing dictionary key.

**Interfaces:**
- Consumes: `hasFeature(orgId: string, featureKey: string, competitionId?: string): Promise<boolean>` (`lib/entitlements.ts:454`); `invalidateOrgEntitlements(orgId: string)` (`lib/entitlements.ts`); `ENTITLEMENT_DOMAINS: { slug: string; features: string[] }[]` (`lib/entitlement-domains.ts:5`); `buildPricingSections` (`lib/pricing-matrix.ts:199`); `seedOrg()` (`server/usecases/__tests__/_rig.ts:23`).
- Produces: no new TypeScript symbol — the key is data. `plan_entitlements` gains one row per plan for `streaming.overlay`, all `bool_value = false`.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/lib/__tests__/entitlement-streaming-overlay.test.ts`:

```ts
// `streaming.overlay` (R1): granted by NO plan, hidden from /pricing by being
// absent from ENTITLEMENT_DOMAINS, lifted for one org by an override row.
//
// Two halves on purpose. The catalogue half is a pure unit — it is the thing a
// later "tidy the domains list" edit would break silently. The resolver half is
// DB-backed, because "false for a fresh org, true after an override" is a claim
// about the real resolver's precedence (entitlements.ts:441 override first),
// not about a constant.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";
import { seedOrg } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;
const KEY = "streaming.overlay";

describe("streaming.overlay is unadvertised", () => {
  it("is in NO ENTITLEMENT_DOMAINS section — that omission is what keeps it off /pricing", () => {
    const listed = ENTITLEMENT_DOMAINS.flatMap((d) => d.features);
    expect(listed).not.toContain(KEY);
  });

  it("the domains list is otherwise untouched by this wave", () => {
    // A positive pair for the negative above: if a future edit deleted the
    // whole list, the assertion above would pass vacuously.
    expect(ENTITLEMENT_DOMAINS.length).toBeGreaterThanOrEqual(5);
    expect(ENTITLEMENT_DOMAINS.flatMap((d) => d.features)).toContain("embeds.enabled");
  });
});

describe.skipIf(!HAS_DB)("streaming.overlay resolves", () => {
  it("carries a catalogue row for every plan, all false", async () => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null }[]>`
      select plan_key, bool_value from plan_entitlements where feature_key = ${KEY}`;
    const plans = await sql<{ key: string }[]>`select key from plans`;
    expect(rows.length, "a missing row already denies, but /admin needs the key visible under \"other\"")
      .toBe(plans.length);
    for (const row of rows) expect(row.bool_value, row.plan_key).toBe(false);
  });

  it("is false for a fresh org and true after an org_entitlement_overrides row", async () => {
    const { auth } = await seedOrg();
    expect(await hasFeature(auth.orgId, KEY), "no plan grants it").toBe(false);

    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${auth.orgId}, ${KEY}, true, 'unit: stream overlay W1')
      on conflict (org_id, feature_key) do update set bool_value = true, expires_at = null`;
    await invalidateOrgEntitlements(auth.orgId);
    expect(await hasFeature(auth.orgId, KEY), "the resolver ranks the override first").toBe(true);

    await sql`
      update org_entitlement_overrides set bool_value = false
       where org_id = ${auth.orgId} and feature_key = ${KEY}`;
    await invalidateOrgEntitlements(auth.orgId);
    expect(await hasFeature(auth.orgId, KEY), "and the other direction, so the flip is real").toBe(false);
  });

  it("does not leak into another org", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${a.auth.orgId}, ${KEY}, true, ${"unit " + randomUUID().slice(0, 6)})
      on conflict (org_id, feature_key) do update set bool_value = true`;
    await invalidateOrgEntitlements(a.auth.orgId);
    expect(await hasFeature(b.auth.orgId, KEY)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run src/lib/__tests__/entitlement-streaming-overlay.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t4-red.json`
  Expected: the two pure cases PASS (the key is genuinely absent from the domains list today), and `carries a catalogue row for every plan, all false` FAILS with `expected +0 to be 5` (or whatever `select count(*) from plans` returns) — the migration does not exist yet. `numFailedTests: 1`.

- [ ] **Step 3: Write the migration.** Create `db/migration/deltas/V393__streaming_overlay_entitlement.sql` (renumber at rebase, R10):

```sql
-- =============================================================================
-- V393 — Stream overlay W1: the `streaming.overlay` entitlement key.
--
-- Granted by NO plan at launch (R1). A missing row already denies
-- (lib/entitlements.ts's resolver; V024__plan_entitlements.sql:1), so these
-- rows are not what makes the gate work — they are what makes the key VISIBLE
-- in /admin/entitlements under "other", so an operator can see the feature
-- exists before deciding a tier for it.
--
-- The key is deliberately NOT added to `ENTITLEMENT_DOMAINS`
-- (apps/web/src/lib/entitlement-domains.ts) — that catalogue is CODE, and
-- `buildPricingSections` renders only listed keys, so the omission is exactly
-- what keeps a false-everywhere row off the public pricing comparison. Adding
-- it there would render an empty column on every plan.
--
-- The test org is lifted with an `org_entitlement_overrides` row (V025), which
-- the resolver ranks first — SQL, not a migration, so the grant travels with
-- the environment rather than with the schema.
--
-- Derived from `plans` rather than a typed plan list, so a tier added later
-- still gets its explicit deny without an edit here. Same insert form as
-- V290__pro_plus_plan.sql:18,39.
-- =============================================================================

insert into plan_entitlements (plan_key, feature_key, bool_value, int_value)
select p.key, 'streaming.overlay', false, null from plans p
on conflict (plan_key, feature_key) do update
  set bool_value = excluded.bool_value, int_value = excluded.int_value;
```

- [ ] **Step 4: Apply and run — expect PASS.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npm run db:apply`
  then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run src/lib/__tests__/entitlement-streaming-overlay.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t4-green.json`
  Expected: `numTotalTests: 5`, `numFailedTests: 0`, `numPendingTests: 0`.

- [ ] **Step 5: Confirm by reading, not by assuming, that no pricing copy is owed.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && grep -an "ENTITLEMENT_DOMAINS" apps/web/src/lib/pricing-matrix.ts`
  Expected: `:196` and `:199` — `buildPricingSections` maps `ENTITLEMENT_DOMAINS` and nothing else. Record in the PR inventory: "no `pricing.feature.streaming.overlay` key added; `buildPricingSections` (pricing-matrix.ts:199) iterates only `ENTITLEMENT_DOMAINS`, which does not list the key."

- [ ] **Step 6: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add db/migration/deltas/V393__streaming_overlay_entitlement.sql apps/web/src/lib/__tests__/entitlement-streaming-overlay.test.ts`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(entitlement): streaming.overlay, denied on every plan" -m "V393 writes an explicit false for every plan key so /admin can see the feature; the key stays out of ENTITLEMENT_DOMAINS, which is what keeps it off /pricing (R1). The DB half proves the override flip in both directions." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 5: The overlay route — layout, page, stage, bar, bug, CSS, dictionary

**Files:**
- Modify: `apps/web/src/server/public-site/data.ts` — new export after `getPublicFixture` (`:747`)
- Create: `apps/web/src/app/overlay/fixtures/[fixtureId]/layout.tsx`
- Create: `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx`
- Create: `apps/web/src/components/overlay/overlay-stage.tsx`
- Create: `apps/web/src/components/overlay/overlay-bar.tsx`
- Create: `apps/web/src/components/overlay/overlay-bug.tsx`
- Modify: `apps/web/src/app/globals.css` — append after the `:root { --sport-* }` block (`:1022`)
- Modify: `apps/web/src/components/cookie-consent.tsx` (`:84`) — one `data-testid`
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/public.json`
- Modify (generated): `apps/web/src/lib/i18n-keys.ts`
- Create (Test): `apps/web/src/lib/__tests__/overlay-dict-coverage.test.ts`
- Create (Test): `apps/web/src/components/overlay/__tests__/contrast.test.ts`

**Interfaces:**
- Consumes: `getPublicFixture(orgSlug, compSlug, divSlug, fixtureId)` (`data.ts:689`); `hasFeature` (`entitlements.ts:454`); `getDictionary(locale, "public"): Promise<Dict>` (`lib/i18n.ts:77`); `t(dict, key, vars)` (`lib/i18n-runtime.ts:30`); `toLocale` (`lib/i18n-constants.ts:42`); `decidedOutcomeTemplates(m: MsgFn)` (`scoring-vocab.ts:1320`) with `msgFor(locale, key, vars)` (`messages-i18n.ts:24`); `sportThemeStyle(skinKey): CSSProperties | undefined` (`sport-theme.ts:557`), `sportThemeAttr(skinKey): string | undefined` (`:553`), `resolveSportPalette(skinKey): SportPalette` (`:515`), `SPORT_TOKENS` (`:77`); `useLiveFixture` (Task 1); `overlayModel`, `OverlayModel`, `OverlaySideInput` (Task 2).
- Produces:
  - `export async function publicFixtureSlugs(fixtureId: string): Promise<{ orgSlug: string; compSlug: string; divSlug: string } | null>` (`data.ts`)
  - `export type OverlayStyle = "bar" | "bug"` and `export function overlayStyleFor(sportKey: string, requested: string | undefined): OverlayStyle` (`overlay-stage.tsx`)
  - `export interface OverlayStageProps { fixtureId: string; initial: LiveFixtureData; realtime: boolean; sportKey: string; style: OverlayStyle; sides: [OverlaySideInput, OverlaySideInput]; startLabel: string | null; dict: Record<string, string>; decidedTemplates: DecidedOutcomeTemplates; fit?: boolean }`
  - `export function OverlayStage(props: OverlayStageProps): JSX.Element`
  - `export function OverlayBar(props: { model: OverlayModel; tick: [boolean, boolean] }): JSX.Element`
  - `export function OverlayBug(props: { model: OverlayModel; tick: [boolean, boolean] }): JSX.Element`

> **Resolution of watch-list 1 (recorded):** the overlay URL carries only a fixture id, and `getPublicFixture` needs three slugs. `publicFixtureSlugs` reads them through the `public_*_v` views — the same visibility filter `fixtureRealtimeEligible` already uses (`data.ts:952-961`) — then the existing `getPublicFixture` runs unchanged, so its `["pub-fixture", fixtureId]` cache key and `divisionTag` are untouched. No overload, no second query path for the fixture itself.

- [ ] **Step 1: Write the failing dictionary-coverage test.** Create `apps/web/src/lib/__tests__/overlay-dict-coverage.test.ts`:

```ts
// Every `overlay.*` / `stream.*` key the source actually references exists in
// all four locales (R14). The key list is DERIVED FROM THE SOURCE, never typed
// here: a typed list drifts the moment a component adds a key, and then the
// test proves only that the list matches itself.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..");
const DICT = join(SRC, "dictionaries");
const LOCALES = ["en", "fr", "es", "nl"] as const;

const SCAN_DIRS = [
  join(SRC, "components", "overlay"),
  join(SRC, "components", "v2"),
  join(SRC, "lib"),
  join(SRC, "app", "overlay"),
  join(SRC, "app", "(public)"),
];

function files(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out = out.concat(files(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every string literal in the source that looks like one of this wave's keys.
 *  Deliberately a literal scan: a key built by concatenation would be missed,
 *  which is why the model builds none (see `headerContext`'s explicit switch). */
function referencedKeys(prefix: string): Set<string> {
  const re = new RegExp(`["'\`](${prefix}\\.[A-Za-z0-9_.]+)["'\`]`, "g");
  const found = new Set<string>();
  for (const dir of SCAN_DIRS) {
    for (const file of files(dir)) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(re)) found.add(m[1]!);
    }
  }
  return found;
}

const dictOf = (locale: string, ns: string): Record<string, string> =>
  JSON.parse(readFileSync(join(DICT, locale, `${ns}.json`), "utf8"));

describe("overlay + panel copy is complete in every locale", () => {
  it("finds the keys at all — a scan that matched nothing would pass vacuously", () => {
    expect(referencedKeys("overlay").size).toBeGreaterThanOrEqual(8);
    expect(referencedKeys("stream").size).toBeGreaterThanOrEqual(12);
  });

  for (const locale of LOCALES) {
    it(`${locale}/public.json carries every overlay.* key the source uses`, () => {
      const dict = dictOf(locale, "public");
      const missing = [...referencedKeys("overlay")].filter((k) => typeof dict[k] !== "string").sort();
      expect(missing, `${locale} is missing these overlay keys`).toEqual([]);
    });

    it(`${locale}/ui.json carries every stream.* key the source uses`, () => {
      const dict = dictOf(locale, "ui");
      const missing = [...referencedKeys("stream")].filter((k) => typeof dict[k] !== "string").sort();
      expect(missing, `${locale} is missing these stream keys`).toEqual([]);
    });
  }

  it("no locale carries an overlay/stream key en has dropped", () => {
    const en = { ...dictOf("en", "public"), ...dictOf("en", "ui") };
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      const other = { ...dictOf(locale, "public"), ...dictOf(locale, "ui") };
      const orphans = Object.keys(other)
        .filter((k) => (k.startsWith("overlay.") || k.startsWith("stream.")) && !(k in en))
        .sort();
      expect(orphans, `${locale} has keys en does not`).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-dict-coverage.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t5a-red.json`
  Expected: `finds the keys at all` fails — `expected +0 to be greater than or equal to 8` (nothing references an `overlay.*` key yet; `overlay-model.ts` uses them but lives under `lib/` and is scanned, so the count will be non-zero once Task 2 landed — in that case the failing case is the per-locale one, `expected [ 'overlay.chase.need', … ] to deeply equal []`). Read the JSON to see which.

- [ ] **Step 3: Add the overlay copy in all four locales.** Add to `apps/web/src/dictionaries/en/public.json`:

```json
  "overlay.header.live": "Live",
  "overlay.header.ended": "Ended",
  "overlay.header.notStarted": "Not started",
  "overlay.header.set": "Set {n}",
  "overlay.header.game": "Game {n}",
  "overlay.detail.serving": "{side} serving",
  "overlay.detail.card": "{side} {card}",
  "overlay.chase.need": "Need {runs}",
  "overlay.brand": "seazn",
  "overlay.watchLive": "Watch live",
  "overlay.replay": "Replay"
```

  `fr/public.json`:

```json
  "overlay.header.live": "En direct",
  "overlay.header.ended": "Terminé",
  "overlay.header.notStarted": "Pas commencé",
  "overlay.header.set": "Set {n}",
  "overlay.header.game": "Jeu {n}",
  "overlay.detail.serving": "{side} au service",
  "overlay.detail.card": "{side} {card}",
  "overlay.chase.need": "Besoin de {runs}",
  "overlay.brand": "seazn",
  "overlay.watchLive": "Regarder en direct",
  "overlay.replay": "Revoir"
```

  `es/public.json`:

```json
  "overlay.header.live": "En directo",
  "overlay.header.ended": "Finalizado",
  "overlay.header.notStarted": "Sin empezar",
  "overlay.header.set": "Set {n}",
  "overlay.header.game": "Juego {n}",
  "overlay.detail.serving": "Saca {side}",
  "overlay.detail.card": "{side} {card}",
  "overlay.chase.need": "Faltan {runs}",
  "overlay.brand": "seazn",
  "overlay.watchLive": "Ver en directo",
  "overlay.replay": "Repetición"
```

  `nl/public.json`:

```json
  "overlay.header.live": "Live",
  "overlay.header.ended": "Afgelopen",
  "overlay.header.notStarted": "Niet begonnen",
  "overlay.header.set": "Set {n}",
  "overlay.header.game": "Game {n}",
  "overlay.detail.serving": "{side} serveert",
  "overlay.detail.card": "{side} {card}",
  "overlay.chase.need": "Nog {runs} nodig",
  "overlay.brand": "seazn",
  "overlay.watchLive": "Live kijken",
  "overlay.replay": "Herhaling"
```

  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && pnpm i18n:gen-keys` and confirm `apps/web/src/lib/i18n-keys.ts` gained the eleven keys (it is GENERATED — never hand-edit it).

- [ ] **Step 4: Add the `.ovl-*` CSS.** Append to `apps/web/src/app/globals.css`, immediately after the `:root { --sport-* }` block (`:1014-1022`). Every value below is `_THEMES.md` §1–§4 and §6 at native 1920×1080 — do not round, do not invent:

```css
/* ─── Stream overlay (W1) ───────────────────────────────────────────────────
   Authored at 1920×1080; the stage scales the whole canvas, so every value
   here is the NATIVE one from _THEMES.md §3 and §4 and none of them are
   responsive. Reads only the seven --sport-* tokens (§2), never a .pad-* rule
   — the pad's classes carry pad layout, and sharing them would couple two
   surfaces that are signed off separately. */
.ovl-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 1920px;
  height: 1080px;
  transform-origin: top left;
  font-variant-numeric: tabular-nums;
  color: var(--sport-ink);
}
.ovl-fit { position: fixed; inset: 0; overflow: hidden; }
.ovl-display { font-family: var(--ps-font-display, var(--font-barlow), "Arial Narrow", system-ui, sans-serif); }
.ovl-label { font-family: var(--font-geist-sans, system-ui, sans-serif); }

/* Theme A — broadcast bar (_THEMES.md §3) */
.ovl-bar { position: absolute; left: 72px; right: 72px; bottom: 54px;
           border-radius: 6px; overflow: hidden;
           box-shadow: 0 21px 66px rgba(0, 0, 0, 0.5); }
.ovl-bar-main { display: flex; align-items: stretch; height: 126px;
                background: var(--sport-board); }
.ovl-live-cell { display: flex; flex-direction: column; justify-content: center;
                 gap: 3px; min-width: 225px; padding: 0 33px;
                 background: var(--sport-board-2); }
.ovl-live-row { display: flex; align-items: center; gap: 12px;
                font-size: 24px; font-weight: 600; letter-spacing: 0.02em; }
.ovl-live-dot { width: 15px; height: 15px; border-radius: 9999px;
                background: #ef4444; box-shadow: 0 0 15px rgba(239, 68, 68, 0.8); }
.ovl-context { font-size: 21px; font-weight: 500;
               color: color-mix(in srgb, var(--sport-ink) 70%, transparent); }
.ovl-team-cell { position: relative; display: flex; align-items: center; gap: 24px;
                 flex: 1 1 auto; min-width: 0; padding: 0 42px; }
.ovl-team-name { font-size: 45px; font-weight: 600; letter-spacing: 0.01em; white-space: nowrap; }
.ovl-team-score { margin-left: auto; font-size: 78px; font-weight: 700; line-height: 1; }
.ovl-team-meta { width: 66px; font-size: 33px; font-weight: 500;
                 color: color-mix(in srgb, var(--sport-ink) 70%, transparent); }
.ovl-divider { width: 1.5px; background: rgba(255, 255, 255, 0.14); }
.ovl-clock-cell { display: flex; align-items: center; padding: 0 33px;
                  font-size: 60px; font-weight: 700; color: var(--sport-led); }
.ovl-brand { display: flex; align-items: center; padding: 0 33px;
             background: var(--sport-board-2); font-size: 30px; font-weight: 600;
             letter-spacing: 0.08em;
             color: color-mix(in srgb, var(--sport-ink) 75%, transparent); }
.ovl-detail-band { display: flex; align-items: center; gap: 33px; height: 51px;
                   padding: 0 33px; font-size: 24px; font-weight: 500;
                   background: color-mix(in srgb, var(--sport-board) 90%, transparent);
                   color: color-mix(in srgb, var(--sport-ink) 92%, transparent); }
.ovl-detail-sep { width: 1.5px; height: 24px; background: rgba(255, 255, 255, 0.2); }
.ovl-detail-emphasis { font-weight: 600; color: var(--sport-ink); }

/* Theme B — corner bug (_THEMES.md §4) */
.ovl-bug { position: absolute; left: 60px; top: 54px; width: 480px;
           border-radius: 12px; overflow: hidden;
           background: var(--sport-board);
           box-shadow: 0 21px 66px rgba(0, 0, 0, 0.5); }
.ovl-bug-header { display: flex; align-items: center; gap: 12px; height: 48px;
                  padding: 0 21px; background: var(--sport-board-2);
                  font-size: 21px; font-weight: 600; }
.ovl-bug-header .ovl-live-dot { width: 13.5px; height: 13.5px; }
.ovl-bug-context { font-size: 19.5px; font-weight: 500;
                   color: color-mix(in srgb, var(--sport-ink) 65%, transparent); }
.ovl-bug-brand { margin-left: auto; font-size: 24px; font-weight: 600;
                 letter-spacing: 0.08em;
                 color: color-mix(in srgb, var(--sport-ink) 70%, transparent); }
.ovl-bug-row { position: relative; display: flex; align-items: center; gap: 18px;
               height: 90px; padding: 0 24px; }
.ovl-bug-code { width: 96px; font-size: 48px; font-weight: 600; }
.ovl-bug-cells { display: flex; gap: 18px; font-size: 39px; font-weight: 600;
                 color: color-mix(in srgb, var(--sport-ink) 70%, transparent); }
.ovl-bug-cell-current { font-weight: 700; color: var(--sport-ink); }
.ovl-bug-score { margin-left: auto; font-size: 69px; font-weight: 700; line-height: 1; }
.ovl-bug-meta { width: 78px; text-align: right; font-size: 30px; font-weight: 500;
                color: color-mix(in srgb, var(--sport-ink) 65%, transparent); }
.ovl-bug-footer { display: flex; align-items: center; justify-content: space-between;
                  height: 45px; padding: 0 24px; font-size: 21px; font-weight: 500;
                  color: color-mix(in srgb, var(--sport-ink) 85%, transparent); }

/* The side in play (both themes): board-2 ground, an LED bar, an LED score. */
.ovl-side-led { background: var(--sport-board-2); }
.ovl-side-led .ovl-team-score,
.ovl-side-led .ovl-bug-score { color: var(--sport-led); }
.ovl-led { position: absolute; background: var(--sport-led);
           transition: transform 200ms ease-in-out; }
.ovl-bar .ovl-led { left: 0; right: 0; bottom: 0; height: 8px; }
.ovl-bug .ovl-led { left: 0; top: 0; bottom: 0; width: 8px; }
.ovl-serve-dot { width: 10.5px; height: 10.5px; border-radius: 9999px;
                 background: var(--sport-led); }

/* Motion — _THEMES.md §6, R13. transform/opacity only; nothing on mount. */
@keyframes ovl-tick { 0% { transform: scale(1); } 45% { transform: scale(1.12); } 100% { transform: scale(1); } }
@keyframes ovl-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
.ovl-tick { animation: ovl-tick 300ms ease-out; }
.ovl-live-dot { animation: ovl-breathe 2s ease-in-out infinite; }
.ovl-static .ovl-live-dot { animation: none; opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .ovl-tick { animation: none; }
  .ovl-live-dot { animation: none; opacity: 1; }
  .ovl-led { transition: none; }
}

/* The overlay segment is a chrome-less page inside the root layout, which
   mounts the consent banner after `children`. OBS composites whatever is
   painted, so the banner would go out on air. */
body:has(.ovl-canvas) [data-testid="cookie-consent"] { display: none !important; }
```

  and add the testid the last rule needs — in `apps/web/src/components/cookie-consent.tsx:84`, the wrapper `<div>` gains `data-testid="cookie-consent"` beside its `className` (attribute only; no other change to that file).

- [ ] **Step 5: Add the slug helper.** In `apps/web/src/server/public-site/data.ts`, after `getPublicFixture` (`:747`):

```ts
/**
 * org / competition / division slugs for a fixture id.
 *
 * The stream-overlay URL carries only a fixture id, but `getPublicFixture`
 * above is keyed on three slugs (and must stay that way — its cache key and
 * its `divisionTag` are shared with the public match page). This resolves them
 * through the SAME `public_*_v` views `fixtureRealtimeEligible` uses (`:952`),
 * so a fixture in a private competition is simply not found here, exactly as
 * it is not found there. Null means 404 for the caller — never a partial.
 */
export async function publicFixtureSlugs(
  fixtureId: string,
): Promise<{ orgSlug: string; compSlug: string; divSlug: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) return null;
  const [row] = await sql<{ org_slug: string; comp_slug: string; div_slug: string }[]>`
    select o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug
    from public_fixtures_v f
    join public_divisions_v d on d.id = f.division_id
    join public_competitions_v c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where f.id = ${fixtureId} limit 1`;
  if (!row) return null;
  return { orgSlug: row.org_slug, compSlug: row.comp_slug, divSlug: row.div_slug };
}
```

- [ ] **Step 6: Write the layout.** Create `apps/web/src/app/overlay/fixtures/[fixtureId]/layout.tsx`:

```tsx
// The overlay segment's chrome-less shell. A NESTED layout cannot emit
// <html>/<body> — `app/layout.tsx:54` owns the only one, and
// `slideshow/layout.tsx:20` / `embed/layout.tsx:26` are the two precedents for
// returning a <div> instead — so the transparent ground is set by a <style>
// element scoped to this segment rather than by a prop. OBS composites the
// page over the camera, so anything painted here goes on air: no header, no
// footer, no attribution link, and the root layout's consent banner is
// suppressed by the `body:has(.ovl-canvas)` rule in globals.css.
import { Barlow_Condensed } from "next/font/google";

// Its own next/font instance, mounted on this div exactly as the public tree
// does (`(public)/shared/[orgSlug]/layout.tsx:19-23,60`). 800 is here for W2's
// slab headline (_THEMES.md §1); the same woff2 files back every instance, so
// this is a second CSS variable, not a second download path — watch-list 7 is
// verified in Step 12 by reading the built CSS, not assumed.
const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700", "800"],
  subsets: ["latin"],
  variable: "--ps-font-display",
});

export default function OverlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={displayFont.variable}>
      <style>{"html,body{background:transparent;margin:0}"}</style>
      {children}
    </div>
  );
}
```

- [ ] **Step 7: Write the page.** Create `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx`:

```tsx
// The transparent per-fixture overlay a club adds to OBS as a Browser source.
//
// Two gates, both server-side, both `notFound()` so a non-entitled org is
// indistinguishable from a missing fixture (R1): the public visibility rules
// (via `publicFixtureSlugs` + `getPublicFixture`, the same reads the public
// match page makes) and the `streaming.overlay` entitlement. The client never
// decides. No redirect anywhere on this route (R8).
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicFixture, publicFixtureSlugs } from "@/server/public-site/data";
import { hasFeature } from "@/lib/entitlements";
import { getDictionary } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { OverlayStage, overlayStyleFor } from "@/components/overlay/overlay-stage";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// ISR on the same window as the public match page; the live numbers come from
// the client transport, not from a rerender.
export const revalidate = 30;
export async function generateStaticParams() {
  return [];
}

type Params = { fixtureId: string };
type Query = { style?: string; lang?: string };

export default async function OverlayPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}) {
  const { fixtureId } = await params;
  const { style, lang } = await searchParams;

  const slugs = await publicFixtureSlugs(fixtureId);
  if (!slugs) notFound();
  const data = await getPublicFixture(slugs.orgSlug, slugs.compSlug, slugs.divSlug, fixtureId);
  if (!data) notFound();
  const { org, competition, division, fixture, entrantNames, realtime } = data;

  // Competition-scoped, like every other spectator-side entitlement read here:
  // an Event Pass grants for the competition it was bought for.
  if (!(await hasFeature(org.id, "streaming.overlay", competition.id))) notFound();

  // `?lang` wins for a club broadcasting in a language other than the org's
  // own public locale; the org's default is the fallback, as on every public
  // surface.
  const locale = toLocale(lang ?? org.default_locale);
  const dict = (await getDictionary(locale, "public")) as Record<string, string>;

  const sides: [
    { id: string; name: string },
    { id: string; name: string },
  ] = [
    {
      id: fixture.home_entrant_id ?? "home",
      name: fixture.home_entrant_id ? (entrantNames[fixture.home_entrant_id] ?? "—") : "—",
    },
    {
      id: fixture.away_entrant_id ?? "away",
      name: fixture.away_entrant_id ? (entrantNames[fixture.away_entrant_id] ?? "—") : "—",
    },
  ];

  // Formatted HERE, where the locale and the venue zone both are; the model
  // stays pure and free of Intl (see overlay-model.ts's own note).
  const startLabel = fixture.scheduled_at
    ? new Intl.DateTimeFormat(locale, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(new Date(fixture.scheduled_at))
    : null;

  return (
    <OverlayStage
      fixtureId={fixture.id}
      initial={{ status: fixture.status, summary: fixture.summary, outcome: fixture.outcome }}
      realtime={realtime}
      sportKey={division.sport_key}
      style={overlayStyleFor(division.sport_key, style)}
      sides={sides}
      startLabel={startLabel}
      dict={dict}
      decidedTemplates={decidedOutcomeTemplates((k, v) => msgFor(locale, k, v))}
      fit
    />
  );
}
```

> **Recorded gap:** `startLabel` formats in `UTC`, not the venue zone. `PublicFixture` carries `venue_name`/`court_name` but no IANA zone, and `getScheduleSettings` (the competition tz) is an ORG-console read behind `AuthCtx` — an unauthenticated overlay cannot call it. Threading a public tz is a data change outside this wave's scope. Recorded in `_INDEX.md` as an owner question; the scheduled state is the only one affected.

- [ ] **Step 8: Write the stage.** Create `apps/web/src/components/overlay/overlay-stage.tsx`:

```tsx
"use client";
// The overlay's one client island: transport + projection + the three motions.
//
// Authored at a fixed 1920×1080 canvas and scaled with
// `transform: scale(min(vw/1920, vh/1080))` from the top-left (R15), so OBS at
// 1080p renders 1:1 and the organiser panel's preview renders THE SAME
// COMPONENT at a smaller scale rather than a picture of it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sportThemeAttr, sportThemeStyle } from "@/components/v2/scorepad/v3/sport-theme";
import { useLiveFixture } from "@/components/public-site/use-live-fixture";
import type { LiveFixtureData } from "@/components/public-site/live-score-data";
import { overlayModel, type OverlayModel, type OverlaySideInput } from "@/lib/overlay-model";
import { t } from "@/lib/i18n-runtime";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { OverlayBar } from "./overlay-bar";
import { OverlayBug } from "./overlay-bug";

export type OverlayStyle = "bar" | "bug";

/** R2: cricket opens on the bar, every other sport on the bug; an unknown
 *  `?style=` value falls to that default rather than erroring — a broken query
 *  string must never take a club off air. */
export function overlayStyleFor(sportKey: string, requested: string | undefined): OverlayStyle {
  if (requested === "bar" || requested === "bug") return requested;
  return sportKey === "cricket" ? "bar" : "bug";
}

export interface OverlayStageProps {
  fixtureId: string;
  initial: LiveFixtureData;
  realtime: boolean;
  sportKey: string;
  style: OverlayStyle;
  sides: [OverlaySideInput, OverlaySideInput];
  startLabel: string | null;
  /** The `public` namespace, en-merged server-side. A plain object, so the
   *  island carries only the active locale. */
  dict: Record<string, string>;
  decidedTemplates: DecidedOutcomeTemplates;
  /** True on the overlay route: fill the viewport. False in the console
   *  preview, which sets its own scale on the wrapper. */
  fit?: boolean;
}

/** The previous render's value, for the tick comparison. A ref, not state:
 *  the comparison must not itself cause a render (R13 — nothing animates on
 *  mount, and a render loop would restart the animation every frame). */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

export function OverlayStage(props: OverlayStageProps) {
  const { data } = useLiveFixture(props.fixtureId, props.initial, props.realtime);

  const model: OverlayModel = overlayModel({
    sportKey: props.sportKey,
    data,
    sides: props.sides,
    startLabel: props.startLabel,
    msg: (key, vars) => t(props.dict, key, vars),
    decidedTemplates: props.decidedTemplates,
  });

  // Score tick: the ONE `big` that changed, and only that one (R13). Held in
  // state and cleared on a 300 ms timer so re-adding the class re-triggers the
  // animation; a bare CSS class on a value that changes twice inside 300 ms
  // would not restart it.
  const previous = usePrevious(model.sides.map((s) => s.big).join(" "));
  const [tick, setTick] = useState<[boolean, boolean]>([false, false]);
  useEffect(() => {
    if (previous === undefined) return; // never on mount — OBS shows the page mid-stream
    const before = previous.split(" ");
    const next: [boolean, boolean] = [
      before[0] !== model.sides[0].big,
      before[1] !== model.sides[1].big,
    ];
    if (!next[0] && !next[1]) return;
    setTick(next);
    const timer = setTimeout(() => setTick([false, false]), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.sides[0].big, model.sides[1].big]);

  // Canvas scale. useLayoutEffect so the first paint is already at the right
  // size — a visible resize would be an entrance animation, which R13 forbids.
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    if (!props.fit) return;
    const measure = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [props.fit]);

  return (
    <div className={props.fit ? "ovl-fit" : undefined}>
      <div
        data-testid="ovl-root"
        data-style={props.style}
        data-sport-theme={sportThemeAttr(props.sportKey)}
        data-led={model.sides[0].led ? "home" : model.sides[1].led ? "away" : "none"}
        className={`ovl-canvas ovl-label${model.live ? "" : " ovl-static"}`}
        style={{ ...sportThemeStyle(props.sportKey), transform: `scale(${scale})` }}
      >
        {props.style === "bar" ? (
          <OverlayBar model={model} tick={tick} />
        ) : (
          <OverlayBug model={model} tick={tick} />
        )}
        {/* W2's slab attaches here (R4). Empty and unstyled in W1. */}
        <div data-testid="ovl-moment-slot" />
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Write the two skins.** Create `apps/web/src/components/overlay/overlay-bar.tsx`:

```tsx
"use client";
// Theme A — the TV lower third (_THEMES.md §3). Every size, colour and inset
// is a class in globals.css's `.ovl-*` block, which carries the sheet's native
// values; nothing is styled inline here except the LED bar's slide, which is a
// transform the CSS transitions.
import type { OverlayModel } from "@/lib/overlay-model";

export function OverlayBar({ model, tick }: { model: OverlayModel; tick: [boolean, boolean] }) {
  return (
    <div className="ovl-bar">
      <div className="ovl-bar-main">
        <div className="ovl-live-cell">
          <span className="ovl-live-row">
            {model.live ? <span data-testid="ovl-live-dot" className="ovl-live-dot" /> : null}
            {model.header.context}
          </span>
          {model.cells.length > 0 ? (
            <span data-testid="ovl-cells" className="ovl-context">
              {model.cells.map((c) => c.value).join("  ")}
            </span>
          ) : null}
        </div>
        {([0, 1] as const).map((row) => {
          const side = model.sides[row];
          return (
            <div
              key={side.short + row}
              data-testid={row === 0 ? "ovl-side-home" : "ovl-side-away"}
              className={`ovl-team-cell ovl-display${side.led ? " ovl-side-led" : ""}`}
            >
              {side.serving ? <span className="ovl-serve-dot" /> : null}
              <span className="ovl-team-name">{side.name}</span>
              <span
                data-testid={row === 0 ? "ovl-big-home" : "ovl-big-away"}
                className={`ovl-team-score${tick[row] ? " ovl-tick" : ""}`}
              >
                {side.big}
              </span>
              <span className="ovl-team-meta">{side.sub ?? ""}</span>
              {side.led ? <span data-testid="ovl-led" className="ovl-led" /> : null}
            </div>
          );
        })}
        {model.header.clock ? <div className="ovl-clock-cell ovl-display">{model.header.clock}</div> : null}
        <div className="ovl-brand ovl-display">seazn</div>
      </div>
      {model.detail.length > 0 || model.chase || model.result ? (
        <div data-testid="ovl-detail" className="ovl-detail-band">
          {model.result ? (
            <span data-testid="ovl-result" className="ovl-detail-emphasis">{model.result}</span>
          ) : model.chase ? (
            <span data-testid="ovl-chase" className="ovl-detail-emphasis">{model.chase}</span>
          ) : null}
          {model.detail.map((line, i) => (
            <span key={line + i} className="contents">
              {i > 0 || model.chase || model.result ? <span className="ovl-detail-sep" /> : null}
              <span>{line}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

  and `apps/web/src/components/overlay/overlay-bug.tsx`:

```tsx
"use client";
// Theme B — the corner bug (_THEMES.md §4), the pad's own stadium-night tile
// so the stream matches the app. `cells[].value` is always "home–away" by
// construction in `overlayModel`, so each row renders its own half of it —
// that split lives here, in the renderer, rather than widening the model.
import type { OverlayModel } from "@/lib/overlay-model";

const halfOf = (value: string, row: 0 | 1): string => {
  const parts = value.split("–");
  return parts[row] ?? value;
};

export function OverlayBug({ model, tick }: { model: OverlayModel; tick: [boolean, boolean] }) {
  return (
    <div className="ovl-bug">
      <div className="ovl-bug-header">
        {model.live ? <span data-testid="ovl-live-dot" className="ovl-live-dot" /> : null}
        <span className="ovl-bug-context">{model.header.context}</span>
        {model.header.clock ? (
          <span className="ovl-bug-brand ovl-display" style={{ color: "var(--sport-led)" }}>
            {model.header.clock}
          </span>
        ) : (
          <span className="ovl-bug-brand ovl-display">seazn</span>
        )}
      </div>
      {([0, 1] as const).map((row) => {
        const side = model.sides[row];
        return (
          <div
            key={side.short + row}
            data-testid={row === 0 ? "ovl-side-home" : "ovl-side-away"}
            className={`ovl-bug-row ovl-display${side.led ? " ovl-side-led" : ""}`}
          >
            {side.led ? <span data-testid="ovl-led" className="ovl-led" /> : null}
            <span className="ovl-bug-code">{side.short}</span>
            {side.serving ? <span className="ovl-serve-dot" /> : null}
            {model.cells.length > 0 ? (
              <span data-testid="ovl-cells" className="ovl-bug-cells">
                {model.cells.map((cell, i) => (
                  <span key={cell.key} className={i === model.cells.length - 1 ? "ovl-bug-cell-current" : undefined}>
                    {halfOf(cell.value, row)}
                  </span>
                ))}
              </span>
            ) : null}
            <span
              data-testid={row === 0 ? "ovl-big-home" : "ovl-big-away"}
              className={`ovl-bug-score${tick[row] ? " ovl-tick" : ""}`}
            >
              {side.big}
            </span>
            <span className="ovl-bug-meta">{side.sub ?? ""}</span>
          </div>
        );
      })}
      {model.result || model.chase || model.detail.length > 0 ? (
        <div data-testid="ovl-detail" className="ovl-bug-footer ovl-label">
          {model.result ? (
            <span data-testid="ovl-result" className="ovl-detail-emphasis">{model.result}</span>
          ) : model.chase ? (
            <span data-testid="ovl-chase" className="ovl-detail-emphasis">{model.chase}</span>
          ) : null}
          <span>{model.detail.join(" · ")}</span>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 10: Add the contrast gate.** Create `apps/web/src/components/overlay/__tests__/contrast.test.ts`, the same method `scorepad/v3/__tests__/contrast.test.ts` uses, over the pairs `_THEMES.md` §2 names:

```ts
// _THEMES.md §2: every ink-on-board and LED-on-board pair the overlay paints
// clears WCAG AA (4.5:1 for text, 3:1 for the LED bar, which is a graphical
// object). Driven off `resolveSportPalette` so the table cannot drift from
// `SPORT_PALETTES` — a hand-typed hex here would only prove the hex.
import { describe, expect, it } from "vitest";
import { resolveSportPalette } from "@/components/v2/scorepad/v3/sport-theme";
import { V3_SKINS } from "@/components/v2/scorepad/v3/registry";

const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a six-digit hex: ${hex}`);
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => channel(c / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe("overlay contrast", () => {
  const keys = Object.keys(V3_SKINS).sort();

  it("covers every skin — a zero-length sweep would pass vacuously", () => {
    expect(keys.length).toBe(11);
  });

  it.each(Object.keys(V3_SKINS).sort())("%s: ink on board reads as text", (key) => {
    const p = resolveSportPalette(key);
    expect(ratio(p.ink, p.board)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Object.keys(V3_SKINS).sort())("%s: ink on board-2 reads as text", (key) => {
    const p = resolveSportPalette(key);
    expect(ratio(p.ink, p["board-2"])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Object.keys(V3_SKINS).sort())("%s: the LED bar clears the graphical floor on board", (key) => {
    const p = resolveSportPalette(key);
    expect(ratio(p.led, p.board)).toBeGreaterThanOrEqual(3);
  });

  it.each(Object.keys(V3_SKINS).sort())("%s: LED-on-board is legible as the score numeral too", (key) => {
    const p = resolveSportPalette(key);
    expect(ratio(p.led, p["board-2"])).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 11: Run the unit gate — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-dict-coverage.test.ts src/components/overlay --reporter=json --outputFile=/tmp/ovl-w1/t5-green.json`
  Expected: `numFailedTests: 0`; dict coverage contributes 10 tests, contrast 45. If a contrast case reds, that is a REAL finding about `SPORT_PALETTES` on a new surface — record it for the owner and raise the floor question; do NOT lower the threshold.

- [ ] **Step 12: Drive the product, not the test.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label ovl`, re-read the port from `_buildManifest.js`, seed a cricket fixture and set the override row, then open `/overlay/fixtures/<id>?style=bar` in a real browser at 1920×1080. Write down, beside a pass/fail: the body is see-through over a light AND a dark frame; the score numerals are aligned; a 43-character entrant name does not wrap; the LED sits on the batting side; the live dot breathes; nothing slid in on load. Then check watch-list 7: `curl -s <base>/_next/static/css/*.css | grep -ac "Barlow"` and the browser network tab — record whether a second `@font-face` and a second woff2 download appear.

- [ ] **Step 13: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/app/overlay apps/web/src/components/overlay apps/web/src/app/globals.css apps/web/src/components/cookie-consent.tsx apps/web/src/server/public-site/data.ts apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts apps/web/src/lib/__tests__/overlay-dict-coverage.test.ts`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(route): the transparent per-fixture page, in the sport's own colours" -m "Nested layout for the transparent ground, two server gates that both 404, one client stage scaling a native 1920x1080 canvas, and the three motions from _THEMES.md 6. Copy in four locales." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 6: The organiser panel, and the two props that reach it

**Files:**
- Create: `apps/web/src/components/v2/fixture-stream-panel.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` — `Props` (`:144-146`), the destructure (`:399`), the three `<FixtureLine>` call sites (`:1072-1085`, `:1115-1128`, `:1167-1180`), `FixtureLine`'s own signature (`:1579-1604`), and ONE conditional line beside the schedule toggle (`:1747`)
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` — the `Promise.all` (`:124-138`) and the `<StagesPanel>` mount (`:596`)
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json`
- Modify (generated): `apps/web/src/lib/i18n-keys.ts`

**Interfaces:**
- Consumes: `useMsg(): (key: MessageKey, vars?) => string` (`components/i18n/dict-provider.tsx:113`); `streamUrlSchema` (Task 3); `OverlayStage`, `overlayStyleFor`, `OverlayStyle` (Task 5); `fetchLiveFixture` (`live-score-data.ts:30`); `decidedOutcomeTemplates` — NOT available client-side with a dictionary, so the panel passes a templates object built from `useMsg` (a `MsgFn`, ui keys — the same call the server makes).
- Produces:
  - `export interface FixtureStreamPanelProps { fixtureId: string; sportKey: string; homeName: string; awayName: string; homeEntrantId: string; awayEntrantId: string; initialStreamUrl: string | null }`
  - `export function FixtureStreamPanel(props: FixtureStreamPanelProps): JSX.Element`
  - `StagesPanel` `Props` gains `sportKey: string; streamingEntitled: boolean`
  - `FixtureLine`'s prop object gains `sportKey: string; streamingEntitled: boolean`

> **Ruling applied (wave prompt scope 6, over the spec):** the toggle's gate is `canEdit && streamingEntitled` — **not** the schedule toggle's `fixture.status === "scheduled"`. A club pastes the replay link after the final whistle, so copying that gate would hide the panel exactly when it is wanted.

- [ ] **Step 1: Add the panel copy in all four locales.** `apps/web/src/dictionaries/en/ui.json` (the `embed.*` block at `:419-421` is the copy-button precedent):

```json
  "stream.toggle.open": "Stream",
  "stream.toggle.close": "Close",
  "stream.title": "Stream this match",
  "stream.lead": "Put the live score inside your own broadcast. The video stays on your channel.",
  "stream.tab.bar": "Broadcast bar",
  "stream.tab.bug": "Corner bug",
  "stream.preview.label": "Preview",
  "stream.link.label": "Overlay link",
  "stream.link.copy": "Copy",
  "stream.link.copied": "Copied",
  "stream.step1": "In OBS, add a Browser source with this link at 1920 × 1080.",
  "stream.step2": "Drag it above your camera — the background is transparent.",
  "stream.step3": "Start streaming, then paste your stream link below.",
  "stream.url.label": "Stream link",
  "stream.url.hint": "YouTube, Facebook, Twitch or Kick.",
  "stream.save": "Save link",
  "stream.saved": "Saved",
  "stream.error.invalid": "Use an https link to YouTube, Facebook, Twitch or Kick.",
  "stream.error.save": "Could not save the link. Try again.",
  "stream.codeNote": "Teams show as the first three letters of their name."
```

  `fr/ui.json`:

```json
  "stream.toggle.open": "Diffusion",
  "stream.toggle.close": "Fermer",
  "stream.title": "Diffuser ce match",
  "stream.lead": "Affichez le score en direct dans votre propre diffusion. La vidéo reste sur votre chaîne.",
  "stream.tab.bar": "Bandeau",
  "stream.tab.bug": "Vignette",
  "stream.preview.label": "Aperçu",
  "stream.link.label": "Lien de l'incrustation",
  "stream.link.copy": "Copier",
  "stream.link.copied": "Copié",
  "stream.step1": "Dans OBS, ajoutez une source Navigateur avec ce lien en 1920 × 1080.",
  "stream.step2": "Placez-la au-dessus de la caméra — le fond est transparent.",
  "stream.step3": "Lancez la diffusion, puis collez le lien ci-dessous.",
  "stream.url.label": "Lien de diffusion",
  "stream.url.hint": "YouTube, Facebook, Twitch ou Kick.",
  "stream.save": "Enregistrer",
  "stream.saved": "Enregistré",
  "stream.error.invalid": "Utilisez un lien https vers YouTube, Facebook, Twitch ou Kick.",
  "stream.error.save": "Enregistrement impossible. Réessayez.",
  "stream.codeNote": "Les équipes apparaissent avec les trois premières lettres de leur nom."
```

  `es/ui.json`:

```json
  "stream.toggle.open": "Emisión",
  "stream.toggle.close": "Cerrar",
  "stream.title": "Emitir este partido",
  "stream.lead": "Muestra el marcador en directo dentro de tu propia emisión. El vídeo se queda en tu canal.",
  "stream.tab.bar": "Banda inferior",
  "stream.tab.bug": "Mosca",
  "stream.preview.label": "Vista previa",
  "stream.link.label": "Enlace de la sobreimpresión",
  "stream.link.copy": "Copiar",
  "stream.link.copied": "Copiado",
  "stream.step1": "En OBS, añade una fuente de Navegador con este enlace a 1920 × 1080.",
  "stream.step2": "Colócala encima de la cámara: el fondo es transparente.",
  "stream.step3": "Empieza a emitir y pega aquí el enlace de tu emisión.",
  "stream.url.label": "Enlace de emisión",
  "stream.url.hint": "YouTube, Facebook, Twitch o Kick.",
  "stream.save": "Guardar enlace",
  "stream.saved": "Guardado",
  "stream.error.invalid": "Usa un enlace https a YouTube, Facebook, Twitch o Kick.",
  "stream.error.save": "No se pudo guardar el enlace. Inténtalo de nuevo.",
  "stream.codeNote": "Los equipos se muestran con las tres primeras letras de su nombre."
```

  `nl/ui.json`:

```json
  "stream.toggle.open": "Stream",
  "stream.toggle.close": "Sluiten",
  "stream.title": "Deze wedstrijd streamen",
  "stream.lead": "Zet de live stand in je eigen uitzending. De video blijft op je eigen kanaal.",
  "stream.tab.bar": "Onderbalk",
  "stream.tab.bug": "Hoektegel",
  "stream.preview.label": "Voorbeeld",
  "stream.link.label": "Overlaylink",
  "stream.link.copy": "Kopiëren",
  "stream.link.copied": "Gekopieerd",
  "stream.step1": "Voeg in OBS een Browser-bron toe met deze link op 1920 × 1080.",
  "stream.step2": "Sleep hem boven je camera — de achtergrond is transparant.",
  "stream.step3": "Start de stream en plak hieronder je streamlink.",
  "stream.url.label": "Streamlink",
  "stream.url.hint": "YouTube, Facebook, Twitch of Kick.",
  "stream.save": "Link opslaan",
  "stream.saved": "Opgeslagen",
  "stream.error.invalid": "Gebruik een https-link naar YouTube, Facebook, Twitch of Kick.",
  "stream.error.save": "Opslaan is niet gelukt. Probeer het opnieuw.",
  "stream.codeNote": "Teams worden getoond met de eerste drie letters van hun naam."
```

  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && pnpm i18n:gen-keys`.

- [ ] **Step 2: Run the dictionary gate — expect red, then green.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/overlay-dict-coverage.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t6a.json`
  Before Step 1 this reds on `finds the keys at all` (`expected +0 to be greater than or equal to 12`) once the panel exists and references them; run it AFTER the panel (Step 3) if you want the honest red. Expected after both: `numFailedTests: 0`, and `pnpm i18n:gen-keys` leaves no further diff.

- [ ] **Step 3: Write the panel.** Create `apps/web/src/components/v2/fixture-stream-panel.tsx`:

```tsx
"use client";
// "Stream this match" — the organiser's whole job, on the fixture row of the
// division's fixtures tab (R12: that tab IS the owner's "Fixture Console").
//
// Design tokens: _THEMES.md §8. Phone first (R15): one column at 320 with every
// control full width and 44 px tall; at ≥ 768 the copy button moves INSIDE the
// link field. One DOM, branched with `max-md:*` / `md:*` — never a second tree,
// and the control SET is identical at both ends.
//
// Imports `streamUrlSchema` from `@/lib/stream-url`, never from `@/server/**`
// (a client component importing @/server is a build failure).
import { useEffect, useState } from "react";
import { Video } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { streamUrlSchema } from "@/lib/stream-url";
import { fetchLiveFixture, type LiveFixtureData } from "@/components/public-site/live-score-data";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { OverlayStage, overlayStyleFor, type OverlayStyle } from "@/components/overlay/overlay-stage";
import { messages } from "@/lib/messages";

export interface FixtureStreamPanelProps {
  fixtureId: string;
  sportKey: string;
  homeEntrantId: string;
  awayEntrantId: string;
  homeName: string;
  awayName: string;
  initialStreamUrl: string | null;
}

const EMPTY: LiveFixtureData = { status: "scheduled", summary: null, outcome: null };

export function FixtureStreamPanel(props: FixtureStreamPanelProps) {
  const msg = useMsg();
  const [style, setStyle] = useState<OverlayStyle>(() => overlayStyleFor(props.sportKey, undefined));
  const [url, setUrl] = useState(props.initialStreamUrl ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [live, setLive] = useState<LiveFixtureData>(EMPTY);

  // The preview shows THE FIXTURE'S OWN current score, not a mock — the whole
  // point of previewing the real component. One fetch; the stage's own
  // transport keeps it moving from there.
  useEffect(() => {
    let cancelled = false;
    void fetchLiveFixture(props.fixtureId)
      .then((data) => {
        if (!cancelled) setLive(data);
      })
      .catch(() => {
        // the preview falls back to the not-started composition
      });
    return () => {
      cancelled = true;
    };
  }, [props.fixtureId]);

  const overlayUrl =
    typeof window === "undefined"
      ? `/overlay/fixtures/${props.fixtureId}?style=${style}`
      : `${window.location.origin}/overlay/fixtures/${props.fixtureId}?style=${style}`;

  async function save() {
    setError(null);
    setSaved(false);
    const parsed = streamUrlSchema.safeParse(url);
    if (!parsed.success) {
      setError(msg("stream.error.invalid"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/fixtures/${props.fixtureId}/stream`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamUrl: parsed.data }),
      });
      const json = (await res.json()) as { ok?: boolean };
      if (!res.ok || json.ok === false) throw new Error("save failed");
      setSaved(true);
    } catch {
      setError(msg("stream.error.save"));
    } finally {
      setBusy(false);
    }
  }

  const tab = (value: OverlayStyle, label: string, testid: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={style === value}
      data-testid={testid}
      onClick={() => setStyle(value)}
      className={`min-h-11 rounded-md px-2.5 py-1 text-xs font-medium max-md:w-full md:min-h-0 ${
        style === value
          ? "bg-purple-100 text-purple-800"
          : "text-slate-500 hover:bg-purple-50 hover:text-purple-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div data-testid="stream-panel" className="card mt-2 p-5">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        <Video aria-hidden size={16} strokeWidth={1.75} className="text-purple-500" />
        {msg("stream.title")}
      </p>
      <p className="mt-1 text-xs text-slate-500">{msg("stream.lead")}</p>

      <div role="tablist" className="mt-3 flex gap-2 max-md:flex-col">
        {tab("bar", msg("stream.tab.bar"), "stream-tab-bar")}
        {tab("bug", msg("stream.tab.bug"), "stream-tab-bug")}
      </div>

      {/* The REAL component at 1/3 scale over a pitch-green stand-in, so the
          organiser sees exactly what OBS will composite (_THEMES.md §8). */}
      <div
        data-testid="stream-preview"
        aria-label={msg("stream.preview.label")}
        className="relative mt-3 h-24 overflow-hidden rounded-lg"
        style={{ background: "linear-gradient(180deg, #3d7a3a, #2e6a2d)" }}
      >
        <div style={{ transform: "scale(0.3333)", transformOrigin: "top left" }}>
          <OverlayStage
            fixtureId={props.fixtureId}
            initial={live}
            realtime={false}
            sportKey={props.sportKey}
            style={style}
            sides={[
              { id: props.homeEntrantId, name: props.homeName },
              { id: props.awayEntrantId, name: props.awayName },
            ]}
            startLabel={null}
            dict={messages as unknown as Record<string, string>}
            decidedTemplates={decidedOutcomeTemplates(msg)}
          />
        </div>
      </div>

      <label className="mt-4 block">
        <span className="label">{msg("stream.link.label")}</span>
        <span className="flex gap-2 max-md:flex-col md:relative">
          <input
            data-testid="stream-link"
            readOnly
            value={overlayUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="min-h-11 w-full min-w-0 rounded-lg border border-purple-100 bg-slate-950 px-3 font-mono text-[11px] text-slate-100 md:h-10 md:min-h-0 md:pr-24"
          />
          <button
            type="button"
            data-testid="stream-copy"
            onClick={() => {
              void navigator.clipboard.writeText(overlayUrl).then(() => setCopied(true));
            }}
            className="btn btn-ghost min-h-11 max-md:w-full md:absolute md:right-1 md:top-1 md:h-7 md:min-h-0 md:px-3 md:text-xs"
          >
            {copied ? msg("stream.link.copied") : msg("stream.link.copy")}
          </button>
        </span>
      </label>

      <ol data-testid="stream-steps" className="mt-4 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-slate-700">
        <li>{msg("stream.step1")}</li>
        <li>{msg("stream.step2")}</li>
        <li>{msg("stream.step3")}</li>
      </ol>

      <label className="mt-4 block">
        <span className="label">{msg("stream.url.label")}</span>
        <input
          data-testid="stream-url-input"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setSaved(false);
            setError(null);
          }}
          className="min-h-11 w-full rounded-lg border border-purple-200 bg-white px-3 text-[13px] text-slate-700 md:h-10 md:min-h-0"
        />
      </label>
      <p className="mt-1 text-[11px] text-slate-500">{msg("stream.url.hint")}</p>
      {error ? (
        <p data-testid="stream-error" role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="stream-save"
        disabled={busy}
        onClick={() => void save()}
        className="btn btn-primary mt-3 min-h-11 max-md:w-full"
      >
        {saved ? msg("stream.saved") : msg("stream.save")}
      </button>
      <p className="mt-3 text-[11px] text-slate-500">{msg("stream.codeNote")}</p>
    </div>
  );
}
```

- [ ] **Step 4: Thread the two props.** In `apps/web/src/components/v2/stages-panel.tsx`:
  - `Props` (after `divSlug: string;` at `:146`):

```ts
  /** The division's sport, from `PublicDivision`/`divisions.sport_key` — the
   *  stream panel themes its preview with it. The panel is the only reader;
   *  this panel had no sport key before (stream overlay W1). */
  sportKey: string;
  /** `hasFeature(orgId, "streaming.overlay")`, resolved server-side by the
   *  division page (R1 — the client never decides). False hides the toggle
   *  entirely; there is no upsell state. */
  streamingEntitled: boolean;
```

  - the destructure (`:399`): add `sportKey, streamingEntitled,` to the parameter list.
  - each of the three `<FixtureLine …>` call sites (`:1072`, `:1115`, `:1167`): add the two lines
    `sportKey={sportKey}` and `streamingEntitled={streamingEntitled}` beside `canEdit={canEdit}`.
  - `FixtureLine`'s destructure and its prop type (`:1579-1604`): add `sportKey,` and `streamingEntitled,` to the destructure and

```ts
  /** Stream overlay W1 — threaded from StagesPanel, which is threaded from the
   *  division page. See that panel's own Props for why neither is derived here. */
  sportKey: string;
  streamingEntitled: boolean;
```

    to the inline type; add `const [streaming, setStreaming] = useState(false);` beside `const [editing, setEditing] = useState(false);`.
  - the ONE import at the top of the file: `import { FixtureStreamPanel } from "./fixture-stream-panel";`
  - the ONE conditional block, immediately after the schedule-toggle button's closing `)}` (`:1753`):

```tsx
          {canEdit && streamingEntitled && (
            <button
              type="button"
              data-testid="fixture-stream-toggle"
              onClick={() => setStreaming(!streaming)}
              className="btn btn-ghost px-3 py-1 text-xs"
            >
              {streaming ? msg("stream.toggle.close") : msg("stream.toggle.open")}
            </button>
          )}
```

    and, immediately after the `{editing && (…)}` block's closing `)}`:

```tsx
      {streaming && (
        <FixtureStreamPanel
          fixtureId={fixture.id}
          sportKey={sportKey}
          homeEntrantId={fixture.home_entrant_id ?? "home"}
          awayEntrantId={fixture.away_entrant_id ?? "away"}
          homeName={home}
          awayName={away}
          initialStreamUrl={null}
        />
      )}
```

- [ ] **Step 5: Feed the props from the division page.** In `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx`, add one entry to the `Promise.all` (`:124-138`) — after `hasFeature(auth.orgId, "exports")`:

```ts
    // Stream overlay W1 (R1): resolved here, server-side, exactly as
    // `embeds.enabled` is at :785 — the panel is absent when false, never an
    // upsell, and the client is told rather than asked to derive it.
    hasFeature(auth.orgId, "streaming.overlay"),
```

  widen the destructure to `const [competition, stages, fixtures, entrants, scheduleSettings, canExport, streamingEntitled, venues] = await Promise.all([…]);` (matching the array's new order — put the new call immediately before `listVenues` so both lists stay aligned), and on the `<StagesPanel …>` mount (`:596`) add:

```tsx
            sportKey={division.sport_key}
            streamingEntitled={streamingEntitled}
```

- [ ] **Step 6: Run the console's own suites — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/v2/__tests__ src/lib/__tests__/overlay-dict-coverage.test.ts --reporter=json --outputFile=/tmp/ovl-w1/t6b.json`
  Expected: `numFailedTests: 0`. Hand-built `StagesPanel` props in that directory will fail to type-check on the two new REQUIRED props — add them there rather than making the props optional; an optional entitlement prop defaults to a state the server never chose.

- [ ] **Step 7: `tsc` — the only thing that can see the prop threading.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npx tsc --noEmit -p apps/web/tsconfig.json; echo "EXIT=$?"`
  Expected: `EXIT=0`. `rtk` prints "tsc clean" while tsc exits 1 — read the `EXIT=` line, not the wrapper's verdict. A local `next build` skips typecheck entirely and proves nothing here.

- [ ] **Step 8: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/components/v2/fixture-stream-panel.tsx apps/web/src/components/v2/stages-panel.tsx "apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx" apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(console): Stream this match on the fixture row" -m "Style tabs over a preview that is the real OverlayStage on the fixture's own score, the overlay link with copy, three numbered steps and the stream-link save. One import and one conditional line in stages-panel.tsx (R11); sportKey and streamingEntitled threaded from the division page." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 7: The public match page link

**Files:**
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` — insert above the `<LiveScore>` mount (`:175-182`)

**Interfaces:**
- Consumes: `fixture.stream_url: string | null` (Task 3), `fixture.status: string`, `getDictionary(locale, "public")` + `t(dict, key)` — the page already resolves `org.default_locale` and holds a `msgFn` for the `ui` namespace (`:23-24`), so the two `public.overlay.*` labels need the `public` dict, loaded the same way `news/[postSlug]/page.tsx:62` does.
- Produces: no exported symbol; one `<a data-testid="public-stream-link">`.

- [ ] **Step 1: Write the failing e2e assertion (the unit layer cannot see this).** Append to `apps/web/e2e/walkthrough/stream-overlay.spec.ts` (created in Task 8's Step 1 — do Task 8 Step 1 first, or write this block into the file as you create it):

```ts
  test("the public match page carries the saved link, and says Replay once decided", async ({ page, request }) => {
    const saved = "https://www.twitch.tv/seaznclub";
    expect((await apiJson(request, `/api/v1/fixtures/${rig.fixtureId}/stream`, "PUT", { streamUrl: saved })).status)
      .toBeLessThan(400);

    const anon = await browserContextAnonymous();
    const publicPage = await anon.newPage();
    await publicPage.goto(rig.publicFixturePath);
    const link = publicPage.getByTestId("public-stream-link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", saved);
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link, "in play or scheduled reads Watch live").toHaveText("Watch live");

    // Decide it through the real door, then reload — this page is ISR + a
    // client transport that polls the SCORE, not the link, so the label is a
    // server render. Recorded as a W1→spectator hand-off rather than pretended.
    await decideFixture(request, rig.fixtureId);
    await publicPage.reload();
    await expect(publicPage.getByTestId("public-stream-link")).toHaveText("Replay");
    await anon.close();
  });
```

> **Recorded hand-off (the wave prompt asks for this decision explicitly):** the "Watch live" → "Replay" flip cannot happen without a reload on the current page. `LiveScore` owns the only live-updating region and its `LiveFixtureData` carries `status/summary/outcome` — not `stream_url` — so the label is a server render. Widening the client payload for a label is spectator W1's composition work (spec §7 already says that programme moves this link into its court header). The test reloads and says so.

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/walkthrough/stream-overlay.spec.ts --project=walkthrough -x`
  Expected red: `Error: expect(locator).toBeVisible() failed … waiting for getByTestId('public-stream-link')` — the anchor does not exist yet.

- [ ] **Step 3: Render the link.** In the public fixture page, add to the imports `import { getDictionary, t } from "@/lib/i18n";`, resolve the dict beside the existing locale work (`const publicDict = await getDictionary(locale, "public");`), and insert immediately above the `<LiveScore …>` mount (`:175`):

```tsx
      {/* The club's own broadcast (stream overlay W1). Placement only —
          spectator W1 owns this page's composition and moves the link into its
          court header (spec §7); do not build a header here.
          `rel="noopener"` is not optional: the href is organiser-supplied, and
          `target="_blank"` without it hands the opened tab a `window.opener`
          handle to this page. The host is already restricted to the ten-name
          allowlist server-side (R16); this is the second, independent guard. */}
      {fixture.stream_url ? (
        <p className="mb-4">
          <a
            data-testid="public-stream-link"
            href={fixture.stream_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 font-display text-sm font-semibold uppercase tracking-wide text-white no-underline shadow transition hover:opacity-90"
          >
            {fixture.status === "decided" || fixture.status === "finalized"
              ? t(publicDict, "overlay.replay")
              : t(publicDict, "overlay.watchLive")}
          </a>
        </p>
      ) : null}
```

- [ ] **Step 4: Run — expect PASS.** Re-run Step 2's command. Expected: that test green. Also confirm the negative pair by hand once: a fixture with no saved link renders NO `public-stream-link` node at all (`await expect(page.getByTestId("public-stream-link")).toHaveCount(0)`), which Task 8's spec asserts.

- [ ] **Step 5: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx"`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(public): Watch live / Replay on the match page" -m "One anchor under the headline, target=_blank rel=noopener, labelled by fixture status. Placement only — spectator W1 owns this page's composition (spec 7)." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 8: e2e, smoke, the visual gate, and the index

> **Ordering note:** Step 1 below creates `stream-overlay.spec.ts`, which Task 7's steps append to. If Tasks 6–7 run in one lane, do Step 1 first and let Task 7 write its own `test(...)` into the file.

**Files:**
- Create: `apps/web/e2e/walkthrough/stream-overlay.spec.ts`
- Create: `apps/web/e2e/walkthrough/stream-overlay-capture.spec.ts`
- Modify: `scripts/smoke.ts` — a new `streamOverlaySuite`, called beside `scorePadV2AppendSuite` (`:784`)
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`
- Modify (post-rebase, same commit): whatever `WALKTHROUGH_SPECS` list exists after the rebase

**Interfaces:**
- Consumes: `apiJson(request, path, method, body?)` (`e2e/helpers.ts:128`), `activeOrg(page)` (`:1268`), `addEntrantsViaApi` (`:1412`), `createStageAndGenerate` (`:1429`), `setBoolEntitlementOverrideSql(orgId, featureKey, value)` (`:500`), `invalidateOrgEntitlements(request, orgId)` (`:943`), `expectNoHorizontalScroll(page, opts?)` (`:49`); `check(label, cond)` and `insertEntitlementOverride(owner, orgId, featureKey, value)` (`scripts/smoke.ts:91`, `:9461`), `html(s, path)` (`:12644`), `v1`/`v1data`.
- Produces: no exported symbol; one Playwright spec, one capture spec, one smoke suite.

> **R9, restated because it changed under this plan:** `WALKTHROUGH_SPECS` **does not exist on this branch** (base `997ad225b`); it landed on `main` in PR #723 (`01ea4a455`) after it. The `walkthrough` project matches by PATH (`playwright.config.ts:119`, `const WALKTHROUGH = /[\\/]e2e[\\/]walkthrough[\\/]/`), so both specs are collected here with no list. **After the rebase, re-grep — do not assume either way** — and if the list exists, register BOTH specs in it in the same commit as the rebase, because a peer session reports `e2e-ci-wiring.test.ts` reds in two CI jobs for any walkthrough spec not named there.

- [ ] **Step 1: Write the failing e2e.** Create `apps/web/e2e/walkthrough/stream-overlay.spec.ts`:

```ts
// Stream overlay W1, end to end. Under e2e/walkthrough/ so the `walkthrough`
// project collects it by path (playwright.config.ts:119) — see R9 about
// WALKTHROUGH_SPECS after the rebase.
//
// The entitlement is lifted by SQL upsert (helpers.ts:500) and thawed to FALSE
// in afterAll, never deleted: the helper is an upsert with no delete, and a
// test.setTimeout would skip a `finally` anyway.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  activeOrg,
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  setBoolEntitlementOverrideSql,
} from "../helpers";
import { POLL_MS } from "../../src/components/public-site/use-live-fixture";

const TAG = `ovl${Math.random().toString(36).slice(2, 7)}`;
const KEY = "streaming.overlay";

// Budget expressed in the constant it depends on, never a flat literal: if
// POLL_MS moves, the budget moves with it (a blown budget reports itself as a
// data defect, "Expected 15 / Received 14", above the timeout line).
const LIVE_BUDGET_MS = Math.max(20_000, POLL_MS * 2 + 5_000);

interface Rig {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionId: string;
  fixtureId: string;
  publicFixturePath: string;
  homeId: string;
}

/** A started CRICKET fixture with one ball bowled — short on purpose (a full
 *  T20 through the API is ~9 minutes) and cricket because R2 makes it the one
 *  sport whose default style is the bar. `cricket.toss` MUST precede
 *  `core.start` or the append is 422 WRONG_PHASE. */
async function cricketRig(page: Page, request: APIRequestContext, label: string): Promise<Rig> {
  const org = await activeOrg(page);
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Overlay ${label} ${TAG}`, visibility: "public", ends_on: "2030-12-31",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
    { name: "Open", sport_key: "cricket", variant_key: "t20", config: {} },
  );
  const entrants = await addEntrantsViaApi(request, div.data!.id, [
    "Milton Keynes Rovers Cricket Club First XI",
    "Northbridge Athletic",
  ]);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds.length, "two entrants, one league fixture — anything else and every assertion below moves").toBe(1);
  const fixtureId = fixtureIds[0]!;
  expect((await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST")).status).toBe(200);

  const toss = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0, type: "cricket.toss", payload: { winner: "home", decision: "bat" },
  });
  expect(toss.status, "cricket.toss must precede core.start — 422 WRONG_PHASE otherwise").toBeLessThan(400);
  const start = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 1, type: "core.start", payload: {},
  });
  expect(start.status).toBeLessThan(400);
  const ball = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 2, type: "cricket.ball",
    payload: { over: 0, ballInOver: 1, striker: `${entrants[0]}-p1`, nonStriker: `${entrants[0]}-p2`, bowler: `${entrants[1]}-p1`, runs: { bat: 4 } },
  });
  expect(ball.status, "one ball, so the overlay has a real number to show").toBeLessThan(400);

  return {
    orgId: org.id, orgSlug: org.slug, compSlug: comp.data!.slug, divSlug: div.data!.slug,
    divisionId: div.data!.id, fixtureId, homeId: entrants[0]!,
    publicFixturePath: `/shared/${org.slug}/${comp.data!.slug}/${div.data!.slug}/fixtures/${fixtureId}`,
  };
}

test.describe("stream overlay", () => {
  let rig: Rig;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    rig = await cricketRig(page, page.request, "W1");
    await context.close();
  });

  test.afterAll(async ({ request }) => {
    // Thaw. Never in a `finally` — a blown test budget skips those.
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, false);
    await invalidateOrgEntitlements(request, rig.orgId);
  });

  test("the entitlement gate opens and closes the route, in both directions", async ({ page, request }) => {
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, false);
    await invalidateOrgEntitlements(request, rig.orgId);
    const closed = await page.goto(`/overlay/fixtures/${rig.fixtureId}`);
    expect(closed?.status(), "not entitled is 404 — indistinguishable from missing, never an upsell").toBe(404);

    await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
    await invalidateOrgEntitlements(request, rig.orgId);
    const open = await page.goto(`/overlay/fixtures/${rig.fixtureId}`);
    expect(open?.status(), "the override row is the only thing that changed").toBe(200);

    const missing = await page.goto("/overlay/fixtures/00000000-0000-0000-0000-000000000000");
    expect(missing?.status()).toBe(404);
  });

  test("the page is transparent, carries the seeded score, and is themed", async ({ browser, request }) => {
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
    await invalidateOrgEntitlements(request, rig.orgId);

    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await anon.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
    await expect(page.getByTestId("ovl-root")).toBeVisible();

    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg, "OBS composites what is painted — an opaque body would black out the camera").toBe("rgba(0, 0, 0, 0)");

    // The score the ENDPOINT reports, not one typed here.
    const { data } = await apiJson<{ summary: { perSide: { line: string }[] } }>(
      request, `/api/v1/public/fixtures/${rig.fixtureId}`,
    );
    const expected = data!.summary.perSide[0]!.line.split(" ")[0]!;
    await expect(page.getByTestId("ovl-big-home")).toHaveText(expected);

    const board = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-testid="ovl-root"]')!).getPropertyValue("--sport-board").trim(),
    );
    expect(board, "cricket overrides nothing, so it resolves to the :root default").toBeTruthy();
    await expect(page.getByTestId("ovl-root")).toHaveAttribute("data-style", "bar");
    await expect(page.getByTestId("ovl-live-dot")).toBeVisible();
    await anon.close();
  });

  test("a new event changes the score in place, ticks only the side that moved, and never navigates", async ({
    browser,
    request,
  }) => {
    test.setTimeout(LIVE_BUDGET_MS + 30_000);
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
    await invalidateOrgEntitlements(request, rig.orgId);

    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await anon.newPage();
    let navigations = 0;
    page.on("framenavigated", () => { navigations += 1; });
    await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
    const before = (await page.getByTestId("ovl-big-home").textContent()) ?? "";
    const awayBefore = (await page.getByTestId("ovl-big-away").textContent()) ?? "";
    const navBaseline = navigations;

    const scored = await apiJson(request, `/api/v1/fixtures/${rig.fixtureId}/events`, "POST", {
      expected_seq: 3, type: "cricket.ball",
      payload: { over: 0, ballInOver: 2, striker: `${rig.homeId}-p1`, nonStriker: `${rig.homeId}-p2`, bowler: "A-p1", runs: { bat: 6 } },
    });
    expect(scored.status, "the append must land — this test is meaningless otherwise").toBeLessThan(400);

    await expect
      .poll(async () => (await page.getByTestId("ovl-big-home").textContent()) ?? "", { timeout: LIVE_BUDGET_MS })
      .not.toBe(before);
    expect(navigations, "the score changed without a navigation").toBe(navBaseline);

    // Mutant (f): with the ovl-tick class application removed this line reds.
    await expect(page.getByTestId("ovl-big-home")).toHaveClass(/ovl-tick/);
    await expect(page.getByTestId("ovl-big-away"), "the side that did not move must not move").not.toHaveClass(/ovl-tick/);
    await expect(page.getByTestId("ovl-big-away")).toHaveText(awayBefore);

    // The LED sits on the batting side.
    await expect(page.getByTestId("ovl-root")).toHaveAttribute("data-led", "home");
    await anon.close();
  });

  test("style and language come from the URL, and an unknown style falls to the sport default", async ({ browser }) => {
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await anon.newPage();

    await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bug`);
    await expect(page.getByTestId("ovl-root")).toHaveAttribute("data-style", "bug");
    await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=carousel`);
    await expect(page.getByTestId("ovl-root"), "cricket's default is the bar (R2)").toHaveAttribute("data-style", "bar");
    await anon.close();
  });

  for (const width of [320, 768, 1280]) {
    test(`the console panel opens and stays within the page at ${width}`, async ({ page, request }) => {
      await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
      await invalidateOrgEntitlements(request, rig.orgId);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}?tab=fixtures`);

      const toggle = page.getByTestId("fixture-stream-toggle").first();
      await expect(toggle, "attached, not visible — a folded control is not visible").toBeAttached();
      await toggle.click();
      await expect(page.getByTestId("stream-panel").first()).toBeAttached();

      const ids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="stream-panel"] [data-testid]')).map(
          (el) => el.getAttribute("data-testid")!,
        ),
      );
      expect(ids, `control set at ${width}`).toEqual([
        "stream-tab-bar", "stream-tab-bug", "stream-preview", "ovl-root", "ovl-side-home",
        "ovl-big-home", "ovl-side-away", "ovl-big-away", "ovl-moment-slot",
        "stream-link", "stream-copy", "stream-steps", "stream-url-input", "stream-save",
      ]);

      if (width === 320) {
        for (const id of ["stream-tab-bar", "stream-tab-bug", "stream-link", "stream-copy", "stream-url-input", "stream-save"]) {
          const box = await page.getByTestId(id).first().boundingBox();
          expect(box, id).not.toBeNull();
          expect(box!.height, `${id} tap target at 320`).toBeGreaterThanOrEqual(44);
        }
      }
      await expectNoHorizontalScroll(page);
    });
  }

  test("the panel saves a valid link and refuses an invalid one without sending it", async ({ page, request }) => {
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, true);
    await invalidateOrgEntitlements(request, rig.orgId);
    await page.setViewportSize({ width: 1280, height: 900 });

    let puts = 0;
    await page.route(`**/api/v1/fixtures/${rig.fixtureId}/stream`, (route) => { puts += 1; return route.fallback(); });

    await page.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}?tab=fixtures`);
    await page.getByTestId("fixture-stream-toggle").first().click();

    await page.getByTestId("stream-url-input").fill("https://www.youtube.com/watch?v=abc123");
    await page.getByTestId("stream-save").click();
    await expect(page.getByTestId("stream-save")).toHaveText("Saved");
    const afterValid = puts;

    await page.getByTestId("stream-url-input").fill("https://evil.example/www.youtube.com");
    await page.getByTestId("stream-save").click();
    await expect(page.getByTestId("stream-error")).toBeVisible();
    expect(puts, "an invalid host is refused in the panel and never sent").toBe(afterValid);

    const { data } = await apiJson<{ stream_url: string | null }>(request, `/api/v1/public/fixtures/${rig.fixtureId}`);
    expect(data!.stream_url, "the refused save left the saved link alone").toBe("https://www.youtube.com/watch?v=abc123");
  });

  test("a non-entitled org sees no stream toggle at all, and still sees the schedule one", async ({ page, request }) => {
    await setBoolEntitlementOverrideSql(rig.orgId, KEY, false);
    await invalidateOrgEntitlements(request, rig.orgId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}?tab=fixtures`);
    await expect(page.getByTestId("fixture-stream-toggle")).toHaveCount(0);
    await expect(
      page.getByTestId("fixture-schedule-toggle").first(),
      "the positive pair: the row still renders its other controls, so the absence above is the gate, not a broken page",
    ).toBeAttached();
  });
});
```

  Add the two helpers this file calls and Task 7's block needs — `browserContextAnonymous` is `browser.newContext({ storageState: { cookies: [], origins: [] } })` inline above; `decideFixture(request, fixtureId)` posts `core.finalize` or the sport's decider through `apiJson` and asserts `< 400` (re-pin the exact event against `_rig.ts`'s cricket helper at execution time).

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/walkthrough/stream-overlay.spec.ts --project=walkthrough --list`
  Expected first: the spec is COLLECTED — `--list` names all eight tests under `[walkthrough]`. A spec the runner does not resolve is the silent failure R9 exists for. Then run it for real; before Task 5/6 land it reds on `ovl-root` / `fixture-stream-toggle` not existing.

- [ ] **Step 3: Run it green, whole-file, after Tasks 5–7.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/walkthrough/stream-overlay.spec.ts --project=walkthrough --reporter=line`
  Expected: `8 passed`. Never `-g` a slice of it — a `-g` sweep is a filename sweep in costume and will select neither of the tests a UI change most often breaks.

- [ ] **Step 4: Mutation checks (e) and (f) at the e2e layer.**
  (e) Delete the `if (!(await hasFeature(…))) notFound();` line in `page.tsx`, re-run Step 3. Expected red: `the entitlement gate opens and closes the route, in both directions` — `expected 200 to be 404`. Restore.
  (f) Remove ` ovl-tick` from the `className` template in `overlay-bar.tsx`, re-run Step 3. Expected red: `a new event changes the score in place…` — `expect(locator).toHaveClass(/ovl-tick/) failed`. Restore and re-run to green.

- [ ] **Step 5: Run the WHOLE `mobile.spec.ts` at all seven widths.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/mobile.spec.ts --reporter=line`
  Expected: no new failures against main's counts. `mobile.spec.ts` is `describe.configure({ mode: "serial" })`, so a red count there is a FLOOR, not a total — re-run after each fix until a full pass completes. The fixtures-tab cases at `:578,2715,2907,3096,3189` are the ones that will see the new toggle.

- [ ] **Step 6: Add the smoke suite.** In `scripts/smoke.ts`, add the function beside `scorePadV2AppendSuite` and call it from the same block (`:784`):

```ts
/**
 * Stream overlay W1 (spec §"Tests"). Three claims, driven through the real
 * doors, because `apiV1` prepends nothing and a route can 404 with the whole
 * unit suite green:
 *   1. the overlay page is 404 for an org with no override row (the DEFAULT
 *      state — no lever needed, which is what makes it the honest negative);
 *   2. it is 200 and carries `ovl-root` once the row is written;
 *   3. `PUT /stream` accepts an allowlisted link and `GET /api/v1/public/
 *      fixtures/{id}` hands the same string back — the seam end to end, in the
 *      one place that would catch `stream_url` being read everywhere and
 *      written nowhere.
 */
async function streamOverlaySuite(admin: Session, proOrgId: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;
  const comp = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31", name: `Stream Overlay ${tag}`, visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Overlay", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: `Overlay Home ${tag}`, seed: 1, members: [] },
    { kind: "individual", display_name: `Overlay Away ${tag}`, seed: 2, members: [] },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
  );
  const fx = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"),
  ).fixtures[0]!.id;
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");

  const denied = await html(admin, `/overlay/fixtures/${fx}`);
  check("stream overlay: 404 for an org with no streaming.overlay row", denied.status === 404);

  await insertEntitlementOverride(admin, proOrgId, "streaming.overlay", true);
  const allowed = await html(admin, `/overlay/fixtures/${fx}`);
  check("stream overlay: 200 once the override row exists", allowed.status === 200);
  check(
    "stream overlay: the page really rendered the stage (not a 200 with no chunks)",
    allowed.body.includes('data-testid="ovl-root"'),
  );

  const link = "https://www.youtube.com/watch?v=smoke";
  const saved = v1data<{ stream_url: string | null }>(
    await v1(admin, `/api/v1/fixtures/${fx}/stream`, "PUT", { streamUrl: link }),
  );
  check("stream overlay: PUT /stream accepts an allowlisted link", saved.stream_url === link);

  const publicJson = v1data<{ stream_url: string | null }>(await v1(admin, `/api/v1/public/fixtures/${fx}`));
  check(
    "stream overlay: the saved link arrives on the PUBLIC fixture JSON (the seam)",
    publicJson.stream_url === link,
  );

  const bad = await raw(admin, `/api/v1/fixtures/${fx}/stream`, "PUT", { streamUrl: "https://evil.example/www.youtube.com" });
  check("stream overlay: an off-allowlist host is refused (4xx)", bad.status >= 400 && bad.status < 500);

  await insertEntitlementOverride(admin, proOrgId, "streaming.overlay", false);
}
```

  and the call, immediately after `await scorePadV2AppendSuite(admin, org2.id);` (`:784`):

```ts
  await streamOverlaySuite(admin, org2.id);
```

- [ ] **Step 7: Run smoke against the prod build.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && SMOKE_BASE=<ovl base> DATABASE_URL=<the ovl url> DATABASE_SSL=disable node --experimental-strip-types scripts/smoke.ts 2>&1 | grep -a "stream overlay"`
  Expected: seven `PASS  stream overlay: …` lines and no `FAIL`. A `FAIL` on the seam line is the inert-seam class this suite exists for — fix the column list, not the assertion.

- [ ] **Step 8: Write the visual-gate capture spec.** Create `apps/web/e2e/walkthrough/stream-overlay-capture.spec.ts`:

```ts
// The owner's per-screen visual gate (merge gate 6). Doubly guarded, the same
// convention gallery.capture.ts uses: it lives in e2e/walkthrough/ so the
// project collects it, and every test skips unless OVL_DIR is set, so a plain
// sweep is a no-op.
//
// The harness asserts the images EXIST and DIFFER — a capture run that errored
// before its first screenshot, or that photographed the same state eight
// times, has collected a sign-off on nothing.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { activeOrg, addEntrantsViaApi, apiJson, createStageAndGenerate, invalidateOrgEntitlements, setBoolEntitlementOverrideSql } from "../helpers";

const DIR = process.env.OVL_DIR;
const SPORTS = ["cricket", "football", "tennis", "volleyball"] as const;
const STYLES = ["bar", "bug"] as const;
const hashes = new Map<string, string>();

test.skip(!DIR, "set OVL_DIR to capture the stream-overlay visual gate");
test.describe.configure({ mode: "serial" });

test("captures bar and bug for four sports at 1920x1080, and the panel at three widths", async ({ page, request }) => {
  test.setTimeout(240_000);
  mkdirSync(DIR!, { recursive: true });
  const org = await activeOrg(page);
  await setBoolEntitlementOverrideSql(org.id, "streaming.overlay", true);
  await invalidateOrgEntitlements(request, org.id);

  for (const sport of SPORTS) {
    const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
      name: `Overlay shot ${sport} ${Date.now()}`, visibility: "public", ends_on: "2030-12-31",
    });
    const div = await apiJson<{ id: string; slug: string }>(
      request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST",
      { name: sport, sport_key: sport, variant_key: sport === "cricket" ? "t20" : "", config: {} },
    );
    await addEntrantsViaApi(request, div.data!.id, ["Milton Keynes Rovers Cricket Club First XI", "Northbridge Athletic"]);
    const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "L" });
    const fx = fixtureIds[0]!;
    await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
    // A short, REAL stream per sport — re-pin each sport's opener against its
    // module before running; a refused append photographs the empty state.
    if (sport === "cricket") {
      await apiJson(request, `/api/v1/fixtures/${fx}/events`, "POST", { expected_seq: 0, type: "cricket.toss", payload: { winner: "home", decision: "bat" } });
    }

    await page.setViewportSize({ width: 1920, height: 1080 });
    for (const style of STYLES) {
      await page.goto(`/overlay/fixtures/${fx}?style=${style}`);
      await expect(page.getByTestId("ovl-root")).toBeVisible();
      const file = join(DIR!, `${sport}-${style}.png`);
      await page.screenshot({ path: file });
      expect(existsSync(file), file).toBe(true);
      hashes.set(`${sport}-${style}`, createHash("sha256").update(readFileSync(file)).digest("hex"));
    }
  }

  expect(
    new Set(hashes.values()).size,
    "eight images that DIFFER — identical hashes mean the theme never applied or nothing opened",
  ).toBe(8);
});

test("captures the organiser panel at 320, 768 and 1280", async ({ page }) => {
  const org = await activeOrg(page);
  const panel: string[] = [];
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/o/${org.slug}`);
    // Navigate to the seeded division's fixtures tab, open the first row's
    // stream panel, then shoot. (Path re-pinned at execution against the rig
    // the first test seeded.)
    const toggle = page.getByTestId("fixture-stream-toggle").first();
    await expect(toggle).toBeAttached();
    if (await toggle.isVisible()) await toggle.click();
    const file = join(DIR!, `panel-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    expect(existsSync(file)).toBe(true);
    panel.push(createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  expect(new Set(panel).size, "three widths, three different pictures").toBe(3);
});
```

- [ ] **Step 9: Run the capture and read the pictures.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && OVL_DIR=/tmp/ovl-w1/shots PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/walkthrough/stream-overlay-capture.spec.ts --project=walkthrough --reporter=line`
  Expected: `2 passed` and eleven files in `/tmp/ovl-w1/shots`. Then OPEN them and write a verdict row per screen: alignment, the 43-character name, LED position, contrast composited over a LIGHT and a DARK frame (OBS will do both), the 404 state and the "—" scheduled state. "CI green" is not a visual sign-off.

- [ ] **Step 10: Update `_INDEX.md`.** In `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`: flip the plan row to `done`, the PR1 row to `in flight`/`merged` with its number, record the LANDED migration numbers (V392/V393 or whatever the rebase gave them), and add the findings this wave produced — the `useLiveFixture` return-type conflict, `OverlayMsg` vs `MsgFn`, `decidedTemplates` as an input, `startLabel` formatted server-side in UTC (no public venue zone), watch-list 6 resolved to the three-letter fallback (`public_entrants_v` carries no `short_name`), `header.clock` empty in W1, the "Replay" label needing a reload, and whatever `--sport-*` contrast or `m.youtube.com` question the run raised.

- [ ] **Step 11: Wave-boundary gate — the full suite, against the baseline.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<the ovl url> DATABASE_SSL=disable npx vitest run --reporter=json --outputFile=/tmp/ovl-w1/full.json`
  Expected: `numFailedTests: 5` and no more — the SAME five as the baseline (3 × `schedule-build-honours-locks.test.ts`, 2 × `pass-scoping-guard.test.ts`), and `numTotalTests` ≥ 14041 + this wave's new tests. Confirm the five by name in `.testResults[]`, and confirm every `.testResults[].name` resolves inside this worktree. Then:
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && rtk proxy npm run lint` → read `✖ 0 problems`;
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npx tsc --noEmit -p apps/web/tsconfig.json; echo "EXIT=$?"` → `EXIT=0`;
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npm run openapi:gen` and `pnpm i18n:gen-keys`, then `/usr/bin/git status --porcelain` → no diff from either.

- [ ] **Step 12: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/e2e/walkthrough/stream-overlay.spec.ts apps/web/e2e/walkthrough/stream-overlay-capture.spec.ts scripts/smoke.ts docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(tests): e2e both gate directions, smoke through the seam, and the visual gate" -m "The e2e drives a real cricket ledger and asserts the score moves without navigating; smoke proves the saved link reaches the public JSON; the capture harness asserts eight images that exist and differ." -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

- [ ] **Step 13: Post-rebase (R11, R9, R10).** After `feat/fixture-console-redesign` merges, rebase on `main`, then in ONE commit: renumber the two migrations to the next free V, and `grep -arn "WALKTHROUGH_SPECS" apps/web` — if the symbol now exists, register BOTH `stream-overlay.spec.ts` and `stream-overlay-capture.spec.ts` in it. Re-run the WHOLE `mobile.spec.ts` AFTER the rebase, not before, and re-run Step 11's full gate.

---

## Self-review

### Spec and wave-prompt coverage

| Source section | Task |
|---|---|
| Spec §1 Overlay route (layout, page, canvas, stage) / prompt scope 5 | 5 |
| Spec §2 Projection (`OverlayModel`, `overlayModel`) / prompt scope 2 | 2 |
| Spec §3 Theme (`sportThemeStyle`, seven tokens, `.ovl-*`) / `_THEMES.md` §1–§4 | 5 |
| Spec §4 Data (V392, view, `PublicFixture`, `PUT /stream`, OpenAPI) / prompt scope 3 | 3 |
| Spec §5 Entitlement (`streaming.overlay`, no plan, override row) / prompt scope 4 | 4 |
| Spec §6 Organiser panel / prompt scope 6 / `_THEMES.md` §8 | 6 |
| Spec §7 Public match page link / prompt scope 7 | 7 |
| Spec §8 Sequencing with in-flight programmes (R11) | 8 (Step 13) |
| Spec §9 Motion — the three W1 motions / `_THEMES.md` §6 / R13 | 5 (CSS + stage), proven in 8 |
| Spec "Error and empty states" (404 both causes, scheduled "—", decided, no-detail sports) | 2 (unit), 5 (render), 8 (e2e) |
| Spec "Tests" — Unit | 1, 2, 3, 4, 5 |
| Spec "Tests" — E2E | 8 (with 7's block) |
| Spec "Tests" — Smoke | 8 |
| Spec "Tests" — Regression (`LiveScore` unchanged, `mobile.spec.ts`, gen diffs) | 1, 8 (Steps 5, 11) |
| Spec "Tests" — Visual gate | 8 (Steps 8–9) |
| Prompt scope 1 Hook extraction | 1 |
| Prompt scope 8 i18n (four locales, gen-keys, derived coverage test) | 5, 6 |
| Prompt scope 10 `_INDEX.md` | 8 (Step 10) |
| R4 `OverlayMoment` type + `ovl-moment-slot`, W2 compatibility | 2, 5 |
| `_THEMES.md` §2 contrast floors | 5 (Step 10) |
| `_THEMES.md` §7 phone legibility floors (no native size lowered) | 5 (CSS values are §3/§4 verbatim), reviewed in 8 Step 9 |

### Mutation checks — each names the test that must go red

| # | Mutation | Test that must go red |
|---|---|---|
| a | `stream-url.ts`: `return ALLOWED.has(url.hostname)` → `return true` | `stream-url.test.ts` › `rejects https://evil.example/www.youtube.com — an allowed host in the PATH is not the host` (and the other nine rejections) |
| b | `overlay-model.ts` `ledEntrantId`: swap the serving branch's two side ids | `overlay-model.test.ts` › `tennis: the LED and the serve dot follow the server` |
| c | `overlay-model.ts` `cellsOf`: `if (breakdown) return [];` | `overlay-model.test.ts` › `badminton renders one cell per game, in order, home–away` |
| d | `use-live-fixture.ts`: `if (!live || subscribed) return;` → `if (subscribed) return;` | `use-live-fixture.test.tsx` › `never arms a poll for a fixture that is already decided at mount` |
| e | `overlay/.../page.tsx`: delete the `hasFeature` guard | `stream-overlay.spec.ts` › `the entitlement gate opens and closes the route, in both directions` (e2e only — no unit can see it) |
| f | `overlay-bar.tsx`: remove ` ovl-tick` from the score `className` | `stream-overlay.spec.ts` › `a new event changes the score in place, ticks only the side that moved, and never navigates` |
| extra | `V392`: drop `stream_url` from the view redefinition | `fixture-stream-url.test.ts` › `writes the link … and it arrives on the PUBLIC view`, and smoke's `the saved link arrives on the PUBLIC fixture JSON (the seam)` |
| extra | `entitlement-domains.ts`: add `"streaming.overlay"` to any section | `entitlement-streaming-overlay.test.ts` › `is in NO ENTITLEMENT_DOMAINS section` |

A surviving mutant is a missing test, not a note. Run each one, restore, and re-run to green before recording it.

### Open pins — carried into `_INDEX.md`, not silently resolved

1. **Entrant short name (watch-list 6) — RESOLVED to the fallback.** `public_entrants_v` (`V350__person_tombstone_views.sql:18-47`) exposes `display_name` and a `team_display` blob of `club_id/club_name/logo_path/colors`; `teams.short_name` (`V206:5`) never reaches it. `shortCode` therefore always takes the three-letter branch, and `ui.stream.codeNote` tells the organiser so.
2. **Venue timezone for `startLabel`.** Formatted in `UTC`. No IANA zone is on `PublicFixture`, and the competition's zone lives behind `getScheduleSettings(auth, …)`, which an unauthenticated overlay cannot call. Owner question: is a UTC start label acceptable on the scheduled state, or is a public tz column owed?
3. **`header.clock` (football family).** `_THEMES.md` §3 gives the bar a clock cell; no elapsed-time field exists on the public `ScoreSummary.detail` (`lib/public-site.ts:319-373` is the complete reader set). The slot renders only when set, so it is live and empty in W1.
4. **`m.youtube.com`.** Not on R16's ten. The unit test asserts it is REJECTED and says so; if the owner wants mobile share links accepted, it is a one-line addition to `STREAM_HOSTS` plus a test row.
5. **Barlow double-mount (watch-list 7).** Verified in Task 5 Step 12 by reading the built CSS and the network tab, not by assumption.
6. **`V3_SKINS` = every `sport_key` a division can carry (watch-list 8).** Task 2's sweep asserts eleven keys; run `select distinct sport_key from divisions` on the ovl DB and diff before the PR — a division on a twelfth key would render the generic composition, which is a designed state but should be a KNOWN one.
7. **`WALKTHROUGH_SPECS` after the rebase (R9).** Absent at base `997ad225b`; present on `main` since PR #723 (`01ea4a455`). Task 8 Step 13 re-greps and registers both specs in the same commit rather than assuming either way.
8. **Conflicts with the wave prompt, listed for `_INDEX.md`:** the hook's return type (object, not bare `LiveFixtureData` — `LiveScore` renders `subscribed`); `OverlayMsg` instead of `MsgFn` (`MessageKey` is the `ui` catalog, the overlay's copy is `public`); `decidedTemplates` as a fourth model input (one authority for the decided sentence); `startLabel` formatted by the server; W2's plan names `apps/web/e2e/stream-overlay.spec.ts` while the W1 prompt's R9 puts it under `e2e/walkthrough/` — the W1 prompt wins and W2 re-pins.

