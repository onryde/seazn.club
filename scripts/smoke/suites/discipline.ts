// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/** SPEC-1 discipline (PROMPT-79): Pro org auto-accumulates a 5-yellow ban the
 *  organiser confirms (→ active + public strip); a free org gets 402 on the
 *  rules PUT and a PlusReveal on the Discipline tab. Cards must be seeded
 *  BEFORE checking (empty-doc false-green lesson). */
export async function disciplineSuite(
  admin: Session,
  proOrgId: string,
  proOrgSlug: string,
): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;

  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Discipline Cup ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Prem",
      sport_key: "football",
      variant_key: "11-a-side",
    }),
  );
  check("disc: football division created", !!div.id);

  const player = v1data<{ id: string }>(
    await v1(admin, "/api/v1/persons", "POST", {
      full_name: `Card Magnet ${tag}`,
      consent: { public_name: true },
    }),
  );
  const ents = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      {
        kind: "team",
        display_name: `Rovers ${tag}`,
        seed: 1,
        members: [{ person_id: player.id }],
      },
      { kind: "team", display_name: `City ${tag}`, seed: 2 },
    ]),
  );
  const rovers = ents[0].id;

  // Enable rules (FA default shape) — 5 yellows → 1 match.
  const put = await v1(admin, `/api/v1/divisions/${div.id}/discipline-rules`, "PUT", {
    enabled: true,
    rules: {
      accumulation: [
        { key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 },
        { key: "yellow_10", color: "yellow", count: 10, ban_matches: 2 },
      ],
      dismissal: [
        { key: "second_yellow", color: "second_yellow", ban_matches: 1 },
        { key: "red", color: "red", ban_matches: 1 },
      ],
    },
  });
  check(
    "disc: pro enables rules",
    put.status === 200 && v1data<{ enabled: boolean }>(put).enabled === true,
  );

  // League with 5 legs → 5 Rovers-vs-City fixtures.
  const stageId = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
      config: { legs: 5 },
    }),
  ).id;
  const fixtures = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stageId}/generate`, "POST"),
  ).fixtures;
  check("disc: 5 fixtures generated (legs:5)", fixtures.length === 5);
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");

  // Seed one yellow per fixture — lineup must carry the player for the card.
  for (const fx of fixtures) {
    await v1(admin, `/api/v1/fixtures/${fx.id}/lineups/${rovers}`, "PUT", {
      slots: [
        {
          person_id: player.id,
          slot: "starting",
          position_key: "FW",
          order_no: 1,
          roles: [],
        },
      ],
    });
    const started = await v1(admin, `/api/v1/fixtures/${fx.id}/events`, "POST", {
      expected_seq: 0,
      type: "core.start",
      payload: {},
    });
    const seq = v1data<{ seq: number }>(started).seq;
    await v1(admin, `/api/v1/fixtures/${fx.id}/events`, "POST", {
      expected_seq: seq,
      type: "football.card",
      payload: { by: rovers, person: player.id, color: "yellow" },
    });
  }

  const pending = v1data<{ id: string; status: string; source: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/suspensions?status=pending`),
  );
  const auto = pending.find((s) => s.source === "auto_accumulation");
  check("disc: 5 yellows raise a pending accumulation ban", !!auto);

  // Same guard as the news feed above: an unrecognised ?status= is refused
  // rather than widened. Serving served and waived bans to a caller who asked
  // for pending is a worse answer than an error.
  const badSusp = await v1(admin, `/api/v1/divisions/${div.id}/suspensions?status=pendign`);
  check(
    "disc: a misspelled ?status= 400s instead of listing every suspension " +
      `(status=${badSusp.status})`,
    badSusp.status === 400,
  );

  if (auto) {
    const confirmed = await v1(admin, `/api/v1/suspensions/${auto.id}`, "PATCH", {
      kind: "confirm",
    });
    check(
      "disc: confirm activates the ban",
      v1data<{ status: string }>(confirmed).status === "active",
    );
  }
  const active = v1data<{ status: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/suspensions?status=active`),
  );
  check("disc: ban listed active after confirm", active.length >= 1);

  const pub = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}/${div.slug}`);
  check(
    "disc: public suspensions strip shows the ban",
    pub.status === 200 && pub.body.includes("Suspensions") && pub.body.includes("to serve"),
  );

  // --- Free path: 402 on the rules PUT + PlusReveal on the Discipline tab ---
  const free = newSession();
  await signIn(free, `delivered+disc_free_${tag}@resend.dev`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs[0];
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Free Disc ${tag}`,
      visibility: "public",
    }),
  );
  const freeDiv = v1data<{ id: string; slug: string }>(
    await v1(free, `/api/v1/competitions/${freeComp.id}/divisions`, "POST", {
      name: "Sunday",
      sport_key: "football",
      variant_key: "11-a-side",
    }),
  );
  const freePut = await v1(free, `/api/v1/divisions/${freeDiv.id}/discipline-rules`, "PUT", {
    enabled: true,
    rules: { accumulation: [], dismissal: [] },
  });
  check("disc: free rules PUT → 402", freePut.status === 402);
  const freeTab = await html(
    free,
    `/o/${freeOrg.slug}/c/${freeComp.slug}/d/${freeDiv.slug}?tab=discipline`,
  );
  check(
    "disc: free Discipline tab shows the PlusReveal",
    freeTab.status === 200 && freeTab.body.includes("discipline.enforced"),
  );
}
