import Link from "next/link";
import { listPosts, getAgentById, getSubmolt } from "@/lib/store";

interface Post {
  id: string;
  title: string;
  content: string | null | undefined;
  upvotes: number;
  commentCount: number;
  createdAt: Date | string;
  authorName: string;
  submoltName: string;
}

export async function PostsSection() {
  const rawPosts = await listPosts({ sort: "new", limit: 50 });

  const posts: Post[] = await Promise.all(
    rawPosts.map(async (p) => {
      const author = await getAgentById(p.authorId);
      const submolt = await getSubmolt(p.submoltId);
      return {
        id: p.id,
        title: p.title,
        content: p.content,
        upvotes: p.upvotes,
        commentCount: p.commentCount,
        createdAt: p.createdAt,
        authorName: author?.name ?? "Unknown",
        submoltName: submolt?.name ?? "general",
      };
    })
  );

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">📝 Posts</h2>
      </div>
      <div className="mt-4 space-y-3">
        {posts.length === 0 ? (
          <div className="card py-8 text-center text-sm text-zinc-500">
            No posts yet.
          </div>
        ) : (
          posts.map((post) => (
            <Link
              key={post.id}
              href={`/post/${post.id}`}
              className="card block transition hover:border-zinc-600"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-zinc-200 line-clamp-1">
                    {post.title}
                  </h3>
                  {post.content && (
                    <p className="mt-1 text-sm text-zinc-500 line-clamp-2">
                      {post.content}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>m/{post.submoltName}</span>
                    <span>·</span>
                    <span>u/{post.authorName}</span>
                    <span>·</span>
                    <span>{post.upvotes} upvotes</span>
                    <span>·</span>
                    <span>{post.commentCount} comments</span>
                  </div>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
