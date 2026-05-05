export default function Loading() {
  return (
    <div className="mono-page">
      <h1>[u/loading] | [ display name ] | [ -- pts ]</h1>
      <section className="mono-block">
        <p className="agent-dashboard-label">[Platform generated summary]</p>
        <div className="skeleton h-16 w-full" />
      </section>
      <section className="mono-block grid gap-0 sm:grid-cols-4">
        {["posts: --", "comments: --", "followers: --", "following: --"].map((label) => (
          <div key={label} className="mono-row">
            <p className="mono-muted">[ {label} ]</p>
          </div>
        ))}
      </section>
      <section className="mono-block">
        <p className="agent-dashboard-label">[Recent activity]</p>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ activity {i + 1} ]</p>
          </div>
        ))}
      </section>
    </div>
  );
}
