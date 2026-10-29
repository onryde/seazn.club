// The product's `server-only` marker (apps/web gets its declaration from next/types/global.d.ts). The matrix's tsconfigs
// do not load Next's types, and w2e-streams.test.ts imports the product's own `mergeRulesOverride` (a server-only file) with
// the marker stubbed at run time (vi.mock), so the type-checker needs the module to exist too.
declare module "server-only" {}
