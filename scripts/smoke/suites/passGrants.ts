// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, newSession, cookieHeader, call, check, signIn, tag, grantPass, smokeDb, html, type V1Res, v1, v1data,
} from "../harness.ts";

/**
 * Task 23 — every grant an Event Pass actually delivers, end to end.
 *
 * ── The shape, and why it is the only honest one ────────────────────────────
 * ONE fresh community org, TWO competitions, a pass on exactly one of them.
 * Every grant is asserted as a PAIR against that same org in the same run:
 * the passed competition is ALLOWED, the sibling competition is REFUSED. A
 * check that a passless community org would also satisfy proves nothing about
 * the pass, and where a grant is a CEILING the pair is the only shape that can
 * fail for the right reason — "allowed at 128" alone passes on a plan with no
 * ceiling at all, and "refused at 129" alone passes on Community's 64.
 *
 * The sibling competition is also the leak detector: `competition_passes` is
 * joined into the resolver per competition (lib/entitlements.ts resolveFromDb),
 * so a grant that shows up on the SIBLING is a pass escaping its scope.
 *
 * ── Two numbers the plan brief got wrong, deliberately not asserted ─────────
 *  • `branding` — V310 made it true on EVERY plan, so "the pass delivers
 *    branding" is a test that cannot fail. Dropped. It is NOT the same key as
 *    `dashboard.theme` (the brand-colour gate since V397 — it was
 *    `dashboard.branding`, which is now badge removal alone and enterprise
 *    only), which is Pro and above and which the pass does not grant, so
 *    neither is substituted for the other.
 *  • "the entrant cap" — V319 raised Community to 64 and the pass to 128.
 *    Asserting 64 asserts what a passless community org already gets.
 * The live matrix (`set search_path = seazn_club`; the `public` schema holds a
 * stale pre-v3 copy) is the authority for every figure below.
 *
 * ── Keyless- and model-safe ────────────────────────────────────────────────
 * Nothing here needs Stripe, and nothing spends an Anthropic token.
 *
 * ── AI credits are no longer part of this pair pattern (v17 Phase 2) ────────
 * The old graded per-division AI run cap (community 5, pass 10 — a
 * per-division count, seeded via fake competition_events and read with
 * `mode: "repair"` against an empty-scope division to stay keyless-safe) was
 * retired (V322): AI runs are now metered by a prepaid, ORG-WIDE credit wallet
 * (`ai_credit_ledger`, V320+), and Event Pass carries no `ai.credits.monthly`
 * row at all — it never touches the wallet, so there is no pass-vs-sibling
 * pair to assert here. The wallet's plan-matrix figure (community 10) staying
 * put org-wide, regardless of a competition-scoped pass, is covered by the
 * org-wide entitlements check further down in this suite instead.
 */
export async function passGrantsSuite(): Promise<void> {
  const genericDiv = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };
  const featureKey = (r: V1Res) => (r.json.error as { feature_key?: string } | undefined)?.feature_key;

  const s = newSession();
  const orgId = (await signIn(s, `delivered+passgrant_${tag}@resend.dev`)).org_id;
  const orgs = (await call(s, "/api/orgs")) as { id: string; slug: string; name: string }[];
  const org = orgs.find((o) => o.id === orgId)!;

  // Unlisted, not public: `dashboard.public.max` is 2 on community (V396 —
  // the comment said 1 until the retired-plan copy sweep re-read the row), and
  // both competitions still resolve through the public read model (only
  // `private` is excluded from public_competitions_v), so the public player
  // card and the public register panel both stay reachable. `unlisted` is
  // still the right choice here: it takes the cap out of the picture entirely
  // rather than sitting one under it, which is what the assertions below
  // assume.
  const mkComp = async (name: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${name} ${tag}`, visibility: "unlisted" }),
    );
  const mkDiv = async (compId: string, name: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(s, `/api/v1/competitions/${compId}/divisions`, "POST", { name, ...genericDiv }),
    );
  const entrants = (n: number, from: number, label: string) =>
    Array.from({ length: n }, (_, i) => ({
      kind: "individual",
      display_name: `${label}${from + i}`,
      seed: from + i,
    }));

  const passComp = await mkComp("Grants Passed");
  const plainComp = await mkComp("Grants Plain");
  await grantPass(orgId, passComp.id, "event_pass");
  check(
    "pass grants: fixture built — one community org, two competitions, one passed",
    !!passComp.id && !!plainComp.id && passComp.id !== plainComp.id,
  );

  // A person consented to a public card, seated as an entrant member in BOTH
  // competitions. public_players_v filters on consent + entrant membership and
  // is NOT competition-scoped, so seating them twice removes the only other
  // reason the card could 404 — whichever side 404s, it 404s on the
  // entitlement and nothing else.
  const person = v1data<{ id: string }>(
    await v1(s, "/api/v1/persons", "POST", {
      full_name: `Grants Player ${tag}`,
      consent: { public_name: true },
    }),
  );

  // Per competition: a board division carrying real fixtures (realtime, the
  // branded export and the player card all read it) plus the ceiling probes.
  const board: Record<"pass" | "plain", { divId: string; divSlug: string; fixtureId: string; stageId: string }> =
    {} as never;
  for (const [key, comp] of [["pass", passComp], ["plain", plainComp]] as const) {
    const div = await mkDiv(comp.id, "Board");
    await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "individual", display_name: `Board One ${key}`, seed: 1, members: [{ person_id: person.id }] },
      { kind: "individual", display_name: `Board Two ${key}`, seed: 2 },
    ]);
    const stage = v1data<{ id: string }>(
      await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
    );
    const fixtures = v1data<{ fixtures: { id: string }[] }>(
      await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
    ).fixtures;
    await v1(s, `/api/v1/divisions/${div.id}/start`, "POST");
    board[key] = { divId: div.id, divSlug: div.slug, fixtureId: fixtures[0].id, stageId: stage.id };
  }

  // === entrants.per_division.max — community 64, pass 128 (V319) ==========
  const passCap = await mkDiv(passComp.id, "Entrant Cap");
  const plainCap = await mkDiv(plainComp.id, "Entrant Cap");
  const passTo128 = await v1(s, `/api/v1/divisions/${passCap.id}/entrants`, "POST", entrants(128, 1, "P"));
  const pass129 = await v1(s, `/api/v1/divisions/${passCap.id}/entrants`, "POST", entrants(1, 129, "P"));
  const plainTo64 = await v1(s, `/api/v1/divisions/${plainCap.id}/entrants`, "POST", entrants(64, 1, "C"));
  const plain65 = await v1(s, `/api/v1/divisions/${plainCap.id}/entrants`, "POST", entrants(1, 65, "C"));
  check(
    "pass grants/entrants: the passed competition seats 128 — past community's 64",
    passTo128.status === 201,
  );
  check(
    "pass grants/entrants: the 129th is refused (the pass ceiling is 128, not unlimited)",
    pass129.status === 402 && featureKey(pass129) === "entrants.per_division.max",
  );
  check(
    "pass grants/entrants: the sibling competition seats 64 (community's own cap)",
    plainTo64.status === 201,
  );
  check(
    "pass grants/entrants: the sibling is refused at 65 — the 128 did not leak org-wide",
    plain65.status === 402 && featureKey(plain65) === "entrants.per_division.max",
  );

  // === AI credits (V320+) — no longer a per-division/per-competition cap ===
  // The old graded per-division AI run cap (community 5, pass 10) was retired
  // (V322): AI runs are metered by a prepaid, ORG-WIDE credit wallet
  // (ai_credit_ledger), not a per-division count, and Event Pass grants
  // no ai.credits.monthly row at all (it is a competition-scoped entrant/
  // division bump only, SPEC-2 §4a) — a pass neither raises nor otherwise
  // touches the org's AI wallet. `passAiDiv` still exists purely as the
  // passed competition's THIRD division, which the divisions.per_competition.
  // max probe just below needs. The "AI credits stay at the community figure
  // org-wide, unaffected by the pass" half of this story is covered by the
  // org-wide entitlements check further down (`ai.credits.monthly === 10`).
  await mkDiv(passComp.id, "AI Five");

  // === divisions.per_competition.max — community 4, pass 10 (V319) =========
  // The sibling (no pass) already holds two divisions (Board, Entrant Cap);
  // community's cap is 4, so a 3rd and 4th still land, and the 5th is refused —
  // proving the pass did not lift the sibling's per-competition division cap.
  await v1(s, `/api/v1/competitions/${plainComp.id}/divisions`, "POST", { name: "Third", ...genericDiv });
  await v1(s, `/api/v1/competitions/${plainComp.id}/divisions`, "POST", { name: "Fourth", ...genericDiv });
  const plainFifth = await v1(s, `/api/v1/competitions/${plainComp.id}/divisions`, "POST", {
    name: "Fifth",
    ...genericDiv,
  });
  check(
    "pass grants/divisions: the sibling competition is refused a 5th division (community's cap is 4)",
    plainFifth.status === 402 && featureKey(plainFifth) === "divisions.per_competition.max",
  );
  let passDivisionsOk = true;
  for (let i = 4; i <= 10; i++) {
    const r = await v1(s, `/api/v1/competitions/${passComp.id}/divisions`, "POST", {
      name: `Filler ${i}`,
      ...genericDiv,
    });
    if (r.status !== 201) passDivisionsOk = false;
  }
  const pass11th = await v1(s, `/api/v1/competitions/${passComp.id}/divisions`, "POST", {
    name: "Eleventh",
    ...genericDiv,
  });
  check(
    "pass grants/divisions: the passed competition takes all 10 (past community's 4)",
    passDivisionsOk,
  );
  check(
    "pass grants/divisions: the 11th is refused (the pass ceiling is 10)",
    pass11th.status === 402 && featureKey(pass11th) === "divisions.per_competition.max",
  );

  // === realtime — community false, pass true ==============================
  // The noticeboard is the surface that resolves `realtime` WITH a competition
  // in hand (app/slideshow/divisions/[id]/page.tsx). The flag reaches the
  // client island as a prop, so it lands in the RSC payload embedded in the
  // page; the backslashes are the payload's own string escaping.
  const flightFlag = (body: string, want: boolean) =>
    body.replace(/\\/g, "").includes(`"realtime":${want}`);
  const passBoard = await html(s, `/slideshow/divisions/${board.pass.divId}`);
  const plainBoard = await html(s, `/slideshow/divisions/${board.plain.divId}`);
  check(
    "pass grants/realtime: the passed competition's noticeboard is live",
    passBoard.status === 200 && flightFlag(passBoard.body, true),
  );
  check(
    "pass grants/realtime: the sibling's noticeboard stays static — realtime did not leak",
    plainBoard.status === 200 && flightFlag(plainBoard.body, false),
  );

  // === exports.branded — community false, pass true =======================
  // Read the document, not the entitlement: docModelToXlsx writes the org name
  // as its own row ONLY when orgBranding() resolved (usecases/exports.ts keys
  // that on `exports.branded` with the competition id). XLSX rather than PDF
  // because pdfkit compresses its content streams, so byte-scanning a PDF for
  // the same string is unreliable.
  const ExcelJS = (await import("exceljs")).default;
  const exportColumnA = async (divisionId: string): Promise<string[]> => {
    const res = await fetch(`${BASE}/api/v1/divisions/${divisionId}/exports/timetable?format=xlsx`, {
      headers: { cookie: cookieHeader(s) },
    });
    if (res.status !== 200) return [`HTTP ${res.status}`];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const cells: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- exceljs CellValue includes object arms; this sheet's column 1 is text and the assertion compares text, so the existing stringification is kept rather than swapped for `.text`, which formats dates and numbers differently.
    wb.worksheets[0]?.eachRow((row) => cells.push(String(row.getCell(1).value ?? "")));
    return cells;
  };
  const passExport = await exportColumnA(board.pass.divId);
  const plainExport = await exportColumnA(board.plain.divId);
  check(
    "pass grants/exports: the passed competition's export carries branded chrome (org name row)",
    passExport[1] === org.name,
  );
  check(
    "pass grants/exports: the sibling's export renders plain — branding did not leak",
    plainExport.length > 1 && !plainExport.includes(org.name),
  );

  // === dashboard.player_profiles — community FALSE, pass TRUE again =======
  //
  // This cell has moved twice in one day and the history is why the comment is
  // this long. It was "community false, pass true" originally; V393
  // (entitlements v18 W2 T1) granted it on Community as one of design §2's
  // three "share loops go free" acquisition cells, and this block was inverted
  // to assert the card renders on BOTH sides. V396 (W2 T15, owner ruling
  // 2026-09-03) REVERSED that — the owner chose value capture over the loop,
  // with the acquisition argument put and overruled.
  //
  // So the pair is back to its original shape: the ONLY difference between a
  // 200 and a 404 is the pass. Do not "restore" the free cell on the strength
  // of design §2's prose — that prose is now the older decision, and §2's own
  // table has been amended.
  const passCard = await fetch(`${BASE}/shared/${org.slug}/${passComp.slug}/players/${person.id}`);
  const plainCard = await fetch(`${BASE}/shared/${org.slug}/${plainComp.slug}/players/${person.id}`);
  check(
    "pass grants/profiles: the public player card renders on the passed competition (200)",
    passCard.status === 200,
  );
  check(
    "pass grants/profiles: the UNPASSED sibling stays dark (404) — V396 made profiles paid again",
    plainCard.status === 404,
  );
  // Hub query perf T1 (V418): `public_entrants_v` now asks this entitlement
  // once per entrant row instead of twice per member. The pass is scoped to ONE
  // competition, so the anonymous entrants document must still publish the
  // consented member's id exactly where the card renders — and keep the member,
  // id withheld, on the sibling. Both sides read the same person.
  type BoardDoc = { entrants?: { display_name: string; members: { name: string; person_id: string | null }[] }[] };
  const boardMember = async (key: "pass" | "plain", compSlug: string) =>
    v1data<BoardDoc | undefined>(
      await v1(newSession(), `/api/v1/public/orgs/${org.slug}/competitions/${compSlug}/divisions/${board[key].divSlug}/entrants`),
    )?.entrants?.find((e) => e.display_name === `Board One ${key}`)?.members?.[0];
  const passMember = await boardMember("pass", passComp.slug);
  const plainMember = await boardMember("plain", plainComp.slug);
  check(
    "pass grants/profiles: the passed competition's public entrants document publishes the member's id",
    passMember?.person_id === person.id,
  );
  check(
    "pass grants/profiles: the unpassed sibling's document keeps the member but withholds the id",
    !!plainMember && plainMember.name.length > 0 && plainMember.person_id === null,
  );
  // Player profile — upcoming across the org (spec 2026-09-23). The passed
  // card's board fixture was generated and never started, so it is SCHEDULED
  // and upcoming. The plain competition is UNLISTED and is not this card's,
  // so its board fixture must never reach this card (R2). Positive and
  // negative read the same page body; both anchor on `="`.
  const passCardHtml = await passCard.text();
  check(
    "player upcoming: the passed card lists its own scheduled board fixture under Upcoming",
    passCardHtml.includes('data-testid="mh-player-upcoming"') &&
      passCardHtml.includes(`data-testid="mh-player-upcoming-row-${board.pass.fixtureId}"`),
  );
  check(
    "player upcoming: the sibling UNLISTED competition's fixture never reaches this card (R2)",
    !passCardHtml.includes(board.plain.fixtureId),
  );
  // Spectator W2 (Task 17, SM2) — the card's open page polls its match lines
  // from a public API. That API must refuse exactly where the card does, or a
  // Community org's paid-only lines are one curl away from the 404 above.
  const matchesPath = (compSlug: string, personId: string) =>
    `/api/v1/public/orgs/${org.slug}/competitions/${compSlug}/players/${personId}/matches`;
  //
  // The 200 carries NO lines, and that is the value, not a gap: the reader
  // lists a person's appearances only (`APPEARANCE_STATUSES`, completed or
  // in play — public-player-matches.ts), and this suite's board fixture is
  // generated and never started. Starting it here would move the officials
  // and device-link checks below, which read the same fixture. Lines a card
  // actually shows are proven in the browser by the player walkthrough
  // (spectator-player.spec.ts PP1/PP2), so the check pins the EMPTY list
  // exactly rather than accepting any array.
  //
  // SM3 (a score write retires the player-matches generation) is deferred on
  // purpose: the only thing it can witness is a Redis DEL, and no smoke
  // environment sets REDIS_URL (CI's smoke-e2e job has none), so it would pass
  // with the DEL deleted. The DEL is pinned by unit tests instead
  // (`player-matches-cache-keys.test.ts`, `hub-cache-invalidation.test.ts`).
  const passMatches = await v1(newSession(), matchesPath(passComp.slug, person.id));
  const passLines = v1data<{ matches?: unknown; generatedAt?: string } | undefined>(passMatches);
  check(
    "pass grants/profiles: the passed competition's player-matches API serves 200, a timestamp, and exactly no lines (its only fixture never started)",
    passMatches.status === 200 &&
      Array.isArray(passLines?.matches) &&
      passLines.matches.length === 0 &&
      !Number.isNaN(Date.parse(passLines?.generatedAt ?? "")),
  );
  const plainMatches = await v1(newSession(), matchesPath(plainComp.slug, person.id));
  check(
    "pass grants/profiles: the UNPASSED sibling's player-matches API is a 404, like its card",
    plainMatches.status === 404,
  );
  const junkMatches = await v1(newSession(), matchesPath(passComp.slug, "not-a-person"));
  check("pass grants/profiles: a non-uuid person on the player-matches API is a 404", junkMatches.status === 404);

  // === sponsors.tiers + sponsors.monetize — community false, pass true ====
  const tierOn = async (competitionId: string, label: string) =>
    v1(s, `/api/v1/orgs/${orgId}/sponsors`, "POST", {
      name: `Grants Sponsor ${label} ${tag}`,
      tier: "gold",
      competition_id: competitionId,
    });
  const packageOn = async (competitionId: string, label: string) =>
    v1(s, `/api/v1/orgs/${orgId}/sponsor-packages`, "POST", {
      name: `Grants Package ${label}`,
      price_cents: 25000,
      currency: "gbp",
      tier: "gold",
      competition_id: competitionId,
    });
  const passTier = await tierOn(passComp.id, "pass");
  const plainTier = await tierOn(plainComp.id, "plain");
  const passPackage = await packageOn(passComp.id, "pass");
  const plainPackage = await packageOn(plainComp.id, "plain");
  check(
    "pass grants/sponsors: a tiered sponsor saves on the passed competition (201)",
    passTier.status === 201,
  );
  check(
    "pass grants/sponsors: the sibling refuses the same tiered sponsor (402 sponsors.tiers)",
    plainTier.status === 402 && featureKey(plainTier) === "sponsors.tiers",
  );
  check(
    "pass grants/sponsors: a priced package saves on the passed competition (201)",
    passPackage.status === 201,
  );
  check(
    "pass grants/sponsors: the sibling refuses the same package (402 sponsors.monetize)",
    plainPackage.status === 402 && featureKey(plainPackage) === "sponsors.monetize",
  );

  // === officials.auto — community false, pass true (V393) =================
  // Auto-officials became a pass grant in v18. All THREE gates are probed,
  // because they resolve the competition by different routes: the two division
  // gates read `divisions.competition_id`, and `/stages/{id}/officials/source`
  // has to hop stages -> divisions first. A gate that forgot the competition
  // id would 402 on the passed side — the org paid for a feature it is then
  // refused — and one that resolved org-wide would 200 on the sibling.
  const officialsAuto = async (divisionId: string) =>
    v1(s, `/api/v1/divisions/${divisionId}/officials/auto`, "POST", {
      policy: { roles: ["referee"] },
    });
  const officialsApply = async (divisionId: string) =>
    v1(s, `/api/v1/divisions/${divisionId}/officials/apply`, "POST", { assignments: [] });
  const officialsSource = async (stageId: string) =>
    v1(s, `/api/v1/stages/${stageId}/officials/source`, "POST", {
      sources: [{ kind: "rank", fromStage: stageId, take: [{ rank: 1 }] }],
    });
  const passAuto = await officialsAuto(board.pass.divId);
  const plainAuto = await officialsAuto(board.plain.divId);
  const passApply = await officialsApply(board.pass.divId);
  const plainApply = await officialsApply(board.plain.divId);
  const passSource = await officialsSource(board.pass.stageId);
  const plainSource = await officialsSource(board.plain.stageId);
  check(
    "pass grants/officials: auto-assign runs on the passed competition (200, proposal returned)",
    passAuto.status === 200 &&
      Array.isArray(v1data<{ assignments: unknown[] }>(passAuto).assignments),
  );
  check(
    "pass grants/officials: the sibling is refused auto-assign (402 officials.auto) — no leak",
    plainAuto.status === 402 && featureKey(plainAuto) === "officials.auto",
  );
  check(
    "pass grants/officials: apply runs on the passed competition (200)",
    passApply.status === 200,
  );
  check(
    "pass grants/officials: the sibling is refused apply (402 officials.auto)",
    plainApply.status === 402 && featureKey(plainApply) === "officials.auto",
  );
  check(
    "pass grants/officials: rank sourcing runs on the passed competition (200) — stage -> division -> competition",
    passSource.status === 200,
  );
  check(
    "pass grants/officials: the sibling is refused rank sourcing (402 officials.auto)",
    plainSource.status === 402 && featureKey(plainSource) === "officials.auto",
  );

  // === stats.player — free on every plan since W3-A (2026-09-06, V399) =====
  // W2 T13 originally proved this pass-scoped (community false, pass true,
  // V393) — the same shape as the two blocks below. W3-A split it: the
  // per-division RECORD this endpoint reads is free everywhere now, pass or
  // no pass, so the "sibling 402s" half of that story is gone. Rewritten to
  // prove the record reads on BOTH competitions, not deleted, so a
  // regression that re-guards it on plan or pass reds here.
  const passStats = await v1(s, `/api/v1/divisions/${board.pass.divId}/stats/players`);
  const plainStats = await v1(s, `/api/v1/divisions/${board.plain.divId}/stats/players`);
  check(
    "pass grants/stats: the passed competition's player leaderboard reads (200)",
    passStats.status === 200,
  );
  check(
    "pass grants/stats: the sibling's leaderboard reads too (200) — W3-A froze stats.player free everywhere",
    plainStats.status === 200,
  );

  // === stats.player.career — the leverage half `stats.player` split off ====
  // (W3-A). `?group=sport` kept the pass-scoped story stats.player used to
  // tell, on its own key — `person` above is seated in BOTH board divisions,
  // so this is the happy-path wiring proof (the route reaches
  // personCareerStats and the passed competition's own gate passes); the
  // full bidirectional pass-scoping case (a person seated ONLY in the
  // unpassed competition, refused with the right key) is proven as real
  // Postgres integration coverage in
  // server/usecases/__tests__/pass-scope-w2.test.ts, mutation-checked there —
  // reproducing it here would mean seating a THIRD entrant into a division
  // this suite has already started, which `createEntrants` refuses.
  const careerRead = await v1(s, `/api/v1/persons/${person.id}/stats?group=sport`);
  check(
    "pass grants/career: the rollup reads for a person seated in the passed competition (200)",
    careerRead.status === 200,
  );

  // === scoring.device_links — community false, pass true (V393) ============
  // Minted against the board fixtures generated above; both are still
  // scheduled, so the only difference between the two calls is the pass.
  const passLink = await v1(s, `/api/v1/fixtures/${board.pass.fixtureId}/device-links`, "POST", {
    label: "Pitch 1",
  });
  const plainLink = await v1(s, `/api/v1/fixtures/${board.plain.fixtureId}/device-links`, "POST", {
    label: "Pitch 1",
  });
  check(
    "pass grants/device links: a day-of scoring device mints on the passed competition (201)",
    passLink.status === 201,
  );
  check(
    "pass grants/device links: the sibling refuses it (402 scoring.device_links) — no leak",
    plainLink.status === 402 && featureKey(plainLink) === "scoring.device_links",
  );

  // === stages.per_division.max — free on every plan (V471) =================
  // Was community 2, pass 4 (V393): the pass lifted it and the sibling was
  // refused a 3rd. V471 ("all stages are free", owner ruling 2026-10-20) made
  // the count unlimited on every plan, so BOTH competitions now take a 3rd —
  // the sibling's 201 is the witness that the old cap is gone, not leaked.
  // Run on the ENTRANT-CAP divisions, which carry NO stages at all — the board
  // divisions already hold one and both competitions are at their division
  // ceiling, so there is no fresh division to take instead. Counting from ZERO
  // is load-bearing: an earlier draft started at seq 2 and the sibling's third
  // create was only its SECOND stage, so it proved nothing about the cap.
  const addStage = (divisionId: string, seq: number) =>
    v1(s, `/api/v1/divisions/${divisionId}/stages`, "POST", {
      seq,
      kind: "league",
      name: `Cap Stage ${seq}`,
    });
  const passStages = [
    await addStage(passCap.id, 1),
    await addStage(passCap.id, 2),
    await addStage(passCap.id, 3),
  ];
  const plainStages = [
    await addStage(plainCap.id, 1),
    await addStage(plainCap.id, 2),
    await addStage(plainCap.id, 3),
  ];
  check(
    "pass grants/stages: the passed competition takes a 3rd stage — past community's old 2",
    passStages.every((r) => r.status === 201),
  );
  check(
    "pass grants/stages: the sibling (no pass) takes a 3rd stage too — free on every plan since V471",
    plainStages.length === 3 && plainStages.every((r) => r.status === 201),
  );

  // === registration.fee_percent — the pass cuts the org's rate ============
  // Stated plainly, because this one is weaker than the rest and the reason
  // matters: the rate has NO competition-scoped read surface. `feePercentFor`
  // is consumed in exactly two places (the registration checkout and the
  // sponsor checkout), and both feed it straight into a Stripe
  // `application_fee_amount` that never comes back out — so there is nothing
  // keyless to observe. What IS assertable is split in two:
  //   • the matrix itself — the pass row must still sit UNDER community's,
  //     which fails the moment a migration regresses the grant. Read from the
  //     table and compared to each other rather than pinned to 5 and 8: V398
  //     re-cut the whole ladder (community 8 -> 5, both pass rungs 5 -> 4) for
  //     the additive fee model, and the claim this suite is making is that the
  //     pass is CHEAPER, never that either rate is a particular number;
  //   • the org-wide resolution — the competition-scoped pass rate must not
  //     become the org's rate, which is the leak this suite exists to catch.
  // If a competition-scoped fee ever surfaces (a quote endpoint, or the
  // application fee echoed on the registration read), replace the first half
  // with the behavioural pair the other grants get.
  const feeDb = smokeDb();
  let feeMatrix: { plan_key: string; int_value: number | null }[] = [];
  try {
    feeMatrix = await feeDb<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements
      where feature_key = 'registration.fee_percent'
        and plan_key in ('community', 'event_pass')`;
  } finally {
    await feeDb.end();
  }
  const feeFor = (planKey: string) => feeMatrix.find((r) => r.plan_key === planKey)?.int_value;
  const passFee = feeFor("event_pass");
  const communityFee = feeFor("community");
  check(
    `pass grants/fee: the pass still cuts the platform rate (${passFee}% against community's ${communityFee}%)`,
    typeof passFee === "number" && typeof communityFee === "number" && passFee < communityFee,
  );

  // === The org itself is untouched — every grant above is competition-scoped
  const ent = (await call(s, `/api/orgs/${orgId}/entitlements`)) as {
    plan_key: string;
    entitlements: Record<string, { enabled?: boolean; limit?: number | null }>;
  };
  const flagOff = (key: string) => ent.entitlements[key]?.enabled === false;
  check(
    "pass grants/scope: the org still resolves the community plan",
    ent.plan_key === "community",
  );
  // `dashboard.player_profiles` left this list in V393, when Community was
  // granted the key and asserting a paywall would have asserted one that no
  // longer existed. V396 put the paywall back (owner ruling 2026-09-03), so the
  // key is pass-lifted again — it is asserted OFF org-wide in its own named
  // check below rather than folded into this && chain, because a chain this
  // long reports only "false" and this particular cell has now moved twice.
  check(
    "pass grants/scope: every boolean grant stays OFF org-wide (realtime, exports.branded, sponsors, and the V393 keys)",
    flagOff("realtime") &&
      flagOff("exports.branded") &&
      flagOff("sponsors.tiers") &&
      flagOff("sponsors.monetize") &&
      // W2 T13 — the leak half. Threading a competition id into these gates
      // must not turn a competition-scoped grant into an org-wide one: they
      // read TRUE on the passed competition above and FALSE for the org here.
      //
      // `stats.player` LEFT this list (W3-A, 2026-09-06, V399): it is true
      // org-wide now, on every plan — `flagOff("stats.player")` would itself
      // be false and break this whole chain. `stats.player.career`, the
      // split-off leverage half, took its place — it is what is still
      // genuinely denied org-wide here.
      flagOff("stats.player.career") &&
      flagOff("scoring.device_links") &&
      flagOff("discipline.enforced") &&
      flagOff("officials.auto"),
  );
  check(
    "pass grants/scope: dashboard.player_profiles is OFF org-wide — paid again since V396, and pass-scoped",
    ent.entitlements["dashboard.player_profiles"]?.enabled === false,
  );
  check(
    `pass grants/scope: every quota stays at the community figure org-wide (64/4/5 entrants/divisions/AI credits, fee ${communityFee}%)`,
    ent.entitlements["entrants.per_division.max"]?.limit === 64 &&
      ent.entitlements["divisions.per_competition.max"]?.limit === 4 &&
      ent.entitlements["ai.credits.monthly"]?.limit === 5 &&
      // The org's own row, read out of the matrix above — never the literal.
      // This is the LEAK half: the passed competition resolves `passFee`, and
      // the org must still resolve its own, whatever V398 (or its successor)
      // set them to.
      ent.entitlements["registration.fee_percent"]?.limit === communityFee,
  );
  check(
    "pass grants/scope: the save-point cap stays at the community figure org-wide (2), and the stage count reads unlimited (V471)",
    ent.entitlements["schedule.checkpoints.max"]?.limit === 2 &&
      ent.entitlements["stages.per_division.max"] !== undefined &&
      ent.entitlements["stages.per_division.max"]?.limit === null,
  );

  // === lock (archived) — a pass stops lifting once its competition is
  // terminal (SPEC-4 §7/§13.5, isPassLocked). Every grant above held while
  // `passComp` ran; retire it to `archived` and the SAME create that a moment
  // ago succeeded under the pass — a tiered sponsor (sponsors.tiers, 201 as
  // passTier) — must now 402. sponsors.tiers is boolean and state-free, so it
  // flips cleanly, where the entrant cap (already at 128) would 402 either
  // way. v17 #287: the status write DOES invalidate the resolver's
  // (org, competition, feature) cache now — patchCompetition busts it inside
  // the same call — so, unlike every raw-SQL write elsewhere in this suite,
  // there is deliberately NO bustOrgEntitlements call below. If that
  // invalidation ever regresses, this 402 goes stale on any Redis-backed
  // target (staging, a prod smoke run) for up to the 300s TTL; locally/CI
  // REDIS_URL is normally unset so the cache is inert and this only proves
  // the resolver logic, not the invalidation itself (see the dedicated
  // Redis-gated suite, entitlements-cache-invalidation.redis.test.ts).
  const retire = await v1(s, `/api/v1/competitions/${passComp.id}`, "PATCH", { status: "archived" });
  check("pass grants/lock: the passed competition retires to archived (200)", retire.status === 200);
  const lockedTier = await tierOn(passComp.id, "locked");
  check(
    "pass grants/lock: once archived the pass no longer lifts sponsors.tiers — the create that held under the pass now 402s",
    lockedTier.status === 402 && featureKey(lockedTier) === "sponsors.tiers",
  );

  // === lock (completed) — the OTHER terminal status (isPassLocked's set is
  // {archived, completed}), on a fresh comp so it's independent of the
  // archived case above. Also proves the pass was genuinely lifting the
  // ENTRANT cap (not just a boolean flag): 65 seats past community's 64
  // while live, then the 66th 402s the instant the completing PATCH commits.
  const lockComp = await mkComp("Grants Lock Completed");
  await grantPass(orgId, lockComp.id, "event_pass");
  const lockDiv = await mkDiv(lockComp.id, "Lock Cap");
  const lockPast64 = await v1(s, `/api/v1/divisions/${lockDiv.id}/entrants`, "POST", entrants(65, 1, "L"));
  check(
    "pass grants/lock(completed): the pass seats 65 — past community's 64 — while the competition is live",
    lockPast64.status === 201,
  );
  const complete = await v1(s, `/api/v1/competitions/${lockComp.id}`, "PATCH", { status: "completed" });
  check("pass grants/lock(completed): the competition completes (200)", complete.status === 200);
  const overCap = await v1(s, `/api/v1/divisions/${lockDiv.id}/entrants`, "POST", entrants(1, 66, "L"));
  check(
    "pass grants/lock(completed): once completed the pass stops lifting entrants.per_division.max — the 66th create 402s with no stale-cache window",
    overCap.status === 402 && featureKey(overCap) === "entrants.per_division.max",
  );
}
