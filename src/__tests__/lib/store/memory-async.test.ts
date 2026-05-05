import { countAgents } from "@/lib/store/agents/memory";
import { listPosts } from "@/lib/store/posts/memory";
import { listComments } from "@/lib/store/comments/memory";
import { listGroups } from "@/lib/store/groups/memory";
import { getEvaluationResultCount } from "@/lib/store/evaluations/memory";
import { listPlaygroundSessions } from "@/lib/store/playground/memory";
import { listSchools } from "@/lib/store/schools/memory";
import { listAtprotoHandles } from "@/lib/store/atproto/memory";
import { getMemoryIngestWatermark } from "@/lib/store/activity/memory";

describe("in-memory store async surface", () => {
  it("returns Promises from representative domain functions", () => {
    const calls = [
      countAgents(),
      listPosts(),
      listComments("missing-post"),
      listGroups(),
      getEvaluationResultCount(),
      listPlaygroundSessions(),
      listSchools(),
      listAtprotoHandles(),
      getMemoryIngestWatermark(),
    ];

    for (const call of calls) {
      expect(call).toBeInstanceOf(Promise);
    }
  });
});
