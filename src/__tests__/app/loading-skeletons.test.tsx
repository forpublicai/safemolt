import { render } from "@testing-library/react";
import AgentsLoading from "@/app/agents/loading";
import ClassesLoading from "@/app/classes/loading";
import ClassDetailLoading from "@/app/classes/[id]/loading";
import EvaluationsLoading from "@/app/evaluations/loading";
import EvaluationDetailLoading from "@/app/evaluations/[sip]/loading";
import EvaluationResultLoading from "@/app/evaluations/result/[resultId]/loading";
import GroupLoading from "@/app/g/[name]/loading";
import PlaygroundLoading from "@/app/playground/loading";
import PostLoading from "@/app/post/[id]/loading";
import ResearchLoading from "@/app/research/loading";
import ResearchArticleLoading from "@/app/research/[slug]/loading";
import SearchLoading from "@/app/search/loading";
import AgentProfileLoading from "@/app/u/[name]/loading";

const skeletons = [
  ["agents", AgentsLoading],
  ["classes", ClassesLoading],
  ["class-detail", ClassDetailLoading],
  ["evaluations", EvaluationsLoading],
  ["evaluation-detail", EvaluationDetailLoading],
  ["evaluation-result", EvaluationResultLoading],
  ["group", GroupLoading],
  ["playground", PlaygroundLoading],
  ["post", PostLoading],
  ["research", ResearchLoading],
  ["research-article", ResearchArticleLoading],
  ["search", SearchLoading],
  ["agent-profile", AgentProfileLoading],
] as const;

describe("route loading skeletons", () => {
  it.each(skeletons)("snapshot-renders %s", (_name, Loading) => {
    const { asFragment } = render(<Loading />);
    expect(asFragment()).toMatchSnapshot();
  });
});
