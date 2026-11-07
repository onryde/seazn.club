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

/** Record a generic result on one fixture through the scoring API (optimistic concurrency on `last_seq`). */
async function scoreGeneric(owner: Session, fixtureId: string, p1Score: number, p2Score: number): Promise<number> {
  const state = v1data<{ last_seq: number } | undefined>(await v1(owner, `/api/v1/fixtures/${fixtureId}/state`));
  const res = await v1(owner, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state?.last_seq ?? 0,
    type: "generic.result",
    payload: { p1Score, p2Score },
  });
  return res.status;
}

/** How many times `attr="value"` appears in the markup — anchored on `="`, never a bare word the dictionary also holds. */
const countAttr = (body: string, attr: string, value: string) => body.split(`${attr}="${value}"`).length - 1;

/**
 * W4 T21 (AN-1, X-CH-8; owner pick R24 4A): a knockout played out with auto-advance off leaves its stage open. The
 * desk raises ONE red "Final decided" row for it; completing the competition is never refused, and the settings page
 * of a competition saved as completed lists the open stage with its Complete stage; completing the stage takes both
 * away. Every read is anchored on markup (`data-*="…"`), never on a word the serialised dictionary also carries.
 */
export async function w4aDeskXch8Check(): Promise<void> {
  const { owner, orgSlug } = await organiser("w4adeskxch8");
  const k = await startedKnockout(owner, "W4A XCH8", 4);
  const semis = k.drawn.filter((f) => f.home_entrant_id && f.away_entrant_id);
  check(
    `w4a desk X-CH-8: a started knockout of four — ${k.drawn.length} fixture(s) read, ${semis.length} seated semi-final(s)`,
    k.ok && orgSlug !== "" && semis.length === 2,
  );
  if (semis.length !== 2) return;
  const semiScores = [];
  for (const sf of semis) semiScores.push(await scoreGeneric(owner, sf.id, 3, 1));
  const final = (await k.fixtures()).find((f) => !semis.some((s) => s.id === f.id));
  const finalScore = final?.home_entrant_id && final.away_entrant_id ? await scoreGeneric(owner, final.id, 3, 1) : 0;
  const played = await k.fixtures();
  const stageStatus = async () => v1data<{ status: string } | undefined>(await v1(owner, `/api/v1/stages/${k.stageId}`))?.status;
  const before = await stageStatus();
  check(
    `w4a desk X-CH-8: the bracket is played out (results ${[...semiScores, finalScore].join(", ")}; ${played.length} fixture(s), ` +
      `${played.filter((f) => f.status === "decided").length} decided) and its stage stays ${before}`,
    played.length === 3 && played.every((f) => f.status === "decided") && before === "active",
  );

  const deskPath = `/o/${orgSlug}/c/${k.compSlug}`;
  const desk = await html(owner, deskPath);
  const rows = countAttr(desk.body, "data-attention", "final_decided");
  check(`w4a desk X-CH-8: the desk (${desk.status}) raises ONE "Final decided" row — ${rows} read`, desk.status === 200 && rows === 1);

  const patched = await v1(owner, `/api/v1/competitions/${k.compId}`, "PATCH", { status: "completed" });
  check(`w4a desk X-CH-8: completing the competition is never refused (${patched.status})`, patched.status === 200);

  const settingsPath = `${deskPath}/settings`;
  const settings = await html(owner, settingsPath);
  const listed = [...settings.body.matchAll(/data-open-stage="([^"]+)"/g)].map((m) => m[1]);
  check(
    `w4a desk X-CH-8: settings (${settings.status}) of the completed competition warns — ${listed.length} open stage(s) listed, ` +
      `the stage's state ${countAttr(settings.body, "data-state", "final_decided") === 1 ? "final_decided" : "missing"}, Complete stage offered ` +
      `${countAttr(settings.body, "data-complete-stage", k.stageId)}x`,
    settings.status === 200 &&
      countAttr(settings.body, "data-testid", "compset-open-stages") === 1 &&
      listed.length === 1 &&
      listed[0] === k.stageId &&
      countAttr(settings.body, "data-state", "final_decided") === 1 &&
      countAttr(settings.body, "data-complete-stage", k.stageId) === 1,
  );

  const completed = await v1(owner, `/api/v1/stages/${k.stageId}/complete`, "POST", {});
  const after = await stageStatus();
  const settingsAfter = await html(owner, settingsPath);
  const deskAfter = await html(owner, deskPath);
  check(
    `w4a desk X-CH-8: Complete stage (${completed.status}) completes it (${after}); the warning and the desk row are gone`,
    completed.status < 300 &&
      after === "complete" &&
      settingsAfter.status === 200 &&
      countAttr(settingsAfter.body, "data-testid", "compset-open-stages") === 0 &&
      deskAfter.status === 200 &&
      countAttr(deskAfter.body, "data-attention", "final_decided") === 0,
  );
}
