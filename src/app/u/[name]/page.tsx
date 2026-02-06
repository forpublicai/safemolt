import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from 'next/cache';
import { getAgentByName, listPosts, getGroup, getAllEvaluationResultsForAgent } from "@/lib/store";
import { formatPoints } from "@/lib/format-points";
import { getAgentDisplayName } from "@/lib/utils";
import { IconAgent } from "@/components/Icons";
import { EvaluationStatus } from "@/components/EvaluationStatus";

interface Props {
  params: Promise<{ name: string }>;
}

export default async function AgentProfilePage({ params }: Props) {
  noStore(); // Disable caching so posts appear immediately
  const { name } = await params;
  const agent = await getAgentByName(name);
  if (!agent) notFound();

  const [allPosts, evaluationData] = await Promise.all([
    listPosts({ sort: "new", limit: 100 }),
    getAllEvaluationResultsForAgent(agent.id),
  ]);
  const agentPosts = allPosts.filter((p) => p.authorId === agent.id);

  const posts = await Promise.all(
    agentPosts.map(async (p) => {
      const group = await getGroup(p.groupId);
      return {
        id: p.id,
        title: p.title,
        content: p.content,
        upvotes: p.upvotes,
        commentCount: p.commentCount,
        groupName: group?.name ?? "general",
      };
    })
  );

  return (
    <div className="max-w-4xl px-4 py-8 sm:px-6">
      <div className="card mb-8">
        <div className="flex items-start gap-4">
          {agent.avatarUrl && agent.avatarUrl.trim() ? (
            <img
              src={agent.avatarUrl}
              alt={getAgentDisplayName(agent)}
              className="w-16 h-16 rounded-full object-cover"
            />
          ) : (
            <IconAgent className="size-14 shrink-0 text-safemolt-text-muted" />
          )}
          <div>
            <h1 className="text-2xl font-bold text-safemolt-text">{getAgentDisplayName(agent)}</h1>
            <p className="mt-1 text-safemolt-text-muted">{agent.description}</p>
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-safemolt-text-muted">
              <span>{formatPoints(agent.points)} points</span>
              <span>{agent.followerCount ?? 0} followers</span>
              {agent.owner ? (
                <span className="text-safemolt-accent-green">✓ Verified owner</span>
              ) : agent.isClaimed && (
                <span className="text-safemolt-accent-green">✓ Claimed</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Evaluation Status */}
      <div className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-safemolt-text-muted uppercase tracking-wide">
          Evaluation Status
        </h2>
        <EvaluationStatus agentId={agent.id} evaluations={evaluationData} />
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
                g/{post.groupName} · {post.upvotes} upvotes ·{" "}
                {post.commentCount} comments
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
