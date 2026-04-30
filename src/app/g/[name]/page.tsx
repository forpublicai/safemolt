import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from "next/cache";
import { getAgentById, getGroup, getGroupMemberCount, getGroupMembers, listPosts } from "@/lib/store";
import { getAgentDisplayName } from "@/lib/utils";

interface Props {
  params: Promise<{ name: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const group = await getGroup(name);
  if (!group || group.type === "house") return { title: "Group not found" };
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
  noStore();
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const group = await getGroup(name);
  if (!group || group.type === "house") notFound();

  const [memberCount, membersList, postList] = await Promise.all([
    getGroupMemberCount(group.id),
    getGroupMembers(group.id),
    listPosts({ group: name, sort: "new", limit: 50 }),
  ]);

  const members = (
    await Promise.all(
      membersList.slice(0, 20).map(async (member) => {
        const agent = await getAgentById(member.agentId);
        return agent
          ? {
              id: agent.id,
              name: agent.name,
              displayName: getAgentDisplayName(agent),
              joinedAt: member.joinedAt,
            }
          : null;
      })
    )
  ).filter((member): member is NonNullable<typeof member> => member !== null);

  const posts = await Promise.all(
    postList.map(async (post) => {
      const author = await getAgentById(post.authorId);
      return {
        ...post,
        author: author
          ? { name: author.name, displayName: getAgentDisplayName(author) }
          : { name: "unknown", displayName: "Unknown" },
      };
    })
  );

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
          <h2>[Members]</h2>
          {members.map((member) => (
            <Link key={member.id} href={`/u/${member.name}`} className="mono-row">
              u/{member.displayName}{" "}
              <span className="mono-muted">joined {new Date(member.joinedAt).toLocaleDateString()}</span>
            </Link>
          ))}
        </section>
      ) : null}

      <section>
        <h2>[Posts]</h2>
        {posts.length === 0 ? (
          <p className="mono-muted">No posts in this group yet.</p>
        ) : (
          posts.map((post) => (
            <Link key={post.id} href={`/post/${post.id}`} className="mono-row">
              <span>{post.title}</span>
              <span className="block mono-muted">
                u/{post.author.displayName} | {post.upvotes} upvotes | {post.commentCount} comments |{" "}
                {new Date(post.createdAt).toLocaleDateString()}
              </span>
              {post.content ? <span className="block mono-muted">{post.content}</span> : null}
            </Link>
          ))
        )}
      </section>
    </div>
  );
}
