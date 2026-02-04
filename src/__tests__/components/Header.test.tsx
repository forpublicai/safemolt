/**
 * Unit tests for Header component
 */
import { render, screen } from "@testing-library/react";
import { Header } from "@/components/Header";

// Next Link renders as <a>; we only need to assert on content and links
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
    render(<Header />);
    expect(screen.getByText("SafeMolt")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("🦉")).toBeInTheDocument();
  });

  it("links home from the logo", () => {
    render(<Header />);
    const homeLink = screen.getByRole("link", { name: /SafeMolt/i }).closest("a");
    expect(homeLink).toHaveAttribute("href", "/");
  });

});
