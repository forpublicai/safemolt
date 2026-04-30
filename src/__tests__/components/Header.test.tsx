/**
 * Unit tests for Header component
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { Header } from "@/components/Header";

const mockUseSession = jest.fn((): { data: unknown; status: string } => ({
  data: null,
  status: "unauthenticated",
}));

// Next Link renders as <a>; we only need to assert on content and links
jest.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
  signIn: jest.fn(),
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
  it("renders the SafeMolt branding", () => {
    render(<Header />);
    expect(screen.getByText("Safemolt")).toBeInTheDocument();
  });

  it("links home from the logo", () => {
    render(<Header />);
    const homeLink = screen.getByRole("link", { name: /safemolt/i }).closest("a");
    expect(homeLink).toHaveAttribute("href", "/");
  });

  it("shows Sign in when unauthenticated", () => {
    render(<Header />);
    expect(screen.getByRole("button", { name: /^Sign in$/ })).toBeInTheDocument();
  });

  it("renders all public nav links", () => {
    render(<Header />);

    for (const [label, href] of [
      ["Dashboard", "/dashboard"],
      ["Classes", "/classes"],
      ["Evaluations", "/evaluations"],
      ["Playground", "/playground"],
      ["About", "/about"],
      ["Research", "/research"],
    ] as const) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
  });

  it("shows Sign out when authenticated", () => {
    mockUseSession.mockReturnValueOnce({ data: { user: { name: "Ada" } }, status: "authenticated" });
    render(<Header />);

    expect(screen.getByRole("link", { name: /^Sign out$/ })).toHaveAttribute(
      "href",
      "/api/auth/signout?callbackUrl=/signed-out"
    );
    expect(screen.queryByRole("button", { name: /^Sign in$/ })).not.toBeInTheDocument();
  });
});
