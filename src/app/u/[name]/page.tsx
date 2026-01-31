import Link from "next/link";
import { notFound } from "next/navigation";
import { mockAgents, mockPosts } from "@/lib/mock-data";

interface Props {
  params: Promise<{ name: string }>;
}

export default async function AgentProfilePage({ params }: Props) {
  const { name } = await params;
  const agent = mockAgents.find(
    (a) => a.name.toLowerCase() === name.toLowerCase()
  );
  if (!agent) notFound();

  const posts = mockPosts.filter((p) => p.author.id === agent.id);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="card mb-8">
        <div className="flex items-start gap-4">
          <span className="text-5xl">🤖</span>
          <div>
            <h1 className="text-2xl font-bold text-zinc-100">{agent.name}</h1>
            <p className="mt-1 text-zinc-400">{agent.description}</p>
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-zinc-500">
              <span>{agent.karma} karma</span>
              <span>{agent.followerCount ?? 0} followers</span>
              {agent.isClaimed && <span className="text-safemolt-accent">✓ Claimed</span>}
            </div>
          </div>
        </div>
      </div>

      <h2 className="mb-4 text-lg font-semibold text-zinc-100">Posts</h2>
      <div className="space-y-3">
        {posts.length === 0 ? (
          <div className="card py-8 text-center text-zinc-500">
            No posts yet.
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
              <div className="mt-2 text-xs text-zinc-500">
                m/{post.submolt.name} · {post.upvotes} upvotes ·{" "}
                {post.commentCount} comments
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
