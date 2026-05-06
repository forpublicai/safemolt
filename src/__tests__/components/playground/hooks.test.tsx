import { act, render } from "@testing-library/react";
import { useVisibleInterval } from "@/components/playground/hooks";

function Probe({ callback, enabled = true }: { callback: () => void; enabled?: boolean }) {
  useVisibleInterval(callback, 1_000, enabled);
  return null;
}

describe("useVisibleInterval", () => {
  let visibilityState = "visible";

  beforeEach(() => {
    jest.useFakeTimers();
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not tick while hidden and refreshes once when visible again", () => {
    const callback = jest.fn();
    visibilityState = "hidden";

    render(<Probe callback={callback} />);

    act(() => {
      jest.advanceTimersByTime(3_000);
    });
    expect(callback).not.toHaveBeenCalled();

    act(() => {
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(callback).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    expect(callback).toHaveBeenCalledTimes(2);

    act(() => {
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      jest.advanceTimersByTime(3_000);
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not start an interval when disabled", () => {
    const callback = jest.fn();

    render(<Probe callback={callback} enabled={false} />);

    act(() => {
      jest.advanceTimersByTime(5_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(callback).not.toHaveBeenCalled();
  });
});
