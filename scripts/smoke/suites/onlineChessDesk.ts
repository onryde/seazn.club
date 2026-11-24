import { readFileSync } from "node:fs";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, type Session, newSession, cookieHeader, call, check, signIn, tag, insertEntitlementOverride, type V1Res, v1, v1data,
} from "../harness.ts";
// The cap and its refusal code from their import-free leaf (lib/online-chess.ts imports `@/`, which this runner cannot resolve): the
// probe below follows the constant the server enforces.
import { ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION as CAP, ONLINE_DIVISION_FULL } from "../../../apps/web/src/lib/online-chess-cap.ts";
// The size ladder and the size's refusal code from the price leaf (also import-free): the size is the third line of that cap
// (Online Chess credits, spec §7.6), so the probe below chooses sizes off the ladder the server enforces.
import { ONLINE_PACKAGE_CODES, ONLINE_SIZES } from "../../../apps/web/src/lib/online-chess-package.ts";

/**
 * Chess in-page board T16 — keyless (no Lichess, no RealtimeKit), against a
 * live server:
 * - the spectators' board route GET /api/v1/public/fixtures/{id}/board answers
 *   a PUBLIC fixture with its doc ({roundOpened, externalPlay}) under the
 *   edge's short public window, and is the same 404 for something that is not
 *   an id, an id that does not exist, and a fixture of a PRIVATE competition;
 * - the organiser's two decisions — "Let the game go on" (…/flags/close) and
 *   "Settle the result now…" (…/resolve) — refuse no identity and a signed-in
 *   stranger (401), and answer the organiser of an over-the-board fixture with
 *   a NOT FOUND (no online board, no flag) rather than writing anything;
 * - the player's door (GET …/lobby) refuses no identity (401) and is the
 *   room's one 404 for a signed-in non-player, never cached.
 * - Match Day online, Task 10: an ONLINE chess division read as the pages an
 *   organiser opens (`onlineChessDivisionPages`, below): Match Day's round row and
 *   round panel, the Fixtures tab's one entry card and its absent Open round, the
 *   stranger's 404.
 * The real surfaces (the board panel, the queue, the run sheet, Open round) are
 * e2e/online-chess-desk.spec.ts and e2e/match-day-online.spec.ts. SMOKE_ONLY=onlineChessDesk runs it alone.
 */
export async function onlineChessDeskSuite(): Promise<void> {
  const owner = newSession();
  await signIn(owner, `delivered+smoke-ocd-${tag}@resend.dev`);
  const stranger = newSession();
  await signIn(stranger, `delivered+smoke-ocd-stranger-${tag}@resend.dev`);
  check("online chess desk: owner and stranger signed in", !!owner.cookies["seazn_session"] && !!stranger.cookies["seazn_session"]);
  const anon = newSession();

  /** One over-the-board chess fixture in a competition of the given visibility. */
  const fixtureIn = async (visibility: "public" | "private"): Promise<string> => {
    const comp = v1data<{ id: string }>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `OCD ${visibility} ${tag}`, visibility }),
    );
    const div = v1data<{ id: string }>(
      await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name: "Chess OTB",
        sport_key: "boardgame",
        variant_key: "classical",
        config: { variant: "classical", clock: { base: 600 } },
      }),
    );
    const ents = await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "individual", display_name: `OCD A ${visibility} ${tag}`, members: [{ new_person: { full_name: `OCD A ${tag}` } }] },
      { kind: "individual", display_name: `OCD B ${visibility} ${tag}`, members: [{ new_person: { full_name: `OCD B ${tag}` } }] },
    ]);
    check(`online chess desk: two entrants in the ${visibility} division (got ${ents.status})`, ents.status === 201);
    const stage = v1data<{ id: string }>(await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }));
    const gen = v1data<{ fixtures: { id: string }[] }>(await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST"));
    return gen?.fixtures?.[0]?.id ?? "";
  };
  const publicFixture = await fixtureIn("public");
  const privateFixture = await fixtureIn("private");
  check("online chess desk: a public and a private fixture to ask about", publicFixture !== "" && privateFixture !== "");

  // The spectators' board route: public, no identity needed.
  const board = (id: string) => v1(anon, `/api/v1/public/fixtures/${id}/board`);
  const open = await board(publicFixture);
  check(`board route, a public over-the-board fixture: 200 (got ${open.status})`, open.status === 200);
  const doc = v1data<{ roundOpened?: unknown; externalPlay?: unknown }>(open);
  check(
    `board route: nothing played online here — roundOpened false, externalPlay null (got ${JSON.stringify(doc)})`,
    doc?.roundOpened === false && doc?.externalPlay === null,
  );
  const cc = open.headers.get("cache-control") ?? "";
  check(`board route: the edge's short public window (got "${cc}")`, cc === "public, s-maxage=2, stale-while-revalidate=5");
  const notFound: [string, string][] = [
    ["not an id", "not-a-uuid"],
    ["an id that does not exist", "00000000-0000-4000-8000-000000000000"],
    ["a fixture of a private competition", privateFixture],
  ];
  for (const [what, id] of notFound) {
    const r = await board(id);
    check(`board route, ${what}: 404 (got ${r.status})`, r.status === 404);
  }

  // The organiser's decisions: valid bodies, so each answer is the auth or the board's, never the parser's.
  const base = `/api/v1/fixtures/${publicFixture}/external-play`;
  const flagIds = { ids: ["00000000-0000-4000-8000-000000000001"] };
  const settle = { kind: "draw" };
  const calls: [string, Session, string, unknown, number, string | null][] = [
    ["go on, no identity", anon, `${base}/flags/close`, flagIds, 401, null],
    ["settle, no identity", anon, `${base}/resolve`, settle, 401, null],
    ["go on, a signed-in stranger", stranger, `${base}/flags/close`, flagIds, 401, "UNAUTHENTICATED"],
    ["settle, a signed-in stranger", stranger, `${base}/resolve`, settle, 401, "UNAUTHENTICATED"],
    ["go on, the organiser, a flag that is not on this board", owner, `${base}/flags/close`, flagIds, 404, "FLAG_NOT_FOUND"],
    ["settle, the organiser, over the board", owner, `${base}/resolve`, settle, 404, "NOT_FOUND"],
  ];
  let answered = 0;
  for (const [what, session, path, body, want, code] of calls) {
    const r = await v1(session, path, "POST", body);
    const got = r.json.error?.code;
    check(`online chess desk API, ${what}: ${want}${code ? ` ${code}` : ""} (got ${r.status} ${got ?? ""})`, r.status === want && (code === null || got === code));
    answered += 1;
  }
  // The player's door: session only; a non-player is the room's one 404; never cached.
  const doors: [string, Session, number, string | null][] = [
    ["door, no identity", anon, 401, null],
    ["door, a signed-in stranger", stranger, 404, "NOT_FOUND"],
    ["door, the organiser, who plays nowhere here", owner, 404, "NOT_FOUND"],
  ];
  for (const [what, session, want, code] of doors) {
    const r = await v1(session, `${base}/lobby`);
    const got = r.json.error?.code;
    const noStore = r.headers.get("cache-control") === "private, no-store";
    check(`online chess desk API, ${what}: ${want}${code ? ` ${code}` : ""}, private no-store (got ${r.status} ${got ?? ""})`, r.status === want && (code === null || got === code) && noStore);
    answered += 1;
  }
  check("online chess desk API: anti-vacuity, nine calls", answered === calls.length + doors.length && answered === 9);
  // Nothing above wrote a result: the public fixture is still unplayed.
  const fx = v1data<{ status?: string }>(await v1(owner, `/api/v1/fixtures/${publicFixture}`));
  check(`online chess desk: no refusal wrote a result (status ${fx?.status})`, fx?.status === "scheduled");

  await onlineChessDivisionPages(owner, stranger);
  await onlineEntrantCap(owner);
}

/**
 * The entrant cap of an online chess division (owner ruling 2026-11-21 at 128, raised to 256 on 2026-11-23), through the REAL v1
 * route. The organiser's plan is lifted to 1,000 entrants a division (and 50 active competitions: the suite's owner has built three by
 * here) so the PLAN is not what refuses: an online division takes CAP (256) in one bulk POST (the route takes up to 500), the next is
 * a 422 ONLINE_DIVISION_FULL carrying the limit, and an over-the-board division on the same plan takes CAP + 1 - so the refusal is the
 * online cap's own. That division is CHOSEN at size 256 (a new online division opens at the smallest size, 16, and the size is a third
 * line below the cap: Online Chess credits, spec §7.6); a second one, chosen at 16 through the API, takes 16 entrants and answers the
 * 17th with 422 ONLINE_SIZE_FULL (`size`, `nextSize`) - and takes it once the size is moved to 32 (the SEQUENCE: full, refused, moved up,
 * admitted). (The sign-up, promote, Reinstate and online-switch doors, the lock and the race are
 * usecases/__tests__/online-entrant-cap-doors.test.ts and online-entrant-size-doors.test.ts.)
 */
async function onlineEntrantCap(owner: Session): Promise<void> {
  const orgs = (await call(owner, "/api/orgs")) as { id: string }[] | { orgs?: { id: string }[] };
  const orgId = (Array.isArray(orgs) ? orgs[0]?.id : orgs.orgs?.[0]?.id) ?? "";
  check("online entrant cap: the organiser's org", orgId !== "");
  if (orgId === "") return;
  await insertEntitlementOverride(owner, orgId, "entrants.per_division.max", 1000);
  // The suite's owner has already built three competitions by here (the public and private fixtures above and the division pages' own), and the Community plan's
  // active-competition limit refuses the next one with 402 competitions.max_active (CI run 44950609964; read off the row's message). Lifted the way
  // publicQuotaDegrade lifts it: what this row asks is the online cap, so no OTHER plan limit may be what answers.
  await insertEntitlementOverride(owner, orgId, "competitions.max_active", 50);
  const compMade = await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `OCD cap ${tag}`, visibility: "private" });
  const comp = v1data<{ id: string }>(compMade);
  check(`online entrant cap: a competition to build in (got ${compMade.status} ${compMade.json.error?.code ?? ""})`, !!comp?.id);
  if (!comp?.id) return;
  const divisionIn = (name: string, online: boolean, size?: number) =>
    v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name,
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", clock: { base: 600, increment: 5 }, ...(online ? { onlinePlay: "lichess" } : {}) },
      ...(online && size !== undefined ? { online_size: size } : {}),
    });
  const entrants = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ kind: "individual", display_name: `Cap ${from + i} ${tag}` }));
  // The premise: the ladder the probe picks from is the server's (the leaf), and 256 and 16 are its ends.
  const smallest = ONLINE_SIZES[0]!;
  const nextUp = ONLINE_SIZES[1]!;
  check(`online entrant cap: the size ladder runs ${smallest} .. ${CAP} (got ${ONLINE_SIZES.join(", ")})`, smallest === 16 && nextUp === 32 && ONLINE_SIZES[ONLINE_SIZES.length - 1] === CAP);
  const made = { online: await divisionIn(`Cap online ${tag}`, true, CAP), otb: await divisionIn(`Cap otb ${tag}`, false) };
  const online = v1data<{ id: string }>(made.online);
  const otb = v1data<{ id: string }>(made.otb);
  check(`online entrant cap: both divisions made (got ${made.online.status} and ${made.otb.status})`, made.online.status === 201 && made.otb.status === 201 && !!online?.id && !!otb?.id);
  if (!online?.id || !otb?.id) return;

  // The premise: the ruling's 256, and a plan override above both numbers the probe writes.
  check(`online entrant cap: the cap is the ruling's 256 (got ${CAP})`, CAP === 256);
  const full = await v1(owner, `/api/v1/divisions/${online.id}/entrants`, "POST", entrants(1, CAP));
  check(`online entrant cap: ${CAP} entrants fit an online division, 201 (got ${full.status} ${full.json.error?.code ?? ""})`, full.status === 201);
  const over = await v1(owner, `/api/v1/divisions/${online.id}/entrants`, "POST", entrants(CAP + 1, 1));
  // The body spreads the refusal's `extra` into `error` (api-v1/http.ts errorResponse): the limit rides as `error.limit`.
  const overLimit = (over.json.error as { limit?: unknown } | undefined)?.limit;
  check(
    `online entrant cap: the ${CAP + 1}th is a 422 ${ONLINE_DIVISION_FULL} with limit ${CAP} (got ${over.status} ${over.json.error?.code ?? ""} limit ${String(overLimit)})`,
    over.status === 422 && over.json.error?.code === ONLINE_DIVISION_FULL && overLimit === CAP,
  );
  const listed = v1data<unknown[]>(await v1(owner, `/api/v1/divisions/${online.id}/entrants`));
  check(`online entrant cap: the refusal wrote nothing, ${CAP} entrants stand (got ${Array.isArray(listed) ? listed.length : "?"})`, Array.isArray(listed) && listed.length === CAP);
  const sameSizeOtb = await v1(owner, `/api/v1/divisions/${otb.id}/entrants`, "POST", entrants(1, CAP + 1));
  check(`online entrant cap: ${CAP + 1} fit an over-the-board division on the same plan, 201 (got ${sameSizeOtb.status} ${sameSizeOtb.json.error?.code ?? ""})`, sameSizeOtb.status === 201);

  // The size as the cap (spec §5.2, §7.6): chosen at the smallest size through the API, it takes that many and no more.
  const sizedMade = await divisionIn(`Cap sized ${tag}`, true, smallest);
  const sized = v1data<{ id: string }>(sizedMade);
  check(`online entrant cap: a division chosen at size ${smallest}, 201 (got ${sizedMade.status} ${sizedMade.json.error?.code ?? ""})`, sizedMade.status === 201 && !!sized?.id);
  if (!sized?.id) return;
  let sizeChecks = 0;
  const atSize = await v1(owner, `/api/v1/divisions/${sized.id}/entrants`, "POST", entrants(1, smallest));
  check(`online entrant cap: ${smallest} entrants fit a size-${smallest} division, 201 (got ${atSize.status} ${atSize.json.error?.code ?? ""})`, atSize.status === 201);
  const pastSize = await v1(owner, `/api/v1/divisions/${sized.id}/entrants`, "POST", entrants(smallest + 1, 1));
  const refusal = pastSize.json.error as { code?: string; size?: unknown; nextSize?: unknown } | undefined;
  check(
    `online entrant cap: the ${smallest + 1}th is a 422 ${ONLINE_PACKAGE_CODES.sizeFull} with size ${smallest} and nextSize ${nextUp} (got ${pastSize.status} ${refusal?.code ?? ""} size ${String(refusal?.size)} nextSize ${String(refusal?.nextSize)})`,
    pastSize.status === 422 && refusal?.code === ONLINE_PACKAGE_CODES.sizeFull && refusal.size === smallest && refusal.nextSize === nextUp,
  );
  const heldAtSize = v1data<unknown[]>(await v1(owner, `/api/v1/divisions/${sized.id}/entrants`));
  check(`online entrant cap: the size refusal wrote nothing, ${smallest} entrants stand (got ${Array.isArray(heldAtSize) ? heldAtSize.length : "?"})`, Array.isArray(heldAtSize) && heldAtSize.length === smallest);
  // Moved up (an unpaid size changes through the division save), the same add is admitted: the refusal was the size's, not a stuck state.
  const movedUp = await v1(owner, `/api/v1/divisions/${sized.id}`, "PATCH", { online_size: nextUp });
  check(`online entrant cap: the size moved to ${nextUp}, 200 (got ${movedUp.status} ${movedUp.json.error?.code ?? ""})`, movedUp.status === 200);
  const admitted = await v1(owner, `/api/v1/divisions/${sized.id}/entrants`, "POST", entrants(smallest + 1, 1));
  check(`online entrant cap: after the move up the ${smallest + 1}th is admitted, 201 (got ${admitted.status} ${admitted.json.error?.code ?? ""})`, admitted.status === 201);
  sizeChecks += 6;
  check(`online entrant cap: anti-vacuity, ${sizeChecks} size checks made`, sizeChecks === 6);
}

/**
 * Match Day online, Task 10 (plan 2026-11-05-match-day-all-in-one.md; it replaces the Arbiter page's phase-2 probes, spec
 * 2026-10-24-arbiter-round-column-design.md §7, §8) — an ONLINE chess division, read as the pages an organiser opens. Match Day
 * answers a division that plays online and the Fixtures tab no longer opens rounds: it shows ONE entry card into Match Day
 * (`arbiter-entry`), and only where Match Day would answer. Three divisions, in one competition, each CREATED with the config it
 * plays under (`config.onlinePlay: "lichess"` asks only the online-chess flag), read as server-rendered HTML:
 * - an online one with a stage and no fixtures: Match Day has no round of it (no online block) and the Fixtures tab says to start
 *   the division but has no card, because the hint does not need fixtures and the card does (§8);
 * - one over the board, with a league: Match Day has no online block and the tab has no card, no hint and no Open round (§7);
 * - an online one with a knockout, read before and after Start: the round's row and its panel (`?round=`, "start the division
 *   first" and no press), the card's fixed line and the tab's start hint first; then the panel's Open round press, ON THE PANEL
 *   AND NOWHERE ELSE, and the card saying the round is ready. A signed-in stranger and a signed-out visitor are refused in the
 *   last state.
 * An online division takes Swiss and knockout stages only (Online Chess credits, Task 8: a league is a 422 ONLINE_FORMAT_NOT_SUPPORTED
 * there), so both online divisions are staged as a knockout; the over-the-board one keeps its league, which an over-the-board division
 * may have. Neither stage has a player in it. An online division demands a Lichess link only of an entrant that HAS members
 * (entrants.ts: `members.length > 0`) and `members` defaults to [], so two member-less individual entrants make a fixture, and
 * nothing here needs the Lichess consent no smoke can give. What a round needs once opened (seated, linked players) is the e2e's.
 * The flag is ONLINE_CHESS_ALWAYS=1 on the smoke server (ci.yml, smoke-e2e). A create or a start it refuses FAILS here with the
 * server's own code, and the first refused setup step ends the suite there: one cause is one red, not a cascade of reds.
 * Every probe is anchored on `="`, and every absence rides a presence on the same response.
 * The real round panel, with players and a round, is e2e/match-day-online.spec.ts and the online-chess walkthrough.
 */
async function onlineChessDivisionPages(owner: Session, stranger: Session): Promise<void> {
  // Every expected word is read from the en dictionary on disk (this runner cannot import the JSON-backed `@/lib/messages`).
  const ui = JSON.parse(readFileSync(new URL("../../../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8")) as Record<string, string>;
  const word = (key: string, vars: Record<string, number> = {}): string => {
    const raw = ui[key];
    if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
    return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
  };
  const openLabel = word("runsheet.round.openCta");

  // The markers, each a whole attribute (`="` anchored): a bare `data-*` probe would match React's `"$undefined"` too.
  const HEADER = `data-testid="md-header"`;
  const ONLINE_BLOCK = `data-testid="md-online"`;
  const ROUND_ROW = `data-testid="md-round-row"`;
  const FOCUS = `data-testid="md-focus"`;
  const START_LINE = `data-testid="md-round-start-first"`;
  const OPEN_PRESS = `data-testid="md-round-open-cta"`;
  const ENTRY = `data-testid="arbiter-entry"`;
  const START_HINT = `data-testid="online-start-hint"`;
  // The Fixtures tab's old control. Task 10 deleted it, so its absence is vacuous alone: it is kept, and `>Open round<` (the
  // rendered label, not the dictionary's copy of it that rides in the page's payload) is the absence that CAN fail.
  const OLD_OPEN_CONTROL = `data-testid="open-round"`;
  const OPEN_LABEL = `>${openLabel}<`;

  /** The opening tag of the first element carrying this test id, and where it ends. A tag's attribute values may hold `>`. */
  const OPEN_TAG = /<[a-zA-Z][\w-]*(?:\s+[^\s"'<>/=]+(?:="[^"]*")?)*\s*\/?>/g;
  const tagOf = (body: string, testid: string): { tag: string; end: number } | null => {
    for (const m of body.matchAll(OPEN_TAG)) {
      if (m[0].includes(` data-testid="${testid}"`)) return { tag: m[0], end: (m.index ?? 0) + m[0].length };
    }
    return null;
  };
  const attrOf = (body: string, testid: string, attr: string): string | null => {
    const t = tagOf(body, testid);
    return t === null ? null : (new RegExp(`\\s${attr}="([^"]*)"`).exec(t.tag)?.[1] ?? null);
  };
  const textOf = (body: string, testid: string): string | null => {
    const t = tagOf(body, testid);
    const close = t === null ? -1 : body.indexOf("</", t.end);
    return t === null || close < 0 ? null : body.slice(t.end, close);
  };

  type Probe = {
    what: string;
    who: Session | null;
    path: string;
    /** 200, 404, or "login" (a redirect to sign in). */
    want: number | "login";
    has?: string[];
    lacks?: string[];
    /** [test id, attribute, value]: the attribute is read off that element's own tag. */
    attrs?: [string, string, string][];
    /** [test id, text]: the element's own text. */
    text?: [string, string][];
  };
  const allProbes: Probe[] = [];
  let fetched = 0;
  let asserted = 0;
  const run = async (state: string, probes: Probe[]): Promise<void> => {
    for (const p of probes) {
      // A guard, not a comment: an absence on a 200 page is read beside a presence on the SAME response.
      if (p.want === 200 && p.lacks && !(p.has?.length || p.attrs?.length || p.text?.length)) {
        throw new Error(`online division, ${state}, ${p.what}: an absence with no presence beside it proves nothing`);
      }
      allProbes.push(p);
      const res = await fetch(`${BASE}${p.path}`, { redirect: "manual", headers: p.who ? { cookie: cookieHeader(p.who) } : {} });
      const body = await res.text();
      const location = res.headers.get("location") ?? "";
      fetched += 1;
      const ok = (label: string, cond: boolean): void => {
        check(`online division, ${state}, ${p.what}: ${label}`, cond);
        asserted += 1;
      };
      ok(
        p.want === "login" ? `sent to sign in (got ${res.status} ${location})` : `${p.want} (got ${res.status})`,
        p.want === "login" ? res.status >= 300 && res.status < 400 && location.includes("/login") : res.status === p.want,
      );
      for (const s of p.has ?? []) ok(`has ${s}`, body.includes(s));
      for (const s of p.lacks ?? []) ok(`lacks ${s}`, !body.includes(s));
      for (const [id, attr, want] of p.attrs ?? []) {
        const got = attrOf(body, id, attr);
        ok(`${id} ${attr}="${want}" (got ${got === null ? "nothing" : `"${got}"`})`, got === want);
      }
      for (const [id, want] of p.text ?? []) {
        const got = textOf(body, id);
        ok(`${id} says "${want}" (got ${got === null ? "nothing" : `"${got}"`})`, got === want);
      }
    }
  };
  /** What a probe asserts, counted from its own definition: its status, then each marker it names. */
  const assertionsOf = (p: Probe): number => 1 + (p.has?.length ?? 0) + (p.lacks?.length ?? 0) + (p.attrs?.length ?? 0) + (p.text?.length ?? 0);

  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[] | { orgs?: { slug: string }[] };
  const orgSlug = (Array.isArray(orgs) ? orgs[0]?.slug : orgs.orgs?.[0]?.slug) ?? "";
  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `OCD online ${tag}`, visibility: "private" }),
  );
  check("online division: an organiser's org and a competition to build in", orgSlug !== "" && !!comp?.id && !!comp?.slug);
  if (orgSlug === "" || !comp?.id) return;
  const clock = { base: 600, increment: 5 };
  const divisionIn = (name: string, onlinePlay: boolean) =>
    v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name,
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", clock, ...(onlinePlay ? { onlinePlay: "lichess" } : {}) },
    });
  const at = (div: { slug: string }, tail: string): string => `/o/${orgSlug}/c/${comp.slug}/d/${div.slug}${tail}`;
  const matchDay = `/o/${orgSlug}/c/${comp.slug}/match-day`;
  const roundPanel = (stageId: string, roundNo: number): string => `${matchDay}?round=${stageId}:${roundNo}`;
  const fixturesTab = (div: { slug: string }): string => at(div, "?tab=fixtures");
  const codeOf = (r: V1Res): string => r.json.error?.code ?? "";

  /** Two member-less individual entrants, one stage of `kind` and its fixtures. Records each step and answers the generated fixtures'
   *  round numbers and its stage id, or null once a step is refused (the caller returns: one cause, one red).
   *  Two entrants make ONE match in either format (a single knockout of n entrants plays n - 1; one round-robin pairing of two is one),
   *  so a knockout answers exactly one fixture. */
  const buildStage = async (div: { id: string }, label: string, kind: "league" | "knockout"): Promise<{ rounds: number[]; stageId: string } | null> => {
    const ents = await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "individual", display_name: `${label} A ${tag}` },
      { kind: "individual", display_name: `${label} B ${tag}` },
    ]);
    check(`online division, ${label}: two member-less entrants, 201 (got ${ents.status} ${codeOf(ents)})`, ents.status === 201);
    if (ents.status !== 201) return null;
    const staged = await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind, name: kind === "league" ? "League" : "Knockout", config: {} });
    const stage = v1data<{ id: string }>(staged);
    check(`online division, ${label}: a ${kind} stage (got ${staged.status} ${codeOf(staged)})`, staged.status < 300 && !!stage?.id);
    if (staged.status >= 300 || !stage?.id) return null;
    const generated = await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST");
    const rounds = (v1data<{ fixtures?: { round_no: number }[] }>(generated)?.fixtures ?? []).map((f) => f.round_no);
    const enough = kind === "knockout" ? rounds.length === 1 : rounds.length >= 1;
    check(`online division, ${label}: the ${kind} has ${kind === "knockout" ? "its one" : "at least one"} fixture (got ${generated.status} ${codeOf(generated)}; ${rounds.length} fixtures)`, generated.status < 300 && enough);
    return generated.status < 300 && enough ? { rounds, stageId: stage.id } : null;
  };

  // 1. CREATED playing online, with a stage and nothing generated: no entrant, so no fixture.
  const emptyName = `Chess online empty ${tag}`;
  const made = await divisionIn(emptyName, true);
  check(`online division: created playing online, 201 (got ${made.status} ${codeOf(made)})`, made.status === 201);
  const empty = v1data<{ id: string; slug: string; config?: { onlinePlay?: string } }>(made);
  check(
    `online division: the created division's config says onlinePlay lichess (got ${JSON.stringify(empty?.config?.onlinePlay)})`,
    empty?.config?.onlinePlay === "lichess",
  );
  if (made.status !== 201 || !empty?.slug || empty.config?.onlinePlay !== "lichess") return;
  const emptyStaged = await v1(owner, `/api/v1/divisions/${empty.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Knockout", config: {} });
  check(`online division: a knockout stage and no Generate (got ${emptyStaged.status} ${codeOf(emptyStaged)})`, emptyStaged.status < 300);
  if (emptyStaged.status >= 300) return;
  await run("created online, a stage and no fixtures", [
    // Match Day answers the competition whose online division has a stage and no fixture: the page is there (its header).
    { what: "Match Day, the organiser", who: owner, path: matchDay, want: 200, has: [HEADER] },
    {
      what: "the Fixtures tab, the organiser",
      who: owner,
      path: fixturesTab(empty),
      want: 200,
      // §8: the start hint is wanted before any fixture exists (a division that has not started has none), so it does not wait for
      // fixtures; the card needs them as well as the panel's own conditions, and this division has none.
      has: [`>${emptyName}<`, START_HINT],
      lacks: [ENTRY, OLD_OPEN_CONTROL, OPEN_LABEL],
    },
  ]);

  // 2. The same build over the board: the predicate's online-play term (§7). The online division below is the presence beside it.
  const otbName = `Chess over the board ${tag}`;
  const otbMade = await divisionIn(otbName, false);
  check(`online division: a division created over the board, 201 (got ${otbMade.status} ${codeOf(otbMade)})`, otbMade.status === 201);
  const otb = v1data<{ id: string; slug: string; config?: { onlinePlay?: string } }>(otbMade);
  check(`online division: it has no onlinePlay (got ${JSON.stringify(otb?.config?.onlinePlay)})`, otb?.config?.onlinePlay === undefined);
  if (otbMade.status !== 201 || !otb?.id || otb.config?.onlinePlay !== undefined) return;
  const otbBuilt = await buildStage(otb, "over the board", "league");
  if (otbBuilt === null) return;
  await run("over the board, with fixtures", [
    // Over the board: Match Day is the competition's page and answers 200, but the division's stage has no online round (a round row's key
    // is `<stage id>:<round no>`); the page's header is the presence beside the absence.
    { what: "Match Day, the organiser", who: owner, path: matchDay, want: 200, has: [HEADER], lacks: [`data-key="${otbBuilt.stageId}:`] },
    {
      what: "the Fixtures tab, the organiser",
      who: owner,
      path: fixturesTab(otb),
      want: 200,
      has: [`>${otbName}<`],
      lacks: [ENTRY, START_HINT, OLD_OPEN_CONTROL, OPEN_LABEL],
    },
  ]);

  // 3. Created online, with a knockout.
  const onlineName = `Chess online knockout ${tag}`;
  const onlineMade = await divisionIn(onlineName, true);
  check(`online division: a division created playing online, 201 (got ${onlineMade.status} ${codeOf(onlineMade)})`, onlineMade.status === 201);
  const online = v1data<{ id: string; slug: string; config?: { onlinePlay?: string } }>(onlineMade);
  check(
    `online division: its config says onlinePlay lichess (got ${JSON.stringify(online?.config?.onlinePlay)})`,
    online?.config?.onlinePlay === "lichess",
  );
  if (onlineMade.status !== 201 || !online?.id || online.config?.onlinePlay !== "lichess") return;
  const built = await buildStage(online, "online", "knockout");
  if (built === null) return;
  const firstRound = Math.min(...built.rounds);
  check(`online division: its first round is a number (got ${firstRound})`, Number.isInteger(firstRound));
  if (!Number.isInteger(firstRound)) return;

  // Spec §5.2, §5.4: not started, so Match Day lists the round, its panel says to start first and offers no press.
  // Spec §8 rule 1: nothing to say yet, so the card reads its fixed body (kind "default").
  await run("online, not started", [
    {
      what: "Match Day's round panel, the organiser",
      who: owner,
      path: roundPanel(built.stageId, firstRound),
      want: 200,
      has: [ONLINE_BLOCK, ROUND_ROW, FOCUS, START_LINE],
      lacks: [OPEN_PRESS, OPEN_LABEL],
      attrs: [
        ["md-focus", "data-online", "round"],
        ["md-focus", "data-state", "not_started"],
      ],
    },
    {
      what: "the Fixtures tab, the organiser",
      who: owner,
      path: fixturesTab(online),
      want: 200,
      has: [ENTRY, START_HINT],
      lacks: [OLD_OPEN_CONTROL, OPEN_LABEL],
      attrs: [["arbiter-entry-status", "data-kind", "default"]],
    },
  ]);

  const started = await v1(owner, `/api/v1/divisions/${online.id}/start`, "POST");
  check(`online division: started (got ${started.status} ${codeOf(started)})`, started.status < 300);
  if (started.status >= 300) return;

  // Started, the knockout's first round stands paired and none is opened: the round's panel is "before" and now holds the press, and the card
  // says the round is ready (§8 rule 4). The press is the panel's: the tab has the card and not the label.
  await run("online, started, nothing opened", [
    {
      what: "Match Day's round panel, the organiser",
      who: owner,
      path: roundPanel(built.stageId, firstRound),
      want: 200,
      has: [ONLINE_BLOCK, ROUND_ROW, FOCUS, OPEN_PRESS, OPEN_LABEL],
      lacks: [START_LINE],
      attrs: [
        ["md-focus", "data-online", "round"],
        ["md-focus", "data-state", "before"],
      ],
    },
    {
      what: "the Fixtures tab, the organiser",
      who: owner,
      path: fixturesTab(online),
      want: 200,
      has: [ENTRY, `>${onlineName}<`],
      lacks: [START_HINT, OLD_OPEN_CONTROL, OPEN_LABEL],
      attrs: [["arbiter-entry-status", "data-kind", "ready"]],
      text: [["arbiter-entry-status", word("arbiter.entry.status.ready", { round: firstRound })]],
    },
    // Not a member of the division's org: both pages are the one 404 and carry nothing of the division. The organiser's 200 above, on
    // the same two URLs, has the round row, the card and the name these bodies lack.
    { what: "Match Day, a signed-in stranger", who: stranger, path: roundPanel(built.stageId, firstRound), want: 404, lacks: [FOCUS, ROUND_ROW, `>${onlineName}<`] },
    { what: "the Fixtures tab, a signed-in stranger", who: stranger, path: fixturesTab(online), want: 404, lacks: [ENTRY, `>${onlineName}<`] },
    { what: "Match Day, signed out", who: null, path: roundPanel(built.stageId, firstRound), want: "login" },
  ]);

  const expectedAsserted = allProbes.reduce((n, p) => n + assertionsOf(p), 0);
  // Two pins: the table's own count (the loop made every assertion the table names) and a literal (a marker deleted from the table
  // turns the run red; the table-derived count alone would shrink with it). Move the literal on purpose, with the table.
  check(
    `online division: anti-vacuity, ${fetched} pages read and ${asserted} assertions made`,
    fetched === allProbes.length && fetched === 11 && asserted === expectedAsserted && asserted === 57,
  );
}
