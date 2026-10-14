// A route handler. Static, so `next build` evaluates it - and the sports barrel with it - at build time.
import { builtinModules } from "@seazn/engine/sports";

export const dynamic = "force-static";

export function GET() {
  return Response.json({ sports: builtinModules.map((m) => m.key) });
}
