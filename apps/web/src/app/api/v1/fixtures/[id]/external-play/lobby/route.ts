import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { externalPlayLobbyTopic, mintExternalPlayLobbyToken } from "@/lib/realtime";
import {
  markExternalPlayReady,
  readExternalPlayLobby,
} from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

async function lobbyPayload(userId: string, fixtureId: string, clicked: boolean) {
  const lobby = clicked
    ? await markExternalPlayReady({ userId, fixtureId })
    : await readExternalPlayLobby(userId, fixtureId);
  let token: string | null = null;
  try {
    token = await mintExternalPlayLobbyToken(fixtureId, userId);
  } catch {
    token = null;
  }
  return {
    ...lobby,
    token,
    channel: externalPlayLobbyTopic(fixtureId),
  };
}

/** GET /api/v1/fixtures/{id}/external-play/lobby — Ready state for a player on the fixture. */
export async function GET(_req: Request, { params }: Ctx) {
  return v1(async () => {
    const user = await requireUser();
    const { id } = await params;
    return lobbyPayload(user.id, id, false);
  });
}

/** POST — this player clicks Ready. Mints when the other side already has. */
export async function POST(_req: Request, { params }: Ctx) {
  return v1(async () => {
    const user = await requireUser();
    const { id } = await params;
    return lobbyPayload(user.id, id, true);
  });
}
