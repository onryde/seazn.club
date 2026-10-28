// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, newSession, cookieHeader, check, signIn, tag, v1 } from "../harness.ts";

/**
 * Chess in-page board T14 — the match room, keyless (no Lichess, no
 * RealtimeKit; nothing here ever resolves to a seat). A room that does not
 * resolve is the room's ONE neutral card — never a 500, never a hint which
 * (no link, a junk link, a signed-in stranger all look alike); the page's
 * head keeps a personal link out of indexes and Referers; and the room's API
 * answers no identity 401 and every wrong identity the same 404 — reads,
 * seats and acts alike, before anything could reach Lichess. The real room
 * (a game, both boards, a move) is e2e/match-room.spec.ts; its Lichess round
 * trip is Task 17's walkthrough. SMOKE_ONLY=matchRoom runs it alone.
 */
export async function matchRoomSuite(): Promise<void> {
  const fixtureId = crypto.randomUUID();
  const fixturePath = `/shared/smoke-room-${tag}/open/rapid/fixtures/${fixtureId}`;
  const junk = `junk-${tag}`;
  const stranger = newSession();
  await signIn(stranger, `delivered+smoke-room-${tag}@resend.dev`);
  check("match room: the stranger is signed in", !!stranger.cookies["seazn_session"]);

  const visitors: [string, string, Session | null][] = [
    ["no link", "", null],
    ["a junk link", `?t=${junk}`, null],
    ["a signed-in stranger", "", stranger],
  ];
  let pages = 0;
  for (const [who, query, session] of visitors) {
    const res = await fetch(`${BASE}${fixturePath}/play${query}`, {
      redirect: "manual",
      headers: session ? { cookie: cookieHeader(session) } : {},
    });
    const html = await res.text();
    check(`match room page, ${who}: 200, never a 500 (got ${res.status})`, res.status === 200);
    check(`match room page, ${who}: the neutral card`, html.includes(`data-screen="unavailable"`));
    check(`match room page, ${who}: its one way out is the fixture page`, html.includes(`href="${fixturePath}"`));
    check(`match room page, ${who}: never indexed`, html.includes(`<meta name="robots" content="noindex, nofollow"`));
    check(`match room page, ${who}: never a Referer`, html.includes(`<meta name="referrer" content="no-referrer"`));
    pages += 1;
  }
  check("match room page: anti-vacuity, three visitors", pages === 3);

  const anon = newSession();
  const room = `/api/v1/fixtures/${fixtureId}/external-play/room`;
  const move = { kind: "move", uci: "e2e4" };
  const calls: [string, Session, string, string, unknown, number][] = [
    ["read, no identity", anon, room, "GET", undefined, 401],
    ["seat, no identity", anon, room, "POST", undefined, 401],
    ["act, no identity", anon, `${room}/act`, "POST", move, 401],
    ["read, a junk link", anon, `${room}?t=${junk}`, "GET", undefined, 404],
    ["seat, a junk link", anon, `${room}?t=${junk}`, "POST", undefined, 404],
    ["act, a junk link", anon, `${room}/act?t=${junk}`, "POST", move, 404],
    ["read, a signed-in stranger", stranger, room, "GET", undefined, 404],
    ["act, a signed-in stranger", stranger, `${room}/act`, "POST", move, 404],
  ];
  let answered = 0;
  for (const [what, session, path, method, body, want] of calls) {
    const r = await v1(session, path, method, body);
    const code = r.json.error?.code;
    check(
      `match room API, ${what}: ${want}${want === 404 ? " NOT_FOUND" : ""} (got ${r.status} ${code ?? ""})`,
      r.status === want && (want !== 404 || code === "NOT_FOUND"),
    );
    answered += 1;
  }
  check("match room API: anti-vacuity, eight calls", answered === calls.length && answered === 8);
}
