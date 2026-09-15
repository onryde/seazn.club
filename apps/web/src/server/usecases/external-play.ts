import "server-only";
// External-play prepare / sync usecases (chess Lichess design 2026-09-15).
// Cron-shaped: privileged `sql` across orgs (same as registration sweeps).
// Wire every 5 min in onryde/seazn.club.workflow (external).
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { sendExternalPlayReadyEmail } from "@/lib/email";
import { toLocale, type Locale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { mapBoardgameClockToLichess } from "@/server/external-play/clock";
import { mapLichessGameToBoardgameResult } from "@/server/external-play/map-result";
import { createLichessAdapter } from "@/server/external-play/lichess/client";
import type {
  ExternalPlayAdapter,
  LichessGameSnapshot,
} from "@/server/external-play/types";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  getLichessAccessToken,
  getLinkedAccount,
} from "@/server/usecases/external-accounts";
import { scoreEvent } from "@/server/usecases/scoring";

const PREPARE_AHEAD_MS = 15 * 60 * 1000;
/** Catch fixtures whose T−15 window already passed but were never prepared. */
const PREPARE_LOOKBACK_MS = 60 * 60 * 1000;

export type PrepareExternalPlayCounts = {
  prepared: number;
  emailed: number;
  deferred: number;
  failed: number;
};

export type PrepareExternalPlayDeps = {
  now?: Date;
  /** Absolute origin for Seazn fixture links (e.g. https://seazn.club). */
  origin: string;
  adapter?: ExternalPlayAdapter;
  sendReadyEmail?: typeof sendExternalPlayReadyEmail;
  /** Optional org scope (tests / targeted re-runs). */
  orgId?: string;
};

type CandidateRow = {
  fixture_id: string;
  scheduled_at: Date;
  home_entrant_id: string;
  away_entrant_id: string;
  org_id: string;
  org_slug: string;
  org_name: string;
  competition_slug: string;
  division_slug: string;
  division_config: unknown;
  ep_status: string | null;
  ep_emailed_at: Date | null;
};

type SidePlayer = {
  entrantId: string;
  displayName: string;
  userId: string | null;
  email: string | null;
  locale: string | null;
};

async function loadSide(entrantId: string): Promise<SidePlayer | null> {
  const rows = await sql<
    {
      display_name: string;
      user_id: string | null;
      email: string | null;
      locale: string | null;
    }[]
  >`
    select e.display_name, p.user_id, u.email, u.locale
      from entrants e
      join entrant_members em on em.entrant_id = e.id
      join persons p on p.id = em.person_id
      left join users u on u.id = p.user_id
     where e.id = ${entrantId}
     order by em.is_captain desc, em.person_id
     limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    entrantId,
    displayName: row.display_name,
    userId: row.user_id,
    email: row.email,
    locale: row.locale,
  };
}

function scheduledLabel(at: Date): string {
  try {
    return at.toLocaleString("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }) + " (UTC)";
  } catch {
    return at.toISOString();
  }
}

function fixtureUrl(origin: string, row: CandidateRow): string {
  const path = routes.sharedFixture(
    row.org_slug,
    row.competition_slug,
    row.division_slug,
    row.fixture_id,
  );
  return `${origin.replace(/\/$/, "")}${path}`;
}

async function upsertExternalPlay(opts: {
  fixtureId: string;
  orgId: string;
  status: string;
  lastError: string | null;
  challengeId?: string | null;
  playUrl?: string | null;
  whitePlayUrl?: string | null;
  blackPlayUrl?: string | null;
  emailedAt?: Date | null;
}): Promise<void> {
  await sql`
    insert into fixture_external_play (
      fixture_id, org_id, provider, status,
      external_challenge_id, play_url, white_play_url, black_play_url,
      last_error, emailed_at, updated_at
    ) values (
      ${opts.fixtureId}, ${opts.orgId}, 'lichess', ${opts.status},
      ${opts.challengeId ?? null}, ${opts.playUrl ?? null},
      ${opts.whitePlayUrl ?? null}, ${opts.blackPlayUrl ?? null},
      ${opts.lastError}, ${opts.emailedAt ?? null}, now()
    )
    on conflict (fixture_id) do update set
      status = excluded.status,
      external_challenge_id = coalesce(excluded.external_challenge_id, fixture_external_play.external_challenge_id),
      play_url = coalesce(excluded.play_url, fixture_external_play.play_url),
      white_play_url = coalesce(excluded.white_play_url, fixture_external_play.white_play_url),
      black_play_url = coalesce(excluded.black_play_url, fixture_external_play.black_play_url),
      last_error = excluded.last_error,
      emailed_at = coalesce(fixture_external_play.emailed_at, excluded.emailed_at),
      updated_at = now()`;
}

/**
 * T−15 window: create Lichess challenges for onlinePlay=lichess fixtures and
 * email both players a Seazn fixture link once. Idempotent on emailed_at.
 */
export async function prepareExternalPlayWindow(
  deps: PrepareExternalPlayDeps,
): Promise<PrepareExternalPlayCounts> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - PREPARE_LOOKBACK_MS);
  const windowEnd = new Date(now.getTime() + PREPARE_AHEAD_MS);
  const adapter = deps.adapter ?? createLichessAdapter({ fetch });
  const sendReady = deps.sendReadyEmail ?? sendExternalPlayReadyEmail;

  const candidates = await sql<CandidateRow[]>`
    select f.id as fixture_id,
           f.scheduled_at,
           f.home_entrant_id,
           f.away_entrant_id,
           o.id as org_id,
           o.slug as org_slug,
           o.name as org_name,
           c.slug as competition_slug,
           d.slug as division_slug,
           d.config as division_config,
           ep.status as ep_status,
           ep.emailed_at as ep_emailed_at
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = c.org_id
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.scheduled_at is not null
       and f.scheduled_at >= ${windowStart}
       and f.scheduled_at <= ${windowEnd}
       and f.home_entrant_id is not null
       and f.away_entrant_id is not null
       and f.status in ('scheduled', 'in_play')
       and coalesce(d.config->>'onlinePlay', 'off') = 'lichess'
       and (
         ep.fixture_id is null
         or ep.status = 'pending'
         or (ep.status = 'ready' and ep.emailed_at is null)
       )
       and (${deps.orgId ?? null}::uuid is null or o.id = ${deps.orgId ?? null})
     order by f.scheduled_at asc
     limit 100`;

  const counts: PrepareExternalPlayCounts = {
    prepared: 0,
    emailed: 0,
    deferred: 0,
    failed: 0,
  };

  for (const row of candidates) {
    try {
      const cfg = (row.division_config ?? {}) as {
        clock?: { base: number; increment?: number; delay?: number };
      };
      const clockMap = mapBoardgameClockToLichess(cfg.clock);
      if (!clockMap.ok) {
        await upsertExternalPlay({
          fixtureId: row.fixture_id,
          orgId: row.org_id,
          status: "needs_organiser",
          lastError: clockMap.reason,
        });
        counts.deferred += 1;
        continue;
      }

      const white = await loadSide(row.home_entrant_id);
      const black = await loadSide(row.away_entrant_id);
      if (!white?.userId || !black?.userId) {
        await upsertExternalPlay({
          fixtureId: row.fixture_id,
          orgId: row.org_id,
          status: "pending",
          lastError: "missing_linked_user",
        });
        counts.deferred += 1;
        continue;
      }

      const whiteLink = await getLinkedAccount(white.userId, "lichess");
      const blackLink = await getLinkedAccount(black.userId, "lichess");
      const whiteToken = await getLichessAccessToken(white.userId);
      if (!whiteLink || !blackLink || !whiteToken) {
        await upsertExternalPlay({
          fixtureId: row.fixture_id,
          orgId: row.org_id,
          status: "pending",
          lastError: "lichess_link_or_token_missing",
        });
        counts.deferred += 1;
        continue;
      }

      // Already ready (email-only retry after a prior send failure) — skip recreate.
      if (row.ep_status !== "ready") {
        const challenge = await adapter.createChallenge({
          whiteAccessToken: whiteToken,
          blackLichessUsername: blackLink.username,
          clock: clockMap.clock,
          rated: false,
        });

        await upsertExternalPlay({
          fixtureId: row.fixture_id,
          orgId: row.org_id,
          status: "ready",
          lastError: null,
          challengeId: challenge.challengeId,
          playUrl: challenge.whitePlayUrl,
          whitePlayUrl: challenge.whitePlayUrl,
          blackPlayUrl: challenge.blackPlayUrl,
        });
        counts.prepared += 1;
      }

      if (row.ep_emailed_at) continue;

      const url = fixtureUrl(deps.origin, row);
      const when = scheduledLabel(row.scheduled_at);
      const recipients: { side: SidePlayer; opponent: SidePlayer }[] = [
        { side: white, opponent: black },
        { side: black, opponent: white },
      ];
      let anySent = false;
      for (const { side, opponent } of recipients) {
        if (!side.email) continue;
        const locale: Locale = toLocale(side.locale);
        const ok = await sendReady(
          side.email,
          {
            orgName: row.org_name,
            opponentName: opponent.displayName,
            scheduledLabel: when,
            fixtureUrl: url,
          },
          locale,
        );
        if (ok) anySent = true;
      }
      if (anySent) {
        await sql`
          update fixture_external_play
             set emailed_at = coalesce(emailed_at, now()), updated_at = now()
           where fixture_id = ${row.fixture_id}`;
        counts.emailed += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : "prepare_failed";
      await upsertExternalPlay({
        fixtureId: row.fixture_id,
        orgId: row.org_id,
        status: "pending",
        lastError: message,
      }).catch(() => undefined);
      counts.failed += 1;
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Webhook / poll sync → real scoreEvent path (Task 6)
// ---------------------------------------------------------------------------

export type ApplyProviderResult = "ignored" | "live" | "finished" | "needs_organiser";

type ExternalPlayBridgeRow = {
  fixture_id: string;
  org_id: string;
  status: string;
  external_challenge_id: string | null;
  external_game_id: string | null;
  home_entrant_id: string;
  away_entrant_id: string;
  fixture_status: string;
  fixture_outcome: unknown;
};

async function loadBridgeByGameId(gameId: string): Promise<ExternalPlayBridgeRow | null> {
  const rows = await sql<ExternalPlayBridgeRow[]>`
    select ep.fixture_id, ep.org_id, ep.status,
           ep.external_challenge_id, ep.external_game_id,
           f.home_entrant_id, f.away_entrant_id,
           f.status as fixture_status, f.outcome as fixture_outcome
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
     where ep.provider = 'lichess'
       and (ep.external_game_id = ${gameId} or ep.external_challenge_id = ${gameId})
     limit 1`;
  return rows[0] ?? null;
}

async function mintOrgOwnerAuth(orgId: string): Promise<AuthCtx> {
  const [owner] = await sql<{ user_id: string }[]>`
    select user_id from org_members
     where org_id = ${orgId} and role = 'owner'
     order by created_at asc
     limit 1`;
  if (!owner) {
    throw new Error(`no owner for org ${orgId}`);
  }
  return {
    orgId,
    via: "session",
    userId: owner.user_id,
    role: "owner",
    keyId: null,
  };
}

async function nextExpectedSeq(orgId: string, fixtureId: string): Promise<number> {
  const [row] = await withTenant(orgId, (tx) => tx<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from score_events where fixture_id = ${fixtureId}`);
  return row?.seq ?? 0;
}

async function markNeedsOrganiser(
  fixtureId: string,
  reason: string,
  gameId?: string | null,
): Promise<"needs_organiser"> {
  await sql`
    update fixture_external_play
       set status = 'needs_organiser',
           last_error = ${reason},
           external_game_id = coalesce(${gameId ?? null}, external_game_id),
           updated_at = now()
     where fixture_id = ${fixtureId}`;
  return "needs_organiser";
}

async function markLive(fixtureId: string, gameId: string): Promise<"live"> {
  await sql`
    update fixture_external_play
       set status = 'live',
           external_game_id = ${gameId},
           started_at = coalesce(started_at, now()),
           last_error = null,
           play_url = coalesce(play_url, ${`https://lichess.org/${gameId}`}),
           updated_at = now()
     where fixture_id = ${fixtureId}`;
  return "live";
}

/**
 * Append a mapped boardgame.result through the REAL scoreEvent door (start
 * first if the fixture is still in pre). Must not write standings itself.
 */
async function appendExternalResult(
  orgId: string,
  fixtureId: string,
  payload: { winner: string | null; method: string },
  idempotencyKey: string,
  authOverride?: AuthCtx,
): Promise<Awaited<ReturnType<typeof scoreEvent>>> {
  const auth = authOverride ?? (await mintOrgOwnerAuth(orgId));
  let seq = await nextExpectedSeq(orgId, fixtureId);
  if (seq === 0) {
    await scoreEvent(auth, fixtureId, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
      idempotency_key: `${idempotencyKey}:start`,
    });
    seq = 1;
  }
  return scoreEvent(auth, fixtureId, {
    expected_seq: seq,
    type: "boardgame.result",
    payload,
    idempotency_key: idempotencyKey,
  });
}

export type ApplyProviderGameUpdateOpts = {
  provider: "lichess";
  gameId: string;
  snapshot?: LichessGameSnapshot;
  adapter?: ExternalPlayAdapter;
};

/**
 * Fold a Lichess game snapshot into Seazn scoring. Clean finishes call
 * scoreEvent; mismatch/abort → needs_organiser; already decided → ignored.
 */
export async function applyProviderGameUpdate(
  opts: ApplyProviderGameUpdateOpts,
): Promise<ApplyProviderResult> {
  if (opts.provider !== "lichess") return "ignored";

  const bridge = await loadBridgeByGameId(opts.gameId);
  if (!bridge) return "ignored";
  if (bridge.status === "finished") return "ignored";
  if (bridge.fixture_outcome != null) return "ignored";
  if (["decided", "finalized", "abandoned", "forfeited", "cancelled"].includes(bridge.fixture_status)) {
    return "ignored";
  }

  const adapter = opts.adapter ?? createLichessAdapter({ fetch });
  const snapshot = opts.snapshot ?? (await adapter.fetchGame(opts.gameId));

  if (snapshot.status === "created" || snapshot.status === "started" || snapshot.status === "paused") {
    return markLive(bridge.fixture_id, snapshot.id);
  }

  const white = await loadSide(bridge.home_entrant_id);
  const black = await loadSide(bridge.away_entrant_id);
  if (!white?.userId || !black?.userId) {
    return markNeedsOrganiser(bridge.fixture_id, "missing_linked_user", snapshot.id);
  }

  const homeLink = await getLinkedAccount(white.userId, "lichess");
  const awayLink = await getLinkedAccount(black.userId, "lichess");
  if (!homeLink || !awayLink) {
    return markNeedsOrganiser(bridge.fixture_id, "lichess_link_missing", snapshot.id);
  }

  const mapped = mapLichessGameToBoardgameResult({
    game: snapshot,
    homeEntrantId: bridge.home_entrant_id,
    awayEntrantId: bridge.away_entrant_id,
    homeLichessId: homeLink.externalUserId,
    awayLichessId: awayLink.externalUserId,
  });

  if (!mapped.ok) {
    if (mapped.reason === "unfinished") {
      return markLive(bridge.fixture_id, snapshot.id);
    }
    return markNeedsOrganiser(bridge.fixture_id, mapped.reason, snapshot.id);
  }

  try {
    await appendExternalResult(
      bridge.org_id,
      bridge.fixture_id,
      mapped.payload,
      `lichess:${snapshot.id}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "score_failed";
    return markNeedsOrganiser(bridge.fixture_id, message, snapshot.id);
  }

  await sql`
    update fixture_external_play
       set status = 'finished',
           external_game_id = ${snapshot.id},
           finished_at = now(),
           last_error = null,
           updated_at = now()
     where fixture_id = ${bridge.fixture_id}`;
  return "finished";
}

export type PollLiveExternalPlayCounts = {
  polled: number;
  live: number;
  finished: number;
  needs_organiser: number;
  ignored: number;
};

/** Poll ready/live bridges that have a challenge or game id. Invoked from cron. */
export async function pollLiveExternalPlay(deps?: {
  adapter?: ExternalPlayAdapter;
  limit?: number;
}): Promise<PollLiveExternalPlayCounts> {
  const adapter = deps?.adapter ?? createLichessAdapter({ fetch });
  const limit = deps?.limit ?? 50;
  const rows = await sql<{ fixture_id: string; game_key: string }[]>`
    select fixture_id,
           coalesce(external_game_id, external_challenge_id) as game_key
      from fixture_external_play
     where provider = 'lichess'
       and status in ('ready', 'live')
       and coalesce(external_game_id, external_challenge_id) is not null
     order by updated_at asc
     limit ${limit}`;

  const counts: PollLiveExternalPlayCounts = {
    polled: 0,
    live: 0,
    finished: 0,
    needs_organiser: 0,
    ignored: 0,
  };

  for (const row of rows) {
    if (!row.game_key) continue;
    counts.polled += 1;
    try {
      const result = await applyProviderGameUpdate({
        provider: "lichess",
        gameId: row.game_key,
        adapter,
      });
      if (result === "live") counts.live += 1;
      else if (result === "finished") counts.finished += 1;
      else if (result === "needs_organiser") counts.needs_organiser += 1;
      else counts.ignored += 1;
    } catch {
      counts.ignored += 1;
    }
  }

  return counts;
}

const ESCALATE_GRACE_MS = 20 * 60 * 1000;

export type EscalateStaleExternalPlayCounts = {
  escalated: number;
};

/**
 * T+20 no-show: ready/pending bridges whose scheduled_at + 20m has passed
 * and the game never went live/finished → needs_organiser.
 */
export async function escalateStaleExternalPlay(opts?: {
  now?: Date;
}): Promise<EscalateStaleExternalPlayCounts> {
  const now = opts?.now ?? new Date();
  const cutoff = new Date(now.getTime() - ESCALATE_GRACE_MS);
  const rows = await sql<{ fixture_id: string }[]>`
    update fixture_external_play ep
       set status = 'needs_organiser',
           last_error = coalesce(nullif(ep.last_error, ''), 'no_show_grace_elapsed'),
           updated_at = now()
      from fixtures f
     where ep.fixture_id = f.id
       and ep.provider = 'lichess'
       and ep.status in ('ready', 'pending')
       and f.scheduled_at is not null
       and f.scheduled_at < ${cutoff}
       and f.outcome is null
       and f.status in ('scheduled', 'in_play')
    returning ep.fixture_id`;
  return { escalated: rows.length };
}

export const ResolveExternalPlayKinds = [
  "home_forfeit",
  "away_forfeit",
  "draw",
  "no_result",
] as const;
export type ResolveExternalPlayKind = (typeof ResolveExternalPlayKinds)[number];

/**
 * Organiser resolve for an open external-play bridge: append boardgame.result
 * via scoreEvent (organiser attribution), then mark finished.
 */
export async function resolveExternalPlay(
  auth: AuthCtx,
  fixtureId: string,
  kind: ResolveExternalPlayKind,
): Promise<{ status: "finished"; score: Awaited<ReturnType<typeof scoreEvent>> }> {
  const [bridge] = await withTenant(auth.orgId, (tx) =>
    tx<
      {
        status: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        fixture_outcome: unknown;
      }[]
    >`
    select ep.status, f.home_entrant_id, f.away_entrant_id,
           f.outcome as fixture_outcome
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
     where ep.fixture_id = ${fixtureId}`,
  );
  if (!bridge) throw new HttpError(404, "No external-play record for this fixture");
  if (bridge.fixture_outcome != null || bridge.status === "finished") {
    throw new HttpError(409, "Fixture already has a result", "ALREADY_RESOLVED");
  }
  if (!bridge.home_entrant_id || !bridge.away_entrant_id) {
    throw new HttpError(422, "Both sides must be seated before resolving");
  }

  let payload: { winner: string | null; method: string };
  switch (kind) {
    case "home_forfeit":
      payload = { winner: bridge.away_entrant_id, method: "forfeit" };
      break;
    case "away_forfeit":
      payload = { winner: bridge.home_entrant_id, method: "forfeit" };
      break;
    case "draw":
      payload = { winner: null, method: "agreement" };
      break;
    case "no_result":
      payload = { winner: null, method: "double_forfeit" };
      break;
  }

  const score = await appendExternalResult(
    auth.orgId,
    fixtureId,
    payload,
    `external-play-resolve:${fixtureId}:${kind}`,
    auth,
  );

  await sql`
    update fixture_external_play
       set status = 'finished',
           finished_at = coalesce(finished_at, now()),
           last_error = null,
           updated_at = now()
     where fixture_id = ${fixtureId}`;

  return { status: "finished", score };
}

/** List needs_organiser online-play fixtures for a division (organiser queue). */
export async function listNeedsOrganiserExternalPlay(
  auth: AuthCtx,
  divisionId: string,
): Promise<
  {
    fixtureId: string;
    fixtureNo: number | null;
    homeName: string;
    awayName: string;
    scheduledAt: string | null;
    lastError: string | null;
  }[]
> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<
      {
        fixture_id: string;
        fixture_no: number | null;
        home_name: string | null;
        away_name: string | null;
        scheduled_at: Date | null;
        last_error: string | null;
      }[]
    >`
      select f.id as fixture_id, f.fixture_no,
             eh.display_name as home_name, ea.display_name as away_name,
             f.scheduled_at, ep.last_error
        from fixture_external_play ep
        join fixtures f on f.id = ep.fixture_id
        left join entrants eh on eh.id = f.home_entrant_id
        left join entrants ea on ea.id = f.away_entrant_id
       where f.division_id = ${divisionId}
         and ep.status = 'needs_organiser'
       order by f.scheduled_at nulls last, f.fixture_no nulls last`;
    return rows.map((r) => ({
      fixtureId: r.fixture_id,
      fixtureNo: r.fixture_no,
      homeName: r.home_name ?? "TBD",
      awayName: r.away_name ?? "TBD",
      scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
      lastError: r.last_error,
    }));
  });
}
