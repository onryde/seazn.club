import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, call, check, signIn, tag, v1, v1data } from "../harness.ts";

/** v16 SPEC-3 marks & reports over real HTTP. Pro path (org2): create a
 *  decided fixture with an accepted official → rate it 1..5 (204) → the org
 *  profile summary reflects the average → the official files + submits a
 *  report (free portal) → the organiser console reads it. Free path (fresh
 *  community owner): the same decided-fixture setup, then the mark PUT is
 *  gated 402 while the report still files. Seeds the assignment + decided
 *  fixture BEFORE asserting (empty-data false-green lesson). */
export async function marksReportsSuite(
  admin: Session,
  proOrgId: string,
  _proOrgSlug: string,
): Promise<void> {
  // The fixture_officials surrogate id is never exposed by the API (the
  // console reads it server-side); the smoke reads it over its own connection,
  // same ad-hoc convention as checkOfficialClaimed.
  async function foId(fixtureId: string, officialId: string): Promise<string | null> {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const sql = postgres(url, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
      prepare: !url.includes(":6543"),
      max: 1,
    });
    try {
      const [r] = await sql<{ id: string }[]>`
        select id from fixture_officials
        where fixture_id = ${fixtureId} and official_id = ${officialId} limit 1`;
      return r?.id ?? null;
    } finally {
      await sql.end();
    }
  }

  // Build a decided fixture whose official has ACCEPTED (the mark + report
  // window). Returns the fixture id + official id + the ref's session.
  async function decidedFixtureWithOfficial(
    owner: Session,
    ownerOrgId: string,
    label: string,
  ): Promise<{ fx: string; offId: string; ref: Session }> {
    owner.cookies["seazn_org"] = ownerOrgId;
    const comp = v1data<{ id: string; slug: string }>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `Marks ${label} ${tag}`,
        visibility: "public",
      }),
    );
    const div = v1data<{ id: string; slug: string }>(
      await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
    await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      {
        kind: "individual",
        display_name: `MA ${label} ${tag}`,
        seed: 1,
        members: [],
      },
      {
        kind: "individual",
        display_name: `MB ${label} ${tag}`,
        seed: 2,
        members: [],
      },
    ]);
    const stage = v1data<{ id: string }>(
      await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "League",
      }),
    );
    const fx = v1data<{ fixtures: { id: string }[] }>(
      await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST"),
    ).fixtures[0].id;
    await v1(owner, `/api/v1/divisions/${div.id}/start`, "POST");
    const offId = v1data<{ id: string }>(
      await v1(owner, "/api/v1/officials", "POST", {
        display_name: `Mark Ref ${label} ${tag}`,
        role_keys: ["referee"],
      }),
    ).id;
    await v1(owner, `/api/v1/fixtures/${fx}/officials`, "PATCH", {
      set: [{ official_id: offId, role_key: "referee", locked: false }],
    });
    const refEmail = `delivered+marksref_${label}_${tag}@resend.dev`;
    const ref = newSession();
    await signIn(ref, refEmail);
    const inv = await v1(owner, `/api/v1/officials/${offId}/invite`, "POST", {
      email: refEmail,
    });
    const token = (v1data<{ claim_url: string }>(inv).claim_url ?? "").split("/claim/")[1];
    await call(ref, `/api/claims/${token}/accept`, "POST");
    await v1(ref, `/api/v1/me/fixtures/${fx}/officiating-response`, "PATCH", {
      response: "accepted",
    });
    // The accepted official scores a generic result → the fixture decides
    // (engine-db integration: generic.result → status 'decided').
    const st = v1data<{ last_seq: number }>(await v1(ref, `/api/v1/fixtures/${fx}/state`));
    await v1(ref, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: st.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    return { fx, offId, ref };
  }

  // ---- Pro path (org2 is Pro here) ----
  const pro = await decidedFixtureWithOfficial(admin, proOrgId, "Pro");
  const proFoId = await foId(pro.fx, pro.offId);
  check("marks: surrogate assignment id resolvable", !!proFoId);
  admin.cookies["seazn_org"] = proOrgId;
  const putMark = await v1(admin, `/api/v1/fixture-officials/${proFoId}/mark`, "PUT", { mark: 4 });
  check("marks pro: rate an accepted, decided official (204)", putMark.status === 204);
  const summary = v1data<{ average: number | null; count: number }>(
    await v1(admin, `/api/v1/officials/${pro.offId}/marks-summary`),
  );
  check(
    "marks pro: profile summary average reflects the mark",
    summary.count === 1 && summary.average === 4,
  );

  // Report (free portal, ungated even on a Pro org): the official files + submits.
  const draft = await v1(pro.ref, `/api/v1/me/officiating/${proFoId}/report`, "PUT", {
    body: "tidy game",
    incidents: [{ kind: "other", note: "smoke note" }],
  });
  check(
    "report: draft saves (free portal)",
    draft.status === 200 && v1data<{ status: string }>(draft).status === "draft",
  );
  const submitted = await v1(pro.ref, `/api/v1/me/officiating/${proFoId}/report/submit`, "POST");
  check(
    "report: submit is final",
    submitted.status === 200 && v1data<{ status: string }>(submitted).status === "submitted",
  );
  const fixReports = v1data<{ status: string }[]>(
    await v1(admin, `/api/v1/fixtures/${pro.fx}/reports`),
  );
  check(
    "report: organiser console reads the submitted report",
    Array.isArray(fixReports) && fixReports.length === 1,
  );

  // ---- Free path (fresh community owner) ----
  const commOwner = newSession();
  await signIn(commOwner, `delivered+markscomm_${tag}@resend.dev`);
  const commOrgId = ((await call(commOwner, "/api/orgs")) as { id: string }[])[0].id;
  const free = await decidedFixtureWithOfficial(commOwner, commOrgId, "Free");
  const freeFoId = await foId(free.fx, free.offId);
  commOwner.cookies["seazn_org"] = commOrgId;
  const freeMark = await v1(commOwner, `/api/v1/fixture-officials/${freeFoId}/mark`, "PUT", {
    mark: 3,
  });
  check(
    "marks free: rating is ungated on community (204, officials.marks #253)",
    freeMark.status === 204,
  );
  const freeDraft = await v1(free.ref, `/api/v1/me/officiating/${freeFoId}/report`, "PUT", {
    body: "community game",
    incidents: [],
  });
  const freeSubmit = await v1(free.ref, `/api/v1/me/officiating/${freeFoId}/report/submit`, "POST");
  check(
    "report free: files + submits on a community org (portal is free)",
    freeDraft.status === 200 &&
      freeSubmit.status === 200 &&
      v1data<{ status: string }>(freeSubmit).status === "submitted",
  );
}
