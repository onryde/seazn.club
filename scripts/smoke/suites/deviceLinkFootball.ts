// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * S2-5 football Remote Scoring, the web half (plan W, design §10), over real HTTP: what the phone's football pad reads off
 * the device-link bootstrap. An organiser seeds a started 11-a-side league of two teams with squad numbers, puts the home
 * side's team sheet (one bench row, one numberless row), mints a device link, and the phone — a bare HTTP client with the
 * link's Bearer dl_ and no cookie — reads `GET /api/v1/device-link`. Every expected value is a literal this suite put.
 *
 * Checks 1–5 are Task 1's (the lineup rows carry slot, position, order, role(s) and shirt number); 6–7 are Task 2's (the
 * events door answers a `Date` header the pad samples its server-time offset from). EXPECTED_CHECKS counts all seven, so a
 * run that executed fewer cannot pass.
 * Its own fresh org, purged by cleanup(). SMOKE_ONLY=deviceLinkFootball runs it alone.
 */
const EXPECTED_CHECKS = 7;

type Row = {
  person_id: string;
  pair_order: number | null;
  slot: string;
  position_key: string | null;
  order_no: number | null;
  role: string | null;
  roles: string[];
  squad_number: number | null;
};
type Side = { entrant_id: string; lineup: Row[] } | null;

export async function deviceLinkFootballSuite(): Promise<void> {
  let checks = 0;
  const step = (label: string, cond: boolean) => {
    check(`device-link football: ${label}`, cond);
    checks++;
  };
  const done = () => check(`device-link football: all ${EXPECTED_CHECKS} checks ran (ran ${checks})`, checks === EXPECTED_CHECKS);

  const owner = newSession();
  await signIn(owner, `delivered+dlfootball_${tag}@resend.dev`);
  const comp = v1data<{ id: string } | undefined>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `DL Football ${tag}`, visibility: "private" }),
  );
  const div = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/competitions/${comp?.id ?? ""}/divisions`, "POST", {
      name: "DL Football",
      sport_key: "football",
      variant_key: "11-a-side",
    }),
  );
  const names = { keeper: `DLF Keeper ${tag}`, striker: `DLF Striker ${tag}`, sub: `DLF Sub ${tag}`, plain: `DLF Plain ${tag}`, away: `DLF Away ${tag}` };
  const ids: Record<string, string> = {};
  for (const [key, full_name] of Object.entries(names)) {
    ids[key] = v1data<{ id: string } | undefined>(
      await v1(owner, "/api/v1/persons", "POST", { full_name, consent: { public_name: true } }),
    )?.id ?? "";
  }
  const ents = v1data<{ id: string }[] | undefined>(
    await v1(owner, `/api/v1/divisions/${div?.id ?? ""}/entrants`, "POST", [
      {
        kind: "team",
        display_name: `DLF Home ${tag}`,
        seed: 1,
        members: [
          { person_id: ids.keeper, squad_number: 1 },
          { person_id: ids.striker, squad_number: 9 },
          { person_id: ids.sub, squad_number: 16 },
          { person_id: ids.plain }, // no shirt number
        ],
      },
      { kind: "team", display_name: `DLF Away ${tag}`, seed: 2, members: [{ person_id: ids.away, squad_number: 5 }] },
    ]),
  ) ?? [];
  const stage = v1data<{ id: string } | undefined>(
    await v1(owner, `/api/v1/divisions/${div?.id ?? ""}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
  );
  const gen = v1data<{ fixtures: { id: string }[] } | undefined>(await v1(owner, `/api/v1/stages/${stage?.id ?? ""}/generate`, "POST"));
  await v1(owner, `/api/v1/divisions/${div?.id ?? ""}/start`, "POST");
  const fixtureId = gen?.fixtures?.[0]?.id ?? "";
  const fixture = v1data<{ home_entrant_id: string; away_entrant_id: string } | undefined>(await v1(owner, `/api/v1/fixtures/${fixtureId}`));
  // The draw decides the seats: the sheet goes on whichever seat the home team (the one with the sheet's people) holds.
  const sheetEntrant = ents[0]?.id ?? "";
  const seat: "home" | "away" = fixture?.home_entrant_id === sheetEntrant ? "home" : "away";
  const otherSeat: "home" | "away" = seat === "home" ? "away" : "home";

  const sheet = [
    { person_id: ids.keeper, slot: "starting", position_key: "GK", order_no: 1, roles: ["captain"] },
    { person_id: ids.striker, slot: "starting", position_key: "FW", order_no: 2, roles: [] },
    { person_id: ids.plain, slot: "starting", order_no: 3, roles: [] },
    { person_id: ids.sub, slot: "bench", position_key: "MF", order_no: 4, roles: [] },
  ];
  const put = await v1(owner, `/api/v1/fixtures/${fixtureId}/lineups/${sheetEntrant}`, "PUT", { slots: sheet });
  const link = await v1(owner, `/api/v1/fixtures/${fixtureId}/device-links`, "POST", { label: "Smoke pitch" });
  const secret = v1data<{ secret?: string } | undefined>(link)?.secret ?? "";
  const asPhone = { Authorization: `Bearer ${secret}` };

  // 1. The bootstrap, read by the phone: the link's bearer and no cookie.
  const boot = await v1(newSession(), "/api/v1/device-link", "GET", undefined, asPhone);
  const sides = v1data<{ sides?: Record<"home" | "away", Side> } | undefined>(boot)?.sides;
  step(
    `GET /device-link with the dl_ bearer → 200 (setup: ${ents.length} entrants, fixture ${fixtureId ? "drawn" : "missing"}, lineup PUT ${put.status}, link ${link.status}; got ${boot.status})`,
    boot.status === 200 && ents.length === 2 && fixtureId !== "" && put.status === 200 && link.status === 201 && secret.startsWith("dl_"),
  );
  const lineup = sides?.[seat]?.lineup ?? [];
  const byPerson = (id: string) => lineup.find((l) => l.person_id === id);

  // 2. The sheet's side carries the rows put, in order_no order.
  step(
    `the sheet's side carries the four rows put, in order (got ${JSON.stringify(lineup.map((l) => l.order_no))})`,
    sides?.[seat]?.entrant_id === sheetEntrant && JSON.stringify(lineup.map((l) => l.person_id)) === JSON.stringify([ids.keeper, ids.striker, ids.plain, ids.sub]),
  );
  // 3. The bench row's six team-sheet fields are what was put.
  const sub = byPerson(ids.sub);
  step(
    `the bench row reads slot bench, position MF, order 4, role player, roles [], shirt 16 (got ${JSON.stringify(sub)})`,
    sub?.slot === "bench" && sub.position_key === "MF" && sub.order_no === 4 && sub.role === "player" && Array.isArray(sub.roles) && sub.roles.length === 0 && sub.squad_number === 16,
  );
  // 4. A member with no shirt number reads null, never 0 or absent.
  const plain = byPerson(ids.plain);
  step(`a numberless row reads squad_number null (got ${JSON.stringify(plain?.squad_number)})`, !!plain && plain.squad_number === null);
  // 5. A side with no sheet is an empty lineup.
  step(`the other side, with no sheet, reads lineup [] (got ${JSON.stringify(sides?.[otherSeat]?.lineup)})`, Array.isArray(sides?.[otherSeat]?.lineup) && sides[otherSeat].lineup.length === 0);

  // 6. Task 2 (ruling 107): the pad samples the server's time from the `Date` header of its /events calls. The phone
  //    starts the match and starts the clock through the link; the clock write is 201 and its answer's Date header
  //    names a time within 60 s of this runner's clock (the same host's, so a header that is missing, unparseable or
  //    from somewhere else entirely reds).
  const viaLink = (expected_seq: number, type: string, payload: unknown) =>
    v1(newSession(), `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq, type, payload }, asPhone);
  const started = await viaLink(0, "core.start", {});
  const clock = await viaLink(1, "football.clock", { running: true, at: { period: "H1", elapsed: 0 } });
  const dateHeader = clock.headers.get("date");
  const serverMs = dateHeader === null ? NaN : Date.parse(dateHeader);
  step(
    `core.start then football.clock through the link → 201, 201, with a Date header within 60 s of the runner (got ${started.status} ${clock.status} ${clock.json.error?.code ?? ""}, Date ${JSON.stringify(dateHeader)})`,
    started.status === 201 && clock.status === 201 && Number.isFinite(serverMs) && Math.abs(serverMs - Date.now()) <= 60_000,
  );
  // 7. The ledger, read back through the link: the clock row is there with a parseable recorded_at.
  const events = await v1(newSession(), `/api/v1/fixtures/${fixtureId}/events?since_seq=0`, "GET", undefined, asPhone);
  const rows = v1data<{ seq: number; type: string; recorded_at: string }[] | undefined>(events) ?? [];
  const clockRow = rows.find((r) => r.type === "football.clock");
  step(
    `GET /events through the link returns the clock row (seq 2) with a parseable recorded_at (got ${events.status}, ${JSON.stringify(clockRow)})`,
    events.status === 200 && clockRow?.seq === 2 && Number.isFinite(Date.parse(clockRow.recorded_at)),
  );

  done();
}
