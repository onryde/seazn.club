// Capture QR v2 §11.1.5 (T12): the FAKE PHONE — Seazn Capture as an HTTP client, nothing more.
//
// It reads the QR text FROM THE PANEL'S PASTE-CODE FIELD (`stream-qr-text`) and drives the REAL phone routes with it:
// the descriptor GET, the beats POST and the start POST, Bearer tok only. So the panel's own output is fed through the
// real consumer (AGENTS.md failure class 1, the inert seam): a code the panel never painted cannot pair, and a route
// that answers outside the contract reds here.
//
// THE CONTRACT IS A GUARD, NOT A COMMENT. Every 2xx is parsed through the zod twin of docs/contracts/capture-*.json
// (`server/api-v1/capture-schemas.ts`, which pins byte parity with the published files), every refusal through
// `CaptureRefusal`, and every answer must be `private, no-store` (§6.3). A body the phone could not read throws, naming
// the route — never a silent `as`. A background beat (`keepAlive`) that breaks the contract is recorded, and
// `disposeFakePhones()` throws it at teardown, so a keep-alive can never swallow a contract break.
//
// THE PHONE CARRIES NO ORGANISER SESSION. Its HTTP client is cookie-less (`newPhoneRequest`), and `fakeCapturePhone`
// refuses one that holds a cookie: a phone route that quietly read the organiser's cookie would pass with
// `page.request` and fail on every real phone.
//
// `keepAlive()` is a phone that is paired and in hand: a beat every POLL_STARTING_SECONDS. By default (`idle`) it beats
// `sid: null`, state `paired` — it keeps the pairing PRESENT (§6.9) and ticks nothing, because §6.11 ticks a session
// only on a beat that NAMES its sid. That is the A7 repair's phone: it pairs a Go live without moving any session's
// clock, so every existing assertion about WAITING and LIVE keeps the timeline it was written against. `publishing`
// is the realistic phone: once it hears go-live it beats the sid it holds (state `publishing`), so its beats stamp the
// session's `phone_beat_at` — what W19 times a lost phone from.
import { expect, request as playwrightRequest, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  CaptureBeat,
  CaptureBeatAnswer,
  CaptureDescriptor,
  CaptureRefusal,
  CaptureStartOk,
} from "../../src/server/api-v1/capture-schemas";
import { POLL_STARTING_SECONDS } from "../../src/server/relay/config";
import { STREAM_POLL_MS } from "../../src/lib/stream-session-view";

/** §6.2: the QR payload — exactly these four keys, in this order, and no credential. */
export const QR_KEYS = ["v", "code", "slot", "tok"] as const;
export interface CaptureQr { v: number; code: string; slot: number; tok: string }

export type BeatBody = z.input<typeof CaptureBeat>;
export type BeatAnswer = z.infer<typeof CaptureBeatAnswer>;
export type Descriptor = z.infer<typeof CaptureDescriptor>;
export type Refusal = z.infer<typeof CaptureRefusal>;
export type StartOk = z.infer<typeof CaptureStartOk>;

/** One answer from a phone route: the status, the headers the phone reads, and the body parsed by the contract —
 *  `ok` (a 2xx, its contract shape) or `refusal` (`{code, message, ...}`), never both. */
export interface PhoneReply<T> {
  status: number;
  headers: Record<string, string>;
  ok: T | null;
  refusal: Refusal | null;
}

export interface FakeCapturePhone {
  /** The phone's install id (`phone` on the wire). */
  readonly id: string;
  /** The QR the panel painted, as the paste code carries it. */
  readonly qr: CaptureQr;
  /** The broadcast this phone holds — the sid of the last `go-live` / `live` it heard; null after `over`, `waiting`,
   *  `replaced` or `taken`. */
  readonly sid: string | null;
  /** The last `over` it heard: which sid ended, and why. */
  readonly lastOver: { sid: string; endReason: string } | null;
  /** The cadence the last answer told it (`pollSeconds`), the one §6.9 judges its silence against. */
  readonly lastPollSeconds: number | null;
  /** Beats sent so far (every one, claims and keep-alives included). */
  readonly beatsSent: number;
  /** A claim beat: `new` (a fresh scan) or `resume` (the same install, its pairing remembered). */
  claim(kind: "new" | "resume"): Promise<PhoneReply<BeatAnswer>>;
  /** One beat. `partial` overrides the defaults (state `paired`, no sid); the cross-field rules are the contract's. */
  beat(partial?: Partial<BeatBody>): Promise<PhoneReply<BeatAnswer>>;
  /** `GET /capture/codes/{code}?phone=<id>&slot=<slot>` — the descriptor, `cred` only for the slot's current phone. */
  get(opts?: { withPhone?: boolean }): Promise<PhoneReply<Descriptor>>;
  /** `POST /capture/codes/{code}/start` — the operator's start. */
  start(): Promise<PhoneReply<StartOk>>;
  /** T21: the operator's Stop from the phone — `state: ended`, the held sid, `endReason: operator-stopped`. */
  ended(sid?: string): Promise<PhoneReply<BeatAnswer>>;
  /** A17: a stop sent AFTER the phone let go of the broadcast — `sid: null`, `stopped: <sid>`. */
  stoppedBeat(sid: string): Promise<PhoneReply<BeatAnswer>>;
  /** Beat every POLL_STARTING_SECONDS until `silence()` — `idle` (sid null, ticks nothing) or `publishing` (the held
   *  sid, once it has heard one). */
  keepAlive(mode?: "idle" | "publishing"): void;
  /** Stop beating — the phone put down, its battery gone. */
  silence(): void;
  /** Stop beating and release the HTTP client. */
  dispose(): Promise<void>;
}

const SCOPE = '[data-role="fixture-stream-body"]';
/** A page's first render — the walkthroughs' NAV_MS. */
const NAV_MS = 30_000;
/** The panel shows a pairing on its read model's NEXT poll (every STREAM_POLL_MS): two polls and a render's slack. */
const READ_MODEL_MS = 2 * STREAM_POLL_MS + 5_000;
const live = new Set<FakeCapturePhone>();
/** Contract breaks (or transport errors) from background beats, thrown by `disposeFakePhones()`. */
const backgroundErrors: string[] = [];

/** A cookie-less HTTP client for a phone: no organiser session, no storage state. */
export async function newPhoneRequest(baseURL: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
}

/** Parse the paste code as a phone would, refusing anything but the §6.2 payload. */
export function parseCaptureQr(text: string): CaptureQr {
  const q = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(q), "the paste code is the QR's four keys, in order, and nothing else (§6.2)").toEqual([...QR_KEYS]);
  expect(q.v, "a v2 QR").toBe(2);
  expect(typeof q.code === "string" && typeof q.tok === "string" && typeof q.slot === "number", "the QR's field types").toBe(true);
  return q as unknown as CaptureQr;
}

/** The paste code the open panel shows. The code card shows it at Ready with no phone; once a phone holds the slot the
 *  card folds to "Paired · Show the code again", which this opens (the organiser's own tap). */
export async function readPanelQrText(page: Page): Promise<string> {
  const scope = page.locator(SCOPE);
  const field = scope.getByTestId("stream-qr-text");
  if ((await field.count()) === 0) {
    const fold = scope.getByTestId("stream-code-disclosure");
    if ((await fold.count()) > 0 && (await fold.getAttribute("open")) === null) await fold.locator("summary").click();
  }
  await expect(field, "the panel shows the stream code's paste code").toBeVisible({ timeout: NAV_MS });
  const text = await field.inputValue();
  expect(text.length, "the paste code is not empty").toBeGreaterThan(0);
  return text;
}

/** RFC 3339 with whole seconds (the beat's `at` refuses milliseconds-only shapes it cannot read, and requires seconds). */
const iso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

async function replyOf<T>(res: APIResponse, ok: z.ZodType<T>, route: string): Promise<PhoneReply<T>> {
  const headers = res.headers();
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${route} -> ${res.status()}: not JSON (${text.slice(0, 200)})`);
  }
  if (headers["cache-control"] !== "private, no-store") {
    throw new Error(`${route} -> ${res.status()}: every phone answer is private, no-store (§6.3); got ${JSON.stringify(headers["cache-control"])}`);
  }
  if (res.status() >= 200 && res.status() < 300) {
    const parsed = ok.safeParse(json);
    if (!parsed.success) throw new Error(`${route} -> ${res.status()} is outside the contract: ${parsed.error.message}\n${text}`);
    return { status: res.status(), headers, ok: parsed.data, refusal: null };
  }
  const refused = CaptureRefusal.safeParse(json);
  if (!refused.success) throw new Error(`${route} -> ${res.status()} is not a contract refusal: ${refused.error.message}\n${text}`);
  return { status: res.status(), headers, ok: null, refusal: refused.data };
}

/**
 * The fake phone, from the QR text the OPEN panel shows (§11.1.5). `request` is the phone's own HTTP client — pass
 * `newPhoneRequest(baseURL)`; one carrying a cookie is refused. `phone` fixes the install id (a second phone, or the
 * same install re-scanning); the default is a fresh 32-hex id. `qrText` is for a phone that scanned EARLIER (an old
 * code kept after a reissue) — the text still came from the panel.
 */
export async function fakeCapturePhone(
  page: Page,
  request: APIRequestContext,
  opts: { phone?: string; qrText?: string } = {},
): Promise<FakeCapturePhone> {
  const state = await request.storageState();
  expect(state.cookies, "the phone's HTTP client carries no organiser session (use newPhoneRequest)").toEqual([]);
  const qr = parseCaptureQr(opts.qrText ?? (await readPanelQrText(page)));
  const id = opts.phone ?? randomBytes(16).toString("hex");
  const auth = { Authorization: `Bearer ${qr.tok}` };
  const base = `/api/v1/capture/codes/${qr.code}`;
  let sid: string | null = null;
  let lastOver: { sid: string; endReason: string } | null = null;
  let lastPollSeconds: number | null = null;
  let beatsSent = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const body = (partial: Partial<BeatBody>): BeatBody => ({
    code: qr.code, slot: qr.slot, phone: id, claim: null, device: null, sid: null, at: iso(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: { percent: 87, charging: false, drainPctPerHour: null },
    thermal: 0, dataUsedMB: 0, appVersion: "1.4.0",
    ...partial,
  });
  const learn = (r: PhoneReply<BeatAnswer>): PhoneReply<BeatAnswer> => {
    const a = r.ok;
    if (a === null) return r;
    if (a.pollSeconds !== undefined) lastPollSeconds = a.pollSeconds;
    if (a.state === "go-live" || a.state === "live") sid = a.sid;
    else if (a.state === "over") {
      lastOver = { sid: a.sid, endReason: a.endReason };
      sid = null;
    } else sid = null;
    return r;
  };
  const beat = async (partial: Partial<BeatBody> = {}): Promise<PhoneReply<BeatAnswer>> => {
    beatsSent++;
    const res = await request.post(`${base}/beats`, { headers: auth, data: body(partial) });
    return learn(await replyOf(res, CaptureBeatAnswer, "POST beats"));
  };

  const phone: FakeCapturePhone = {
    id,
    qr,
    get sid() { return sid; },
    get lastOver() { return lastOver; },
    get lastPollSeconds() { return lastPollSeconds; },
    get beatsSent() { return beatsSent; },
    claim: (kind) => beat({ claim: kind, device: { model: "Pixel 8" } }),
    beat,
    async get(o = {}) {
      const q = o.withPhone === false ? `?slot=${qr.slot}` : `?phone=${encodeURIComponent(id)}&slot=${qr.slot}`;
      return replyOf(await request.get(`${base}${q}`, { headers: auth }), CaptureDescriptor, "GET descriptor");
    },
    async start() {
      return replyOf(await request.post(`${base}/start`, { headers: auth, data: { phone: id } }), CaptureStartOk, "POST start");
    },
    ended: (s) => {
      const held = s ?? sid;
      if (held === null) throw new Error("ended(): this phone holds no broadcast — pass its sid");
      return beat({ state: "ended", sid: held, endReason: "operator-stopped" });
    },
    stoppedBeat: (s) => beat({ sid: null, stopped: s }),
    keepAlive(mode = "idle") {
      if (timer) clearInterval(timer);
      const next = (): Partial<BeatBody> => (mode === "publishing" && sid !== null ? { sid, state: "publishing", transport: "srt", delivery: "ok" } : {});
      timer = setInterval(() => {
        void beat(next()).catch((err: unknown) => {
          if (!disposed) backgroundErrors.push(`phone ${id.slice(0, 8)}: ${String(err)}`);
        });
      }, POLL_STARTING_SECONDS * 1_000);
    },
    silence() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async dispose() {
      disposed = true;
      phone.silence();
      live.delete(phone);
      await request.dispose().catch(() => undefined);
    },
  };
  live.add(phone);
  return phone;
}

/**
 * The A7 repair's one call: a phone that scans the open panel's code, claims the slot through the REAL beat route, and
 * keeps beating (present, ticking nothing) until `disposeFakePhones()`. Asserts the claim was accepted, then waits for
 * the panel to show the phone (its code card folds to "Paired · Show the code again" on the read model's next poll).
 */
export async function pairedPhone(page: Page, opts: { phone?: string; mode?: "idle" | "publishing"; waitForPanel?: boolean } = {}): Promise<FakeCapturePhone> {
  const phone = await fakeCapturePhone(page, await newPhoneRequest(new URL(page.url()).origin), opts);
  const claimed = await phone.claim("new");
  expect(claimed.status, `the phone's claim beat was accepted: ${JSON.stringify(claimed.refusal)}`).toBe(200);
  expect(claimed.ok!.state, "a claim on a free slot is never replaced or taken").not.toMatch(/^(replaced|taken)$/);
  phone.keepAlive(opts.mode ?? "idle");
  if (opts.waitForPanel !== false) {
    await expect(page.locator(SCOPE).getByTestId("stream-code-disclosure"), "the panel shows the paired phone").toBeAttached({ timeout: READ_MODEL_MS });
  }
  return phone;
}

/**
 * Pair a phone with the fixture at `fixturePath` WITHOUT touching the caller's page: a second tab in the same browser
 * context (the organiser's session) opens the fixture's Stream panel on its Phone tab, reads the paste code, claims, and
 * closes. For the cases that reach a session through the API (`goLiveApi`, `holdWaiting`) and must keep their own page
 * — its poll counts, its state — exactly as it was.
 */
export async function pairPhoneOnFixture(page: Page, fixturePath: string, opts: { phone?: string } = {}): Promise<FakeCapturePhone> {
  const tab = await page.context().newPage();
  try {
    await tab.goto(fixturePath);
    const control = tab.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');
    await expect(control, "the fixture page offers its Stream control").toHaveCount(1, { timeout: NAV_MS });
    await control.click();
    const scope = tab.locator(SCOPE);
    await expect(scope).toBeAttached({ timeout: NAV_MS });
    const phoneTab = scope.getByTestId("stream-tab-phone");
    if (await phoneTab.count()) await phoneTab.click();
    return await pairedPhone(tab, { ...opts, waitForPanel: false });
  } finally {
    await tab.close();
  }
}

/** Every phone still beating — for a spec's afterEach, so no keep-alive outlives its test. Returns how many it stopped,
 *  and throws any contract break a background beat recorded. */
export async function disposeFakePhones(): Promise<number> {
  const all = [...live];
  for (const p of all) await p.dispose();
  const errors = backgroundErrors.splice(0);
  if (errors.length > 0) throw new Error(`a background beat broke the capture contract:\n${errors.join("\n")}`);
  return all.length;
}
