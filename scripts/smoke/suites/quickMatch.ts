// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { readFileSync } from "node:fs";
import { BASE, check, cookieHeader, newSession, signIn, smokeDb, tag } from "../harness.ts";
import { QUICK_MATCH_EXPIRY_DAYS, QUICK_MATCH_SYSTEM_ORG_ID } from "../../../apps/web/src/lib/quick-match-constants.ts";

/**
 * Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5, §7.8, §9 "smoke"; plan 2 Task 11 and plan 3
 * Task 7, ledger decision D9): the guest's whole path over real HTTP, then the real expiry sweep.
 *
 * 1. Create, score, Live (plan 2 T11). A guest with no account posts the setup form to `POST /api/quick-match` (a form post,
 *    303 to `/q/<token>`; the bot check skips on a harness server, ENV_NAME local or ci, server/turnstile.ts). The home reads
 *    "Up next" and "0 of 1 match played" and carries ONE match's Score form. Posting that form lands on `/score/dl_…` (the
 *    device link the pad uses); through that link the pad's own two writes go in (`core.start`, one `badminton.rally`), and
 *    the home then reads "Live". Every expected word is the English dictionary's, filled with the constants it names.
 * 2. The sweep (plan 3 T7, extended past its amendment by the dispatch): two more matches, one aged past its expiry in SQL and
 *    one saved through the real Save post by a signed-in person and aged the same. `POST /api/cron/quick-match-expiry` with
 *    the cron secret answers a report with a number for every key, `failed` 0 and `expired` >= 1; then, per match: the
 *    expired unsaved one is gone (row, competition, and its home reads the dead screen), while the saved one and the match
 *    scored in step 1 are kept. The saved match is aged like the expired one so it is a real witness: a sweep that re-armed a
 *    LIVE saver's match would give it an expiry in the past and delete it in the same pass.
 *    Needs the cron secret the server was started with (CI's smoke job sets CRON_SECRET at job level); without it the leg
 *    skips with a passing line, as funnelReminder's does. The sweep has no scope (the route never reads one): it sweeps
 *    EVERY quick match on its target, so the leg refuses any target that is not this machine or staging (`sweepTargetAllowed`).
 *
 * One sport, badminton (plan 3 Amend T7 [E8]): smoke proves the routes are alive end to end; the cascade closure over two
 * sports is quick-match-sweep.test.ts's orphan test. No email is typed (Amend T7 [A8]), so no mail is queued.
 *
 * Teardown: the system org belongs to no run, so `cleanup(tag)` never reaches these rows. `finally` deletes this suite's own:
 * the outbox rows by ref, then each competition, which cascades to its quick_matches row and everything under it; and it
 * asserts nothing of its own was left. The saver's account goes with the run's users (`cleanup`'s list, harness.ts).
 * SMOKE_ONLY=quickMatch runs it alone (SELECTABLE_SUITES).
 */

const UI = JSON.parse(
  readFileSync(new URL("../../../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8"),
) as Record<string, string>;
/** What a guest may create, as the probe recorded it (`quick-match-sports.ts` reads the same file). */
const OFFER = JSON.parse(
  readFileSync(new URL("../../../apps/web/src/lib/quick-match-offer.generated.json", import.meta.url), "utf8"),
) as { offered: { sport_key: string; variant_key: string }[] };

const SPORT = "badminton";
const TOKEN = /^\/q\/(qm_[A-Za-z0-9_-]{43})$/;
const DL = /^\/score\/(dl_[A-Za-z0-9_-]+)$/;
const REPORT_KEYS = ["checked", "rearmed", "reminded", "expired", "orphans", "failed", "deferred"] as const;
/** Hours an aged match's last activity is put back: one expiry and three hours, so a re-armed expiry is plainly past. */
const AGED_HOURS = QUICK_MATCH_EXPIRY_DAYS * 24 + 3;

/** A dictionary line with its `{name}` slots filled. A missing key is "", which no page contains. */
function words(key: string, vars: Record<string, string | number> = {}): string {
  const raw = UI[key];
  if (typeof raw !== "string") return "";
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Where the sweep leg may run: this machine, or staging. Anything else (production above all) is refused, because the route
 *  sweeps every quick match on its target (plan 3 Amend T7 [A9]). */
export function sweepTargetAllowed(base: string): boolean {
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "stg.seazn.club";
}

type Made = { status: number; token: string | null; where: string };

/** The setup form's post, as the page sends it (a form, not JSON), with the site's own Origin. `where` is the Location with
 *  the token blanked, for a label: the home token is the match's credential and never goes in a log. */
async function createMatch(name: string, sides: readonly [string, string], variant: string): Promise<Made> {
  const body = new URLSearchParams({ name, sport_key: SPORT, variant_key: variant, kind: "individual", format: "league", plays: "1", locale: "en" });
  for (const side of sides) body.append("sides", side);
  const res = await fetch(`${BASE}/api/quick-match`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(BASE).origin },
    body,
  });
  const at = new URL(res.headers.get("location") ?? "", BASE);
  const token = at.search === "" ? (TOKEN.exec(at.pathname)?.[1] ?? null) : null;
  return { status: res.status, token, where: `${at.pathname.replace(/qm_[A-Za-z0-9_-]+/, "<token>")}${at.search}` };
}

async function page(path: string, cookie?: string): Promise<{ status: number; html: string }> {
  const res = await fetch(BASE + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return { status: res.status, html: await res.text() };
}

/** The text of the `<tag>` carrying `data-testid="<id>"`, its inner tags dropped (the hero kicker wraps its words in a span
 *  beside the live dot). Null when the page has no such element. */
function testidText(html: string, id: string, tag = "p"): string | null {
  const at = html.indexOf(`data-testid="${id}"`);
  if (at === -1) return null;
  const open = html.indexOf(">", at);
  const close = html.indexOf(`</${tag}>`, open);
  return open === -1 || close === -1 ? null : html.slice(open + 1, close).replace(/<[^>]*>/g, "");
}

export async function quickMatchSuite(): Promise<void> {
  const variant = OFFER.offered.find((o) => o.sport_key === SPORT)?.variant_key ?? "";
  check(`quick match: the probe's offer lists a ${SPORT} variant to create (got ${JSON.stringify(variant)})`, variant !== "");
  if (variant === "") return;

  const db = smokeDb();
  const made: { name: string; quickMatchId: string; competitionId: string }[] = [];
  /** This suite's match by its (tagged, unique) name: the row the create wrote, kept for teardown the moment it exists. */
  const own = async (name: string) => {
    const [row] = await db<{ id: string; competition_id: string }[]>`
      select id, competition_id from quick_matches where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID} and name = ${name}`;
    if (row) made.push({ name, quickMatchId: row.id, competitionId: row.competition_id });
    return row ?? null;
  };
  const counts = async (m: { quickMatchId: string; competitionId: string }) => {
    const [n] = await db<{ qm: number; comp: number }[]>`
      select (select count(*)::int from quick_matches where id = ${m.quickMatchId}) as qm,
             (select count(*)::int from competitions where id = ${m.competitionId}) as comp`;
    return { qm: n?.qm ?? -1, comp: n?.comp ?? -1 };
  };

  try {
    // ── 1. Create → home → Score → rally → Live ─────────────────────────────────────────────────────────────────────────
    const liveName = `QM smoke ${tag} live`;
    const created = await createMatch(liveName, [`Ana ${tag}`, `Ben ${tag}`], variant);
    check(
      `quick match: the setup form's post answers 303 to the match's home, /q/<token> (got ${created.status} ${created.where})`,
      created.status === 303 && created.token !== null,
    );
    const live = await own(liveName);
    check(`quick match: the create wrote one quick_matches row in the system org (found ${live ? 1 : 0})`, live !== null);
    if (!created.token || !live) return;
    const homePath = `/q/${created.token}`;

    const before = await page(homePath);
    const playedNone = words("quickMatch.home.played.one", { played: 0, count: 1, days: QUICK_MATCH_EXPIRY_DAYS });
    const upNext = words("quickMatch.home.upNext", { n: 1, total: 1 });
    const liveKicker = words("quickMatch.home.liveMatch", { n: 1, total: 1 });
    const kickerBefore = testidText(before.html, "qm-hero-kicker");
    check(
      `quick match: the home renders the match by name, its hero "${upNext}" (not yet "${liveKicker}") and "${playedNone}" (got ${before.status}, kicker ${JSON.stringify(kickerBefore)}, played ${JSON.stringify(testidText(before.html, "qm-played"))})`,
      before.status === 200 && before.html.includes(liveName) && playedNone !== "" && upNext !== "" && liveKicker !== "" &&
        kickerBefore === upNext && testidText(before.html, "qm-played") === playedNone,
    );
    const actions = [...before.html.matchAll(/action="\/q\/qm_[A-Za-z0-9_-]{43}\/score\/([0-9a-f-]{36})"/g)].map((m) => m[1]);
    const fixtureIds = [...new Set(actions)];
    check(
      `quick match: the home carries Score forms for exactly one match, the league of two's only one (${actions.length} form(s), ${fixtureIds.length} distinct match(es))`,
      actions.length >= 1 && fixtureIds.length === 1,
    );
    const fixtureId = fixtureIds[0];
    if (fixtureIds.length !== 1 || !fixtureId) return;

    const tap = await fetch(`${BASE}${homePath}/score/${fixtureId}`, { method: "POST", redirect: "manual" });
    const padAt = new URL(tap.headers.get("location") ?? "", BASE);
    const secret = padAt.search === "" ? (DL.exec(padAt.pathname)?.[1] ?? null) : null;
    check(
      `quick match: Score answers 303 into the scoring pad, /score/dl_… (got ${tap.status} ${padAt.pathname.replace(/dl_[A-Za-z0-9_-]+/, "dl_<secret>")}${padAt.search})`,
      tap.status === 303 && secret !== null,
    );
    if (!secret) return;
    const asPad = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

    const bootRes = await fetch(`${BASE}/api/v1/device-link`, { headers: asPad });
    const boot = ((await bootRes.json().catch(() => ({}))) as { data?: { fixture_id?: string; sides?: { home?: { entrant_id?: string } } } }).data;
    const homeEntrant = boot?.sides?.home?.entrant_id ?? "";
    check(
      `quick match: the pad's link opens the match the home's form named, with a known home side (got ${bootRes.status}, same match ${boot?.fixture_id === fixtureId}, home side ${homeEntrant ? "known" : "missing"})`,
      bootRes.status === 200 && boot?.fixture_id === fixtureId && homeEntrant !== "",
    );
    const post = async (expected_seq: number, type: string, payload: unknown) => {
      const res = await fetch(`${BASE}/api/v1/fixtures/${fixtureId}/events`, {
        method: "POST",
        headers: asPad,
        body: JSON.stringify({ expected_seq, type, payload }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      return `${res.status}${json.error?.code ? ` ${json.error.code}` : ""}`;
    };
    const start = await post(0, "core.start", {});
    const rally = await post(1, `${SPORT}.rally`, { wonBy: homeEntrant });
    const ledgerRes = await fetch(`${BASE}/api/v1/fixtures/${fixtureId}/events?since_seq=0`, { headers: asPad });
    const ledger = ((await ledgerRes.json().catch(() => ({}))) as { data?: { type: string }[] }).data ?? [];
    check(
      `quick match: through the link the pad starts the match and scores one rally, and the ledger holds those two (start ${start}, rally ${rally}; ledger ${ledger.length} row(s): ${ledger.map((e) => e.type).join(", ")})`,
      start === "201" && rally === "201" && ledger.length === 2 && ledger[0]?.type === "core.start" && ledger[1]?.type === `${SPORT}.rally`,
    );

    const after = await page(homePath);
    const kickerAfter = testidText(after.html, "qm-hero-kicker");
    const heroScore = testidText(after.html, "qm-hero-score", "span");
    check(
      `quick match: the home's hero now reads "${liveKicker}" with a score, and the line still "${playedNone}" (got ${after.status}, kicker ${JSON.stringify(kickerAfter)}, score ${JSON.stringify(heroScore)}, played ${JSON.stringify(testidText(after.html, "qm-played"))})`,
      after.status === 200 && kickerAfter === liveKicker && heroScore !== null && heroScore.trim() !== "" &&
        testidText(after.html, "qm-played") === playedNone,
    );

    // ── 2. The sweep: an expired unsaved match goes, a saved one and the live one stay ────────────────────────────────────
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      check("quick match sweep: skipped (no CRON_SECRET in the smoke env, the cron route cannot be called); quick-match-sweep.test.ts covers it", true);
      return;
    }
    if (!sweepTargetAllowed(BASE)) {
      check(`quick match sweep: REFUSED, the target ${new URL(BASE).hostname} is not this machine or staging, and the sweep deletes every expired quick match there`, false);
      return;
    }

    const expiringName = `QM smoke ${tag} expiring`;
    const savedName = `QM smoke ${tag} saved`;
    const expiringMade = await createMatch(expiringName, [`Cy ${tag}`, `Di ${tag}`], variant);
    const savedMade = await createMatch(savedName, [`Ed ${tag}`, `Fay ${tag}`], variant);
    const expiring = await own(expiringName);
    const saved = await own(savedName);
    check(
      `quick match sweep: two more matches created for the sweep (got ${expiringMade.status} ${expiringMade.where}, ${savedMade.status} ${savedMade.where}; rows found ${[expiring, saved].filter(Boolean).length} of 2)`,
      expiringMade.token !== null && savedMade.token !== null && expiring !== null && saved !== null,
    );
    if (!expiringMade.token || !savedMade.token || !expiring || !saved) return;

    // The Save post, as the home's button sends it: signed in, from the site's own page.
    const saverEmail = `delivered+qm_saver_${tag}@resend.dev`;
    const saver = newSession();
    await signIn(saver, saverEmail);
    const [saverRow] = await db<{ id: string }[]>`select id from users where email = ${saverEmail}`;
    const savePost = await fetch(`${BASE}/q/${savedMade.token}/save/confirm`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookieHeader(saver), origin: new URL(BASE).origin },
    });
    const saveAt = new URL(savePost.headers.get("location") ?? "", BASE);
    const [savedRow] = await db<{ saved_by_user_id: string | null; expires_at: Date | null }[]>`
      select saved_by_user_id, expires_at from quick_matches where id = ${saved.id}`;
    check(
      `quick match sweep: Save, signed in, answers 303 to the bare home and the row names its saver with no expiry (got ${savePost.status} ${saveAt.pathname.replace(/qm_[A-Za-z0-9_-]+/, "<token>")}${saveAt.search}; saver ${savedRow?.saved_by_user_id === saverRow?.id && !!saverRow ? "set" : "not set"}, expiry ${savedRow?.expires_at === null ? "none" : "still set"})`,
      savePost.status === 303 && saveAt.search === "" && !!saverRow && savedRow?.saved_by_user_id === saverRow.id && savedRow.expires_at === null,
    );

    // Age both: last activity one expiry and three hours ago; the unsaved one's expiry an hour past (C1: last activity + 7 days).
    const agedExpiring = await db`
      update quick_matches
         set last_activity_at = now() - make_interval(hours => ${AGED_HOURS}::int),
             expires_at = now() - interval '1 hour'
       where id = ${expiring.id} and saved_by_user_id is null`;
    const agedSaved = await db`
      update quick_matches set last_activity_at = now() - make_interval(hours => ${AGED_HOURS}::int)
       where id = ${saved.id} and saved_by_user_id is not null and expires_at is null`;
    const expiringBefore = await counts({ quickMatchId: expiring.id, competitionId: expiring.competition_id });
    check(
      `quick match sweep: both aged ${AGED_HOURS} h, the unsaved one past its expiry (updated ${agedExpiring.count} unsaved + ${agedSaved.count} saved; the unsaved one has ${expiringBefore.qm} row and ${expiringBefore.comp} competition before the sweep)`,
      agedExpiring.count === 1 && agedSaved.count === 1 && expiringBefore.qm === 1 && expiringBefore.comp === 1,
    );

    const sweepRes = await fetch(`${BASE}/api/cron/quick-match-expiry`, { method: "POST", headers: { "x-cron-secret": cronSecret } });
    const sweepBody = (await sweepRes.json().catch(() => ({}))) as { ok?: boolean; data?: Record<string, unknown> };
    const report = sweepBody.data ?? {};
    const numeric = REPORT_KEYS.filter((k) => typeof report[k] === "number");
    check(
      `quick match sweep: the cron route answers 200 with a number for every report key, failed 0 and expired >= 1 (got ${sweepRes.status}; ${numeric.length} of ${REPORT_KEYS.length} keys numeric; ${JSON.stringify(report)})`,
      sweepRes.status === 200 && sweepBody.ok === true && numeric.length === REPORT_KEYS.length &&
        report.failed === 0 && typeof report.expired === "number" && report.expired >= 1,
    );

    const gone = await counts({ quickMatchId: expiring.id, competitionId: expiring.competition_id });
    const dead = await page(`/q/${expiringMade.token}`);
    check(
      `quick match sweep: the expired unsaved match is deleted (${gone.qm} quick_matches row and ${gone.comp} competition left, of 1 and 1), and its link reads the dead screen (got ${dead.status}, dead screen ${dead.html.includes('data-testid="qm-dead-link"') ? "shown" : "absent"})`,
      gone.qm === 0 && gone.comp === 0 && dead.status === 200 && dead.html.includes('data-testid="qm-dead-link"'),
    );

    const [keptSaved] = await db<{ saved_by_user_id: string | null; expires_at: Date | null }[]>`
      select saved_by_user_id, expires_at from quick_matches where id = ${saved.id}`;
    const savedLeft = await counts({ quickMatchId: saved.id, competitionId: saved.competition_id });
    // Its home, as its saver sees it: "Saved", and the played line with no countdown (a saved match has no expiry).
    const savedHome = await page(`/q/${savedMade.token}`, cookieHeader(saver));
    const playedSaved = words("quickMatch.home.playedSaved.one", { played: 0, count: 1 });
    const savedWord = testidText(savedHome.html, "qm-saved");
    check(
      `quick match sweep: the saved match, idle past an expiry, is kept and still saved (${savedLeft.qm} row and ${savedLeft.comp} competition of 1 and 1; saver ${keptSaved?.saved_by_user_id === saverRow?.id ? "kept" : "lost"}, expiry ${keptSaved?.expires_at === null ? "none" : "re-armed"}; its home ${savedHome.status} reads ${JSON.stringify(savedWord)} and ${JSON.stringify(testidText(savedHome.html, "qm-played"))})`,
      savedLeft.qm === 1 && savedLeft.comp === 1 && !!saverRow && keptSaved?.saved_by_user_id === saverRow.id &&
        keptSaved.expires_at === null && savedHome.status === 200 && playedSaved !== "" &&
        savedWord === words("quickMatch.home.saved") && testidText(savedHome.html, "qm-played") === playedSaved,
    );

    const liveLeft = await counts({ quickMatchId: live.id, competitionId: live.competition_id });
    const [liveRow] = await db<{ ahead: boolean }[]>`
      select expires_at > now() as ahead from quick_matches where id = ${live.id}`;
    check(
      `quick match sweep: the match scored above is kept, its expiry still ahead (${liveLeft.qm} row and ${liveLeft.comp} competition of 1 and 1; expiry ahead ${liveRow?.ahead === true})`,
      liveLeft.qm === 1 && liveLeft.comp === 1 && liveRow?.ahead === true,
    );
  } finally {
    if (made.length > 0) {
      const qmIds = made.map((m) => m.quickMatchId);
      const compIds = made.map((m) => m.competitionId);
      await db`delete from email_outbox where ref_type = 'quick_match' and ref_id = any(${qmIds}::text[])`;
      await db`delete from competitions where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID} and id = any(${compIds}::uuid[])`;
      const [left] = await db<{ qm: number; comp: number }[]>`
        select (select count(*)::int from quick_matches where id = any(${qmIds}::uuid[])) as qm,
               (select count(*)::int from competitions where id = any(${compIds}::uuid[])) as comp`;
      check(
        `quick match: teardown removed every match this suite made (${made.length} made; ${left?.qm ?? -1} rows and ${left?.comp ?? -1} competitions left)`,
        left?.qm === 0 && left.comp === 0,
      );
    }
    await db.end();
  }
}
