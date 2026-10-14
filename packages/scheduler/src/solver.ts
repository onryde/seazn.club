// The adapter behind @seazn/engine's solver port (engine-split spec §5.1, D11): env and secret live HERE, never in the engine.
// The client is imported at call time so tests can spy on `solveBuild` through the module namespace — the repo's recorded
// inert-mock trap (a static import would leave the spy seeing nothing).
import type { PlacementSolver } from "@seazn/engine/scheduling";

export const placementSolver: PlacementSolver = async (input, { requestId }) => {
  const client = await import("./placement-client.ts");
  return client.solveBuild(input, { secret: process.env.PLACEMENT_SERVICE_SECRET ?? "", requestId });
};
