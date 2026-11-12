// Player payment page (plan 2026-11-11-player-payment-page, Task 5, moved from Task 7 Step 1): the e2e runner reads a chase mail's
// pay link out of the outbox. It cannot import seal.ts (`server-only`), so e2e/outbox-body-open.ts opens the envelope itself; this
// proves it opens what the product's OWN `sealBody` sealed, under the product's key name, and refuses a damaged one - so an e2e can
// never green on a body the server would not have written (failure class 1: a fixture on both ends proves the fixture).
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOutboxBody, payLinkFrom } from "../../../../e2e/outbox-body-open";
import { OUTBOX_KEK, sealBody } from "../seal";

afterEach(() => {
  vi.unstubAllEnvs();
});

const hexKek = () => randomBytes(32).toString("hex");

describe("e2e outbox opener — opens what the product's sealBody sealed", () => {
  it("round-trips html and text under EMAIL_OUTBOX_KEK", () => {
    vi.stubEnv(OUTBOX_KEK, hexKek());
    vi.stubEnv("RESEND_API_KEY", "");
    const bodies = [
      { html: "<p>Pay <a href=\"https://x.test/r/pay/abc\">here</a></p>", text: "Pay here: https://x.test/r/pay/abc" },
      { html: "", text: "" },
      { html: "<p>ünïcødé — €25.00</p>", text: "ünïcødé — €25.00\n" + "x".repeat(4096) },
    ];
    let checked = 0;
    for (const b of bodies) {
      const sealed = sealBody(b);
      expect(sealed, "premise: the product sealed it").not.toBeNull();
      expect(openOutboxBody(sealed!)).toEqual(b);
      checked += 1;
    }
    expect(checked).toBe(bodies.length);
  });

  it("a tampered byte is refused (GCM tag), and a different key cannot open it", () => {
    vi.stubEnv(OUTBOX_KEK, hexKek());
    vi.stubEnv("RESEND_API_KEY", "");
    const sealed = sealBody({ html: "<p>h</p>", text: "t" })!;
    // The positive pair: the untampered envelope opens.
    expect(openOutboxBody(sealed).text).toBe("t");
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() => openOutboxBody(tampered)).toThrow();
    vi.stubEnv(OUTBOX_KEK, hexKek());
    expect(() => openOutboxBody(sealed)).toThrow();
  });

  it("refuses with the key's own message when EMAIL_OUTBOX_KEK is unset or malformed", () => {
    vi.stubEnv(OUTBOX_KEK, hexKek());
    vi.stubEnv("RESEND_API_KEY", "");
    const sealed = sealBody({ html: "h", text: "t" })!;
    vi.stubEnv(OUTBOX_KEK, "");
    expect(() => openOutboxBody(sealed)).toThrow(/EMAIL_OUTBOX_KEK/);
    vi.stubEnv(OUTBOX_KEK, "zz");
    expect(() => openOutboxBody(sealed)).toThrow(/EMAIL_OUTBOX_KEK/);
  });
});

describe("payLinkFrom — the one /r/pay/<token> href", () => {
  const token = "A".repeat(21) + "_-" + "b".repeat(20); // 43 base64url characters
  it("extracts the one link, even when it appears twice (button and fallback)", () => {
    const href = `https://seazn.test/r/pay/${token}`;
    expect(payLinkFrom(`<a href="${href}">Pay</a> or <a href="${href}">${href}</a>`)).toBe(href);
  });
  it("throws on zero links and on two different links", () => {
    expect(() => payLinkFrom("<p>no link here</p>")).toThrow(/no \/r\/pay\//);
    const other = "C".repeat(43);
    expect(() => payLinkFrom(`<a href="https://s.test/r/pay/${token}">a</a><a href="https://s.test/r/pay/${other}">b</a>`)).toThrow(
      /2 different/,
    );
  });
});
