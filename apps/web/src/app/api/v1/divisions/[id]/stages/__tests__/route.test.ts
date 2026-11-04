// FMT5 — the route half of the Format dialog's three PUTs. The usecase's semantics (what a dry run reads, when the token
// is asked) are server/usecases/__tests__/format-change.test.ts; what that suite cannot see is the HANDLER: whether
// `?dry_run=1` reaches the preview and not the write, whether `?clear=` is passed through VERBATIM, and whether a refusal's
// preview reaches the wire as `error.preview`, where the dialog reads it (`previewOf`).
//
// Harness mirrors stages/[id]/generate/__tests__/route.test.ts: mock the auth door and the usecase, drive the real `PUT`
// through the real `v1()` envelope, and read what reached the usecase off the spies.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { FORMAT_CHANGE_REFUSALS, previewOf, type FormatChangePreview } from "@/lib/format-change";
import type { AuthCtx } from "@/server/api-v1/auth";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };
const DIVISION_ID = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: DIVISION_ID }) };

const PREVIEW: FormatChangePreview = {
  dry_run: true,
  stages: [{ id: "s1", name: "Groups" }],
  fixtures: 6,
  slots: 4,
  courts: 2,
  officials: 0,
  lineups: 0,
  device_links: 1,
  calls: 0,
  token: "t0k",
};

const replaceMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []));
const previewMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})));
const authMock = vi.hoisted(() => vi.fn(async () => AUTH));
vi.mock("@/server/usecases/stages", () => ({
  replaceStages: replaceMock,
  previewReplaceStages: previewMock,
  listStagesWithTableRules: vi.fn(),
  createStages: vi.fn(),
}));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { PUT } from "../route";

const BODY = [{ seq: 1, name: "League", kind: "league", config: {} }];

function put(query: string): Request {
  return new Request(`http://localhost/api/v1/divisions/${DIVISION_ID}/stages${query}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(BODY),
  });
}

beforeEach(() => {
  replaceMock.mockReset();
  previewMock.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue(AUTH);
  replaceMock.mockResolvedValue([]);
  previewMock.mockResolvedValue(PREVIEW);
});

describe("PUT /api/v1/divisions/{id}/stages — FMT5 dry run and clear", () => {
  it("?dry_run=1 answers the preview and never writes", async () => {
    const res = await PUT(put("?dry_run=1"), ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual(PREVIEW);
    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(previewMock.mock.calls[0]?.[0]).toBe(AUTH);
    expect(previewMock.mock.calls[0]?.[1]).toBe(DIVISION_ID);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // Fix round 1 (review m1): a preview flag that fell through to the write failed OPEN - `?dry_run=true` on a division with
  // no fixtures replaced its stages. Every value but the documented one is a 400 that reaches neither usecase.
  it("?dry_run= anything but 1 is a 400: neither the preview nor the write", async () => {
    const values = ["0", "true", "yes", ""];
    for (const v of values) {
      const res = await PUT(put(`?dry_run=${v}`), ctx);
      expect(res.status, `dry_run=${v}`).toBe(400);
      const body = (await res.json()) as { ok: false; error: { code: string; message: string } };
      expect(body.error.code, `dry_run=${v}`).toBe("VALIDATION");
      expect(body.error.message).toBe("dry_run must be one of 1");
    }
    expect(values.length, "anti-vacuity: values checked").toBe(4);
    expect(previewMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("?clear=<token> reaches replaceStages verbatim", async () => {
    await PUT(put("?clear=t0k"), ctx);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock.mock.calls[0]?.[3]).toEqual({ clear: "t0k" });
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("no query: replaceStages without a token (the no-fixture PUT, and the confirm refusal otherwise)", async () => {
    await PUT(put(""), ctx);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock.mock.calls[0]?.[3]).toEqual({});
  });

  it("a confirm refusal carries its preview to the wire as error.preview", async () => {
    const r = FORMAT_CHANGE_REFUSALS.FORMAT_CHANGE_CONFIRM;
    replaceMock.mockRejectedValueOnce(new HttpError(r.status, r.message, "FORMAT_CHANGE_CONFIRM", { preview: PREVIEW }));
    const res = await PUT(put(""), ctx);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: false; error: { code: string; message: string } & Record<string, unknown> };
    expect(body.error.code).toBe("FORMAT_CHANGE_CONFIRM");
    expect(body.error.message).toBe(r.message);
    // What the dialog reads: the client keeps every member past code/message as `extra` (client-v1.ts).
    const extra = Object.fromEntries(Object.entries(body.error).filter(([k]) => k !== "code" && k !== "message"));
    expect(previewOf(extra)).toEqual(PREVIEW);
  });
});
