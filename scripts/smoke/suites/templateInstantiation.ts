// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * P4/D1a: template instantiation through the REAL route — one template end
 * to end (own fresh free session, matching capacityPrecheckSuite's shape:
 * not an entitlement gate in itself), then confirm normal flow continues on
 * the created competition (the SAME division-list route a manually-created
 * competition uses returns the template's declared shape). A second call
 * (americano-night, formats.advanced) proves the free tier is refused
 * through the SAME route, not only in the unit suite.
 */
export async function templateInstantiationSuite(): Promise<void> {
  const free = newSession();
  await signIn(free, `delivered+dtx_template_${tag}@resend.dev`);
  const created = v1data<{
    competitionId: string;
    slug: string;
    divisions: { id: string; stages: { id: string; fixtureCount: number }[] }[];
    templateKey: string;
    templateVersion: number;
  }>(
    await v1(free, "/api/v1/competitions/from-template", "POST", {
      template_key: "slam128",
      name: `DTX Slam ${tag}`,
      ends_on: "2030-12-31",
    }),
  );
  check(
    "template instantiation: slam128 creates one division with one knockout stage, stamped provenance",
    created.templateKey === "slam128" &&
      created.divisions.length === 1 &&
      created.divisions[0].stages.length === 1,
  );

  const divisions = v1data<{ id: string; sport_key: string }[]>(
    await v1(free, `/api/v1/competitions/${created.competitionId}/divisions`, "GET"),
  );
  check(
    "template instantiation: normal flow continues — GET divisions returns the template's tennis division",
    divisions.length === 1 && divisions[0].sport_key === "tennis",
  );

  const gated = await v1(free, "/api/v1/competitions/from-template", "POST", {
    template_key: "americano-night",
    name: `DTX Night ${tag}`,
    ends_on: "2030-12-31",
  });
  check(
    "template instantiation: americano-night is refused 402 PAYMENT_REQUIRED on a free session, through the real route",
    gated.status === 402 &&
      (gated.json.error)?.code === "PAYMENT_REQUIRED",
  );

  // P7/D1b (T5) — multi-stage instantiation: t20-super8 (group -> Super 8 ->
  // knockout) is the catalog's first template with 3 stages, TWO of which
  // carry progression (timing: "setup") in the SAME division. It used to be
  // gated on STAGE COUNT alone (V112: stages.per_division.max 2 on community)
  // and ran on a Pro session. V471 ("all stages are free", owner ruling
  // 2026-10-20) made the count unlimited on every plan, so it now runs on a
  // fresh COMMUNITY session — no setPlan — which is the witness that a free
  // org instantiates a 3-stage template through the real route.
  const t20User = newSession();
  await signIn(t20User, `delivered+dtx_template_t20_${tag}@resend.dev`);

  const t20Created = v1data<{
    competitionId: string;
    slug: string;
    divisions: { id: string; stages: { id: string; fixtureCount: number }[] }[];
    templateKey: string;
    templateVersion: number;
  }>(
    await v1(t20User, "/api/v1/competitions/from-template", "POST", {
      template_key: "t20-super8",
      name: `DTX T20 ${tag}`,
      ends_on: "2030-12-31",
    }),
  );
  check(
    "template instantiation: t20-super8 creates one division with 3 stages, zero fixtures at birth (no format-lock on arrival)",
    t20Created.templateKey === "t20-super8" &&
      t20Created.divisions.length === 1 &&
      t20Created.divisions[0].stages.length === 3 &&
      t20Created.divisions[0].stages.every((s) => s.fixtureCount === 0),
  );
  const t20DivisionId = t20Created.divisions[0].id;

  type SlotLabelWire = { key: string; params: Record<string, unknown> } | null;
  const t20Stages = v1data<{ id: string; kind: string; name: string; seq: number }[]>(
    await v1(t20User, `/api/v1/divisions/${t20DivisionId}/stages`, "GET"),
  );
  check(
    "template instantiation: t20-super8's 3 stages are Group Stage -> Super 8 (a group-kind mid-stage) -> Knockout, in seq order",
    t20Stages.length === 3 &&
      t20Stages.filter((s) => s.name === "Super 8" && s.kind === "group").length === 1 &&
      t20Stages.filter((s) => s.name === "Knockout" && s.kind === "knockout").length === 1 &&
      [...t20Stages].sort((a, b) => a.seq - b.seq).map((s) => s.name).join(" -> ") ===
        "Group Stage -> Super 8 -> Knockout",
  );
  const t20GroupStageId = t20Stages.find((s) => s.name === "Group Stage")!.id;
  const t20SuperStageId = t20Stages.find((s) => s.name === "Super 8")!.id;

  const t20TeamNames = Array.from({ length: 16 }, (_, i) => `T20 Squad ${i + 1}`);
  await v1(
    t20User,
    `/api/v1/divisions/${t20DivisionId}/entrants`,
    "POST",
    t20TeamNames.map((n, i) => ({ kind: "team", display_name: n, seed: i + 1 })),
  );

  const t20GroupGen = await v1(t20User, `/api/v1/stages/${t20GroupStageId}/generate`, "POST");
  check("template instantiation: t20-super8 group stage generates from real entrants", t20GroupGen.status < 300);

  // The group stage was only just generated, never played — Super 8 (fed by
  // it via progression, timing: "setup") must still generate real fixture
  // ROWS with every slot TBD, exactly like P6/D4a's stageProgressionSuite
  // proved for a knockout final. This is the same mechanism reaching a
  // non-terminal, group-kind stage instead — the actual point of the
  // t20-super8 catalog entry.
  const t20SuperGen = v1data<{
    created: number;
    fixtures: {
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      home_slot_label: SlotLabelWire;
      away_slot_label: SlotLabelWire;
    }[];
  }>(await v1(t20User, `/api/v1/stages/${t20SuperStageId}/generate`, "POST"));
  const seedFamily = new Set(["slot.winner_group", "slot.runner_up_group"]);
  check(
    "template instantiation: Super 8 generates real fixture rows, every slot TBD with a resolved seed-descriptor label (not a real entrant, not a raw string)",
    t20SuperGen.created > 0 &&
      t20SuperGen.fixtures.length === t20SuperGen.created &&
      t20SuperGen.fixtures.every(
        (f) =>
          f.home_entrant_id === null &&
          f.away_entrant_id === null &&
          seedFamily.has(f.home_slot_label?.key ?? "") &&
          seedFamily.has(f.away_slot_label?.key ?? ""),
      ),
  );
}
