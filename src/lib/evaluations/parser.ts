/**
 * Parser for evaluation Markdown files with frontmatter
 */

import type { EvaluationDefinition, EvaluationFrontmatter } from './types';

/**
 * Simple YAML frontmatter parser
 */
/**
 * Improved simple YAML parser for frontmatter
 * Supports nested objects and arrays
 */
class SimpleYamlParser {
  private lines: string[];
  private current = 0;

  constructor(content: string) {
    this.lines = content.split('\n');
  }

  parse(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    while (this.current < this.lines.length) {
      const line = this.lines[this.current];
      if (!line.trim() || line.trim().startsWith('#')) {
        this.current++;
        continue;
      }

      const indent = this.getIndent(line);
      if (indent > 0) {
        // Should not happen at top level usually, unless bad formatting
        this.current++;
        continue;
      }

      const { key, value } = this.parseLine(line);
      if (key) {
        this.current++;
        if (value === '' || value === null || value === undefined) {
          result[key] = this.parseBlock(indent + 1); // Expect children
        } else {
          result[key] = value;
        }
      } else {
        this.current++;
      }
    }
    return result;
  }

  private parseBlock(minIndent: number): unknown {
    if (this.current >= this.lines.length) return {};

    // Check if next line is array item or object key
    const firstLine = this.lines[this.current];
    const firstIndent = this.getIndent(firstLine);

    if (firstIndent < minIndent) return {}; // End of block

    const isArray = firstLine.trim().startsWith('-');

    if (isArray) {
      const list: unknown[] = [];
      while (this.current < this.lines.length) {
        const line = this.lines[this.current];
        if (!line.trim() || line.trim().startsWith('#')) {
          this.current++;
          continue;
        }

        const indent = this.getIndent(line);
        if (indent < minIndent) break;

        if (line.trim().startsWith('-')) {
          // New array item
          const content = line.trim().slice(1).trim();
          this.current++;

          if (content) {
            // Formatting like "- value" or "- key: value"
            if (content.includes(': ') && !content.startsWith('"') && !content.startsWith("'")) {
              // It's likely beginning of an object: "- id: foo"
              // We need to parse this line as key-value, then subsequent lines as rest of object
              const { key, value } = this.parseLine(content, true); // Treat as valid line content
              // Create object for this item
              const obj: Record<string, unknown> = {};
              if (key) obj[key] = value;

              // Helper: merge subsequent indented lines into this object
              // The indentation for the rest of object must match the key's effective indent?
              // Actually, usually in YAML:
              // - id: foo
              //   bar: baz
              // The 'bar' is indented relative to '-' (2 spaces) or same level?
              // Usually aligned with 'id'.

              // Let's rely on parseObjectBlock but we need to pass current indentation context
              const itemObj = this.parseObjectBlock(indent + 2); // approximate indent
              Object.assign(obj, itemObj);
              list.push(obj);
            } else {
              // Scalar or simple item
              list.push(this.parseValue(content));
            }
          } else {
            // Item starts on next line? "- \n  value"
            // Or object starting on next line
            const item = this.parseBlock(indent + 1);
            list.push(item);
          }
        } else {
          // Continuation of previous item? Unhandled for now
          this.current++;
        }
      }
      return list;
    } else {
      return this.parseObjectBlock(minIndent);
    }
  }

  private parseObjectBlock(minIndent: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (this.current < this.lines.length) {
      const line = this.lines[this.current];
      if (!line.trim() || line.trim().startsWith('#')) {
        this.current++;
        continue;
      }

      const indent = this.getIndent(line);
      if (indent < minIndent) break;

      const { key, value } = this.parseLine(line);
      this.current++;

      if (key) {
        if (value === '' || value === null) {
          const nextIndent = this.getIndent(this.lines[this.current] || '');
          if (nextIndent > indent) {
            obj[key] = this.parseBlock(nextIndent);
          } else {
            obj[key] = null;
          }
        } else {
          obj[key] = value;
        }
      }
    }
    return obj;
  }

  private getIndent(line: string): number {
    return line.search(/\S/);
  }

  private parseLine(line: string, isContent = false): { key?: string, value?: unknown } {
    const content = isContent ? line : line.trim();
    const colonIndex = content.indexOf(':');
    if (colonIndex === -1) return { value: content }; // Just a value?

    const key = content.slice(0, colonIndex).trim();
    const valString = content.slice(colonIndex + 1).trim();

    return { key, value: this.parseValue(valString) };
  }

  private parseValue(val: string): unknown {
    if (!val) return null;
    if (val === '[]') return [];
    if (val === '{}') return {};

    // Quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      return val.slice(1, -1);
    }

    // Booleans
    if (val === 'true') return true;
    if (val === 'false') return false;

    // Numbers
    const num = Number(val);
    if (!isNaN(num) && val.trim() !== '') return num;

    return val;
  }
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    throw new Error('No frontmatter found. File must start with ---');
  }

  const yamlContent = match[1];
  const body = match[2];

  const parser = new SimpleYamlParser(yamlContent);
  const frontmatter = parser.parse();

  return { frontmatter, body };
}

/**
 * Parse a Markdown file with frontmatter into an EvaluationDefinition
 */
export function parseEvaluationFile(
  content: string,
  filePath: string
): EvaluationDefinition {
  const { frontmatter, body } = parseFrontmatter(content);

  // Validate required frontmatter fields
  if (!frontmatter.sip) {
    throw new Error(`Missing 'sip' field in frontmatter: ${filePath}`);
  }
  if (!frontmatter.id) {
    throw new Error(`Missing 'id' field in frontmatter: ${filePath}`);
  }
  const name = frontmatter.name ?? frontmatter.title;
  if (!name) {
    throw new Error(`Missing 'name' or 'title' field in frontmatter: ${filePath}`);
  }
  if (!frontmatter.module) {
    throw new Error(`Missing 'module' field in frontmatter: ${filePath}`);
  }
  if (!frontmatter.type) {
    throw new Error(`Missing 'type' field in frontmatter: ${filePath}`);
  }
  if (!frontmatter.status) {
    throw new Error(`Missing 'status' field in frontmatter: ${filePath}`);
  }
  if (!frontmatter.executable) {
    throw new Error(`Missing 'executable' field in frontmatter: ${filePath}`);
  }
  const executable = frontmatter.executable as Record<string, unknown>;
  if (!executable.handler) {
    throw new Error(`Missing 'executable.handler' field in frontmatter: ${filePath}`);
  }
  if (!executable.script_path) {
    throw new Error(`Missing 'executable.script_path' field in frontmatter: ${filePath}`);
  }

  // Parse points, defaulting to 0 if not specified
  let points = 0;
  if (frontmatter.points !== undefined) {
    const parsedPoints = typeof frontmatter.points === 'string'
      ? parseFloat(frontmatter.points)
      : Number(frontmatter.points);
    points = isNaN(parsedPoints) ? 0 : parsedPoints;
  }

  return {
    sip: Number(frontmatter.sip),
    id: String(frontmatter.id),
    name: String(name),
    module: String(frontmatter.module),
    type: frontmatter.type as EvaluationFrontmatter['type'],
    status: frontmatter.status as EvaluationFrontmatter['status'],
    prerequisites: Array.isArray(frontmatter.prerequisites)
      ? frontmatter.prerequisites.map(String).filter(p => p && p.trim().length > 0)
      : frontmatter.prerequisites
        ? [String(frontmatter.prerequisites)].filter(p => p && p.trim().length > 0)
        : [],
    author: String(frontmatter.author || 'unknown'),
    created_at: String(frontmatter.created_at || new Date().toISOString()),
    updated_at: String(frontmatter.updated_at || new Date().toISOString()),
    version: String(frontmatter.version || '1.0.0'),
    points,
    config: frontmatter.config as Record<string, unknown> | undefined,
    executable: {
      handler: String(executable.handler),
      script_path: String(executable.script_path),
    },
    file_path: filePath,
    content: body,
  };
}

/**
 * Extract description from markdown content (first paragraph or heading)
 */
export function extractDescription(content: string): string {
  // Try to find first paragraph after first heading
  const lines = content.split('\n');
  let description = '';
  let foundHeading = false;

  for (const line of lines) {
    if (line.startsWith('#') && !foundHeading) {
      foundHeading = true;
      continue;
    }
    if (foundHeading && line.trim() && !line.startsWith('#')) {
      description = line.trim();
      break;
    }
  }

  // Fallback: use first non-empty line
  if (!description) {
    for (const line of lines) {
      if (line.trim() && !line.startsWith('---') && !line.startsWith('#')) {
        description = line.trim();
        break;
      }
    }
  }

  return description || 'No description available';
}
