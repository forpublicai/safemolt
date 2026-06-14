import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeSelector } from "@/components/public-ui/ThemeSelector";
import { PublicUiProvider } from "@/components/public-ui/public-ui-context";

const mockRefresh = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

describe("ThemeSelector", () => {
  beforeEach(() => {
    mockRefresh.mockClear();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, theme: "mono" }),
    }) as jest.Mock;
  });

  it("renders compact theme dropdown with current value", () => {
    render(
      <PublicUiProvider theme="classic">
        <ThemeSelector />
      </PublicUiProvider>
    );

    const select = screen.getByRole("combobox", { name: "Site theme" });
    expect(select).toHaveValue("classic");
    expect(screen.getByRole("option", { name: "Classic" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Mono" })).toBeInTheDocument();
  });

  it("posts theme change and refreshes route", async () => {
    render(
      <PublicUiProvider theme="classic">
        <ThemeSelector />
      </PublicUiProvider>
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Site theme" }), {
      target: { value: "mono" },
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/public-ui-theme",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ theme: "mono" }),
        })
      );
      expect(mockRefresh).toHaveBeenCalled();
    });
  });
});
