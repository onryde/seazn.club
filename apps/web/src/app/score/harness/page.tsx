import { notFound } from "next/navigation";
import { HarnessClient } from "./harness-client";

/**
 * S10/#419 — the v2 pad's browser-verification harness. NOT a product surface:
 * S12 wires the pad into the real entry points behind the `scorepad-v2` flag,
 * and this route is deleted no later than S13's cutover.
 *
 * It exists because the acceptance criteria this session owes — the queue
 * survives tab death, scoring continues offline, the queue drains in order on
 * reconnect — are claims about a REAL browser holding REAL IndexedDB across a
 * REAL reload. A fake-IndexedDB unit test cannot witness any of them.
 *
 * Gated on a server-read env var rather than a `NEXT_PUBLIC_*` one on purpose:
 * a `NEXT_PUBLIC_*` value is baked into the client bundle at BUILD time, so it
 * would ship the gate's answer to production. This is read per request on the
 * server, so a deploy that never sets it cannot route here at all. There was
 * no dev-only-page precedent in `src/app` to copy — this is the first.
 */
export const dynamic = "force-dynamic";

interface SearchParams {
  sport?: string;
  variant?: string;
  fixture?: string;
  band?: string;
  locked?: string;
}

export default async function ScorepadHarnessPage(props: {
  searchParams: Promise<SearchParams>;
}) {
  if (process.env.SCOREPAD_V2_HARNESS !== "1") notFound();
  const params = await props.searchParams;
  const band = Number(params.band ?? "3");
  return (
    <HarnessClient
      sportKey={params.sport ?? "cricket"}
      variant={params.variant ?? null}
      fixtureId={params.fixture ?? null}
      band={band === 0 || band === 1 || band === 2 || band === 3 ? band : 3}
      locked={params.locked === "1"}
    />
  );
}
