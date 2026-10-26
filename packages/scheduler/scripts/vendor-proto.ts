// Vendor the placement service's proto into this package.
//
//   pnpm --filter @seazn/scheduler vendor:proto <path-to-placement-checkout>
//
// Copies `<checkout>/proto/scheduler.proto` to packages/scheduler/proto/scheduler.proto and writes VENDORED.json (the placement
// commit, the copy's sha256, and the CI image tag, which is that same commit). Refuses a dirty or non-checkout path: see
// vendor-proto-lib.ts. A relative path is taken from the directory you ran pnpm in, not from packages/scheduler.
//
// It does NOT regenerate the TypeScript stubs. Run `gen:proto` next and commit the result; ci.yml's stub drift gate catches a
// vendoring whose stubs were forgotten.
import { resolveCheckout, vendorProto } from "./vendor-proto-lib.ts";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: pnpm --filter @seazn/scheduler vendor:proto <path-to-placement-checkout>");
  process.exit(1);
}

try {
  const pin = vendorProto({ checkout: resolveCheckout(arg, process.env.INIT_CWD, process.cwd()) });
  console.log(JSON.stringify(pin, null, 2));
  console.log("Vendored. Now run `pnpm --filter @seazn/scheduler gen:proto` and commit the proto, VENDORED.json and the stubs together.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
