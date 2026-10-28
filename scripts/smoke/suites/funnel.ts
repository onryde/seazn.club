// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, raw, call, check, tag, checkOutboxRow, smokeDb, html } from "../harness.ts";

export async function funnelSuite(): Promise<void> {
  const visitor = newSession();
  const funnelEmail = `delivered+funnel_${tag}@resend.dev`;
  const started = (await call(visitor, "/api/funnel/start", "POST", {
    email: funnelEmail,
    name: `Funnel Fiesta ${tag}`,
    sport: "Badminton",
    entrants: 8,
  })) as { claim_url?: string };
  check("funnel: draft created with dev claim_url", !!started.claim_url);

  // Email outbox, phase 3 wave 3 (Task 5): the claim email is one `funnel_claim` row, ref the draft (the response does not name it, so
  // it is read back by the visitor's address), its first attempt made in the request and no body left on it. Keyless run: no DB.
  if (process.env.DATABASE_URL) {
    const db = smokeDb();
    let draftId: string | undefined;
    try {
      const [draft] = await db<{ id: string }[]>`
        select id from funnel_drafts where email = ${funnelEmail} order by created_at desc limit 1`;
      draftId = draft?.id;
    } finally {
      await db.end();
    }
    check("funnel: the start stored a draft for the visitor's address", !!draftId);
    if (draftId) await checkOutboxRow("funnel_claim", "funnel_draft", draftId);
  }

  const token = new URL(started.claim_url ?? "").searchParams.get("token");
  const claimed = (await call(visitor, "/api/funnel/claim", "POST", {
    token,
  })) as {
    redirect: string;
  };
  check(
    "funnel: claim lands inside the competition (entrants tab)",
    /^\/o\/[^/]+\/c\/funnel-fiesta[^/]*\/d\/[^/?]+\?tab=entrants$/.test(claimed.redirect),
  );
  check("funnel: claim started a session", !!visitor.cookies["seazn_session"]);
  const landing = await html(visitor, claimed.redirect);
  check(
    "funnel: landing page renders the new competition",
    landing.status === 200 && landing.body.includes(`Funnel Fiesta ${tag}`),
  );

  // Single-use: a second consume fails cleanly.
  const again = await raw(visitor, "/api/funnel/claim", "POST", { token });
  check("funnel: claim token is single-use", again.json.ok === false);
}
