// The REAL vendored proto and its pin (engine-split phase 2a, Task W1). test/vendor-proto.test.ts proves the vendoring
// script on temp repos; this file proves the files it left in THIS package are what they claim to be, so a malformed pin, a
// second proto dropped in beside the copy, or a gen-proto.ts still reading the old repo-root /proto all red here, at the
// unit tier, before the CI drift gate. The pin is one key, the image tag: it is not checked against the copy or the placement
// repo (a contract change is handled by hand).
//
// Expected values come from git's own attribute resolution and the pin's declared shape, never from the vendoring code under
// test.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PKG_ROOT, VENDORED_JSON, VENDORED_PROTO, VENDORED_PROTO_DIR } from "../scripts/proto-paths.ts";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "../..");
const readPin = (): Record<string, string> => JSON.parse(readFileSync(VENDORED_JSON, "utf8")) as Record<string, string>;

describe("proto-paths", () => {
  it("is this package, and every path hangs off it", () => {
    expect(PKG_ROOT).toBe(PACKAGE);
    expect((JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { name: string }).name).toBe("@seazn/scheduler");
    expect(VENDORED_PROTO_DIR).toBe(join(PACKAGE, "proto"));
    expect(VENDORED_PROTO).toBe(join(PACKAGE, "proto", "scheduler.proto"));
    expect(VENDORED_JSON).toBe(join(PACKAGE, "VENDORED.json"));
  });
});

describe("the vendored placement proto", () => {
  it("VENDORED.json has exactly one key, imageTag, a 40-hex commit sha", () => {
    const pin = readPin();
    expect(Object.keys(pin)).toEqual(["imageTag"]);
    expect(pin.imageTag, "imageTag").toMatch(/^[0-9a-f]{40}$/);
  });

  it("it is the only proto vendored", () => {
    expect(readdirSync(VENDORED_PROTO_DIR)).toEqual(["scheduler.proto"]);
  });

  it("is checked out byte for byte on every platform (no end-of-line conversion), as git itself resolves it", () => {
    // `git check-attr` is the resolver: it reads .gitattributes the way checkout does, so this is red if the line is
    // missing, mistyped, or shadowed by a later rule, and green only when the attribute actually applies to the file.
    const target = relative(REPO, VENDORED_PROTO);
    const out = execFileSync("git", ["check-attr", "text", "--", target], { cwd: REPO, encoding: "utf8" }).trim();
    expect(out).toBe(`${target}: text: unset`);
  });
});

describe("gen-proto.ts", () => {
  const source = readFileSync(join(PACKAGE, "scripts/gen-proto.ts"), "utf8");
  // The code only: the header comment may (and does) say why the old path is gone.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

  it("reads the vendored copy: it imports VENDORED_PROTO_DIR from ./proto-paths.ts and hands it to protoc", () => {
    expect(code).toMatch(/import\s*\{[^}]*\bVENDORED_PROTO_DIR\b[^}]*\}\s*from\s*"\.\/proto-paths\.ts"/);
    expect(code, "-I is the vendored directory").toMatch(/"-I",\s*VENDORED_PROTO_DIR\b/);
    expect(code, "the file argument is inside it").toMatch(/path\.join\(VENDORED_PROTO_DIR,\s*"scheduler\.proto"\)/);
  });

  it("no longer reads the monorepo's /proto", () => {
    expect(code).not.toMatch(/path\.join\(\s*repoRoot\s*,\s*"proto"\s*\)/);
    expect(code).not.toMatch(/\bprotoDir\b/);
  });

  it("its header says where the proto comes from now (the placement repo, via the vendored copy)", () => {
    const header = source.split("\n").slice(0, 12).join("\n");
    expect(header).toContain("packages/scheduler/proto/scheduler.proto");
    expect(header).toContain("vendor:proto");
    expect(header, "the stale pointer to the monorepo's /proto is gone").not.toMatch(/`proto\/scheduler\.proto`/);
  });
});
