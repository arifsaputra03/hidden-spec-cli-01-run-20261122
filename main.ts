// mend: one command-line tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a
// tree of text files, exactly as SPEC.md says. Node 22, standard library only.
// Run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are.

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

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 * and none of its /-separated segments is empty, . or .. (section 3). */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file as lines: its own line break, its lines, and whether it ends with one. */
interface FileState {
  br: '\n' | '\r\n';
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
}

/** A line normalised for one matching tier (section 5). */
function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where o occurs in lines at one tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(lines[i + j]!, tier) !== norm(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which o occurs. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first tier at which o occurs at or after `from`, with those positions. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: its text, and the index in O of the context line it is, or null. */
interface NLine {
  text: string;
  contextOf: number | null;
}

/**
 * Replace lines[pos .. pos + oLen) with N. Context lines of N are written as
 * the file's own matched lines; at tier 2 every other line of N is re-indented
 * from O's first line's leading whitespace to the file's first matched line's.
 */
function spliceLines(st: FileState, pos: number, oLen: number, n: NLine[], tier: number, o: string[]): FileState {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWS(st.lines[pos] ?? '');
    p = leadingWS(o[0]!);
  }
  const rep: string[] = n.map((nl) => {
    if (nl.contextOf !== null) return st.lines[pos + nl.contextOf]!;
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    return t;
  });
  return { br: st.br, lines: [...st.lines.slice(0, pos), ...rep, ...st.lines.slice(pos + oLen)], finalBreak: st.finalBreak };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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
  registerMove(oldPath: string, newPath: string): void {
    this.moves.push([oldPath, newPath]);
  }
}

type Edit = (tree: Tree) => void;

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      const st = splitFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      const lines = [...st.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ br: st.br, lines, finalBreak: st.finalBreak }));
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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  /** a \ line follows the hunk's last context or + line */
  lastNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  kind: 'create' | 'delete' | 'move' | 'change';
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

/** O (context and - lines) and N (context and + lines) of a hunk body. */
function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      n.push({ text: b.text, contextOf: o.length });
      o.push(b.text);
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, contextOf: null });
    }
  }
  return { o, n };
}

function finishHunk(body: BodyLine[], a: number): Hunk {
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  let lastNoEol = false;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') {
      lastNoEol = body[i + 1] !== undefined && body[i + 1]!.kind === '\\';
      break;
    }
  }
  return { a, body, lastNoEol };
}

/** Apply a section's hunks in order to a file state. */
function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let d = 0;
  let cur = st;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const atEnd = at === cur.lines.length;
      cur = spliceLines(cur, at, 0, n, 0, o);
      if (atEnd) cur.finalBreak = !h.lastNoEol;
      d += n.length;
      continue;
    }
    const found = findTier(cur.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.occ) {
      const dd = Math.abs(p - target);
      if (dd < best) {
        best = dd;
        pos = p;
      }
    }
    const runsToEnd = pos + o.length === cur.lines.length;
    cur = spliceLines(cur, pos, o.length, n, found.tier, o);
    if (runsToEnd) cur.finalBreak = !h.lastNoEol;
    d += n.length - o.length;
  }
  return cur;
}

/** The path after `--- ` or `+++ ` (section 6): up to the first tab, trimmed. */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  return raw.replace(/^[ab]\//, '');
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  // A section under construction: its header facts and its hunks so far.
  let cur: {
    diffOld: string | null;
    diffNew: string | null;
    renameOld: string | null;
    renameNew: string | null;
    dashOld: string | null;
    dashNew: string | null;
    dashSet: boolean;
    create: boolean;
    del: boolean;
    hunks: Hunk[];
  } | null = null;
  let body: BodyLine[] | null = null;
  let bodyA = 0;

  const closeBody = (): void => {
    if (body !== null && cur !== null) {
      cur.hunks.push(finishHunk(body, bodyA));
      body = null;
    }
  };
  const closeSection = (): void => {
    closeBody();
    if (cur === null) return;
    const oldPath = cur.dashOld ?? cur.renameOld ?? cur.diffOld;
    const newPath = cur.dashNew ?? cur.renameNew ?? cur.diffNew;
    let kind: Section['kind'];
    if (cur.create || oldPath === null) kind = 'create';
    else if (cur.del || newPath === null) kind = 'delete';
    else if (oldPath !== newPath) kind = 'move';
    else kind = 'change';
    sections.push({ oldPath, newPath, kind, hunks: cur.hunks });
    cur = null;
  };
  const startSection = (diffOld: string | null, diffNew: string | null): void => {
    closeSection();
    cur = { diffOld, diffNew, renameOld: null, renameNew: null, dashOld: null, dashNew: null, dashSet: false, create: false, del: false, hunks: [] };
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (body !== null) {
      // Inside a hunk body. The body ends at a diff --git line, at a --- line
      // followed by a +++ line, or at the first other line. (A --- line
      // starts with -, so it must be tested before the old-line rule below.)
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        closeBody();
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        const kind = l === '' ? ' ' : (l[0] as ' ' | '-' | '+' | '\\');
        body.push({ kind, text: l === '' ? '' : l.slice(1), raw: l });
        i += 1;
        continue;
      }
      // The body ends here; re-process this line outside the body.
      closeBody();
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = dashPath(l);
      const newP = dashPath(lines[i + 1]!);
      if (cur === null || cur.hunks.length > 0) {
        // A pair after a section's hunks starts a new section; a pair in a
        // section's header (no hunk yet) names that section's paths.
        startSection(null, null);
        cur!.dashOld = oldP;
        cur!.dashNew = newP;
        cur!.dashSet = true;
      } else if (!cur.dashSet) {
        cur.dashOld = oldP;
        cur.dashNew = newP;
        cur.dashSet = true;
      }
      // A second pair in the same header is already part of it: ignored.
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      body = [];
      bodyA = Number(m[1]);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Inside a section's header (before its first hunk).
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: and any other line are ignored.
    }
    // After a section's hunks, or outside a section: ignored (prose, code fences).
    i += 1;
  }
  closeSection();
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'create') {
      const p = sec.newPath;
      if (p === null) return; // both paths /dev/null: nothing to create
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const created: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j += 1) {
          const b = h.body[j]!;
          if (b.kind === '+') {
            created.push(b.text);
            lastPlus = { hunk: h, idx: j };
          }
        }
      }
      let finalBreak = true;
      if (lastPlus !== null) {
        const next = lastPlus.hunk.body[lastPlus.idx + 1];
        if (next !== undefined && next.kind === '\\') finalBreak = false;
      }
      tree.now.set(p, created.length === 0 ? '' : created.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    if (sec.kind === 'delete') {
      const p = sec.oldPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.kind === 'move') {
      const oldP = sec.oldPath!;
      const newP = sec.newPath!;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = joinFile(applyHunks(splitFile(text), sec.hunks, strict, oldP));
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.registerMove(oldP, newP);
      return;
    }
    const p = sec.oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, joinFile(applyHunks(splitFile(text), sec.hunks, strict, p)));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = splitFile(text);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n = newLines.map((t) => ({ text: t, contextOf: null }));
    tree.now.set(path, joinFile(spliceLines(st, pos, oldLines.length, n, found.tier, oldLines)));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trimStart().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(makeSearchReplaceEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const isAdd = l.startsWith('*** Add File: ');
      const isDel = l.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDel ? '*** Delete File: ' : '*** Update File: ';
      const path = l.slice(prefix.length).trim();
      const headerLine = i + 1;
      // Collect this section's lines: until the next section start or End Patch.
      const secLines: { text: string; num: number }[] = [];
      i += 1;
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ')) break;
        secLines.push({ text: s, num: i + 1 });
        i += 1;
      }
      // Blank lines at the end of a section are not part of it.
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
      if (isAdd) {
        for (const sl of secLines) {
          if (!(sl.text.startsWith('+') || sl.text === '')) throw new Exit2(`error: parse ${sl.num}`);
        }
        const fileLines = secLines.map((sl) => (sl.text === '' ? '' : sl.text.slice(1)));
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
        });
      } else if (isDel) {
        for (const sl of secLines) throw new Exit2(`error: parse ${sl.num}`);
        edits.push((tree) => {
          if (!safe(path)) throw new Fail('unsafe', path);
          if (tree.get(path) === null) throw new Fail('missing', path);
          tree.now.set(path, null);
        });
      } else {
        edits.push(v4aUpdateEdit(path, secLines, headerLine, strict));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, secLines: { text: string; num: number }[], headerLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let start = 0;
  if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.text.slice('*** Move to: '.length).trim();
    start = 1;
  }
  const chunks: V4aChunk[] = [];
  let idx = start;
  let firstChunk = true;
  while (idx < secLines.length) {
    const l = secLines[idx]!;
    let anchor: string | null;
    if (l.text.startsWith('@@')) {
      anchor = l.text.slice(2).trim();
      if (anchor === '') anchor = null;
      idx += 1;
    } else if (firstChunk && (l.text === '' || l.text[0] === ' ' || l.text[0] === '-' || l.text[0] === '+')) {
      anchor = null;
    } else {
      throw new Exit2(`error: parse ${l.num}`);
    }
    const body: BodyLine[] = [];
    let eof = false;
    while (idx < secLines.length) {
      const b = secLines[idx]!;
      if (b.text.startsWith('@@')) break;
      if (b.text.trim() === '*** End of File') {
        eof = true;
        idx += 1;
        break;
      }
      if (b.text === '' || b.text[0] === ' ' || b.text[0] === '-' || b.text[0] === '+') {
        body.push({ kind: b.text === '' ? ' ' : (b.text[0] as ' ' | '-' | '+'), text: b.text === '' ? '' : b.text.slice(1), raw: b.text });
        idx += 1;
        continue;
      }
      throw new Exit2(`error: parse ${b.num}`);
    }
    chunks.push({ anchor, eof, body });
    firstChunk = false;
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let st = splitFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTierFrom(st.lines, [chunk.anchor], cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const b of chunk.body) {
        if (b.kind === ' ') {
          n.push({ text: b.text, contextOf: o.length });
          o.push(b.text);
        } else if (b.kind === '-') {
          o.push(b.text);
        } else if (b.kind === '+') {
          n.push({ text: b.text, contextOf: null });
        }
      }
      if (o.length === 0) {
        const at = chunk.eof ? st.lines.length : cursor;
        st = spliceLines(st, at, 0, n, 0, o);
        cursor = at + n.length;
        continue;
      }
      const found = findTierFrom(st.lines, o, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      let pos = found.occ[0]!;
      if (chunk.eof) {
        const endPos = found.occ.filter((p) => p + o.length === st.lines.length);
        if (endPos.length === 0) throw new Fail('no-match', path);
        pos = endPos[0]!;
      }
      st = spliceLines(st, pos, o.length, n, found.tier, o);
      cursor = pos + n.length;
    }
    const out = joinFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.registerMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Format detection, the run, and the trial hand-over                  */
/* ------------------------------------------------------------------ */

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Rows for the paths whose state changed, in byte order of the paths (a
  // move's R line sorts by its new path and replaces that pair's D and A).
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.now.get(oldP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null && !consumed.has(oldP) && !consumed.has(newP)) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
