export interface ResearchAuthor {
  name: string;
  url?: string;
  affiliation?: string;
}

export interface ResearchTocItem {
  id: string;
  label: string;
}

/** Frontmatter for MDX files in content/research/ */
export interface ResearchPostFrontmatter {
  title: string;
  slug: string;
  date: string;
  updated?: string;
  abstract: string;
  authors: ResearchAuthor[];
  ogImage?: string;
  toc?: boolean;
  /** Anchor ids must match `rehype-slug` output for corresponding `##` headings */
  tocItems?: ResearchTocItem[];
}

export type ResearchPostListItem = ResearchPostFrontmatter & {
  /** ISO date for sorting */
  timestamp: number;
};
