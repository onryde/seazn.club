// Regenerate the TypeScript gRPC stubs from the shared `proto/scheduler.proto`.
//
//   npm run gen:proto --workspace packages/engine
//
// Output lands in src/scheduling/generated/ and is COMMITTED. It is mechanically
// produced — never hand-edit it; change the .proto or this script's ts_proto
// options and regenerate. Committing it is what keeps `protoc` off CI's critical
// path: typechecking and testing the client needs the stubs, not the compiler.
//
// Two things here deliberately differ from the obvious version, both because the
// obvious version is silently wrong in THIS repo:
//
//  1. `npx protoc` is not used. There is no system protoc on a clean machine, and
//     `npx` resolves that by silently fetching whatever `protoc` the registry
//     currently publishes — outside the lockfile, at codegen time, so two runs a
//     month apart can emit different stubs. `protoc` is a pinned devDependency
//     (exact, not caret) and is invoked from node_modules so the lockfile is the
//     only thing that decides the compiler version.
//
//  2. The plugin is NOT at the repo-root node_modules/.bin. pnpm's default linker
//     only hoists what pnpm-workspace.yaml's `publicHoistPattern` names (three
//     packages, none of them these), so a workspace package's devDependency bins
//     live in packages/engine/node_modules/.bin. Root is checked as a fallback in
//     case the hoisting policy ever changes, and a missing bin is a hard error
//     naming `pnpm install` rather than a fetch from the network.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engineRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const repoRoot = path.resolve(engineRoot, "../..");
const outDir = path.join(engineRoot, "src/scheduling/generated");
const protoDir = path.join(repoRoot, "proto");

/** Locate a devDependency binary, preferring the package-local pnpm bin dir. */
function resolveBin(name: string): string {
  const candidates = [
    path.join(engineRoot, "node_modules/.bin", name),
    path.join(repoRoot, "node_modules/.bin", name),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Codegen binary ${name} not found. Looked in:\n  ${candidates.join("\n  ")}\n` +
        `Run \`pnpm install\` from the repo root. Do NOT fall back to \`npx ${name}\` — ` +
        `that fetches an unpinned package from the registry and makes codegen non-deterministic.`,
    );
  }
  return found;
}

const protoc = resolveBin("protoc");
const tsProtoPlugin = resolveBin("protoc-gen-ts_proto");

// protoc does not create its own output directory; without this the first run on
// a fresh clone fails with a bare "No such file or directory".
mkdirSync(outDir, { recursive: true });

execFileSync(
  protoc,
  [
    `--plugin=protoc-gen-ts_proto=${tsProtoPlugin}`,
    `--ts_proto_out=${outDir}`,
    "--ts_proto_opt=outputServices=grpc-js,esModuleInterop=true",
    "-I",
    protoDir,
    path.join(protoDir, "scheduler.proto"),
  ],
  { stdio: "inherit" },
);

console.log(`Generated TS proto stubs in ${path.relative(process.cwd(), outDir)}`);
