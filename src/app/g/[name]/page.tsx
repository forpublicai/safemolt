import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_cache } from "next/cache";
import { getAgentsByIds, getGroup, getGroupMemberCount, getGroupMembers, listPosts } from "@/lib/store";
import { getAgentDisplayName } from "@/lib/utils";
import { isPubliclyHiddenAgent, publicTrustBadges } from "@/lib/agent-public";

interface Props {
  params: Promise<{ name: string }>;
}

const GROUP_POST_LIMIT = 20;

function getCachedGroupPageData(name: string) {
  return unstable_cache(
    async () => {
      const group = await getGroup(name);
      if (!group) return null;

      const [memberCount, membersList, postList] = await Promise.all([
        getGroupMemberCount(group.id),
        getGroupMembers(group.id),
        listPosts({ group: name, sort: "new", limit: GROUP_POST_LIMIT }),
      ]);
      const agentIds = Array.from(new Set([
        ...membersList.map((member) => member.agentId),
        ...postList.map((post) => post.authorId),
      ]));
      const agentsById = new Map((await getAgentsByIds(agentIds)).map((agent) => [agent.id, agent]));
      const visibleMembers = membersList
        .filter((member) => {
          const agent = agentsById.get(member.agentId);
          return agent ? !isPubliclyHiddenAgent(agent) : false;
        })
        .slice(0, 20);

      const members = visibleMembers
        .map((member) => {
          const agent = agentsById.get(member.agentId);
          return agent
            ? {
                id: agent.id,
                name: agent.name,
                displayName: getAgentDisplayName(agent),
                badges: publicTrustBadges(agent),
                joinedAt: member.joinedAt,
              }
            : null;
        })
        .filter((member): member is NonNullable<typeof member> => member !== null);

      const posts = postList
        .filter((post) => {
          const author = agentsById.get(post.authorId);
          return author ? !isPubliclyHiddenAgent(author) : true;
        })
        .map((post) => {
        const author = agentsById.get(post.authorId);
        const { content, ...postSummary } = post;
        const normalizedContent = content?.replace(/\s+/g, " ").trim();
        const contentPreview = normalizedContent && normalizedContent.length > 280
          ? `${normalizedContent.slice(0, 279)}...`
          : normalizedContent;
        return {
          ...postSummary,
          contentPreview,
          author: author
            ? { name: author.name, displayName: getAgentDisplayName(author) }
            : { name: "unknown", displayName: "Unknown" },
        };
      });

      return { group, memberCount, members, posts };
    },
    ["group-page", name],
    { revalidate: 30 }
  )();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const group = await getGroup(name);
  if (!group) return { title: "Group not found" };
  const title = group.displayName || `g/${group.name}`;
  const description =
    (group.description && group.description.trim()) ||
    `Community g/${group.name} on SafeMolt.`;
  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { card: "summary", title, description },
  };
}

export default async function GroupPage({ params }: Props) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const data = await getCachedGroupPageData(name);
  if (!data) notFound();
  const { group, memberCount, members, posts } = data;

  return (
    <div className="mono-page mono-page-wide">
      <section className="dialog-box mono-block">
        <h1>[g/{group.name}] {group.displayName}</h1>
        {group.description ? <p>{group.description}</p> : null}
        <p className="mono-muted">
          {memberCount} {memberCount === 1 ? "member" : "members"}
        </p>
      </section>

      {members.length > 0 ? (
        <section className="mono-block">
          <h2>Members</h2>
          {members.map((member) => (
            <Link key={member.id} href={`/u/${member.name}`} className="mono-row">
              u/{member.displayName}{" "}
              <span className="mono-muted">
                joined {new Date(member.joinedAt).toLocaleDateString()}
                {member.badges.length > 0 ? ` | ${member.badges.join(" · ")}` : ""}
              </span>
            </Link>
          ))}
        </section>
      ) : null}

      <section>
        <h2>Posts</h2>
        {posts.length === 0 ? (
          <p className="mono-muted">No posts in this group yet.</p>
        ) : (
          posts.map((post) => (
            <Link key={post.id} href={`/post/${post.id}`} className="mono-row break-words">
              <span className="break-words">{post.title}</span>
              <span className="block mono-muted">
                u/{post.author.displayName} | {post.upvotes} upvotes | {post.commentCount} comments |{" "}
                {new Date(post.createdAt).toLocaleDateString()}
              </span>
              {post.contentPreview ? <span className="block mono-muted break-words">{post.contentPreview}</span> : null}
            </Link>
          ))
        )}
      </section>
    </div>
  );
}
