import postgres from "postgres";
// The overlay's sport palette, from the module `overlay-tokens.ts` re-exports
// it out of (`paletteFor = resolveSportPalette`). Imported by relative path for
// the same reason `@seazn/engine` is imported at all and `@/…` is not: this
// file's only import in `sport-theme.ts` is a type-only `CSSProperties`, so it
// loads under `node --experimental-strip-types`. Proven before relying on it.
import {
  SPORT_TOKENS,
  resolveSportPalette,
  sportCustomProperty,
} from "../../../apps/web/src/components/v2/scorepad/v3/sport-theme.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, ledger, timedFixture, html, v1, v1data } from "../harness.ts";

/** Override a BOOLEAN entitlement for one org, directly. Same SQL-flip convention
 *  as `setStaff`/`setConnect` above, and the same one `e2e/helpers.ts`'s
 *  `setBoolEntitlementOverrideSql` uses — `org_entitlement_overrides` carries
 *  both a `bool_value` and an `int_value`, and `hasFeature` reads the boolean.
 *
 *  There is no HTTP route for this that a non-staff owner can reach. Since
 *  V426 (Task 14b) every plan grants `streaming.overlay` — V402 had written it
 *  `false` on every plan, a dark rollout — so an override-false row is the only
 *  way left to switch the overlay route off. */
async function setBoolEntitlement(orgId: string, featureKey: string, value: boolean): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to write an entitlement override in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${orgId}, ${featureKey}, ${value}, 'smoke: stream overlay W1')
      on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  } finally {
    await sql.end();
  }
}

/** A LIVE hockey fixture with one card of every class, in an org of its own.
 *  Returns what the overlay route needs to be fetched. */
async function seedOverlayOrg(label: string, cards: boolean): Promise<{
  orgId: string;
  fixtureId: string;
}> {
  const owner = newSession();
  await signIn(owner, `delivered+overlay_${label}_${tag}@resend.dev`);
  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Overlay ${label} ${tag}`,
      visibility: "public",
    }),
  );
  const fx = await timedFixture(owner, comp.id, {
    name: `Overlay ${label}`,
    // HOCKEY, and it has to be. Only `hockey` and `icehockey` run on the
    // period kernel, and only the period kernel populates
    // `summary().detail.discipline` — football's `summary()` has no such key,
    // so a football fixture renders NO card chip however many cards its ledger
    // holds. Hockey is also the only sport whose three classes reach all three
    // chip tones at once (green → advisory, yellow → caution, red → dismissal).
    sport_key: "hockey",
    variant_key: "fih-outdoor",
    entrants: [
      { kind: "team", display_name: `Overlay Home ${tag}`, seed: 1 },
      { kind: "team", display_name: `Overlay Away ${tag}`, seed: 2 },
    ],
  });
  const led = ledger(owner, fx.fixtureId);
  const refused: string[] = [];
  const send = async (type: string, payload: unknown) => {
    const res = await led.send(type, payload);
    if (res.status !== 201) refused.push(`${type} -> ${res.status}`);
  };
  await send("core.start", {});
  if (cards) {
    // `person` is OPTIONAL on the suspension payload (period/kernel.ts), so no
    // roster is needed: the chip is painted off `classKey` alone.
    for (const cls of ["green", "yellow", "red"]) {
      await send("hockey.suspension.start", { by: fx.entrantIds[1], class: cls });
    }
  }
  check(`overlay smoke (${label}): every seed event was accepted${refused.length ? ` (${refused.join("; ")})` : ""}`, refused.length === 0);
  const orgs = (await call(owner, "/api/orgs")) as { id: string }[];
  return { orgId: orgs[0].id, fixtureId: fx.fixtureId };
}

/**
 * The overlay route over real HTTP (stream overlay W1, Task 8) — the smoke
 * `overlay-tokens.ts` was owed since T1: the module has no HTTP surface of its
 * own, so its palette could only ever be proven where it is painted.
 *
 * TWO ORGS, identical in every way except the entitlement, so the gate is a
 * differential rather than a claim: A rides its PLAN (V426 grants
 * `streaming.overlay` on every plan) and must answer 200 with the scorebug's
 * markup; B carries an override-false row and must be indistinguishable from a
 * missing fixture. B's row is written before ANY fetch and never changes — the
 * resolver caches for 300 s (`ENT_TTL_SECONDS`, lib/entitlements.ts), so a
 * "switch off and re-check" on one org would assert against a stale answer.
 */
export async function streamOverlaySuite(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("SKIP  stream overlay suite (DATABASE_URL not set — the override-false negative needs SQL)");
    return;
  }
  const entitled = await seedOverlayOrg("entitled", true);
  const denied = await seedOverlayOrg("denied", true);
  // Switched off BEFORE the first fetch: `resolve()` is cache-aside with a
  // 300 s TTL, and a 200 fetched first would still be cached when the override
  // landed. `entitled` gets NO row: its 200 below is its plan's V426 grant.
  await setBoolEntitlement(denied.orgId, "streaming.overlay", false);

  const anon = newSession();
  const shut = await html(anon, `/overlay/fixtures/${denied.fixtureId}?style=bar`);
  check(
    `overlay smoke: an override switches overlay off → 404, not a broken overlay (got ${shut.status})`,
    shut.status === 404,
  );

  const bar = await html(anon, `/overlay/fixtures/${entitled.fixtureId}?style=bar`);
  check(
    `overlay smoke: with no override the plan's own grant (V426) answers 200 (got ${bar.status})`,
    bar.status === 200,
  );
  check(
    "overlay smoke: the bar renders the live dot and one chip per card",
    bar.body.includes('data-testid="ovl-live-dot"') &&
      bar.body.split('data-testid="ovl-chip"').length - 1 === 3,
  );
  check(
    "overlay smoke: the segment renders no consent banner (OBS composites whatever is painted)",
    !bar.body.includes('data-testid="cookie-consent"'),
  );

  // `overlay-tokens.ts`'s own palette, reaching the wire. `resolveSportPalette`
  // IS `paletteFor` (that module exports it under the alias) — imported here
  // rather than retyped, so a palette revision moves this check with it.
  // `overlay-tokens.ts` itself cannot be imported by this script: it resolves
  // `@/…` aliases, which do not load under `node --experimental-strip-types`
  // (see this file's header on `@seazn/engine`). `sport-theme.ts`'s only import
  // is a type-only `CSSProperties`, so it does.
  const palette = resolveSportPalette("hockey");
  const missing = SPORT_TOKENS.filter(
    (token) => !bar.body.includes(`${sportCustomProperty(token)}:${palette[token]}`),
  );
  check(
    `overlay smoke: all seven --sport-* tokens reach the canvas for hockey${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
    missing.length === 0,
  );

  // --- W2 Task 1: the overlay endpoint's `recent` window, over real HTTP.
  //
  // The ONLY place this can be proven. `recent` is built in `server/overlay/`
  // from the fold's own void-resolved stream, projected per event type and
  // consent-resolved — four seams no unit test drives end to end, and the seeded
  // ledger above is exactly the shape it must survive: one `core.start` that
  // must NOT appear, three `hockey.suspension.start` that must, each carrying
  // its own class and the side it was recorded against.
  const overlayJson = await v1(anon, `/api/v1/public/fixtures/${entitled.fixtureId}/overlay`);
  const recent = v1data<{ recent?: { type: string; seq: number; payload: { side?: number; class?: string } }[] }>(
    overlayJson,
  ).recent;
  check(
    `overlay smoke: the overlay payload always carries a recent[] array (got ${typeof recent})`,
    Array.isArray(recent),
  );
  const suspensions = (recent ?? []).filter((e) => e.type === "hockey.suspension.start");
  check(
    `overlay smoke: recent[] carries the engine's OWN event types, kernel events excluded (${
      (recent ?? []).map((e) => e.type).join(", ") || "empty"
    })`,
    suspensions.length === 3 && !(recent ?? []).some((e) => e.type.startsWith("core.")),
  );
  check(
    "overlay smoke: recent[] is oldest-first and its seqs ascend",
    (recent ?? []).every((e, i, all) => i === 0 || all[i - 1].seq < e.seq),
  );
  check(
    `overlay smoke: each suspension projects its own class and the side it was recorded against (${
      suspensions.map((e) => `${e.payload.class}/${e.payload.side}`).join(" ")
    })`,
    suspensions.map((e) => e.payload.class).join(",") === "green,yellow,red" &&
      suspensions.every((e) => e.payload.side === 1),
  );
  const bug = await html(anon, `/overlay/fixtures/${entitled.fixtureId}?style=bug`);
  check(
    "overlay smoke: ?style= picks the theme server-side",
    bug.status === 200 &&
      bug.body.includes('data-style="bug"') &&
      bar.body.includes('data-style="bar"'),
  );
  // R2007 decision 2 (spec 2026-10-15 §4.4): `?template=` names the template, `?style=` stays its alias forever.
  // Hockey opens on `bug`, so `?template=bar` is the discriminating row (a route ignoring `?template=` lands on bug),
  // and `?template=bug&style=bar` proves template wins over the alias. Anchored on `="` (AGENTS.md: React serialises an
  // omitted prop as "$undefined", so a bare attribute probe passes in both states).
  const viaTemplate = await html(anon, `/overlay/fixtures/${entitled.fixtureId}?template=bar`);
  const bothParams = await html(anon, `/overlay/fixtures/${entitled.fixtureId}?template=bug&style=bar`);
  const viaStyle = await html(anon, `/overlay/fixtures/${entitled.fixtureId}?style=bar`);
  check(
    `overlay smoke: ?template= picks the template server-side, and wins over ?style= (got ${viaTemplate.status}/${bothParams.status})`,
    viaTemplate.status === 200 &&
      viaTemplate.body.includes('data-style="bar"') &&
      bothParams.status === 200 &&
      bothParams.body.includes('data-style="bug"'),
  );
  check(
    `overlay smoke: ?style= is still honoured as the alias (got ${viaStyle.status})`,
    viaStyle.status === 200 && viaStyle.body.includes('data-style="bar"'),
  );
  const junk = await html(anon, `/overlay/fixtures/${entitled.fixtureId}?style=nonsense`);
  check(
    `overlay smoke: an unusable ?style= falls back rather than taking a club off air (got ${junk.status})`,
    junk.status === 200 && junk.body.includes('data-style="bug"'),
  );

  const fr = await html(anon, `/overlay/fixtures/${entitled.fixtureId}?style=bar&lang=fr`);
  check(
    "overlay smoke: ?lang= reaches the theme's own copy",
    fr.status === 200 && fr.body.includes("En direct") && bar.body.includes(">Live<"),
  );
}
