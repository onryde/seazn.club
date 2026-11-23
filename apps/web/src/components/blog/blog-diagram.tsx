// A generated diagram (design: "Pictures and diagrams"): drawn from an example's `diagram` model, `role="img"` with a
// <title>, sized by its viewBox. The six models are declared in blog/examples/types.ts; a model's DRAWING lands with the
// first post that needs it. A model with no drawing yet is REFUSED rather than drawn as nothing: a post whose example
// gains such a `diagram` fails the build here, instead of shipping a figure with a caption and no picture.
//
// Each drawing is one component in components/blog/diagrams/, named after the post that first needs it, with one `case`
// below. Parallel batches merge here, so each batch adds its cases in its own marked block.
import type { DiagramModel } from "@/blog/examples/types";
import { BracketDiagram } from "@/components/blog/diagrams/bracket";
import { LadderSwap } from "@/components/blog/diagrams/ladder-swap";
import { ScoreTiles } from "@/components/blog/diagrams/score-tiles";
import { BestPlaced } from "@/components/blog/diagrams/best-placed";
import { GroupsToBracket } from "@/components/blog/diagrams/groups-to-bracket";
import { RoundRobinWheel } from "@/components/blog/diagrams/round-robin-wheel";
import { SwissRoundDiagram } from "@/components/blog/swiss-round-diagram";
import { WalkoverBracket } from "@/components/blog/diagrams/walkover-bracket";

export function BlogDiagram({ model }: { model: DiagramModel }) {
  switch (model.kind) {
    // ---- batch 4 (Task 10): third-place-match, page-playoff-and-stepladder, double-elimination-explained, what-is-a-plate ----
    case "bracket":
      return <BracketDiagram model={model} />;
    // ---- end batch 4 ----
    // ---- batch 5 (Task 11): how-a-ladder-works (the partner grid of the held americano post is with its held note) ----
    case "ladder":
      return <LadderSwap model={model} />;
    // ---- batch 5, fix round 1: withdrawal-in-a-knockout, double-walkover, forfeits-and-walkovers-by-sport ----
    case "walkoverBracket":
      return <WalkoverBracket model={model} />;
    case "scoreTiles":
      return <ScoreTiles model={model} />;
    // ---- end batch 5 ----
    // ---- batch 3 (Swiss and seeding): how-swiss-pairing-works, swiss-chess-bye, joining-or-leaving-a-swiss ----
    case "swissRound":
      return <SwissRoundDiagram model={model} />;
    // ---- end batch 3 ----
    // ---- batch 6 (Task 12): round-robin-schedule, groups-into-knockout, best-third-placed-teams ----
    case "roundRobinWheel":
      return <RoundRobinWheel model={model} />;
    case "groupsToBracket":
      return <GroupsToBracket model={model} />;
    case "bestPlaced":
      return <BestPlaced model={model} />;
    // ---- end batch 6 ----
    default:
      throw new Error(`blog diagram: there is no drawing for '${(model as { kind: string }).kind}' yet (add it to components/blog/blog-diagram.tsx with the first post that uses it)`);
  }
}
