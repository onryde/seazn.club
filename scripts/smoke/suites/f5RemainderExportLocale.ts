// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, newSession, cookieHeader, check, signIn, tag, v1, v1data } from "../harness.ts";

/** F5 remainder — build.ts's per-value i18n fallbacks (the "vs" result
 *  separator and the per_pitch "no court" heading; the officials-rota
 *  no-duties subheading and its Accepted/Declined/Pending labels, and the
 *  bracket-family entrantTbd, are proven at the engine/vitest layer instead —
 *  build.test.ts and exports.test.ts — because nothing in the product today
 *  drives a fixture into those states). A rendered PDF's content stream is
 *  compressed, so grepping the response bytes for "vs"/"Unassigned" proves
 *  nothing either way — what only a real HTTP round-trip can show is that the
 *  new fallback-resolution code, threaded through exportChrome() and
 *  buildTimetable, does not throw for a French-locale org's fixtures in their
 *  default day-one state (no court, no result).
 *
 *  Repair pass: roster/officials-rota signature blocks (rosterSignatures/
 *  rotaSignatures) are added below too. Unlike the fields above they need no
 *  special "empty" state — every roster/rota section carries the signature
 *  footer regardless of data — so the same French org exercises both once it
 *  has a registered entrant (roster) and one real duty assignment (rota). */
export async function f5RemainderExportLocaleSuite(): Promise<void> {
  const s = newSession();
  const orgId = (await signIn(s, `delivered+smoke-f5-fr-locale-${tag}@resend.dev`)).org_id;
  const locale = await v1(s, `/api/orgs/${orgId}`, "PATCH", { default_locale: "fr" });
  check("f5 remainder: org PATCH accepts default_locale=fr", locale.status === 200);

  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `FR Locale ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "A", seed: 1 },
    { kind: "individual", display_name: "B", seed: 2 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
  );
  // Freshly generated: no court_id, no result — the exact day-one state
  // build.ts used to render as hardcoded "Unassigned"/"vs" regardless of
  // locale.
  const gen = v1data<{ fixtures: { id: string }[] }>(
    await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
  );

  const timetable = await fetch(
    `${BASE}/api/v1/divisions/${div.id}/exports/timetable?format=pdf&pageBreaks=per_pitch`,
    { headers: { cookie: cookieHeader(s) } },
  );
  const timetableBytes = Buffer.from(await timetable.arrayBuffer());
  check(
    "f5 remainder: a French-locale org's courtless/undecided timetable (per_pitch) still renders a content-bearing PDF",
    timetable.status === 200 && timetableBytes.subarray(0, 5).toString() === "%PDF-",
  );

  // Repair pass: build.ts:152/228 hardcoded the roster's sign-at-start block
  // and the rota's sign-on/off block — opts.i18n.rosterSignatures/
  // rotaSignatures now cover them (exportChrome()). Unlike resultVs/
  // courtUnassigned above, both print unconditionally on every section, so
  // the entrants already registered above are enough for the roster — no
  // day-one/empty state to engineer.
  const roster = await fetch(`${BASE}/api/v1/divisions/${div.id}/exports/roster?format=pdf`, {
    headers: { cookie: cookieHeader(s) },
  });
  const rosterBytes = Buffer.from(await roster.arrayBuffer());
  check(
    "f5 remainder: a French-locale org's roster export still renders a content-bearing PDF",
    roster.status === 200 && rosterBytes.subarray(0, 5).toString() === "%PDF-",
  );

  // The rota query only returns officials with >=1 duty (exports.ts's
  // officialDutyRows), so a section — and its signature block — needs a real
  // assignment first, same idiom as the officials-onboarding suite below.
  const official = v1data<{ id: string }>(
    await v1(s, "/api/v1/officials", "POST", {
      display_name: `FR Ref ${tag}`,
      role_keys: ["referee"],
    }),
  );
  await v1(s, `/api/v1/fixtures/${gen.fixtures[0].id}/officials`, "PATCH", {
    set: [{ official_id: official.id, role_key: "referee", locked: false }],
  });
  const rota = await fetch(`${BASE}/api/v1/divisions/${div.id}/exports/officials_rota?format=pdf`, {
    headers: { cookie: cookieHeader(s) },
  });
  const rotaBytes = Buffer.from(await rota.arrayBuffer());
  check(
    "f5 remainder: a French-locale org's officials-rota export still renders a content-bearing PDF",
    rota.status === 200 && rotaBytes.subarray(0, 5).toString() === "%PDF-",
  );
}
