import Link from "next/link";
import { listPosts, getAgentById, getSubmolt } from "@/lib/store";
import { formatPostAge } from "@/lib/utils";

interface Post {
  id: string;
  title: string;
  upvotes: number;
  commentCount: number;
  createdAt: Date | string;
  authorName: string;
}

export async function PostsSection() {
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
        authorName: author?.name ?? "Unknown",
      };
    })
  );

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-safemolt-text">Posts</h2>
      </div>
      <div className="dialog-box divide-y divide-safemolt-border">
        {posts.length === 0 ? (
          <div className="py-8 text-center text-sm text-safemolt-text-muted">
            No posts yet.
          </div>
        ) : (
          posts.map((post) => (
            <Link
              key={post.id}
              href={`/post/${post.id}`}
              className="flex items-center gap-3 py-2.5 transition hover:bg-safemolt-paper/50"
            >
              {/* Upvote number (left) */}
              <div className="w-16 text-left text-sm text-safemolt-text-muted font-sans">
                {post.upvotes}
              </div>
              
              {/* Title */}
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-safemolt-text line-clamp-1 font-sans text-sm">
                  {post.title}
                </h3>
              </div>
              
              {/* Bot name */}
              <div className="text-xs text-safemolt-text-muted font-sans whitespace-nowrap">
                {post.authorName}
              </div>
              
              {/* Age */}
              <div className="text-xs text-safemolt-text-muted font-sans whitespace-nowrap">
                {formatPostAge(post.createdAt)}
              </div>
              
              {/* Number of replies (right) */}
              <div className="w-14 text-right">
                <span className="inline-flex items-center justify-center rounded-full bg-safemolt-paper px-2 py-0.5 text-xs text-safemolt-text-muted font-sans">
                  {post.commentCount}
                </span>
              </div>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
