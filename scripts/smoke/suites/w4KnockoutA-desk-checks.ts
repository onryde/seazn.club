import { readFileSync } from "node:fs";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, v1data, type Session } from "../harness.ts";

/**
 * Format matrix W4 app PR A, lane B-desk (Tasks 18 + 21): the smoke checks this lane owes, written as exported functions
 * and deliberately NOT wired into a suite here — the lane that owns `scripts/smoke/index.ts` / the W4 suite calls them
 * (controller ruling: lane B-desk never touches the harness, index or main). Each function signs in its own organiser,
 * builds its own competition, and moves the shared pass/fail counters only through `check`. Every list read states its
 * count, and a zero count fails.
 */

const uiEn = JSON.parse(
  readFileSync(new URL("../../../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8"),
) as Record<string, string>;

const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

type DeskFixture = {
  id: string;
  fixture_no: number | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind: string; winner?: string; loser?: string | null; reason?: string } | null;
};

/** The text that opens each Activity row's caption in a server-rendered console (`data-role="v3-activity-caption"`). */
function activityCaptions(body: string): string[] {
  return [...body.matchAll(/data-role="v3-activity-caption"[^>]*>([^<]*)/g)].map((m) => (m[1] ?? "").trim());
}

/** A fresh organiser and its org slug. */
async function organiser(label: string): Promise<{ owner: Session; orgSlug: string }> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+${label}_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  return { owner, orgSlug: orgs.find((o) => o.id === who.org_id)?.slug ?? "" };
}

/** One private competition with one generic division holding `size` entrants in a generated, started knockout. */
async function startedKnockout(owner: Session, label: string, size: number) {
  const comp = await v1(owner, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `${label} ${tag}`,
    visibility: "private",
  });
  const compRow = v1data<{ id: string; slug: string } | undefined>(comp);
  const div = await v1(owner, `/api/v1/competitions/${compRow?.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const divRow = v1data<{ id: string; slug: string } | undefined>(div);
  const names = Array.from({ length: size }, (_, i) => `${label} S${i + 1} ${tag}`);
  const entrants = await v1(
    owner,
    `/api/v1/divisions/${divRow?.id}/entrants`,
    "POST",
    names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })),
  );
  const ids = (v1data<{ id: string }[] | undefined>(entrants) ?? []).map((e) => e.id);
  const stage = await v1(owner, `/api/v1/divisions/${divRow?.id}/stages`, "POST", { seq: 1, kind: "knockout", name: "Cup" });
  const stageRow = v1data<{ id: string } | undefined>(stage);
  const generated = await v1(owner, `/api/v1/stages/${stageRow?.id}/generate`, "POST");
  const started = await v1(owner, `/api/v1/divisions/${divRow?.id}/start`, "POST");
  const fixtures = async () =>
    v1data<DeskFixture[] | undefined>(await v1(owner, `/api/v1/divisions/${divRow?.id}/fixtures`)) ?? [];
  const drawn = await fixtures();
  const ok =
    comp.status === 201 &&
    div.status === 201 &&
    ids.length === size &&
    stage.status < 300 &&
    generated.status < 300 &&
    started.status < 300 &&
    drawn.length === size - 1;
  return {
    ok,
    compId: compRow?.id ?? "",
    compSlug: compRow?.slug ?? "",
    divisionId: divRow?.id ?? "",
    divSlug: divRow?.slug ?? "",
    stageId: stageRow?.id ?? "",
    drawn,
    fixtures,
  };
}

/**
 * W4 T18 (K12): a disqualification walkover is worded as a disqualification. A started generic knockout of four: one
 * semi-final's away side is DISQUALIFIED (the cascade walks the semi), the other semi's away side WITHDRAWS. Both semis
 * are walked with the same stored award — reason `withdrew`, the engine's credit (controller ruling C12: never a stored
 * `disqualified`) — and the organiser console of each says what happened: "Disqualification recorded" for the first,
 * "Withdrawal recorded" for the second, and never the other's words. The words are read from the en catalog.
 */
export async function w4aDeskK12Check(): Promise<void> {
  const DQ = uiEn["pad.ribbon.core.forfeit.disqualified"] ?? "";
  const WD = uiEn["pad.ribbon.core.forfeit.withdrew"] ?? "";
  const { owner, orgSlug } = await organiser("w4adeskk12");
  const k = await startedKnockout(owner, "W4A K12", 4);
  const semis = k.drawn.filter((f) => f.home_entrant_id && f.away_entrant_id);
  check(
    `w4a desk K12: a started knockout of four — ${k.drawn.length} fixture(s) read, ${semis.length} seated semi-final(s)`,
    k.ok && orgSlug !== "" && semis.length === 2 && DQ !== "" && WD !== "",
  );
  const [sfA, sfB] = semis;
  if (!sfA || !sfB) return;
  const dqLoser = sfA.away_entrant_id ?? "";
  const wdLoser = sfB.away_entrant_id ?? "";
  const dq = await v1(owner, `/api/v1/entrants/${dqLoser}`, "PATCH", { status: "disqualified" });
  const wd = await v1(owner, `/api/v1/entrants/${wdLoser}/withdraw`, "POST", {});
  check(`w4a desk K12: the disqualification (${dq.status}) and the withdrawal (${wd.status}) are accepted`, dq.status === 200 && wd.status < 300);
  const after = await k.fixtures();
  const cases = [
    { label: "disqualification", sf: sfA, loser: dqLoser, says: DQ, never: WD },
    { label: "withdrawal", sf: sfB, loser: wdLoser, says: WD, never: DQ },
  ];
  for (const c of cases) {
    const row = after.find((f) => f.id === c.sf.id);
    check(
      `w4a desk K12 (${c.label}): the semi is walked with the withdrawal's credit — status ${row?.status}, reason ${row?.outcome?.reason}`,
      row?.status === "forfeited" &&
        row.outcome?.kind === "award" &&
        row.outcome.reason === "withdrew" &&
        row.outcome.loser === c.loser &&
        row.outcome.winner === c.sf.home_entrant_id,
    );
    const page = await html(owner, `/o/${orgSlug}/c/${k.compSlug}/d/${k.divSlug}/f/${row?.fixture_no ?? c.sf.fixture_no}`);
    // Read the Activity rows' own captions, anchored on the markup: the page also serialises the whole dictionary, so a
    // bare `body.includes(word)` holds for every forfeit word on every console.
    const captions = activityCaptions(page.body);
    check(
      `w4a desk K12 (${c.label}): the organiser console (${page.status}) — ${captions.length} Activity caption(s) read — says "${c.says}" and never "${c.never}"`,
      page.status === 200 &&
        captions.length > 0 &&
        captions.some((t) => t.startsWith(c.says)) &&
        !captions.some((t) => t.includes(c.never)),
    );
  }
}
