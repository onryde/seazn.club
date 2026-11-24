// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, setPlan, type V1Res } from "../harness.ts";

/**
 * The competition realtime-token door over real HTTP (realtime push nudges, spec 2026-11-24 §4.1, plan Task 12, case
 * `divisionRealtimeDoor`): `GET /api/v1/public/competitions/{id}/realtime-token`, the token for a competition's private
 * `division:{id}` topics. The smoke server may or may not configure a Supabase project (CI's runs with none, stg's with one),
 * so for an admitted caller the 200 and the 503 REALTIME_UNAVAILABLE are BOTH a correct answer and each is checked for what
 * it must be; the suite counts which it saw. What it proves on the wire:
 *   - a spectator (no cookie) on a PUBLIC competition of a Pro org: 200 with exactly `{token, divisionIds, expiresAt, url,
 *     apikey}`, `divisionIds` = the competition's one division, an integer expiry in epoch SECONDS within the hour, and
 *     `cache-control: private, no-store` — or 503 with no token;
 *   - a spectator on a PUBLIC competition of a Community org (no `realtime`): 403, no token;
 *   - a spectator on the Pro org's PRIVATE competition: 404; a slug in place of the id: 404;
 *   - the organiser's own cookie on that private competition: admitted (200 no-store, or 503);
 *   - the organiser on a private competition with no division: 403 `no_divisions`;
 *   - NO response header of any answer carries a minted token (counted: zero scanned is a failure).
 * Two orgs of its own (Pro and Community), purged by cleanup(). SMOKE_ONLY=divisionRealtimeDoor runs it alone.
 */
export async function divisionRealtimeDoorSuite(): Promise<void> {
  const EXPECTED_STEPS = 8;
  let steps = 0;
  const step = (label: string, cond: boolean) => {
    check(`division-realtime-door smoke: ${label}`, cond);
    steps++;
  };
  let headerSets = 0, served = 0, unavailable = 0;
  const tokens: string[] = [];
  const leaks: string[] = [];
  const done = () => {
    for (const [what, value] of headerValues) for (const t of tokens) if (value.includes(t)) leaks.push(what);
    console.log(`division-realtime-door smoke: ${steps} steps, ${headerSets} header sets scanned, ${served} served, ${unavailable} unavailable`);
    check(`division-realtime-door smoke: no response header carried a token (${headerSets} header sets scanned; leaks: ${leaks.join(", ")})`, headerSets > 0 && leaks.length === 0);
    check(`division-realtime-door smoke: all ${EXPECTED_STEPS} steps ran (ran ${steps})`, steps === EXPECTED_STEPS);
  };
  const headerValues: Array<[string, string]> = [];
  const anon = newSession();
  const door = async (who: typeof anon, id: string): Promise<V1Res> => {
    const res = await v1(who, `/api/v1/public/competitions/${encodeURIComponent(id)}/realtime-token`);
    headerSets++;
    for (const [name, value] of res.headers) headerValues.push([`${res.status} ${name}`, value]);
    const token = (res.json.data as { token?: unknown } | undefined)?.token;
    if (typeof token === "string") tokens.push(token);
    return res;
  };
  /** An admitted caller's answer: a token for exactly `divisionIds`, or the server's honest "no project here". */
  const admitted = (label: string, res: V1Res, divisionIds: string[], before: number) => {
    if (res.status === 200) {
      served++;
      const d = (res.json.data ?? {}) as Record<string, unknown>;
      step(
        `${label} → 200 {token, divisionIds, expiresAt, url, apikey}, its divisions, epoch seconds within the hour, private no-store (got ${JSON.stringify(Object.keys(d))})`,
        JSON.stringify(Object.keys(d).sort()) === JSON.stringify(["apikey", "divisionIds", "expiresAt", "token", "url"]) &&
          typeof d.token === "string" && d.token.split(".").length === 3 &&
          JSON.stringify(d.divisionIds) === JSON.stringify(divisionIds) &&
          typeof d.expiresAt === "number" && Number.isInteger(d.expiresAt) && d.expiresAt > before && d.expiresAt <= before + 3600 + 30 &&
          typeof d.url === "string" && /^https:\/\/[^\s/?#@]+/.test(d.url) &&
          res.headers.get("cache-control") === "private, no-store",
      );
    } else {
      unavailable++;
      step(
        `${label} on a server with no Supabase project → 503 REALTIME_UNAVAILABLE and no token (got ${res.status} ${res.json.error?.code})`,
        res.status === 503 && res.json.error?.code === "REALTIME_UNAVAILABLE" && res.json.data === undefined,
      );
    }
  };

  // The Pro org: a public competition with one division, a private one with one, a private one with none.
  const owner = newSession();
  const pro = await signIn(owner, `delivered+divrt_${tag}@resend.dev`);
  await setPlan(pro.org_id, "pro", owner);
  const compOf = async (name: string, visibility: "public" | "private") =>
    v1data<{ id: string; slug: string; visibility: string }>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${name} ${tag}`, visibility }),
    );
  const divisionOf = async (s: typeof owner, compId: string) =>
    v1data<{ id: string }>(
      await v1(s, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name: "Open", sport_key: "generic", variant_key: "score", config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
  const open = await compOf("Div realtime public", "public");
  const openDiv = await divisionOf(owner, open.id);
  const hidden = await compOf("Div realtime private", "private");
  const hiddenDiv = await divisionOf(owner, hidden.id);
  const empty = await compOf("Div realtime empty", "private");
  step(
    `setup: a public and two private competitions, two divisions (got ${open.visibility}/${hidden.visibility}/${empty.visibility})`,
    open.visibility === "public" && hidden.visibility === "private" && empty.visibility === "private" && !!openDiv?.id && !!hiddenDiv?.id,
  );
  if (!openDiv?.id || !hiddenDiv?.id) return done();

  // 1. A SPECTATOR on the Pro org's public competition.
  let before = Math.floor(Date.now() / 1000);
  admitted("a spectator on a public competition of a Pro org", await door(anon, open.id), [openDiv.id], before);

  // 2-3. A SPECTATOR on the private competition, and a slug in place of the id.
  const priv = await door(anon, hidden.id);
  step(`a spectator on a private competition → 404, no token (got ${priv.status})`, priv.status === 404 && priv.json.data === undefined);
  const slug = await door(anon, open.slug);
  step(`a slug in place of the id → 404, never a 500 (got ${slug.status})`, slug.status === 404 && slug.json.data === undefined);

  // 4. THE ORGANISER on the private competition: the official path.
  before = Math.floor(Date.now() / 1000);
  admitted("the organiser on a private competition", await door(owner, hidden.id), [hiddenDiv.id], before);

  // 5. THE ORGANISER on a competition with no division: never a token that reads nothing.
  const none = await door(owner, empty.id);
  step(`a competition with no division → 403 no_divisions (got ${none.status} ${none.json.error?.code})`, none.status === 403 && none.json.error?.code === "no_divisions");

  // 6. A SPECTATOR on a Community org's public competition: no `realtime`, so the page polls.
  const other = newSession();
  await signIn(other, `delivered+divrtcommunity_${tag}@resend.dev`);
  const free = v1data<{ id: string; visibility: string }>(
    await v1(other, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Div realtime community ${tag}`, visibility: "public" }),
  );
  const freeDiv = await divisionOf(other, free.id);
  const refused = await door(anon, free.id);
  step(
    `a spectator on a public competition of a Community org → 403, no token (got ${refused.status}; visibility ${free.visibility}, division ${!!freeDiv?.id})`,
    free.visibility === "public" && !!freeDiv?.id && refused.status === 403 && refused.json.data === undefined,
  );
  step(`every admitted answer was a 200 or the honest 503 (served ${served}, unavailable ${unavailable})`, served + unavailable === 2);
  done();
}
