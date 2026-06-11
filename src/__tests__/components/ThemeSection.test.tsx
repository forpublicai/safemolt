import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ThemeSection } from "@/components/public-ui/ThemeSection";
import { PublicUiProvider } from "@/components/public-ui/public-ui-context";

describe("ThemeSection", () => {
  it("renders children only when active theme matches", () => {
    const { rerender } = render(
      <PublicUiProvider theme="classic">
        <ThemeSection themes={["classic"]}>
          <p>Classic only</p>
        </ThemeSection>
      </PublicUiProvider>
    );
    expect(screen.getByText("Classic only")).toBeInTheDocument();

    rerender(
      <PublicUiProvider theme="mono">
        <ThemeSection themes={["classic"]}>
          <p>Classic only</p>
        </ThemeSection>
      </PublicUiProvider>
    );
    expect(screen.queryByText("Classic only")).not.toBeInTheDocument();
  });
});
