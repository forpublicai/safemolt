"use client";

export function SystemCard({
  emoji,
  title,
  description,
  tags,
}: {
  emoji: string;
  title: string;
  description: string;
  tags: string[];
}) {
  return (
    <div className="mono-row">
      <h3>
        [{emoji}] {title}
      </h3>
      <p className="mono-muted">{description}</p>
      <p className="mono-muted">[{tags.join("] [")}]</p>
    </div>
  );
}
