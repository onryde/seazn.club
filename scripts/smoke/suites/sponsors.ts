// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { createHmac } from "node:crypto";
import {
  BASE, CONNECT_TEST_ACCOUNT, type Session, newSession, call, check, signIn, tag, setConnect, pageRedirect, html, v1, v1data, smokeDb,
  ledger, timedFixture,
} from "../harness.ts";
import { SPONSOR_SHORT_CODE_PATTERN } from "../../../apps/web/src/lib/sponsor-short-code.ts";

/** The compositor's job token, as `mintRelayToken` writes it (apps/web/src/server/relay/tokens.ts): HS256 over AUTH_SECRET,
 *  audience `seazn-relay`, `{ sid, scope: "relay-job" }`. Hand-rolled (no jose in this process): smoke has no Machine, and
 *  the server shares the job's AUTH_SECRET. */
function relayJobToken(sid: string, secret: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const signed = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sid, scope: "relay-job", aud: "seazn-relay", iat: now, exp: now + 600 })}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

type SmokePlan = {
  cards: { id: string; shortCode: string | null }[];
  airings: { momentId: string; seq: number; cardId: string; style: string; breakKind: string }[];
} | null;

/**
 * R4 S15 — the sponsor-on-stream rows owed by S5, S8, S9 and S10, on a real server, each able to fail:
 *   S5   overlay: sponsorPlan present on a seeded live fixture with a ticked sponsor
 *   S8   relay: heartbeat with airings answers 200 (and the airing row is read back)
 *   S9   relay: frame with a bad token → 401 (positive pair: the SAME frame with the job token gets past it, to 413)
 *   S10  /s/<id>?f=&src=match, /s/<CODE> and HEAD /s/<id>
 * The composed session is written straight to its table: smoke has no Machine, and the only composed start a smoke server
 * admits runs on the second (compositor-image) server, inside captureV2. Retired at the end, so the later relay-sweep row
 * never finds a live session with no Machine behind it.
 */
async function sponsorStreamRows(admin: Session, proOrgId: string, competitionId: string, goldId: string): Promise<void> {
  const vb = await timedFixture(admin, competitionId, {
    name: `Sponsor VB ${tag}`,
    sport_key: "volleyball",
    variant_key: "indoor",
    entrants: [
      { kind: "team", display_name: `Sponsor Home ${tag}`, seed: 1 },
      { kind: "team", display_name: `Sponsor Away ${tag}`, seed: 2 },
    ],
  });
  const led = ledger(admin, vb.fixtureId);
  const started = await led.send("core.start", {});
  // Indoor set 1 is to 25: one summary closes it, and a closed set opens the sport's set_end break (the engine's opensAt).
  const setClosed = await led.send("volleyball.set.summary", { home: 25, away: 20 });
  const overlay = await v1(newSession(), `/api/v1/public/fixtures/${vb.fixtureId}/overlay`);
  const plan = overlay.status === 200 ? v1data<{ sponsorPlan: SmokePlan }>(overlay).sponsorPlan : null;
  const card = plan?.cards[0];
  const airing = plan?.airings[0];
  check(
    "overlay: sponsorPlan present on a seeded live fixture with a ticked sponsor",
    started.status === 201 && setClosed.status === 201 && card?.id === goldId && SPONSOR_SHORT_CODE_PATTERN.test(card?.shortCode ?? "") &&
      airing?.cardId === goldId && airing.breakKind === "set_end" && airing.momentId === `${led.seq}:sponsor.set_end`,
  );

  const secret = process.env.AUTH_SECRET ?? "";
  const db = smokeDb();
  let sid: string | null = null;
  try {
    const [target] = await db<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${proOrgId}, 'youtube', ${`Sponsor beat ${tag}`}, ${Buffer.from("smoke")})
      returning id`;
    const [owner] = await db<{ user_id: string }[]>`select user_id from org_members where org_id = ${proOrgId} order by created_at limit 1`;
    const [session] = await db<{ id: string }[]>`
      insert into fixture_stream_sessions (org_id, fixture_id, mode, state, runner_state, target_id, sport_key, competition_id, division_id,
                                           entitlement_via_override, created_by)
      values (${proOrgId}, ${vb.fixtureId}, 'composed', 'live', 'playing', ${target.id}, 'volleyball', ${competitionId}, ${vb.divisionId},
              false, ${owner.user_id})
      returning id`;
    sid = session.id;
    const jobToken = relayJobToken(sid, secret);
    const beat = (body: unknown) =>
      fetch(`${BASE}/api/internal/relay/sessions/${sid}/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${jobToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // The page's two lines for the plan's airing, as SC1 converts them: a start on one beat, its end on the next.
    const startBeat = airing
      ? await beat({ state: "playing", airings: [{ kind: "start", momentId: airing.momentId, cardId: airing.cardId, style: airing.style, source: "rotation", breakKind: airing.breakKind, at: new Date().toISOString() }] })
      : null;
    const endBeat = airing
      ? await beat({ state: "playing", airings: [{ kind: "end", momentId: airing.momentId, at: new Date().toISOString(), cutShort: false }] })
      : null;
    const rows = await db<{ sponsor_id: string | null; break_kind: string | null; closed: boolean }[]>`
      select sponsor_id, break_kind, ended_at is not null as closed from sponsor_airings where session_id = ${sid}`;
    check(
      "relay: heartbeat with airings answers 200",
      secret !== "" && startBeat?.status === 200 && endBeat?.status === 200 &&
        rows.length === 1 && rows[0].sponsor_id === goldId && rows[0].break_kind === "set_end" && rows[0].closed,
    );

    // A frame over the bound, so the good token's answer is the body's refusal (413) — never a stored JPEG — and the bad
    // token's 401 is the token's alone. "Bad" = well-formed and signed, with the wrong secret.
    const frame = (token: string) =>
      fetch(`${BASE}/api/internal/relay/sessions/${sid}/airings/${encodeURIComponent(airing?.momentId ?? "0:sponsor.set_end")}/frame`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg" },
        body: new Uint8Array(262_145),
      });
    const refused = await frame(relayJobToken(sid, `${secret}-not-it`));
    const passed = await frame(jobToken);
    check("relay: frame with a bad token → 401", refused.status === 401 && passed.status === 413);
  } finally {
    // Retire the hand-seeded session the way the relay's own end leaves one: `completed` AND `runner_state = 'destroyed'`.
    // The relay sweep (relay-sweep.ts) picks up any session whose runner is not 'none'/'destroyed', whatever its state,
    // so a completed row still `playing` would be swept as a live Machine that smoke never started.
    if (sid) await db`update fixture_stream_sessions set state = 'completed', desired_state = 'ending', runner_state = 'destroyed' where id = ${sid}`;
    await db.end();
  }

  // S10: the board's tagged link, the stream code, and HEAD (a link preview, I3: never a click). The HEAD goes FIRST. Two
  // fences then prove it wrote nothing: once the tagged click's row has landed, the total is before + 1; once the code's
  // row has landed too, before + 2. A HEAD row that landed late still trips the second.
  const clicks = smokeDb();
  try {
    const count = async (where: { fixture?: string; source?: string } = {}) => {
      const [{ n }] = await clicks<{ n: number }[]>`
        select count(*)::int as n from sponsor_clicks
         where sponsor_id = ${goldId}
           and (${where.fixture ?? null}::uuid is null or fixture_id = ${where.fixture ?? null}::uuid)
           and (${where.source ?? null}::text is null or source = ${where.source ?? null}::text)`;
      return n;
    };
    const landed = async (where: { fixture: string; source: string }) => {
      for (let i = 0; i < 20; i++) {
        if ((await count(where)) === 1) return true;
        await new Promise((r) => setTimeout(r, 300));
      }
      return false;
    };
    const before = await count();
    const head = await fetch(`${BASE}/s/${goldId}`, { method: "HEAD", redirect: "manual" });
    const tagged = await pageRedirect(newSession(), `/s/${goldId}?f=${vb.fixtureId}&src=match`);
    check(
      "sponsors: /s/<id>?f=&src=match 302s to the sponsor and records a match click on that fixture",
      tagged.status === 302 && (tagged.location ?? "").startsWith("https://goldco.example") && (await landed({ fixture: vb.fixtureId, source: "match" })),
    );
    const afterTagged = await count();
    const coded = await pageRedirect(newSession(), `/s/${card?.shortCode ?? "NOCODE"}`);
    const codeLanded = await landed({ fixture: vb.fixtureId, source: "stream" });
    check(
      "sponsors: /s/<CODE> 302s to the sponsor and records a stream click on the code's fixture",
      coded.status === 302 && (coded.location ?? "").startsWith("https://goldco.example") && codeLanded,
    );
    const afterCode = await count();
    check(
      "sponsors: HEAD /s/<id> 302s and records no click (both fences)",
      head.status === 302 && afterTagged === before + 1 && codeLanded && afterCode === before + 2,
    );
  } finally {
    await clicks.end();
  }
}

/** v10 sponsor CRM smoke: tiered manager + public placement + tracked click
 *  on the pro org; free path keeps the flat partner strip and gets 402 on
 *  tiers/packages. Checkout runs the order-first Connect rail; keyless envs
 *  assert the 409 gate + order insert (webhook activation is unit-tested —
 *  smoke can't complete a hosted card payment). */
export async function sponsorsSuite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  // --- Pro path: tiers, per-competition scoping, placement, click tracking.
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sponsor Cup ${tag}`,
      visibility: "public",
    }),
  );
  const gold = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", {
    name: `Goldco ${tag}`,
    tier: "gold",
    url: "https://goldco.example",
  });
  check("sp pro creates a gold sponsor", gold.status === 201);
  const goldId = v1data<{ id: string }>(gold).id;
  const scoped = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", {
    name: `Cup Title ${tag}`,
    tier: "title",
    competition_id: comp.id,
  });
  check("sp pro creates a competition-scoped title sponsor", scoped.status === 201);

  const shared = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}`);
  check(
    "sp public page renders the perimeter board (title leads)",
    shared.status === 200 &&
      shared.body.includes("Presented by") &&
      shared.body.includes(`Cup Title ${tag}`) &&
      shared.body.includes(`Goldco ${tag}`),
  );
  check("sp public logo links via tracked redirect", shared.body.includes(`/s/${goldId}`));

  const click = await pageRedirect(newSession(), `/s/${goldId}`);
  // Response.redirect normalizes the URL (adds the trailing slash).
  check(
    "sp click 302s to the sponsor url",
    click.status === 302 && (click.location ?? "").startsWith("https://goldco.example"),
  );
  // The bump is deferred() tail work — it lands after the 302 by design, so
  // poll briefly instead of racing it (CI runners lose the instant read).
  let clicked = false;
  for (let i = 0; i < 10 && !clicked; i++) {
    const afterClick = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`);
    clicked =
      v1data<{ id: string; click_count: number }[]>(afterClick).find((s) => s.id === goldId)
        ?.click_count === 1;
    if (!clicked) await new Promise((r) => setTimeout(r, 300));
  }
  check("sp click_count incremented", clicked);

  // --- R4 S12: the On stream tab's two writes, read back off the page that shows them. There is no GET for the settings (the
  // tab reads them server-side), so the round trip is PUT -> the tab's own markup: the dial and switch are `role=radio` /
  // `role=switch` buttons whose `aria-checked` is the server's stored value.
  const streamUrl = `/api/v1/orgs/${proOrgId}/sponsor-stream-settings`;
  const tabTag = (body: string, testid: string): string => new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`).exec(body)?.[0] ?? "";
  const dialOf = (body: string): string[] => ["light", "normal", "busy"].filter((f) => /aria-checked="true"/.test(tabTag(body, `on-stream-dial-${f}`)));
  const switchOn = (body: string): boolean => /aria-checked="true"/.test(tabTag(body, "on-stream-switch"));
  const put = async (competitionId: string | null, enabled: boolean, frequency: string) =>
    v1(admin, streamUrl, "PUT", { competitionId, enabled, frequency });

  const tickRes = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors/${goldId}`, "PATCH", { on_stream: true });
  check("sponsors: tick PATCH on_stream answers 200 and the row carries it", tickRes.status === 200 && v1data<{ on_stream: boolean }>(tickRes).on_stream === true);
  const afterTick = await html(admin, `/o/${proOrgSlug}/sponsors?tab=on_stream`);
  check(
    "sponsors: the first tick turned the rotation on at Normal (R12), read off the tab",
    afterTick.status === 200 && switchOn(afterTick.body) && dialOf(afterTick.body).join() === "normal",
  );
  const light = await put(null, true, "light");
  check("sponsors: settings PUT answers 200 with the saved setting", light.status === 200 && v1data<{ frequency: string }>(light).frequency === "light");
  const readLight = await html(admin, `/o/${proOrgSlug}/sponsors?tab=on_stream`);
  check("sponsors: settings PUT round-trips (org scope, Light)", dialOf(readLight.body).join() === "light" && switchOn(readLight.body));
  check("sponsors: a second PUT replaces it (Busy, switched off)", (await put(null, false, "busy")).status === 200);
  const readBusy = await html(admin, `/o/${proOrgSlug}/sponsors?tab=on_stream`);
  check("sponsors: settings PUT round-trips again (org scope, Busy, off)", dialOf(readBusy.body).join() === "busy" && !switchOn(readBusy.body));
  check("sponsors: a competition scope PUT answers 200", (await put(comp.id, true, "normal")).status === 200);
  const readComp = await html(admin, `/o/${proOrgSlug}/sponsors?tab=on_stream&scope=${comp.id}`);
  // The org page is read AGAIN, after the competition write: an earlier body would stay Busy/off whatever that write did to it.
  const readOrgAfter = await html(admin, `/o/${proOrgSlug}/sponsors?tab=on_stream`);
  check("sponsors: the competition keeps its own row (Normal, on)", dialOf(readComp.body).join() === "normal" && switchOn(readComp.body));
  check("sponsors: ...while the org, read again after that write, stays Busy, off", dialOf(readOrgAfter.body).join() === "busy" && !switchOn(readOrgAfter.body));
  check("sponsors: an unknown frequency is refused (400)", (await put(null, true, "loud")).status === 400);

  // --- R4 S13: the Overview reads the click above off its `sponsor_clicks` row (never `click_count`), and a report link is
  // created, then revoked. The Overview is the hub's landing tab; its numbers are server-rendered, so the round trip is the markup.
  const overview = await html(admin, `/o/${proOrgSlug}/sponsors`);
  const goldClicks = new RegExp(`data-testid="sponsor-overview-row-${goldId}"[\\s\\S]*?data-testid="sponsor-overview-clicks"[^>]*>([\\d,.\\u00a0\\u202f]+)<`)
    .exec(overview.body)?.[1];
  check(
    // Exactly one: the gold sponsor is new this run (`tag`), and the one /s/ click above is its only click row.
    "sponsors: the Overview lists the gold sponsor with the click recorded above",
    overview.status === 200 && goldClicks !== undefined && Number(goldClicks.replace(/\D/g, "")) === 1,
  );
  const created = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors/${goldId}/report-links`, "POST", { competitionId: null, from: "2026-01-01", to: "2026-12-31" });
  const link = created.status === 201 ? v1data<{ id: string; url: string }>(created) : null;
  const revokeUrl = `/api/v1/orgs/${proOrgId}/sponsor-report-links/${link?.id ?? "00000000-0000-4000-8000-000000000000"}`;
  const revoked = await v1(admin, revokeUrl, "DELETE");
  check(
    "sponsors: create link then revoke",
    link !== null && /^\/r\/sponsor\/[A-Za-z0-9_-]{43}$/.test(link.url) && revoked.status === 200,
  );
  check("sponsors: a second revoke of the same link is 404", (await v1(admin, revokeUrl, "DELETE")).status === 404);
  check(
    "sponsors: a report link ending before it starts is refused (400)",
    (await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors/${goldId}/report-links`, "POST", { competitionId: null, from: "2026-06-02", to: "2026-06-01" })).status === 400,
  );

  // --- R4 S14: the public report renders a seeded airing - with no session at all - and 404s once the link is revoked. The
  // airing is written straight to its table (the overlay read path writes it in production): 8 s on screen, in the link's dates.
  const db = smokeDb();
  try {
    await db`
      insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, moment_id, source, break_kind, style, started_at, ended_at)
      values (${proOrgId}, ${goldId}, ${`Goldco ${tag}`}, null, ${`smoke-${tag}:sponsor.over_end`}, 'rotation', 'over_end', 'lower_third',
              '2026-03-02T10:00:00Z', '2026-03-02T10:00:08Z')`;
  } finally {
    await db.end();
  }
  const reportMade = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors/${goldId}/report-links`, "POST", { competitionId: null, from: "2026-03-01", to: "2026-03-31" });
  const report = reportMade.status === 201 ? v1data<{ id: string; url: string }>(reportMade) : null;
  const opened = report ? await html(newSession(), report.url) : null;
  check(
    "sponsors: the report renders a seeded airing",
    opened !== null && opened.status === 200 && opened.body.includes('data-testid="sponsor-report"') &&
      opened.body.includes(`Goldco ${tag}`) && (opened.body.match(/data-testid="report-showing"/g) ?? []).length === 1 &&
      /<meta name="robots" content="noindex/.test(opened.body),
  );
  if (report) await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-report-links/${report.id}`, "DELETE");
  const closed = report ? await html(newSession(), report.url) : null;
  check("sponsors: a revoked report link is the 404", closed !== null && closed.status === 404 && closed.body.includes('data-testid="sponsor-report-not-found"'));

  // --- R4 S15: the rows S5, S8, S9 and S10 owed, chained off ONE live volleyball match in `comp` — whose own settings row
  // is Normal and on (the S12 rows above), and where the gold sponsor is the only ticked one. AFTER the Overview and report
  // rows on purpose: those count gold's clicks and airings, and every row below adds to them.
  await sponsorStreamRows(admin, proOrgId, comp.id, goldId);

  // --- Monetization: package + order-first Connect checkout.
  const pkgRes = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-packages`, "POST", {
    name: `Gold Package ${tag}`,
    price_cents: 25_000,
    currency: "gbp",
    tier: "gold",
  });
  check("sp pro creates a package", pkgRes.status === 201);
  const pkg = v1data<{ id: string }>(pkgRes);

  // Connect gate: same refusal as entry fees, before any order row exists.
  await setConnect(proOrgId, false);
  const gated = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`, "POST", {
    package_id: pkg.id,
    sponsor_name: "Gate Probe",
    sponsor_email: `delivered+gate_${tag}@resend.dev`,
  });
  check("sp checkout refused without Connect (409)", gated.status === 409);
  // The one org in the run that gets a REAL connected account, when supplied —
  // stripe_account_id is UNIQUE, so it can only ever be handed to one.
  await setConnect(proOrgId, true, CONNECT_TEST_ACCOUNT);

  const started = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`, "POST", {
    package_id: pkg.id,
    sponsor_name: `Acme ${tag}`,
    sponsor_email: `delivered+acme_${tag}@resend.dev`,
  });
  if (!process.env.STRIPE_SECRET_KEY) {
    // Keyless: the Stripe mint fails AFTER the pending order landed — the
    // order-before-intent rail is still observable below.
    check("sp checkout keyless fails after the order insert", started.status >= 500);
  } else if (!CONNECT_TEST_ACCOUNT) {
    // Keyed but destination-less. A secret key is NOT a proxy for "Connect is
    // usable": the checkout sends setConnect's fabricated acct_smoke_* as
    // transfer_data.destination, which Stripe rejects with resource_missing,
    // so 201 is unreachable no matter how valid the key is. Skip (counting the
    // check, same convention as paymentMethodSuite) rather than assert a
    // failure the fixture — not the app — causes.
    check(
      "sp checkout: skipped (no STRIPE_CONNECT_TEST_ACCOUNT — destination charge needs a real connected account)",
      true,
    );
  } else {
    check(
      "sp checkout starts (order + session url)",
      started.status === 201 && !!v1data<{ checkout_url: string }>(started).checkout_url,
    );
  }
  const orders = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`);
  check(
    "sp order row landed pending (order-before-intent)",
    orders.status === 200 &&
      v1data<{ status: string; sponsor_name: string }[]>(orders).some(
        (o) => o.status === "pending" && o.sponsor_name === `Acme ${tag}`,
      ),
  );

  // --- R4 S11: the top-level Sponsors hub. Settings -> Sponsors moved here; the old URL forwards (307, query kept).
  const hubOverview = await html(admin, `/o/${proOrgSlug}/sponsors`);
  check(
    "sp hub answers 200 for an editor and opens on Overview",
    hubOverview.status === 200 && hubOverview.body.includes('data-testid="sponsors-tab-overview"'),
  );
  const hubSponsors = await html(admin, `/o/${proOrgSlug}/sponsors?tab=sponsors`);
  check(
    "sp hub Sponsors tab renders for an editor (the moved tiered manager, not Overview)",
    hubSponsors.status === 200 &&
      hubSponsors.body.includes('data-testid="sponsors-tab-sponsors"') &&
      !hubSponsors.body.includes('data-testid="sponsors-tab-overview"'),
  );
  const hubPackages = await html(admin, `/o/${proOrgSlug}/sponsors?tab=packages`);
  check(
    "sp hub Packages tab renders the sell console for an editor",
    hubPackages.status === 200 &&
      hubPackages.body.includes('data-testid="sponsors-tab-packages"') &&
      hubPackages.body.includes('data-testid="sponsor-packages"'),
  );
  const legacyTab = await pageRedirect(admin, `/o/${proOrgSlug}/settings?tab=sponsors&x=1`);
  check(
    "sp legacy settings?tab=sponsors redirects to the hub's Sponsors tab (second param kept)",
    legacyTab.status === 307 && (legacyTab.location ?? "").endsWith(`/o/${proOrgSlug}/sponsors?tab=sponsors&x=1`),
  );
  const settingsOrg = await pageRedirect(admin, `/o/${proOrgSlug}/settings?tab=organization`);
  check("sp settings?tab=organization does NOT redirect (only the retired tab does)", settingsOrg.status === 200);
  const hubSignedOut = await pageRedirect(newSession(), `/o/${proOrgSlug}/sponsors`);
  check(
    "sp hub is not served to a signed-out visitor",
    hubSignedOut.status >= 300 && hubSignedOut.status < 400 && (hubSignedOut.location ?? "").includes("/login"),
  );

  // --- Free path: flat partner strip stays free; tiers + packages are 402.
  const free = newSession();
  const freeVer = await signIn(free, `delivered+sponsor_free_${tag}@resend.dev`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sponsor Free ${tag}`,
      visibility: "public",
    }),
  );
  const partner = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsors`, "POST", {
    name: `Corner Shop ${tag}`,
    url: "https://corner.example",
  });
  check("sp free adds a partner sponsor", partner.status === 201);
  const freeGold = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsors`, "POST", {
    name: "Blocked Gold",
    tier: "gold",
  });
  check("sp free tiering gated (402)", freeGold.status === 402);
  const freeShared = await html(newSession(), `/shared/${freeOrg.slug}/${freeComp.slug}`);
  check(
    "sp free strip renders publicly, un-tiered",
    freeShared.status === 200 &&
      freeShared.body.includes(`Corner Shop ${tag}`) &&
      !freeShared.body.includes("Presented by"),
  );
  const freePkg = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsor-packages`, "POST", {
    name: "Blocked Package",
    price_cents: 1_000,
    currency: "gbp",
    tier: "partner",
  });
  check("sp free packages gated (402)", freePkg.status === 402);
  // The hub is not itself gated: a free-plan owner reaches it, and its Packages tab (the upsell) renders rather than 402/404.
  const freeHub = await html(free, `/o/${freeOrg.slug}/sponsors?tab=packages`);
  check(
    "sp hub Packages tab answers 200 on a free org (the gate is the feature, not the page)",
    freeHub.status === 200 && freeHub.body.includes('data-testid="sponsors-tab-packages"'),
  );
}
