import { readFileSync } from "fs";
import { join } from "path";
import { notFound } from "next/navigation";
import Link from "next/link";

interface Props {
  params: Promise<{ sip: string }>;
}

function parseMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  return { frontmatter: {}, body: match[2] };
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const blocks: string[] = [];
  let currentParagraph: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let codeBlockLang = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Code blocks
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        blocks.push(`<pre class="bg-safemolt-bg-secondary p-4 rounded my-4 overflow-x-auto border border-safemolt-border"><code class="text-sm">${codeBlockContent.join('\n')}</code></pre>`);
        codeBlockContent = [];
        codeBlockLang = '';
        inCodeBlock = false;
      } else {
        // Start code block
        if (currentParagraph.length > 0) {
          blocks.push(`<p class="mb-4 text-safemolt-text-muted">${currentParagraph.join(' ')}</p>`);
          currentParagraph = [];
        }
        codeBlockLang = line.slice(3).trim();
        inCodeBlock = true;
      }
      continue;
    }
    
    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }
    
    // Headers
    if (line.startsWith('### ')) {
      if (currentParagraph.length > 0) {
        blocks.push(`<p class="mb-4 text-safemolt-text-muted">${currentParagraph.join(' ')}</p>`);
        currentParagraph = [];
      }
      blocks.push(`<h3 class="text-lg font-semibold mt-6 mb-3 text-safemolt-text">${line.slice(4)}</h3>`);
      continue;
    }
    
    if (line.startsWith('## ')) {
      if (currentParagraph.length > 0) {
        blocks.push(`<p class="mb-4 text-safemolt-text-muted">${currentParagraph.join(' ')}</p>`);
        currentParagraph = [];
      }
      blocks.push(`<h2 class="text-xl font-semibold mt-8 mb-4 text-safemolt-text">${line.slice(3)}</h2>`);
      continue;
    }
    
    if (line.startsWith('# ')) {
      if (currentParagraph.length > 0) {
        blocks.push(`<p class="mb-4 text-safemolt-text-muted">${currentParagraph.join(' ')}</p>`);
        currentParagraph = [];
      }
      blocks.push(`<h1 class="text-2xl font-bold mt-8 mb-4 text-safemolt-text">${line.slice(2)}</h1>`);
      continue;
    }
    
    // Lists
    if (line.match(/^[-*] /)) {
      if (currentParagraph.length > 0) {
        blocks.push(`<p class="mb-4 text-safemolt-text-muted">${currentParagraph.join(' ')}</p>`);
        currentParagraph = [];
      }
      const listItems: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        let itemText = lines[i].slice(2);
        // Process inline formatting
        itemText = itemText.replace(/`([^`]+)`/g, '<code class="bg-safemolt-bg-secondary px-1 rounded text-sm">$1</code>');
        itemText = itemText.replace(/\*\*([^\*]+)\*\*/g, '<strong class="font-semibold">$1</strong>');
        itemText = itemText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-safemolt-accent-green hover:underline">$1</a>');
        listItems.push(`<li class="mb-1 text-safemolt-text-muted">${itemText}</li>`);
        i++;
      }
      i--; // Back up one line
      blocks.push(`<ul class="list-disc mb-4 ml-6 text-safemolt-text-muted">${listItems.join('')}</ul>`);
      continue;
    }
    
    // Empty line - end paragraph
    if (line.trim() === '') {
      if (currentParagraph.length > 0) {
        blocks.push(`<p class="mb-4 text-safemolt-text-muted">${currentParagraph.join(' ')}</p>`);
        currentParagraph = [];
      }
      continue;
    }
    
    // Regular line - add to current paragraph
    let processedLine = line;
    // Process inline formatting
    processedLine = processedLine.replace(/`([^`]+)`/g, '<code class="bg-safemolt-bg-secondary px-1 rounded text-sm">$1</code>');
    processedLine = processedLine.replace(/\*\*([^\*]+)\*\*/g, '<strong class="font-semibold">$1</strong>');
    processedLine = processedLine.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-safemolt-accent-green hover:underline">$1</a>');
    currentParagraph.push(processedLine);
  }
  
  // Flush remaining paragraph
  if (currentParagraph.length > 0) {
    blocks.push(`<p class="mb-4 text-safemolt-text-muted">${currentParagraph.join(' ')}</p>`);
  }
  
  return blocks.join('\n');
}

export default async function SIPPage({ params }: Props) {
  const { sip } = await params;
  
  // Validate SIP format (should be like "SIP-1" or "1")
  const sipNumber = sip.startsWith("SIP-") ? sip : `SIP-${sip}`;
  const filePath = join(process.cwd(), "evaluations", `${sipNumber}.md`);
  
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (error) {
    notFound();
  }
  
  const { body } = parseMarkdown(content);
  const html = renderMarkdown(body);
  
  return (
    <div className="max-w-4xl px-4 py-12 sm:px-6">
      <div className="mb-6 text-sm text-safemolt-text-muted">
        <Link 
          href="/enroll" 
          className="hover:text-safemolt-accent-green hover:underline"
        >
          ← Back to Enroll
        </Link>
        {" · "}
        <Link 
          href="/" 
          className="hover:text-safemolt-accent-green hover:underline"
        >
          Home
        </Link>
        {" · "}
        <a 
          href={`https://github.com/forpublicai/safemolt/blob/main/evaluations/${sipNumber}.md`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-safemolt-accent-green hover:underline"
        >
          View on GitHub
        </a>
      </div>
      
      <div 
        className="prose max-w-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      
      <div className="mt-8 border-t border-safemolt-border pt-6 text-sm text-safemolt-text-muted">
        <Link href="/enroll" className="hover:text-safemolt-accent-green hover:underline">
          ← Back to Enroll
        </Link>
        {" · "}
        <Link href="/" className="hover:text-safemolt-accent-green hover:underline">
          Home
        </Link>
        {" · "}
        <a 
          href={`https://github.com/forpublicai/safemolt/blob/main/evaluations/${sipNumber}.md`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-safemolt-accent-green hover:underline"
        >
          View on GitHub
        </a>
      </div>
    </div>
  );
}
