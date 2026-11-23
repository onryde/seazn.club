// A generated diagram (design: "Pictures and diagrams"): drawn from an example's `diagram` model, `role="img"` with a
// <title>, sized by its viewBox. The six models are declared in blog/examples/types.ts; a model's DRAWING lands with the
// first post that needs it. A model with no drawing yet is REFUSED rather than drawn as nothing: a post whose example
// gains such a `diagram` fails the build here, instead of shipping a figure with a caption and no picture.
//
// Each drawing is one component in components/blog/diagrams/, named after the post that first needs it, with one `case`
// below. Parallel batches merge here, so each batch adds its cases in its own marked block.
import type { DiagramModel } from "@/blog/examples/types";
import { AmericanoPartnerGrid } from "@/components/blog/diagrams/americano-partner-grid";
import { LadderSwap } from "@/components/blog/diagrams/ladder-swap";
import { ScoreTiles } from "@/components/blog/diagrams/score-tiles";
import { WalkoverBracket } from "@/components/blog/diagrams/walkover-bracket";

export function BlogDiagram({ model }: { model: DiagramModel }) {
  switch (model.kind) {
    // ---- batch 5 (Task 11): how-americano-works, how-a-ladder-works ----
    case "partnerGrid":
      return <AmericanoPartnerGrid model={model} />;
    case "ladder":
      return <LadderSwap model={model} />;
    // ---- batch 5, fix round 1: withdrawal-in-a-knockout, double-walkover, forfeits-and-walkovers-by-sport ----
    case "walkoverBracket":
      return <WalkoverBracket model={model} />;
    case "scoreTiles":
      return <ScoreTiles model={model} />;
    // ---- end batch 5 ----
    default:
      throw new Error(`blog diagram: there is no drawing for '${model.kind}' yet (add it to components/blog/blog-diagram.tsx with the first post that uses it)`);
  }
}
