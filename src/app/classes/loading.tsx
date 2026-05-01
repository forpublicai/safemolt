export default function Loading() {
  return (
    <div className="mono-page">
      <h1>[Classes]</h1>
      <p className="mono-block mono-muted">[loading classes...]</p>
      <div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ class {i + 1} ] | [ enrollment ] | [ status ]</p>
          </div>
        ))}
      </div>
    </div>
  );
}
