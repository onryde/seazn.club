// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, type Session, newSession, cookieHeader, call, check, signIn, tag, setConnect, html, v1, v1data,
} from "../harness.ts";

/** PROMPT-33/34 smoke: board v3 renders + a seq-tokened reschedule lands and
 *  a stale token 409s (pro); registration issues an SZ ref and /r/[ref]
 *  resolves it on pro AND free orgs (house rule). */
export async function schedRegV3Suite(
  admin: Session,
  proOrgSlug: string,
  proOrgId: string,
): Promise<void> {
  const schedV3Venue = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/venues`, "POST", { name: `Sched v3 Venue ${tag}` }),
  );
  const schedV3CourtA = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/venues/${schedV3Venue.id}/courts`, "POST", {
      name: "A",
    }),
  );
  const schedV3CourtB = v1data<{ id: string }>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/venues/${schedV3Venue.id}/courts`, "POST", {
      name: "B",
    }),
  );
  // --- Pro path: competition + division + timetable + board page ---
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sched v3 ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Boarded",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "S1", seed: 1 },
    { kind: "individual", display_name: "S2", seed: 2 },
    { kind: "individual", display_name: "S3", seed: 3 },
    { kind: "individual", display_name: "S4", seed: 4 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  // V305: no `tz` in the body — the console never sends one. The venue zone
  // comes from the ORGANISATION and is inherited by every division.
  await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-01T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [schedV3CourtA.id, schedV3CourtB.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
  });

  // Org scheduling timezone (V305): set it once on the org, and the division
  // that stores no tz of its own reports it. Then pin the division explicitly
  // and prove a tz-less save no longer moves it (pre-V305 divisions keep
  // their zone forever), before restoring inheritance with an explicit null.
  await call(admin, `/api/orgs/${proOrgId}`, "PATCH", {
    timezone: "Europe/Madrid",
  });
  const inherited = v1data<{ tz: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`),
  );
  check("division inherits the org scheduling timezone (V305)", inherited.tz === "Europe/Madrid");
  await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-01T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [schedV3CourtA.id, schedV3CourtB.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "Asia/Kolkata",
  });
  const kept = v1data<{ tz: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-10-01T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [schedV3CourtA.id, schedV3CourtB.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    }),
  );
  check("a tz-less save keeps a division's own timezone (V305)", kept.tz === "Asia/Kolkata");
  const recleared = v1data<{ tz: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-10-01T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [schedV3CourtA.id, schedV3CourtB.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: null,
    }),
  );
  check("tz: null clears back to inheriting the org zone (V305)", recleared.tz === "Europe/Madrid");
  // Restore: the rest of this suite (and every later suite on this org)
  // assumes UTC wall clocks.
  await call(admin, `/api/orgs/${proOrgId}`, "PATCH", { timezone: null });

  const gen = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"),
  );
  const fixture = gen.fixtures[0].id;

  const board = await html(admin, `/o/${proOrgSlug}/c/${comp.slug}/schedule`);
  check(
    "sched board v3 renders (pro)",
    board.status === 200 && board.body.includes("Board density"),
  );

  // Quarter-hour granularity. Chrome's date/time PICKER POPUP ignores `step`
  // (measured, Chrome 151 — the dropdown renders a full 0-59 minute column
  // regardless), so `step="900"` alone never bounded what a click could
  // pick, only the keyboard. The fix owns the option list instead: every
  // clock control on this tab is now a native <select> built from the
  // quarter-hour grid (`time-options.ts`), and no <input type="time"> or
  // type="datetime-local"> renders anywhere on the page any more — even the
  // start field, which used to be one `datetime-local` input, is now a date
  // <input> beside that same select. The end-DATE field stays a bare
  // <input type="date"> and is unaffected: `step` there counts DAYS, and 900
  // would mean one selectable date every two and a half years, which is why
  // it must carry none.
  //
  // Asserted over the real server-rendered HTML because nothing in the app
  // ever reads this back — it is exactly the kind of thing a refactor drops
  // with every unit test still green. The length floors are the vacuity
  // guard: `[].every(…)` is true, so a selector that stops matching would
  // otherwise report this as a pass.
  const settingsHtml = await html(
    admin,
    `/o/${proOrgSlug}/c/${comp.slug}/d/${div.slug}/schedule?tab=settings`,
  );
  const inputTags = settingsHtml.body.match(/<input\b[^>]*>/g) ?? [];
  const clockInputTags = inputTags.filter((t) => /type="(?:time|datetime-local)"/.test(t));
  // Start's date half + the end date — both bare <input type="date">.
  const dateTags = inputTags.filter((t) => /type="date"/.test(t));
  const selectBlocks = settingsHtml.body.match(/<select\b[^>]*>[\s\S]*?<\/select>/g) ?? [];
  // Start's time half + play-from + play-until: every select offering the
  // full quarter-hour grid, not a truncated or coarser one.
  const clockSelects = selectBlocks.filter(
    (s) => s.includes('value="00:00"') && s.includes('value="23:45"'),
  );
  check(
    "datetime: the settings tab renders no raw clock input any more",
    settingsHtml.status === 200 && inputTags.length >= 5 && clockInputTags.length === 0,
  );
  check(
    "datetime: every clock control on the settings tab offers the quarter-hour grid",
    clockSelects.length >= 3 &&
      clockSelects.every((s) => s.includes('value="09:00"') && s.includes('value="09:15"')),
  );
  check(
    "datetime: the end-DATE field carries no step (there it would count days)",
    dateTags.length >= 2 && dateTags.every((t) => !/\bstep=/.test(t)),
  );

  // Matchday documents (v12 PR1, Task 9): timetable PDF export renders a
  // real PDF for this division's fixtures. It renders REAL PDFs, so assert
  // validity via magic bytes + content-type, not literal text (font
  // subsetting encodes glyph IDs, not characters) — the branded-vs-plain
  // visual proof is the Task 18 gallery, not a byte assertion.
  const docPdf = await fetch(`${BASE}/api/v1/divisions/${div.id}/exports/timetable?format=pdf`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const docPdfBytes = Buffer.from(await docPdf.arrayBuffer());
  check(
    "exports timetable PDF renders a valid branded PDF (pro)",
    docPdf.status === 200 &&
      (docPdf.headers.get("content-type") ?? "").includes("application/pdf") &&
      docPdfBytes.subarray(0, 5).toString() === "%PDF-" &&
      docPdfBytes.byteLength > 1024,
  );

  // F4/P5 + F4/P2 (wave A/B — day-one handout surfaces). Reuses `comp`/`div`
  // above rather than building another division: `div`'s League stage alone
  // can never carry a placeholder — a round robin's fixtures are fully
  // determined the instant it is generated, both sides known from the
  // entrant list — so a second, bracket-shaped stage is added on the SAME
  // division purely to get one unresolved slot. A 4-entrant knockout's final
  // is fed by winnerOf(semi1)/winnerOf(semi2)
  // (bracketToGen/generateStageFixtures,
  // apps/web/src/server/usecases/stages.ts:1117-1155), so it is written with
  // a `slot.winner_match` label and no scheduled_at — resolved at render
  // time to "Winner of {ref}" — exactly the day-one shape both checks below
  // need, and `comp` already carries the `ends_on` the calendar feed anchors
  // on.
  const dayOneStage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 2,
      kind: "knockout",
      name: "Day One KO",
    }),
  );
  const dayOneGen = v1data<{
    fixtures: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[];
  }>(await v1(admin, `/api/v1/stages/${dayOneStage.id}/generate`, "POST"));
  const finalFixtureId = dayOneGen.fixtures.find(
    (f) => f.home_entrant_id === null && f.away_entrant_id === null,
  )?.id;
  check(
    "day-one KO stage generates a final whose slots are still unresolved (setup)",
    finalFixtureId !== undefined,
  );

  // F4/P5: the printed draw is the artifact an organiser pins to a wall on day
  // one. It used to say "TBD vs TBD" while every HTML surface said "Winner of
  // Group A", and nothing in the UI could reveal the discrepancy because the
  // slot-label columns were never selected. A PDF's content streams are
  // compressed (see the comment above `docPdfBytes`), so `toContain` against
  // PDF bytes proves nothing — XLSX cell text is exactly what a `toContain`
  // can search. This is the SAME technique (ExcelJS) `exportColumnA` a few
  // thousand lines up already uses for the pass-grants branding row — a new
  // closure here rather than a call to that one, because it only ever reads
  // column A (this export's own column order is [time, court, home, result,
  // away, stage] — the slot label lands in columns 3/5, not 1) and it closes
  // over `board`/`s`, which do not exist in this function.
  const xlsxCellsToText = async (bytes: ArrayBuffer): Promise<string> => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    const cells: string[] = [];
    wb.worksheets[0]?.eachRow((row) =>
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- same as above: text cells, text assertion, behaviour preserved.
      row.eachCell((cell) => cells.push(String(cell.value ?? ""))),
    );
    return cells.join(" | ");
  };
  const drawXlsx = await fetch(`${BASE}/api/v1/divisions/${div.id}/exports/timetable?format=xlsx`, {
    headers: { cookie: cookieHeader(admin) },
  });
  const drawText = await xlsxCellsToText(await drawXlsx.arrayBuffer());
  check(
    "exports timetable shows a placeholder's slot label, not TBD",
    drawXlsx.status === 200 && /Winner of /.test(drawText) && !/TBD vs TBD/.test(drawText),
  );

  // F4/P2: the subscribed calendar had no smoke coverage at all.
  const ics = await fetch(`${BASE}/shared/${proOrgSlug}/${comp.slug}/${div.slug}/calendar.ics`);
  const icsBody = await ics.text();
  check(
    "public .ics serves as text/calendar",
    ics.status === 200 && (ics.headers.get("content-type") ?? "").includes("text/calendar"),
  );
  check(
    "public .ics carries the day-one final as a tentative all-day event",
    icsBody.includes("STATUS:TENTATIVE") &&
      icsBody.includes("DTSTART;VALUE=DATE:") &&
      /SUMMARY:.*Winner of /.test(icsBody),
  );
  check(
    "public .ics keys the VEVENT UID on the fixture id",
    icsBody.includes(`UID:${finalFixtureId}@seazn.club`),
  );

  // B1 (owner ruling 2026-08-24): the OLD ?entrant= predicate excluded every
  // unresolved fixture by construction (both entrant ids null satisfies
  // neither `=== entrantId` comparison), so a subscribing player never
  // received the final they were heading toward. Reuses the same day-one KO
  // stage — one semi's own entrant is the subscriber; the still-unresolved
  // final is what the fix must add back to THEIR feed.
  const dayOneSemi = dayOneGen.fixtures.find((f) => f.home_entrant_id !== null);
  const entrantIcs = await fetch(
    `${BASE}/shared/${proOrgSlug}/${comp.slug}/${div.slug}/calendar.ics?entrant=${dayOneSemi?.home_entrant_id}`,
  );
  const entrantIcsBody = await entrantIcs.text();
  check(
    "public .ics ?entrant= feed still carries the subscriber's own fixture",
    entrantIcs.status === 200 && entrantIcsBody.includes(`UID:${dayOneSemi?.id}@seazn.club`),
  );
  check(
    "public .ics ?entrant= feed also carries the unresolved final that names neither side",
    entrantIcsBody.includes(`UID:${finalFixtureId}@seazn.club`),
  );

  // Backwards date ranges are refused server-side on BOTH endpoints the
  // organiser can reach them through. The panels now refuse first, in the
  // organiser's own language — these are the backstop for every other caller,
  // and the reason the client guards are an improvement in ergonomics rather
  // than the only thing standing between a user and a broken division.
  //
  // On a THROWAWAY division: the control runs write real settings, and doing
  // that to `div` would move the board every later check in this suite reads.
  const orderDiv = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: `Date order ${tag}`,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );

  // Schedule window (#498, `PutScheduleSettings`). Every field carries a
  // `.default()`, so a rejected PUT leaves a usable config behind and the only
  // symptom is silence — which is why this is asserted on the STATUS.
  const badWindow = await v1(admin, `/api/v1/divisions/${orderDiv.id}/schedule-settings`, "PUT", {
    config: { startAt: "2026-10-12T09:00:00Z", endAt: "2026-10-11T09:00:00Z" },
  });
  check("date order: a schedule window that ends before it starts is refused", badWindow.status >= 400);
  // The control run: identical shape, dates the right way round, same path.
  // Without it a blanket-broken endpoint would satisfy the assertion above.
  const goodWindow = await v1(admin, `/api/v1/divisions/${orderDiv.id}/schedule-settings`, "PUT", {
    config: { startAt: "2026-10-12T09:00:00Z", endAt: "2026-10-13T09:00:00Z" },
  });
  check("date order: the same window the right way round saves", goodWindow.status === 200);

  // Registration window (`registrations.ts`). `>=`, so the zero-length case
  // is refused too — a window that opens and closes at one instant accepts
  // nobody, which is a control that silently does not work.
  const regBase = {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    form_fields: [],
  };
  const badReg = await v1(admin, `/api/v1/divisions/${orderDiv.id}/registration-settings`, "PUT", {
    ...regBase,
    opens_at: "2026-10-12T18:00:00Z",
    closes_at: "2026-10-12T09:00:00Z",
  });
  check("date order: a registration window that closes before it opens is refused", badReg.status === 422);
  const zeroReg = await v1(admin, `/api/v1/divisions/${orderDiv.id}/registration-settings`, "PUT", {
    ...regBase,
    opens_at: "2026-10-12T09:00:00Z",
    closes_at: "2026-10-12T09:00:00Z",
  });
  check("date order: a zero-length registration window is refused too", zeroReg.status === 422);
  const goodReg = await v1(admin, `/api/v1/divisions/${orderDiv.id}/registration-settings`, "PUT", {
    ...regBase,
    opens_at: "2026-10-12T09:00:00Z",
    closes_at: "2026-10-12T18:00:00Z",
  });
  check("date order: the same registration window the right way round saves", goodReg.status === 200);

  // Matchday documents (v12, Task 17): the officials rota only emits duty
  // rows for fixtures carrying a live assignment (buildOfficialsRotaDoc
  // reads fixture_officials joined to still-scheduled fixtures) — assign one
  // before hitting the export so it renders the real content path, not just
  // the empty masthead. Same official/assign shape as the officials-unify
  // suite: POST /officials → PATCH the fixture's officials.
  const docOfficial = v1data<{ id: string }>(
    await v1(admin, "/api/v1/officials", "POST", {
      display_name: `Doc Umpire ${tag}`,
      role_keys: ["referee"],
    }),
  );
  const assignDocOfficial = await v1(admin, `/api/v1/fixtures/${fixture}/officials`, "PATCH", {
    set: [{ official_id: docOfficial.id, role_key: "referee", locked: false }],
  });
  check("doc-export official assigned to a fixture", assignDocOfficial.status === 200);
  const rotaPdf = await fetch(
    `${BASE}/api/v1/divisions/${div.id}/exports/officials_rota?format=pdf`,
    { headers: { cookie: cookieHeader(admin) } },
  );
  const rotaPdfBytes = Buffer.from(await rotaPdf.arrayBuffer());
  check(
    "exports officials rota PDF renders a valid PDF with a real duty row (pro)",
    rotaPdf.status === 200 &&
      (rotaPdf.headers.get("content-type") ?? "").includes("application/pdf") &&
      rotaPdfBytes.subarray(0, 5).toString() === "%PDF-" &&
      rotaPdfBytes.byteLength > 1024,
  );

  // Group F remainder (admit-tickets, commit 9a28c4e2c): this division's
  // entrants (above) were added directly, exactly like every division this
  // suite builds — `registrations` has zero rows for it. Admit tickets reads
  // `registrations`, not `entrants`, so it must refuse rather than render an
  // empty branded page as a 200 PDF.
  const ticketsRefused = await v1(admin, `/api/v1/competitions/${comp.id}/exports/tickets?format=pdf`);
  check(
    "exports admit tickets 422s TICKETS_NOT_AVAILABLE with no confirmed registrations (pro)",
    ticketsRefused.status === 422 && ticketsRefused.json.error?.code === "TICKETS_NOT_AVAILABLE",
  );

  // Reschedule with the current division seq — lands; replaying the same
  // (now stale) token 409s with SEQ_CONFLICT (v3/11 gap 10).
  const seq0 = v1data<{ seq: number }>(await v1(admin, `/api/v1/divisions/${div.id}`)).seq;
  const move = await v1(admin, `/api/v1/fixtures/${fixture}`, "PATCH", {
    scheduled_at: "2026-10-01T09:00:00.000Z",
    court_id: schedV3CourtA.id,
    expected_seq: Number(seq0),
  });
  check("sched seq-tokened reschedule lands", move.status === 200);
  const stale = await v1(admin, `/api/v1/fixtures/${fixture}`, "PATCH", {
    scheduled_at: "2026-10-01T10:00:00.000Z",
    court_id: schedV3CourtA.id,
    expected_seq: Number(seq0),
  });
  check(
    "sched stale seq 409s with SEQ_CONFLICT",
    stale.status === 409 && stale.json.error?.code === "SEQ_CONFLICT",
  );

  // Registration → SZ ref → public /r/[ref] page (pro org). RS001 deleted the
  // public submit endpoint this drove (POST .../register) — everything
  // downstream of a submission (the SZ ref, /r/[ref] resolving it, the
  // ticket.png render, confirming it, the admit-tickets PDF export it fed)
  // went with it, since nothing can create a registration through a live
  // public entry point until RS006 restores one. confirmRegistration and the
  // tickets export both still have unit coverage (registrations.test.ts);
  // this was their only end-to-end/PDF-render exercise. What survives here:
  // registration-settings still PUTs successfully.
  await v1(admin, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "gbp",
    form_fields: [],
  });

  // Honeypot (400) and GDPR no-consent (422) were both submit-time gates on
  // the same deleted endpoint — no surviving entry point to drive them
  // through, so both are gone with it. Owed back by RS006/RS007.

  // --- Dual payments (spec 2026-07-12): card gates (pro). The offline
  // mark-paid half (pending submit → confirm blocked 422 → mark-paid
  // confirms) needed a submitted registration to test any of; RS001 deleted
  // the endpoint that submits one, so that half is gone with it (unit
  // coverage for confirm/mark-paid survives in registrations.test.ts). Card
  // method gates below need no submission — they only exercise
  // registration-settings PUT — so they stay. ---
  const payDiv = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Paid Offline",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );

  // Card method gates: rejected without Connect, accepted once flipped.
  const cardPutNoConnect = await v1(
    admin,
    `/api/v1/divisions/${payDiv.id}/registration-settings`,
    "PUT",
    {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 500,
      currency: "gbp",
      form_fields: [],
      payment_method: "stripe",
    },
  );
  check("pay card method needs Connect (422)", cardPutNoConnect.status === 422);
  await setConnect(proOrgId, true);
  const cardPut = await v1(admin, `/api/v1/divisions/${payDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 500,
    currency: "gbp",
    form_fields: [],
    payment_method: "stripe",
  });
  check("pay card method saves with Connect", cardPut.status === 200);
  // "pay card submit holds a pending spot" and "pay waive confirms without
  // payment" both needed a submitted registration (the deleted endpoint) —
  // gone with it; waive's own unit coverage lives in registrations.test.ts.
  await setConnect(proOrgId, false);

  // --- Free path: fresh community owner ---
  const free = newSession();
  const freeVer = await signIn(free, `delivered+sched_free_${tag}@resend.dev`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const fComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sched Free ${tag}`,
      visibility: "public",
    }),
  );
  const fDiv = v1data<{ id: string; slug: string }>(
    await v1(free, `/api/v1/competitions/${fComp.id}/divisions`, "POST", {
      name: "Free Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(free, `/api/v1/divisions/${fDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "gbp",
    form_fields: [],
  });
  // "reg issues an SZ ref (free)" and "reg /r/[ref] resolves (free)" both
  // submitted through the now-deleted public endpoint — gone with it.
  // Community sees the division fixtures page (schedule list) fine.
  const fFixtures = await html(
    free,
    `/o/${freeOrg.slug}/c/${fComp.slug}/d/${fDiv.slug}?tab=fixtures`,
  );
  check("division fixtures page renders (free)", fFixtures.status === 200);

  // Competition Desk W2 (Task 4): the fixtures tab renders as a run sheet — a
  // day group only appears once at least one fixture is SCHEDULED
  // (`buildRunSheet` drops an empty/all-unscheduled division's sheet
  // entirely, spec "Error and empty states"), so this generates + times one
  // fixture on the SAME free-path division the check above already used.
  await v1(
    free,
    `/api/v1/divisions/${fDiv.id}/entrants`,
    "POST",
    ["Alpha", "Bravo"].map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const fStage = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${fDiv.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
  );
  const fGen = v1data<{ fixtures: { id: string }[] }>(
    await v1(free, `/api/v1/stages/${fStage.id}/generate`, "POST", {}),
  );
  await v1(free, `/api/v1/fixtures/${fGen.fixtures[0].id}`, "PATCH", {
    scheduled_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  });
  const runSheet = await html(free, `/o/${freeOrg.slug}/c/${fComp.slug}/d/${fDiv.slug}?tab=fixtures`);
  // Anchor on `="` — React serialises an omitted prop as `"$undefined"`, so a
  // bare `data-run-sheet-day` probe would pass in both states.
  check(
    "p56: fixtures tab renders the run sheet with a day group",
    runSheet.status === 200 && runSheet.body.includes('data-run-sheet-day="'),
  );

  // Dual payments on community: offline fees were always plan-free, and since
  // V310 (registration.paid on every plan) the CARD method is free too — the
  // platform monetises it through the higher community fee (5% vs pro's 2%
  // since V398; it was 8% vs 2%),
  // not by gating it. It still requires Connect, so it is refused UNTIL Connect
  // is live, then allowed.
  const fOffline = await v1(free, `/api/v1/divisions/${fDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 500,
    currency: "gbp",
    form_fields: [],
    payment_method: "offline",
  });
  check("pay offline fee allowed on community", fOffline.status === 200);
  await setConnect(freeVer.org_id, true);
  const fCard = await v1(free, `/api/v1/divisions/${fDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 500,
    currency: "gbp",
    form_fields: [],
    payment_method: "stripe",
  });
  check("pay card method allowed on community once Connect is live (V310)", fCard.status === 200);
  await setConnect(freeVer.org_id, false);
}
