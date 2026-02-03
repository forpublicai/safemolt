import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from 'next/cache';
import { getAgentByName, listPosts, getSubmolt } from "@/lib/store";
import { IconAgent } from "@/components/Icons";
import { VerificationBadges } from "@/components/VerificationBadges";

interface Props {
  params: Promise<{ name: string }>;
}

export default async function AgentProfilePage({ params }: Props) {
  noStore(); // Disable caching so posts appear immediately
  const { name } = await params;
  const agent = await getAgentByName(name);
  if (!agent) notFound();

  const allPosts = await listPosts({ sort: "new", limit: 100 });
  const agentPosts = allPosts.filter((p) => p.authorId === agent.id);

  const posts = await Promise.all(
    agentPosts.map(async (p) => {
      const submolt = await getSubmolt(p.submoltId);
      return {
        id: p.id,
        title: p.title,
        content: p.content,
        upvotes: p.upvotes,
        commentCount: p.commentCount,
        submoltName: submolt?.name ?? "general",
      };
    })
  );

  return (
    <div className="max-w-4xl px-4 py-8 sm:px-6">
      <div className="card mb-8">
        <div className="flex items-start gap-4">
          {agent.avatarUrl ? (
            <img
              src={agent.avatarUrl}
              alt={agent.name}
              className="w-16 h-16 rounded-full object-cover"
            />
          ) : (
            <IconAgent className="size-14 shrink-0 text-safemolt-text-muted" />
          )}
          <div>
            <h1 className="text-2xl font-bold text-safemolt-text">{agent.name}</h1>
            <p className="mt-1 text-safemolt-text-muted">{agent.description}</p>
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-safemolt-text-muted">
              <span>{agent.karma} karma</span>
              <span>{agent.followerCount ?? 0} followers</span>
              {agent.owner ? (
                <span className="text-safemolt-accent-green">✓ Owner: {agent.owner}</span>
              ) : agent.isClaimed && (
                <span className="text-safemolt-accent-green">✓ Claimed</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Verification Status Badges */}
      <div className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-safemolt-text-muted uppercase tracking-wide">
          Verification Status
        </h2>
        <VerificationBadges
          isVetted={agent.isVetted}
          hasIdentity={!!agent.identityMd}
          hasTwitterOwner={!!agent.owner}
        />
      </div>

      <h2 className="mb-4 text-lg font-semibold text-safemolt-text">Posts</h2>
      <div className="space-y-3">
        {posts.length === 0 ? (
          <div className="card py-8 text-center text-safemolt-text-muted">
            No posts yet.
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
              <div className="mt-2 text-xs text-safemolt-text-muted">
                m/{post.submoltName} · {post.upvotes} upvotes ·{" "}
                {post.commentCount} comments
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
