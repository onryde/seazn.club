import { test, expect } from "@playwright/test";
import { TAG, apiJson, divisionPath } from "./helpers";

// Unified Add-Entrant: enroll an EXISTING team into a division from the UI
// (the "Existing team" mode), instead of re-running the CSV import.
test("enroll an existing team into a division via the UI", async ({ page }) => {
  // Seed a team by importing it (no Division column → directory only, no entry).
  const csv = `Club,Team,Player\nRiverside ${TAG},Riverside U12 ${TAG},Ada ${TAG}`;
  const up = await page.request.post("/api/v1/imports", {
    multipart: { file: { name: "p.csv", mimeType: "text/csv", buffer: Buffer.from(csv) } },
  });
  expect(up.status(), `import upload failed: ${await up.text()}`).toBeLessThan(300);
  const importId = ((await up.json()) as { data: { importId: string } }).data.importId;
  const committed = await page.request.post(`/api/v1/imports/${importId}/commit`, { data: {} });
  expect(committed.status(), `import COMMIT failed: ${await committed.text()}`).toBeLessThan(300);

  // A competition + division to enroll into.
  const comp = (await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Enroll ${TAG}`,
    visibility: "public",
  })).data!;
  const div = (await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  )).data!;

  // Give the club a crest so the badge-fallback contract is observable: the
  // team has no own logo, so its entrant row must wear the CLUB crest.
  const clubs = (await apiJson<{ id: string; name: string }[]>(page.request, "/api/v1/clubs")).data!;
  const club = clubs.find((c) => c.name === `Riverside ${TAG}`)!;
  await apiJson(page.request, `/api/v1/clubs/${club.id}`, "PATCH", {
    logo_path: "orgs/e2e/clubs/enroll-crest.png",
  });

  await page.goto(await divisionPath(page.request, div.id, "?tab=entrants"));
  await page.getByRole("button", { name: "Existing team" }).click();
  await page.getByRole("textbox", { name: "Search teams" }).fill(`Riverside U12 ${TAG}`);
  await page.getByText(`Riverside U12 ${TAG}`, { exact: true }).first().click();
  // The enroll form reads the squad it is about to copy. The sibling test
  // below drives the OTHER branch of this same element ("Team squad is
  // empty"), so the two together pin both states rather than one.
  await expect(page.getByTestId("squad-preview")).toContainText(
    "Team squad: 1 player will be copied to this entry.",
  );
  await page.getByRole("button", { name: /Enroll team/ }).click();

  // The team now appears as an entrant in the division table.
  const cell = page.getByRole("cell", { name: `Riverside U12 ${TAG}` });
  await expect(cell).toBeVisible();

  // Clubs W1 regression 1: the row wears the club crest (entrant has no own
  // badge, team has no own logo — the resolved logo map must fall through).
  await expect(cell.locator('img[src*="enroll-crest.png"]')).toBeVisible();

  // Clubs W1 regression 2: first-time enrollment seeds the entry's roster
  // from the team's persistent squad.
  //
  // This assertion has been wrong twice, in opposite directions, and both
  // are worth keeping in view. It began as a page-wide
  // `getByText(\`Ada ${TAG}\`)` under a comment claiming it proved the seed;
  // it did not. `entrants-panel.tsx` renders `persons.filter(...).slice(0, 6)`
  // as ADD-PLAYER SUGGESTIONS in the same subtree as the roster, so with a
  // small org directory "+ Ada <TAG>" was on screen and the page-wide probe
  // matched it. Read off the database, every team this spec had ever made
  // carried ZERO `team_members` rows — in the passing runs as much as the
  // failing one. It failed the day a neighbouring spec in the same shard
  // added four people and pushed Ada off the six.
  //
  // It was then narrowed to "the player is REACHABLE through the picker",
  // which was true but weaker than the product's own claim, because a
  // directory-only import genuinely did not fill the squad — noted at the
  // time as an open product question.
  //
  // The owner has since answered it: a `Club,Team,Player` row IS a statement
  // about that team's squad, and the import now writes `team_members`. So the
  // original claim is finally testable, and is asserted here properly scoped:
  // inside the roster's own box, Ada is a MEMBER — and the differential that
  // the old assertion lacked, `+ Ada` is NOT offered as a suggestion, because
  // `candidates` filters out anyone already on the roster. One of those two
  // can only be true if the seed really happened.
  await cell.getByRole("button", { name: new RegExp(`Riverside U12 ${TAG}`) }).click();
  const roster = page.getByTestId("entrant-roster");
  await expect(roster, "the roster editor did not open").toBeVisible();
  await expect(
    roster,
    "enrollment left the entry with no roster — the team's squad was empty",
  ).not.toContainText("No players on this roster.");
  await expect(
    roster.getByText(`Ada ${TAG}`, { exact: true }),
    "the imported player is not ON the seeded roster",
  ).toBeVisible();
  await expect(
    roster.getByRole("button", { name: `+ Ada ${TAG}` }),
    "Ada is still OFFERED for the roster, so she is not on it — this is the "
      + "exact false pass the page-wide probe used to produce",
  ).toHaveCount(0);
});

// Enrollment snapshots the squad ONCE; players added to the squad afterwards
// don't appear on the entry until the organiser syncs explicitly. This covers
// the empty-squad warning in the enroll form and the "Sync from team squad"
// action on the entrant row.
test("empty-squad enroll warns, then Sync from team squad pulls late players", async ({ page }) => {
  const teamName = `Latecomers ${TAG}`;
  const team = (await apiJson<{ id: string }>(page.request, "/api/v1/teams", "POST", {
    name: teamName,
  })).data!;

  const comp = (await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Sync ${TAG}`,
    visibility: "private",
  })).data!;
  const div = (await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  )).data!;

  // Enroll form: picking the squad-less team surfaces the empty-squad warning.
  await page.goto(await divisionPath(page.request, div.id, "?tab=entrants"));
  await page.getByRole("button", { name: "Existing team" }).click();
  await page.getByRole("textbox", { name: "Search teams" }).fill(teamName);
  await page.getByText(teamName, { exact: true }).first().click();
  await expect(page.getByTestId("squad-preview")).toContainText("Team squad is empty");
  await page.getByRole("button", { name: /Enroll team/ }).click();
  const cell = page.getByRole("cell", { name: teamName });
  await expect(cell).toBeVisible();

  // Squad filled AFTER enrollment; the entry roster is still the empty snapshot.
  const person = (await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
    full_name: `Late Joiner ${TAG}`,
    consent: {},
    dob: null,
    gender: null,
    external_ref: null,
  })).data!;
  await apiJson(page.request, `/api/v1/teams/${team.id}/squad`, "PUT", {
    members: [
      { person_id: person.id, squad_number: 9, default_position_key: null, is_captain: false, roles: [] },
    ],
  });

  // Expand the row → Sync from team squad → confirm → the late player appears.
  await cell.getByRole("button", { name: new RegExp(teamName) }).click();
  await page.getByRole("button", { name: "Sync from team squad" }).click();
  await page.getByRole("button", { name: "Sync roster" }).click();
  await expect(page.getByText(`Late Joiner ${TAG}`)).toBeVisible();
});
