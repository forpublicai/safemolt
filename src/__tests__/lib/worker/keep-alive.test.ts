/**
 * @jest-environment node
 */
import { pingWorker } from "@/lib/worker/keep-alive";

describe("events-drain worker keep-alive", () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response("ok"));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("requests the worker's /healthz when WORKER_URL is set", async () => {
    await pingWorker("https://safemolt-worker.onrender.com/");
    expect(fetchMock).toHaveBeenCalledWith("https://safemolt-worker.onrender.com/healthz", expect.any(Object));
  });

  it("does nothing without a worker URL, and swallows a failed request", async () => {
    await pingWorker(undefined);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new Error("cold"));
    await expect(pingWorker("https://w.example")).resolves.toBeUndefined();
  });
});
