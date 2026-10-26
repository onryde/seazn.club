// `isLichessRosterRefusal` is the one question a caller that must CARRY ON past the gate's refusal asks (an automatic waitlist
// promotion skips to the next registrant on it, and rethrows everything else). Asked wrongly one way it swallows real failures;
// the other way it fails a withdrawal for someone else's link. So it is pinned from both sides, against the refusals the
// verdict function ITSELF throws - not against a pair of strings typed here.
import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import { assertPersonIdsLinkedForOnlinePlay, isLichessRosterRefusal, type LichessLinkState } from "../external-accounts";

const caught = (fn: () => void): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};

/** Every distinct way the verdict function answers for one person: a link that plays, a link that must reconnect, no link at all. */
const VERDICTS: { name: string; states: ReadonlyMap<string, LichessLinkState> | null }[] = [
  { name: "plays", states: new Map([["p", "plays"]]) },
  { name: "reconnect", states: new Map([["p", "reconnect"]]) },
  { name: "no link", states: new Map() },
  { name: "nothing read", states: null },
];

describe("isLichessRosterRefusal", () => {
  const thrown = VERDICTS.map((v) => ({ ...v, err: caught(() => assertPersonIdsLinkedForOnlinePlay(v.states, ["p"])) }));

  it("anti-vacuity: the verdict function refuses in exactly two ways, over the four inputs it can be asked", () => {
    expect(thrown).toHaveLength(4);
    const refusals = thrown.filter((t) => t.err !== null);
    expect(refusals.map((t) => t.name)).toEqual(["reconnect", "no link", "nothing read"]);
    expect(new Set(refusals.map((t) => (t.err as HttpError).code)).size, "two distinct codes: reconnect, and link").toBe(2);
  });

  it("is true for every refusal the verdict function throws, and false for the answer that seats", () => {
    for (const t of thrown) {
      expect(isLichessRosterRefusal(t.err), t.name).toBe(t.err !== null);
    }
  });

  it("is false for an HttpError that is not the gate's: another code, no code, another status", () => {
    const refusal = thrown.find((t) => t.name === "no link")!.err as HttpError;
    const others = [
      new HttpError(422, refusal.message, "SOMETHING_ELSE", refusal.extra),
      new HttpError(422, refusal.message),
      new HttpError(409, "Registration settings changed while this was being processed - try again"),
      new HttpError(404, "division not found"),
      new HttpError(500, "boom", "LICHESS_LINK_REQUIRED_NOT"),
    ];
    for (const other of others) expect(isLichessRosterRefusal(other), other.message + " / " + other.code).toBe(false);
  });

  it("is false for anything that is not an HttpError, even one that looks like a refusal", () => {
    const refusal = thrown.find((t) => t.name === "no link")!.err as HttpError;
    const lookalikes: unknown[] = [
      new Error("boom"),
      new Error(refusal.code), // the code, as a message
      Object.assign(new Error(refusal.message), { code: refusal.code, status: 422 }), // the code, on a plain Error
      { code: refusal.code, status: 422, extra: refusal.extra },
      refusal.code,
      null,
      undefined,
      42,
    ];
    for (const value of lookalikes) expect(isLichessRosterRefusal(value), String(value)).toBe(false);
    expect(lookalikes).toHaveLength(8);
  });
});
