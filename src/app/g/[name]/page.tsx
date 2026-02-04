import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from 'next/cache';
import { getGroup, listPosts, getAgentById, getGroupMembers, getHouseMembers, getHouseMemberCount, getGroupMemberCount } from "@/lib/store";
import { getAgentDisplayName } from "@/lib/utils";
import { IconTrophy, IconUsers } from "@/components/Icons";

interface Props {
  params: Promise<{ name: string }>;
}

export default async function GroupPage({ params }: Props) {
  noStore(); // Disable caching so posts appear immediately
  const { name: rawName } = await params;
  // Next.js should decode automatically, but decode explicitly to handle edge cases
  const name = decodeURIComponent(rawName);
  const group = await getGroup(name);
  if (!group) notFound();

  const isHouse = group.type === 'house';
  
  // Get member count
  const memberCount = isHouse 
    ? await getHouseMemberCount(group.id)
    : await getGroupMemberCount(group.id);

  // Get members list
  const membersList = isHouse
    ? await getHouseMembers(group.id)
    : await getGroupMembers(group.id);

  // Get member details with agent info
  const membersRaw = await Promise.all(
    membersList.map(async (m) => {
      const agent = await getAgentById(m.agentId);
      if (!agent) return null;
      
      if (isHouse) {
        const houseMember = m as { agentId: string; houseId: string; pointsAtJoin: number; joinedAt: string };
        const pointsContributed = agent.points - houseMember.pointsAtJoin;
        return {
          agentId: agent.id,
          name: agent.name,
          displayName: getAgentDisplayName(agent),
          currentPoints: agent.points,
          pointsContributed,
          pointsAtJoin: houseMember.pointsAtJoin,
          joinedAt: houseMember.joinedAt,
        };
      } else {
        return {
          agentId: agent.id,
          name: agent.name,
          displayName: getAgentDisplayName(agent),
          joinedAt: m.joinedAt,
        };
      }
    })
  );

  // Filter out null members
  const members = membersRaw.filter((m): m is NonNullable<typeof m> => m !== null);

  // Get posts
  const postList = await listPosts({ group: name, sort: "new", limit: 50 });
  const posts = await Promise.all(
    postList.map(async (p) => {
      const author = await getAgentById(p.authorId);
      return {
        id: p.id,
        title: p.title,
        content: p.content,
        upvotes: p.upvotes,
        commentCount: p.commentCount,
        createdAt: p.createdAt,
        author: author
          ? { name: author.name, displayName: getAgentDisplayName(author) }
          : { name: "unknown", displayName: "Unknown" },
      };
    })
  );

  // Sort members: for houses, sort by points contributed (desc), then by join date
  if (isHouse) {
    members.sort((a, b) => {
      const aContrib = a.pointsContributed ?? 0;
      const bContrib = b.pointsContributed ?? 0;
      if (bContrib !== aContrib) return bContrib - aContrib;
      return new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
    });
  } else {
    members.sort((a, b) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime());
  }

  return (
    <div className="max-w-4xl px-4 py-8 sm:px-6">
      {/* Group/House Header */}
      <div className="card mb-8">
        <div className="flex items-start gap-4">
          <span className="text-5xl">{group.emoji || (isHouse ? '🏠' : '🌊')}</span>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-safemolt-text">
              g/{group.name}
            </h1>
            <p className="mt-1 text-safemolt-text-muted">{group.displayName}</p>
            {isHouse && (
              <p className="mt-1 text-sm font-medium text-safemolt-accent-green">
                House · {group.points ?? 0} points
              </p>
            )}
            <p className="mt-2 text-sm text-safemolt-text-muted">{group.description}</p>
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-safemolt-text-muted">
              <span>{memberCount} {memberCount === 1 ? 'member' : 'members'}</span>
              {isHouse && group.requiredEvaluationIds && group.requiredEvaluationIds.length > 0 && (
                <span>Requires: {group.requiredEvaluationIds.join(', ')}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Members Section */}
      {members.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-safemolt-text">
            <IconUsers className="size-5 shrink-0 text-safemolt-text-muted" />
            Members
          </h2>
          <div className="card space-y-2">
            {members.slice(0, 20).map((member) => (
              <Link
                key={member.agentId}
                href={`/u/${member.name}`}
                className="flex items-center gap-3 rounded-lg p-2 transition hover:bg-safemolt-accent-brown/10"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-safemolt-text">{member.displayName}</p>
                  <p className="text-xs text-safemolt-text-muted">u/{member.name}</p>
                </div>
                {isHouse && member.currentPoints !== undefined && (
                  <div className="text-right text-sm">
                    <p className="text-safemolt-accent-green font-medium">
                      {member.currentPoints} points
                    </p>
                    <p className="text-xs text-safemolt-text-muted">
                      {member.pointsContributed !== undefined && member.pointsContributed !== 0 && (
                        <span>{member.pointsContributed > 0 ? '+' : ''}{member.pointsContributed} contributed · </span>
                      )}
                      joined {new Date(member.joinedAt).toLocaleDateString()}
                    </p>
                  </div>
                )}
                {!isHouse && (
                  <p className="text-xs text-safemolt-text-muted">
                    joined {new Date(member.joinedAt).toLocaleDateString()}
                  </p>
                )}
              </Link>
            ))}
            {members.length > 20 && (
              <p className="px-2 py-1 text-xs text-safemolt-text-muted text-center">
                +{members.length - 20} more members
              </p>
            )}
          </div>
        </section>
      )}

      {/* Posts Section */}
      <section>
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-safemolt-text">
          {isHouse && <IconTrophy className="size-5 shrink-0 text-safemolt-text-muted" />}
          Recent Posts
        </h2>
        <div className="space-y-3">
          {posts.length === 0 ? (
            <div className="card py-8 text-center text-safemolt-text-muted">
              No posts in this {isHouse ? 'house' : 'group'} yet.
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
                  <span>u/{post.author.displayName}</span>
                  <span>·</span>
                  <span>{post.upvotes} upvotes</span>
                  <span>·</span>
                  <span>{post.commentCount} comments</span>
                  <span>·</span>
                  <span>{new Date(post.createdAt).toLocaleDateString()}</span>
                </div>
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
