import { fireEvent, render, screen } from "@testing-library/react";
import { SessionCard } from "@/components/playground/SessionCard";
import type { PlaygroundSession } from "@/components/playground/types";

function sampleSession(): PlaygroundSession {
  return {
    id: "session-1",
    gameId: "prisoners-dilemma",
    status: "active",
    participants: [
      { agentId: "a1", agentName: "Ada", status: "active" },
      { agentId: "a2", agentName: "Turing", status: "active" },
    ],
    transcript: [],
    currentRound: 2,
    roundDeadline: new Date(Date.now() + 120_000).toISOString(),
    maxRounds: 4,
    createdAt: new Date(Date.now() - 300_000).toISOString(),
  };
}

describe("SessionCard", () => {
  it("renders the session title, status, participants, and recency", () => {
    render(
      <SessionCard
        session={sampleSession()}
        gameName="Prisoner's Dilemma"
        isSelected={false}
        onClick={jest.fn()}
      />
    );

    expect(screen.getByText(/Prisoner's Dilemma/)).toBeInTheDocument();
    expect(screen.getByText("[active]")).toBeInTheDocument();
    expect(screen.getByText(/Ada, Turing/)).toBeInTheDocument();
    expect(screen.getByText(/m ago/)).toBeInTheDocument();
  });

  it("opens the session when clicked", () => {
    const onClick = jest.fn();
    render(
      <SessionCard
        session={sampleSession()}
        gameName="Prisoner's Dilemma"
        isSelected={false}
        onClick={onClick}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Prisoner's Dilemma/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("truncates long participant lists", () => {
    const session = sampleSession();
    session.participants = [
      { agentId: "a1", agentName: "Ada", status: "active" },
      { agentId: "a2", agentName: "Turing", status: "active" },
      { agentId: "a3", agentName: "Grace", status: "active" },
      { agentId: "a4", agentName: "Katherine", status: "active" },
      { agentId: "a5", agentName: "Margaret", status: "active" },
    ];

    render(
      <SessionCard
        session={session}
        gameName="Prisoner's Dilemma"
        isSelected={false}
        onClick={jest.fn()}
      />
    );

    expect(screen.getByText(/Ada, Turing, Grace \+2 more/)).toBeInTheDocument();
    expect(screen.queryByText(/Katherine/)).not.toBeInTheDocument();
  });

  it("adds status stripe and selected card classes", () => {
    render(
      <SessionCard
        session={sampleSession()}
        gameName="Prisoner's Dilemma"
        isSelected
        onClick={jest.fn()}
      />
    );

    const card = screen.getByRole("button", { name: /Prisoner's Dilemma/ });
    expect(card).toHaveClass("playground-session-card");
    expect(card).toHaveClass("playground-card-status-active");
    expect(card).toHaveClass("playground-session-card-selected");
  });
});
