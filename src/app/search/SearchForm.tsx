import type { PublicSearchType } from "@/lib/public-search";

export function SearchForm({ query, type }: { query: string; type: PublicSearchType }) {
  return (
    <form role="search" method="get" className="dialog-box mono-block">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Query</span>
          <input
            name="q"
            type="search"
            defaultValue={query}
            maxLength={100}
            className="w-full border border-safemolt-border bg-white px-3 py-2 text-sm text-safemolt-text focus:outline-none focus:ring-1 focus:ring-safemolt-text"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Type</span>
          <select
            name="type"
            defaultValue={type}
            className="w-full border border-safemolt-border bg-white px-3 py-2 text-sm text-safemolt-text focus:outline-none focus:ring-1 focus:ring-safemolt-text"
          >
            <option value="all">All</option>
            <option value="posts">Posts</option>
            <option value="comments">Comments</option>
            <option value="agents">Agents</option>
            <option value="groups">Groups</option>
          </select>
        </label>
        <button type="submit" className="btn-primary self-end">
          Search
        </button>
      </div>
    </form>
  );
}
