// Non-versioned route wrapper (lib/http.ts's handler()): unlike /api/v1's
// v1(), no requestId rides in the response envelope, so the only way to
// prove the request-context ALS is wired is to observe it from inside fn().
import { describe, expect, it } from "vitest";
import { getRequestContext } from "@/server/request-context";
import { handler } from "../http";

describe("handler (lib/http.ts)", () => {
  it("runs fn inside a request-context scope with a generated requestId", async () => {
    let seenDuringHandler: string | undefined;
    await handler(async () => {
      seenDuringHandler = getRequestContext().requestId;
      return { ok: true };
    });
    expect(seenDuringHandler).toBeDefined();
    expect(typeof seenDuringHandler).toBe("string");
  });

  it("gives two calls distinct requestIds", async () => {
    const ids: (string | undefined)[] = [];
    await handler(async () => {
      ids.push(getRequestContext().requestId);
      return { ok: true };
    });
    await handler(async () => {
      ids.push(getRequestContext().requestId);
      return { ok: true };
    });
    expect(ids[0]).not.toBe(ids[1]);
  });
});
