import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, check, tag, v1, v1data } from "../harness.ts";

/** design/v6 PROMPT-48..50: the three new sports over real HTTP — a tennis
 *  set scored point-by-point (rally mode), an icehockey OT result paying
 *  2/1 through standings, and a power-play goal with the strength chip
 *  visible on the anonymous public fixture read. */
export async function v6SportsSuite(admin: Session): Promise<void> {
  // Local-run fallback: CI runs sync:sports; a local DB may predate v6.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const db = postgres(dbUrl, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl:
        process.env.DATABASE_SSL === "disable"
          ? false
          : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
            ? false
            : "require",
      prepare: !dbUrl.includes(":6543"),
      max: 1,
    });
    const empty = { groups: [], lineup: { size: 1, benchMax: 1 } };
    for (const [key, name] of [
      ["tennis", "Tennis"],
      ["icehockey", "Ice Hockey"],
    ] as const) {
      await db`insert into sports (key, name, module_version, position_catalog)
               values (${key}, ${name}, '1.0.0', ${db.json(empty)})
               on conflict (key) do nothing`;
    }
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('tennis', 'tour', 'Tour', ${db.json({})}, true)
             on conflict do nothing`;
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('icehockey', 'iihf', 'IIHF', ${db.json({})}, true)
             on conflict do nothing`;
    await db.end();
  }

  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `V6 Sports ${tag}`,
    visibility: "public",
  });
  check("v6 competition created", comp.status === 201);
  const compId = v1data<{ id: string }>(comp).id;

  // --- Tennis (PROMPT-48): one set scored rally-mode, then a summary set ---
  const tdiv = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Tennis",
    sport_key: "tennis",
    variant_key: "tour",
  });
  check("v6 tennis division created from catalog", tdiv.status === 201);
  const tdivId = v1data<{ id: string }>(tdiv).id;
  const tents = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${tdivId}/entrants`, "POST", [
      { kind: "individual", display_name: "Rune", seed: 1 },
      { kind: "individual", display_name: "Sasha", seed: 2 },
    ]),
  );
  const tstage = await v1(admin, `/api/v1/divisions/${tdivId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const tgen = await v1(
    admin,
    `/api/v1/stages/${v1data<{ id: string }>(tstage).id}/generate`,
    "POST",
  );
  const tfx = v1data<{ fixtures: { id: string }[] }>(tgen).fixtures[0].id;
  await v1(admin, `/api/v1/divisions/${tdivId}/start`, "POST");
  let seq = v1data<{ seq: number }>(
    await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    }),
  ).seq;
  // 24 straight points = a 6–0 set in rally mode.
  for (let i = 0; i < 24; i++) {
    seq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
        expected_seq: seq,
        type: "tennis.point",
        payload: { by: tents[0].id },
      }),
    ).seq;
  }
  const midState = await v1(admin, `/api/v1/fixtures/${tfx}/state`);
  const midHeadline = v1data<{ summary: { headline: string } }>(midState).summary.headline;
  check("v6 tennis rally set banked (1 — 0 · 6–0)", midHeadline.startsWith("1 — 0"));
  // Undo the last point and re-score it — the fold reopens cleanly.
  const events = await v1(admin, `/api/v1/fixtures/${tfx}/events`);
  const lastPoint = v1data<{ id: string; type: string; seq: number }[]>(events)
    .filter((e) => e.type === "tennis.point")
    .sort((a, b) => b.seq - a.seq)[0];
  if (lastPoint) {
    seq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
        expected_seq: seq,
        type: "core.void",
        payload: { event_id: lastPoint.id },
      }),
    ).seq;
    const reopened = await v1(admin, `/api/v1/fixtures/${tfx}/state`);
    check(
      "v6 tennis undo restores the live point",
      v1data<{ summary: { headline: string } }>(reopened).summary.headline.startsWith("0 — 0"),
    );
    seq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
        expected_seq: seq,
        type: "tennis.point",
        payload: { by: tents[0].id },
      }),
    ).seq;
  }
  // Second set as a tier-0 summary; the match decides.
  seq = v1data<{ seq: number }>(
    await v1(admin, `/api/v1/fixtures/${tfx}/events`, "POST", {
      expected_seq: seq,
      type: "tennis.set_summary",
      payload: { home: 6, away: 0 },
    }),
  ).seq;
  const tdone = await v1(admin, `/api/v1/fixtures/${tfx}/state`);
  check(
    "v6 tennis match decided from mixed fidelity",
    v1data<{ status: string }>(tdone).status === "decided",
  );

  // --- Ice hockey (PROMPT-49/50): OT points + PP goal + strength chip ---
  const idiv = await v1(admin, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Ice",
    sport_key: "icehockey",
    variant_key: "iihf",
  });
  check("v6 icehockey division created from catalog", idiv.status === 201);
  const idivId = v1data<{ id: string }>(idiv).id;
  const ients = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${idivId}/entrants`, "POST", [
      { kind: "team", display_name: "Polar Bears", seed: 1 },
      { kind: "team", display_name: "Glacier Kings", seed: 2 },
    ]),
  );
  const istage = await v1(admin, `/api/v1/divisions/${idivId}/stages`, "POST", {
    seq: 1,
    kind: "league",
    name: "League",
  });
  const istageId = v1data<{ id: string }>(istage).id;
  const igen = await v1(admin, `/api/v1/stages/${istageId}/generate`, "POST");
  const ifx = v1data<{ fixtures: { id: string }[] }>(igen).fixtures[0].id;
  await v1(admin, `/api/v1/divisions/${idivId}/start`, "POST");
  const iceSend = async (type: string, payload: unknown) => {
    iceSeq = v1data<{ seq: number }>(
      await v1(admin, `/api/v1/fixtures/${ifx}/events`, "POST", {
        expected_seq: iceSeq,
        type,
        payload,
      }),
    ).seq;
  };
  let iceSeq = 0;
  await iceSend("core.start", {});
  // Power play: minor on the Kings → 5v4 chip visible to an anonymous
  // public read (PROMPT-50 free path), PP goal, scorer releases the minor.
  await iceSend("icehockey.suspension.start", {
    by: ients[1].id,
    class: "minor",
  });
  const anon = newSession();
  const pub = await v1(anon, `/api/v1/public/fixtures/${ifx}`);
  const pubDetail = v1data<{ summary: { detail?: { strength?: string } } }>(pub).summary.detail;
  check("v6 public scorebug carries the 5v4 strength chip", pubDetail?.strength === "5v4");
  await iceSend("icehockey.goal", { by: ients[0].id, kind: "pp" });
  await iceSend("icehockey.suspension.end", {
    by: ients[1].id,
    class: "minor",
  });
  // Level it, run out regulation, win in sudden-death OT.
  await iceSend("icehockey.goal", { by: ients[1].id });
  await iceSend("icehockey.period.advance", { to: "P2" });
  await iceSend("icehockey.period.advance", { to: "P3" });
  await iceSend("icehockey.period.advance", { to: "FT" });
  await iceSend("icehockey.goal", { by: ients[0].id });
  const idone = await v1(admin, `/api/v1/fixtures/${ifx}/state`);
  check(
    "v6 icehockey OT decides with (OT) headline",
    v1data<{ status: string; summary: { headline: string } }>(idone).status === "decided" &&
      v1data<{ summary: { headline: string } }>(idone).summary.headline.includes("(OT)"),
  );
  const istandings = await v1(admin, `/api/v1/stages/${istageId}/standings`);
  const irows = v1data<{ rows: { entrantId: string; points: number }[] }>(istandings).rows;
  check(
    "v6 icehockey standings pay OT points 2/1 (Event Code §219)",
    irows.find((r) => r.entrantId === ients[0].id)?.points === 2 &&
      irows.find((r) => r.entrantId === ients[1].id)?.points === 1,
  );
}
