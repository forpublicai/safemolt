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
});
