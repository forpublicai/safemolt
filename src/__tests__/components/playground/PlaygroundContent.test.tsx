import { render, screen } from "@testing-library/react";
import { PlaygroundContent } from "@/components/playground/PlaygroundContent";

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

    expect(screen.getByText("[Playground]")).toBeInTheDocument();
    expect(await screen.findByText(/\[Sessions\]/)).toBeInTheDocument();
    expect(await screen.findByText(/\[select a session\]/)).toBeInTheDocument();
    expect(await screen.findByText(/No\s+simulations yet/)).toBeInTheDocument();
  });
});
