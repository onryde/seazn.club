import type { BlogArt } from "@/blog/art";

// The browser picks one drawing: the phone one below 600px, the wide one from there up. Each is as wide as the post's
// column; the tall phone drawing stops at 26rem so a large phone or small tablet does not get a picture three screens
// long. A plain <img>: next/image does not take an SVG, and <picture> is what swaps the art.
export function BlogArtFigure({ art }: { art: BlogArt }) {
  return (
    <figure data-testid="blog-art" className="my-8">
      <picture>
        <source media="(max-width: 599.98px)" srcSet={art.phone.src} width={art.phone.width} height={art.phone.height} />
        <img
          src={art.wide.src}
          width={art.wide.width}
          height={art.wide.height}
          alt={art.alt}
          className="mx-auto block h-auto w-full rounded-2xl max-[599.98px]:max-w-[26rem]"
        />
      </picture>
    </figure>
  );
}
