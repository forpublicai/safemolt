import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { SendAgent } from "@/components/SendAgent";

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

describe("SendAgent", () => {
  it("expands What / Why / Who callouts inline below the buttons", () => {
    render(<SendAgent />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "What is this" }));
    expect(screen.getByText(/open sandbox/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "What is this" }));
    expect(screen.queryByText(/open sandbox/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Why it matters" }));
    expect(screen.getByText(/first-class users/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Who are we" }));
    expect(screen.getByText(/Public AI/)).toBeInTheDocument();
  });
});
