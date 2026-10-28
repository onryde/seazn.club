// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/** v16 SPEC-2 org news over real HTTP. Pro path (org2 is Pro): an opted-in
 *  division auto-drafts a result post on the decided seam → the organiser lists
 *  it, publishes it, and the public feed / post page / story.png all serve.
 *  Free path (fresh community owner): a MANUAL post creates + publishes (free on
 *  every plan) and serves publicly, while the auto_posts toggle is gated 402
 *  (Pro news.auto). Seeds the decided fixture BEFORE asserting (empty-data
 *  false-green lesson). */
export async function newsSuite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  admin.cookies["seazn_org"] = proOrgId;
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `News ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "News Prem",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const toggle = await v1(admin, `/api/v1/divisions/${div.id}`, "PATCH", {
    auto_posts: true,
  });
  check("news pro: auto_posts toggle allowed (news.auto)", toggle.status === 200);

  await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: `NHome ${tag}`, seed: 1, members: [] },
    { kind: "individual", display_name: `NAway ${tag}`, seed: 2, members: [] },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const fx = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"),
  ).fixtures[0].id;
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");
  const st = v1data<{ last_seq: number }>(await v1(admin, `/api/v1/fixtures/${fx}/state`));
  await v1(admin, `/api/v1/fixtures/${fx}/events`, "POST", {
    expected_seq: st.last_seq,
    type: "generic.result",
    payload: { p1Score: 3, p2Score: 1 },
  });

  const drafts = v1data<{ id: string; kind: string; auto_source: unknown }[]>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/posts?status=draft`),
  );
  const auto = drafts.find((d) => d.kind === "result" && d.auto_source);
  check("news pro: a result post auto-drafted on the decided seam", !!auto);

  // A near-miss status must 400, not quietly return the UNFILTERED feed. This
  // route used to answer `?status=publish` with every post, drafts included,
  // while the caller believed it had filtered to published. Driven here rather
  // than in a unit test because the defect was the ROUTE ignoring its own
  // enum — a helper can be correct and never called.
  const badStatus = await v1(admin, `/api/v1/orgs/${proOrgId}/posts?status=publish`);
  check(
    "news: ?status=publish 400s instead of silently returning every post " +
      `(status=${badStatus.status})`,
    badStatus.status === 400,
  );
  check(
    "news: the 400 names the accepted values",
    ["draft", "published", "archived"].every((v) =>
      (badStatus.json.error?.message ?? "").includes(v),
    ),
  );

  // P3 (D7) — this division has exactly 2 entrants, so round 1 has exactly
  // one fixture: the SAME decided write that drafted the result post above
  // also completes the round, which should have auto-drafted a round_recap
  // alongside it. Its enrichment needs no player-level scorer data (unlike
  // topPerformers/leaderboardMoves) — biggestMargin reads the plain
  // generic.result score line directly, so this is the cheapest real proof
  // that enrichment is wired end to end in the deployed app, not just under
  // vitest.
  const recap = drafts.find((d) => d.kind === "round_recap" && d.auto_source);
  check("news pro: the same decided write also auto-drafts a round_recap (single-fixture round)", !!recap);
  if (recap) {
    const recapDetail = v1data<{ body_md: string }>(await v1(admin, `/api/v1/posts/${recap.id}`));
    check(
      "news pro (P3): round_recap draft carries an enriched biggest-result line",
      recapDetail.body_md.includes("Biggest result"),
    );
  }

  const pub = await v1(admin, `/api/v1/posts/${auto!.id}`, "PATCH", {
    action: "publish",
  });
  const pubData = v1data<{ status: string; slug: string }>(pub);
  check("news pro: draft publishes", pub.status === 200 && pubData.status === "published");

  const feed = await html(newSession(), `/shared/${proOrgSlug}/news`);
  check(
    "news pro: public feed 200 + shows a post card",
    feed.status === 200 && feed.body.includes("news-card"),
  );
  check(
    "news pro: feed carries the back-to-org link",
    feed.body.includes('data-testid="news-back"'),
  );
  const postPage = await html(newSession(), `/shared/${proOrgSlug}/news/${pubData.slug}`);
  check("news pro: public post page 200", postPage.status === 200);
  const story = await fetch(`${BASE}/shared/${proOrgSlug}/news/${pubData.slug}/story.png`);
  check(
    "news pro: story PNG 200 image/png",
    story.status === 200 && (story.headers.get("content-type") ?? "").includes("image/png"),
  );

  // Archive round-trip: off the public page, kept in ?status=archived, and
  // republish restores the same frozen slug (console Archived disclosure).
  const arch = await v1(admin, `/api/v1/posts/${auto!.id}`, "PATCH", {
    action: "archive",
  });
  check(
    "news pro: publish\u2192archive flips status",
    arch.status === 200 && v1data<{ status: string }>(arch).status === "archived",
  );
  const gonePage = await html(newSession(), `/shared/${proOrgSlug}/news/${pubData.slug}`);
  check("news pro: archived post page 404s publicly", gonePage.status === 404);
  const archList = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/posts?status=archived`),
  );
  check(
    "news pro: ?status=archived lists it",
    archList.some((x) => x.id === auto!.id),
  );
  const repub = v1data<{ status: string; slug: string }>(
    await v1(admin, `/api/v1/posts/${auto!.id}`, "PATCH", {
      action: "publish",
    }),
  );
  check(
    "news pro: republish restores published at the frozen slug",
    repub.status === "published" && repub.slug === pubData.slug,
  );
  const backPage = await html(newSession(), `/shared/${proOrgSlug}/news/${pubData.slug}`);
  check("news pro: republished page 200 again", backPage.status === 200);

  // P3 (D7) — the weekly digest button. Same news.auto entitlement as the
  // auto-drafts above; the org just decided a fixture this instant, so the
  // digest's [now-7d, now) window covers it and the standings-movement
  // section should have something to say too.
  const digest = await v1(admin, `/api/v1/orgs/${proOrgId}/posts/digest`, "POST");
  const digestData = v1data<{ id: string; kind: string; title: string; body_md: string }>(digest);
  check(
    "news pro (P3): Generate digest creates a weekly_digest draft (201)",
    digest.status === 201 && digestData.kind === "weekly_digest",
  );
  check("news pro (P3): digest title is non-empty", digestData.title.length > 0);
  const digestList = v1data<{ id: string; kind: string }[]>(
    await v1(admin, `/api/v1/orgs/${proOrgId}/posts?status=draft`),
  );
  check(
    "news pro (P3): the digest draft is listed among the org's drafts",
    digestList.some((d) => d.id === digestData.id && d.kind === "weekly_digest"),
  );

  // ---- Free path (fresh community owner) ----
  const commOwner = newSession();
  await signIn(commOwner, `delivered+newscomm_${tag}@resend.dev`);
  const commOrg = ((await call(commOwner, "/api/orgs")) as { id: string; slug: string }[])[0];
  commOwner.cookies["seazn_org"] = commOrg.id;

  const manual = await v1(commOwner, `/api/v1/orgs/${commOrg.id}/posts`, "POST", {
    title: `Free news ${tag}`,
    body_md: "Hello **world**.",
    kind: "announcement",
  });
  check("news free: manual post create (free on every plan)", manual.status === 201);
  const manualPub = v1data<{ slug: string; status: string }>(
    await v1(commOwner, `/api/v1/posts/${v1data<{ id: string }>(manual).id}`, "PATCH", {
      action: "publish",
    }),
  );
  check("news free: manual post publishes", manualPub.status === "published");
  const freePost = await html(newSession(), `/shared/${commOrg.slug}/news/${manualPub.slug}`);
  check("news free: manual post public page 200", freePost.status === 200);

  const freeComp = v1data<{ id: string }>(
    await v1(commOwner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Free news comp ${tag}`,
      visibility: "public",
    }),
  );
  const freeDiv = v1data<{ id: string }>(
    await v1(commOwner, `/api/v1/competitions/${freeComp.id}/divisions`, "POST", {
      name: "Div",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const freeToggle = await v1(commOwner, `/api/v1/divisions/${freeDiv.id}`, "PATCH", {
    auto_posts: true,
  });
  check("news free: auto_posts toggle gated 402 (Pro news.auto)", freeToggle.status === 402);

  // P3 (D7) — the digest button is gated the same way (news.auto).
  const freeDigest = await v1(commOwner, `/api/v1/orgs/${commOrg.id}/posts/digest`, "POST");
  check("news free (P3): Generate digest gated 402 (Pro news.auto)", freeDigest.status === 402);
}
