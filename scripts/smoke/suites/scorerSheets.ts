// The scorer-sheets checks read a printed PDF's link URIs with the same
// reader the e2e journey uses. Its only import is `node:zlib`, so it loads
// under `--experimental-strip-types` (proven before relying on it).
import { pdfLinkUris } from "../../../apps/web/e2e/pdf-uris.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, newSession, check, tag, v1, v1data, printScorerSheets, orgDayOf } from "../harness.ts";

/**
 * Scorer sheets over the real route (Task 10): a started knockout of four with
 * its three matches timed on one org day. Prints (same-origin 200 PDF, never
 * cached; a foreign Origin refused), one QR per match and the same set on a
 * reprint, and a PRINTED bearer that decides a semi can no longer void it once
 * the final is seated from it. The PDF's link URIs are read with the e2e
 * reader (`pdfLinkUris`), not re-derived.
 */
export async function scorerSheetsSuite(admin: Session): Promise<void> {
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Sheets Cup ${tag}` });
  const compId = v1data<{ id: string }>(comp).id;
  const div = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Sheets",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divId = v1data<{ id: string }>(div).id;
  await v1(
    admin,
    `/api/v1/divisions/${divId}/entrants`,
    "POST",
    ["SA", "SB", "SC", "SD"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await v1(admin, `/api/v1/divisions/${divId}/stages`, "POST", {
    seq: 1,
    kind: "knockout",
    name: "Cup",
    config: {},
  });
  const gen = await v1(admin, `/api/v1/stages/${v1data<{ id: string }>(stage).id}/generate`, "POST");
  const started = await v1(admin, `/api/v1/divisions/${divId}/start`, "POST");
  const drawn = v1data<{ id: string; round_no: number; seq_in_round: number }[]>(
    await v1(admin, `/api/v1/divisions/${divId}/fixtures`),
  ).sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);
  const base = Date.UTC(2026, 9, 3, 10, 0, 0);
  const at = drawn.map((_, i) => new Date(base + i * 30 * 60_000).toISOString());
  const timed: number[] = [];
  for (const [i, f] of drawn.entries()) {
    timed.push((await v1(admin, `/api/v1/fixtures/${f.id}`, "PATCH", { scheduled_at: at[i] })).status);
  }
  const days = await Promise.all(at.map((iso) => orgDayOf(admin, compId, iso)));
  const day = days[0] ?? "";
  check(
    "scorer sheets seed: a started knockout of four, three matches timed on one org day",
    gen.status < 300 &&
      started.status === 200 &&
      drawn.length === 3 &&
      timed.every((s) => s === 200) &&
      days.every((d) => d === day),
  );

  const sameOrigin = new URL(BASE).origin;
  const print = await printScorerSheets(admin, compId, day, sameOrigin);
  const pdf = Buffer.from(await print.arrayBuffer());
  check(
    "scorer sheets print: 200, application/pdf, %PDF- bytes, Cache-Control private, no-store",
    print.status === 200 &&
      (print.headers.get("content-type") ?? "").startsWith("application/pdf") &&
      pdf.subarray(0, 5).toString("latin1") === "%PDF-" &&
      print.headers.get("cache-control") === "private, no-store",
  );
  const foreign = await printScorerSheets(admin, compId, day, "https://evil.example");
  check("scorer sheets print: a foreign Origin is refused (403, proxy.ts CSRF)", foreign.status === 403);

  const uris = pdfLinkUris(pdf);
  check(
    `scorer sheets: one QR per match scheduled that day (${uris.length} of ${drawn.length})`,
    uris.length === drawn.length && new Set(uris).size === uris.length,
  );
  const again = pdfLinkUris(Buffer.from(await (await printScorerSheets(admin, compId, day, sameOrigin)).arrayBuffer()));
  check(
    "scorer sheets: a reprint carries the same QR set",
    JSON.stringify([...again].sort()) === JSON.stringify([...uris].sort()),
  );

  // A semi's printed bearer: the one PDF link whose token opens the semi.
  const semi = drawn.find((f) => f.round_no === 1);
  const final = drawn.find((f) => f.round_no === 2);
  const bare = newSession(); // no cookies — the printed token is the credential
  const opens: { token: string; seq: number }[] = [];
  for (const u of uris) {
    const token = new URL(u).pathname.replace(/^\/score\//, "");
    const st = await v1(bare, `/api/v1/fixtures/${semi?.id}/state`, "GET", undefined, {
      Authorization: `Bearer ${token}`,
    });
    if (st.status === 200) opens.push({ token, seq: v1data<{ last_seq: number }>(st).last_seq });
  }
  const printed = opens[0];
  check("scorer sheets: exactly one printed QR opens the semi", opens.length === 1);
  const bearer = { Authorization: `Bearer ${printed?.token ?? ""}` };
  const decided = await v1(
    bare,
    `/api/v1/fixtures/${semi?.id}/events`,
    "POST",
    { expected_seq: printed?.seq ?? 0, type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
    bearer,
  );
  const result = v1data<{ id: string; seq: number } | undefined>(decided);
  const finalRow = v1data<{ home_entrant_id: string | null; away_entrant_id: string | null }>(
    await v1(admin, `/api/v1/fixtures/${final?.id}`),
  );
  check(
    "scorer sheets: the printed bearer decides its semi, seating the final",
    decided.status === 201 && (finalRow.home_entrant_id !== null || finalRow.away_entrant_id !== null),
  );
  const before = v1data<unknown[]>(await v1(admin, `/api/v1/fixtures/${semi?.id}/events?since_seq=0`)).length;
  const voided = await v1(
    bare,
    `/api/v1/fixtures/${semi?.id}/events`,
    "POST",
    { expected_seq: result?.seq ?? 0, type: "core.void", payload: { event_id: result?.id } },
    bearer,
  );
  const after = v1data<unknown[]>(await v1(admin, `/api/v1/fixtures/${semi?.id}/events?since_seq=0`)).length;
  check(
    "scorer sheets: the printed bearer cannot void a carried-forward semi (403 RESULT_CARRIED_FORWARD, nothing written)",
    voided.status === 403 && voided.json.error?.code === "RESULT_CARRIED_FORWARD" && after === before,
  );
}
