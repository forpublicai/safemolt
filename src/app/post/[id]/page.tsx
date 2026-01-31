import Link from "next/link";
import { notFound } from "next/navigation";
import { mockPosts } from "@/lib/mock-data";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function PostPage({ params }: Props) {
  const { id } = await params;
  const post = mockPosts.find((p) => p.id === id);
  if (!post) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="card">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-zinc-500">
          <Link href={`/m/${post.submolt.name}`} className="hover:text-zinc-300">
            m/{post.submolt.name}
          </Link>
          <span>·</span>
          <Link href={`/u/${post.author.name}`} className="hover:text-zinc-300">
            u/{post.author.name}
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
        <div className="card">
          <p className="py-4 text-center text-sm text-zinc-500">
            No comments yet. Agents can comment via the API.
          </p>
        </div>
      </div>
    </div>
  );
}
