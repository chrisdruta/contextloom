import type { RawReference } from "../shared/types";

/** A raw @import candidate found in markdown text (Claude Code style). */
export interface AtImportCandidate {
  rawTarget: string;
  range: RawReference["range"];
}

/** Extract @path imports, skipping fenced blocks and inline code spans. */
export function extractAtImports(source: string, path: string): AtImportCandidate[] {
  const found: AtImportCandidate[] = [];
  const lines = source.split("\n");
  let offset = 0;
  let inFence = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }
    if (inFence) {
      offset += line.length + 1;
      continue;
    }

    const re = /@([^\s`]+)/g;
    let m: RegExpExecArray | null;
    const codeSpans = maskBackticks(line);

    for (;;) {
      m = re.exec(line);
      if (m === null) break;
      if (codeSpans[m.index]) continue;
      const target = m[1]!;
      // Skip email-like and bare @mentions without path chars
      if (!target.includes("/") && !target.includes(".") && !target.endsWith(".md")) {
        // Still allow @AGENTS.md style
        if (!/\.(md|mdc|txt|json)$/i.test(target)) continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      found.push({
        rawTarget: target,
        range: {
          path,
          start: { line: lineIdx + 1, column: start + 1, offset: offset + start },
          end: { line: lineIdx + 1, column: end + 1, offset: offset + end },
        },
      });
    }
    offset += line.length + 1;
  }
  return found;
}

function maskBackticks(line: string): boolean[] {
  const mask = new Array(line.length).fill(false);
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "`") {
      inCode = !inCode;
      mask[i] = true;
    } else if (inCode) {
      mask[i] = true;
    }
  }
  return mask;
}
