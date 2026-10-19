// The match room (T14) — a player's own board for an online chess fixture,
// at `/shared/{org}/{comp}/{div}/fixtures/{id}/play`, entered from the
// invite's personal link (`?t=`) or the fixture page with a session.
//
// It lives in the `(kiosk)` route group, not under `[orgSlug]/layout.tsx`:
// the owner-approved canvas (2026-10-11) is a full-screen room with its own
// header, and the chrome layout's sticky header, `max-w-5xl` main and footer
// would box it in. The kiosk layout gives it exactly what it needs from the
// org tree — the org door, the display face (`--ps-font-display`), the brand
// palette and `<html lang>` — and nothing else. The URL is unchanged
// (route groups are not in the path).
//
// The first snapshot is read here, server-side, through the SAME usecase the
// room's GET route serves, so first paint and every poll are one shape. A
// link or session that does not resolve to one of the fixture's two players
// is the room's one "not available" card — never a 500, never a hint which.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DictProvider } from "@/components/i18n/dict-provider";
import { RoomShell } from "@/components/public-site/match-room/room-shell";
import { RoomHeaderless, RoomNoAccountHeaderless, RoomRepairingHeaderless } from "@/components/public-site/match-room/room-unavailable";
import { getCurrentUser } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";
import { lichessFlashCode } from "@/lib/lichess-link";
import { routes } from "@/lib/routes";
import { publicOrgOrNull } from "@/server/public-site/org-guard";
import { readRoom, roomGrantDowngraded, type RoomIdentity } from "@/server/usecases/external-play/room";
import { roomViewer } from "@/server/usecases/external-play/room-viewer";
import { ROOM_BEING_REPAIRED, ROOM_SEAT_NO_ACCOUNT, type RoomSnapshot } from "@/components/public-site/match-room/room-snapshot";

export const dynamic = "force-dynamic";

type Params = { orgSlug: string; competitionSlug: string; divisionSlug: string; fixtureId: string };

// A personal link is in the URL: never indexed, and never sent onward as a
// Referer (the room links only to our own pages, but the rule is cheap).
const PRIVATE: Pick<Metadata, "robots" | "referrer"> = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// Title and description in the ORG's language: every field a page leaves out
// is inherited from the root layout, which is English (the kiosk boards' rule,
// Task 16 review I2). Generic on purpose — the head never names the players.
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { orgSlug } = await params;
  const org = await publicOrgOrNull(orgSlug);
  const ui = await getDictionary(toLocale(org?.org.default_locale), "ui");
  return {
    title: t(ui, "externalPlay.room.meta.title"),
    description: t(ui, "externalPlay.room.meta.description"),
    ...PRIVATE,
  };
}

async function identityFor(token: string | null): Promise<RoomIdentity | null> {
  // A personal link also carries who is looking, when anyone is signed in: the room tells the seat's own account from
  // another (owner staging test 2026-10-19). Fail-open, as the room's polls are (match-room-identity.ts).
  if (token) {
    const viewer = await roomViewer();
    return viewer ? { kind: "token", token, viewer } : { kind: "token", token };
  }
  const user = await getCurrentUser();
  return user ? { kind: "session", userId: user.id } : null;
}

export default async function MatchRoomPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ t?: string | string[]; lichess?: string | string[] }>;
}) {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const query = await searchParams;
  const raw = query.t;
  const token = typeof raw === "string" && raw.length > 0 ? raw : null;
  // Owner staging test 2026-10-19: the Lichess link's callback lands back here as `…/play?t=…&lichess=<code>`
  // (lib/lichess-link.ts `lichessLanding`). Read the way /me and settings read it - through the shared narrowing, so a
  // value that is not one of ours is no outcome - and handed to the shell, which says it on the link / re-link card.
  const lichessFlash = typeof query.lichess === "string" ? lichessFlashCode(query.lichess) : null;

  const org = await publicOrgOrNull(orgSlug);
  const locale = toLocale(org?.org.default_locale);
  const ui = await getDictionary(locale, "ui");
  const fixturePath = routes.sharedFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);

  let snapshot: RoomSnapshot | null = null;
  // Final re-review 4, I2: the board is being re-paired (the server's 409) — no snapshot yet, but not "not yours".
  let repairing = false;
  // A VERIFIED link for a seat tied to no Seazn account (the server's 409): no seat to read, and no sign-in fixes it.
  let noAccount = false;
  // Final review P10: Lichess's word on the player's grant, asked ONCE per page load (never by the room's polls).
  let grantRefused = false;
  const identity = await identityFor(token);
  if (identity !== null) {
    try {
      snapshot = await readRoom(identity, fixtureId);
      grantRefused = await roomGrantDowngraded(identity, fixtureId);
    } catch (err) {
      // Only the room's own refusal reads as "not available"; anything else
      // is a real fault and goes to the error boundary — save a board being
      // re-paired (fix round 4b), which is its own card (I2).
      if (err instanceof HttpError && err.status === 409 && err.code === ROOM_BEING_REPAIRED) repairing = true;
      else if (err instanceof HttpError && err.status === 409 && err.code === ROOM_SEAT_NO_ACCOUNT) noAccount = true;
      else if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }

  if (snapshot === null && repairing) {
    // No snapshot to run a room on: the re-pair card, headerless, re-asking this page at the room's cadence
    // until the board is paired to this player again (the room) or the room refuses them (card 7).
    return (
      <DictProvider dict={ui} locale={locale}>
        <RoomRepairingHeaderless t={(k, v) => t(ui, k, v)} />
      </DictProvider>
    );
  }

  if (snapshot === null && noAccount) {
    return (
      <DictProvider dict={ui} locale={locale}>
        <RoomNoAccountHeaderless fixtureHref={fixturePath} t={(k, v) => t(ui, k, v)} />
      </DictProvider>
    );
  }

  if (snapshot === null) {
    return (
      <DictProvider dict={ui} locale={locale}>
        <RoomHeaderless fixtureHref={fixturePath} t={(k, v) => t(ui, k, v)} />
      </DictProvider>
    );
  }

  // The fixture is found by id; the slugs in the path are the fixture's own
  // or a stale copy (a renamed competition). Land on the canonical room.
  if (!snapshot.links.fixture.startsWith(`/shared/${orgSlug}/${competitionSlug}/${divisionSlug}/`)) {
    redirect(`${snapshot.links.fixture}/play${token ? `?t=${encodeURIComponent(token)}` : ""}`);
  }

  const selfPath = `${snapshot.links.fixture}/play${token ? `?t=${encodeURIComponent(token)}` : ""}`;
  return (
    <DictProvider dict={ui} locale={locale}>
      <RoomShell initial={snapshot} token={token} selfPath={selfPath} grantRefused={grantRefused} lichessFlash={lichessFlash ?? undefined} />
    </DictProvider>
  );
}
