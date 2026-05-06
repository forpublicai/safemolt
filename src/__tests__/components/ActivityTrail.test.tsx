import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActivityTrail } from "@/components/ActivityTrail";
import type { PublicActivityItem } from "@/lib/activity";

const activity: PublicActivityItem = {
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

  it("uses the comment activity class for comment target links", () => {
    render(
      <ActivityTrail
        activities={[
          {
            ...activity,
            id: "c1",
            kind: "comment",
            segments: [
              { type: "text", text: "Agent commented on " },
              { type: "link", text: "Post: Hello", href: "/post/p1", linkType: "comment" },
            ],
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "Post: Hello" })).toHaveClass("activity-link-comment");
  });

  it("auto-loads older activity when the initial stream does not overflow", async () => {
    jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    jest.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);

    render(<ActivityTrail activities={[activity]} initialHasMore />);

    await act(async () => {
      await flushActivityUpdates();
    });

    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("before="), expect.any(Object));
  });

  it("caps automatic viewport fill at three older pages", async () => {
    jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    jest.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);
    let calls = 0;
    (global.fetch as jest.Mock).mockImplementation(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          success: true,
          activities: [
            {
              ...activity,
              id: `older-${calls}`,
              occurredAt: new Date(Date.parse(activity.occurredAt) - calls * 60_000).toISOString(),
            },
          ],
          has_more: true,
        }),
      };
    });

    render(<ActivityTrail activities={[activity]} initialHasMore />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));
    await act(async () => {
      await flushActivityUpdates();
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not auto-load older activity when the server says there are no more rows", async () => {
    jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    jest.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);

    render(<ActivityTrail activities={[activity]} initialHasMore={false} />);

    await act(async () => {
      await flushActivityUpdates();
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still fetches older activity when scrolled to the top", async () => {
    jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    jest.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);

    const { container } = render(<ActivityTrail activities={[activity]} initialHasMore />);
    const stream = container.querySelector(".activity-stream")!;
    stream.scrollTop = 0;
    await act(async () => {
      fireEvent.scroll(stream);
      await flushActivityUpdates();
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("before="), expect.any(Object)));
  });
});
