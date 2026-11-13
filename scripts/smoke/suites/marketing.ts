// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, check, renderedAttr } from "../harness.ts";

export async function marketingSuite(): Promise<void> {
  const home = await fetch(`${BASE}/`, { redirect: "manual" });
  const html = await home.text();
  check("marketing: home 200", home.status === 200);
  check("marketing: home has The Draw", html.includes("The Draw"));
  // The hero's one primary since owner 2026-11-13 (Option A): the quick match start, a plain GET form (it works with no
  // script, which is all smoke reads) to the locale's setup page; the organiser's setup is a link to the locale's /start.
  // The locale is whatever `/` negotiated, so the paths match any two-letter one.
  const tagOf = (testid: string) => html.match(new RegExp(`<[a-z]+\\b[^>]*\\bdata-testid="${testid}"[^>]*>`))?.[0] ?? "";
  const qmForm = tagOf("qm-cta-form");
  check(
    "marketing: home hero quick match start is a GET to the setup page",
    qmForm.includes('method="get"') && /\baction="\/[a-z]{2}\/play"/.test(qmForm),
  );
  check("marketing: home hero sport select", /<select\b[^>]*\bname="sport"/.test(html));
  check("marketing: home hero organiser link to /start", /\bhref="\/[a-z]{2}\/start"/.test(tagOf("hero-event-link")));
  check("marketing: home hero has no funnel form", !html.includes("data-start-funnel"));
  check("marketing: home SSR default draw", html.includes("GROUP STAGE"));

  // The two doors into /start carry the sport (start wizard plan T5, T7). /play's "register to start a season" link names the
  // sport its chips chose — before any script runs, the server's default — by its key; and /start, opened by such a link,
  // renders the wizard on that sport: its chip is the checked radio in the server's markup.
  const play = await fetch(`${BASE}/en/play`);
  const playHtml = await play.text();
  check("marketing: /en/play 200", play.status === 200);
  const door = playHtml.match(/<a\b[^>]*\bdata-testid="qm-register-season"[^>]*>/)?.[0] ?? "";
  check("marketing: /en/play's season door links /start with its sport", door.includes('href="/en/start?sport='));
  const start = await fetch(`${BASE}/en/start?sport=tabletennis`);
  const startHtml = await start.text();
  check("marketing: /en/start?sport=tabletennis 200", start.status === 200);
  check("marketing: /en/start renders the wizard at its first step", startHtml.includes('data-start-wizard="true" data-step="sport"'));
  const checkedSport = [...startHtml.matchAll(/<input\b[^>]*\bname="sport"[^>]*>/g)]
    .filter((m) => /\bchecked=""/.test(m[0]))
    .map((m) => /\bvalue="([^"]*)"/.exec(m[0])?.[1]);
  check("marketing: /en/start opens on the linked sport (one checked chip: tabletennis)", JSON.stringify(checkedSport) === '["tabletennis"]');

  const preview = await fetch(`${BASE}/api/public/format-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "groups-knockout", entrants: 8 }),
  });
  const body = (await preview.json()) as {
    ok?: boolean;
    data?: { phases?: Array<{ sections: unknown[] }> };
  };
  check("marketing: format-preview 200", preview.status === 200);
  check("marketing: format-preview two phases", body.data?.phases?.length === 2);

  const sched = await fetch(`${BASE}/scheduling`);
  const shtml = await sched.text();
  check("marketing: /scheduling 200", sched.status === 200);
  check("marketing: /scheduling has rundown", shtml.includes("Order of play"));

  // #364 Task 8 — the AI architect demo section. Smoke reads HTML with no JS
  // running, so the claim provable here is narrow and deliberately so: the
  // section SHIPPED on this page, with one card per template. `ready` names the
  // section root, not a played recording — that a recording actually replays is
  // an e2e claim (apps/web/e2e/marketing-ai-demo.spec.ts), never this one.
  // Every probe carries the full value AND its closing quote: React serialises
  // an omitted prop as `"$undefined"`, so a bare attribute-name probe would
  // pass in both states and prove nothing.
  check("marketing: ai demo section shipped", shtml.includes('data-ai-demo="ready"'));
  for (const slug of ["finals-day", "club-night", "northside-open"]) {
    check(`marketing: ai demo card ${slug}`, shtml.includes(`data-ai-template="${slug}"`));
  }

  // R14 (entitlements v18 W3) — the /pricing box-office redesign. Coarse HTML
  // checks only (no JS runs here); the figures and copy are pinned by
  // pricing-page.test.tsx and pricing-v18.spec.ts, which is where that job
  // belongs. This is the "did the page even ship" net.
  const pricing = await fetch(`${BASE}/pricing`);
  const phtml = await pricing.text();
  check("pricing: 200", pricing.status === 200);
  check("pricing: sport rail shipped", renderedAttr(phtml, "data-pricing-rail"));
  // W3 fix round 2, item 5: carrom folded into "Board games" — nine slots,
  // never its own. See lib/pricing-rail.ts's PRICING_RAIL_COVERAGE.
  for (const sport of [
    "football", "cricket", "tennis", "badminton", "tabletennis",
    "volleyball", "hockey", "icehockey", "boardgame",
  ]) {
    check(`pricing: rail slot ${sport}`, phtml.includes(`data-rail-sport="${sport}"`));
  }
  check("pricing: no rail slot for carrom", !phtml.includes('data-rail-sport="carrom"'));
  check("pricing: rail foot line shipped", renderedAttr(phtml, "data-rail-footer"));
  check("pricing: no rail slot for generic", !phtml.includes('data-rail-sport="generic"'));
  check("pricing: Event Pass ticket stub shipped", renderedAttr(phtml, "data-pass-stub"));
  check(
    "pricing: comparison table columns are community/event_pass/pro, no event_pass_l",
    phtml.includes('data-pricing-column="community"') &&
      phtml.includes('data-pricing-column="event_pass"') &&
      phtml.includes('data-pricing-column="pro"') &&
      !phtml.includes('data-pricing-column="event_pass_l"'),
  );
  check("pricing: 320 accordion shipped", renderedAttr(phtml, "data-pricing-accordion"));
  check("pricing: no retired 'Pro Plus' copy", !phtml.includes("Pro Plus"));
  // W3 fix round 2, item 2: one sellable rung leaves no L to contrast
  // against — "Size M" / "Event Pass M" are gone from every selling surface.
  check("pricing: no 'Size M' / 'Event Pass M' rung suffix", !phtml.includes("Event Pass M"));
  // W3 fix round 2, item 3: the enterprise-only row routes to Contact-us
  // rather than reading as a flat "no".
  check("pricing: enterprise-only row carries its routing note", phtml.includes("Enterprise only"));
  // W3 fix round 2, item 6: the dedicated Platform fee FAQ entry.
  check(
    "pricing: dedicated Platform fee FAQ entry shipped",
    phtml.includes("platform fee") && phtml.includes("on top of"),
  );
}
