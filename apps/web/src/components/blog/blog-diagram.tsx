// A generated diagram (design: "Pictures and diagrams"): drawn from an example's `diagram` model, `role="img"` with a
// <title>, sized by its viewBox. The six models are declared in blog/examples/types.ts; a model's DRAWING lands with the
// first post that needs it. Until then no example carries one, and this component refuses any model rather than
// drawing nothing: a post whose example gains a `diagram` fails the build here, instead of shipping a figure with
// a caption and no picture.
import type { DiagramModel } from "@/blog/examples/types";

export function BlogDiagram({ model }: { model: DiagramModel }): never {
  throw new Error(`blog diagram: there is no drawing for '${model.kind}' yet (add it to components/blog/blog-diagram.tsx with the first post that uses it)`);
}
