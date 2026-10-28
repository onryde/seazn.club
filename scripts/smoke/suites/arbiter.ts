// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, newSession, cookieHeader, call, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Chess in-page board T15 — the arbiter panel, keyless (no Lichess, no
 * RealtimeKit). The organiser's panel and its four routes answer only an
 * organiser of an ONLINE chess board: on an over-the-board chess fixture the
 * join, the leave, the video override and the resync are NOT FOUND (there is
 * no online game; T15 fix round 1, M3); with no identity every route is 401, and so with a
 * signed-in stranger (not a member of the fixture's org); the panel page 404s on the
 * over-the-board division, with a signed-out visitor sent to sign in. The real
 * panel (boards, flags, the outage and its audit record) is
 * e2e/arbiter-panel.spec.ts. SMOKE_ONLY=arbiter runs it alone.
 */
export async function arbiterSuite(): Promise<void> {
  const owner = newSession();
  await signIn(owner, `delivered+smoke-arb-${tag}@resend.dev`);
  const stranger = newSession();
  await signIn(stranger, `delivered+smoke-arb-stranger-${tag}@resend.dev`);
  check("arbiter: owner and stranger signed in", !!owner.cookies["seazn_session"] && !!stranger.cookies["seazn_session"]);

  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Arbiter OTB ${tag}`, visibility: "public" }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Chess OTB",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", clock: { base: 600 } },
    }),
  );
  const ents = await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: `Arb A ${tag}`, members: [{ new_person: { full_name: `Arb A ${tag}` } }] },
    { kind: "individual", display_name: `Arb B ${tag}`, members: [{ new_person: { full_name: `Arb B ${tag}` } }] },
  ]);
  check(`arbiter: two over-the-board entrants (got ${ents.status})`, ents.status === 201);
  const stage = v1data<{ id: string }>(await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }));
  const gen = v1data<{ fixtures: { id: string }[] }>(await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST"));
  const fixtureId = gen?.fixtures?.[0]?.id ?? "";
  check("arbiter: an over-the-board chess fixture to ask about", fixtureId !== "");

  const anon = newSession();
  const base = `/api/v1/fixtures/${fixtureId}/external-play`;
  const note = { note: "smoke: never written" };
  const side = { side: "home" };
  const calls: [string, Session, string, unknown, number, string | null][] = [
    ["join, no identity", anon, `${base}/arbiter`, undefined, 401, null],
    ["resync, no identity", anon, `${base}/resync`, undefined, 401, null],
    ["override, no identity", anon, `${base}/video-override`, note, 401, null],
    // Not a member of the fixture's org: requireOrgAuth's AuthError, the same
    // 401 as no identity — nothing says the board exists.
    ["join, a signed-in stranger", stranger, `${base}/arbiter`, undefined, 401, "UNAUTHENTICATED"],
    ["resync, a signed-in stranger", stranger, `${base}/resync`, undefined, 401, "UNAUTHENTICATED"],
    ["override, a signed-in stranger", stranger, `${base}/video-override`, note, 401, "UNAUTHENTICATED"],
    // D16 (§5.6.4): the join names a player's side, so the body is `{ side }` and a missing one is a 400 - judged before the board is
    // looked up. The over-the-board refusal is asked with a VALID body, or it would answer the validation instead of the 404.
    ["join, the organiser, over the board", owner, `${base}/arbiter`, side, 404, "NOT_FOUND"],
    ["join, the organiser, no side", owner, `${base}/arbiter`, undefined, 400, "VALIDATION"],
    ["override, the organiser, over the board", owner, `${base}/video-override`, note, 404, "NOT_FOUND"],
    ["resync, the organiser, over the board", owner, `${base}/resync`, undefined, 404, "NOT_FOUND"],
  ];
  let answered = 0;
  for (const [what, session, path, body, want, code] of calls) {
    const r = await v1(session, path, "POST", body);
    const got = r.json.error?.code;
    check(`arbiter API, ${what}: ${want}${code ? ` ${code}` : ""} (got ${r.status} ${got ?? ""})`, r.status === want && (code === null || got === code));
    answered += 1;
  }
  // The panel closing (I2): DELETE …/arbiter/{participantId} — nobody's watch here.
  const leave = `${base}/arbiter/smoke-${tag}`;
  const leaves: [string, Session, number, string | null][] = [
    ["leave, no identity", anon, 401, null],
    ["leave, a signed-in stranger", stranger, 401, "UNAUTHENTICATED"],
    ["leave, the organiser, a watch that is not theirs", owner, 404, "NOT_FOUND"],
  ];
  for (const [what, session, want, code] of leaves) {
    const r = await v1(session, leave, "DELETE");
    const got = r.json.error?.code;
    check(`arbiter API, ${what}: ${want}${code ? ` ${code}` : ""} (got ${r.status} ${got ?? ""})`, r.status === want && (code === null || got === code));
    answered += 1;
  }
  check("arbiter API: anti-vacuity, thirteen calls", answered === calls.length + leaves.length && answered === 13);

  // The page: the division's slugs from the organiser's own links.
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[] | { orgs?: { slug: string }[] };
  const orgSlug = Array.isArray(orgs) ? orgs[0]?.slug : orgs.orgs?.[0]?.slug;
  const page = `/o/${orgSlug}/c/${comp.slug}/d/${div.slug}/arbiter`;
  const asOwner = await fetch(`${BASE}${page}`, { redirect: "manual", headers: { cookie: cookieHeader(owner) } });
  check(`arbiter page, the organiser, over the board: 404 (got ${asOwner.status})`, asOwner.status === 404);
  const asAnon = await fetch(`${BASE}${page}`, { redirect: "manual" });
  const to = asAnon.headers.get("location") ?? "";
  check(`arbiter page, signed out: sent to sign in (got ${asAnon.status} ${to})`, asAnon.status >= 300 && asAnon.status < 400 && to.includes("/login"));
}
