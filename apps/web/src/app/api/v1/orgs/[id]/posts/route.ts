import { v1, reply, parseBody, assertOneOf } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CreatePost, PostStatus } from "@/server/api-v1/schemas";
import { toApiPost } from "@/server/api-v1/posts";
import { listPosts, createPost } from "@/server/usecases/org-posts";

type Ctx = { params: Promise<{ id: string }> };

/** Org news feed (console): all posts, optional ?status= filter. Free — manual
 *  posts are ungated on every plan (SPEC-2 PLG thesis). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    // An unrecognised ?status= is a 400, not an unfiltered list: answering
    // `?status=publish` with every post — drafts included — while the caller
    // believes they filtered to published is a silent data leak into a console
    // view. Members come from the zod enum openapi.ts publishes for this
    // param, so the three lists cannot drift apart.
    const status = new URL(req.url).searchParams.get("status");
    assertOneOf(status, PostStatus.options, "status");
    return (await listPosts(auth, id, status ?? undefined)).map(toApiPost);
  });
}

/** Compose a post (starts as a draft; free on every plan). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, CreatePost);
    const auth = await requireOrgAuth(req, id, "write");
    return reply(
      201,
      toApiPost(
        await createPost(auth, id, {
          title: body.title,
          ...(body.body_md !== undefined ? { bodyMd: body.body_md } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.competition_id !== undefined ? { competitionId: body.competition_id } : {}),
          ...(body.division_id !== undefined ? { divisionId: body.division_id } : {}),
          ...(body.hero_image_path !== undefined ? { heroImagePath: body.hero_image_path } : {}),
        }),
      ),
    );
  });
}
