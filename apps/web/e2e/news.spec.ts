import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// SPEC-2 news (PROMPT-83): on the shared Pro org, an opted-in division
// auto-drafts a result post on the decided seam. The organiser reviews it in the
// console News tab (⚡ auto chip), edits + publishes it, and the public feed +
// post page carry the scorebug, the share bar, and the downloadable story card.
// Serial: the second test reads the post the first one published.
test.describe.serial("org news", () => {
  let orgSlug: string;
  let postSlug: string;

  test("auto-draft → console review → publish → public scorebug", async ({ page }) => {
    const org = await activeOrg(page);
    orgSlug = org.slug;

    const comp = await apiJson<{ id: string; slug: string }>(
      page.request,
      "/api/v1/competitions",
      "POST",
      { ends_on: "2030-12-31", name: `News E2E ${TAG}`, visibility: "public" },
    );
    const div = await apiJson<{ id: string; slug: string }>(
      page.request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "News Prem",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const divId = div.data!.id;

    // Opt the division in (Pro news.auto on the shared org).
    const toggle = await apiJson(page.request, `/api/v1/divisions/${divId}`, "PATCH", {
      auto_posts: true,
    });
    expect(toggle.status).toBe(200);

    await apiJson(page.request, `/api/v1/divisions/${divId}/entrants`, "POST", [
      { kind: "individual", display_name: `Alpha ${TAG}`, seed: 1, members: [] },
      { kind: "individual", display_name: `Beta ${TAG}`, seed: 2, members: [] },
    ]);
    const stage = await apiJson<{ id: string }>(
      page.request,
      `/api/v1/divisions/${divId}/stages`,
      "POST",
      { seq: 1, kind: "league", name: "League" },
    );
    const gen = await apiJson<{ fixtures: { id: string }[] }>(
      page.request,
      `/api/v1/stages/${stage.data!.id}/generate`,
      "POST",
    );
    const fx = gen.data!.fixtures[0]!.id;
    await apiJson(page.request, `/api/v1/divisions/${divId}/start`, "POST");

    // Decide the fixture → the seam auto-drafts a result post.
    const st = await apiJson<{ last_seq: number }>(page.request, `/api/v1/fixtures/${fx}/state`);
    await apiJson(page.request, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: st.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 3, p2Score: 1 },
    });

    // P3 (D7) — the round_recap draft (same decided write, see the comment
    // below) should carry an enriched "biggest result" line: biggestMargin
    // needs only the plain score line already present here, no player-stat
    // model. Checked via the API, not the console composer's rich-text
    // ProseEditor — that editor's DOM is not a stable surface to pull a
    // markdown substring out of, and scripts/smoke.ts proves the same fact
    // the same way.
    const draftsAfterDecide = await apiJson<{ id: string; kind: string; body_md: string }[]>(
      page.request,
      `/api/v1/orgs/${org.id}/posts?status=draft`,
    );
    const recapPost = draftsAfterDecide.data!.find((d) => d.kind === "round_recap");
    expect(recapPost, "round_recap draft was not auto-drafted").toBeTruthy();
    expect(recapPost!.body_md).toContain("Biggest result");

    // Console News tab: the ⚡ auto RESULT draft is queued. Deciding the only
    // fixture also completes the round, so a round_recap draft lands in the
    // SAME transaction — identical created_at, uuid tiebreak, random order.
    // Select by the auto result title ("Alpha … 3–1 Beta …"), never .first():
    // publishing the recap by accident yields a post with kind=round_recap,
    // which renders no scorebug/story card and fails the second test.
    await page.goto(`/o/${orgSlug}/settings?tab=news`);
    await expect(page.getByTestId("news-tab")).toBeVisible();
    const draft = page
      .getByTestId("draft-row")
      .filter({ hasText: `Alpha ${TAG} 3–1 Beta ${TAG}` });
    await expect(draft).toBeVisible();
    await expect(draft.getByTestId("auto-chip")).toBeVisible();

    // Edit the headline (keep it a scoreline so it still renders a scorebug).
    await draft.getByRole("button", { name: /edit/i }).click();
    await expect(page.getByTestId("news-composer")).toBeVisible();
    const editedTitle = `Alpha ${TAG} 2–0 Beta ${TAG}`;
    await page.getByTestId("composer-title").fill(editedTitle);
    await page.getByTestId("composer-save").click();

    // Publish from the drafts queue — the result row now wears the edited title.
    await page
      .getByTestId("draft-row")
      .filter({ hasText: editedTitle })
      .getByTestId("draft-publish")
      .click();
    const published = page.getByTestId("published-row").filter({ hasText: editedTitle });
    await expect(published).toBeVisible();
    postSlug = await published
      .getByRole("link")
      .first()
      .getAttribute("href")
      .then((h) => (h ?? "").split("/news/")[1] ?? "");
    expect(postSlug).not.toBe("");
  });

  test("public feed card, post scorebug, share bar + downloadable story card", async ({ page }) => {
    // Feed lists the published post as a card.
    await page.goto(`/shared/${orgSlug}/news`);
    await expect(page.getByTestId("news-card").first()).toBeVisible();

    // Post page: the scorebug hero + the share bar, and a working story.png.
    await page.goto(`/shared/${orgSlug}/news/${postSlug}`);
    await expect(page.getByTestId("post-scorebug")).toBeVisible();
    await expect(page.getByRole("link", { name: /whatsapp/i })).toBeVisible();

    const download = page.getByTestId("news-download-card");
    await expect(download).toBeVisible();
    const storyHref = await download.getAttribute("href");
    const png = await page.request.get(storyHref!);
    expect(png.status()).toBe(200);
    expect(png.headers()["content-type"]).toContain("image/png");
  });
});

// P3 (D7) — the "Generate digest" button on the org posts admin page. Serial:
// the second test's non-dedup proof reads the draft count the first test left
// behind. Shares the same shared Pro org as "org news" above (news.auto is
// already live there), but works in its OWN competition/division so it does
// not race that describe's fixture.
test.describe.serial("weekly digest (P3 / D7)", () => {
  test("Generate digest button creates a draft with visible sections", async ({ page }) => {
    const org = await activeOrg(page);

    const comp = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Digest E2E ${TAG}`,
      visibility: "public",
    });
    const div = await apiJson<{ id: string }>(
      page.request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "Digest Prem",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const divId = div.data!.id;
    await apiJson(page.request, `/api/v1/divisions/${divId}/entrants`, "POST", [
      { kind: "individual", display_name: `Delta ${TAG}`, seed: 1, members: [] },
      { kind: "individual", display_name: `Echo ${TAG}`, seed: 2, members: [] },
    ]);
    const stage = await apiJson<{ id: string }>(
      page.request,
      `/api/v1/divisions/${divId}/stages`,
      "POST",
      { seq: 1, kind: "league", name: "League" },
    );
    const gen = await apiJson<{ fixtures: { id: string }[] }>(
      page.request,
      `/api/v1/stages/${stage.data!.id}/generate`,
      "POST",
    );
    const fx = gen.data!.fixtures[0]!.id;
    await apiJson(page.request, `/api/v1/divisions/${divId}/start`, "POST");
    const st = await apiJson<{ last_seq: number }>(page.request, `/api/v1/fixtures/${fx}/state`);
    // A decided fixture in the last-7-days window gives the digest's
    // standings-movement section something real to report.
    await apiJson(page.request, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: st.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 4, p2Score: 0 },
    });

    await page.goto(`/o/${org.slug}/settings?tab=news`);
    await expect(page.getByTestId("news-tab")).toBeVisible();

    // Pro org — the live button, never the PlanBadge upsell chip.
    const digestButton = page.getByTestId("news-generate-digest");
    await expect(digestButton).toBeVisible();
    await expect(page.getByTestId("news-digest-upsell")).toHaveCount(0);

    // Digests are deliberately NOT deduped (see V358's org_posts_auto_once
    // exemption), so a Playwright retry of this test leaves the previous
    // attempt's draft behind. Count first and assert the increase: a bare
    // toBeVisible() trips strict mode on the second row, and a `.first()`
    // would be satisfied by the OLD row without ever waiting for the new one.
    const digestRows = page.getByTestId("draft-row").filter({ hasText: "Weekly digest" });
    const rowsBefore = await digestRows.count();
    await digestButton.click();
    await expect(digestRows).toHaveCount(rowsBefore + 1, { timeout: 20_000 });

    const drafts = await apiJson<{ id: string; kind: string; body_md: string }[]>(
      page.request,
      `/api/v1/orgs/${org.id}/posts?status=draft`,
    );
    const digestPost = drafts.data!.find((d) => d.kind === "weekly_digest");
    expect(digestPost, "weekly_digest draft was not created").toBeTruthy();
    expect(digestPost!.body_md).toContain("Standings movement");
  });

  test("a second press creates a second, independent digest draft (not deduped)", async ({ page }) => {
    const org = await activeOrg(page);
    const before = await apiJson<{ id: string; kind: string }[]>(
      page.request,
      `/api/v1/orgs/${org.id}/posts?status=draft`,
    );
    const beforeCount = before.data!.filter((d) => d.kind === "weekly_digest").length;
    expect(beforeCount, "expected the prior test's digest draft to already exist").toBeGreaterThan(0);

    await page.goto(`/o/${org.slug}/settings?tab=news`);
    await expect(page.getByTestId("news-tab")).toBeVisible();
    const digestRows = page.getByTestId("draft-row").filter({ hasText: "Weekly digest" });
    const rowsBefore = await digestRows.count();
    await page.getByTestId("news-generate-digest").click();
    // Wait on the count RISING, not on `.first()` being visible — the prior
    // test already left a row, so `.first()` resolves immediately and the API
    // read below then races the server finishing this press's insert.
    await expect(digestRows).toHaveCount(rowsBefore + 1, { timeout: 20_000 });

    const after = await apiJson<{ id: string; kind: string }[]>(
      page.request,
      `/api/v1/orgs/${org.id}/posts?status=draft`,
    );
    const afterCount = after.data!.filter((d) => d.kind === "weekly_digest").length;
    expect(afterCount).toBe(beforeCount + 1);
  });
});
