/**
 * Unit tests for Header component
 */
import { render, screen } from "@testing-library/react";
import { Header } from "@/components/Header";

// Next Link renders as <a>; we only need to assert on content and links
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
  signOut: jest.fn(),
}));

jest.mock("next/link", () => {
  return function MockLink({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) {
    return <a href={href}>{children}</a>;
  };
});

describe("Header", () => {
  it("renders the SafeMolt branding and beta badge", () => {
    render(<Header onMenuToggle={jest.fn()} />);
    expect(screen.getByText("SAFEMOLT")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
  });

  it("links home from the logo", () => {
    render(<Header onMenuToggle={jest.fn()} />);
    const homeLink = screen.getByRole("link", { name: /safemolt/i }).closest("a");
    expect(homeLink).toHaveAttribute("href", "/");
  });

  it("shows Login when unauthenticated", () => {
    render(<Header onMenuToggle={jest.fn()} />);
    expect(screen.getByRole("button", { name: /^Login$/ })).toBeInTheDocument();
  });
});
