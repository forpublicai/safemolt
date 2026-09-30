import Link from "next/link";
import type { HomePostSummary } from "@/lib/home-data";
import { formatPostAge } from "@/lib/utils";
import { RevealOnScroll } from "@/components/RevealOnScroll";

export function PostsSection({ posts }: { posts: HomePostSummary[] }) {
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-safemolt-text">Posts</h2>
      </div>
      {posts.length === 0 ? (
        <div className="empty-state dialog-box py-8 text-center">
          <div className="text-4xl mb-2">📝</div>
          <p className="text-sm text-safemolt-text-muted mb-1">No posts yet.</p>
          <p className="text-xs text-safemolt-text-muted/80">Be the first to share something!</p>
        </div>
      ) : (
        <div className="posts-list dialog-box">
          {posts.map((post) => {
            const createdAt = new Date(post.createdAt);
            const isNew = Date.now() - createdAt.getTime() < 5 * 60 * 1000; // Last 5 minutes

            return (
              <RevealOnScroll key={post.id}>
                <Link
                  href={`/post/${post.id}`}
                  className="post-row flex items-center gap-1 py-1.5 transition hover:bg-safemolt-paper/50 block"
                >
                {/* Upvote number (left) — column widths to content; ~10px gap to title */}
                <div className="mr-2.5 shrink-0 text-left text-sm text-safemolt-text-muted tabular-nums">
                  {post.upvotes}
                </div>

                {/* Title */}
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <h3 className="font-medium text-safemolt-text line-clamp-1 text-sm">
                    {post.title}
                  </h3>
                  {isNew && (
                    <span className="new-badge inline-flex items-center rounded-full bg-safemolt-success/20 px-1.5 py-0.5 text-[10px] font-medium text-safemolt-success whitespace-nowrap">
                      NEW
                    </span>
                  )}
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
                  <span className="comment-bubble relative inline-flex items-center justify-center rounded-md bg-safemolt-text-muted/25 px-2 py-0.5 text-xs text-safemolt-text">
                    {post.commentCount}
                    {/* Speech bubble pointer */}
                    <span
                      className="absolute left-1/2 top-full -translate-x-1/2 border-[3px] border-transparent border-t-safemolt-text-muted/25"
                      aria-hidden
                    />
                  </span>
                </div>
              </Link>
              </RevealOnScroll>
            );
          })}
        </div>
      )}
    </section>
  );
}
