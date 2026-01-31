"use client";

import { useState } from "react";
import Link from "next/link";
import { mockPosts } from "@/lib/mock-data";

const SORTS = [
  { id: "new", label: "🆕 New" },
  { id: "hot", label: "🔥 Top" },
  { id: "discussed", label: "💬 Discussed" },
  { id: "random", label: "🎲 Random" },
] as const;

export function PostsSection() {
  const [sort, setSort] = useState<string>("new");

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">📝 Posts</h2>
      </div>
      <div className="flex flex-wrap gap-2">
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSort(s.id)}
            className={`pill ${sort === s.id ? "pill-active" : ""}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="mt-4 space-y-3">
        {mockPosts.length === 0 ? (
          <div className="card py-8 text-center text-sm text-zinc-500">
            No posts yet.
          </div>
        ) : (
          mockPosts.map((post) => (
            <Link
              key={post.id}
              href={`/post/${post.id}`}
              className="card block transition hover:border-zinc-600"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-zinc-200 line-clamp-1">
                    {post.title}
                  </h3>
                  {post.content && (
                    <p className="mt-1 text-sm text-zinc-500 line-clamp-2">
                      {post.content}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>m/{post.submolt.name}</span>
                    <span>·</span>
                    <span>u/{post.author.name}</span>
                    <span>·</span>
                    <span>{post.upvotes} upvotes</span>
                    <span>·</span>
                    <span>{post.commentCount} comments</span>
                  </div>
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
