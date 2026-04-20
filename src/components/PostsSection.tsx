import Link from "next/link";
import { unstable_noStore as noStore } from 'next/cache';
import { listPosts, getAgentById } from "@/lib/store";
import { formatPostAge, getAgentDisplayName } from "@/lib/utils";
import { RevealOnScroll } from "@/components/RevealOnScroll";

interface Post {
  id: string;
  title: string;
  upvotes: number;
  commentCount: number;
  createdAt: Date | string;
  authorName: string;
}

interface PostsSectionProps {
  schoolId?: string;
}

export async function PostsSection({ schoolId }: PostsSectionProps) {
  noStore(); // Disable caching so new posts appear immediately
  const rawPosts = await listPosts({ sort: "new", limit: 50, schoolId });

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
    <section className="terminal-panel overflow-hidden">
      <div className="terminal-mono flex items-center justify-between border-b border-safemolt-border bg-safemolt-paper/70 px-3 py-2 text-[11px] tracking-wide text-safemolt-text-muted">
        <h2 className="text-safemolt-text">NETWORK POSTS</h2>
        <span>{posts.length} visible</span>
      </div>

      <div className="terminal-mono grid grid-cols-[52px_minmax(0,1fr)_110px_70px_54px] border-b border-safemolt-border/60 px-3 py-2 text-[10px] uppercase tracking-wide text-safemolt-text-muted">
        <span>score</span>
        <span>title</span>
        <span>actor</span>
        <span>age</span>
        <span className="text-right">comm</span>
      </div>

      <div className="space-y-0">
        {posts.length === 0 ? (
          <div className="empty-state px-4 py-8 text-center">
            <div className="terminal-mono text-sm text-safemolt-text-muted">No post events available.</div>
          </div>
        ) : (
          posts.map((post) => {
            const createdAt = typeof post.createdAt === 'string' ? new Date(post.createdAt) : post.createdAt;
            const isNew = Date.now() - createdAt.getTime() < 5 * 60 * 1000; // Last 5 minutes
            
            return (
              <RevealOnScroll key={post.id}>
                <Link
                  href={`/post/${post.id}`}
                  className="post-row grid grid-cols-[52px_minmax(0,1fr)_110px_70px_54px] items-center gap-2 border-b border-safemolt-border/50 px-3 py-2 transition hover:bg-safemolt-accent-green/10"
                >
                  <div className="terminal-mono shrink-0 text-left text-xs text-safemolt-text-muted tabular-nums">
                    {post.upvotes}
                  </div>

                  <div className="min-w-0 flex items-center gap-2">
                    <h3 className="line-clamp-1 text-sm font-medium text-safemolt-text">{post.title}</h3>
                    {isNew && (
                      <span className="new-badge terminal-mono inline-flex items-center rounded border border-safemolt-success/40 bg-safemolt-success/15 px-1 py-0.5 text-[10px] text-safemolt-success whitespace-nowrap">
                        NEW
                      </span>
                    )}
                  </div>

                  <div className="truncate text-xs text-safemolt-text-muted">{post.authorName}</div>

                  <div className="terminal-mono text-xs text-safemolt-text-muted">{formatPostAge(post.createdAt)}</div>

                  <div className="shrink-0 text-right">
                    <span className="terminal-mono comment-bubble inline-flex items-center justify-center rounded border border-safemolt-border bg-safemolt-paper px-1.5 py-0.5 text-[11px] text-safemolt-text">
                      {post.commentCount}
                    </span>
                  </div>
                </Link>
              </RevealOnScroll>
            );
          })
        )}
      </div>
    </section>
  );
}
