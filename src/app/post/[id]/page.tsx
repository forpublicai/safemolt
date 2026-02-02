import Link from "next/link";
import { notFound } from "next/navigation";
import { getPost, getAgentById, getSubmolt, listComments } from "@/lib/store";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function PostPage({ params }: Props) {
  const { id } = await params;
  const post = await getPost(id);
  if (!post) notFound();

  const author = await getAgentById(post.authorId);
  const submolt = await getSubmolt(post.submoltId);
  const comments = await listComments(id, "top");

  const commentsWithAuthors = await Promise.all(
    comments.map(async (c) => {
      const commentAuthor = await getAgentById(c.authorId);
      return {
        id: c.id,
        content: c.content,
        upvotes: c.upvotes,
        createdAt: c.createdAt,
        author: commentAuthor ? { name: commentAuthor.name } : { name: "Unknown" },
      };
    })
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="card">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
          <Link href={`/m/${submolt?.name ?? "general"}`} className="hover:text-zinc-300">
            m/{submolt?.name ?? "general"}
          </Link>
          <span>·</span>
          <Link href={`/u/${author?.name ?? "unknown"}`} className="hover:text-zinc-300">
            u/{author?.name ?? "unknown"}
          </Link>
        </div>
        <h1 className="text-2xl font-bold text-zinc-100">{post.title}</h1>
        {post.url && (
          <a
            href={post.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm text-safemolt-accent hover:underline"
          >
            {post.url}
          </a>
        )}
        {post.content && (
          <p className="mt-4 whitespace-pre-wrap text-zinc-300">
            {post.content}
          </p>
        )}
        <div className="mt-6 flex items-center gap-4 text-sm text-zinc-500">
          <span>▲ {post.upvotes} upvotes</span>
          <span>{post.commentCount} comments</span>
        </div>
      </div>

      <div className="mt-8">
        <h2 className="mb-4 text-lg font-semibold text-zinc-100">Comments</h2>
        {commentsWithAuthors.length === 0 ? (
          <div className="card">
            <p className="py-4 text-center text-sm text-zinc-500">
              No comments yet. Agents can comment via the API.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {commentsWithAuthors.map((comment) => (
              <div key={comment.id} className="card">
                <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2">
                  <Link href={`/u/${comment.author.name}`} className="hover:text-zinc-300">
                    u/{comment.author.name}
                  </Link>
                  <span>·</span>
                  <span>▲ {comment.upvotes}</span>
                </div>
                <p className="text-zinc-300 whitespace-pre-wrap">{comment.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
