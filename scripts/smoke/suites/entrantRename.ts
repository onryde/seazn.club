// The create-time entrant-name join — the entrant-rename suite derives every
// expected name with it rather than typing one. Dependency-free, like the above.
import { rosterDerivedName } from "../../../apps/web/src/lib/entrant-roster-name.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, smokeDb, html, v1, v1data } from "../harness.ts";

/**
 * An entrant's name after create (2026-09-22, reported from production: pair
 * "Sankar & Ritwik" swapped Ritwik for Venkatesh and kept the old name on every
 * page — `display_name` was derived once at create, and nothing could change
 * it afterwards).
 *
 * Smoke rather than only unit, because two of the claims live in the seam
 * between a write and a CACHED public page, which only a real server shows:
 *   1. a roster swap through the real PATCH route renames a pair whose name was
 *      derived from its people, and leaves a custom name alone;
 *   2. the public division page shows the new name on the very NEXT load.
 *      `patchEntrant` now expires the division's public tag; before, an entrant
 *      patch fired nothing and the page served the old name until its 30s cache
 *      ran out.
 * The control makes (2) mean something: a raw write that fires nothing is NOT
 * on the next load, so the page really is cached — without it, a page that
 * never cached at all would pass (2) vacuously.
 *
 * Every expected name is built by the create-time join itself
 * (`rosterDerivedName`), never typed. Own fresh free session: a community org
 * may publish one public competition, which is all this needs.
 */
export async function entrantRenameSuite(): Promise<void> {
  const free = newSession();
  const ver = await signIn(free, `delivered+rename_${tag}@resend.dev`);
  const orgs = (await call(free, "/api/orgs")) as { id: string; slug: string }[];
  const org = orgs.find((o) => o.id === ver.org_id)!;

  const comp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Rename Cup ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Doubles",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const person = async (fullName: string) => ({
    id: v1data<{ id: string }>(await v1(free, "/api/v1/persons", "POST", { full_name: fullName })).id,
    name: fullName,
  });
  const sankar = await person(`Sankar ${tag}`);
  const ritwik = await person(`Ritwik ${tag}`);
  const venkatesh = await person(`Venkatesh ${tag}`);
  const asha = await person(`Asha ${tag}`);
  const bilal = await person(`Bilal ${tag}`);
  const chen = await person(`Chen ${tag}`);
  const derivedName = rosterDerivedName([sankar.name, ritwik.name]);
  // Sankar keeps his seat; Venkatesh takes Ritwik's.
  const followedName = rosterDerivedName([sankar.name, venkatesh.name]);
  const customName = `Smash Bros ${tag}`;
  const controlName = `Control Pair ${tag}`;
  const members = (...people: { id: string }[]) => people.map((p) => ({ person_id: p.id }));

  const created = v1data<{ id: string; display_name: string }[]>(
    await v1(free, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "pair", display_name: derivedName, seed: 1, members: members(sankar, ritwik) },
      { kind: "pair", display_name: customName, seed: 2, members: members(asha, bilal) },
      { kind: "pair", display_name: `Third Pair ${tag}`, seed: 3 },
      { kind: "pair", display_name: `Fourth Pair ${tag}`, seed: 4 },
    ]),
  );
  const pairId = created.find((e) => e.display_name === derivedName)!.id;
  const customId = created.find((e) => e.display_name === customName)!.id;
  const thirdId = created.find((e) => e.display_name === `Third Pair ${tag}`)!.id;

  // Started, so the division's public page is live.
  const stage = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1, kind: "league", name: "L", config: {},
    }),
  );
  await v1(free, `/api/v1/stages/${stage.id}/generate`, "POST");
  await v1(free, `/api/v1/divisions/${div.id}/start`, "POST");

  const path = `/shared/${org.slug}/${comp.slug}/${div.slug}`;
  // React escapes "&" in text; match what the page actually serves.
  const served = (name: string) => name.replaceAll("&", "&amp;");
  const warm = await html(newSession(), path);
  check(
    `entrant rename: the public division page names the pair as created (status ${warm.status})`,
    warm.status === 200 && warm.body.includes(served(derivedName)),
  );

  // Control: a raw write behind the app's back fires no revalidation, so the
  // very next load must still show the OLD name — the page is cached.
  const db = smokeDb();
  try {
    await db`update entrants set display_name = ${controlName} where id = ${thirdId}`;
  } finally {
    await db.end();
  }
  const control = await html(newSession(), path);
  check(
    "entrant rename (control): a write that fires nothing is NOT on the next load — the public page is cached",
    control.status === 200 &&
      control.body.includes(`Third Pair ${tag}`) &&
      !control.body.includes(controlName),
  );

  // 1. The roster swap renames the derived pair, through the real route.
  const swapped = await v1(free, `/api/v1/entrants/${pairId}`, "PATCH", {
    members: members(sankar, venkatesh),
  });
  check(
    `entrant rename: a roster swap renames a pair whose name its people derived (got '${v1data<{ display_name: string }>(swapped)?.display_name}')`,
    swapped.status === 200 && v1data<{ display_name: string }>(swapped).display_name === followedName,
  );
  // …and never a custom one.
  const customSwap = await v1(free, `/api/v1/entrants/${customId}`, "PATCH", {
    members: members(asha, chen),
  });
  check(
    "entrant rename: a roster swap leaves a custom pair name exactly as the organiser wrote it",
    customSwap.status === 200 && v1data<{ display_name: string }>(customSwap).display_name === customName,
  );

  // 2. The next public load shows the new name, not the old one.
  const after = await html(newSession(), path);
  check(
    "entrant rename: the public division page shows the renamed pair on the very next load (no 30s cache lag)",
    after.status === 200 &&
      after.body.includes(served(followedName)) &&
      !after.body.includes(served(derivedName)),
  );

  // An explicit rename (the console's Name field) reaches the page the same way.
  const explicitName = `Court Kings ${tag}`;
  const renamed = await v1(free, `/api/v1/entrants/${pairId}`, "PATCH", { display_name: explicitName });
  const afterExplicit = await html(newSession(), path);
  check(
    "entrant rename: an explicit rename is on the public page at the next load",
    renamed.status === 200 &&
      afterExplicit.body.includes(explicitName) &&
      !afterExplicit.body.includes(served(followedName)),
  );
}
