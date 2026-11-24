import { randomBytes } from "node:crypto";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { BASE, newSession, call, check, signIn, tag, v1, v1data, setPlan } from "../harness.ts";

/**
 * Match Day's realtime-token door over real HTTP (realtime push nudges, spec 2026-11-24 §3, plan Task 9, case `matchDayRealtime`):
 * the organiser mints a Match Day code, and a phone — a bare HTTP client holding only the code's `md_` Bearer, no cookie —
 * asks `GET /api/v1/match-day-code/realtime-token`. The smoke server may or may not configure a Supabase project (CI's runs
 * with none, stg's with one), so the 200 and the 503 REALTIME_UNAVAILABLE are BOTH a correct answer here and each is checked
 * for what it must be; the suite counts which it saw and fails when it saw neither. What it proves on the wire, never in a
 * unit's stubs:
 *   - no bearer, a credential in the QUERY string alone, and an `md_` that does not exist are each 401 MD_UNKNOWN, and carry no data;
 *   - the code's bearer is 200 with exactly the contract's five keys, the bare topic `match-day:{codeId}`, an integer expiry in
 *     epoch SECONDS within the hour, and `cache-control: private, no-store` — or 503 REALTIME_UNAVAILABLE with no token in it;
 *   - the day read still answers the same code 200 (the door spent its own bucket, not the day read's);
 *   - after a withdrawal the door is 410 MD_WITHDRAWN and mints nothing;
 *   - NO response header of any answer carries the md_ credential or a minted token (counted: zero scanned is a failure).
 * Its own Pro org, purged by cleanup(). SMOKE_ONLY=matchDayRealtime runs it alone (SELECTABLE_SUITES).
 */
export async function matchDayRealtimeSuite(): Promise<void> {
  const EXPECTED_STEPS = 10;
  let steps = 0;
  const step = (label: string, cond: boolean) => {
    check(`match-day-realtime smoke: ${label}`, cond);
    steps++;
  };
  const done = () => {
    console.log(`match-day-realtime smoke: ${steps} steps, ${headerSets} header sets scanned, ${served} served, ${unavailable} unavailable`);
    check(`match-day-realtime smoke: all ${EXPECTED_STEPS} steps ran (ran ${steps})`, steps === EXPECTED_STEPS);
  };
  let headerSets = 0, served = 0, unavailable = 0;
  const secrets: string[] = [];
  const leaks: string[] = [];
  const scan = (res: { headers: Headers }, what: string) => {
    headerSets++;
    for (const [name, value] of res.headers) for (const s of secrets) if (value.includes(s)) leaks.push(`${what}: ${name}`);
  };

  const owner = newSession();
  await signIn(owner, `delivered+mdrealtime_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string }[];
  await setPlan(orgs[0].id, "pro", owner);
  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Match Day realtime ${tag}`, visibility: "private" }),
  );

  // 1. MINT — the organiser's Match Day code (today, the whole competition): the md_ credential is all the phone holds.
  const minted = await v1(owner, `/api/v1/competitions/${comp.id}/match-day-codes`, "POST", { scope: { kind: "competition" } });
  const code = v1data<{ id?: string; url?: string }>(minted);
  const credential = code?.url?.slice(code.url.lastIndexOf("/") + 1) ?? "";
  step(`POST match-day-codes → 201 with an md_ credential (got ${minted.status})`, minted.status === 201 && /^md_[A-Za-z0-9_-]{43}$/.test(credential) && !!code.id);
  if (!code?.id || !credential) return done();
  secrets.push(credential);

  const door = async (bearer: string | null, query = "") => {
    const res = await fetch(`${BASE}/api/v1/match-day-code/realtime-token${query}`, { headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` } });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } };
    scan(res, `door ${res.status}`);
    return { status: res.status, headers: res.headers, json };
  };

  // 2-4. THE REFUSALS A CREDENTIAL NOT IN THE HEADER EARNS.
  const none = await door(null);
  step(`no bearer → 401 MD_UNKNOWN, no data (got ${none.status} ${none.json.error?.code})`, none.status === 401 && none.json.error?.code === "MD_UNKNOWN" && none.json.data === undefined);
  const query = await door(null, `?token=${credential}`);
  step(`the credential in the QUERY alone → 401 MD_UNKNOWN: the URL is never read (got ${query.status})`, query.status === 401 && query.json.error?.code === "MD_UNKNOWN" && query.json.data === undefined);
  const unknown = await door("md_" + randomBytes(32).toString("base64url"));
  step(`an md_ code that does not exist → 401 MD_UNKNOWN (got ${unknown.status})`, unknown.status === 401 && unknown.json.error?.code === "MD_UNKNOWN");

  // 5. THE CODE'S OWN ANSWER: a token, or the server's honest "no project here".
  const before = Math.floor(Date.now() / 1000);
  const got = await door(credential);
  if (got.status === 200) {
    served++;
    const d = got.json.data ?? {};
    const token = typeof d.token === "string" ? d.token : "";
    if (token) secrets.push(token);
    step(
      `the code's bearer → 200 {token, topic, expiresAt, url, apikey}, topic match-day:{codeId}, expiresAt in epoch seconds within the hour, private no-store (got ${JSON.stringify(Object.keys(d))})`,
      JSON.stringify(Object.keys(d).sort()) === JSON.stringify(["apikey", "expiresAt", "token", "topic", "url"]) &&
        d.topic === `match-day:${code.id}` &&
        token.split(".").length === 3 &&
        typeof d.expiresAt === "number" && Number.isInteger(d.expiresAt) && d.expiresAt > before && d.expiresAt <= before + 3600 + 30 &&
        typeof d.url === "string" && /^https:\/\/[^\s/?#@]+/.test(d.url) &&
        got.headers.get("cache-control") === "private, no-store",
    );
  } else {
    unavailable++;
    step(
      `the code's bearer on a server with no Supabase project → 503 REALTIME_UNAVAILABLE and no token (got ${got.status} ${got.json.error?.code})`,
      got.status === 503 && got.json.error?.code === "REALTIME_UNAVAILABLE" && got.json.data === undefined,
    );
  }

  // 6. THE DAY READ is untouched: the same code is still admitted there.
  const dayRead = await fetch(`${BASE}/api/v1/match-day-code`, { headers: { authorization: `Bearer ${credential}` } });
  scan(dayRead, "day read");
  step(`the day read still answers the same code 200 (got ${dayRead.status})`, dayRead.status === 200);

  // 7. WITHDRAW: the door is 410 and mints nothing.
  const revoked = await v1(owner, `/api/v1/match-day-codes/${code.id}/revoke`, "POST");
  step(`POST revoke → 204 (got ${revoked.status})`, revoked.status === 204);
  const after = await door(credential);
  step(`after a withdrawal the door is 410 MD_WITHDRAWN and carries no data (got ${after.status} ${after.json.error?.code})`, after.status === 410 && after.json.error?.code === "MD_WITHDRAWN" && after.json.data === undefined);

  // 8-9. THE WIRE: one of the two answers was seen, and no header carried a secret.
  step(`the door answered a token or an honest 503 (served ${served}, unavailable ${unavailable})`, served + unavailable === 1);
  step(`no response header of ${headerSets} carried the credential or a token (leaks: ${leaks.join("; ") || "none"})`, headerSets >= 6 && leaks.length === 0);
  done();
}
