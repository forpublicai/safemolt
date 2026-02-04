/**
 * Parser for evaluation Markdown files with frontmatter
 */

import type { EvaluationDefinition, EvaluationFrontmatter } from './types';

/**
 * Simple YAML frontmatter parser
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    throw new Error('No frontmatter found. File must start with ---');
  }
  
  const yamlContent = match[1];
  const body = match[2];
  
  // Simple YAML parser for basic key-value pairs
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlContent.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;
    
    const key = trimmed.slice(0, colonIndex).trim();
    let value: unknown = trimmed.slice(colonIndex + 1).trim();
    
    // Remove quotes if present
    if (typeof value === 'string') {
      if ((value.startsWith('"') && value.endsWith('"')) || 
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
    }
    
    // Parse nested objects (simple support for executable: handler:)
    if (key.includes('.')) {
      const parts = key.split('.');
      let current: Record<string, unknown> = frontmatter;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) {
          current[parts[i]] = {};
        }
        current = current[parts[i]] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    } else {
      frontmatter[key] = value;
    }
    
    // Parse arrays (prerequisites:)
    if (key === 'prerequisites' && typeof value === 'string') {
      // Handle YAML array format: - item1\n  - item2
      const arrayLines = lines.filter(l => l.trim().startsWith('-'));
      if (arrayLines.length > 0) {
        frontmatter[key] = arrayLines.map(l => l.trim().slice(1).trim());
      }
    }
  }
  
  // Handle executable nested object
  if (frontmatter.executable && typeof frontmatter.executable === 'object') {
    // Already parsed above
  } else {
    // Try to parse executable from separate lines
    const executableLines: string[] = [];
    let inExecutable = false;
    for (const line of lines) {
      if (line.trim().startsWith('executable:')) {
        inExecutable = true;
        continue;
      }
      if (inExecutable) {
        if (line.trim().startsWith('-') || (!line.startsWith(' ') && line.trim())) {
          break;
        }
        executableLines.push(line);
      }
    }
    if (executableLines.length > 0) {
      const executable: Record<string, unknown> = {};
      for (const line of executableLines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
          const key = line.slice(0, colonIndex).trim();
          let val = line.slice(colonIndex + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || 
              (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          executable[key] = val;
        }
      }
      if (Object.keys(executable).length > 0) {
        frontmatter.executable = executable;
      }
    }
  }
  
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
  if (!frontmatter.name) {
    throw new Error(`Missing 'name' field in frontmatter: ${filePath}`);
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
  
  return {
    sip: Number(frontmatter.sip),
    id: String(frontmatter.id),
    name: String(frontmatter.name),
    module: String(frontmatter.module),
    type: frontmatter.type as EvaluationFrontmatter['type'],
    status: frontmatter.status as EvaluationFrontmatter['status'],
    prerequisites: Array.isArray(frontmatter.prerequisites) 
      ? frontmatter.prerequisites.map(String)
      : frontmatter.prerequisites 
        ? [String(frontmatter.prerequisites)]
        : [],
    author: String(frontmatter.author || 'unknown'),
    created_at: String(frontmatter.created_at || new Date().toISOString()),
    updated_at: String(frontmatter.updated_at || new Date().toISOString()),
    version: String(frontmatter.version || '1.0.0'),
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
