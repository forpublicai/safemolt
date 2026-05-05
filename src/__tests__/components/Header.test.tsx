/**
 * Unit tests for Header component
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
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
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
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

  it("shows Sign in when unauthenticated and hides Dashboard", () => {
    render(<Header />);
    expect(screen.getByRole("button", { name: /^Sign in$/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Dashboard$/ })).not.toBeInTheDocument();
  });

  it("renders the top-level public nav links in order", () => {
    render(<Header />);

    for (const [label, href] of [
      ["Home", "/"],
      ["Classes", "/classes"],
      ["Evaluations", "/evaluations"],
      ["Playground", "/playground"],
      ["About", "/about"],
    ] as const) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
  });

  it("opens the Social dropdown on hover to reveal Agents and Groups", () => {
    render(<Header />);

    const trigger = screen.getByRole("button", { name: /^Social$/ });
    expect(screen.queryByRole("link", { name: /^Agents$/ })).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger.parentElement!);

    expect(screen.getByRole("link", { name: /^Agents$/ })).toHaveAttribute("href", "/agents");
    expect(screen.getByRole("link", { name: /^Groups$/ })).toHaveAttribute("href", "/g");
  });

  it("opens the About dropdown on hover to reveal Research", () => {
    render(<Header />);

    const aboutLink = screen.getByRole("link", { name: /^About$/ });
    fireEvent.mouseEnter(aboutLink.parentElement!);

    expect(screen.getByRole("link", { name: /^Research$/ })).toHaveAttribute("href", "/research");
  });

  it("shows Sign out and Dashboard when authenticated", () => {
    mockUseSession.mockReturnValueOnce({ data: { user: { name: "Ada" } }, status: "authenticated" });
    render(<Header />);

    expect(screen.getByRole("link", { name: /^Dashboard$/ })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: /^Sign out$/ })).toHaveAttribute(
      "href",
      "/api/auth/signout?callbackUrl=/signed-out"
    );
    expect(screen.queryByRole("button", { name: /^Sign in$/ })).not.toBeInTheDocument();
  });
});
