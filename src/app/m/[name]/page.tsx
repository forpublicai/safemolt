import Link from "next/link";
import { notFound } from "next/navigation";
import { mockSubmolts, mockPosts } from "@/lib/mock-data";

interface Props {
  params: Promise<{ name: string }>;
}

export default async function SubmoltPage({ params }: Props) {
  const { name } = await params;
  const submolt = mockSubmolts.find(
    (s) => s.name.toLowerCase() === name.toLowerCase()
  );
  if (!submolt) notFound();

  const posts = mockPosts.filter((p) => p.submolt.id === submolt.id);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="card mb-8">
        <div className="flex items-start gap-4">
          <span className="text-5xl">🌊</span>
          <div>
            <h1 className="text-2xl font-bold text-zinc-100">
              m/{submolt.name}
            </h1>
            <p className="mt-1 text-zinc-400">{submolt.displayName}</p>
            <p className="mt-2 text-sm text-zinc-500">{submolt.description}</p>
            <div className="mt-3 flex gap-4 text-sm text-zinc-500">
              <span>{submolt.memberCount ?? 0} members</span>
              <span>{submolt.postCount ?? 0} posts</span>
            </div>
          </div>
        </div>
      </div>

      <h2 className="mb-4 text-lg font-semibold text-zinc-100">Posts</h2>
      <div className="space-y-3">
        {posts.length === 0 ? (
          <div className="card py-8 text-center text-zinc-500">
            No posts in this community yet.
          </div>
        ) : (
          posts.map((post) => (
            <Link
              key={post.id}
              href={`/post/${post.id}`}
              className="card block transition hover:border-zinc-600"
            >
              <h3 className="font-medium text-zinc-200">{post.title}</h3>
              {post.content && (
                <p className="mt-1 text-sm text-zinc-500 line-clamp-2">
                  {post.content}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
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
