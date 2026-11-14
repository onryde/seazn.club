// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, raw, call, check, tag, checkOutboxRow, smokeDb, html, type Session } from "../harness.ts";

/** What a claim built, read back from the division its redirect lands on (`/o/<org>/c/<comp>/d/<div>?tab=entrants`): the
 *  stage kinds in seq order, how many entrants the division holds, the field size recorded on the draft stamped with the
 *  competition (V518 `funnel_drafts.competition_id`; the getting-started target), the organisation's active venues and
 *  courts, and its court-hours rows. Null when the redirect names no division the database holds. */
async function builtBy(redirect: string): Promise<{
  stageKinds: string[];
  entrants: number;
  target: number | null;
  venues: number;
  courts: number;
  courtHours: number;
} | null> {
  const m = /^\/o\/([^/]+)\/c\/([^/]+)\/d\/([^/?]+)\?/.exec(redirect);
  if (!m) return null;
  const [, org, comp, div] = m;
  const db = smokeDb();
  try {
    const [row] = await db<{ division_id: string; org_id: string; competition_id: string }[]>`
      select d.id as division_id, o.id as org_id, c.id as competition_id
        from divisions d
        join competitions c on c.id = d.competition_id
        join organizations o on o.id = c.org_id
       where o.slug = ${org} and c.slug = ${comp} and d.slug = ${div}`;
    if (!row) return null;
    const stages = await db<{ kind: string }[]>`select kind from stages where division_id = ${row.division_id} order by seq`;
    const [{ entrants }] = await db<{ entrants: number }[]>`
      select count(*)::int as entrants from entrants where division_id = ${row.division_id}`;
    const [draft] = await db<{ target: number | null }[]>`
      select (payload->>'entrants')::int as target from funnel_drafts where competition_id = ${row.competition_id}`;
    const [{ venues }] = await db<{ venues: number }[]>`
      select count(*)::int as venues from venues where org_id = ${row.org_id} and archived_at is null`;
    const [{ courts }] = await db<{ courts: number }[]>`
      select count(*)::int as courts from courts c join venues v on v.id = c.venue_id
       where c.org_id = ${row.org_id} and c.archived_at is null and v.archived_at is null`;
    const [{ courtHours }] = await db<{ courtHours: number }[]>`
      select count(*)::int as "courtHours" from court_hours where org_id = ${row.org_id}`;
    return { stageKinds: stages.map((s) => s.kind), entrants, target: draft?.target ?? null, venues, courts, courtHours };
  } finally {
    await db.end();
  }
}

/** A start, then its claim by the dev-exposed link's token. Returns the token and where the claim landed. */
async function startAndClaim(
  visitor: Session,
  body: Record<string, unknown>,
  label: string,
): Promise<{ token: string | null; redirect: string }> {
  const started = (await call(visitor, "/api/funnel/start", "POST", body)) as { claim_url?: string };
  check(`funnel: ${label}: draft created with dev claim_url`, !!started.claim_url);
  const token = new URL(started.claim_url ?? "http://x/").searchParams.get("token");
  const claimed = (await call(visitor, "/api/funnel/claim", "POST", { token })) as { redirect: string };
  return { token, redirect: claimed.redirect };
}

export async function funnelSuite(): Promise<void> {
  // ── 1. The body every older client posts (start wizard plan D6): name, sport by its table NAME, a size, no format, no
  //       Planning. It still starts and claims, and builds the division with no stage (a draft that names no format builds
  //       none — never a guess, D4), no venue and no entrant: the 8 chosen are the draft's target (/start "Sent stepper",
  //       owner 2026-11-14, removed the "Player 1..n" placeholders).
  const visitor = newSession();
  const funnelEmail = `delivered+funnel_${tag}@resend.dev`;
  const { token, redirect } = await startAndClaim(
    visitor,
    { email: funnelEmail, name: `Funnel Fiesta ${tag}`, sport: "Badminton", entrants: 8 },
    "old-shaped body",
  );

  // Email outbox, phase 3 wave 3 (Task 5): the claim email is one `funnel_claim` row, ref the draft (the response does not name it, so
  // it is read back by the visitor's address), its first attempt made in the request and no body left on it. Keyless run: no DB.
  if (process.env.DATABASE_URL) {
    const db = smokeDb();
    let draftId: string | undefined;
    try {
      const [draft] = await db<{ id: string }[]>`
        select id from funnel_drafts where email = ${funnelEmail} order by created_at desc limit 1`;
      draftId = draft?.id;
    } finally {
      await db.end();
    }
    check("funnel: the start stored a draft for the visitor's address", !!draftId);
    if (draftId) await checkOutboxRow("funnel_claim", "funnel_draft", draftId);
  }

  check(
    "funnel: claim lands inside the competition (entrants tab)",
    /^\/o\/[^/]+\/c\/funnel-fiesta[^/]*\/d\/[^/?]+\?tab=entrants$/.test(redirect),
  );
  check("funnel: claim started a session", !!visitor.cookies["seazn_session"]);
  const landing = await html(visitor, redirect);
  check(
    "funnel: landing page renders the new competition",
    landing.status === 200 && landing.body.includes(`Funnel Fiesta ${tag}`),
  );
  if (process.env.DATABASE_URL) {
    const built = await builtBy(redirect);
    check("funnel: old-shaped body: the redirect names a division the database holds", built !== null);
    check("funnel: old-shaped body: no format, so no stage", built !== null && built.stageKinds.length === 0);
    check("funnel: old-shaped body: no placeholder entrant", built !== null && built.entrants === 0);
    check("funnel: old-shaped body: the 8 chosen are the stamped draft's target", built !== null && built.target === 8);
    check("funnel: old-shaped body: no Planning, so no venue and no court", built !== null && built.venues === 0 && built.courts === 0);
  }

  // Single-use: a second consume is the named dead-link refusal (the card words it), a 400 — never a 500.
  const again = await raw(visitor, "/api/funnel/claim", "POST", { token });
  check(
    "funnel: claim token is single-use (400 FUNNEL_CLAIM_INVALID)",
    again.status === 400 && again.json.ok === false && (again.json as { code?: string }).code === "FUNNEL_CLAIM_INVALID",
  );

  // ── 2. The wizard's body (start wizard plan T7): a format, and the Planning fold's courts and hours. The claim builds the
  //       format's stage graph (a knockout is one knockout stage, the rulebook's own shape), no entrant (8 is the target), one
  //       venue holding the 2 courts, and writes no court hours (D1: hours only shaped the card's estimate). A fresh visitor, so
  //       the organisation it lands in is a new one with no venue of its own yet.
  const planner = newSession();
  const planned = await startAndClaim(
    planner,
    {
      email: `delivered+funnel_ko_${tag}@resend.dev`,
      locale: "en",
      name: `Funnel Bracket ${tag}`,
      sport: "Badminton",
      entrants: 8,
      format: "knockout",
      courts: 2,
      hours: 3,
    },
    "knockout with Planning",
  );
  check(
    "funnel: knockout with Planning: claim lands inside the competition (entrants tab)",
    /^\/o\/[^/]+\/c\/funnel-bracket[^/]*\/d\/[^/?]+\?tab=entrants$/.test(planned.redirect),
  );
  if (process.env.DATABASE_URL) {
    const built = await builtBy(planned.redirect);
    check("funnel: knockout with Planning: the redirect names a division the database holds", built !== null);
    check(
      "funnel: knockout with Planning: one knockout stage",
      built !== null && JSON.stringify(built.stageKinds) === JSON.stringify(["knockout"]),
    );
    check("funnel: knockout with Planning: no placeholder entrant", built !== null && built.entrants === 0);
    check("funnel: knockout with Planning: the 8 chosen are the target", built !== null && built.target === 8);
    check("funnel: knockout with Planning: one venue holding 2 courts", built !== null && built.venues === 1 && built.courts === 2);
    check("funnel: knockout with Planning: the hours write no court hours", built !== null && built.courtHours === 0);
  }
  const plannedAgain = await raw(planner, "/api/funnel/claim", "POST", { token: planned.token });
  check(
    "funnel: knockout with Planning: its token is single-use too (400 FUNNEL_CLAIM_INVALID)",
    plannedAgain.status === 400 && (plannedAgain.json as { code?: string }).code === "FUNNEL_CLAIM_INVALID",
  );

  // ── 3. A first day that has passed (T4 follow-up): the start takes it (the claim decides), and the claim refuses it with
  //       its own code before any write — no competition by that name exists after it.
  const late = newSession();
  const lateName = `Funnel Late ${tag}`;
  const now = new Date();
  const monthAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30)).toISOString().slice(0, 10);
  const lateStart = (await call(late, "/api/funnel/start", "POST", {
    email: `delivered+funnel_late_${tag}@resend.dev`,
    name: lateName,
    sport: "Badminton",
    entrants: 8,
    start_date: monthAgo,
  })) as { claim_url?: string };
  check("funnel: past first day: draft created with dev claim_url", !!lateStart.claim_url);
  const lateToken = new URL(lateStart.claim_url ?? "http://x/").searchParams.get("token");
  const refused = await raw(late, "/api/funnel/claim", "POST", { token: lateToken });
  check(
    "funnel: past first day: the claim is a 400 FUNNEL_CLAIM_DATE_PAST",
    refused.status === 400 && (refused.json as { code?: string }).code === "FUNNEL_CLAIM_DATE_PAST",
  );
  if (process.env.DATABASE_URL) {
    const db = smokeDb();
    try {
      const [{ n }] = await db<{ n: number }[]>`select count(*)::int as n from competitions where name = ${lateName}`;
      check("funnel: past first day: nothing was built", n === 0);
    } finally {
      await db.end();
    }
  }

  // ── 4. A resubmit (/start "Sent stepper", V518): the visitor went back and sent again. The same address replaces the live
  //       draft — under a NEW reference, since no replace key came with it (T1 review m1); the first link is then the named
  //       replaced refusal, and only the second builds. Then Change email: a different address replaces it only with the
  //       reference AND the replace key the start answered — the reference stays, and the second address's link builds.
  const resubmitter = newSession();
  const resubmitName = `Funnel Resubmit ${tag}`;
  const resubmitEmail = `delivered+funnel_again_${tag}@resend.dev`;
  type Started = { claim_url?: string; reference?: string; replaceKey?: string };
  const first = (await call(resubmitter, "/api/funnel/start", "POST", { email: resubmitEmail, name: resubmitName, sport: "Badminton", entrants: 8 })) as Started;
  const second = (await call(resubmitter, "/api/funnel/start", "POST", { email: resubmitEmail, name: resubmitName, sport: "Badminton", entrants: 10 })) as Started;
  check("funnel: resubmit: the start answers a SZ- reference", /^SZ-[2-9A-HJ-NP-Z]{6}$/.test(first.reference ?? ""));
  check(
    "funnel: resubmit: a keyless resubmit draws its own reference",
    /^SZ-[2-9A-HJ-NP-Z]{6}$/.test(second.reference ?? "") && second.reference !== first.reference,
  );
  const tokenOf = (s: Started) => new URL(s.claim_url ?? "http://x/").searchParams.get("token");
  const firstClaim = await raw(resubmitter, "/api/funnel/claim", "POST", { token: tokenOf(first) });
  check(
    "funnel: resubmit: the first link is replaced (400 FUNNEL_CLAIM_REPLACED)",
    firstClaim.status === 400 && (firstClaim.json as { code?: string }).code === "FUNNEL_CLAIM_REPLACED",
  );
  // Change email: the reference with its replace key moves the draft to the new address.
  const movedEmail = `delivered+funnel_moved_${tag}@resend.dev`;
  const moved = (await call(resubmitter, "/api/funnel/start", "POST", {
    email: movedEmail,
    name: resubmitName,
    sport: "Badminton",
    entrants: 10,
    previousReference: second.reference,
    replaceKey: second.replaceKey,
  })) as Started;
  check("funnel: change email: the reference carries over", !!second.reference && moved.reference === second.reference);
  const secondClaim = await raw(resubmitter, "/api/funnel/claim", "POST", { token: tokenOf(second) });
  check(
    "funnel: change email: the old address's link is replaced (400 FUNNEL_CLAIM_REPLACED)",
    secondClaim.status === 400 && (secondClaim.json as { code?: string }).code === "FUNNEL_CLAIM_REPLACED",
  );
  const movedClaim = (await call(resubmitter, "/api/funnel/claim", "POST", { token: tokenOf(moved) })) as { redirect: string };
  check("funnel: change email: the new address's link builds", /^\/o\/[^/]+\/c\/funnel-resubmit[^/]*\/d\//.test(movedClaim.redirect));
  if (process.env.DATABASE_URL) {
    const db = smokeDb();
    try {
      const [{ n }] = await db<{ n: number }[]>`select count(*)::int as n from competitions where name = ${resubmitName}`;
      check("funnel: resubmit: one competition, not one per submit", n === 1);
    } finally {
      await db.end();
    }
  }
}
