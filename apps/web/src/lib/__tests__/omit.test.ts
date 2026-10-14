// `omit` replaces the rest-destructure omit (`const { secret: _s, ...rest } =
// row`) everywhere in apps/web, whose eslint config has no `^_` ignore pattern.
// Several call sites strip a CREDENTIAL from a response row
// (`access_token_hash`), so the oracle for every case here is the language's
// own rest-destructure — the semantics being replaced — never `omit` itself.
import { describe, expect, it } from "vitest";
import { omit } from "../omit";

describe("omit", () => {
  it("drops one key and keeps every other value, in the destructure's key order", () => {
    const row = { id: "r1", access_token_hash: "h", display_name: "Ada", amount_cents: 0 };
    const { access_token_hash: dropped, ...want } = row;
    const got = omit(row, "access_token_hash");
    expect(dropped, "premise: the key carried a value").toBe("h");
    expect(got).toEqual(want);
    expect(Object.keys(got)).toEqual(Object.keys(want));
    expect(Object.keys(got)).toEqual(["id", "display_name", "amount_cents"]);
  });

  it("drops several keys at once", () => {
    const row = { a: 1, b: 2, c: 3, d: 4 };
    expect(omit(row, "b", "d")).toEqual({ a: 1, c: 3 });
  });

  it("removes the key itself, not just its value — an undefined value is still a key", () => {
    // A strip that wrote `{ ...row, secret: undefined }` would pass a
    // `toEqual` (which ignores undefined-valued keys) and still hand the key
    // to anything that enumerates the object.
    const row: { id: string; secret?: string } = { id: "r1", secret: undefined };
    const got = omit(row, "secret");
    expect("secret" in got).toBe(false);
    expect(Object.keys(got)).toEqual(["id"]);
  });

  it("never mutates its input", () => {
    const row = { id: "r1", secret: "s" };
    omit(row, "secret");
    expect(row).toEqual({ id: "r1", secret: "s" });
  });

  it("with no keys, returns a copy — equal, but not the same object", () => {
    const row = { id: "r1", n: 2 };
    const got = omit(row);
    expect(got).toEqual(row);
    expect(got).not.toBe(row);
  });

  it("is a no-op for an optional key the row does not carry", () => {
    const row: { id: string; venue?: string } = { id: "r1" };
    expect(omit(row, "venue")).toEqual({ id: "r1" });
  });

  it("copies exactly what the rest-destructure copies: own enumerable keys, symbols included", () => {
    const tag = Symbol("tag");
    const row = Object.defineProperty({ id: "r1", drop: 1, [tag]: "t" }, "hidden", {
      value: "h",
      enumerable: false,
    });
    const { drop: dropped, ...want } = row;
    expect(dropped, "premise: the key carried a value").toBe(1);
    const got = omit(row, "drop");
    expect(Reflect.ownKeys(got)).toEqual(Reflect.ownKeys(want));
    expect(Reflect.ownKeys(got)).toEqual(["id", tag]);
    expect((got as Record<symbol, unknown>)[tag]).toBe("t");
  });
});
