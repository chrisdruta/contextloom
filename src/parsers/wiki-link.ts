/**
 * Vendored wiki-link extractor for Markdown.
 * Supports: [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]]
 * Skips content inside fenced code blocks and inline code spans (best-effort line scan).
 */

export interface WikiLinkMatch {
  rawTarget: string;
  alias?: string;
  fragment?: string;
  /** Full match including brackets */
  full: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export function extractWikiLinks(source: string): WikiLinkMatch[] {
  const results: WikiLinkMatch[] = [];
  const lines = source.split("\n");
  let offset = 0;
  let inFence = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const lineStart = offset;

    // Fence detection (``` or ~~~)
    const fenceMatch = line.match(/^(\s*)(```|~~~)/);
    if (fenceMatch) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }
    if (inFence) {
      offset += line.length + 1;
      continue;
    }

    // Strip inline code spans for matching positions, but search original line
    // with a mask of code spans
    const mask = maskInlineCode(line);
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null = re.exec(line);
    while (m !== null) {
      // Skip if any char of the match is inside a code span
      const start = m.index;
      const end = m.index + m[0].length;
      if (!isMasked(mask, start, end)) {
        const inner = m[1]!.trim();
        if (inner) {
          let targetPart = inner;
          let alias: string | undefined;
          const pipe = inner.indexOf("|");
          if (pipe >= 0) {
            targetPart = inner.slice(0, pipe).trim();
            alias = inner.slice(pipe + 1).trim() || undefined;
          }

          let fragment: string | undefined;
          const hash = targetPart.indexOf("#");
          if (hash >= 0) {
            fragment = targetPart.slice(hash + 1).trim() || undefined;
            targetPart = targetPart.slice(0, hash).trim();
          }

          // Reconstruct rawTarget for resolver (path + optional fragment)
          let rawTarget = targetPart;
          if (fragment) rawTarget = `${targetPart}#${fragment}`;

          const startOffset = lineStart + start;
          const endOffset = lineStart + end;
          results.push({
            rawTarget,
            alias,
            fragment,
            full: m[0],
            startOffset,
            endOffset,
            startLine: lineIdx + 1,
            startColumn: start + 1,
            endLine: lineIdx + 1,
            endColumn: end + 1,
          });
        }
      }
      m = re.exec(line);
    }

    offset += line.length + 1; // +1 for \n (last line may not have it — ok for offsets)
  }

  return results;
}

function maskInlineCode(line: string): boolean[] {
  const mask = new Array(line.length).fill(false);
  // Match `code` and ``code``
  const re = /`+/g;
  const ticks: { start: number; len: number }[] = [];
  let m: RegExpExecArray | null = re.exec(line);
  while (m !== null) {
    ticks.push({ start: m.index, len: m[0].length });
    m = re.exec(line);
  }
  let i = 0;
  while (i < ticks.length) {
    const open = ticks[i]!;
    let closed = false;
    for (let j = i + 1; j < ticks.length; j++) {
      if (ticks[j]!.len === open.len) {
        const from = open.start;
        const to = ticks[j]!.start + ticks[j]!.len;
        for (let k = from; k < to; k++) mask[k] = true;
        i = j + 1;
        closed = true;
        break;
      }
    }
    if (!closed) i++;
  }
  return mask;
}

function isMasked(mask: boolean[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (mask[i]) return true;
  }
  return false;
}
