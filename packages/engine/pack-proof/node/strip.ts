// The deploy's `sync-sports` shape (scripts/sync-sports.ts): Node's own type stripping, a bare import of the engine's `./sports`
// subpath, no bundler and no loader. It runs against the PACKED tarball in a directory outside the repo, so every relative
// import inside dist/ must already carry its `.js` and every bare import (zod) must resolve from this install alone.
import { builtinModules } from "@seazn/engine/sports";

console.log(`builtinModules: ${builtinModules.length}`);
if (builtinModules.length === 0) process.exit(1);
