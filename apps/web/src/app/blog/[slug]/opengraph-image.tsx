// The share card of a post: its question on the house night slab, the blog's name and the date. One image per post,
// drawn at build (generateStaticParams). Type is the default next/og face, like the other cards: no font is fetched.
import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { formatBlogDate } from "@/lib/blog";
import { blogOgTitleSize } from "@/lib/blog-seo";
import { OG_SIZE } from "@/server/og/card";
import { allBlogPosts, blogPost } from "@/server/blog-content";

export const alt = "Seazn Club Blog";
export const size = OG_SIZE;
export const contentType = "image/png";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams(): { slug: string }[] {
  return allBlogPosts().map((p) => ({ slug: p.slug }));
}

const NIGHT = "#150b36";
const CREAM = "#f5f0e8";
const LIME = "#a3e635";

export default async function Image({ params }: Props) {
  const { slug } = await params;
  const post = blogPost(slug);
  if (!post) notFound();
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "56px 64px",
          color: CREAM,
          fontFamily: "sans-serif",
          backgroundColor: NIGHT,
          backgroundImage: "radial-gradient(780px 460px at 90% -10%, rgba(124,58,237,0.30), transparent 62%), linear-gradient(180deg, #1d1145, #150b36)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30, fontWeight: 800, letterSpacing: 2 }}>
          <span>SEAZN CLUB BLOG</span>
          <span style={{ display: "flex", width: 64, height: 6, borderRadius: 3, background: LIME }} />
        </div>
        <div style={{ display: "flex", fontSize: blogOgTitleSize(post.title), fontWeight: 800, lineHeight: 1.12 }}>{post.title}</div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: "rgba(245,240,232,0.78)" }}>
          <span>Seazn · {formatBlogDate(post.date)}</span>
          <span>seazn.club/blog</span>
        </div>
      </div>
    ),
    size,
  );
}
