// "Open in app" link shapes (spec 2026-11-25 §5.1): the credential only ever after `#`, the stream fragment the unpadded
// base64url of the UTF-8 bytes of the exact QR text. `Buffer` is the test's independent decoder; the module under test
// may not use it (it runs in the browser). No sport is read here.
import { describe, expect, it } from "vitest";
import { captureQrV2Text } from "@/lib/capture-qr";
import { dayAppLink, scoreAppLink, streamAppLink } from "@/lib/open-in-app";

const STG = "https://stg.seazn.club";
const PROD = "https://seazn.club";
const fragmentOf = (url: string): string => url.slice(url.indexOf("#") + 1);

describe("streamAppLink", () => {
  it.each([
    captureQrV2Text({ v: 2, code: "0123456789ab", slot: 0, tok: "A".repeat(22) }),
    captureQrV2Text({ v: 2, code: "0123456789ab", slot: 3, tok: "_-".repeat(11), exp: 1795600000 }),
  ])("stream fragment round-trips the QR text byte for byte: %s", (text) => {
    const url = streamAppLink(STG, text);
    const [head, frag] = url.split("#");
    expect(head).toBe("https://stg.seazn.club/app/stream");
    expect(frag).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(frag!, "base64url").toString("utf8")).toBe(text);
  });

  it("encodes UTF-8 bytes, not UTF-16 code units or Latin-1", () => {
    const text = '{"v":2,"x":"é ü 日本 🎾"}';
    const frag = fragmentOf(streamAppLink(PROD, text));
    expect(Buffer.from(frag, "base64url").equals(Buffer.from(text, "utf8"))).toBe(true);
  });

  it("is URL-safe and unpadded at every padding length", () => {
    // "~~~???>>>" is chosen because standard base64 of it uses both `+` and `/`, so the mapping is really exercised.
    const base = "~~~???>>>";
    expect(Buffer.from(base).toString("base64")).toContain("+");
    expect(Buffer.from(base).toString("base64")).toContain("/");
    const remainders = new Set<number>();
    for (const text of [base, `${base}a`, `${base}ab`]) {
      remainders.add(Buffer.byteLength(text) % 3);
      const frag = fragmentOf(streamAppLink(PROD, text));
      expect(frag, text).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(frag, text).toBe(Buffer.from(text, "utf8").toString("base64url"));
    }
    expect([...remainders].sort()).toEqual([0, 1, 2]);
  });
});

describe("scoreAppLink and dayAppLink", () => {
  const dl = "dl_" + "a".repeat(43);
  const md = "md_" + "b".repeat(43);

  it("score and day put the token only after #", () => {
    expect(scoreAppLink(PROD, dl)).toBe(`https://seazn.club/app/score#${dl}`);
    expect(dayAppLink(PROD, `https://seazn.club/day/${md}`)).toBe(`https://seazn.club/app/day#${md}`);
    expect(dayAppLink(PROD, "https://seazn.club/day/")).toBeNull();
  });

  it("keeps every character of a base64url day token, and builds on the given origin", () => {
    const token = "md_" + "-_Az09".repeat(7) + "Q";
    expect(dayAppLink(STG, `http://localhost:3000/day/${token}`)).toBe(`${STG}/app/day#${token}`);
  });

  it("drops a query or fragment that trails the day token", () => {
    expect(dayAppLink(PROD, `${PROD}/day/${md}?utm=x`)).toBe(`${PROD}/app/day#${md}`);
    expect(dayAppLink(PROD, `${PROD}/day/${md}#top`)).toBe(`${PROD}/app/day#${md}`);
  });

  it("answers null for every URL with no md_ token", () => {
    const refused = [
      "",
      `${PROD}/day/`,
      `${PROD}/day/md_`,
      `${PROD}/day/${dl}`,
      `${PROD}/score/${md}`,
      `${PROD}/day/x${md}`,
      `${PROD}/day/${md}%2Fmore`,
    ];
    let checked = 0;
    for (const url of refused) {
      expect(dayAppLink(PROD, url), url).toBeNull();
      checked++;
    }
    expect(checked).toBe(7);
  });
});
