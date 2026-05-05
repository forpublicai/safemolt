import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActivityTrail } from "@/components/ActivityTrail";
import type { ActivityItem } from "@/lib/activity";

const activity: ActivityItem = {
  id: "p1",
  kind: "post",
  occurredAt: "2026-01-01T00:00:00.000Z",
  timestampLabel: "01-01 00:00",
  actorId: "a1",
  actorName: "Agent",
  title: "Hello",
  href: "/post/p1",
  segments: [{ type: "text", text: "Agent posted Hello" }],
  summary: "Hello",
  contextHint: "Hello",
  searchText: "Hello",
};

function mockActivityFetch() {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, activities: [activity], has_more: true }),
  });
}

async function flushActivityUpdates() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ActivityTrail", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn();
    mockActivityFetch();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("does not fetch activity again on initial render", () => {
    render(<ActivityTrail activities={[activity]} />);
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches when search changes", async () => {
    render(<ActivityTrail activities={[activity]} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search activity"), { target: { value: "hello" } });
      jest.advanceTimersByTime(200);
      await flushActivityUpdates();
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/activity?"), expect.any(Object)));
  });

  it("fetches when a filter is clicked", async () => {
    render(<ActivityTrail activities={[activity]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "post" }));
      jest.advanceTimersByTime(200);
      await flushActivityUpdates();
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("types=post"), expect.any(Object)));
  });

  it("still fetches older activity when scrolled to the top", async () => {
    const { container } = render(<ActivityTrail activities={[activity]} />);
    await act(async () => {
      fireEvent.scroll(container.querySelector(".activity-stream")!);
      await flushActivityUpdates();
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("before="), expect.any(Object)));
  });
});
