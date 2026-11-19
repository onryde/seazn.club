// W5 app-A Task 23 (X-CU-7, X-CU-8, X-CU-11) - seed a STARTED root league or group through the real API, for the desktop spec and
// the width-project spec both: a generic-sport division, its entrants (seed order), one table stage, generated, started, with one
// line started so the stage is in play. And the AUTOMATIC late arrival the waiting strip exists for: a public registration,
// auto-approved, after Start - the same `materialise` every paid, approved and webhook confirmation runs (a test has no Stripe).
import { expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, competitionPath } from "../helpers";

const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

export interface StartedTable {
  competitionId: string;
  divisionId: string;
  stageId: string;
  ids: string[];
}

export type TableLine = { id: string; round_no: number; pool_id: string | null; ext_key?: string | null; home_entrant_id: string | null; away_entrant_id: string | null; scheduled_at?: string | null };

export async function tableLines(request: APIRequestContext, divisionId: string, stageId: string): Promise<TableLine[]> {
  const all = await apiJson<(TableLine & { stage_id: string })[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(all.status, JSON.stringify(all.error)).toBe(200);
  return (all.data ?? []).filter((f) => f.stage_id === stageId);
}

/** `n` entrants named `${label} P<i>`, one root table (a group of `pools` pools when given, else a league), generated and started.
 *  `play: false` leaves every line unstarted (nothing in the stage has started: Rebuild is still offered). */
export async function seedStartedTable(
  request: APIRequestContext,
  o: { label: string; n: number; pools?: number; visibility?: "private" | "public"; names?: string[]; play?: boolean },
): Promise<StartedTable> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${o.label} ${TAG}`, visibility: o.visibility ?? "public" });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
  const added = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST",
    Array.from({ length: o.n }, (_, i) => ({ kind: "individual", display_name: o.names?.[i] ?? `${o.label} P${i + 1} ${TAG}`, seed: i + 1 })));
  expect(added.status, JSON.stringify(added.error)).toBe(201);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: o.pools ? "group" : "league",
    name: o.pools ? "Groups" : "League",
    config: o.pools ? { pools: { count: o.pools } } : {},
  });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  const stageId = stage.data!.id;
  const gen = await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST");
  expect(gen.status, JSON.stringify(gen.error)).toBe(200);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBe(200);
  if (o.play !== false) {
    const first = (await tableLines(request, divisionId, stageId)).find((f) => f.round_no === 1)!;
    const ev = await apiJson(request, `/api/v1/fixtures/${first.id}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    expect(ev.status, JSON.stringify(ev.error)).toBe(201);
  }
  return { competitionId: comp.data!.id, divisionId, stageId, ids: added.data!.map((e) => e.id) };
}

/** An automatic arrival after Start: the public register door, free and auto-approved. Returns the entrant it made. */
export async function registerLateArrival(request: APIRequestContext, t: StartedTable, who: string): Promise<string> {
  const settings = await apiJson(request, `/api/v1/divisions/${t.divisionId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    payment_method: "offline",
    form_fields: [],
    approval: "auto",
  });
  expect(settings.status, JSON.stringify(settings.error)).toBeLessThan(300);
  const path = await competitionPath(request, t.competitionId);
  const [, orgSlug, compSlug] = /^\/o\/([^/]+)\/c\/([^/]+)/.exec(path)!;
  const sent = await apiJson<{ entries: { status: string }[] }>(request, `/api/v1/public/orgs/${orgSlug}/competitions/${compSlug}/register`, "POST", {
    contact: { name: who, email: `delivered+${TAG.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 8)}@resend.dev` },
    privacy_consent: true,
    entries: [{ division_id: t.divisionId, entrant_kind: "individual", players: [{ full_name: who }], answers: {} }],
  });
  expect(sent.status, JSON.stringify(sent.error)).toBe(201);
  expect(sent.data!.entries[0]!.status, "premise: confirmed at once").toBe("confirmed");
  const list = await apiJson<{ id: string; display_name: string }[]>(request, `/api/v1/divisions/${t.divisionId}/entrants`);
  const entrant = list.data!.find((e) => e.display_name === who);
  expect(entrant, "premise: the confirmation made an entrant").toBeTruthy();
  return entrant!.id;
}
