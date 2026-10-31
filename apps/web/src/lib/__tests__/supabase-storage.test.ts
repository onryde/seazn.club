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
}));
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => ({
    storage: {
      from: (bucket: string) => {
        const call = (op: string, data: unknown) => async (...args: unknown[]) => {
          sb.calls.push({ bucket, op, args });
          return sb.error ? { data: null, error: sb.error } : { data: sb.noData ? null : data, error: null };
        };
        return {
          upload: call("upload", { path: "p" }),
          remove: call("remove", []),
          createSignedUrl: call("createSignedUrl", { signedUrl: "https://project.supabase.co/storage/v1/object/sign/sponsor-frames/o/s/m.jpg?token=t" }),
          getPublicUrl: call("getPublicUrl", { publicUrl: "never" }),
        };
      },
    },
  }),
}));

import { ASSETS_BUCKET } from "@/lib/storage-url";
import {
  SIGNED_READ_MAX_TTL_SEC, SPONSOR_FRAMES_BUCKET, putStorageObject, removeStorageObjects, signedReadUrl,
} from "@/lib/supabase-storage";

beforeEach(() => {
  sb.calls.length = 0;
  sb.error = null;
  sb.noData = false;
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

  it("signedReadUrl signs a read of the private bucket for the TTL asked — 1 s and SIGNED_READ_MAX_TTL_SEC both accepted — and never asks for a public URL", async () => {
    let checked = 0;
    for (const ttl of [1, 60, SIGNED_READ_MAX_TTL_SEC]) {
      const url = await signedReadUrl("o/s/m.jpg", ttl);
      expect(url).toContain("/object/sign/");
      checked++;
    }
    expect(checked).toBe(3);
    expect(sb.calls.map((c) => [c.bucket, c.op, c.args])).toEqual([1, 60, SIGNED_READ_MAX_TTL_SEC].map((ttl) => [SPONSOR_FRAMES_BUCKET, "createSignedUrl", ["o/s/m.jpg", ttl]]));
  });

  it("signedReadUrl refuses, before asking the provider, a TTL that is not a whole number from 1 to SIGNED_READ_MAX_TTL_SEC", async () => {
    const refused = [0, -1, SIGNED_READ_MAX_TTL_SEC + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_400 * 365];
    let checked = 0;
    for (const ttl of refused) {
      await expect(signedReadUrl("o/s/m.jpg", ttl), String(ttl)).rejects.toThrow(RangeError);
      checked++;
    }
    expect(checked).toBe(refused.length);
    expect(sb.calls, "the provider was never asked").toEqual([]);
  });

  it("signedReadUrl throws on a storage error or an answer with no URL", async () => {
    sb.error = { message: "Object not found" };
    await expect(signedReadUrl("o/s/m.jpg", 60)).rejects.toThrow(/Object not found/);
    sb.error = null;
    sb.noData = true;
    await expect(signedReadUrl("o/s/m.jpg", 60)).rejects.toThrow(/no URL/);
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
    await signedReadUrl("x.jpg", 30);
    await removeStorageObjects(["x.jpg"]);
    expect(sb.calls).toHaveLength(3);
    expect(new Set(sb.calls.map((c) => c.bucket))).toEqual(new Set([SPONSOR_FRAMES_BUCKET]));
    expect(sb.calls.some((c) => c.op === "getPublicUrl")).toBe(false);
  });
});
