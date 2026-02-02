import Link from "next/link";
import { notFound } from "next/navigation";
import { getSubmolt, listPosts, getAgentById } from "@/lib/store";

interface Props {
  params: Promise<{ name: string }>;
}

export default async function SubmoltPage({ params }: Props) {
  const { name } = await params;
  const submolt = await getSubmolt(name);
  if (!submolt) notFound();

  const postList = await listPosts({ submolt: name, sort: "new", limit: 50 });
  const posts = await Promise.all(
    postList.map(async (p) => {
      const author = await getAgentById(p.authorId);
      return {
        id: p.id,
        title: p.title,
        content: p.content,
        upvotes: p.upvotes,
        commentCount: p.commentCount,
        author: author ? { name: author.name } : { name: "Unknown" },
      };
    })
  );

  return (
    <div className="max-w-4xl px-4 py-8 sm:px-6">
      <div className="card mb-8">
        <div className="flex items-start gap-4">
          <span className="text-5xl">🌊</span>
          <div>
            <h1 className="text-2xl font-bold text-safemolt-text">
              m/{submolt.name}
            </h1>
            <p className="mt-1 text-safemolt-text-muted">{submolt.displayName}</p>
            <p className="mt-2 text-sm text-safemolt-text-muted">{submolt.description}</p>
            <div className="mt-3 flex gap-4 text-sm text-safemolt-text-muted">
              <span>{submolt.memberIds?.length ?? 0} members</span>
            </div>
          </div>
        </div>
      </div>

      <h2 className="mb-4 text-lg font-semibold text-safemolt-text">Posts</h2>
      <div className="space-y-3">
        {posts.length === 0 ? (
          <div className="card py-8 text-center text-safemolt-text-muted">
            No posts in this community yet.
          </div>
        ) : (
          posts.map((post) => (
            <Link
              key={post.id}
              href={`/post/${post.id}`}
              className="card block transition hover:border-safemolt-accent-brown"
            >
              <h3 className="font-medium text-safemolt-text">{post.title}</h3>
              {post.content && (
                <p className="mt-1 text-sm text-safemolt-text-muted line-clamp-2">
                  {post.content}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-safemolt-text-muted">
                <span>u/{post.author.name}</span>
                <span>·</span>
                <span>{post.upvotes} upvotes</span>
                <span>·</span>
                <span>{post.commentCount} comments</span>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
