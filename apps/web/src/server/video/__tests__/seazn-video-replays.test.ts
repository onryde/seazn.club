// Seazn-hosted video Task 25: the replay host's copy on the match page. A recording the replay move has made `playable` (Task 24)
// is offered as an `embed` part (the host's player, `signedEmbed`) under its STORED part number, IN PLACE of its interim `hls` part
// (Task 14), never beside it; one still on its way or failed keeps the interim; one the organiser removed is no part at all. The
// public read takes the playable copies from `public_fixture_seazn_replays_v`, the organiser's read from the table.
//
// Every recording here comes from the REAL producers: the organiser's Go live, the Machine's playing beat and Stop
// (_seazn-session-rig.ts), the Cloudflare fake's recordings under the programme input's own uid, the REAL Seazn pass that locks
// them (`lockSeaznRecordings`), and the REAL discovery and move (`discoverSeaznRecordings`, `moveSeaznRecordings`) onto the replay
// fake. Only the organiser's delete (Task 26's, not built yet) is written by hand, as the columns V542 gives it. The expected
// values are the brief's, typed here: the embed URL's shape `…/embed/<library>/<video>?token=<64 hex>&expires=<digits>` on the fake
// host, its 1 h life (REPLAY_EMBED_TOKEN_TTL_SECONDS, the plan's B8), and the part rules.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the read never reads a sport rule; every rig rides `generic`.
// Secrets: the fakes' tokens are not secret; the one log line read here is checked to carry none.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
/** Review I1's guard: the entries read, as is, unless a test drops discovery's own new recordings from it (a fault no data reaches:
 *  every new recording is held by the lock or pending, so this is the only way to reach the refusal). */
const entriesFault = vi.hoisted(() => ({ dropPending: false }));
vi.mock("@/server/video/replay-entries", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/video/replay-entries")>();
  return {
    ...orig,
    readReplayEntries: async (...a: Parameters<typeof orig.readReplayEntries>) => {
      const rows = await orig.readReplayEntries(...a);
      return entriesFault.dropPending ? rows.filter((r) => !r.pending) : rows;
    },
  };
});

import { sql } from "@/lib/db";
import { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { BUNNY_ENV_NAMES, DELETE_RECORDING_AFTER_DAYS, SEAZN_TOKEN_FAILURE_CACHE_SECONDS } from "@/server/relay/config";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest } from "@/server/relay/fakes";
import { lockSeaznRecordings } from "@/server/usecases/seazn-recordings";
import { type SeaznReplayDeps, discoverSeaznRecordings, moveSeaznRecordings } from "@/server/usecases/seazn-replays";
import { GET } from "@/app/api/v1/public/fixtures/[id]/video/route";
import { createPlaybackTokenCache } from "../cf-playback";
import { setReplayDriverForTest } from "../replay-driver";
import { FAKE_REPLAY_LENGTH_SECONDS, FakeReplayHost } from "../replay-fake";
import { __resetReplayHostLogForTests, seaznFixtureVideo, seaznFixtureVideoForOrg, seaznReplayPartNos } from "../seazn-video";
import { seaznVideoPlan } from "../seazn-video-plan";
import { installSeaznEnv, live, seaznRig, stopAndSettle } from "./_seazn-session-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const BUDGET = 8_000;
/** The embed URL's shape (brief, plan B4), on the replay fake's host and library. Group 1: the video; 2: the token; 3: the expiry. */
const EMBED = /^https:\/\/embed\.fake\.invalid\/embed\/1\/([^/?]+)\?token=([0-9a-f]{64})&expires=(\d+)$/;
/** The interim's Cloudflare manifest (C1): the token is one path segment. */
const PLAY = /^https:\/\/playback\.fake\.invalid\/([^/?]+)\/manifest\/video\.m3u8$/;
/** The embed token's life (plan B8: 1 h), typed here. */
const EMBED_TTL_SECONDS = 3600;
const EMPTY = { live: null, replay: [] };

installSeaznEnv("t25-video-replays");
afterEach(() => { setReplayDriverForTest(null); __resetReplayHostLogForTests(); entriesFault.dropPending = false; });

async function world() {
  const r = await seaznRig();
  const ingest = r.deps.drivers.ingest as FakeIngest;
  const host = new FakeReplayHost();
  const replayDeps: SeaznReplayDeps = { ingest, replay: host, tokenCache: createPlaybackTokenCache() };
  const mint = vi.spyOn(ingest, "playbackToken");
  return { ...r, ingest, host, replayDeps, mint };
}
type World = Awaited<ReturnType<typeof world>>;

/** A Seazn session that recorded `n` recordings on its programme input (one minute apart, the replay fake's own length unless
 *  `duration` says otherwise), then ended. */
async function endedWith(w: World, fixtureId: string, recs: { duration?: number; state?: "ready" | "error" }[]) {
  const sid = await live(w, fixtureId, w.seazn);
  const [prog] = await sql<{ uid: string }[]>`select ingest_input_id as uid from fixture_stream_inputs where session_id = ${sid} and role = 'programme'`;
  expect(prog?.uid, "PREMISE: the programme input has a uid").toBeTruthy();
  const base = w.deps.now().getTime();
  const ids = recs.map((rec, k) => {
    const videoId = `v-${k}-${randomUUID()}`;
    w.ingest.addVideo({ videoId, inputId: prog!.uid, createdAt: new Date(base + k * MIN).toISOString(), inProgress: false,
      durationSeconds: rec.duration ?? FAKE_REPLAY_LENGTH_SECONDS, height: 1080, ...(rec.state ? { state: rec.state } : {}) });
    return videoId;
  });
  await stopAndSettle(w, fixtureId, sid);
  const [{ ended_at, created_at }] = await sql<{ ended_at: Date; created_at: Date }[]>`select ended_at, created_at from fixture_stream_sessions where id = ${sid}`;
  return { sid, uid: prog!.uid, ids, endedAt: new Date(ended_at).getTime(), createdAt: new Date(created_at).getTime() };
}
const lockPass = (w: World, at: number) => lockSeaznRecordings(w.deps, { now: new Date(at), budgetMs: BUDGET, orgIds: [w.auth.orgId] });
const decide = (fixtureId: string, at: number) => sql`update fixtures set finished_at = ${new Date(at)} where id = ${fixtureId}`;
const discover = (w: World, at: number) => discoverSeaznRecordings(w.replayDeps, { now: new Date(at), budgetMs: BUDGET, orgIds: [w.auth.orgId] });
const move = (w: World, at: number) => moveSeaznRecordings(w.replayDeps, { now: new Date(at), budgetMs: BUDGET, orgIds: [w.auth.orgId] });
interface Row { cf_video_id: string; part_no: number; state: string; bunny_video_id: string | null }
const rowOf = async (cf: string) => (await sql<Row[]>`select cf_video_id, part_no, state, bunny_video_id from fixture_video_replays where cf_video_id = ${cf}`)[0];
/** The host finishes the copy of `cf`, and the move's poll (its 15 min backstop after `at`) verifies it: the row is playable. */
async function toPlayable(w: World, cf: string, at: number): Promise<string> {
  const row = await rowOf(cf);
  expect(row?.state, `PREMISE: ${cf} is encoding before the host finishes it`).toBe("encoding");
  w.host.advance(row!.bunny_video_id!);
  await move(w, at + 15 * MIN);
  const after = await rowOf(cf);
  expect(after?.state, `PREMISE: ${cf} is verified`).toBe("playable");
  return after!.bunny_video_id!;
}
/** The organiser's delete (Task 26), as the columns V542 gives it. */
const organiserDelete = (cf: string, state: string) =>
  sql`update fixture_video_replays set deleted_at = now(), deleted_reason = 'organiser', state = ${state} where cf_video_id = ${cf}`;

/** The reads, each with a token cache of its own so every listed part is minted afresh. */
const read = (w: World, f: string, at: number) =>
  seaznFixtureVideo(f, new Date(at), { ingest: w.ingest, tokenCache: createPlaybackTokenCache(), replay: w.host });
const readOrg = (w: World, f: string, at: number) =>
  seaznFixtureVideoForOrg(w.auth.orgId, f, new Date(at), { ingest: w.ingest, tokenCache: createPlaybackTokenCache(), replay: w.host });
/** [partNo, player, the id it plays]: the Cloudflare uid inside an hls token (`fake.<uid>.<exp>`), the host's video in an embed URL. */
function shape(answer: PublicFixtureVideo): [number, string, string][] {
  return answer.replay.map((p) => {
    if (p.player === "embed") {
      const m = EMBED.exec(p.src);
      expect(m, `an embed URL of the brief's shape: ${p.src}`).not.toBeNull();
      return [p.partNo, p.player, decodeURIComponent(m![1]!)];
    }
    const m = PLAY.exec(p.src);
    expect(m, `a Cloudflare manifest: ${p.src}`).not.toBeNull();
    return [p.partNo, p.player, m![1]!.split(".")[1]!];
  });
}

describe.skipIf(!HAS_DB)("Task 25 — the replay host's copy replaces the interim, part for part", () => {
  it("the swap, one recording, through the real lock, discovery and move: none → hls 1 → found hls 1 → encoding hls 1 → playable embed 1 (never two parts, no Cloudflare mint) → removed: none", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s = await endedWith(w, f, [{}]);
    const cf = s.ids[0]!;
    const t0 = s.endedAt + 15 * MIN;
    expect(await read(w, f, t0), "not locked yet: nothing").toEqual(EMPTY);
    expect(await lockPass(w, s.endedAt + MIN)).toMatchObject({ locked: 1 });
    expect(shape(await read(w, f, t0)), "locked, no row: the interim").toEqual([[1, "hls", cf]]);
    await decide(f, s.endedAt);
    expect(await discover(w, t0)).toMatchObject({ discovered: 1 });
    expect((await rowOf(cf))?.part_no, "PREMISE: discovery numbered it 1").toBe(1);
    expect(shape(await read(w, f, t0)), "found: the interim, same number").toEqual([[1, "hls", cf]]);
    await move(w, t0);
    expect((await rowOf(cf))?.state, "PREMISE: the fetch was made").toBe("encoding");
    expect(shape(await read(w, f, t0)), "encoding: the interim, same number").toEqual([[1, "hls", cf]]);

    const guid = await toPlayable(w, cf, t0);
    const at = t0 + 16 * MIN;
    w.mint.mockClear();
    const answer = await read(w, f, at);
    expect(shape(answer), "playable: ONE part, the host's copy, under the stored number").toEqual([[1, "embed", guid]]);
    expect(w.mint, "the Cloudflare copy is not signed once the host's plays").not.toHaveBeenCalled();
    const exp = Number(EMBED.exec(answer.replay[0]!.src)![3]);
    expect(exp, "the embed token's expiry, in the URL: now + 1 h").toBe(Math.floor((at + EMBED_TTL_SECONDS * 1000) / 1000));
    expect(new Date(answer.replay[0]!.expiresAt).getTime(), "expiresAt: now + 1 h").toBe(at + EMBED_TTL_SECONDS * 1000);
    expect(PublicFixtureVideo.parse(answer), "the producer's answer is the published contract").toEqual(answer);
    expect(await readOrg(w, f, at), "the organiser's read agrees").toEqual(answer);
    expect(await seaznReplayPartNos(f, new Date(at)), "the plan holds the picker for the host's part").toEqual([1]);

    await organiserDelete(cf, "playable");
    expect(await read(w, f, at), "removed (deleted_at set, state still playable): no part, the interim neither").toEqual(EMPTY);
    expect(await readOrg(w, f, at), "nor in the organiser's read").toEqual(EMPTY);
    await organiserDelete(cf, "deleted");
    expect(await read(w, f, at), "deleted: no part").toEqual(EMPTY);
    expect(await readOrg(w, f, at)).toEqual(EMPTY);
    expect(await seaznReplayPartNos(f, new Date(at))).toEqual([]);
  });

  it("a FAILED copy keeps the interim under its stored number (the length check failed: Cloudflare kept)", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s = await endedWith(w, f, [{ duration: FAKE_REPLAY_LENGTH_SECONDS + 60 }]);
    const cf = s.ids[0]!;
    const t0 = s.endedAt + 15 * MIN;
    await lockPass(w, s.endedAt + MIN);
    await decide(f, s.endedAt);
    await discover(w, t0);
    await move(w, t0);
    const row = await rowOf(cf);
    w.host.advance(row!.bunny_video_id!);
    await move(w, t0 + 15 * MIN);
    expect((await rowOf(cf))?.state, "PREMISE: the copy failed the length check").toBe("failed");
    expect(shape(await read(w, f, t0 + 16 * MIN))).toEqual([[1, "hls", cf]]);
    expect(shape(await readOrg(w, f, t0 + 16 * MIN))).toEqual([[1, "hls", cf]]);
    // The organiser removes it while it reads `failed` (deleted_at set, the state not yet moved): the interim goes too.
    await organiserDelete(cf, "failed");
    expect(await read(w, f, t0 + 16 * MIN), "removed: no interim either").toEqual(EMPTY);
    expect(await readOrg(w, f, t0 + 16 * MIN)).toEqual(EMPTY);
  });

  it("two recordings, the first playable and the second encoding → Part 1 embed, Part 2 hls; both playable → two embeds in recorded_at order; the route and the plan agree", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s = await endedWith(w, f, [{}, {}]);
    const [a, b] = s.ids as [string, string];
    const t0 = s.endedAt + 15 * MIN;
    await lockPass(w, s.endedAt + MIN);
    await decide(f, s.endedAt);
    await discover(w, t0);
    await move(w, t0);
    expect([(await rowOf(a))?.part_no, (await rowOf(b))?.part_no], "PREMISE: discovery numbered them in recording order").toEqual([1, 2]);
    const ga = await toPlayable(w, a, t0);
    const at = t0 + 16 * MIN;
    expect((await rowOf(b))?.state, "PREMISE: the second copy is still encoding").toBe("encoding");
    expect(shape(await read(w, f, at))).toEqual([[1, "embed", ga], [2, "hls", b]]);

    const gb = await toPlayable(w, b, t0 + 16 * MIN);
    const later = t0 + 32 * MIN;
    const both = await read(w, f, later);
    expect(shape(both), "two playable rows: two embeds, in recorded_at order").toEqual([[1, "embed", ga], [2, "embed", gb]]);
    expect(both.replay.map((p) => p.player)).toEqual(["embed", "embed"]);
    expect(await seaznReplayPartNos(f, new Date(later))).toEqual([1, 2]);
    // The public route, on the production path (the process's own replay driver: the fake here), lists the same parts.
    const res = await GET(new Request(`http://app.test/api/v1/public/fixtures/${f}/video`), { params: Promise.resolve({ id: f }) });
    expect(res.status).toBe(200);
    const body = PublicFixtureVideo.parse(((await res.json()) as { data: unknown }).data);
    expect(shape(body)).toEqual([[1, "embed", ga], [2, "embed", gb]]);
  });

  it("carry 1: the 30-day bound is Cloudflare's — at the session's start + DELETE_RECORDING_AFTER_DAYS the encoding part goes and the playable one STAYS", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s = await endedWith(w, f, [{}, {}]);
    const [a, b] = s.ids as [string, string];
    const t0 = s.endedAt + 15 * MIN;
    await lockPass(w, s.endedAt + MIN);
    await decide(f, s.endedAt);
    await discover(w, t0);
    await move(w, t0);
    const ga = await toPlayable(w, a, t0);
    const KEEP_MS = DELETE_RECORDING_AFTER_DAYS * 24 * 60 * MIN;
    expect(shape(await read(w, f, s.createdAt + KEEP_MS - 1)), "a ms before Cloudflare's delete").toEqual([[1, "embed", ga], [2, "hls", b]]);
    expect(shape(await read(w, f, s.createdAt + KEEP_MS)), "at it: the host's copy is not Cloudflare's").toEqual([[1, "embed", ga]]);
    expect(shape(await read(w, f, s.createdAt + 10 * KEEP_MS)), "long after").toEqual([[1, "embed", ga]]);
  });

  it("a recording discovery has not listed yet is numbered after the stored parts — a removed one's included — and discovery then gives it THAT number", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const first = await endedWith(w, f, [{}]);
    const t0 = first.endedAt + 15 * MIN;
    await lockPass(w, first.endedAt + MIN);
    await decide(f, first.endedAt);
    await discover(w, t0);
    await move(w, t0);
    await toPlayable(w, first.ids[0]!, t0);
    await organiserDelete(first.ids[0]!, "deleted");
    // The match goes on: a second session, its recording locked but not yet listed by discovery.
    const second = await endedWith(w, f, [{}]);
    await lockPass(w, second.endedAt + MIN);
    const at = second.endedAt + 2 * MIN;
    expect(shape(await read(w, f, at)), "Part 1 removed; the new recording is Part 2, never a reused 1").toEqual([[2, "hls", second.ids[0]!]]);
    await decide(f, second.endedAt);
    await discover(w, second.endedAt + 15 * MIN);
    expect((await rowOf(second.ids[0]!))?.part_no, "discovery's own number is the one the page already showed").toBe(2);
    expect(shape(await read(w, f, at))).toEqual([[2, "hls", second.ids[0]!]]);
  });

  it("a PRIVATE competition's replay is absent from the public read (and the plan's parts) and present in the organiser's; another org reads nothing", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s = await endedWith(w, f, [{}]);
    const t0 = s.endedAt + 15 * MIN;
    await lockPass(w, s.endedAt + MIN);
    await decide(f, s.endedAt);
    await discover(w, t0);
    await move(w, t0);
    const guid = await toPlayable(w, s.ids[0]!, t0);
    const at = t0 + 16 * MIN;
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${f}`;
    await sql`update competitions set visibility = 'private' where id = ${competition_id}`;
    expect(await read(w, f, at), "private: nothing for the public").toEqual(EMPTY);
    expect(await seaznReplayPartNos(f, new Date(at))).toEqual([]);
    expect(shape(await readOrg(w, f, at)), "the organiser still sees it").toEqual([[1, "embed", guid]]);
    const other = await seaznRig();
    expect(await seaznFixtureVideoForOrg(other.auth.orgId, f, new Date(at), { ingest: w.ingest, tokenCache: createPlaybackTokenCache(), replay: w.host }), "another org").toEqual(EMPTY);
    await sql`update competitions set visibility = 'unlisted' where id = ${competition_id}`;
    expect(shape(await read(w, f, at)), "unlisted: the public's again").toEqual([[1, "embed", guid]]);
  });

  it("a replay host that cannot be built leaves the host's parts out of THIS answer, logged by error class only (no URL, no token); the interim parts and the relay are unaffected", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s = await endedWith(w, f, [{}, {}]);
    const [a, b] = s.ids as [string, string];
    const t0 = s.endedAt + 15 * MIN;
    await lockPass(w, s.endedAt + MIN);
    await decide(f, s.endedAt);
    await discover(w, t0);
    await move(w, t0);
    await toPlayable(w, a, t0);
    const at = t0 + 16 * MIN;
    // REPLAY_DRIVER=bunny with none of its settings: the driver refuses to build (config.ts bunnyConfig).
    vi.stubEnv("REPLAY_DRIVER", "bunny");
    for (const k of BUNNY_ENV_NAMES) vi.stubEnv(k, "");
    expect(BUNNY_ENV_NAMES.length, "PREMISE: the Bunny settings are named").toBeGreaterThan(0);
    setReplayDriverForTest(null);
    const warn = vi.spyOn(log, "warn");
    const answer = await seaznFixtureVideo(f, new Date(at), { ingest: w.ingest, tokenCache: createPlaybackTokenCache() });
    expect(shape(answer), "the interim part still answers; the host's is left out").toEqual([[2, "hls", b]]);
    const lines = warn.mock.calls.filter((c) => String(c[1]).startsWith("seazn video:"));
    expect(lines, "one line").toHaveLength(1);
    expect(lines[0]![1]).toBe("seazn video: the replay host could not be built; its parts are left out of this answer");
    expect(JSON.stringify(lines[0]), "never a URL or a token").not.toMatch(/token|https?:|embed\//i);
    // Review m2: every viewer read fails the same way, so the line is once per failure window (the mint's), not once per read.
    const W = SEAZN_TOKEN_FAILURE_CACHE_SECONDS * 1000;
    const hostLines = () => warn.mock.calls.filter((c) => String(c[1]).startsWith("seazn video: the replay host")).length;
    for (const dt of [1, W / 2, W - 1]) {
      expect(shape(await seaznFixtureVideo(f, new Date(at + dt), { ingest: w.ingest, tokenCache: createPlaybackTokenCache() })), `+${dt} ms`).toEqual([[2, "hls", b]]);
    }
    expect(hostLines(), "the reads inside the window log nothing more").toBe(1);
    await seaznFixtureVideo(f, new Date(at + W), { ingest: w.ingest, tokenCache: createPlaybackTokenCache() });
    expect(hostLines(), "the next window logs once more").toBe(2);
    await seaznFixtureVideo(f, new Date(at + W + 1), { ingest: w.ingest, tokenCache: createPlaybackTokenCache() });
    expect(hostLines(), "and then waits again").toBe(2);
    warn.mockRestore();
  });

  it("an answer of host parts alone never BUILDS the relay: a relay that throws the moment it is read answers the embed part, with no line logged", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s = await endedWith(w, f, [{}]);
    const t0 = s.endedAt + 15 * MIN;
    await lockPass(w, s.endedAt + MIN);
    await decide(f, s.endedAt);
    await discover(w, t0);
    await move(w, t0);
    const guid = await toPlayable(w, s.ids[0]!, t0);
    // A deployment whose relay cannot even be built (its secrets missing) throws on the first read of it.
    const built: string[] = [];
    setRelayDriversForTest({
      get ingest(): never { built.push("ingest"); throw new Error("the relay was built"); },
      get runner(): never { built.push("runner"); throw new Error("the relay was built"); },
    } as unknown as ReturnType<typeof disabledRelayDrivers>);
    setReplayDriverForTest(w.host);
    const warn = vi.spyOn(log, "warn");
    const answer = await seaznFixtureVideo(f, new Date(t0 + 16 * MIN));
    expect(shape(answer)).toEqual([[1, "embed", guid]]);
    expect(built, "the relay was never read").toEqual([]);
    expect(warn.mock.calls.filter((c) => String(c[1]).startsWith("seazn video:")), "no line").toEqual([]);
    warn.mockRestore();
  });

  it("the plan: a fixture whose only Seazn trace is a live replay row is `seazn` with LIVE off (flag-independent); a removed row is not", async () => {
    const w = await world();
    const [f, g] = w.fixtureIds as unknown as [string, string];
    const s = await endedWith(w, f, [{}]);
    const t0 = s.endedAt + 15 * MIN;
    await lockPass(w, s.endedAt + MIN);
    await decide(f, s.endedAt);
    await discover(w, t0);
    // A row on the OTHER fixture (its session is this one's): fixture g has no session of its own, so only the row can make it seazn.
    await sql`update fixture_video_replays set fixture_id = ${g} where cf_video_id = ${s.ids[0]!}`;
    await sql`update fixtures set status = 'decided' where id = ${g}`;
    vi.stubEnv("SEAZN_HOSTED_LIVE", "false");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${g}`;
    expect(n, "PREMISE: g has no session").toBe(0);
    expect((await seaznVideoPlan(g)).player, "a replay row: seazn").toBe("seazn");
    await organiserDelete(s.ids[0]!, "deleted");
    expect((await seaznVideoPlan(g)).player, "a removed row is no trace").toBe("external");
  });
});

// ─── Review I1 (carry 2): a part keeps its number through discovery, whatever discovery skips or lists first ───────────────────
// Discovery stores, for each recording, the number the match page already shows for it (one numbering rule, replay-parts.ts
// `partNumbers`, over the video read's own entries, replay-entries.ts). The two paths the review probed: an errored recording that is
// locked but never discovered, and a session whose listing failed and was skipped while a later session was listed. A viewer's pick
// is a part number, so each number must keep playing ITS recording: the hls part by its Cloudflare uid, the host's copy by the
// recording it was made from (the copy's title names it: `seazn:<session>:<recording>`, Task 24).
describe.skipIf(!HAS_DB)("Task 25 review I1 — part numbers are stable through discovery", () => {
  /** The recording each part plays: an hls part's uid, an embed part's source recording (from the host copy's own title). */
  async function plays(w: World, answer: PublicFixtureVideo): Promise<[number, string][]> {
    const out: [number, string][] = [];
    for (const [n, player, id] of shape(answer)) {
      if (player === "hls") { out.push([n, id]); continue; }
      const { title } = await w.host.video(id);
      expect(title, `PREMISE: the host's copy ${id} carries its title`).toMatch(/^seazn:[^:]+:[^:]+$/);
      out.push([n, title!.split(":")[2]!]);
    }
    return out;
  }

  it("A, E (Cloudflare errored it: locked, never discovered), B: Parts 1, 2, 3 before discovery; after it A and B keep 1 and 3 and E is gone; B on the host is still Part 3", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s = await endedWith(w, f, [{}, { state: "error" }, {}]);
    const [a, e, b] = s.ids as [string, string, string];
    const t0 = s.endedAt + 15 * MIN;
    expect(await lockPass(w, s.endedAt + MIN)).toMatchObject({ locked: 3 });
    const before = await plays(w, await read(w, f, t0));
    expect(before, "before discovery: Task 14's 1..3, E included").toEqual([[1, a], [2, e], [3, b]]);
    await decide(f, s.endedAt);
    expect(await discover(w, t0)).toMatchObject({ discovered: 2, failed: 0 });
    const [{ marked }] = await sql<{ marked: boolean }[]>`
      select i.replays_discovered_at is not null as marked from fixture_stream_inputs i where i.session_id = ${s.sid} and i.role = 'programme'`;
    expect(marked, "PREMISE: the input is fully discovered (E is finished: `error`)").toBe(true);
    expect([(await rowOf(a))?.part_no, (await rowOf(b))?.part_no, await rowOf(e)], "discovery stored the numbers the page showed; E has no row").toEqual([1, 3, undefined]);
    const after = await plays(w, await read(w, f, t0));
    expect(after, "A and B keep their numbers; E, unplayable, is no part, its number unused").toEqual([[1, a], [3, b]]);
    await move(w, t0);
    await toPlayable(w, b, t0);
    expect(await plays(w, await read(w, f, t0 + 16 * MIN)), "B on the host: still Part 3, still B").toEqual([[1, a], [3, b]]);
    expect(shape(await read(w, f, t0 + 16 * MIN)).map(([n, player]) => [n, player])).toEqual([[1, "hls"], [3, "embed"]]);
  });

  it("session 1's listing fails and is skipped while session 2 is listed: A (s1) keeps Part 1 and B (s2) Part 2 — then, and after s1 is listed, and on the host", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const first = await endedWith(w, f, [{}]);
    const second = await endedWith(w, f, [{}]);
    const [a, b] = [first.ids[0]!, second.ids[0]!];
    await lockPass(w, second.endedAt + MIN);
    const t0 = second.endedAt + 15 * MIN;
    const before = await plays(w, await read(w, f, t0));
    expect(before, "before discovery: A 1, B 2").toEqual([[1, a], [2, b]]);
    await decide(f, second.endedAt);
    // One transient Cloudflare list failure, on session 1's input (listed first: the oldest session).
    const list = vi.spyOn(w.ingest, "listInputVideos").mockImplementationOnce(async () => { throw new Error("cloudflare list videos: HTTP 504 code 0 timeout"); });
    expect(await discover(w, t0)).toMatchObject({ discovered: 1, failed: 1 });
    expect(list.mock.calls[0]?.[0], "PREMISE: the failed listing was session 1's").toBe(first.uid);
    expect([(await rowOf(a))?.part_no, (await rowOf(b))?.part_no], "s2 stored the 2 the page showed; s1 has no row yet").toEqual([undefined, 2]);
    expect(await plays(w, await read(w, f, t0)), "after s2 alone: unchanged").toEqual(before);
    expect(await discover(w, t0 + MIN)).toMatchObject({ discovered: 1, failed: 0 });
    expect([(await rowOf(a))?.part_no, (await rowOf(b))?.part_no], "s1 listed later: the 1 the page showed").toEqual([1, 2]);
    expect(await plays(w, await read(w, f, t0 + MIN)), "after both: unchanged").toEqual(before);
    await move(w, t0 + MIN);
    await toPlayable(w, a, t0 + MIN);
    await toPlayable(w, b, t0 + 16 * MIN);   // b's next poll is the backstop after the first one
    const onHost = await read(w, f, t0 + 32 * MIN);
    expect(shape(onHost).map(([n, player]) => [n, player]), "both on the host").toEqual([[1, "embed"], [2, "embed"]]);
    expect(await plays(w, onHost), "Part 1 still plays A, Part 2 still B").toEqual(before);
  });

  it("GUARD: a new recording missing from the fixture's entries is never stored under a guessed number — the input is refused (failed, not marked) and the next run stores it under the merge's number", async () => {
    const w = await world();
    const f = w.fixtureIds[0];
    const s = await endedWith(w, f, [{}, {}]);   // never locked: discovery's own recordings are the pending entries
    const t0 = s.endedAt + 15 * MIN;
    await decide(f, s.endedAt);
    entriesFault.dropPending = true;
    const error = vi.spyOn(log, "error");
    expect(await discover(w, t0)).toMatchObject({ discovered: 0, failed: 1 });
    expect(error.mock.calls.some((c) => String(c[1]).startsWith("seazn replays: a programme input's recordings could not be recorded")), "refused, by name").toBe(true);
    error.mockRestore();
    expect(await sql`select 1 from fixture_video_replays where fixture_id = ${f}`, "nothing stored").toHaveLength(0);
    const [{ marked }] = await sql<{ marked: boolean }[]>`
      select i.replays_discovered_at is not null as marked from fixture_stream_inputs i where i.session_id = ${s.sid} and i.role = 'programme'`;
    expect(marked, "the input is NOT marked: the next run lists it again").toBe(false);
    entriesFault.dropPending = false;
    expect(await discover(w, t0 + MIN)).toMatchObject({ discovered: 2, failed: 0 });
    expect([(await rowOf(s.ids[0]!))?.part_no, (await rowOf(s.ids[1]!))?.part_no]).toEqual([1, 2]);
  });
});
