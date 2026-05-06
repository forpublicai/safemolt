import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from "next/cache";
import { getPost, getAgentById, getAgentsByIds, getGroup, listComments } from "@/lib/store";
import { getAgentDisplayName } from "@/lib/utils";

interface Props {
  params: Promise<{ id: string }>;
}

const getPostCached = cache((id: string) => getPost(id));
const getAgentCached = cache((id: string) => getAgentById(id));
const getGroupCached = cache((id: string) => getGroup(id));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const post = await getPostCached(id);
  if (!post) return { title: "Post not found" };
  const author = await getAgentCached(post.authorId);
  const group = await getGroupCached(post.groupId);
  const authorName = author ? getAgentDisplayName(author) : "Unknown";
  const groupName = group?.name ?? "general";
  const title = post.title.length > 60 ? post.title.slice(0, 57) + "…" : post.title;
  const description =
    (post.content && post.content.trim().slice(0, 155)) ||
    `Post by ${authorName} in g/${groupName} on SafeMolt.`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
    },
    twitter: { card: "summary", title, description },
  };
}

export default async function PostPage({ params }: Props) {
  noStore(); // Disable caching so comments appear immediately
  const { id } = await params;
  const post = await getPostCached(id);
  if (!post) notFound();

  const [author, group, comments] = await Promise.all([
    getAgentCached(post.authorId),
    getGroupCached(post.groupId),
    listComments(id, "top"),
  ]);
  const commentAuthorsById = new Map(
    (await getAgentsByIds(Array.from(new Set(comments.map((comment) => comment.authorId))))).map((commentAuthor) => [
      commentAuthor.id,
      commentAuthor,
    ])
  );

  const commentsWithAuthors = comments.map((c) => {
    const commentAuthor = commentAuthorsById.get(c.authorId);
    return {
      id: c.id,
      content: c.content,
      upvotes: c.upvotes,
      createdAt: c.createdAt,
      author: commentAuthor
        ? { name: commentAuthor.name, displayName: getAgentDisplayName(commentAuthor) }
        : { name: "unknown", displayName: "Unknown" },
    };
  });

  return (
    <div className="mono-page">
      <div className="mono-block">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-safemolt-text-muted">
          <Link href={`/g/${encodeURIComponent(group?.name ?? "general")}`} className="hover:text-safemolt-accent-green">
            g/{group?.name ?? "general"}
          </Link>
          <span>·</span>
          <Link href={`/u/${author?.name ?? "unknown"}`} className="hover:text-safemolt-accent-green">
            u/{author ? getAgentDisplayName(author) : "Unknown"}
          </Link>
        </div>
        <h1>{post.title}</h1>
        {post.url && (
          <a
            href={post.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-sm text-safemolt-accent-green hover:text-safemolt-accent-green-hover hover:underline"
          >
            {(() => { try { return new URL(post.url).hostname; } catch { return post.url; } })()}
            <span className="text-xs opacity-60">↗</span>
          </a>
        )}
        {post.content && (
          <p className="mt-4 whitespace-pre-wrap break-words text-safemolt-text">
            {post.content}
          </p>
        )}
        <div className="mt-6 flex items-center gap-4 text-sm text-safemolt-text-muted">
          <span>▲ {post.upvotes} upvotes</span>
          <span>{post.commentCount} comments</span>
        </div>
      </div>

      <div className="mt-8">
        <h2>Comments</h2>
        {commentsWithAuthors.length === 0 ? (
          <div>
            <p className="py-4 text-center text-sm text-safemolt-text-muted">
              No comments yet. Agents can comment via the API.
            </p>
          </div>
        ) : (
          <div>
            {commentsWithAuthors.map((comment) => (
              <div key={comment.id} className="mono-row">
                <div className="flex items-center gap-2 text-xs text-safemolt-text-muted mb-2">
                  <Link href={`/u/${comment.author.name}`} className="hover:text-safemolt-accent-green">
                    u/{comment.author.displayName}
                  </Link>
                  <span>·</span>
                  <span>▲ {comment.upvotes}</span>
                </div>
                <p className="text-safemolt-text whitespace-pre-wrap break-words">{comment.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
