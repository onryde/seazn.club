import { readFileSync } from "node:fs";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/**
 * Per-stage match rules — the public format label (brief 2026-09-24).
 *
 * The prod shape: a badminton `short` division (best of 3 to 11), a Swiss
 * stage whose stored rules are 1 game to 15 capped at 21, and a League stage
 * beside it with none. Before the fix every public surface named the
 * division's preset ("Short (11 points)") for both. Now the Swiss fixture's
 * `match_centre.header.metaLine` states the stage's rules, the League's keeps
 * the preset, the hub document carries a line for the Swiss stage only, and
 * the division page's stage chip says it. Anonymous reads throughout. Every
 * expected string is read from the en dictionaries on disk.
 */
export async function stageRulesFormatSmoke(): Promise<void> {
  const readDict = (ns: string) =>
    JSON.parse(
      readFileSync(new URL(`../apps/web/src/dictionaries/en/${ns}.json`, import.meta.url), "utf8"),
    ) as Record<string, string>;
  const pub = readDict("public");
  const ui = readDict("ui");
  const fill = (template: string, params: Record<string, number>): string =>
    template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]));

  const owner = newSession();
  const who = await signIn(owner, `delivered+stagerules_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";
  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Stage Rules Smoke ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Boys Singles",
      sport_key: "badminton",
      variant_key: "short",
    }),
  );
  await v1(
    owner,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    ["Ada", "Bo", "Cy", "Di"].map((n, i) => ({
      kind: "individual",
      display_name: `${n} ${tag}`,
      seed: i + 1,
    })),
  );
  const swiss = v1data<{ id: string }>(
    await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "Swiss" }),
  );
  const league = v1data<{ id: string }>(
    await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 2, kind: "league", name: "League" }),
  );
  const rules = { bestOf: 1, setTo: 15, cap: 21, finalSetTo: 15, winBy: 2 };
  const put = await v1(owner, `/api/v1/stages/${swiss.id}/rules`, "PUT", { rules });
  check("stage rules smoke: PUT /stages/{id}/rules saves the Swiss stage's rules", put.status === 200);
  const swissFx = v1data<{ fixtures: { id: string }[] }>(
    await v1(owner, `/api/v1/stages/${swiss.id}/generate`, "POST"),
  ).fixtures[0].id;
  const leagueFx = v1data<{ fixtures: { id: string }[] }>(
    await v1(owner, `/api/v1/stages/${league.id}/generate`, "POST"),
  ).fixtures[0].id;
  await v1(owner, `/api/v1/divisions/${div.id}/start`, "POST");
  const divRow = v1data<{ slug: string; config: { setTo?: number } }>(
    await v1(owner, `/api/v1/divisions/${div.id}`),
  );

  const line = fill(pub["format.rules.oneGamePointsCap"], { points: rules.setTo, cap: rules.cap });
  const preset = ui["variant.badminton.short"];
  check(
    "stage rules smoke: the premise — the division's own target is not the stage's 15",
    typeof divRow.config.setTo === "number" && divRow.config.setTo !== rules.setTo,
  );

  const anon = newSession();
  const metaOf = async (fixtureId: string): Promise<string> =>
    v1data<{ match_centre?: { header?: { metaLine?: string } } }>(
      await v1(anon, `/api/v1/public/fixtures/${fixtureId}`),
    ).match_centre?.header?.metaLine ?? "";
  const swissMeta = await metaOf(swissFx);
  check(
    `stage rules smoke: the Swiss fixture's metaLine names "${line}", not the preset — got "${swissMeta}"`,
    swissMeta.includes(line) && !swissMeta.includes(preset),
  );
  const leagueMeta = await metaOf(leagueFx);
  check(
    `stage rules smoke: the League fixture (no override) keeps "${preset}" — got "${leagueMeta}"`,
    leagueMeta.includes(preset) && !leagueMeta.includes(line),
  );

  // A line is a list of clauses; the set kernel says its rules in ONE.
  type HubLine = { stageName: string; line: { key: string; params?: Record<string, unknown> }[] };
  const hub = v1data<{ divisions?: { slug: string; stageFormatLines?: HubLine[] }[] } | undefined>(
    await v1(anon, `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/hub`),
  );
  const lines = hub?.divisions?.find((d) => d.slug === divRow.slug)?.stageFormatLines ?? [];
  check(
    `stage rules smoke: the hub names the Swiss stage's rules and ONLY it — got ${JSON.stringify(lines)}`,
    lines.length === 1 &&
      lines[0].stageName === "Swiss" &&
      lines[0].line.length === 1 &&
      lines[0].line[0].key === "format.rules.oneGamePointsCap" &&
      lines[0].line[0].params?.points === rules.setTo &&
      lines[0].line[0].params?.cap === rules.cap,
  );

  const page = await html(anon, `/shared/${orgSlug}/${comp.slug}/${divRow.slug}`);
  check(
    "stage rules smoke: the division page's Swiss chip carries the line, read ANONYMOUSLY",
    page.status === 200 &&
      page.body.includes(`data-testid="division-stage-format"`) &&
      page.body.includes(line),
  );
}
