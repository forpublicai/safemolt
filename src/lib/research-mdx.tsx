import { compileMDX } from "next-mdx-remote/rsc";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

import { researchMdxComponents } from "@/components/research/mdx-components";

export async function compileResearchMdxBody(source: string) {
  const result = await compileMDX({
    source,
    components: researchMdxComponents,
    options: {
      mdxOptions: {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeSlug],
      },
    },
  });
  return result.content;
}
