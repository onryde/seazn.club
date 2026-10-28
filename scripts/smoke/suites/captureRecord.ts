import { randomBytes } from "node:crypto";
import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, newSession, call, check, signIn, tag, timedFixture, v1, v1data, setPlan } from "../harness.ts";

/**
 * Capture record upload over real HTTP (spec 2026-10-12-capture-record-upload-design.md §13.2, case `capture-record`):
 * the organiser mints a stream code, and a phone — a bare HTTP client with the QR's Bearer tok and no cookie, as Seazn
 * Capture is — sends its Send record as NDJSON: its OWN pairing window (its `pair` line, under this tok's tag, and a
 * device line inside it), ANOTHER code's `pair` line (a window of a code that is not this one) and a BAD line (a key off
 * capture's allow-list). §6 drops the foreign line and owner ruling RL (2026-10-12) drops the bad one without refusing
 * the body: 201 `{ref, kept: 2, dropped: 2}` — the closed 201, values typed from the record's construction. SQL then reads
 * the stored row: received 4, kept 2, dropped 2, invalid 1, and neither dropped line's distinctive value is stored.
 * Then the body-level refusals: a wrong tok is 401, 1001 lines are 413 `too_large`, an empty body is 422 `invalid`.
 * And proxy.ts leaves the records path out of its matcher (review fix 5): a foreign Origin reaches the route there, and
 * is proxy's 403 on the code's beats.
 * EVERY phone answer is `Cache-Control: private, no-store` — counted, and zero counted is a failure. Five records'
 * worth of calls, well inside the 10-an-hour records budget (§8). Its own Pro org, purged by cleanup().
 * SMOKE_ONLY=captureRecord runs it alone (SELECTABLE_SUITES).
 */
export async function captureRecordSuite(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP  capture-record suite (DATABASE_URL not set — the plan change and the stored row need SQL)");
    return;
  }
  const EXPECTED_STEPS = 8;
  let steps = 0;
  const step = (label: string, cond: boolean) => {
    check(`capture-record smoke: ${label}`, cond);
    steps++;
  };
  const done = () => {
    console.log(`capture-record smoke: ${steps} steps, ${phoneAnswers} phone answers`);
    check(`capture-record smoke: all ${EXPECTED_STEPS} steps ran (ran ${steps})`, steps === EXPECTED_STEPS);
  };
  let phoneAnswers = 0;
  const notPrivate: string[] = [];

  const owner = newSession();
  await signIn(owner, `delivered+caprecord_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string }[];
  await setPlan(orgs[0].id, "pro", owner);
  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Capture record ${tag}`, visibility: "private" }),
  );
  const fx = await timedFixture(owner, comp.id, {
    name: "Capture record",
    sport_key: "hockey",
    variant_key: "fih-outdoor",
    entrants: [
      { kind: "team", display_name: `Record Home ${tag}`, seed: 1 },
      { kind: "team", display_name: `Record Away ${tag}`, seed: 2 },
    ],
  });

  // 1. MINT — the organiser's stream code: the v2 QR's code and tok are all the phone holds.
  const minted = await v1(owner, `/api/v1/fixtures/${fx.fixtureId}/stream-code`, "POST");
  const qr = (minted.json.data as { qr?: { code: string; tok: string } } | undefined)?.qr;
  step(`POST stream-code → 200 with a code and a tok (got ${minted.status})`, minted.status === 200 && !!qr?.code && !!qr?.tok);
  if (!qr) return done();

  // §0.1: capture's pair-line tag — FNV-1a 32 over the token's UTF-16 code units, 8 lowercase hex (Q8, final). Typed
  // here from capture's rule, never imported from the server's own implementation.
  const fnv1a32 = (s: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, "0");
  };
  const send = async (tok: string, body: string): Promise<{ status: number; json: Record<string, unknown> | null }> => {
    const res = await fetch(`${BASE}/api/v1/capture/codes/${qr.code}/records`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/x-ndjson" },
      body,
    });
    phoneAnswers++;
    const cache = res.headers.get("cache-control");
    if (cache !== "private, no-store") notPrivate.push(`${res.status} ${String(cache)}`);
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };

  // 2. THE RECORD — own window (pair + a device line), another code's pair, a bad line.
  const at = new Date().toISOString();
  const foreign = `foreign-${tag}`;
  const bad = `badline-${tag}`;
  const lines = [
    { at, kind: "pair", claim: "new", slot: 0, tokenTag: fnv1a32(qr.tok) },
    { at, kind: "thermal", status: 2 },
    { at, kind: "pair", claim: "new", slot: 0, tokenTag: fnv1a32(`${qr.tok}-${foreign}`), message: foreign },
    { at, kind: "thermal", battery: 1, message: bad },
  ];
  const sent = await send(qr.tok, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const ref = typeof sent.json?.ref === "string" ? sent.json.ref : null;
  step(
    `a 4-line record (own pair, own device line, a foreign pair, a bad line) → 201 exactly {ref, kept: 2, dropped: 2} (got ${sent.status} ${JSON.stringify(sent.json)})`,
    sent.status === 201 &&
      JSON.stringify(Object.keys(sent.json ?? {}).sort()) === JSON.stringify(["dropped", "kept", "ref"]) &&
      sent.json?.kept === 2 && sent.json?.dropped === 2 && !!ref,
  );

  // 3. The stored row: ruling RL's bad-line count beside the drops, and no dropped value stored.
  {
    const url = process.env.DATABASE_URL;   // the suite's first line returns without it
    const sql = postgres(url, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : "require",
      prepare: !url.includes(":6543"),
      max: 1,
    });
    try {
      const rows = await sql<{ received_lines: number; kept_lines: number; dropped_lines: number; invalid_lines: number; lines: string }[]>`
        select received_lines, kept_lines, dropped_lines, invalid_lines, lines from capture_records where ref = ${ref ?? ""}`;
      const row = rows[0];
      step(
        `the stored record: received 4, kept 2, dropped 2, invalid 1; neither dropped value stored (got ${JSON.stringify(row ? { ...row, lines: row.lines.length } : null)})`,
        rows.length === 1 && !!row &&
          row.received_lines === 4 && row.kept_lines === 2 && row.dropped_lines === 2 && row.invalid_lines === 1 &&
          !row.lines.includes(foreign) && !row.lines.includes(bad) && row.lines.includes(fnv1a32(qr.tok)),
      );
    } finally {
      await sql.end();
    }
  }

  // 4–6. The body-level refusals: a wrong tok, the line limit, an empty body.
  const wrong = await send(randomBytes(16).toString("base64url"), `${JSON.stringify(lines[1])}\n`);
  step(`a wrong tok → 401 code_ended (got ${wrong.status} ${String(wrong.json?.code)})`, wrong.status === 401 && wrong.json?.code === "code_ended");
  const over = await send(qr.tok, `${Array.from({ length: 1001 }, () => JSON.stringify(lines[1])).join("\n")}\n`);
  step(`1001 lines → 413 too_large (got ${over.status} ${String(over.json?.code)})`, over.status === 413 && over.json?.code === "too_large");
  const empty = await send(qr.tok, "");
  step(`an empty body → 422 invalid (got ${empty.status} ${String(empty.json?.code)})`, empty.status === 422 && empty.json?.code === "invalid");

  // Review fix 5 (PR #943): proxy.ts's matcher leaves the records path out (no 10 MB body buffer ahead of the route's
  // own cap and auth). Seen on the real build through proxy's one /api behaviour, the CSRF Origin check: a foreign
  // Origin on a records POST reaches the ROUTE (its 401 for a wrong tok, the capture envelope), while the same Origin on
  // the code's beats — still under proxy — is proxy's 403 Forbidden (the positive pair: proxy runs there).
  const foreignOrigin = { Origin: "https://evil.example", Authorization: `Bearer ${randomBytes(16).toString("base64url")}` };
  const viaRecords = await fetch(`${BASE}/api/v1/capture/codes/${qr.code}/records`, {
    method: "POST", headers: { ...foreignOrigin, "Content-Type": "application/x-ndjson" }, body: `${JSON.stringify(lines[1])}\n`,
  });
  const viaBeats = await fetch(`${BASE}/api/v1/capture/codes/${qr.code}/beats`, {
    method: "POST", headers: { ...foreignOrigin, "Content-Type": "application/json" }, body: "{}",
  });
  const recordsBody = (await viaRecords.json().catch(() => null)) as { code?: string } | null;
  const beatsBody = (await viaBeats.json().catch(() => null)) as { error?: string } | null;
  step(
    `proxy skips the records path, not its siblings: a foreign Origin → records ${viaRecords.status} ${String(recordsBody?.code)} (the route's 401), beats ${viaBeats.status} ${String(beatsBody?.error)} (proxy's 403)`,
    viaRecords.status === 401 && recordsBody?.code === "code_ended" && viaBeats.status === 403 && beatsBody?.error === "Forbidden",
  );

  // 7. Every phone answer above was private, no-store — and there were answers to judge.
  step(
    `every phone answer (${phoneAnswers}) is Cache-Control: private, no-store${notPrivate.length ? ` — not: ${notPrivate.join("; ")}` : ""}`,
    phoneAnswers === 4 && notPrivate.length === 0,
  );
  done();
}
