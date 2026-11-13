// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { readFileSync } from "node:fs";
import { BASE, check, cookieHeader, newSession, signIn, smokeDb, tag } from "../harness.ts";
import {
  QUICK_MATCH_ERRORS,
  QUICK_MATCH_EXPIRY_DAYS,
  QUICK_MATCH_SYSTEM_ORG_ID,
} from "../../../apps/web/src/lib/quick-match-constants.ts";

/**
 * Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5, §7.8, §9 "smoke"; plan 2 Task 11 and plan 3
 * Task 7, ledger decision D9): the guest's whole path over real HTTP, then the real expiry sweep.
 *
 * 1. Create, score, Live (plan 2 T11). A guest with no account posts the setup form to `POST /api/quick-match` (a form post,
 *    303 to `/q/<token>`; the bot check skips on a harness server, ENV_NAME local or ci, server/turnstile.ts). The home reads
 *    "Up next" and "0 of 1 match played" and carries ONE match's Score form. Posting that form lands on `/score/dl_…` (the
 *    device link the pad uses); through that link the pad's own two writes go in (`core.start`, one `badminton.rally` won
 *    by the home side). After the start alone the home reads "Live" with no point on its score; after the rally its score's
 *    current level reads 1 to 0, home first (one rally won by the home side is one point to it). Every expected word is the
 *    English dictionary's, filled with the constants it names.
 * 2. Not played (plan 4 T7, `notPlayedLeg`): a second league of two has its one match marked Not played through the home's own
 *    form; the home then reads "0 of 1 match played · 1 not played" and "No matches were played", a second tap changes
 *    nothing, a stale Put back is refused with QUICK_MATCH_LEAGUE_FINISHED, and the match's row stays `cancelled`.
 * 3. The sweep (plan 3 T7, extended past its amendment by the dispatch): two more matches, one aged past its expiry in SQL and
 *    one saved through the real Save post by a signed-in person and aged the same. `POST /api/cron/quick-match-expiry` with
 *    the cron secret answers a report with a number for every key, `failed` 0 and `expired` >= 1; then, per match: the
 *    expired unsaved one is gone (its row and its competition, each counted 1 before and 0 after), while the saved one and the match
 *    scored in step 1 are kept. The saved match is aged like the expired one so it is a real witness: a sweep that re-armed a
 *    LIVE saver's match would give it an expiry in the past and delete it in the same pass.
 *    Needs the cron secret the server was started with (CI's smoke job sets CRON_SECRET at job level); without it the leg
 *    skips with a passing line, as funnelReminder's does. The sweep has no scope (the route never reads one): it sweeps
 *    EVERY quick match on its target, and the leg back-dates rows through DATABASE_URL, so before either it refuses (a FAIL,
 *    fail-closed) unless BOTH the server and the database are on this machine (`sweepTargetAllowed`): CI's job and a seazn-env
 *    label, never staging or production (a staging server also enforces the bot check, which this post does not answer).
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
/** The hero score's CURRENT level (its last part: "0–0 · 1–0" prints games won, then the open game's points, home first) after one
 *  rally won by the home side: 1 to 0. Rejects a score with no point yet ("0–0 · 0–0", "0 — 0"). */
const HOME_ONE_LEVEL = /\b1\D+0\s*$/;
/** Hours an aged match's last activity is put back: one expiry and three hours, so a re-armed expiry is plainly past. */
const AGED_HOURS = QUICK_MATCH_EXPIRY_DAYS * 24 + 3;

/** A dictionary line with its `{name}` slots filled. A missing key is "", which no page contains. */
function words(key: string, vars: Record<string, string | number> = {}): string {
  const raw = UI[key];
  if (typeof raw !== "string") return "";
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The URL names this machine (an unparseable one, or a socket path with no host, does not). */
function isLocal(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Where the sweep leg may run: a server AND a database on this machine (CI's smoke job, a seazn-env label). Everything else is
 *  refused, production above all, because the route sweeps every quick match on its target (plan 3 Amend T7 [A9]) and the leg
 *  back-dates rows through the database it is handed (review m2, m3). */
export function sweepTargetAllowed(base: string, databaseUrl: string | undefined): boolean {
  return isLocal(base) && isLocal(databaseUrl);
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

/** Server-rendered text back to the dictionary's own characters: React escapes `'` as `&#x27;` (the flash says "can't"), and
 *  `&`, `"`, `<`, `>` as their named entities. `&amp;` last, so an escaped entity is never decoded twice. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** A Location for a label, the home token blanked: the token is the match's credential and never goes in a log. */
function hideToken(at: URL): string {
  return `${at.pathname.replace(/qm_[A-Za-z0-9_-]+/, "<token>")}${at.search}`;
}

/**
 * Step 2, Not played (quick match plan 4 Task 7; spec docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md
 * §3, §6). A league of two has one match. Its home offers that match's "Not played" form (the ⋯ menu's item, a plain post
 * with no body); posting it answers 303 to the bare home, which then reads "0 of 1 match played · 1 not played" with no
 * countdown (a finished league names no clock, T4 review m1) and shows the "No matches were played" card: the only match
 * skipped finishes the league with nothing played and no winner. A second tap changes nothing (plan D3: 303 to the bare home
 * again). Put back, posted as a stale tap would (the finished home no longer draws it), is refused: 303 to the home with
 * `?e=QUICK_MATCH_LEAGUE_FINISHED`, whose flash is the dictionary's line. The match's row in the database ends `cancelled`.
 * Before the skip, the same home reads the unfinished line and draws no such card: the negative half of every check after.
 *
 * Writes only through the guest's own posts, on its own tagged match, as step 1 does: no guard of the sweep's kind is owed.
 */
async function notPlayedLeg(
  db: ReturnType<typeof smokeDb>,
  own: (name: string) => Promise<{ id: string; competition_id: string } | null>,
  variant: string,
): Promise<void> {
  const name = `QM smoke ${tag} not played`;
  const made = await createMatch(name, [`Gil ${tag}`, `Hal ${tag}`], variant);
  const row = await own(name);
  check(
    `quick match not played: a league of two created for the skip (got ${made.status} ${made.where}; row ${row ? "found" : "missing"})`,
    made.status === 303 && made.token !== null && row !== null,
  );
  if (!made.token || !row) return;
  const homePath = `/q/${made.token}`;
  const hasNoPlay = (html: string) => html.includes(`data-testid="qm-no-play"`);

  const before = await page(homePath);
  const skipActions = [...before.html.matchAll(/action="(\/q\/qm_[A-Za-z0-9_-]{43}\/skip\/([0-9a-f-]{36}))"/g)];
  const skipIds = [...new Set(skipActions.map((m) => m[2]))];
  const fixtureId = skipIds.length === 1 ? skipIds[0] : undefined;
  const skipPath = fixtureId ? `${homePath}/skip/${fixtureId}` : "";
  const playedOpen = words("quickMatch.home.played.one", { played: 0, count: 1, days: QUICK_MATCH_EXPIRY_DAYS });
  check(
    `quick match not played: before the skip the home offers Not played for exactly its one match, on its own path, reads "${playedOpen}" and draws no "no matches were played" card (got ${before.status}; ${skipActions.length} skip form(s), ${skipIds.length} distinct match(es), own path ${skipActions.every((m) => m[1] === skipPath)}; played ${JSON.stringify(testidText(before.html, "qm-played"))}; card ${hasNoPlay(before.html) ? "present" : "absent"})`,
    before.status === 200 && fixtureId !== undefined && skipActions.every((m) => m[1] === skipPath) && playedOpen !== "" &&
      testidText(before.html, "qm-played") === playedOpen && !hasNoPlay(before.html),
  );
  if (!fixtureId) return;

  const postAt = async (path: string) => {
    const res = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual" });
    return { status: res.status, at: new URL(res.headers.get("location") ?? "", BASE) };
  };
  const skipped = await postAt(skipPath);
  check(
    `quick match not played: the Not played post answers 303 to the bare home (got ${skipped.status} ${hideToken(skipped.at)})`,
    skipped.status === 303 && skipped.at.pathname === homePath && skipped.at.search === "",
  );

  const after = await page(homePath);
  // "N of M played · K not played", M the full total, K through its own plural; no countdown on a finished league.
  const playedSkipped = words("quickMatch.home.playedSkippedSaved.one", {
    played: 0,
    count: 1,
    skipped: words("quickMatch.home.notPlayedPart.one", { count: 1 }),
  });
  const noPlayTitle = words("quickMatch.home.noPlay");
  const titleAfter = testidText(after.html, "qm-no-play-title", "h2");
  check(
    `quick match not played: after the skip the home reads "${playedSkipped}" and the league is finished with nothing played, "${noPlayTitle}", no winner and no Put back (got ${after.status}; played ${JSON.stringify(testidText(after.html, "qm-played"))}; card ${hasNoPlay(after.html) ? "present" : "absent"}, title ${JSON.stringify(titleAfter)}; winner ${after.html.includes(`data-testid="qm-winner"`) ? "shown" : "none"}; put-back forms ${(after.html.match(/\/put-back\//g) ?? []).length})`,
    after.status === 200 && playedSkipped !== "" && noPlayTitle !== "" && testidText(after.html, "qm-played") === playedSkipped &&
      hasNoPlay(after.html) && titleAfter === noPlayTitle && !after.html.includes(`data-testid="qm-winner"`) &&
      !after.html.includes("/put-back/"),
  );

  const again = await postAt(skipPath);
  check(
    `quick match not played: a second Not played tap changes nothing and lands on the bare home again (got ${again.status} ${hideToken(again.at)})`,
    again.status === 303 && again.at.pathname === homePath && again.at.search === "",
  );

  // Put back, as a stale tap (a home opened before the skip) would post it: the league has finished, so it is refused.
  const putBack = await postAt(`${homePath}/put-back/${fixtureId}`);
  const refusedAt = `${homePath}?e=${QUICK_MATCH_ERRORS.LEAGUE_FINISHED}`;
  const flashPage = putBack.at.pathname === homePath ? await page(`${putBack.at.pathname}${putBack.at.search}`) : null;
  const flashText = flashPage ? testidText(flashPage.html, "qm-flash") : null;
  const flashCopy = words("quickMatch.flash.leagueFinished");
  check(
    `quick match not played: Put back after the league finished answers 303 to the home with ?e=${QUICK_MATCH_ERRORS.LEAGUE_FINISHED}, whose flash reads "${flashCopy}" (got ${putBack.status} ${hideToken(putBack.at)}; flash ${JSON.stringify(flashText === null ? null : unescapeHtml(flashText))})`,
    putBack.status === 303 && `${putBack.at.pathname}${putBack.at.search}` === refusedAt && flashCopy !== "" &&
      flashText !== null && unescapeHtml(flashText) === flashCopy,
  );

  const [fx] = await db<{ status: string }[]>`
    select f.status from fixtures f join divisions d on d.id = f.division_id
     where f.id = ${fixtureId} and d.competition_id = ${row.competition_id}`;
  check(
    `quick match not played: the match's row in the database is cancelled, the refused Put back undid nothing (got ${JSON.stringify(fx?.status ?? null)})`,
    fx?.status === "cancelled",
  );
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
    // The home between the start and the rally: already Live (the start alone puts the match in play), with a score that does
    // not yet read the home side's point. The negative half of the rally check below (review I1).
    const started = await page(homePath);
    const scoreStarted = testidText(started.html, "qm-hero-score", "span");
    check(
      `quick match: after the start alone the home's hero reads "${liveKicker}" with no point scored yet (got ${started.status}, kicker ${JSON.stringify(testidText(started.html, "qm-hero-kicker"))}, score ${JSON.stringify(scoreStarted)})`,
      started.status === 200 && testidText(started.html, "qm-hero-kicker") === liveKicker && scoreStarted !== null &&
        scoreStarted.trim() !== "" && !HOME_ONE_LEVEL.test(scoreStarted),
    );
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
      `quick match: after the rally the home's hero reads "${liveKicker}" and its score's current level is the home side's point, 1 to 0, and the line still "${playedNone}" (got ${after.status}, kicker ${JSON.stringify(kickerAfter)}, score ${JSON.stringify(heroScore)}, played ${JSON.stringify(testidText(after.html, "qm-played"))})`,
      after.status === 200 && kickerAfter === liveKicker && heroScore !== null && HOME_ONE_LEVEL.test(heroScore) &&
        testidText(after.html, "qm-played") === playedNone,
    );

    // ── 2. Not played: the only match skipped finishes the league with nothing played; Put back is then refused ──────────
    // Its own function, so a check that stops it early never takes the sweep below with it.
    await notPlayedLeg(db, own, variant);

    // ── 3. The sweep: an expired unsaved match goes, a saved one and the live one stay ────────────────────────────────────
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      check("quick match sweep: skipped (no CRON_SECRET in the smoke env, the cron route cannot be called); quick-match-sweep.test.ts covers it", true);
      return;
    }
    if (!sweepTargetAllowed(BASE, process.env.DATABASE_URL)) {
      check(
        `quick match sweep: REFUSED, the server (${BASE}) or the database (${isLocal(process.env.DATABASE_URL) ? "local" : "not local"}) is not on this machine; the leg back-dates rows and the sweep deletes every expired quick match on its target`,
        false,
      );
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
    check(
      `quick match sweep: the expired unsaved match is deleted (${gone.qm} quick_matches row and ${gone.comp} competition left, of 1 and 1)`,
      gone.qm === 0 && gone.comp === 0,
    );

    const [keptSaved] = await db<{ saved_by_user_id: string | null; expires_at: Date | null }[]>`
      select saved_by_user_id, expires_at from quick_matches where id = ${saved.id}`;
    const savedLeft = await counts({ quickMatchId: saved.id, competitionId: saved.competition_id });
    // Its home, as its saver sees it: "Saved", and the played line with no countdown (a saved match has no expiry).
    const savedHome = await page(`/q/${savedMade.token}`, cookieHeader(saver));
    const playedSaved = words("quickMatch.home.playedSaved.one", { played: 0, count: 1 });
    const savedWord = testidText(savedHome.html, "qm-saved");
    const savedCopy = words("quickMatch.home.saved");
    check(
      `quick match sweep: the saved match, idle past an expiry, is kept and still saved (${savedLeft.qm} row and ${savedLeft.comp} competition of 1 and 1; saver ${keptSaved?.saved_by_user_id === saverRow?.id ? "kept" : "lost"}, expiry ${keptSaved?.expires_at === null ? "none" : "re-armed"}; its home ${savedHome.status} reads ${JSON.stringify(savedWord)} and ${JSON.stringify(testidText(savedHome.html, "qm-played"))})`,
      savedLeft.qm === 1 && savedLeft.comp === 1 && !!saverRow && keptSaved?.saved_by_user_id === saverRow.id &&
        keptSaved.expires_at === null && savedHome.status === 200 && playedSaved !== "" && savedCopy !== "" &&
        savedWord === savedCopy && testidText(savedHome.html, "qm-played") === playedSaved,
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
