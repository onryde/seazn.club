// lib/supabase-storage.ts, R4 S9 (preflight R10): the three helpers of the PRIVATE frames bucket. Supabase is the one
// fake (`supabaseAdmin`): every call is kept with its bucket, so "private bucket only" is read off what was asked, and
// each helper's refusal is driven. No database.
//
// ONE SPORT, on purpose: not applicable — storage reads no sport.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => ({
  calls: [] as { bucket: string; op: string; args: unknown[] }[],
  error: null as { message: string } | null,
  noData: false,
  bucket: { public: false } as { public: unknown },
  bucketsAsked: [] as string[],
  /** Paths the provider answers with a per-object error in a batch sign. */
  unsignable: new Set<string>(),
}));
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => ({
    storage: {
      async getBucket(id: string) {
        sb.bucketsAsked.push(id);
        if (sb.error) return { data: null, error: sb.error };
        return { data: sb.noData ? null : { id, name: id, ...sb.bucket }, error: null };
      },
      from: (bucket: string) => {
        const call = (op: string, data: unknown) => async (...args: unknown[]) => {
          sb.calls.push({ bucket, op, args });
          return sb.error ? { data: null, error: sb.error } : { data: sb.noData ? null : data, error: null };
        };
        return {
          upload: call("upload", { path: "p" }),
          remove: call("remove", []),
          createSignedUrl: call("createSignedUrl", { signedUrl: "https://project.supabase.co/storage/v1/object/sign/sponsor-frames/o/s/m.jpg?token=t" }),
          // The batch answer is per object, in the order asked (storage-js `createSignedUrls`), REVERSED here so a reader
          // that trusted the order rather than each row's `path` would pair a url with the wrong frame.
          createSignedUrls: async (paths: string[], ttl: number) => {
            sb.calls.push({ bucket, op: "createSignedUrls", args: [paths, ttl] });
            if (sb.error) return { data: null, error: sb.error };
            if (sb.noData) return { data: null, error: null };
            const rows = paths.map((path) => sb.unsignable.has(path)
              ? { path, signedUrl: null, error: "Object not found" }
              : { path, signedUrl: `https://project.supabase.co/storage/v1/object/sign/sponsor-frames/${path}?token=t`, error: null });
            return { data: rows.reverse(), error: null };
          },
          getPublicUrl: call("getPublicUrl", { publicUrl: "never" }),
        };
      },
    },
  }),
}));

import { ASSETS_BUCKET } from "@/lib/storage-url";
import {
  SIGNED_READ_MAX_TTL_SEC, SPONSOR_FRAMES_BUCKET, framesBucketIsPublic, putStorageObject, removeStorageObjects, signedReadUrl,
  signedReadUrls,
} from "@/lib/supabase-storage";

const ORG = "6b65a1f0-1111-4c1a-9a51-6f1d2b3c4d5e";
const OTHER_ORG = "6b65a1f0-2222-4c1a-9a51-6f1d2b3c4d5e";
const KEY = `${ORG}/0b5f6f1e-8c8e-4c1a-9a51-6f1d2b3c4d5e/MTI6c3BvbnNvci5vdmVyX2VuZA.jpg`;

beforeEach(() => {
  sb.calls.length = 0;
  sb.error = null;
  sb.noData = false;
  sb.bucket = { public: false };
  sb.bucketsAsked.length = 0;
  sb.unsignable.clear();
});

describe("the private frames bucket (R4 S9)", () => {
  it("is not the public assets bucket", () => {
    expect(SPONSOR_FRAMES_BUCKET).toBe("sponsor-frames");
    expect(SPONSOR_FRAMES_BUCKET).not.toBe(ASSETS_BUCKET);
  });

  it("putStorageObject writes the bytes to the private bucket, replacing (upsert) with the content type; a storage error is thrown with the provider's message and never the bytes", async () => {
    const bytes = Uint8Array.of(0xff, 0xd8, 0xff, 0x01, 0x02);
    await putStorageObject("o/s/m.jpg", bytes, "image/jpeg");
    expect(sb.calls).toEqual([{ bucket: SPONSOR_FRAMES_BUCKET, op: "upload", args: ["o/s/m.jpg", bytes, { contentType: "image/jpeg", upsert: true }] }]);
    sb.error = { message: "Bucket not found" };
    const err = await putStorageObject("o/s/m.jpg", bytes, "image/jpeg").then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    if (err === null) throw new Error("premise: the put was refused");
    expect(err.message).toContain("Bucket not found");
    expect(err.message).not.toContain("255");
  });

  it("signedReadUrl signs a read of one of the org's frames in the private bucket for the TTL asked — 1 s and SIGNED_READ_MAX_TTL_SEC both accepted — and never asks for a public URL", async () => {
    let checked = 0;
    for (const ttl of [1, 60, SIGNED_READ_MAX_TTL_SEC]) {
      const url = await signedReadUrl(ORG, KEY, ttl);
      expect(url).toContain("/object/sign/");
      checked++;
    }
    expect(checked).toBe(3);
    expect(sb.calls.map((c) => [c.bucket, c.op, c.args])).toEqual([1, 60, SIGNED_READ_MAX_TTL_SEC].map((ttl) => [SPONSOR_FRAMES_BUCKET, "createSignedUrl", [KEY, ttl]]));
  });

  it("signedReadUrl refuses, before asking the provider, a TTL that is not a whole number from 1 to SIGNED_READ_MAX_TTL_SEC", async () => {
    const refused = [0, -1, SIGNED_READ_MAX_TTL_SEC + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_400 * 365];
    let checked = 0;
    for (const ttl of refused) {
      await expect(signedReadUrl(ORG, KEY, ttl), String(ttl)).rejects.toThrow(RangeError);
      checked++;
    }
    expect(checked).toBe(refused.length);
    expect(sb.calls, "the provider was never asked").toEqual([]);
  });

  it("signedReadUrl refuses (review m9), before asking the provider, a path that is not one of the org's: another org's key, a key that only starts with the org's id, a bare org id, an empty org, and an org holding a `/`", async () => {
    const refused: Array<[string, string]> = [
      [OTHER_ORG, KEY], [ORG, `${ORG}x/s/m.jpg`], [ORG, ORG], [ORG, `x/${KEY}`], ["", `/${KEY}`], ["", KEY], [`${ORG}/s`, `${ORG}/s/m.jpg`],
    ];
    let checked = 0;
    for (const [org, path] of refused) {
      await expect(signedReadUrl(org, path, 60), `${org} ${path}`).rejects.toThrow(/not one of the organisation's frames/);
      checked++;
    }
    expect(checked).toBe(refused.length);
    expect(sb.calls, "the provider was never asked").toEqual([]);
    expect(await signedReadUrl(ORG, KEY, 60), "the positive pair").toContain("/object/sign/");
  });

  it("signedReadUrl throws on a storage error or an answer with no URL", async () => {
    sb.error = { message: "Object not found" };
    await expect(signedReadUrl(ORG, KEY, 60)).rejects.toThrow(/Object not found/);
    sb.error = null;
    sb.noData = true;
    await expect(signedReadUrl(ORG, KEY, 60)).rejects.toThrow(/no URL/);
  });

  // Final review S14 m5: the report signs its frames in ONE provider call, with signedReadUrl's own refusals.
  it("signedReadUrls signs every path in ONE call to the private bucket, each url paired by its path; an object the provider cannot sign is null; an empty list asks nothing", async () => {
    const keys = [1, 2, 3].map((n) => `${ORG}/0b5f6f1e-8c8e-4c1a-9a51-6f1d2b3c4d5e/m${n}.jpg`);
    sb.unsignable.add(keys[1]!);
    const urls = await signedReadUrls(ORG, keys, 60);
    expect(sb.calls).toEqual([{ bucket: SPONSOR_FRAMES_BUCKET, op: "createSignedUrls", args: [keys, 60] }]);
    expect(urls).toEqual([expect.stringContaining(`/${keys[0]}?`), null, expect.stringContaining(`/${keys[2]}?`)]);
    sb.calls.length = 0;
    expect(await signedReadUrls(ORG, [], 60)).toEqual([]);
    expect(sb.calls, "an empty list asks nothing").toEqual([]);
  });

  it("signedReadUrls refuses the WHOLE batch, before asking the provider, when any one path is not the org's or the TTL is out of range; a failed call throws", async () => {
    let checked = 0;
    for (const [org, path] of [[OTHER_ORG, KEY], [ORG, `${ORG}x/s/m.jpg`], ["", KEY]] as const) {
      await expect(signedReadUrls(org, [`${org}/s/ok.jpg`, path], 60), `${org} ${path}`).rejects.toThrow(/not one of the organisation's frames/);
      checked++;
    }
    for (const ttl of [0, 1.5, SIGNED_READ_MAX_TTL_SEC + 1]) {
      await expect(signedReadUrls(ORG, [KEY], ttl), `ttl ${ttl}`).rejects.toThrow(/ttlSec/);
      checked++;
    }
    expect(checked).toBe(6);
    expect(sb.calls, "the provider was never asked").toEqual([]);
    sb.error = { message: "storage is down" };
    await expect(signedReadUrls(ORG, [KEY], 60)).rejects.toThrow(/storage is down/);
    sb.error = null;
    sb.noData = true;
    await expect(signedReadUrls(ORG, [KEY], 60)).rejects.toThrow(/no URLs/);
  });

  it("framesBucketIsPublic asks about the frames bucket and reads `public` strictly — only `true` is public; a storage error or no bucket throws", async () => {
    const cases: Array<[unknown, boolean]> = [[false, false], [true, true], [undefined, false], ["true", false]];
    let checked = 0;
    for (const [flag, expected] of cases) {
      sb.bucket = { public: flag };
      expect({ flag, isPublic: await framesBucketIsPublic() }).toEqual({ flag, isPublic: expected });
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(sb.bucketsAsked).toEqual(cases.map(() => SPONSOR_FRAMES_BUCKET));
    sb.error = { message: "Bucket not found" };
    await expect(framesBucketIsPublic()).rejects.toThrow(/Bucket not found/);
    sb.error = null;
    sb.noData = true;
    await expect(framesBucketIsPublic()).rejects.toThrow(/no bucket/);
  });

  it("removeStorageObjects removes the paths from the private bucket; an empty list asks nothing; an error is thrown", async () => {
    await removeStorageObjects([]);
    expect(sb.calls).toEqual([]);
    await removeStorageObjects(["a.jpg", "b.jpg"]);
    expect(sb.calls).toEqual([{ bucket: SPONSOR_FRAMES_BUCKET, op: "remove", args: [["a.jpg", "b.jpg"]] }]);
    sb.error = { message: "storage is down" };
    await expect(removeStorageObjects(["a.jpg"])).rejects.toThrow(/storage is down/);
  });

  it("no helper ever touches the public bucket or builds a public URL", async () => {
    await putStorageObject("x.jpg", Uint8Array.of(1), "image/jpeg");
    await signedReadUrl(ORG, KEY, 30);
    await removeStorageObjects(["x.jpg"]);
    expect(sb.calls).toHaveLength(3);
    expect(new Set(sb.calls.map((c) => c.bucket))).toEqual(new Set([SPONSOR_FRAMES_BUCKET]));
    expect(sb.calls.some((c) => c.op === "getPublicUrl")).toBe(false);
  });
});
