import { z } from "zod";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { FAKE_DRIVER_ENV_NAMES } from "@/server/relay/config";
import { relayDrivers } from "@/server/relay/drivers";
import { FakeIngest } from "@/server/relay/fakes";

type Ctx = { params: Promise<{ inputId: string }> };

/** One control per call: the three words FakeIngest.setState takes (ports.ts IngestState), or (Seazn Task 19) a finished
 *  recording of the input, FakeIngest.addRecording. */
const Body = z.union([
  z.object({ state: z.enum(["connected", "disconnected", "unknown"]) }).strict(),
  z.object({ recording: z.literal("ready") }).strict(),
]);

/** Where the control exists at all: an explicit RELAY_DRIVERS=fake on a developer's machine or CI (config.ts's own
 *  FAKE_DRIVER_ENV_NAMES). Read BEFORE relayDrivers(), which throws on a named deployment asking for the fake. */
function fakeControlEnabled(env: Record<string, string | undefined>): boolean {
  const name = env.ENV_NAME?.trim();
  return env.RELAY_DRIVERS === "fake" && !!name && FAKE_DRIVER_ENV_NAMES.includes(name);
}

/** POST /api/internal/relay/fake-ingest/[inputId] — capture QR v2 T7 (§6.15, FP8): a walkthrough's control over the FAKE
 *  ingest. It flips the scripted state of one fake live input through the EXISTING `FakeIngest.setState`, which overrides
 *  the connect timer, so ask 10 and W19 can be driven in seconds. The next tick reads the flipped state.
 *  Body `{ state: "connected" | "disconnected" | "unknown" }`, answered `{ inputId, state }`; or (Seazn Task 19)
 *  `{ recording: "ready" }`: the input leaves one FINISHED, unsigned recording (FakeIngest.addRecording, Cloudflare's own C3
 *  shape), answered `{ inputId, videoId }`, for the stream tick's Seazn lock pass to find. 404 unless RELAY_DRIVERS=fake AND
 *  ENV_NAME is local or ci,
 *  and 404 for an input this process's fake never made; 400 for any other body. No auth: it exists nowhere a real
 *  provider, a real credit or a named deployment does. */
export async function POST(req: Request, { params }: Ctx) {
  return handler(async () => {
    if (!fakeControlEnabled(process.env)) throw new HttpError(404, "Not found");
    const ingest = relayDrivers().ingest;
    if (!(ingest instanceof FakeIngest)) throw new HttpError(404, "Not found");
    const { inputId } = await params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "body must be { state: connected | disconnected | unknown } or { recording: ready }");
    const control = parsed.data;
    try {
      if ("recording" in control) return { inputId, videoId: ingest.addRecording(inputId) };
      ingest.setState(inputId, control.state);
    } catch {
      throw new HttpError(404, "Unknown fake input");
    }
    return { inputId, state: control.state };
  });
}
