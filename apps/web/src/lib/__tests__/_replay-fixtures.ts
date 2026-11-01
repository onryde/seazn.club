// Test-only (no `.test.` in the name, so vitest never collects it): the pages whose URL holds a credential, and a Sentry client
// that holds a Replay integration. Built from the REAL minters and route builders; the importing test file installs the
// `@/lib/db` stand-in (`_fake-sql`) the minters run on.
import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { getClient } from "@sentry/nextjs";
import { routes } from "@/lib/routes";
import { createLoginLink } from "@/lib/login-link";
import { createVerificationToken } from "@/lib/verification";
import { mintClaimSecret } from "@/server/usecases/person-claims";
import { createInvite } from "@/server/usecases/invites";
import { mintCheckinToken } from "@/server/usecases/checkin-token";
import { mintMatchRoomToken } from "@/server/usecases/match-room-token";
import { mintReportToken } from "@/server/sponsors/report-token";
import { reportLinkPath } from "@/lib/sponsor-report";
import { REPLAY_INTEGRATION_NAME } from "@/lib/replay-guard";
import { USER_ID } from "./_fake-sql";

export const ORIGIN = "https://seazn.club";
export const TOKEN = "dl_Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFuZG9tIHRva2Vu_Ab-9";
const ORG = "00000000-0000-4000-8000-000000000002";
const FIXTURE = "00000000-0000-4000-8000-000000000003";

/** Every page whose URL holds a credential, built from the real minters and builders. `secret` is what must never be recorded. */
export async function credentialPages(): Promise<{ name: string; url: string; secrets: string[] }[]> {
  const claim = mintClaimSecret();
  const invite = (await createInvite(ORG, USER_ID, { role: "admin", max_uses: 1 })).token;
  const checkin = await mintCheckinToken(FIXTURE, new Date(Date.now() + 3600_000));
  const login = await createLoginLink(USER_ID);
  const verify = await createVerificationToken(USER_ID);
  const room = await mintMatchRoomToken({ fixtureId: randomUUID(), personId: randomUUID(), roundOpenId: randomUUID(), roundOpenedAt: new Date().toISOString() });
  const play = routes.sharedFixturePlay("chess-club", "autumn-open", "open", randomUUID(), room);
  const report = mintReportToken();
  const pages = [
    { name: "device-link scorer page", url: `${ORIGIN}/score/${TOKEN}`, secrets: [TOKEN] },
    { name: "profile claim", url: `${ORIGIN}${routes.claim(claim)}`, secrets: [claim] },
    { name: "profile claim under a locale prefix", url: `${ORIGIN}/fr${routes.claim(claim)}`, secrets: [claim] },
    { name: "claim, as a router href (path only)", url: routes.claim(claim), secrets: [claim] },
    { name: "org invite", url: `${ORIGIN}/join/${invite}`, secrets: [invite] },
    { name: "day check-in", url: `${ORIGIN}${routes.checkin(checkin)}`, secrets: [checkin] },
    { name: "sign-in link", url: `${ORIGIN}/magic-link?token=${login}`, secrets: [login] },
    { name: "sign-in link with a next", url: `${ORIGIN}/magic-link?token=${login}&next=%2Fdashboard`, secrets: [login] },
    { name: "email verification", url: `${ORIGIN}/verify-email?token=${verify}`, secrets: [verify] },
    { name: "personal match room", url: `${ORIGIN}${play}`, secrets: [room] },
    { name: "sign-in carrying a claim in next", url: `${ORIGIN}/login?next=${encodeURIComponent(routes.claim(claim))}`, secrets: [claim] },
    { name: "claim with a hash", url: `${ORIGIN}${routes.claim(claim)}#top`, secrets: [claim] },
    { name: "sponsor report (S14)", url: `${ORIGIN}${reportLinkPath(report)}`, secrets: [report] },
    { name: "sponsor report under a locale prefix", url: `${ORIGIN}/nl${reportLinkPath(report)}`, secrets: [report] },
    { name: "sponsor report, as a router href (path only)", url: reportLinkPath(report), secrets: [report] },
  ];
  for (const p of pages) for (const s of p.secrets) expect(p.url, `premise: ${p.name} carries its secret`).toContain(s);
  return pages;
}

/** Make `getClient()` (mocked by the importing file) return a client whose Replay integration is `replay`, or none. */
export function setReplay(replay: { stop: () => Promise<void> } | undefined): void {
  vi.mocked(getClient).mockReturnValue(
    (replay ? { getIntegrationByName: vi.fn((name: string) => (name === REPLAY_INTEGRATION_NAME ? replay : undefined)) } : undefined) as never,
  );
}
