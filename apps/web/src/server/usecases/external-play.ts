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
import { publishExternalPlayLobby } from "@/lib/realtime";
import { scoreEvent } from "@/server/usecases/scoring";

const PREPARE_AHEAD_MS = 15 * 60 * 1000;
/** Catch fixtures whose T−15 window already passed but were never prepared. */
const PREPARE_LOOKBACK_MS = 60 * 60 * 1000;
/**
 * Lichess cancels an unstreamed realtime challenge after 20s. The lobby
 * countdown uses the same window. A missed window clears both Ready clicks;
 * it does not mint again until both click Ready.
 */
export const CHALLENGE_TTL_MS = 20_000;

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
  challenge_created_at: Date | null;
};

type SideRecipient = { email: string; locale: string | null };

type SidePlayer = {
  entrantId: string;
  displayName: string;
  userId: string | null;
  recipients: SideRecipient[];
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
     order by em.person_id`;
  const row = rows[0];
  if (!row) return null;
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id))];
  return {
    entrantId,
    displayName: row.display_name,
    // One linked user only. Several linked members is not a chess seat — do
    // not silently pick the captain.
    userId: userIds.length === 1 ? userIds[0] : null,
    recipients: rows
      .filter((r): r is typeof r & { email: string } => !!r.email)
      .map((r) => ({ email: r.email, locale: r.locale })),
  };
}

function scheduledLabel(at: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(at);
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
  whiteLichessId?: string | null;
  blackLichessId?: string | null;
  challengeCreatedAt?: Date | null;
  emailedAt?: Date | null;
}): Promise<void> {
  await sql`
    insert into fixture_external_play (
      fixture_id, org_id, provider, status,
      external_challenge_id, play_url, white_play_url, black_play_url,
      white_lichess_id, black_lichess_id, challenge_created_at,
      last_error, emailed_at, updated_at
    ) values (
      ${opts.fixtureId}, ${opts.orgId}, 'lichess', ${opts.status},
      ${opts.challengeId ?? null}, ${opts.playUrl ?? null},
      ${opts.whitePlayUrl ?? null}, ${opts.blackPlayUrl ?? null},
      ${opts.whiteLichessId ?? null}, ${opts.blackLichessId ?? null},
      ${opts.challengeCreatedAt ?? null},
      ${opts.lastError}, ${opts.emailedAt ?? null}, now()
    )
    on conflict (fixture_id) do update set
      status = excluded.status,
      external_challenge_id = coalesce(excluded.external_challenge_id, fixture_external_play.external_challenge_id),
      play_url = coalesce(excluded.play_url, fixture_external_play.play_url),
      white_play_url = coalesce(excluded.white_play_url, fixture_external_play.white_play_url),
      black_play_url = coalesce(excluded.black_play_url, fixture_external_play.black_play_url),
      white_lichess_id = coalesce(excluded.white_lichess_id, fixture_external_play.white_lichess_id),
      black_lichess_id = coalesce(excluded.black_lichess_id, fixture_external_play.black_lichess_id),
      challenge_created_at = coalesce(excluded.challenge_created_at, fixture_external_play.challenge_created_at),
      last_error = excluded.last_error,
      emailed_at = coalesce(fixture_external_play.emailed_at, excluded.emailed_at),
      updated_at = now()`;
}

/**
 * T−15 window: email both players the Seazn lobby URL. Does not mint a
 * Lichess challenge — that waits until both click Ready.
 */
export async function prepareExternalPlayWindow(
  deps: PrepareExternalPlayDeps,
): Promise<PrepareExternalPlayCounts> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - PREPARE_LOOKBACK_MS);
  const windowEnd = new Date(now.getTime() + PREPARE_AHEAD_MS);
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
           ep.emailed_at as ep_emailed_at,
           ep.challenge_created_at
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
         or ep.status in ('pending', 'ready')
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

      // Lobby row only. Never downgrade a minted, live, or queued bridge.
      if (
        !row.ep_status ||
        row.ep_status === "pending"
      ) {
        await upsertExternalPlay({
          fixtureId: row.fixture_id,
          orgId: row.org_id,
          status: "pending",
          lastError: null,
          whiteLichessId: whiteLink.externalUserId,
          blackLichessId: blackLink.externalUserId,
        });
      }

      if (row.ep_emailed_at) continue;

      const url = fixtureUrl(deps.origin, row);
      const targets: { email: string; locale: string | null; opponentName: string }[] = [
        ...white.recipients.map((r) => ({ ...r, opponentName: black.displayName })),
        ...black.recipients.map((r) => ({ ...r, opponentName: white.displayName })),
      ];
      if (targets.length === 0) continue;

      let sent = 0;
      for (const target of targets) {
        const locale: Locale = toLocale(target.locale);
        const ok = await sendReady(
          target.email,
          {
            orgName: row.org_name,
            opponentName: target.opponentName,
            scheduledLabel: scheduledLabel(row.scheduled_at, locale),
            fixtureUrl: url,
          },
          locale,
        );
        if (ok) sent += 1;
      }
      if (sent === targets.length) {
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

export type ExternalPlayLobbyView = {
  status: string;
  side: "home" | "away";
  homeReady: boolean;
  awayReady: boolean;
  /** ready_up = click Ready; countdown = link minted; closed = game started or queued. */
  phase: "ready_up" | "countdown" | "closed";
  playUrl: string | null;
  whitePlayUrl: string | null;
  blackPlayUrl: string | null;
  challengeCreatedAt: string | null;
  expiresAt: string | null;
};

type LobbyContext = {
  fixture_id: string;
  org_id: string;
  side: "home" | "away";
  division_config: { clock?: { base: number; increment?: number; delay?: number } } | null;
  ep_status: string | null;
  play_url: string | null;
  white_play_url: string | null;
  black_play_url: string | null;
  challenge_created_at: Date | null;
  white_ready_at: Date | null;
  black_ready_at: Date | null;
};

async function loadLobbyContext(userId: string, fixtureId: string): Promise<LobbyContext> {
  const [row] = await sql<LobbyContext[]>`
    select f.id as fixture_id,
           f.org_id,
           case when e.id = f.home_entrant_id then 'home' else 'away' end as side,
           d.config as division_config,
           ep.status as ep_status,
           ep.play_url,
           ep.white_play_url,
           ep.black_play_url,
           ep.challenge_created_at,
           ep.white_ready_at,
           ep.black_ready_at
      from fixtures f
      join divisions d on d.id = f.division_id
      join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
      join entrant_members em on em.entrant_id = e.id
      join persons p on p.id = em.person_id
       and p.user_id = ${userId}
       and p.merged_into is null
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.id = ${fixtureId}
     limit 1`;
  if (!row) throw new HttpError(403, "This match doesn't involve your player profile", "NOT_YOUR_FIXTURE");
  return row;
}

function challengeFresh(status: string | null, createdAt: Date | null, now: Date): boolean {
  if (status !== "ready" || !createdAt) return false;
  return now.getTime() - new Date(createdAt).getTime() <= CHALLENGE_TTL_MS;
}

function lobbyView(row: LobbyContext, now: Date): ExternalPlayLobbyView {
  const closed = row.ep_status === "live" || row.ep_status === "finished" || row.ep_status === "needs_organiser";
  const fresh = challengeFresh(row.ep_status, row.challenge_created_at, now);
  const created = row.challenge_created_at ? new Date(row.challenge_created_at).toISOString() : null;
  return {
    status: row.ep_status ?? "pending",
    side: row.side,
    homeReady: row.white_ready_at != null,
    awayReady: row.black_ready_at != null,
    phase: closed ? "closed" : fresh ? "countdown" : "ready_up",
    playUrl: fresh || row.ep_status === "live" ? row.play_url : null,
    whitePlayUrl: fresh || row.ep_status === "live" ? row.white_play_url : null,
    blackPlayUrl: fresh || row.ep_status === "live" ? row.black_play_url : null,
    challengeCreatedAt: fresh ? created : null,
    expiresAt: fresh && created ? new Date(new Date(created).getTime() + CHALLENGE_TTL_MS).toISOString() : null,
  };
}

/** Drop a missed 20s challenge so both players must click Ready again. */
async function clearMissedChallenge(fixtureId: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - CHALLENGE_TTL_MS);
  await sql`
    update fixture_external_play
       set status = 'pending',
           white_ready_at = null,
           black_ready_at = null,
           external_challenge_id = null,
           play_url = null,
           white_play_url = null,
           black_play_url = null,
           challenge_created_at = null,
           updated_at = now()
     where fixture_id = ${fixtureId}
       and status = 'ready'
       and challenge_created_at is not null
       and challenge_created_at < ${cutoff}`;
}

export async function readExternalPlayLobby(
  userId: string,
  fixtureId: string,
  now = new Date(),
): Promise<ExternalPlayLobbyView> {
  await clearMissedChallenge(fixtureId, now);
  return lobbyView(await loadLobbyContext(userId, fixtureId), now);
}

/**
 * Record this player's Ready click. Mint only when the other side has also
 * clicked and no fresh challenge exists. A missed window is cleared first.
 */
export async function markExternalPlayReady(opts: {
  userId: string;
  fixtureId: string;
  now?: Date;
  adapter?: ExternalPlayAdapter;
}): Promise<ExternalPlayLobbyView> {
  const now = opts.now ?? new Date();
  const adapter = opts.adapter ?? createLichessAdapter({ fetch });
  await clearMissedChallenge(opts.fixtureId, now);
  const ctx = await loadLobbyContext(opts.userId, opts.fixtureId);
  if (ctx.ep_status === "live" || ctx.ep_status === "finished" || ctx.ep_status === "needs_organiser") {
    return lobbyView(ctx, now);
  }

  if (ctx.side === "home") {
    await sql`
      insert into fixture_external_play (fixture_id, org_id, provider, status, white_ready_at, updated_at)
      values (${opts.fixtureId}, ${ctx.org_id}, 'lichess', 'pending', ${now}, now())
      on conflict (fixture_id) do update set white_ready_at = ${now}, updated_at = now()`;
  } else {
    await sql`
      insert into fixture_external_play (fixture_id, org_id, provider, status, black_ready_at, updated_at)
      values (${opts.fixtureId}, ${ctx.org_id}, 'lichess', 'pending', ${now}, now())
      on conflict (fixture_id) do update set black_ready_at = ${now}, updated_at = now()`;
  }

  const locked = await sql.begin(async (tx) => {
    const [row] = await tx<LobbyContext[]>`
      select f.id as fixture_id,
             f.org_id,
             ${ctx.side} as side,
             d.config as division_config,
             ep.status as ep_status,
             ep.play_url,
             ep.white_play_url,
             ep.black_play_url,
             ep.challenge_created_at,
             ep.white_ready_at,
             ep.black_ready_at
        from fixtures f
        join divisions d on d.id = f.division_id
        join fixture_external_play ep on ep.fixture_id = f.id
       where f.id = ${opts.fixtureId}
       for update of ep`;
    if (!row) return null;
    if (challengeFresh(row.ep_status, row.challenge_created_at, now)) return row;
    if (!row.white_ready_at || !row.black_ready_at) return row;

    const home = await loadSide(
      (await tx<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${opts.fixtureId}`)[0]!
        .home_entrant_id,
    );
    const away = await loadSide(
      (await tx<{ away_entrant_id: string }[]>`select away_entrant_id from fixtures where id = ${opts.fixtureId}`)[0]!
        .away_entrant_id,
    );
    if (!home?.userId || !away?.userId) return row;
    const whiteLink = await getLinkedAccount(home.userId, "lichess");
    const blackLink = await getLinkedAccount(away.userId, "lichess");
    const whiteToken = await getLichessAccessToken(home.userId);
    if (!whiteLink || !blackLink || !whiteToken) return row;
    const clockMap = mapBoardgameClockToLichess(row.division_config?.clock);
    if (!clockMap.ok) {
      await tx`
        update fixture_external_play
           set status = 'needs_organiser', last_error = ${clockMap.reason}, updated_at = now()
         where fixture_id = ${opts.fixtureId}`;
      return { ...row, ep_status: "needs_organiser" };
    }
    const challenge = await adapter.createChallenge({
      whiteAccessToken: whiteToken,
      blackLichessUsername: blackLink.username,
      clock: clockMap.clock,
      rated: false,
    });
    await tx`
      update fixture_external_play
         set status = 'ready',
             external_challenge_id = ${challenge.challengeId},
             play_url = ${challenge.whitePlayUrl},
             white_play_url = ${challenge.whitePlayUrl},
             black_play_url = ${challenge.blackPlayUrl},
             white_lichess_id = ${whiteLink.externalUserId},
             black_lichess_id = ${blackLink.externalUserId},
             challenge_created_at = ${now},
             last_error = null,
             updated_at = now()
       where fixture_id = ${opts.fixtureId}`;
    return {
      ...row,
      ep_status: "ready",
      play_url: challenge.whitePlayUrl,
      white_play_url: challenge.whitePlayUrl,
      black_play_url: challenge.blackPlayUrl,
      challenge_created_at: now,
    };
  });

  void publishExternalPlayLobby(opts.fixtureId);
  if (!locked) return lobbyView(await loadLobbyContext(opts.userId, opts.fixtureId), now);
  return lobbyView({ ...locked, side: ctx.side }, now);
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
  white_lichess_id: string | null;
  black_lichess_id: string | null;
  home_entrant_id: string;
  away_entrant_id: string;
  fixture_status: string;
  fixture_outcome: unknown;
};

async function loadBridgeByGameId(gameId: string): Promise<ExternalPlayBridgeRow | null> {
  const rows = await sql<ExternalPlayBridgeRow[]>`
    select ep.fixture_id, ep.org_id, ep.status,
           ep.external_challenge_id, ep.external_game_id,
           ep.white_lichess_id, ep.black_lichess_id,
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

async function boundLichessIds(
  bridge: ExternalPlayBridgeRow,
): Promise<{ white: string; black: string } | null> {
  if (bridge.white_lichess_id && bridge.black_lichess_id) {
    return { white: bridge.white_lichess_id, black: bridge.black_lichess_id };
  }
  const white = await loadSide(bridge.home_entrant_id);
  const black = await loadSide(bridge.away_entrant_id);
  if (!white?.userId || !black?.userId) return null;
  const homeLink = await getLinkedAccount(white.userId, "lichess");
  const awayLink = await getLinkedAccount(black.userId, "lichess");
  if (!homeLink || !awayLink) return null;
  return { white: homeLink.externalUserId, black: awayLink.externalUserId };
}

async function markLive(bridge: ExternalPlayBridgeRow, gameId: string): Promise<"live"> {
  const seq = await nextExpectedSeq(bridge.org_id, bridge.fixture_id);
  if (seq === 0) {
    const auth = await mintOrgOwnerAuth(bridge.org_id);
    await scoreEvent(auth, bridge.fixture_id, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
      idempotency_key: `lichess:${gameId}:start`,
    });
  }
  await sql`
    update fixture_external_play
       set status = 'live',
           external_game_id = ${gameId},
           started_at = coalesce(started_at, now()),
           last_error = null,
           play_url = coalesce(play_url, ${`https://lichess.org/${gameId}`}),
           updated_at = now()
     where fixture_id = ${bridge.fixture_id}`;
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

  const ids = await boundLichessIds(bridge);
  if (!ids) {
    return markNeedsOrganiser(bridge.fixture_id, "lichess_link_missing", snapshot.id);
  }
  if (
    snapshot.players.white.userId !== ids.white ||
    snapshot.players.black.userId !== ids.black
  ) {
    return markNeedsOrganiser(bridge.fixture_id, "account_mismatch", snapshot.id);
  }

  if (snapshot.status === "created" || snapshot.status === "started" || snapshot.status === "paused") {
    return markLive(bridge, snapshot.id);
  }

  const mapped = mapLichessGameToBoardgameResult({
    game: snapshot,
    homeEntrantId: bridge.home_entrant_id,
    awayEntrantId: bridge.away_entrant_id,
    homeLichessId: ids.white,
    awayLichessId: ids.black,
  });

  if (!mapped.ok) {
    if (mapped.reason === "unfinished") {
      return markLive(bridge, snapshot.id);
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

/** Re-send the Seazn fixture URL. Does not mint a new Lichess challenge. */
export async function resendExternalPlayNotice(
  auth: AuthCtx,
  fixtureId: string,
  origin: string,
): Promise<{ emailed: number }> {
  const [row] = await withTenant(auth.orgId, (tx) =>
    tx<
      {
        status: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        scheduled_at: Date | null;
        org_name: string;
        org_slug: string;
        competition_slug: string;
        division_slug: string;
      }[]
    >`
    select ep.status, f.home_entrant_id, f.away_entrant_id, f.scheduled_at,
           o.name as org_name, o.slug as org_slug,
           c.slug as competition_slug, d.slug as division_slug
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = c.org_id
     where ep.fixture_id = ${fixtureId}`,
  );
  if (!row) throw new HttpError(404, "No external-play record for this fixture");
  if (row.status === "finished") {
    throw new HttpError(409, "Fixture already finished", "ALREADY_RESOLVED");
  }
  if (!row.home_entrant_id || !row.away_entrant_id) {
    throw new HttpError(422, "Both sides must be seated before notifying");
  }
  const white = await loadSide(row.home_entrant_id);
  const black = await loadSide(row.away_entrant_id);
  if (!white || !black) throw new HttpError(422, "Both sides must be seated before notifying");
  const url = `${origin.replace(/\/$/, "")}${routes.sharedFixture(
    row.org_slug,
    row.competition_slug,
    row.division_slug,
    fixtureId,
  )}`;
  const when = row.scheduled_at ?? new Date();
  const targets = [
    ...white.recipients.map((r) => ({ ...r, opponentName: black.displayName })),
    ...black.recipients.map((r) => ({ ...r, opponentName: white.displayName })),
  ];
  let emailed = 0;
  for (const target of targets) {
    const locale = toLocale(target.locale);
    const ok = await sendExternalPlayReadyEmail(
      target.email,
      {
        orgName: row.org_name,
        opponentName: target.opponentName,
        scheduledLabel: scheduledLabel(when, locale),
        fixtureUrl: url,
      },
      locale,
    );
    if (ok) emailed += 1;
  }
  return { emailed };
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
      homeName: r.home_name ?? "",
      awayName: r.away_name ?? "",
      scheduledAt: r.scheduled_at ? r.scheduled_at.toISOString() : null,
      lastError: r.last_error,
    }));
  });
}
