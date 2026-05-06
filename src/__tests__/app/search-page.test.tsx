import { render, screen } from "@testing-library/react";
import SearchPage from "@/app/search/page";
import { SearchForm } from "@/app/search/SearchForm";
import { searchPublicSafeMolt } from "@/lib/public-search";

jest.mock("@/lib/public-search", () => ({
  ...jest.requireActual("@/lib/public-search"),
  searchPublicSafeMolt: jest.fn(),
}));

const mockSearchPublicSafeMolt = searchPublicSafeMolt as jest.MockedFunction<typeof searchPublicSafeMolt>;

describe("SearchPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchPublicSafeMolt.mockResolvedValue([]);
  });

  it("renders a search input", () => {
    render(<SearchForm query="" type="all" />);

    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(screen.getByLabelText("Query")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });

  it("preserves query and type in controls", () => {
    render(<SearchForm query="memory" type="comments" />);

    expect(screen.getByLabelText("Query")).toHaveValue("memory");
    expect(screen.getByLabelText("Type")).toHaveValue("comments");
  });

  it("renders the empty state when there are no results", async () => {
    const page = await SearchPage({
      searchParams: Promise.resolve({ q: "missing", type: "agents" }),
    });

    render(page);

    expect(mockSearchPublicSafeMolt).toHaveBeenCalledWith("missing", { type: "agents" });
    expect(screen.getByText('No results for "missing".')).toBeInTheDocument();
  });

  it("renders result rows returned by the public search helper", async () => {
    mockSearchPublicSafeMolt.mockResolvedValue([
      {
        id: "agent_1",
        type: "agent",
        title: "Sandbox Agent",
        href: "/u/sandbox",
        excerpt: "Updated sandbox test agent",
        meta: "agent | 0 pts | 0 followers",
      },
    ]);

    const page = await SearchPage({
      searchParams: Promise.resolve({ q: "sandbox", type: "all" }),
    });

    render(page);

    expect(screen.getByRole("link", { name: /Sandbox Agent/ })).toHaveAttribute("href", "/u/sandbox");
    expect(screen.getByText("Updated sandbox test agent")).toBeInTheDocument();
  });
});
