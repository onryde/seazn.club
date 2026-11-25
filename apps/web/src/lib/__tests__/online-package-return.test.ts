// The division page's reading of the checkout return (spec 2026-11-23-online-chess-credits-design.md §8.4; relay-checkout route,
// `returnTo: "division"`): `?tab=fixtures&oc=pay&checkout=success&session_id=…[&size=N]`. `oc=pay` reopens the receipt; `size` is an
// upgrade's target riding in the address, so it is ladder-validated and anything else is DROPPED (never a price, never free text).
// The route-built URL itself is fed through this parser in the route's own suite (app/api/billing/relay-checkout/__tests__/
// route-online-chess.test.ts, "the success URL parses on the division page"), so both ends are proven against the real producer.
//
// Expected values are typed from the spec and the ladder (decision 4), never from the parser. Anti-vacuity: every sweep reports how
// many values it checked.
import { describe, expect, it } from "vitest";
import { onlineReceiptRequest } from "@/lib/online-package-return";

const LADDER = [16, 32, 64, 128, 256] as const;

describe("onlineReceiptRequest: oc=pay reopens the receipt", () => {
  it("is absent without oc=pay - the ordinary visit asks for nothing (the empty case)", () => {
    expect(onlineReceiptRequest({})).toBeNull();
    expect(onlineReceiptRequest({ size: "64" })).toBeNull(); // a size alone opens nothing
    expect(onlineReceiptRequest({ oc: "" })).toBeNull();
    expect(onlineReceiptRequest({ oc: "PAY" })).toBeNull();
    expect(onlineReceiptRequest({ oc: " pay" })).toBeNull();
    expect(onlineReceiptRequest({ oc: "pay2" })).toBeNull();
    expect(onlineReceiptRequest({ oc: ["pay"] })).toBeNull(); // a repeated key is not the route's shape
    expect(onlineReceiptRequest({ oc: undefined })).toBeNull();
    expect(onlineReceiptRequest({ oc: 1 })).toBeNull();
  });

  it("oc=pay with no size: the receipt reopens on the stored size (a first payment keeps it on the unpaid row)", () => {
    expect(onlineReceiptRequest({ oc: "pay" })).toEqual({ size: null, key: "" });
  });

  it("every size on the ladder is carried through, and only those (sweep)", () => {
    let checked = 0;
    for (const s of LADDER) {
      expect(onlineReceiptRequest({ oc: "pay", size: String(s) })).toEqual({ size: s, key: "" });
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("anything else in `size` is dropped, the receipt still reopens (sweep over the ways a number can be spelled wrong)", () => {
    const dropped = ["0", "8", "15", "17", "48", "100", "512", "-16", "16.0", "016", "1e1", "0x10", "", " 16", "16 ", "+16", "NaN", "Infinity", "sixteen", "16,32", "16abc", "９"];
    for (const raw of dropped) expect(onlineReceiptRequest({ oc: "pay", size: raw }), JSON.stringify(raw)).toEqual({ size: null, key: "" });
    expect(onlineReceiptRequest({ oc: "pay", size: ["16", "32"] })).toEqual({ size: null, key: "" });
    expect(onlineReceiptRequest({ oc: "pay", size: 64 })).toEqual({ size: null, key: "" }); // not a string: the route only ever writes strings
    expect(dropped.length).toBeGreaterThan(15);
  });

  it("the other return params are not this parser's: checkout changes nothing, and the session id is only the arrival's key", () => {
    expect(onlineReceiptRequest({ oc: "pay", checkout: "success", session_id: "cs_test_1", size: "128" })).toEqual({ size: 128, key: "cs_test_1" });
    expect(onlineReceiptRequest({ checkout: "success", session_id: "cs_test_1" })).toBeNull();
  });

  it("the key is the checkout session: two arrivals differ, a refresh of one does not, and anything that is not a session id is no key", () => {
    const a = onlineReceiptRequest({ oc: "pay", checkout: "success", session_id: "cs_test_a1B2" });
    const b = onlineReceiptRequest({ oc: "pay", checkout: "success", session_id: "cs_test_c3D4" });
    expect(a?.key).toBe("cs_test_a1B2");
    expect(b?.key).toBe("cs_test_c3D4");
    expect(a?.key).not.toBe(b?.key);
    expect(onlineReceiptRequest({ oc: "pay", session_id: "cs_test_a1B2" })?.key).toBe(a?.key); // same session, same key
    let checked = 0;
    for (const bad of ["", " cs", "cs test", "cs/..", "cs?x=1", "<b>", "x".repeat(256), ["cs_test_1"], 7, undefined, null]) {
      expect(onlineReceiptRequest({ oc: "pay", session_id: bad })?.key, JSON.stringify(bad)).toBe("");
      checked += 1;
    }
    expect(checked).toBe(11);
  });
});

// Task 15: a short-balance purchase comes back with the receipt's Fair-play camera ANSWER in the address (`cameras=1` Yes, `cameras=0` No), so the page
// reopens the receipt on the answer the buyer left with - either way (at the paid size, the answer alone is what names a change).
describe("onlineReceiptRequest: the camera answer rides the return (`cameras=1` / `cameras=0`)", () => {
  it("cameras=1 is Yes and cameras=0 is No, beside the size; absent otherwise (the key is not even present)", () => {
    expect(onlineReceiptRequest({ oc: "pay", size: "64", cameras: "1" })).toEqual({ size: 64, key: "", cameras: true });
    expect(onlineReceiptRequest({ oc: "pay", cameras: "1" })).toEqual({ size: null, key: "", cameras: true });
    expect(onlineReceiptRequest({ oc: "pay", size: "64", cameras: "0" })).toEqual({ size: 64, key: "", cameras: false });
    expect(onlineReceiptRequest({ oc: "pay", cameras: "0" })).toEqual({ size: null, key: "", cameras: false });
    const plain = onlineReceiptRequest({ oc: "pay", size: "64" })!;
    expect("cameras" in plain, "no answer is no key").toBe(false);
  });

  it("only the exact `1` and `0` are answers (sweep over the ways they can be spelled)", () => {
    const not = ["", "true", "false", "yes", "no", "01", "00", "1 ", " 0", "1.0", "on", "TRUE"];
    for (const raw of not) expect("cameras" in onlineReceiptRequest({ oc: "pay", size: "64", cameras: raw })!, JSON.stringify(raw)).toBe(false);
    const odd = [["1"], ["0"], ["1", "1"], 1, 0, true, false, undefined, null];
    for (const raw of odd) expect("cameras" in onlineReceiptRequest({ oc: "pay", size: "64", cameras: raw })!, JSON.stringify(raw)).toBe(false);
    expect(not.length + odd.length, "anti-vacuity: every spelling was checked").toBe(21);
  });

  it("a camera answer without oc=pay opens nothing (it is the receipt's, never a page's own switch)", () => {
    for (const cameras of ["1", "0"]) {
      expect(onlineReceiptRequest({ cameras })).toBeNull();
      expect(onlineReceiptRequest({ size: "64", cameras })).toBeNull();
    }
  });
});
