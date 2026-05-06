import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlaygroundContent } from "@/components/playground/PlaygroundContent";
import type { GameDef, PlaygroundSession } from "@/components/playground/types";

jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <>{children}</>,
}));

describe("PlaygroundContent", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        json: async () =>
          url.includes("/api/v1/playground/games")
            ? { success: true, data: [] }
            : { success: true, data: [] },
      } as Response;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders the sessions pane and empty detail prompt", async () => {
    render(<PlaygroundContent />);

    expect(screen.getByRole("heading", { name: "Playground" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(await screen.findByText(/\[select a session\]/)).toBeInTheDocument();
    expect(await screen.findByText(/No\s+simulations yet/)).toBeInTheDocument();
  });

  it("renders server-provided sessions and games on first paint", () => {
    render(<PlaygroundContent initialGames={[game]} initialLoaded initialSessions={[session]} />);

    expect(screen.getByText("[active] 1")).toBeInTheDocument();
    expect(screen.getByText("[games] 1")).toBeInTheDocument();
    expect(screen.getByText(/Arlo/)).toBeInTheDocument();
    expect(screen.getByText("2-5 players | 4 rounds")).toBeInTheDocument();
  });

  it("skips the mount-time sessions fetch for server-provided data, then fetches on tab change", async () => {
    render(<PlaygroundContent initialGames={[game]} initialLoaded initialSessions={[session]} />);

    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "[completed]" }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("status=completed"), expect.any(Object)));
  });

  it("normalizes snake_case game API payloads before rendering cards", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        json: async () =>
          url.includes("/api/v1/playground/games")
            ? {
                success: true,
                data: [
                  {
                    id: "trade-bazaar",
                    name: "Trade Bazaar",
                    description: "A trading game.",
                    min_players: 2,
                    max_players: 5,
                    default_max_rounds: 4,
                  },
                ],
              }
            : { success: true, data: [] },
      } as Response;
    });

    render(<PlaygroundContent initialLoaded />);

    expect(await screen.findByText("2-5 players | 4 rounds")).toBeInTheDocument();
  });

  it("filters legacy unsupported session statuses from refreshed lists", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        json: async () =>
          url.includes("/api/v1/playground/games")
            ? { success: true, data: [] }
            : {
                success: true,
                data: [
                  { ...session, id: "active-session", status: "active" },
                  { ...session, id: "legacy-session", status: "cancelled" },
                ],
              },
      } as Response;
    });

    render(<PlaygroundContent />);

    expect(await screen.findByText(/Arlo/)).toBeInTheDocument();
    expect(screen.queryByText(/\[cancelled\]/)).not.toBeInTheDocument();
  });

  it("surfaces unsuccessful session API responses", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        json: async () =>
          url.includes("/api/v1/playground/games")
            ? { success: true, data: [] }
            : { success: false, error: "rate limited" },
      } as Response;
    });

    render(<PlaygroundContent />);

    expect(await screen.findByText(/rate limited/)).toBeInTheDocument();
  });

  it("surfaces unavailable session details", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      json: async () => ({ success: true, data: { ...session, status: "cancelled" } }),
    } as Response);

    render(<PlaygroundContent initialGames={[game]} initialLoaded initialSessions={[session]} />);

    fireEvent.click(document.getElementById("session-pg-1")!);

    expect(await screen.findByText(/Session unavailable/)).toBeInTheDocument();
  });

  it("surfaces unsuccessful session detail responses", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      json: async () => ({ success: false, error: "detail failed" }),
    } as Response);

    render(<PlaygroundContent initialGames={[game]} initialLoaded initialSessions={[session]} />);

    fireEvent.click(document.getElementById("session-pg-1")!);

    expect(await screen.findByText(/detail failed/)).toBeInTheDocument();
  });
});

const game: GameDef = {
  id: "trade-bazaar",
  name: "Trade Bazaar",
  description: "A trading game.",
  minPlayers: 2,
  maxPlayers: 5,
  defaultMaxRounds: 4,
};

const session: PlaygroundSession = {
  id: "pg-1",
  gameId: "trade-bazaar",
  status: "active",
  participants: [{ agentId: "agent-1", agentName: "Arlo", status: "active" }],
  transcript: [],
  currentRound: 2,
  maxRounds: 4,
  createdAt: new Date().toISOString(),
};
