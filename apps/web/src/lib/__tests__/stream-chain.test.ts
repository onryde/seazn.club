// The Signal path (spec 2026-09-30 §3.2) as ONE pure mapping. Every expected value below is the SPEC's table — the
// rulebook — never a value read back from `chainFor`: the per-row cases transcribe one row each, and the sweep's oracle
// (`specRow`) is the same table written as a function of the four inputs the table names (session state, phone ingest,
// destination output, and whether D3's 30 s have passed). The input lists come from the wire schema's own enums and
// the domain's own state lists, so a state or an output word added there is swept here without an edit.
//
// One sport is not a question here: the chain reads no sport (the relay is sport-agnostic).
import { describe, expect, it } from "vitest";
import { ACTIVE_STATES, TERMINAL_STATES } from "@/server/relay/domain/session";
import { StreamIngest, StreamLostCountdown, StreamOutput, StreamSessionState, type StreamPhone, type StreamSessionCurrent } from "@/server/api-v1/schemas";
import { OUTPUT_WARNING_AFTER_MS, phoneStrip } from "@/lib/stream-session-view";
import { chainFor, phoneDot, type Chain, type ChainNode, type LinkStyle, type PhoneDot } from "../stream-chain";
import { HEALTH_REASONS } from "@/server/relay/domain/health-reasons";

type State = (typeof StreamSessionState.options)[number];
type IngestWord = (typeof StreamIngest.shape.state.options)[number];
type OutputWord = (typeof StreamOutput.shape.state.options)[number];

/** A projection literal: only the three fields the chain reads. `elapsedMs` is the SERVER's measure (M6). */
const v = (state: State, ingest: IngestWord | null, output: OutputWord | null, elapsedMs = 0) => ({
  state,
  ingest: ingest ? { state: ingest, protocol: "srt" as const } : null,
  output: output ? { state: output, since: "2026-09-30T12:00:00.000Z", elapsedMs } : null,
});

const n = (tone: ChainNode["tone"], word: ChainNode["word"], mark: ChainNode["mark"] = null): ChainNode => ({ tone, word, mark });
const W = OUTPUT_WARNING_AFTER_MS;

describe("chainFor — spec §3.2, row by row", () => {
  it("the threshold the D3 rows are drawn at is the spec's 30 s (the lib's constant, pinned to the spec's number)", () => {
    expect(W).toBe(30_000);
  });

  it("idle (no session): all slate, dashed; Not connected · Ready · Not live", () => {
    expect(chainFor(null)).toEqual({
      phone: n("slate", "notConnected"), link1: "idle",
      seazn: n("slate", "ready"), link2: "idle",
      dest: n("slate", "notLive"),
    });
  });

  it("idle with the picked destination held by another match (mockup state 5): the destination node says In use, slate; nothing else moves", () => {
    expect(chainFor(null, { destInUse: true })).toEqual({
      phone: n("slate", "notConnected"), link1: "idle",
      seazn: n("slate", "ready"), link2: "idle",
      dest: n("slate", "inUse"),
    });
    // The flag is the idle row's only: a session that exists draws its own destination whatever a stale refusal says.
    expect(chainFor(v("live", "connected", "ok"), { destInUse: true })!.dest).toEqual(n("red", "live", "dot"));
  });

  it("requested / provisioning / warming: amber Waiting, link 1 animated lime, link 2 idle, destination Not live", () => {
    let checked = 0;
    for (const s of ["requested", "provisioning", "warming"] as const) {
      expect(chainFor(v(s, null, null)), s).toEqual({
        phone: n("amber", "waiting"), link1: "connecting",
        seazn: n("amber", "waiting"), link2: "idle",
        dest: n("slate", "notLive"),
      });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("live, output ok: lime Connected · Receiving, both links flowing, destination red Live with a dot — however long it has been ok", () => {
    expect(chainFor(v("live", "connected", "ok", W * 5))).toEqual({
      phone: n("lime", "connected"), link1: "flowing",
      seazn: n("lime", "receiving"), link2: "flowing",
      dest: n("red", "live", "dot"),
    });
  });

  it("live, output connecting under 30 s: link 2 animated, destination amber Connecting; the phone half is untouched", () => {
    const c = chainFor(v("live", "connected", "connecting", W - 1))!;
    expect(c.link2).toBe("connecting");
    expect(c.dest).toEqual(n("amber", "connecting"));
    expect(c.link1).toBe("flowing");
    expect(c.phone).toEqual(n("lime", "connected"));
  });

  it("live, output not ok for 30 s or more (D3): link 2 amber dashes, destination amber '!' Not receiving — for EVERY non-ok word", () => {
    const notOk = StreamOutput.shape.state.options.filter((o) => o !== "ok");
    let checked = 0;
    for (const o of notOk) {
      const c = chainFor(v("live", "connected", o, W))!;
      expect(c.link2, o).toBe("problem");
      expect(c.dest, o).toEqual(n("amber", "notReceiving", "bang"));
      expect(c.phone, `${o}: the phone half never moves for the destination`).toEqual(n("lime", "connected"));
      checked++;
    }
    expect(checked, "anti-vacuity: the schema declares non-ok words").toBeGreaterThanOrEqual(3);
  });

  it("D3 boundary: one millisecond under the threshold is still Connecting, the threshold itself is Not receiving", () => {
    expect(chainFor(v("live", "connected", "unknown", W - 1))!.dest.word).toBe("connecting");
    expect(chainFor(v("live", "connected", "unknown", W))!.dest.word).toBe("notReceiving");
  });

  it("back to ok after a warning: the next projection reads ok, and the row is ok's — nothing latches", () => {
    const warned = chainFor(v("live", "connected", "connecting", W * 2))!;
    expect(warned.dest.word).toBe("notReceiving");
    expect(chainFor(v("live", "connected", "ok", 0))!.dest).toEqual(n("red", "live", "dot"));
  });

  it("live, phone ingest stale: phone amber No signal, link 1 amber dashes, Seazn amber Waiting; link 2 and destination follow the output", () => {
    const c = chainFor(v("live", "disconnected", "ok"))!;
    expect(c.phone).toEqual(n("amber", "noSignal"));
    expect(c.link1).toBe("problem");
    expect(c.seazn).toEqual(n("amber", "waiting"));
    expect(c.link2).toBe("flowing");
    expect(c.dest).toEqual(n("red", "live", "dot"));
  });

  // The chain's "!" (controller ruling 2026-10-01, B5 re-review 2 n-2): in the phone-no-signal state the "!" sits on the
  // PHONE node, not the destination — it follows the D3 box, which points at the phone there (I-1). The destination
  // keeps its amber "Not receiving" and its amber dashes: it is still not receiving; it is just not the cause.
  it("live, phone no signal, past the hold: the '!' sits on the PHONE node; the destination stays amber Not receiving with no mark — for EVERY non-ok word and every not-connected ingest word", () => {
    const notOk = StreamOutput.shape.state.options.filter((o) => o !== "ok");
    const silent = StreamIngest.shape.state.options.filter((i) => i !== "connected");
    let checked = 0;
    for (const i of silent) for (const o of notOk) {
      const c = chainFor(v("live", i, o, W))!;
      expect(c.phone, `${i} × ${o}`).toEqual(n("amber", "noSignal", "bang"));
      expect(c.link1, `${i} × ${o}`).toBe("problem");
      expect(c.seazn, `${i} × ${o}`).toEqual(n("amber", "waiting"));
      expect(c.link2, `${i} × ${o}`).toBe("problem");
      expect(c.dest, `${i} × ${o}: no "!" on the destination`).toEqual(n("amber", "notReceiving"));
      checked++;
    }
    expect(checked, "anti-vacuity: silent ingest words × non-ok words").toBe(silent.length * notOk.length);
    expect(checked).toBeGreaterThanOrEqual(2 * 3);
  });

  it("…under the hold the silent phone carries no '!' (there is no D3 box yet), and with the destination ok neither node does", () => {
    expect(chainFor(v("live", "disconnected", "connecting", W - 1))!.phone).toEqual(n("amber", "noSignal"));
    expect(chainFor(v("live", "disconnected", "connecting", W - 1))!.dest).toEqual(n("amber", "connecting"));
    expect(chainFor(v("live", "disconnected", "ok", W * 3))!.phone).toEqual(n("amber", "noSignal"));
  });

  it("live with NO ingest read (a failed provider read, N1) is NOT stale: nothing is decided on an unknown — the phone stays Connected", () => {
    expect(chainFor(v("live", null, "ok"))!.phone).toEqual(n("lime", "connected"));
  });

  it("live with no output read yet (or a composed session): Connecting, never Not receiving — there is nothing to judge", () => {
    expect(chainFor(v("live", "connected", null))!.dest).toEqual(n("amber", "connecting"));
  });

  it("ending: all slate, links idle, destination Ending…", () => {
    expect(chainFor(v("ending", "connected", "ok"))).toEqual({
      phone: n("slate", "connected"), link1: "idle",
      seazn: n("slate", "receiving"), link2: "idle",
      dest: n("slate", "ending"),
    });
  });

  it("every ACTIVE state draws a chain and every TERMINAL state draws none — both lists the domain's own", () => {
    let checked = 0;
    for (const s of ACTIVE_STATES) { expect(chainFor(v(s, "connected", "ok")), s).not.toBeNull(); checked++; }
    for (const s of TERMINAL_STATES) { expect(chainFor(v(s, null, null)), s).toBeNull(); checked++; }
    expect(checked).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
    expect(checked, "anti-vacuity").toBeGreaterThan(0);
  });
});

/** The §3.2 table as a function of its four inputs — the rulebook, typed once, for the sweep. */
function specRow(state: State, ingest: IngestWord | null, output: OutputWord | null, warned: boolean): Chain | null {
  if (state === "completed" || state === "failed") return null;
  if (state === "requested" || state === "provisioning" || state === "warming") {
    return { phone: n("amber", "waiting"), link1: "connecting", seazn: n("amber", "waiting"), link2: "idle", dest: n("slate", "notLive") };
  }
  if (state === "ending") {
    return { phone: n("slate", "connected"), link1: "idle", seazn: n("slate", "receiving"), link2: "idle", dest: n("slate", "ending") };
  }
  // live
  const half: Pick<Chain, "link2" | "dest"> =
    output === "ok" ? { link2: "flowing", dest: n("red", "live", "dot") }
      : output !== null && warned ? { link2: "problem", dest: n("amber", "notReceiving", "bang") }
        : { link2: "connecting", dest: n("amber", "connecting") };
  const stale = ingest !== null && ingest !== "connected";
  if (!stale) return { phone: n("lime", "connected"), link1: "flowing", seazn: n("lime", "receiving"), ...half };
  // The "!" follows the D3 box (ruling 2026-10-01): with the phone silent it sits on the phone, never the destination.
  const bangOnPhone = half.dest.mark === "bang";
  return {
    phone: n("amber", "noSignal", bangOnPhone ? "bang" : null), link1: "problem", seazn: n("amber", "waiting"),
    link2: half.link2, dest: bangOnPhone ? { ...half.dest, mark: null } : half.dest,
  };
}

describe("chainFor — the whole input space against the table", () => {
  it("every session state × phone ingest × destination output × side of the 30 s line matches §3.2", () => {
    const ingests: (IngestWord | null)[] = [null, ...StreamIngest.shape.state.options];
    const outputs: (OutputWord | null)[] = [null, ...StreamOutput.shape.state.options];
    const elapsed = [0, W - 1, W, W * 10];
    let checked = 0;
    let warnedRows = 0;
    let phoneBangRows = 0;
    let destBangRows = 0;
    for (const state of StreamSessionState.options) {
      for (const ingest of ingests) {
        for (const output of outputs) {
          for (const ms of elapsed) {
            const expected = specRow(state, ingest, output, ms >= W);
            expect(chainFor(v(state, ingest, output, ms)), `${state} · ingest ${ingest} · output ${output} · ${ms} ms`).toEqual(expected);
            if (expected?.dest.word === "notReceiving") warnedRows++;
            if (expected?.phone.mark === "bang") phoneBangRows++;
            if (expected?.dest.mark === "bang") destBangRows++;
            checked++;
          }
        }
      }
    }
    expect(checked, "anti-vacuity: the full product was swept").toBe(
      StreamSessionState.options.length * ingests.length * outputs.length * elapsed.length,
    );
    expect(checked).toBeGreaterThanOrEqual(7 * 4 * 5 * 4);
    expect(warnedRows, "the D3 row really was reached by the sweep").toBeGreaterThan(0);
    expect(phoneBangRows, "the '!' on the phone was reached by the sweep").toBeGreaterThan(0);
    expect(destBangRows, "…and the '!' on the destination too").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Capture QR v2 §6.12 (T11, Option B rev 2): with the phone's read model (`capture`), the PHONE node says Paired / Not
// answering at Ready, Starting while the session waits, and "Reconnecting…" instead of "No signal" while live with the
// input not connected. The "!" stays on the phone during the countdown and is dropped while the phone still beats (its
// reason shows instead). Every other node and link is the §3.2 table's, and a session with no `capture` (C-1: a legacy
// session, pairing_id null) is exactly today's chain. Expected values are §6.12's rulings, written out here.
// ---------------------------------------------------------------------------------------------------------------------
type CapturePhone = NonNullable<Parameters<typeof chainFor>[1]>["capture"];
const beating = (over: Record<string, unknown> = {}) => ({
  present: true, silent: false, notResponding: false, model: null, appVersion: null, mode: null, state: "publishing",
  notReady: null, notReadyForMs: null, notReadyShown: false, health: null, startFailed: null, lastBeatAt: "2026-09-30T12:00:00.000Z", elapsedMs: 5_000,
  beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null }, farPoll: false, ...over,
}) as NonNullable<NonNullable<CapturePhone>["phone"]>;
const LIVE_CD = { kind: "live" as const, reason: "phone_lost" as const, elapsedMs: 160_000, remainingMs: 740_000 };

describe("chainFor — capture v2's phone node (T11)", () => {
  it("Ready: no phone → slate Not connected; present → lime Paired; not answering → amber Not answering — the rest is idle's", () => {
    const rows: [string, CapturePhone, ChainNode][] = [
      ["no phone (the empty case)", { phone: null, countdown: null }, n("slate", "notConnected")],
      ["paired and present", { phone: beating({ state: "paired" }), countdown: null }, n("lime", "paired")],
      ["paired but silent (§6.9)", { phone: beating({ present: false, silent: true }), countdown: null }, n("amber", "notAnswering")],
    ];
    let checked = 0;
    for (const [name, capture, phone] of rows) {
      expect(chainFor(null, { capture }), name).toEqual({ ...chainFor(null)!, phone });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("waiting (requested / provisioning / warming): the phone node is amber Starting; everything else is §3.2's waiting row", () => {
    let checked = 0;
    for (const s of ["requested", "provisioning", "warming"] as const) {
      expect(chainFor(v(s, "disconnected", null), { capture: { phone: beating(), countdown: null } }), s).toEqual({
        ...chainFor(v(s, "disconnected", null))!, phone: n("amber", "starting"),
      });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("live, input not connected: Reconnecting… — with the '!' while the server counts down, and without it while the phone beats with a reason", () => {
    const counting = chainFor(v("live", "disconnected", "unknown", W), { capture: { phone: beating({ present: false, silent: true }), countdown: LIVE_CD } })!;
    expect(counting.phone).toEqual(n("amber", "reconnecting", "bang"));
    expect(counting.dest, "the cause is the phone: no mark on the destination").toEqual(n("amber", "notReceiving"));
    // The paused mockup: the phone still beats with a reason → no "!" (no countdown), the destination unmarked.
    const paused = chainFor(v("live", "disconnected", "unknown", W), { capture: { phone: beating({ notReady: "camera" }), countdown: null } })!;
    expect(paused.phone).toEqual(n("amber", "reconnecting"));
    expect(paused.dest).toEqual(n("amber", "notReceiving"));
    // No reason and no countdown past the hold: D3's phone box shows, so the "!" follows it as today.
    expect(chainFor(v("live", "disconnected", "unknown", W), { capture: { phone: beating(), countdown: null } })!.phone).toEqual(n("amber", "reconnecting", "bang"));
    // Under the hold with no countdown: no "!".
    expect(chainFor(v("live", "disconnected", "connecting", W - 1), { capture: { phone: beating(), countdown: null } })!.phone).toEqual(n("amber", "reconnecting"));
    // The countdown alone earns the "!", even under the D3 hold.
    expect(chainFor(v("live", "disconnected", "connecting", W - 1), { capture: { phone: null, countdown: LIVE_CD } })!.phone).toEqual(n("amber", "reconnecting", "bang"));
  });

  it("W24: Reconnecting… ONLY while the input is not connected — a connected (or unread) input is §3.2's lime Connected", () => {
    const capture = { phone: beating({ notReady: "camera" }), countdown: null };
    expect(chainFor(v("live", "connected", "ok"), { capture })).toEqual(chainFor(v("live", "connected", "ok")));
    expect(chainFor(v("live", null, "ok"), { capture })).toEqual(chainFor(v("live", null, "ok")));
  });

  it("the whole input space: with capture, ONLY the phone node and link 1 may differ from §3.2's row — link 1 only to `problem`, only while waiting under a lost-phone countdown; link 2, Seazn and the destination are the table's; without it (legacy) the chain is today's", () => {
    const ingests: (IngestWord | null)[] = [null, ...StreamIngest.shape.state.options];
    const outputs: (OutputWord | null)[] = [null, ...StreamOutput.shape.state.options];
    const captures: CapturePhone[] = [
      { phone: null, countdown: null }, { phone: beating(), countdown: null }, { phone: beating({ notReady: "held" }), countdown: null },
      { phone: beating({ present: false, silent: true }), countdown: LIVE_CD },
    ];
    // The coordinator's ruling (B8 re-review, item 6): in a WAITING state a countdown about a lost phone draws link 1 as
    // live's W19 does — `problem` — beside the node's "!", the strip and the dot. Written from the rule, not read back.
    const WAITING = ["requested", "provisioning", "warming"];
    let checked = 0;
    let phoneMoved = 0;
    let linkMoved = 0;
    for (const state of StreamSessionState.options) for (const ingest of ingests) for (const output of outputs) for (const ms of [0, W]) {
      const legacy = chainFor(v(state, ingest, output, ms));
      expect(chainFor(v(state, ingest, output, ms), {}), "no capture = today").toEqual(legacy);
      for (const capture of captures) {
        const c = chainFor(v(state, ingest, output, ms), { capture });
        if (legacy === null) { expect(c).toBeNull(); checked++; continue; }
        const where = `${state} ${ingest} ${output} ${ms}`;
        expect({ ...c!, phone: null, link1: null }, where).toEqual({ ...legacy, phone: null, link1: null });
        const lostWhileWaiting = WAITING.includes(state) && capture?.countdown?.reason === "phone_lost";
        expect(c!.link1, `${where}: link 1`).toBe(lostWhileWaiting ? "problem" : legacy.link1);
        if (JSON.stringify(c!.phone) !== JSON.stringify(legacy.phone)) phoneMoved++;
        if (c!.link1 !== legacy.link1) linkMoved++;
        checked++;
      }
    }
    expect(checked).toBe(StreamSessionState.options.length * ingests.length * outputs.length * 2 * captures.length);
    expect(phoneMoved, "anti-vacuity: the v2 words were reached").toBeGreaterThan(0);
    expect(linkMoved, "anti-vacuity: link 1 moved somewhere").toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// B8 re-review item 1: the Phone node and the strip under it are ONE statement. Both read the SAME fact — the server's
// countdown on `current` (`phoneStrip` keys its sentence on it; `chainFor` gets it as `capture.countdown`) — so for every
// countdown the wire declares they must say the same thing about the phone. The table is the rule text, written out:
//  - warming, no_inbound_timeout: the phone checks in and its video has not arrived — "Starting", no mark (the signed-off
//    mockup's warming state, Option B rev 2 §5);
//  - warming, phone_lost (ask 10): the phone STOPPED checking in — the node says what Ready's silent node says, "Not
//    answering", with the "!" (the stream will be cancelled because of the phone);
//  - live, phone_lost (W19): "Reconnecting…" with the "!" (mockup §6) — in `live`, and in a warming RECONNECT (§5.4: first
//    ingest set, still live for W19), whose strip says the same sentence.
// The "!" is on the phone exactly when the sentence is about a LOST phone. The read model's own `present` never moves the
// node here: in ask 10's window the phone is not yet silent (§6.9's threshold IS ask 10's end), so a node keyed on it
// would read "Starting" beside "The phone stopped checking in" — the defect this table exists for.
// Link 1 (phone → Seazn) is the FOURTH voice (coordinator ruling, B8 re-review item 6): amber `problem` exactly when the
// phone is lost, as live's W19 draws it; the warming timeout keeps waiting's `connecting`.
// The folded "Paired · Show the code again" line's dot is the THIRD voice (coordinator ruling on the B8 re-review's open
// point): while the server counts down it reads the same countdown — amber exactly when the phone is lost, lime while
// the phone still checks in (the timeout) — never the read model's `present`, which is still true in ask 10's window.
// ---------------------------------------------------------------------------------------------------------------------
describe("W24 — the Phone node, link 1, the strip and the fold's dot agree for every countdown the wire declares", () => {
  type Countdown = import("@/server/api-v1/schemas").StreamLostCountdown;
  /** Every (kind, reason) the wire's union declares, read off the schema — a reason added there is swept here. */
  const WIRE: [Countdown["kind"], Countdown["reason"]][] = StreamLostCountdown.options.flatMap((o) => {
    const kind = o.shape.kind.value;
    const reason = o.shape.reason;
    const reasons = "options" in reason ? (reason.options as Countdown["reason"][]) : [reason.value as Countdown["reason"]];
    return reasons.map((r) => [kind, r] as [Countdown["kind"], Countdown["reason"]]);
  });
  const TABLE: Record<string, { key: string; node: ChainNode; link1: LinkStyle; dot: PhoneDot }> = {
    "warming.no_inbound_timeout": { key: "stream.phone.countdown.warming.no_inbound_timeout", node: n("amber", "starting"), link1: "connecting", dot: "lime" },
    "warming.phone_lost": { key: "stream.phone.countdown.warming.phone_lost", node: n("amber", "notAnswering", "bang"), link1: "problem", dot: "amber" },
    "live.phone_lost": { key: "stream.phone.countdown.live.phone_lost", node: n("amber", "reconnecting", "bang"), link1: "problem", dot: "amber" },
  };
  /** The states each kind is served in: `warming` before any video; `live` in live AND in a warming reconnect. */
  const STATES: Record<Countdown["kind"], readonly ("live" | "warming")[]> = { warming: ["warming"], live: ["live", "warming"] };
  const projection = (state: "live" | "warming", countdown: Countdown | null) => ({
    ...v(state, "disconnected", countdown?.kind === "live" ? "unknown" : null, W),
    countdown,
  }) as unknown as StreamSessionCurrent;
  const readModel = (phone: ReturnType<typeof beating>) => ({ legacy: false, phone }) as unknown as StreamPhone;

  it("the table covers exactly the wire's countdowns — no more, no fewer", () => {
    expect(WIRE.map(([k, r]) => `${k}.${r}`).sort()).toEqual(Object.keys(TABLE).sort());
    expect(WIRE.length, "anti-vacuity").toBeGreaterThanOrEqual(3);
  });

  it("every countdown: the strip says the table's sentence, the node the table's word, link 1 the table's style and the fold's dot the table's tone — the '!', link 1's `problem` and the amber dot exactly when the phone is lost — whatever the read model says of the phone's presence", () => {
    let checked = 0;
    let lost = 0;
    for (const [kind, reason] of WIRE) {
      const row = TABLE[`${kind}.${reason}`]!;
      const countdown = { kind, reason, elapsedMs: 40_000, remainingMs: 20_000 } as Countdown;
      // ask 10's real window has the phone still `present` (not yet silent); a staged one may say silent — both agree.
      for (const state of STATES[kind]) for (const phone of [beating(), beating({ present: false, silent: true })]) {
        const session = projection(state, countdown);
        const where = `${kind}.${reason} in ${state} (present ${phone.present})`;
        const strip = phoneStrip(readModel(phone), session);
        expect(strip?.body?.key, `${where}: the strip`).toBe(row.key);
        const chain = chainFor(session, { capture: { phone, countdown } })!;
        expect(chain.phone, `${where}: the node`).toEqual(row.node);
        expect(chain.phone.mark === "bang", `${where}: the '!' iff the phone is lost`).toBe(reason === "phone_lost");
        expect(chain.link1, `${where}: link 1`).toBe(row.link1);
        expect(chain.link1 === "problem", `${where}: link 1 is a problem iff the node carries the '!'`).toBe(chain.phone.mark === "bang");
        const dot = phoneDot({ phone, countdown });
        expect(dot, `${where}: the fold's dot`).toBe(row.dot);
        expect(dot === "amber", `${where}: the dot is amber iff the node carries the '!'`).toBe(chain.phone.mark === "bang");
        if (reason === "phone_lost") lost++;
        checked++;
      }
    }
    // warming.no_inbound_timeout ×1 state, warming.phone_lost ×1, live.phone_lost ×2 (live, warming reconnect); ×2 phones.
    expect(checked).toBe(WIRE.reduce((sum, [k]) => sum + STATES[k].length, 0) * 2);
    expect(checked).toBe(8);
    expect(lost, "every lost row was reached").toBe(6);
  });

  it("the empty case: warming with NO countdown — the strip leads with 'Waiting' alone and the node is Starting with no mark, even with the read model saying silent", () => {
    let checked = 0;
    for (const phone of [beating(), beating({ present: false, silent: true })]) {
      const session = projection("warming", null);
      const strip = phoneStrip(readModel(phone), session);
      expect(strip).toEqual({ tone: "slate", icon: "clock", lead: "stream.phone.waitingVideo", body: null });
      expect(chainFor(session, { capture: { phone, countdown: null } })!.phone).toEqual(n("amber", "starting"));
      expect(chainFor(session, { capture: { phone, countdown: null } })!.link1, "no countdown: waiting's link 1").toBe("connecting");
      // No countdown: the dot reads the read model, as Ready's does (the strip and node say nothing of presence here).
      expect(phoneDot({ phone, countdown: null }), `present ${phone.present}`).toBe(phone.present ? "lime" : "amber");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the empty case, Ready (no session, so no countdown): the dot and the node read the read model alike — present → lime Paired, silent → amber Not answering, no phone → slate", () => {
    const rows: [ReturnType<typeof beating> | null, PhoneDot, ChainNode | null][] = [
      [beating(), "lime", n("lime", "paired")],
      [beating({ present: false, silent: true }), "amber", n("amber", "notAnswering")],
      [null, "slate", null],
    ];
    let checked = 0;
    for (const [phone, dot, node] of rows) {
      expect(phoneDot({ phone, countdown: null }), `present ${phone?.present}`).toBe(dot);
      if (node) expect(chainFor(null, { capture: { phone, countdown: null } })!.phone).toEqual(node);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a lost-phone countdown with the read model unread (null facts) is still amber — the countdown is the server's word, not the read model's", () => {
    let checked = 0;
    for (const [kind, reason] of WIRE) {
      const countdown = { kind, reason, elapsedMs: 40_000, remainingMs: 20_000 } as Countdown;
      expect(phoneDot({ phone: null, countdown }), `${kind}.${reason}`).toBe(reason === "phone_lost" ? "amber" : "slate");
      checked++;
    }
    expect(checked).toBe(WIRE.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// PR-2 (§7.4, Option A states 5 and 8): live with the input UP, the SERVER's `phone.health` moves the Phone node — not
// responding is "Not answering" with the "!" (and the fold's dot amber with it: one statement, as W24's voices are), stalled
// keeps the row's word with the "!". Hot and battery low are the strip's alone (the phone still sends). Never a reading
// against a client threshold: a scorching phone the server has not named moves nothing.
// ---------------------------------------------------------------------------------------------------------------------
describe("PR-2 §7.4 — the Phone node reads the server's health verdict, live with the input up", () => {
  const liveUp = v("live", "connected", "ok");
  it("each reason the domain declares: not responding → amber Not answering '!'; stalled → amber, the row's word, '!'; hot and battery low → the row's node", () => {
    const row = chainFor(liveUp)!.phone;
    const WANT: Record<string, ChainNode> = {
      not_responding: n("amber", "notAnswering", "bang"),
      stalled: n("amber", row.word, "bang"),
      hot: row,
      battery_low: row,
    };
    let checked = 0;
    for (const health of HEALTH_REASONS) {
      const capture = { phone: beating({ health }), countdown: null };
      const c = chainFor(liveUp, { capture })!;
      expect(c.phone, health).toEqual(WANT[health]);
      // Owner rulings 2026-10-08: stalled also moves the SEAZN node and LINK 1 (both below) — nothing else moves for any reason.
      expect({ ...c, phone: null, seazn: null, link1: null }, `${health}: nothing else moves`).toEqual({ ...chainFor(liveUp)!, phone: null, seazn: null, link1: null });
      expect(phoneDot(capture), `${health}: the fold's dot`).toBe(health === "not_responding" ? "amber" : "lime");
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length);
  });

  // Owner ruling 2026-10-08 (B7 fix round 1, B): while the server says the video is not reaching Seazn, the Seazn node does
  // not claim "Receiving" — it says "Waiting for video" (amber, as every waiting word on the chain is). The SAME verdict,
  // never a client reading: `delivery: "stalled"` with health null moves nothing (the empty case below).
  it("the Seazn node: stalled → amber 'Waiting for video', no mark; every other verdict (and none) → the row's lime Receiving", () => {
    const row = chainFor(liveUp)!.seazn;
    expect(row, "PREMISE: the row's live Seazn node").toEqual(n("lime", "receiving"));
    let checked = 0;
    for (const health of [...HEALTH_REASONS, null]) {
      const c = chainFor(liveUp, { capture: { phone: beating({ health }), countdown: null } })!;
      expect(c.seazn, String(health)).toEqual(health === "stalled" ? n("amber", "waitingVideo") : row);
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length + 1);
    expect(HEALTH_REASONS, "PREMISE: the domain declares stalled").toContain("stalled");
    expect(chainFor(liveUp, { capture: { phone: null, countdown: null } })!.seazn, "no phone facts").toEqual(row);
  });

  // Owner ruling 2026-10-08 (B8, relayed by the controller): while the server says the video is not reaching Seazn, the
  // phone → Seazn link does not draw as flowing (solid lime) beside "Waiting for video" — it draws the chain's existing
  // `problem` style (the amber dashes live's no-signal row and a lost phone's countdown already use). The SAME verdict
  // that moves the Seazn node; the Seazn → destination link is the destination's alone and does not move.
  it("link 1 (phone → Seazn): stalled → problem, the amber dashes; healthy live and every other verdict → the row's flowing; link 2 never moves", () => {
    const row = chainFor(liveUp)!;
    expect(row.link1, "PREMISE: healthy live draws link 1 flowing").toBe("flowing");
    expect(row.link2, "PREMISE: the destination ok draws link 2 flowing").toBe("flowing");
    let checked = 0;
    for (const health of [...HEALTH_REASONS, null]) {
      const c = chainFor(liveUp, { capture: { phone: beating({ health }), countdown: null } })!;
      expect(c.link1, `${String(health)}: link 1`).toBe(health === "stalled" ? "problem" : "flowing");
      expect(c.link2, `${String(health)}: link 2`).toBe(row.link2);
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length + 1);
    // A destination still connecting keeps ITS link 2 under the verdict too: only link 1 is the phone's.
    const connecting = v("live", "connected", null);
    const stalledThere = chainFor(connecting, { capture: { phone: beating({ health: "stalled" }), countdown: null } })!;
    expect(stalledThere.link1, "stalled, destination connecting: link 1").toBe("problem");
    expect(stalledThere.link2, "stalled, destination connecting: link 2 is the row's").toBe(chainFor(connecting)!.link2);
    expect(chainFor(liveUp, { capture: { phone: null, countdown: null } })!.link1, "no phone facts: flowing").toBe("flowing");
  });

  it("the stalled word and dashes are LIVE-with-the-input-up only: waiting, live with no signal and Ending keep the row's Seazn node and link 1", () => {
    const capture = { phone: beating({ health: "stalled" }), countdown: null };
    const rows = [v("warming", "disconnected", null), v("live", "disconnected", "unknown", W), v("ending", "connected", "ok")];
    let checked = 0;
    for (const view of rows) {
      expect(chainFor(view, { capture })!.seazn, view.state + " " + view.ingest?.state).toEqual(chainFor(view)!.seazn);
      expect(chainFor(view, { capture })!.link1, `${view.state} ${view.ingest?.state}: link 1`).toBe(chainFor(view)!.link1);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("the EMPTY case and the client-threshold mutant: health null with readings past every W9 limit → the row's lime node, the dot lime", () => {
    const scorching = beating({ health: null, beat: { battery: { percent: 1, charging: false, drainPctPerHour: 50 }, bitrateKbps: 1, delivery: "stalled", thermal: 6, dataUsedMB: 1 } });
    expect(chainFor(liveUp, { capture: { phone: scorching, countdown: null } })!.phone).toEqual(chainFor(liveUp)!.phone);
    expect(chainFor(liveUp, { capture: { phone: scorching, countdown: null } })!.seazn, "delivery stalled, no verdict: Receiving").toEqual(chainFor(liveUp)!.seazn);
    expect(chainFor(liveUp, { capture: { phone: scorching, countdown: null } })!.link1, "delivery stalled, no verdict: link 1 flowing").toBe("flowing");
    expect(phoneDot({ phone: scorching, countdown: null })).toBe("lime");
  });

  it("pre-live and with the input DOWN the verdict moves nothing here: Ready, waiting and live-no-signal keep their T11 nodes", () => {
    let checked = 0;
    for (const health of HEALTH_REASONS) {
      const capture = { phone: beating({ health }), countdown: null };
      expect(chainFor(null, { capture })!.phone, `ready ${health}`).toEqual(chainFor(null, { capture: { phone: beating(), countdown: null } })!.phone);
      expect(chainFor(v("warming", "disconnected", null), { capture })!.phone, `warming ${health}`).toEqual(n("amber", "starting"));
      const down = v("live", "disconnected", "unknown", W);
      expect(chainFor(down, { capture })!.phone, `live down ${health}`).toEqual(chainFor(down, { capture: { phone: beating(), countdown: null } })!.phone);
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length);
  });
});
