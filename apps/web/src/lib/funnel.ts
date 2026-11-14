import "server-only";
// Start-a-competition funnel (v3/07 §6): a visitor configures a competition
// BEFORE authenticating; the draft rides a single-use emailed token that both
// proves email ownership (like login_links) and carries the payload. Claiming
// creates the org (if none), the competition and a division — with the format
// the visitor picked as its stages and their courts as a venue (start-wizard
// redesign, 2026-11-13), and NO entrants: the field size they chose is the
// target the getting-started read reports (/start "Sent stepper", 2026-11-14) —
// then lands the new organiser inside it. An address holds one live draft at a
// time, under a short reference that survives a resubmit (V518).
import crypto from "node:crypto";
import { z } from "zod";
import { sql, type Tx } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import { FUNNEL_CLAIM_DATE_PAST } from "@/lib/funnel-claim-codes";
import { funnelEarliestDay } from "@/lib/funnel-days";
import { funnelFormatMin, funnelFormatStages, isFunnelFormat } from "@/lib/funnel-formats";
import { funnelSportByKeyOrName } from "@/lib/funnel-sports";
import { HttpError } from "@/lib/errors";
import { isIsoDay } from "@/lib/sponsor-report";
import { getDictionary, t } from "@/lib/i18n";
import { lookup } from "@/lib/i18n-runtime";
import { DEFAULT_LOCALE, hasLocale, type Locale } from "@/lib/i18n-constants";
import { createOrgForUser, getUserOrgs } from "@/lib/auth";
import type { OrgMembership } from "@/lib/types";
import { CreateStages, type CreateCompetition } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { registrationDefaultKind } from "@/server/usecases/entrant-shape";
import { createEntrants } from "@/server/usecases/entrants";
import { frozenMemberIds } from "@/server/usecases/entitlement-freeze";
import { createStages } from "@/server/usecases/stages";
import { createCourt, createVenue, listVenues } from "@/server/usecases/venues";
import { pickVariant } from "@/lib/preferred-variant";
import { routes } from "@/lib/routes";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { EntrantKind } from "@seazn/engine/sport";

const DRAFT_TTL_DAYS = 7;

/** The plan row the funnel's field is capped by: a division's entrants. */
const ENTRANT_CAP_KEY = "entrants.per_division.max";

export const funnelPayloadSchema = z
  .object({
    name: z.string().min(1).max(200),
    sport: z.string().min(1).max(60),
    entrants: z.number().int().min(2).max(256),
    start_date: z.string().max(10).optional(),
    format: z.string().max(40).optional(),
    // The wizard's Planning fold, sent only when it was opened. Courts are built (one venue, this many courts); hours only
    // shaped the cards' estimate and are kept on the draft, never written (a duration is not a court's clock window).
    courts: z.number().int().min(1).max(32).optional(),
    hours: z.number().int().min(1).max(72).optional(),
  })
  .strict();

export type FunnelPayload = z.infer<typeof funnelPayloadSchema>;

export interface FunnelDraft {
  id: string;
  email: string;
  payload: FunnelPayload;
  /** The language the visitor started the draft in (the start route's pick); null when they gave none. */
  locale: Locale | null;
}

/** The reference alphabet (owner, 2026-11-14): digits and capitals less 0/O and 1/I, so a reference can be read aloud or
 *  retyped from an email. 32 symbols, so a random byte's low five bits pick one without bias. */
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REFERENCE_LENGTH = 6;

/** A draft reference's shape: what the V518 CHECK holds and the start route accepts as `previousReference`. */
export const FUNNEL_REFERENCE_SHAPE = /^SZ-[2-9A-HJ-NP-Z]{6}$/;

/** A fresh draft reference, `SZ-` and six symbols (the V518 CHECK holds the same shape). */
export function newFunnelReference(): string {
  return `SZ-${Array.from(crypto.randomBytes(REFERENCE_LENGTH), (b) => REFERENCE_ALPHABET[b & 31]).join("")}`;
}

/** The replace key is stored as this hash, never as given: the row must not hand out the proof that it was started here. */
const replaceKeyHash = (key: string): string => crypto.createHash("sha256").update(key).digest("hex");

/** An earlier draft the client names to replace (the Change-email flow): its reference and the replace key its start returned. */
export interface FunnelPrevious {
  reference: string;
  replaceKey: string;
}

export interface CreatedFunnelDraft {
  id: string;
  token: string;
  expiresAt: Date;
  /** The draft's human reference: the replaced draft's when this start replaced one, else a fresh one. */
  reference: string;
  /** Opaque, returned to the client that started the draft and stored only as a hash: with the reference, it lets that client
   *  (and nobody who merely knows or guesses the reference) replace this draft from another address. */
  replaceKey: string;
}

/** Create a draft on `db` and return its single-use claim token, the instant it stops working, its reference and its replace key.
 *  The start route passes its transaction, so the draft and the outbox row that carries its token are committed together or not
 *  at all. `locale` is the language the visitor started it in (the start route's pick), kept for the +24h reminder; null when they
 *  gave none.
 *
 *  ONE LIVE DRAFT PER ADDRESS (/start "Sent stepper" wave T1): every unused, unexpired, unreplaced draft of the same address
 *  (case-insensitive) is marked replaced, and so is the draft `previous` names when its reference AND key match a live one (the
 *  address may differ: the visitor changed it). The new draft carries the replaced draft's reference — `previous`'s when it named
 *  one, else the address's latest — so the code in the visitor's inbox never changes while they resubmit; a fresh one otherwise.
 *  A wrong key, or a reference alone, replaces nothing (and says nothing): the start goes on as a fresh one. Starts for one address
 *  are serialised by an advisory lock, so two at once cannot each find nothing and each leave a live draft. */
export async function createFunnelDraft(
  email: string,
  payload: FunnelPayload,
  db: Tx | typeof sql = sql,
  locale: Locale | null = null,
  previous: FunnelPrevious | null = null,
): Promise<CreatedFunnelDraft> {
  const write = async (tx: Tx): Promise<CreatedFunnelDraft> => {
    await tx`select pg_advisory_xact_lock(hashtext(${`funnel-draft:${email.toLowerCase()}`}))`;
    const keyed = previous
      ? await tx<{ id: string; reference: string }[]>`
          select id, reference from funnel_drafts
           where reference = ${previous.reference} and replace_key_hash = ${replaceKeyHash(previous.replaceKey)}
             and used_at is null and replaced_at is null and expires_at > now()
           for update`
      : [];
    const sameAddress = await tx<{ id: string; reference: string }[]>`
      select id, reference from funnel_drafts
       where lower(email) = lower(${email}) and used_at is null and replaced_at is null and expires_at > now()
       order by created_at desc, id desc
       for update`;
    const replaced = [...new Set([...keyed, ...sameAddress].map((r) => r.id))];
    const reference = keyed[0]?.reference ?? sameAddress[0]?.reference ?? newFunnelReference();
    // Retired BEFORE the insert: the live-reference index admits one live draft per reference.
    if (replaced.length > 0) await tx`update funnel_drafts set replaced_at = now() where id = any(${replaced}::uuid[])`;
    // A replaced draft names the reference its latest email carries ("check your latest email, SZ-…"): when the replaced drafts
    // carried another one (a draft at the new address beside the one the key named), every replaced draft of that reference takes
    // the surviving one, so an old link never points the visitor at a code no live email carries.
    const retired = [...new Set([...keyed, ...sameAddress].map((r) => r.reference))].filter((r) => r !== reference);
    if (retired.length > 0) {
      await tx`update funnel_drafts set reference = ${reference} where replaced_at is not null and reference = any(${retired}::text[])`;
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const replaceKey = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000);
    const [row] = await tx<{ id: string }[]>`
      insert into funnel_drafts (token, email, payload, expires_at, locale, reference, replace_key_hash)
      values (${token}, ${email}, ${tx.json(payload)}, ${expiresAt.toISOString()}, ${locale}, ${reference}, ${replaceKeyHash(replaceKey)})
      returning id`;
    return { id: row!.id, token, expiresAt, reference, replaceKey };
  };
  // The pool opens its own transaction; a caller's transaction is used as it is (the lock is held until it commits). By identity:
  // the pooled handle is a Proxy, so `"begin" in sql` is false.
  return db === sql ? sql.begin(write) : write(db as Tx);
}

/** The reference of the draft `token` names when a newer start REPLACED it, else null (no such draft, or one that was not
 *  replaced). What the claim reads after a refused consume, to tell "replaced by a newer link" from a dead one. Replaced is
 *  terminal, so this read outside the consume's transaction cannot disagree with it. */
export async function replacedFunnelDraftReference(token: string): Promise<string | null> {
  const [row] = await sql<{ reference: string }[]>`
    select reference from funnel_drafts where token = ${token} and replaced_at is not null limit 1`;
  return row?.reference ?? null;
}

/**
 * Consume a claim token: mark it used and return the draft if it was valid,
 * unexpired, unused and not replaced by a newer start — otherwise null. Single-use inside one transaction,
 * exactly like login-link consumption (clicking proves email ownership).
 */
export async function consumeFunnelDraft(token: string): Promise<FunnelDraft | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<
      {
        id: string;
        email: string;
        payload: unknown;
        expires_at: string;
        used_at: string | null;
        replaced_at: string | null;
        locale: string | null;
      }[]
    >`
      select id, email, payload, expires_at, used_at, replaced_at, locale
      from funnel_drafts where token = ${token}
      for update limit 1`;
    if (!row || row.used_at || row.replaced_at || new Date(row.expires_at).getTime() < Date.now()) {
      return null;
    }
    const parsed = funnelPayloadSchema.safeParse(row.payload);
    if (!parsed.success) return null;
    await tx`update funnel_drafts set used_at = now() where id = ${row.id}`;
    // The column's CHECK holds it to the shipped locales; anything else reads as no language, never a cast.
    const locale = row.locale !== null && hasLocale(row.locale) ? row.locale : null;
    return { id: row.id, email: row.email, payload: parsed.data, locale };
  });
}

/** What the claim page reads of the draft `token` names, WITHOUT claiming it: the language it was started in (the emailed
 *  link carries none, so the card is worded in this one first), its sport as /start's key (the first-day-passed
 *  card's "Start again" link carries it) and its reference (the replaced-link card names the code to look for in the latest
 *  email: a replaced draft carries its successor's reference — createFunnelDraft keeps them in step). Any draft the token
 *  names, used, replaced or expired too — a link opened a second time is still that visitor's, and its card is theirs to read.
 *  Each is null when the token names no draft, the draft has no language, or its sport is none /start lists. Never the
 *  address, the name or the rest of the payload. */
export async function funnelDraftCard(
  token: string,
): Promise<{ locale: Locale | null; sportKey: string | null; reference: string | null }> {
  const [row] = await sql<{ locale: string | null; sport: string | null; reference: string }[]>`
    select locale, payload->>'sport' as sport, reference from funnel_drafts where token = ${token} limit 1`;
  return {
    locale: row?.locale != null && hasLocale(row.locale) ? row.locale : null,
    sportKey: row?.sport != null ? (funnelSportByKeyOrName(row.sport)?.key ?? null) : null,
    reference: row?.reference ?? null,
  };
}

/** How many entrants a division of a new organisation on `planKey` holds (the free plan by default: a claim with no
 *  organisation yet makes one on it), read from the live plan catalogue — the number /start quotes beside its size
 *  stepper. `null` is unlimited; a plan with no row holds none, as the resolver reads a missing row (`getLimit`). */
export async function funnelEntrantCap(planKey: "community" = "community"): Promise<number | null> {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements where plan_key = ${planKey} and feature_key = ${ENTRANT_CAP_KEY}`;
  return row ? row.int_value : 0;
}

/** Map the funnel's free-text sport onto the engine catalog: an exact-name
 *  sport with its PREFERRED system variant (the one the division builder
 *  preselects - `lib/preferred-variant.ts`, so the two creation paths cannot
 *  disagree; W2e D2 made badminton's 3x15), else the first system variant by
 *  key, else the generic score module. */
export async function resolveSport(
  sport: string,
): Promise<{ sport_key: string; variant_key: string }> {
  const rows = await sql<{ sport_key: string; variant_key: string }[]>`
    select s.key as sport_key, v.key as variant_key
    from sports s
    join sport_variants v on v.sport_key = s.key and v.is_system
    where lower(s.name) = ${sport.toLowerCase()}
    order by s.key, v.key`;
  const first = rows[0];
  if (first) {
    const variants = rows.filter((r) => r.sport_key === first.sport_key).map((r) => ({ key: r.variant_key }));
    return { sport_key: first.sport_key, variant_key: pickVariant(first.sport_key, variants) };
  }
  const [generic] = await sql<{ variant_key: string }[]>`
    select key as variant_key from sport_variants
    where sport_key = 'generic' and is_system
    order by key limit 1`;
  return { sport_key: "generic", variant_key: generic?.variant_key ?? "score" };
}

/** The `ui` key each entrant kind's placeholder name reads; `{n}` is its seed. */
const PLACEHOLDER_NAME_KEY: Record<EntrantKind, string> = {
  individual: "funnel.claim.entrant.individual",
  pair: "funnel.claim.entrant.pair",
  team: "funnel.claim.entrant.team",
};

/** The writes after the competition, each named in the partial-build log. */
type ClaimStep = "division" | "stages" | "entrants" | "venue";

/** A write refused AFTER the competition exists: the event is part-built behind a spent token. `cause` is the use-case's
 *  own refusal, unchanged (its status, its feature key); the claim route reads it to tell a part-built event from one
 *  of which nothing was written. */
export class FunnelClaimPartialError extends Error {
  constructor(
    readonly step: ClaimStep,
    readonly competitionId: string,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "FunnelClaimPartialError";
  }
}

/** Run one write of a claim whose competition already exists. A refusal here leaves a half-built event behind a spent
 *  token, and a 4xx is logged by no one else (lib/http.ts logs 5xx only), so it is said once — which step, which
 *  competition; never the address, the token or the draft — and rethrown as a FunnelClaimPartialError around it. */
async function claimStep<T>(step: ClaimStep, competitionId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : null;
    log.error({ step, competitionId, status }, "funnel_claim_build_partial");
    throw new FunnelClaimPartialError(step, competitionId, err);
  }
}

/** The existing organisation a claim builds into, or null for a new one: the oldest the user OWNS; else the oldest they
 *  administer on a seat the plan has not frozen (doc 10 §2.4 — the seat requireOrgAuth refuses a write through; owners are
 *  never frozen). Never one they only view, nor a frozen seat's: the use-cases the claim calls re-check neither the role nor
 *  the seat, so either would write an event into someone else's organisation past its owners (review-whole I1). */
async function claimTargetOrg(userId: string): Promise<OrgMembership | null> {
  const orgs = await getUserOrgs(userId); // oldest first
  const owned = orgs.find((o) => o.role === "owner");
  if (owned) return owned;
  for (const o of orgs) {
    if (o.role === "admin" && !(await frozenMemberIds(o.id)).has(userId)) return o;
  }
  return null;
}

/**
 * Turn a claimed draft into real structure for `userId` and return where to
 * land: inside the new competition on the division's entrants tab. Uses the
 * standard use-cases, so quotas/slugs/audit all apply as if typed by hand.
 *
 * In order (start-wizard redesign plan, 2026-11-13):
 *   -. before anything, the first day: one that is not a calendar day or is before the UTC day less one is refused
 *      (400), so a stale or hand-made draft writes nothing — not even the organisation;
 *   0. the organisation (`claimTargetOrg`: the oldest the user owns, else the oldest they administer on an unfrozen seat,
 *      else a new one), then a PRE-FLIGHT of the reads and checks the build can make before its first write — the
 *      language, the sport, the entrant cap, the stage graph parsed as the API parses it.
 *      Not pre-flighted: the active-competition quota (createCompetition's own check, which refuses BEFORE its insert,
 *      so a 402 there writes nothing of the event) and the stage kinds' plan features (createStages, after the
 *      competition and division exist). Not one transaction: each use-case opens its own (`withTenant` never nests);
 *   1. the competition — one day long when the visitor gave a date (D5); undated otherwise (Q2: an end date needs a
 *      day the visitor never gave, the #376 residual);
 *   2. the division, of the sport's preferred variant, named as the sport is in the draft's language;
 *   3. the field: the visitor's size held to the plan's per-division cap (D4, Q1). It is the ONE size both the stages
 *      and the entrants are built for, so a 256 ask on a 64-entrant plan builds a 64 field's graph and 64 entrants —
 *      never a bracket sized for entrants that do not exist;
 *   4. the stages of the format card they picked, the graph that card's match count was read off
 *      (lib/funnel-formats.ts); none for a format the funnel does not offer, a draft that names none (old drafts), or a
 *      field below the format's minimum — never a guess;
 *   5. the entrants: name-only, of the division's default kind, seeded 1..field, named in the draft's language;
 *   6. the courts, when the visitor opened Planning and the organisation has no active venue: one venue holding that
 *      many. The hours are never written (D1).
 * A write after the competition that is refused is logged by step (`claimStep`) and rethrown as a
 * FunnelClaimPartialError; a refusal before it (the quota, the pre-flight) is thrown as it came.
 */
export async function createFromDraft(
  userId: string,
  draft: FunnelDraft,
): Promise<{ redirect: string; orgId: string }> {
  const { payload } = draft;
  // Before any write: a first day that is no calendar day, or that has passed for every visitor (before the UTC day less
  // one, the /start parser's own tolerance), is refused — the draft was started days ago, or its body was hand-made.
  if (payload.start_date !== undefined && (!isIsoDay(payload.start_date) || payload.start_date < funnelEarliestDay(new Date()))) {
    throw new HttpError(400, "This event's first day has already passed — nothing was set up.", FUNNEL_CLAIM_DATE_PAST);
  }
  const dict = await getDictionary(draft.locale ?? DEFAULT_LOCALE, "ui");
  // The organisation the claim builds into (`claimTargetOrg`); none such, a new one of their own, named in the draft's
  // language. The claim acts with the role the user holds there — owner of the organisation it just created.
  const target = await claimTargetOrg(userId);
  const org = target ?? (await createOrgForUser(userId, t(dict, "funnel.claim.orgName", { name: payload.name })));
  const auth: AuthCtx = { orgId: org.id, via: "session", userId, role: target?.role ?? "owner", keyId: null };

  // 0. Pre-flight.
  const { sport_key, variant_key } = await resolveSport(payload.sport);
  // Other (and a name the registry does not know) builds the generic module, whose dictionary name is "Generic" — a word
  // for the engine, not for an organiser's division.
  const sportName = lookup(dict, sport_key === "generic" ? "funnel.claim.division.other" : `sport.${sport_key}`);
  // Org-wide: a competition created a moment from now holds no Event Pass and no add-on aimed at it, so this is the
  // answer its division's entrant write will get.
  const cap = await getLimit(org.id, ENTRANT_CAP_KEY);
  const field = cap === null ? payload.entrants : Math.min(payload.entrants, cap);
  const { format } = payload;
  // Parsed as the stages route parses the division builder's POST: a graph the API would refuse is refused here, before
  // anything of the event exists.
  const stages =
    isFunnelFormat(format) && field >= funnelFormatMin(format)
      ? CreateStages.parse(funnelFormatStages(format, field).map((stage, i) => ({ seq: i + 1, ...stage })))
      : null;

  // 1. The cast is the undated draft's: CreateCompetition requires an end date (#376) and an undated draft has none (Q2).
  const competition = await createCompetition(auth, {
    name: payload.name,
    visibility: "private",
    branding: {},
    ...(payload.start_date ? { starts_on: payload.start_date, ends_on: payload.start_date } : {}),
  } as CreateCompetition);
  if (field < payload.entrants) {
    log.info(
      { orgId: org.id, competitionId: competition.id, requested: payload.entrants, cap },
      "funnel_claim_entrants_clamped",
    );
  }

  // 2.
  const division = await claimStep("division", competition.id, () =>
    createDivision(auth, competition.id, {
      name: typeof sportName === "string" ? sportName : payload.sport,
      sport_key,
      variant_key,
      config: {},
    } as never),
  );

  // 3-4.
  if (stages !== null) await claimStep("stages", competition.id, () => createStages(auth, division.id, stages));

  // 5. A plan that holds no entrants (`field` 0) asks for an empty batch, which createEntrants writes nothing for.
  const kind = registrationDefaultKind(division);
  await claimStep("entrants", competition.id, () =>
    createEntrants(
      auth,
      division.id,
      Array.from({ length: field }, (_, i) => ({
        kind,
        display_name: t(dict, PLACEHOLDER_NAME_KEY[kind], { n: i + 1 }),
        seed: i + 1,
        members: [],
      })),
    ),
  );

  // 6.
  const { courts } = payload;
  if (courts !== undefined) {
    await claimStep("venue", competition.id, async () => {
      if ((await listVenues(auth)).length > 0) return;
      const venue = await createVenue(auth, { name: t(dict, "funnel.claim.venue"), sort: 0 });
      for (let i = 1; i <= courts; i++) {
        await createCourt(auth, venue.id, { name: t(dict, "funnel.claim.court", { n: i }), sort: i - 1, tags: [] });
      }
    });
  }

  return {
    redirect: routes.division(org.slug, competition.slug, division.slug, "entrants"),
    orgId: org.id,
  };
}
