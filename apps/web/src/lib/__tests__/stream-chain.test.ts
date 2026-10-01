// The Signal path (spec 2026-09-30 §3.2) as ONE pure mapping. Every expected value below is the SPEC's table — the
// rulebook — never a value read back from `chainFor`: the per-row cases transcribe one row each, and the sweep's oracle
// (`specRow`) is the same table written as a function of the four inputs the table names (session state, phone ingest,
// destination output, and whether D3's 30 s have passed). The input lists come from the wire schema's own enums and
// the domain's own state lists, so a state or an output word added there is swept here without an edit.
//
// One sport is not a question here: the chain reads no sport (the relay is sport-agnostic).
import { describe, expect, it } from "vitest";
import { ACTIVE_STATES, TERMINAL_STATES } from "@/server/relay/domain/session";
import { StreamIngest, StreamOutput, StreamSessionState } from "@/server/api-v1/schemas";
import { OUTPUT_WARNING_AFTER_MS } from "@/lib/stream-session-view";
import { chainFor, type Chain, type ChainNode } from "../stream-chain";

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
