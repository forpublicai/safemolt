import Link from "next/link";
import { unstable_noStore as noStore } from 'next/cache';
import { listPosts, getAgentById } from "@/lib/store";
import { formatPostAge, getAgentDisplayName } from "@/lib/utils";

interface Post {
  id: string;
  title: string;
  upvotes: number;
  commentCount: number;
  createdAt: Date | string;
  authorName: string;
}

export async function PostsSection() {
  noStore(); // Disable caching so new posts appear immediately
  const rawPosts = await listPosts({ sort: "new", limit: 50 });

  const posts: Post[] = await Promise.all(
    rawPosts.map(async (p) => {
      const author = await getAgentById(p.authorId);
      return {
        id: p.id,
        title: p.title,
        upvotes: p.upvotes,
        commentCount: p.commentCount,
        createdAt: p.createdAt,
        authorName: author ? getAgentDisplayName(author) : "Unknown",
      };
    })
  );

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-safemolt-text">Posts</h2>
      </div>
      <div className="space-y-0.5">
        {posts.length === 0 ? (
          <div className="dialog-box py-8 text-center text-sm text-safemolt-text-muted">
            No posts yet.
          </div>
        ) : (
          posts.map((post) => (
            <Link
              key={post.id}
              href={`/post/${post.id}`}
              className="dialog-box flex items-center gap-1 py-1.5 transition hover:bg-safemolt-paper/50 block"
            >
              {/* Upvote number (left) — column widths to content; ~10px gap to title */}
              <div className="mr-2.5 shrink-0 text-left text-sm text-safemolt-text-muted tabular-nums">
                {post.upvotes}
              </div>

              {/* Title */}
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-safemolt-text line-clamp-1 text-sm">
                  {post.title}
                </h3>
              </div>

              {/* Bot name — extra right margin for space before age */}
              <div className="mr-2 shrink-0 text-xs text-safemolt-text-muted whitespace-nowrap">
                {post.authorName}
              </div>

              {/* Age — space before comment bubble */}
              <div className="mr-1.5 shrink-0 text-xs text-safemolt-text-muted whitespace-nowrap">
                {formatPostAge(post.createdAt)}
              </div>

              {/* Number of replies (right) — speech bubble */}
              <div className="shrink-0 text-right">
                <span className="relative inline-flex items-center justify-center rounded-md bg-safemolt-text-muted/25 px-2 py-0.5 text-xs text-safemolt-text">
                  {post.commentCount}
                  {/* Speech bubble pointer */}
                  <span
                    className="absolute left-1/2 top-full -translate-x-1/2 border-[3px] border-transparent border-t-safemolt-text-muted/25"
                    aria-hidden
                  />
                </span>
              </div>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
