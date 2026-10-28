import { readFileSync } from "node:fs";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, type Session, newSession, cookieHeader, call, check, signIn, tag, type V1Res, v1, v1data,
} from "../harness.ts";

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
 * - arbiter round column, phase 2: an ONLINE chess division read as the pages an
 *   organiser opens (`onlineChessDivisionPages`, below): the panel's column, the
 *   Fixtures tab's one entry card and its absent Open round, the stranger's 404.
 * The real surfaces (the watch panel, the queue, the run sheet, Open round) are
 * e2e/online-chess-desk.spec.ts. SMOKE_ONLY=onlineChessDesk runs it alone.
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
}

/**
 * Arbiter round column, phase 2 (spec 2026-10-24-arbiter-round-column-design.md §7, §8) — an ONLINE chess division, read as
 * the pages an organiser opens. The panel answers a division that plays online and the Fixtures tab no longer opens rounds: it
 * shows ONE entry card into the panel (`arbiter-entry`), and only where the panel would answer. Three divisions, in one
 * competition, each CREATED with the config it plays under (`config.onlinePlay: "lichess"` asks only the online-chess flag), read
 * as server-rendered HTML:
 * - an online one with a stage and no fixtures: the panel answers it (the column's "before" phase, the start line) and the
 *   Fixtures tab says to start the division but has no card, because the hint does not need fixtures and the card does (§8);
 * - one over the board, with a league: the panel is a 404 and the tab has no card, no hint and no Open round (§7, online play);
 * - an online one with a league, read before and after Start: the column, the card's fixed line and the tab's start hint
 *   first; then the column's Open round press, ON THE PANEL AND NOWHERE ELSE, and the card saying the round is ready. A
 *   signed-in stranger and a signed-out visitor are refused in the last state.
 * Neither league has a player in it. An online division demands a Lichess link only of an entrant that HAS members
 * (entrants.ts: `members.length > 0`) and `members` defaults to [], so two member-less individual entrants make a fixture, and
 * nothing here needs the Lichess consent no smoke can give. What a round needs once opened (seated, linked players) is the e2e's.
 * The flag is ONLINE_CHESS_ALWAYS=1 on the smoke server (ci.yml, smoke-e2e). A create or a start it refuses FAILS here with the
 * server's own code, and the first refused setup step ends the suite there: one cause is one red, not a cascade of reds.
 * Every probe is anchored on `="`, and every absence rides a presence on the same response.
 * The real column, with players and a round, is e2e/arbiter-panel.spec.ts and the online-chess walkthrough.
 */
async function onlineChessDivisionPages(owner: Session, stranger: Session): Promise<void> {
  // Every expected word is read from the en dictionary on disk (this runner cannot import the JSON-backed `@/lib/messages`).
  const ui = JSON.parse(readFileSync(new URL("../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8")) as Record<string, string>;
  const word = (key: string, vars: Record<string, number> = {}): string => {
    const raw = ui[key];
    if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
    return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
  };
  const openLabel = word("runsheet.round.openCta");

  // The markers, each a whole attribute (`="` anchored): a bare `data-*` probe would match React's `"$undefined"` too.
  const COLUMN = `data-testid="arbiter-round-column"`;
  const START_LINE = `data-testid="arbiter-column-start-first"`;
  const OPEN_PRESS = `data-testid="arbiter-column-open-cta"`;
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
  const arbiter = (div: { slug: string }): string => at(div, "/arbiter");
  const fixturesTab = (div: { slug: string }): string => at(div, "?tab=fixtures");
  const codeOf = (r: V1Res): string => r.json.error?.code ?? "";

  /** Two member-less individual entrants, one league stage and its fixtures. Records each step and answers the generated fixtures'
   *  round numbers, or null once a step is refused (the caller returns: one cause, one red). */
  const buildLeague = async (div: { id: string }, label: string): Promise<number[] | null> => {
    const ents = await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "individual", display_name: `${label} A ${tag}` },
      { kind: "individual", display_name: `${label} B ${tag}` },
    ]);
    check(`online division, ${label}: two member-less entrants, 201 (got ${ents.status} ${codeOf(ents)})`, ents.status === 201);
    if (ents.status !== 201) return null;
    const staged = await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
    const stage = v1data<{ id: string }>(staged);
    check(`online division, ${label}: a league stage (got ${staged.status} ${codeOf(staged)})`, staged.status < 300 && !!stage?.id);
    if (staged.status >= 300 || !stage?.id) return null;
    const generated = await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST");
    const rounds = (v1data<{ fixtures?: { round_no: number }[] }>(generated)?.fixtures ?? []).map((f) => f.round_no);
    check(`online division, ${label}: the league has at least one fixture (got ${generated.status} ${codeOf(generated)}; ${rounds.length} fixtures)`, generated.status < 300 && rounds.length >= 1);
    return generated.status < 300 && rounds.length >= 1 ? rounds : null;
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
  const emptyStaged = await v1(owner, `/api/v1/divisions/${empty.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  check(`online division: a league stage and no Generate (got ${emptyStaged.status} ${codeOf(emptyStaged)})`, emptyStaged.status < 300);
  if (emptyStaged.status >= 300) return;
  await run("created online, a stage and no fixtures", [
    {
      what: "the arbiter page, the organiser",
      who: owner,
      path: arbiter(empty),
      want: 200,
      has: [COLUMN, START_LINE],
      lacks: [OPEN_PRESS, OPEN_LABEL],
      attrs: [["arbiter-round-column", "data-phase", "before"]],
    },
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
  if ((await buildLeague(otb, "over the board")) === null) return;
  await run("over the board, with fixtures", [
    { what: "the arbiter page, the organiser", who: owner, path: arbiter(otb), want: 404 },
    {
      what: "the Fixtures tab, the organiser",
      who: owner,
      path: fixturesTab(otb),
      want: 200,
      has: [`>${otbName}<`],
      lacks: [ENTRY, START_HINT, OLD_OPEN_CONTROL, OPEN_LABEL],
    },
  ]);

  // 3. Created online, with a league.
  const onlineName = `Chess online league ${tag}`;
  const onlineMade = await divisionIn(onlineName, true);
  check(`online division: a league division created playing online, 201 (got ${onlineMade.status} ${codeOf(onlineMade)})`, onlineMade.status === 201);
  const online = v1data<{ id: string; slug: string; config?: { onlinePlay?: string } }>(onlineMade);
  check(
    `online division: its config says onlinePlay lichess (got ${JSON.stringify(online?.config?.onlinePlay)})`,
    online?.config?.onlinePlay === "lichess",
  );
  if (onlineMade.status !== 201 || !online?.id || online.config?.onlinePlay !== "lichess") return;
  const rounds = await buildLeague(online, "online");
  if (rounds === null) return;
  const firstRound = Math.min(...rounds);
  check(`online division: its first round is a number (got ${firstRound})`, Number.isInteger(firstRound));
  if (!Number.isInteger(firstRound)) return;

  // Spec §5.2, §5.4: no round is opened, so the column is "before"; not started, so it says to start first and offers no press.
  // Spec §8 rule 1: nothing to say yet, so the card reads its fixed body (kind "default").
  await run("online, not started", [
    {
      what: "the arbiter page, the organiser",
      who: owner,
      path: arbiter(online),
      want: 200,
      has: [COLUMN, START_LINE],
      lacks: [OPEN_PRESS, OPEN_LABEL],
      attrs: [["arbiter-round-column", "data-phase", "before"]],
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

  // Started, a league has paired round 1 and none is opened: the column is still "before" but now holds the press, and the card
  // says the round is ready (§8 rule 4). The press is the panel's: the tab has the card and not the label.
  await run("online, started, nothing opened", [
    {
      what: "the arbiter page, the organiser",
      who: owner,
      path: arbiter(online),
      want: 200,
      has: [COLUMN, OPEN_PRESS, OPEN_LABEL, `>${onlineName}<`],
      lacks: [START_LINE],
      attrs: [["arbiter-round-column", "data-phase", "before"]],
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
    // the same two URLs, has the column, the card and the name these bodies lack.
    { what: "the arbiter page, a signed-in stranger", who: stranger, path: arbiter(online), want: 404, lacks: [COLUMN, `>${onlineName}<`] },
    { what: "the Fixtures tab, a signed-in stranger", who: stranger, path: fixturesTab(online), want: 404, lacks: [ENTRY, `>${onlineName}<`] },
    { what: "the arbiter page, signed out", who: null, path: arbiter(online), want: "login" },
  ]);

  const expectedAsserted = allProbes.reduce((n, p) => n + assertionsOf(p), 0);
  // Two pins: the table's own count (the loop made every assertion the table names) and a literal (a marker deleted from the table
  // turns the run red; the table-derived count alone would shrink with it). Move the literal on purpose, with the table.
  check(
    `online division: anti-vacuity, ${fetched} pages read and ${asserted} assertions made`,
    fetched === allProbes.length && fetched === 11 && asserted === expectedAsserted && asserted === 53,
  );
}
