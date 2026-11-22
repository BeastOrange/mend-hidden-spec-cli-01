// mend: one patch tool for every AI edit format (SPEC v1)
// Supports unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edits.
// Implements 3-tier fuzzy line matching, precise whitespace/newline preservation,
// and all-or-nothing atomic writes.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

interface MoveRecord {
  oldPath: string;
  newPath: string;
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree, moves: MoveRecord[]) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- Section 3 & 5: File & Tier helpers ---

interface FileDoc {
  lines: string[];
  br: string;
  hasFinalBreak: boolean;
}

function parseFileDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', hasFinalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const hasFinalBreak = text.endsWith(br);
  const body = hasFinalBreak ? text.slice(0, -br.length) : text;
  const lines = body.split(br);
  return { lines, br, hasFinalBreak };
}

function stringifyFileDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.hasFinalBreak ? doc.br : '');
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

function leadingWS(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
}

function lineMatches(f: string, p: string, tier: number): boolean {
  if (tier === 0) return f === p;
  if (tier === 1) return stripTrailing(f) === stripTrailing(p);
  if (tier === 2) return stripBoth(f) === stripBoth(p);
  return false;
}

function findOccurrencesAtTier(fileLines: string[], O: string[], tier: number): number[] {
  if (O.length === 0 || fileLines.length < O.length) return [];
  const occ: number[] = [];
  for (let i = 0; i <= fileLines.length - O.length; i++) {
    let match = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineMatches(fileLines[i + j], O[j], tier)) {
        match = false;
        break;
      }
    }
    if (match) occ.push(i);
  }
  return occ;
}

function findOccurrences(fileLines: string[], O: string[], strict: boolean): { tier: number; occurrences: number[] } {
  const t0 = findOccurrencesAtTier(fileLines, O, 0);
  if (t0.length > 0) return { tier: 0, occurrences: t0 };
  if (strict) return { tier: -1, occurrences: [] };
  const t1 = findOccurrencesAtTier(fileLines, O, 1);
  if (t1.length > 0) return { tier: 1, occurrences: t1 };
  const t2 = findOccurrencesAtTier(fileLines, O, 2);
  if (t2.length > 0) return { tier: 2, occurrences: t2 };
  return { tier: -1, occurrences: [] };
}

function findAnchor(fileLines: string[], cursor: number, anchor: string, strict: boolean): number {
  for (let i = cursor; i < fileLines.length; i++) {
    if (lineMatches(fileLines[i], anchor, 0)) return i;
  }
  if (strict) return -1;
  for (let i = cursor; i < fileLines.length; i++) {
    if (lineMatches(fileLines[i], anchor, 1)) return i;
  }
  for (let i = cursor; i < fileLines.length; i++) {
    if (lineMatches(fileLines[i], anchor, 2)) return i;
  }
  return -1;
}

function reindent(text: string, F: string, P: string): string {
  if (text !== '' && text.trim() !== '' && text.startsWith(P)) {
    return F + text.slice(P.length);
  }
  return text;
}

// --- Section 9: JSON Edits ---

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Section 7: SEARCH/REPLACE blocks ---

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastReplaceIdx = -1;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNum = i + 1;
      const searchIdx = i;

      let path: string | null = null;
      for (let k = searchIdx - 1; k > lastReplaceIdx; k--) {
        const l = lines[k];
        if (!blank(l) && !l.trim().startsWith('```')) {
          path = l.trim();
          break;
        }
      }
      if (path === null) {
        if (lastPath !== null) {
          path = lastPath;
        } else {
          throw new Exit2(`error: parse ${searchLineNum}`);
        }
      }

      let eqIdx = -1;
      for (let k = searchIdx + 1; k < lines.length; k++) {
        if (lines[k].trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[k].trimEnd() === '=======') {
          eqIdx = k;
          break;
        }
      }
      if (eqIdx < 0) throw new Exit2(`error: parse ${searchLineNum}`);

      let repIdx = -1;
      for (let k = eqIdx + 1; k < lines.length; k++) {
        if (lines[k].trimEnd() === '<<<<<<< SEARCH' || lines[k].trimEnd() === '=======') break;
        if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
          repIdx = k;
          break;
        }
      }
      if (repIdx < 0) throw new Exit2(`error: parse ${searchLineNum}`);

      const oldLines = lines.slice(searchIdx + 1, eqIdx);
      const newLines = lines.slice(eqIdx + 1, repIdx);
      lastReplaceIdx = repIdx;
      lastPath = path;
      i = repIdx + 1;

      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (oldLines.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        } else {
          const before = tree.get(p);
          if (before === null) throw new Fail('missing', p);
          const doc = parseFileDoc(before);
          const match = findOccurrences(doc.lines, oldLines, strict);
          if (match.tier < 0 || match.occurrences.length === 0) throw new Fail('no-match', p);
          if (match.occurrences.length > 1) throw new Fail('ambiguous', p);
          const pos = match.occurrences[0];
          const tier = match.tier;
          const F = leadingWS(doc.lines[pos]);
          const P = leadingWS(oldLines[0]);
          const nLines = newLines.map((l) => (tier === 2 ? reindent(l, F, P) : l));
          doc.lines.splice(pos, oldLines.length, ...nLines);
          tree.now.set(p, stringifyFileDoc(doc));
        }
      });
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// --- Section 6: Unified diffs ---

interface HunkItem {
  type: 'context' | 'old' | 'new';
  text: string;
  backslashAfter?: boolean;
}

interface Hunk {
  A: number;
  items: HunkItem[];
}

interface UnifiedSection {
  diffGitOld: string | null;
  diffGitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  hasOldSpec: boolean;
  hasNewSpec: boolean;
  isCreation: boolean;
  isDeletion: boolean;
  hunks: Hunk[];
}

function parseDiffPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  if (s === '/dev/null') return null;
  return s;
}

function parseDiffGit(line: string): { oldPath: string; newPath: string } | null {
  const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!m) return null;
  return { oldPath: m[1], newPath: m[2] };
}

function parseHunkHeader(line: string): number | null {
  const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function applyUnifiedHunks(doc: FileDoc, hunks: Hunk[], errPath: string, strict: boolean) {
  let d = 0;
  for (const hunk of hunks) {
    const O: { type: string; text: string }[] = [];
    const N: { type: string; text: string; oIndex?: number }[] = [];
    for (const item of hunk.items) {
      if (item.type === 'context' || item.type === 'old') {
        const oIdx = O.length;
        O.push(item);
        if (item.type === 'context') {
          N.push({ ...item, oIndex: oIdx });
        }
      } else if (item.type === 'new') {
        N.push(item);
      }
    }

    let lastContextOrNewHadBackslash = false;
    for (let idx = hunk.items.length - 1; idx >= 0; idx--) {
      const it = hunk.items[idx];
      if (it.type === 'context' || it.type === 'new') {
        lastContextOrNewHadBackslash = !!it.backslashAfter;
        break;
      }
    }

    if (O.length > 0) {
      const oLines = O.map((x) => x.text);
      const match = findOccurrences(doc.lines, oLines, strict);
      if (match.tier < 0 || match.occurrences.length === 0) {
        throw new Fail('no-match', errPath);
      }
      const target = hunk.A - 1 + d;
      let bestPos = match.occurrences[0];
      let bestDiff = Math.abs(bestPos - target);
      for (let k = 1; k < match.occurrences.length; k++) {
        const pos = match.occurrences[k];
        const diff = Math.abs(pos - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestPos = pos;
        }
      }
      const pos = bestPos;
      const tier = match.tier;
      const runsToEnd = pos + O.length === doc.lines.length;

      const F = leadingWS(doc.lines[pos]);
      const P = leadingWS(oLines[0]);
      const nLines: string[] = [];
      for (const item of N) {
        if (item.type === 'context') {
          nLines.push(doc.lines[pos + item.oIndex!]);
        } else {
          nLines.push(tier === 2 ? reindent(item.text, F, P) : item.text);
        }
      }

      doc.lines.splice(pos, O.length, ...nLines);
      if (runsToEnd) {
        doc.hasFinalBreak = !lastContextOrNewHadBackslash;
      }
      d += N.length - O.length;
    } else {
      let insertIdx = hunk.A + d;
      if (insertIdx < 0) insertIdx = 0;
      if (insertIdx > doc.lines.length) insertIdx = doc.lines.length;
      const isAtEnd = insertIdx === doc.lines.length;

      const nLines = N.map((x) => x.text);
      doc.lines.splice(insertIdx, 0, ...nLines);
      if (isAtEnd) {
        doc.hasFinalBreak = !lastContextOrNewHadBackslash;
      }
      d += N.length;
    }
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;

  function endCurrentSection() {
    if (cur !== null) {
      sections.push(cur);
      cur = null;
      inHeader = false;
    }
  }

  while (i < lines.length) {
    const l = lines[i];
    const lineNum = i + 1;

    if (l.startsWith('diff --git')) {
      const dg = parseDiffGit(l);
      if (!dg) throw new Exit2(`error: parse ${lineNum}`);
      endCurrentSection();
      cur = {
        diffGitOld: dg.oldPath,
        diffGitNew: dg.newPath,
        oldPath: null,
        newPath: null,
        hasOldSpec: false,
        hasNewSpec: false,
        isCreation: false,
        isDeletion: false,
        hunks: [],
      };
      inHeader = true;
      i++;
      continue;
    }

    if (l.startsWith('--- ')) {
      const nextLine = lines[i + 1] ?? '';
      if (!nextLine.startsWith('+++ ')) {
        if (inHeader) {
          throw new Exit2(`error: parse ${lineNum + 1}`);
        }
        i++;
        continue;
      }
      if (!inHeader || cur === null) {
        endCurrentSection();
        cur = {
          diffGitOld: null,
          diffGitNew: null,
          oldPath: parseDiffPath(l),
          newPath: parseDiffPath(nextLine),
          hasOldSpec: true,
          hasNewSpec: true,
          isCreation: false,
          isDeletion: false,
          hunks: [],
        };
        inHeader = true;
      } else {
        cur.oldPath = parseDiffPath(l);
        cur.newPath = parseDiffPath(nextLine);
        cur.hasOldSpec = true;
        cur.hasNewSpec = true;
      }
      i += 2;
      continue;
    }

    if (l.startsWith('@@')) {
      if (cur === null) {
        throw new Exit2(`error: parse ${lineNum}`);
      }
      const A = parseHunkHeader(l);
      if (A === null) {
        throw new Exit2(`error: parse ${lineNum}`);
      }
      inHeader = false;
      i++;

      const rawBody: string[] = [];
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.startsWith('diff --git')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          rawBody.push(bl);
          i++;
        } else {
          break;
        }
      }

      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') {
        rawBody.pop();
        i--;
      }

      const items: HunkItem[] = [];
      for (const bl of rawBody) {
        if (bl.startsWith('\\')) {
          if (items.length > 0) items[items.length - 1].backslashAfter = true;
        } else if (bl.startsWith('+')) {
          items.push({ type: 'new', text: bl.slice(1) });
        } else if (bl.startsWith('-')) {
          items.push({ type: 'old', text: bl.slice(1) });
        } else if (bl.startsWith(' ')) {
          items.push({ type: 'context', text: bl.slice(1) });
        } else if (bl === '') {
          items.push({ type: 'context', text: '' });
        }
      }
      cur.hunks.push({ A, items });
      continue;
    }

    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) {
        cur.oldPath = l.slice('rename from '.length).trim();
        cur.hasOldSpec = true;
      } else if (l.startsWith('rename to ')) {
        cur.newPath = l.slice('rename to '.length).trim();
        cur.hasNewSpec = true;
      } else if (l.startsWith('new file mode')) {
        cur.isCreation = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.isDeletion = true;
      }
      i++;
      continue;
    }

    i++;
  }

  endCurrentSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const s of sections) {
    let oldP: string | null = null;
    let newP: string | null = null;

    if (s.hasOldSpec) oldP = s.oldPath;
    else if (s.diffGitOld !== null) oldP = s.diffGitOld;

    if (s.hasNewSpec) newP = s.newPath;
    else if (s.diffGitNew !== null) newP = s.diffGitNew;

    const isCreation = s.isCreation || oldP === null;
    const isDeletion = s.isDeletion || newP === null;

    if (isCreation) {
      const p = newP!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plusLines: string[] = [];
        let lastHadBackslash = false;
        for (const hunk of s.hunks) {
          for (const it of hunk.items) {
            if (it.type === 'new') {
              plusLines.push(it.text);
              lastHadBackslash = !!it.backslashAfter;
            }
          }
        }
        const hasFinalBreak = !lastHadBackslash;
        tree.now.set(p, plusLines.length === 0 ? '' : plusLines.join('\n') + (hasFinalBreak ? '\n' : ''));
      });
    } else if (isDeletion) {
      const p = oldP!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (oldP !== newP) {
      const fromP = oldP!;
      const toP = newP!;
      edits.push((tree, moves) => {
        if (!safe(fromP)) throw new Fail('unsafe', fromP);
        if (!safe(toP)) throw new Fail('unsafe', toP);
        const content = tree.get(fromP);
        if (content === null) throw new Fail('missing', fromP);
        if (tree.get(toP) !== null) throw new Fail('exists', toP);
        const doc = parseFileDoc(content);
        applyUnifiedHunks(doc, s.hunks, fromP, strict);
        tree.now.set(toP, stringifyFileDoc(doc));
        tree.now.set(fromP, null);
        moves.push({ oldPath: fromP, newPath: toP });
      });
    } else {
      const p = oldP!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const content = tree.get(p);
        if (content === null) throw new Fail('missing', p);
        const doc = parseFileDoc(content);
        applyUnifiedHunks(doc, s.hunks, p, strict);
        tree.now.set(p, stringifyFileDoc(doc));
      });
    }
  }
  return edits;
}

// --- Section 8: V4A patches ---

interface V4AChunk {
  anchor: string | null;
  items: HunkItem[];
  isEndOfFile: boolean;
}

interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0) throw new Exit2('error: parse 1');
  if (lines[firstNonBlank].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNonBlank + 1}`);

  let lastNonBlank = -1;
  for (let idx = lines.length - 1; idx >= 0; idx--) {
    if (!blank(lines[idx])) {
      lastNonBlank = idx;
      break;
    }
  }
  if (lines[lastNonBlank].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4ASection[] = [];
  let i = firstNonBlank + 1;

  while (i < lastNonBlank) {
    if (blank(lines[i])) {
      i++;
      continue;
    }
    const l = lines[i];
    const lineNum = i + 1;

    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const addLines: string[] = [];
      while (i < lastNonBlank) {
        const bl = lines[i];
        if (bl.startsWith('*** Add File: ') || bl.startsWith('*** Delete File: ') || bl.startsWith('*** Update File: ')) {
          break;
        }
        if (bl.startsWith('+')) {
          addLines.push(bl.slice(1));
          i++;
        } else if (bl === '') {
          let allBlank = true;
          for (let k = i; k < lastNonBlank; k++) {
            const rem = lines[k];
            if (rem.startsWith('*** Add File: ') || rem.startsWith('*** Delete File: ') || rem.startsWith('*** Update File: ')) break;
            if (!blank(rem)) {
              allBlank = false;
              break;
            }
          }
          if (allBlank) {
            while (i < lastNonBlank && blank(lines[i]) && !lines[i].startsWith('*** ')) i++;
            break;
          }
          addLines.push('');
          i++;
        } else if (blank(bl)) {
          let allBlank = true;
          for (let k = i; k < lastNonBlank; k++) {
            const rem = lines[k];
            if (rem.startsWith('*** Add File: ') || rem.startsWith('*** Delete File: ') || rem.startsWith('*** Update File: ')) break;
            if (!blank(rem)) {
              allBlank = false;
              break;
            }
          }
          if (allBlank) {
            while (i < lastNonBlank && blank(lines[i]) && !lines[i].startsWith('*** ')) i++;
            break;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') {
        addLines.pop();
      }
      sections.push({ type: 'add', path, moveTo: null, addLines, chunks: [] });
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < lastNonBlank && blank(lines[i])) i++;
      if (i < lastNonBlank && !lines[i].startsWith('*** Add File: ') && !lines[i].startsWith('*** Delete File: ') && !lines[i].startsWith('*** Update File: ')) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ type: 'delete', path, moveTo: null, addLines: [], chunks: [] });
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLineNum = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < lastNonBlank && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4AChunk[] = [];
      while (i < lastNonBlank) {
        if (blank(lines[i])) {
          let allBlank = true;
          for (let k = i; k < lastNonBlank; k++) {
            const rem = lines[k];
            if (rem.startsWith('*** Add File: ') || rem.startsWith('*** Delete File: ') || rem.startsWith('*** Update File: ')) break;
            if (!blank(rem)) {
              allBlank = false;
              break;
            }
          }
          if (allBlank) {
            while (i < lastNonBlank && blank(lines[i]) && !lines[i].startsWith('*** ')) i++;
            break;
          }
        }
        const curL = lines[i];
        if (curL.startsWith('*** Add File: ') || curL.startsWith('*** Delete File: ') || curL.startsWith('*** Update File: ')) {
          break;
        }

        let anchor: string | null = null;
        if (curL.startsWith('@@')) {
          const a = curL.slice(2).trim();
          anchor = a === '' ? null : a;
          i++;
        } else if (chunks.length > 0) {
          throw new Exit2(`error: parse ${i + 1}`);
        }

        const items: HunkItem[] = [];
        let isEndOfFile = false;
        while (i < lastNonBlank) {
          const bl = lines[i];
          if (bl.startsWith('*** Add File: ') || bl.startsWith('*** Delete File: ') || bl.startsWith('*** Update File: ')) {
            break;
          }
          if (bl.trim() === '*** End of File') {
            isEndOfFile = true;
            i++;
            break;
          }
          if (bl.startsWith('@@')) {
            break;
          }
          if (bl.startsWith('+')) {
            items.push({ type: 'new', text: bl.slice(1) });
            i++;
          } else if (bl.startsWith('-')) {
            items.push({ type: 'old', text: bl.slice(1) });
            i++;
          } else if (bl.startsWith(' ')) {
            items.push({ type: 'context', text: bl.slice(1) });
            i++;
          } else if (bl === '') {
            let allBlank = true;
            for (let k = i; k < lastNonBlank; k++) {
              const rem = lines[k];
              if (rem.startsWith('*** Add File: ') || rem.startsWith('*** Delete File: ') || rem.startsWith('*** Update File: ')) break;
              if (!blank(rem)) {
                allBlank = false;
                break;
              }
            }
            if (allBlank) {
              break;
            }
            items.push({ type: 'context', text: '' });
            i++;
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
        }
        chunks.push({ anchor, items, isEndOfFile });
      }

      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        if (!lastChunk.isEndOfFile) {
          while (lastChunk.items.length > 0 && lastChunk.items[lastChunk.items.length - 1].type === 'context' && lastChunk.items[lastChunk.items.length - 1].text === '') {
            lastChunk.items.pop();
          }
        }
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${updateLineNum}`);
      }
      sections.push({ type: 'update', path, moveTo, addLines: [], chunks });
    } else {
      throw new Exit2(`error: parse ${lineNum}`);
    }
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.type === 'add') {
      const p = s.path;
      const linesToAdd = s.addLines;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const content = linesToAdd.length === 0 ? '' : linesToAdd.join('\n') + '\n';
        tree.now.set(p, content);
      });
    } else if (s.type === 'delete') {
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (s.type === 'update') {
      const oldP = s.path;
      const moveP = s.moveTo;
      const chunks = s.chunks;
      edits.push((tree, moves) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (moveP !== null && !safe(moveP)) throw new Fail('unsafe', moveP);
        const content = tree.get(oldP);
        if (content === null) throw new Fail('missing', oldP);
        if (moveP !== null && tree.get(moveP) !== null) throw new Fail('exists', moveP);

        const doc = parseFileDoc(content);
        let cursor = 0;

        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const anchorIdx = findAnchor(doc.lines, cursor, chunk.anchor, strict);
            if (anchorIdx < 0) throw new Fail('no-match', oldP);
            cursor = anchorIdx + 1;
          }

          const O: { type: string; text: string }[] = [];
          const N: { type: string; text: string; oIndex?: number }[] = [];
          for (const item of chunk.items) {
            if (item.type === 'context' || item.type === 'old') {
              const oIdx = O.length;
              O.push(item);
              if (item.type === 'context') {
                N.push({ ...item, oIndex: oIdx });
              }
            } else if (item.type === 'new') {
              N.push(item);
            }
          }

          if (O.length > 0) {
            const oLines = O.map((x) => x.text);
            const tryTier = (tier: number) => {
              const occs = findOccurrencesAtTier(doc.lines, oLines, tier);
              for (const p of occs) {
                if (p >= cursor) {
                  if (chunk.isEndOfFile) {
                    if (p + O.length === doc.lines.length) return p;
                  } else {
                    return p;
                  }
                }
              }
              return -1;
            };

            let matchPos = tryTier(0);
            let matchTier = 0;
            if (matchPos < 0 && !strict) {
              matchPos = tryTier(1);
              matchTier = 1;
              if (matchPos < 0) {
                matchPos = tryTier(2);
                matchTier = 2;
              }
            }
            if (matchPos < 0) throw new Fail('no-match', oldP);

            const pos = matchPos;
            const tier = matchTier;
            const F = leadingWS(doc.lines[pos]);
            const P = leadingWS(oLines[0]);
            const nLines: string[] = [];
            for (const item of N) {
              if (item.type === 'context') {
                nLines.push(doc.lines[pos + item.oIndex!]);
              } else {
                nLines.push(tier === 2 ? reindent(item.text, F, P) : item.text);
              }
            }

            doc.lines.splice(pos, O.length, ...nLines);
            cursor = pos + nLines.length;
          } else {
            const insertIdx = chunk.isEndOfFile ? doc.lines.length : cursor;
            const nLines = N.map((x) => x.text);
            doc.lines.splice(insertIdx, 0, ...nLines);
            cursor = insertIdx + nLines.length;
          }
        }

        const finalContent = stringifyFileDoc(doc);
        if (moveP !== null) {
          tree.now.set(moveP, finalContent);
          tree.now.set(oldP, null);
          moves.push({ oldPath: oldP, newPath: moveP });
        } else {
          tree.now.set(oldP, finalContent);
        }
      });
    }
  }
  return edits;
}

// --- Runner and Main ---

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const moves: MoveRecord[] = [];
  const fails: Fail[] = [];

  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Determine state changes
  // A <path>, D <path>, M <path>, R <old> -> <new>
  const allPaths = new Set<string>();
  for (const p of tree.now.keys()) allPaths.add(p);

  // Successful moves replacement
  const validMoves: { oldPath: string; newPath: string }[] = [];
  const handledPaths = new Set<string>();

  for (const m of moves) {
    if (tree.original(m.oldPath) !== null && tree.get(m.oldPath) === null && tree.original(m.newPath) === null && tree.get(m.newPath) !== null) {
      validMoves.push(m);
      handledPaths.add(m.oldPath);
      handledPaths.add(m.newPath);
    }
  }

  interface Row {
    sortKey: string;
    line: string;
  }
  const rows: Row[] = [];

  for (const vm of validMoves) {
    rows.push({
      sortKey: vm.newPath,
      line: `R ${vm.oldPath} -> ${vm.newPath}`,
    });
  }

  for (const p of allPaths) {
    if (handledPaths.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && now !== null) {
      rows.push({ sortKey: p, line: `A ${p}` });
    } else if (was !== null && now === null) {
      rows.push({ sortKey: p, line: `D ${p}` });
    } else {
      rows.push({ sortKey: p, line: `M ${p}` });
    }
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')));

  if (!check) {
    for (const p of allPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  const outLines = rows.map((r) => r.line);
  return {
    code: 0,
    out: [...outLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
