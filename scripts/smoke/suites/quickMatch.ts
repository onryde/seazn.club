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
 * 3. League + Knockout (plan 5 T10, `leagueKnockoutLeg`): League → Final of three sides draws its final waiting on the league's
 *    top two; every league match marked Not played leaves the three level across the cut, so the home asks; Pick fills the
 *    final from the route's own advance (one confirmed seed proposal), the home names who went through, and a second answer
 *    is refused with QUICK_MATCH_ALREADY_DECIDED, changing nothing.
 * 3b. Cricket, League only (decision log 2026-11-14, `cricketLeg`): a League → Final of cricket sides is refused back to the
 *    setup page with QUICK_MATCH_FORMAT_NOT_OFFERED; a League of two is scored through the link as the quick match pad sends
 *    it (toss, Start, an over, Close innings, a chasing over) and decided for the side batting second, as the toss seated it.
 * 4. The sweep (plan 3 T7, extended past its amendment by the dispatch): two more matches, one aged past its expiry in SQL and
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
 * Badminton for steps 1 to 4 (plan 3 Amend T7 [E8]): smoke proves the routes are alive end to end; the cascade closure over two
 * sports is quick-match-sweep.test.ts's orphan test. Step 3b is cricket's own, the one League-only sport with its own Start. No email is typed (Amend T7 [A8]), so no mail is queued.
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
) as { offered: { sport_key: string; variant_key: string; knockoutAllowed?: boolean }[] };

const SPORT = "badminton";
/** The League-only sport the cricket leg creates (spec C11 as amended 2026-11-14), and the variant it prefers when offered. */
const CRICKET = "cricket";
const CRICKET_VARIANT = "t20";
/** Cricket's sides are teams (its entrant model, `entrantShapeOf`: the create answers KIND_NOT_OFFERED to any other kind). */
const CRICKET_KIND = "team";
const CRICKET_FINAL = { shape: "final", sport: CRICKET, kind: CRICKET_KIND } as const;
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
/** The Format list's one radio (plan 5 D1, lib/quick-match-shape.ts `SETUP_SHAPES`): League | League → Final | League →
 *  Semi-finals → Final. Spelled here because that module's `@/` imports do not load under node's type stripping. */
type Shape = "league" | "final" | "semis";

/** The setup form's post, as the page sends it (a form, not JSON), with the site's own Origin: its format is the `shape` radio,
 *  which the create route maps to the create's format and qualifiers (plan 5 D1). `where` is the Location with the token
 *  blanked, for a label: the home token is the match's credential and never goes in a log. */
async function createMatch(
  name: string,
  sides: readonly string[],
  variant: string,
  { shape = "league", sport = SPORT, kind = "individual" }: { shape?: Shape; sport?: string; kind?: "individual" | "team" } = {},
): Promise<Made> {
  const body = new URLSearchParams({ name, sport_key: sport, variant_key: variant, kind, shape, plays: "1", locale: "en" });
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

/** A home control's post, as its `<form method="post">` sends it: no body, or the form's fields (the Pick panel's). */
async function postAt(path: string, form?: URLSearchParams): Promise<{ status: number; at: URL }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    ...(form ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: form } : {}),
  });
  return { status: res.status, at: new URL(res.headers.get("location") ?? "", BASE) };
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

/** League → Final of three sides, each pair once: 3 league matches and the final (plan 5 Global Constraints, "3 sides Once +
 *  final = 3 + 1 = 4"). */
const LK_SIDES = 3;
const LK_LEAGUE_MATCHES = (LK_SIDES * (LK_SIDES - 1)) / 2;
const LK_PLACES: number = 2;

/** The same members, in any order. */
function sameSet(a: readonly (string | null)[], b: readonly string[]): boolean {
  return a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** The knockout's seat lines, in card order (each card home then away): a seat's name, or what it waits on in words. Null when
 *  the page draws no knockout section. */
function knockoutSeats(html: string): string[] | null {
  const at = html.indexOf(`data-testid="qm-knockout"`);
  if (at === -1) return null;
  const end = html.indexOf("</section>", at);
  const part = html.slice(at, end === -1 ? undefined : end);
  return [...part.matchAll(/data-testid="qm-draw-name"[^>]*>([^<]*)<\/span>/g)].map((m) => unescapeHtml(m[1] ?? ""));
}

/**
 * Step 3, League + Knockout (quick match plan 5 Task 10; spec docs/superpowers/specs/2026-11-12-quick-match-league-knockout-
 * design.md §5, §6, §11). A League → Final of three sides (the setup's `shape` radio, `final`) is created as two stages, a
 * league then a knockout. Before any result its home draws the knockout (`qm-knockout`), the final waiting on "1st in the
 * league" and "2nd in the league" (D7), asks nothing (no `qm-cut`), and offers Not played on the three league matches only (a
 * bracket needs a winner). All three are marked Not played through those posts; the last finishes the league with the three
 * level on nothing played, a class that straddles the cut (three sides, two places, D4 case 1). BEFORE the home is loaded
 * again (its load retries the fill, so it would mask what the route's own advance did: T5 review carry) the database shows
 * nothing decided and the knockout unfilled. The home then asks "Tie for 1st: 3 sides, 2 places" with Pick among the three as
 * typed, and both of the final's seats read "— to decide".
 *
 * Nothing was played, so the engine drew no lot (the three stand in typing order: `CutTie.byLot` false, controller ruling
 * T4): there is no coin, the home offers no Toss, and a Toss post (a crafted or stale one) is refused with
 * QUICK_MATCH_TIE_NOT_OPEN and writes nothing. Pick then sends the two sides the typing order would NOT seat (the second and
 * third typed), so a fill from typing order cannot pass for it; 303 to the bare home, and BEFORE the next home load the
 * database holds that pick, ONE confirmed seed proposal for the knockout stage, and the final seated with exactly those two.
 * The home then names both in `qm-cut-result` ("Picked to go through: …") and on the final's seats, with no question left. A
 * second answer (Toss, as another phone's would be) is refused with QUICK_MATCH_ALREADY_DECIDED, whose flash is the
 * dictionary's line, and changes nothing: still one confirmed proposal, the same pick, the same seats.
 *
 * Writes only through the guest's own posts, on its own tagged match, as step 2 does: no guard of the sweep's kind is owed.
 */
async function leagueKnockoutLeg(
  db: ReturnType<typeof smokeDb>,
  own: (name: string) => Promise<{ id: string; competition_id: string } | null>,
  variant: string,
): Promise<void> {
  const name = `QM smoke ${tag} knockout`;
  const typed = [`Ivy ${tag}`, `Jo ${tag}`, `Kit ${tag}`];
  const made = await createMatch(name, typed, variant, { shape: "final" });
  const row = await own(name);
  const [qm] = row ? await db<{ format: string }[]>`select format from quick_matches where id = ${row.id}` : [];
  const stages = row
    ? await db<{ id: string; kind: string }[]>`
        select s.id, s.kind from stages s join divisions d on d.id = s.division_id
         where d.competition_id = ${row.competition_id} order by s.seq`
    : [];
  const [leagueStage, koStage] = stages;
  check(
    `quick match knockout: League → Final of ${LK_SIDES} sides created as a league stage then a knockout one (got ${made.status} ${made.where}; row ${row ? "found" : "missing"}, format ${JSON.stringify(qm?.format ?? null)}; stages ${JSON.stringify(stages.map((s) => s.kind))})`,
    made.status === 303 && made.token !== null && row !== null && qm?.format === "league_knockout" && stages.length === 2 &&
      leagueStage?.kind === "league" && koStage?.kind === "knockout",
  );
  if (!made.token || !row || !leagueStage || !koStage || leagueStage.kind !== "league" || koStage.kind !== "knockout") return;
  const homePath = `/q/${made.token}`;
  const asks = (html: string) => html.includes(`data-testid="qm-cut"`);

  /** What the database holds for the knockout: the stored decision, the stage's confirmed seed proposals, its lines' seats. */
  const stored = async () => {
    const [d] = await db<{ cut: { how?: unknown; through?: unknown } | null }[]>`
      select cut_decision as cut from quick_matches where id = ${row.id}`;
    const [p] = await db<{ n: number }[]>`
      select count(*)::int as n from stage_seed_proposals where stage_id = ${koStage.id} and status = 'confirmed'`;
    const lines = await db<{ home: string | null; away: string | null }[]>`
      select home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${koStage.id}`;
    const raw: unknown = d?.cut?.through;
    const through = Array.isArray(raw) ? raw.map(String) : null;
    // Every knockout seat, home then away per line: the final's two once it has filled.
    const seats = lines.flatMap((l) => [l.home, l.away]);
    return { how: d?.cut?.how ?? null, through, confirmed: p?.n ?? -1, lines, seats };
  };
  const said = (s: Awaited<ReturnType<typeof stored>>) =>
    `decision ${JSON.stringify(s.how === null ? null : { how: s.how, through: s.through?.length ?? null })}, ${s.confirmed} confirmed proposal(s), ${s.lines.length} knockout line(s) seated ${s.lines.map((l) => [l.home, l.away].filter(Boolean).length).join("/") || "-"}`;

  // ── Before any result: the final waits on the league's top two, nothing is asked, Not played only on the league ────────
  const rank1 = words("quickMatch.home.leagueRank.1");
  const rank2 = words("quickMatch.home.leagueRank.2");
  const before = await page(homePath);
  const seatsBefore = knockoutSeats(before.html);
  const skipIds = [...new Set([...before.html.matchAll(/action="\/q\/qm_[A-Za-z0-9_-]{43}\/skip\/([0-9a-f-]{36})"/g)].map((m) => m[1] ?? ""))];
  const leagueLines = (await db<{ id: string }[]>`select id from fixtures where stage_id = ${leagueStage.id}`).map((f) => f.id);
  check(
    `quick match knockout: before a result the home draws the knockout, its final waiting on "${rank1}" then "${rank2}", asks nothing, and offers Not played on exactly the ${LK_LEAGUE_MATCHES} league matches (got ${before.status}; seats ${JSON.stringify(seatsBefore)}; cut ${asks(before.html) ? "asked" : "none"}; ${skipIds.length} skippable, the league stage's ${leagueLines.length} line(s) ${sameSet(skipIds, leagueLines) ? "exactly" : "NOT"})`,
    before.status === 200 && rank1 !== "" && rank2 !== "" && JSON.stringify(seatsBefore) === JSON.stringify([rank1, rank2]) &&
      !asks(before.html) && skipIds.length === LK_LEAGUE_MATCHES && sameSet(skipIds, leagueLines),
  );
  if (skipIds.length !== LK_LEAGUE_MATCHES) return;

  // ── Every league match Not played: the league finishes level across the cut ────────────────────────────────────────────
  const skips: { status: number; at: URL }[] = [];
  for (const id of skipIds) skips.push(await postAt(`${homePath}/skip/${id}`));
  const afterSkips = await stored(); // before any home load: what the skip route's own advance left
  check(
    `quick match knockout: each of the ${LK_LEAGUE_MATCHES} Not played posts answers 303 to the bare home, and the league finished level leaves nothing decided and the knockout unfilled (got ${skips.map((s) => `${s.status} ${hideToken(s.at)}`).join("; ")}; ${said(afterSkips)})`,
    skips.length === LK_LEAGUE_MATCHES && skips.every((s) => s.status === 303 && s.at.pathname === homePath && s.at.search === "") &&
      afterSkips.how === null && afterSkips.confirmed === 0 && afterSkips.lines.length === 1 &&
      afterSkips.lines.every((l) => l.home === null && l.away === null),
  );

  const asked = await page(homePath);
  const titleCopy = words(`quickMatch.cut.titleMany.${LK_PLACES === 1 ? "one" : "other"}`, {
    place: words("quickMatch.home.rankShort.1"),
    sides: LK_SIDES,
    count: LK_PLACES,
  });
  const title = testidText(asked.html, "qm-cut-title", "h2");
  const options = [...asked.html.matchAll(/name="entrant" value="([0-9a-f-]{36})"[^>]*>\s*<span[^>]*>([^<]*)<\/span>/g)].map((m) => ({
    id: m[1] ?? "",
    name: unescapeHtml(m[2] ?? ""),
  }));
  const pickPath = `${homePath}/cut/pick`;
  const tossPath = `${homePath}/cut/toss`;
  const pickForm = asked.html.includes(`action="${pickPath}"`);
  const tossShown = asked.html.includes(`action="${tossPath}"`) || asked.html.includes(`data-testid="qm-cut-toss"`);
  const toDecide = [rank1, rank2].map((seat) => words("quickMatch.home.toDecide", { seat }));
  const seatsAsked = knockoutSeats(asked.html);
  check(
    `quick match knockout: the league over, all ${LK_SIDES} level on nothing played, the home asks "${titleCopy}" with Pick among the ${LK_SIDES} as typed, no Toss (no lot was drawn), and the final's seats read ${JSON.stringify(toDecide)} (got ${asked.status}; cut ${asks(asked.html) ? "asked" : "none"}, title ${JSON.stringify(title === null ? null : unescapeHtml(title))}; pick form ${pickForm ? "present" : "absent"}, options ${JSON.stringify(options.map((o) => o.name))}; toss ${tossShown ? "shown" : "none"}; seats ${JSON.stringify(seatsAsked)})`,
    asked.status === 200 && asks(asked.html) && titleCopy !== "" && title !== null && unescapeHtml(title) === titleCopy && pickForm &&
      JSON.stringify(options.map((o) => o.name)) === JSON.stringify(typed) && !tossShown && toDecide.every((w) => w !== "") &&
      JSON.stringify(seatsAsked) === JSON.stringify(toDecide),
  );
  if (options.length !== LK_SIDES) return;

  /** A refusal's landing: the home with `?e=<code>` and the flash it prints. */
  const flashOf = async (at: URL) => {
    const flashPage = at.pathname === homePath ? await page(`${at.pathname}${at.search}`) : null;
    const text = flashPage ? testidText(flashPage.html, "qm-flash") : null;
    return text === null ? null : unescapeHtml(text);
  };

  // ── Toss with no lot drawn: refused, nothing written ───────────────────────────────────────────────────────────────────
  const coinless = await postAt(tossPath);
  const coinlessStored = await stored();
  const coinlessFlash = await flashOf(coinless.at);
  const tieChanged = words("quickMatch.flash.tieChanged");
  check(
    `quick match knockout: a Toss post with no lot drawn answers 303 to the home with ?e=${QUICK_MATCH_ERRORS.TIE_NOT_OPEN}, whose flash reads "${tieChanged}", and writes nothing (got ${coinless.status} ${hideToken(coinless.at)}; flash ${JSON.stringify(coinlessFlash)}; ${said(coinlessStored)})`,
    coinless.status === 303 && `${coinless.at.pathname}${coinless.at.search}` === `${homePath}?e=${QUICK_MATCH_ERRORS.TIE_NOT_OPEN}` &&
      tieChanged !== "" && coinlessFlash === tieChanged && coinlessStored.how === null && coinlessStored.confirmed === 0,
  );

  // ── Pick the two typing order would NOT seat: the route's own advance fills the final ─────────────────────────────────
  const chosen = options.slice(LK_SIDES - LK_PLACES);
  const chosenIds = chosen.map((o) => o.id);
  const form = new URLSearchParams();
  for (const o of chosen) form.append("entrant", o.id);
  const pick = await postAt(pickPath, form);
  const filled = await stored(); // before any home load: the home's own retry would mask a route that never advanced
  check(
    `quick match knockout: Pick of ${JSON.stringify(chosen.map((o) => o.name))} answers 303 to the bare home, and before the home is loaded again the database holds that pick, ONE confirmed seed proposal for the knockout stage and the final seated with exactly those two (got ${pick.status} ${hideToken(pick.at)}; ${said(filled)}; seated the chosen ${filled.lines.length === 1 && sameSet(filled.seats, chosenIds)})`,
    pick.status === 303 && pick.at.pathname === homePath && pick.at.search === "" && filled.how === "pick" &&
      filled.through !== null && sameSet(filled.through, chosenIds) && filled.confirmed === 1 && filled.lines.length === 1 &&
      sameSet(filled.seats, chosenIds),
  );

  const decided = await page(homePath);
  const result = testidText(decided.html, "qm-cut-result", "div");
  const list = (names: readonly string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names);
  const names = chosen.map((o) => o.name);
  const resultCopies = [names, [...names].reverse()].map((n) => words("quickMatch.cut.pickResult", { names: list(n) }));
  const seatsDecided = knockoutSeats(decided.html);
  check(
    `quick match knockout: the home no longer asks, its qm-cut-result reads "${resultCopies[0]}" and the final's two seats name exactly those two (got ${decided.status}; cut ${asks(decided.html) ? "asked" : "none"}; result ${JSON.stringify(result === null ? null : unescapeHtml(result))}; seats ${JSON.stringify(seatsDecided)})`,
    decided.status === 200 && !asks(decided.html) && result !== null && resultCopies.every((c) => c !== "") &&
      resultCopies.includes(unescapeHtml(result)) && seatsDecided !== null && sameSet(seatsDecided, names) &&
      names.every((n) => unescapeHtml(result).includes(n)),
  );

  // ── A second answer, as another phone's: refused, nothing moves ────────────────────────────────────────────────────────
  const second = await postAt(tossPath);
  const secondStored = await stored();
  const secondFlash = await flashOf(second.at);
  const alreadyDecided = words("quickMatch.flash.alreadyDecided");
  check(
    `quick match knockout: a second answer (Toss) answers 303 to the home with ?e=${QUICK_MATCH_ERRORS.ALREADY_DECIDED}, whose flash reads "${alreadyDecided}", and changes nothing: the same pick, one confirmed proposal, the same two seated (got ${second.status} ${hideToken(second.at)}; flash ${JSON.stringify(secondFlash)}; ${said(secondStored)})`,
    second.status === 303 && `${second.at.pathname}${second.at.search}` === `${homePath}?e=${QUICK_MATCH_ERRORS.ALREADY_DECIDED}` &&
      alreadyDecided !== "" && secondFlash === alreadyDecided && secondStored.how === "pick" && secondStored.through !== null &&
      sameSet(secondStored.through, chosenIds) && secondStored.confirmed === 1 && secondStored.lines.length === 1 &&
      sameSet(secondStored.seats, chosenIds),
  );
}

/**
 * Step 3b, cricket (decision log 2026-11-13/14; spec C11 as amended 2026-11-14): cricket is offered League only, scored at a
 * guest's bands (toss, Start, over summaries, Close innings). First the refusal: a League → Final of three cricket sides answers
 * 303 back to the setup page with `?e=QUICK_MATCH_FORMAT_NOT_OFFERED` and writes no match. Then the positive pair, a League of
 * two: through the device link the pad's own writes go in, in the order the quick match pad sends them (its Start asks the
 * toss, `cricket-start-toss.ts`): the toss (the away side won and chose to bat, so the AWAY side bats first: the fold's default
 * without a toss is the home side, so the toss is witnessed), the Start, one over of 8 as the over sheet sends it (the innings
 * so far, `partial`), Close innings, then the home side's chasing over of 9, which passes 8: the match is decided, its winner
 * the home side (the engine's answer, read from `fixtures.outcome`; a toss the fold ignored would make it the away side), and
 * the finished home names that side as the winner. Writes only through the guest's own posts, on its own tagged matches, as step 1 does.
 */
async function cricketLeg(
  db: ReturnType<typeof smokeDb>,
  own: (name: string) => Promise<{ id: string; competition_id: string } | null>,
): Promise<void> {
  const offered = OFFER.offered.filter((o) => o.sport_key === CRICKET);
  check(
    `quick match cricket: the probe offers cricket, League only (${offered.length} variant(s): ${offered.map((o) => `${o.variant_key}${o.knockoutAllowed === true ? "+KO" : ""}`).join(", ")})`,
    offered.length > 0 && offered.every((o) => o.knockoutAllowed !== true),
  );
  const variant = offered.find((o) => o.variant_key === CRICKET_VARIANT)?.variant_key ?? offered[0]?.variant_key ?? "";
  if (variant === "") return;

  // The refusal: League → Final is not a cricket quick match.
  const koName = `QM smoke ${tag} cricket final`;
  const refused = await createMatch(koName, [`Owls ${tag}`, `Rooks ${tag}`, `Wrens ${tag}`], variant, CRICKET_FINAL);
  const koRow = await own(koName);
  const expectedAt = `?e=${QUICK_MATCH_ERRORS.FORMAT_NOT_OFFERED}`;
  check(
    `quick match cricket: a League → Final is refused back to the setup page with ${expectedAt} and no match written (got ${refused.status} ${refused.where}; rows ${koRow ? 1 : 0})`,
    refused.status === 303 && refused.token === null && refused.where.endsWith(expectedAt) && koRow === null,
  );

  // The positive pair: a League of two, scored to a won chase.
  const name = `QM smoke ${tag} cricket`;
  const home = `Falcons ${tag}`;
  const away = `Kites ${tag}`;
  const made = await createMatch(name, [home, away], variant, { sport: CRICKET, kind: CRICKET_KIND });
  const row = await own(name);
  check(
    `quick match cricket: a League of two answers 303 to its home and writes one row (got ${made.status} ${made.where}; rows ${row ? 1 : 0})`,
    made.status === 303 && made.token !== null && row !== null,
  );
  if (!made.token || !row) return;
  const homePath = `/q/${made.token}`;
  const before = await page(homePath);
  const fixtureIds = [...new Set([...before.html.matchAll(/action="\/q\/qm_[A-Za-z0-9_-]{43}\/score\/([0-9a-f-]{36})"/g)].map((m) => m[1]))];
  const fixtureId = fixtureIds.length === 1 ? fixtureIds[0] : undefined;
  check(`quick match cricket: the home carries one match's Score form (${fixtureIds.length} distinct)`, fixtureId !== undefined);
  if (!fixtureId) return;
  const tap = await fetch(`${BASE}${homePath}/score/${fixtureId}`, { method: "POST", redirect: "manual" });
  const padAt = new URL(tap.headers.get("location") ?? "", BASE);
  const secret = padAt.search === "" ? (DL.exec(padAt.pathname)?.[1] ?? null) : null;
  check(`quick match cricket: Score answers 303 into the scoring pad (got ${tap.status})`, tap.status === 303 && secret !== null);
  if (!secret) return;
  const asPad = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
  const bootRes = await fetch(`${BASE}/api/v1/device-link`, { headers: asPad });
  type Side = { entrant_id?: string };
  const boot = ((await bootRes.json().catch(() => ({}))) as { data?: { fixture_id?: string; sides?: { home?: Side; away?: Side } } }).data;
  const homeId = boot?.sides?.home?.entrant_id ?? "";
  const awayId = boot?.sides?.away?.entrant_id ?? "";
  check(
    `quick match cricket: the pad's link opens the match with both sides known (got ${bootRes.status}, same match ${boot?.fixture_id === fixtureId})`,
    bootRes.status === 200 && boot?.fixture_id === fixtureId && homeId !== "" && awayId !== "",
  );
  if (homeId === "" || awayId === "") return;

  let seq = 0;
  const post = async (type: string, payload: unknown) => {
    const res = await fetch(`${BASE}/api/v1/fixtures/${fixtureId}/events`, {
      method: "POST",
      headers: asPad,
      body: JSON.stringify({ expected_seq: seq++, type, payload }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    return `${res.status}${json.error?.code ? ` ${json.error.code}` : ""}`;
  };
  const answers = [
    await post("cricket.toss", { wonBy: awayId, elected: "bat" }),
    await post("core.start", {}),
    await post("cricket.innings.summary", { runs: 8, wickets: 0, legalBalls: 6, partial: true }),
    await post("cricket.innings.close", { reason: "other" }),
    await post("cricket.innings.summary", { runs: 9, wickets: 0, legalBalls: 6, partial: true }),
  ];
  const ledgerRes = await fetch(`${BASE}/api/v1/fixtures/${fixtureId}/events?since_seq=0`, { headers: asPad });
  const ledger = ((await ledgerRes.json().catch(() => ({}))) as { data?: { type: string }[] }).data ?? [];
  const types = ["cricket.toss", "core.start", "cricket.innings.summary", "cricket.innings.close", "cricket.innings.summary"];
  check(
    `quick match cricket: toss, Start, an over of 8, Close innings and a chasing over of 9 each go in, in that order (answers ${answers.join(", ")}; ledger ${ledger.map((e) => e.type).join(", ")})`,
    answers.every((a) => a === "201") && JSON.stringify(ledger.map((e) => e.type)) === JSON.stringify(types),
  );
  const [fx] = await db<{ status: string; outcome: { winner?: string } | null }[]>`
    select status, outcome from fixtures where id = ${fixtureId}`;
  check(
    `quick match cricket: the away side won the toss and batted, so the chase past 8 decides the match for the home side batting second (status ${fx?.status}, winner ${fx?.outcome?.winner === homeId ? "home" : fx?.outcome?.winner === awayId ? "away" : JSON.stringify(fx?.outcome)})`,
    fx?.status === "decided" && fx.outcome?.winner === homeId,
  );
  const after = await page(homePath);
  const winner = testidText(after.html, "qm-winner-name", "li");
  check(
    `quick match cricket: the finished home names the home side the winner (got ${after.status}, ${JSON.stringify(winner === null ? null : unescapeHtml(winner))})`,
    after.status === 200 && winner !== null && unescapeHtml(winner) === home,
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

    // ── 3. League + Knockout: a tie at the cut is asked, decided once, and the final fills itself ─────────────────────────
    // A variant whose knockout may be played (C23, the probe's `knockoutAllowed`); its own function, as step 2's.
    const koVariant = OFFER.offered.find((o) => o.sport_key === SPORT && o.knockoutAllowed === true)?.variant_key ?? "";
    check(`quick match knockout: the probe's offer lists a ${SPORT} variant whose knockout may be played (got ${JSON.stringify(koVariant)})`, koVariant !== "");
    if (koVariant !== "") await leagueKnockoutLeg(db, own, koVariant);

    // ── 3b. Cricket: League only (a League → Final refused), and a League of two scored to a won chase ────────────────────
    await cricketLeg(db, own);

    // ── 4. The sweep: an expired unsaved match goes, a saved one and the live one stay ────────────────────────────────────
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
