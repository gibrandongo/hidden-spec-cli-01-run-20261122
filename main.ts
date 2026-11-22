import fs from 'node:fs';

// mend: one patch tool for every AI edit format.
// Implements SPEC.md v1: unified diffs, SEARCH/REPLACE blocks, V4A patches
// and JSON edits, with three-tier line matching and all-or-nothing writes.
// Plain JavaScript, Node 22 standard library only, fully deterministic.

function splitLines(text) {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const out = [];
  for (const p of parts) out.push(p.endsWith('\r') ? p.slice(0, -1) : p);
  return out;
}

function stripTrail(s) {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function isSafePath(p) {
  if (p === '') return false;
  if (p.charAt(0) === '/') return false;
  if (p.indexOf('\\') !== -1) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// ---- file line model (SPEC section 3) ----
function parseFile(text) {
  let eol = '\n';
  const idx = text.indexOf('\n');
  if (idx > 0 && text.charAt(idx - 1) === '\r') eol = '\r\n';
  let lines;
  if (text === '') {
    lines = [];
  } else {
    lines = text.split(eol);
    if (text.endsWith(eol)) lines.pop();
  }
  const ends = text !== '' && text.endsWith(eol);
  return { eol: eol, lines: lines, ends: ends };
}

function renderFile(f) {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.ends ? f.eol : '');
}

// ---- three-tier matching (SPEC section 5) ----
function lineEq(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function findOccurrences(lines, oldLines, tier, from) {
  const res = [];
  const start = from === undefined ? 0 : from;
  for (let i = start; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!lineEq(lines[i + j], oldLines[j], tier)) { ok = false; break; }
    }
    if (ok) res.push(i);
  }
  return res;
}

function matchTier(lines, oldLines, strict, from) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ: occ };
  }
  return null;
}

// Build the replacement lines for a chunk/hunk body.
// body: [{kind: 'ctx'|'old'|'new', text}]. Context lines are written as the
// file's own matched lines; other lines are re-indented at tier 2.
function buildNewLines(body, fileLines, pos, tier) {
  const oLines = [];
  for (const b of body) {
    if (b.kind !== 'new' && b.kind !== 'bs') oLines.push(b.text);
  }
  let fLead = '';
  let pLead = '';
  if (tier === 2 && oLines.length > 0) {
    fLead = leadWs(fileLines[pos]);
    pLead = leadWs(oLines[0]);
  }
  const out = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + oi]);
      oi++;
    } else if (b.kind === 'old') {
      oi++;
    } else if (b.kind === 'bs') {
      // a "\" line refers to the line before it; it writes nothing
    } else {
      let t = b.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.indexOf(pLead) === 0) {
        t = fLead + t.slice(pLead.length);
      }
      out.push(t);
    }
  }
  return out;
}

// ---- in-memory tree ----
function Tree() {
  this.cache = new Map();
}
Tree.prototype.get = function (p) {
  if (!this.cache.has(p)) {
    let st = null;
    try { st = fs.statSync(p); } catch (e) { st = null; }
    if (st && st.isFile()) {
      let text = '';
      try { text = fs.readFileSync(p, 'utf8'); } catch (e) { text = ''; }
      this.cache.set(p, { exists: true, dir: false, text: text, origExists: true, origText: text });
    } else if (st && st.isDirectory()) {
      this.cache.set(p, { exists: true, dir: true, text: '', origExists: true, origText: '' });
    } else {
      this.cache.set(p, { exists: false, dir: false, text: '', origExists: false, origText: '' });
    }
  }
  return this.cache.get(p);
};
Tree.prototype.set = function (p, text) {
  if (!this.cache.has(p)) this.get(p);
  const e = this.cache.get(p);
  e.exists = true;
  e.dir = false;
  e.text = text;
};
Tree.prototype.del = function (p) {
  if (!this.cache.has(p)) this.get(p);
  const e = this.cache.get(p);
  e.exists = false;
  e.dir = false;
  e.text = '';
};

function fail(code, path) {
  return { code: code, path: path };
}

// ---- CLI parsing (SPEC section 1) ----
function parseArgs(args) {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional = [];
  for (const a of args) {
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.charAt(0) === '-' && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (a.indexOf('--format=') === 0) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return null;
  return { format: format, check: check, strict: strict, patch: positional.length === 1 ? positional[0] : null };
}

// ---- format detection (SPEC section 4) ----
function detectFormat(lines) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const firstCh = lines[first].trimStart().charAt(0);
  if (firstCh === '[' || firstCh === '{') return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('diff --git ') === 0) return 'unified';
    if (lines[i].indexOf('--- ') === 0 && i + 1 < lines.length && lines[i + 1].indexOf('+++ ') === 0) return 'unified';
  }
  return null;
}

function parseErr(line) {
  const e = new Error('parse ' + line);
  e.parseLine = line;
  return e;
}

// ---- unified diffs (SPEC section 6) ----
function parseDiffPath(raw) {
  let p = raw.split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.indexOf('a/') === 0) p = p.slice(2);
  else if (p.indexOf('b/') === 0) p = p.slice(2);
  return p;
}

function parseUnified(lines) {
  const sections = [];
  let cur = null;
  let i = 0;
  const n = lines.length;
  function newSection(startLine) {
    const s = {
      startLine: startLine,
      pairOld: undefined, pairNew: undefined,
      renameOld: null, renameNew: null,
      diffOld: null, diffNew: null,
      newFile: false, delFile: false,
      hunks: []
    };
    sections.push(s);
    return s;
  }
  while (i < n) {
    const line = lines[i];
    if (line.indexOf('diff --git ') === 0) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (!m) throw parseErr(i + 1);
      cur = newSection(i + 1);
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      i++;
      continue;
    }
    if (line.indexOf('@@') === 0) {
      if (!cur) throw parseErr(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw parseErr(i + 1);
      const hunk = { a: parseInt(m[1], 10), c: parseInt(m[3], 10), body: [], line: i + 1 };
      cur.hunks.push(hunk);
      i++;
      while (i < n) {
        const bl = lines[i];
        if (bl.indexOf('diff --git ') === 0) break;
        if (bl.indexOf('--- ') === 0 && i + 1 < n && lines[i + 1].indexOf('+++ ') === 0) break;
        if (bl.indexOf('@@') === 0) break;
        if (bl === '' || bl.charAt(0) === ' ' || bl.charAt(0) === '-' || bl.charAt(0) === '+' || bl.charAt(0) === '\\') {
          hunk.body.push(bl);
          i++;
        } else {
          break;
        }
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      continue;
    }
    if (line.indexOf('--- ') === 0 && i + 1 < n && lines[i + 1].indexOf('+++ ') === 0) {
      if (cur && cur.hunks.length === 0 && cur.pairOld === undefined && cur.pairNew === undefined) {
        cur.pairOld = parseDiffPath(line.slice(4));
        cur.pairNew = parseDiffPath(lines[i + 1].slice(4));
        i += 2;
        continue;
      }
      cur = newSection(i + 1);
      cur.pairOld = parseDiffPath(line.slice(4));
      cur.pairNew = parseDiffPath(lines[i + 1].slice(4));
      i += 2;
      continue;
    }
    if (line.indexOf('--- ') === 0) {
      if (cur && cur.hunks.length === 0) throw parseErr(i + 2);
      i++;
      continue;
    }
    if (cur && cur.hunks.length === 0) {
      if (line.indexOf('+++ ') === 0) {
        cur.pairNew = parseDiffPath(line.slice(4));
      } else if (line.indexOf('rename from ') === 0) {
        cur.renameOld = line.slice('rename from '.length).trim();
      } else if (line.indexOf('rename to ') === 0) {
        cur.renameNew = line.slice('rename to '.length).trim();
      } else if (line.indexOf('new file mode') === 0) {
        cur.newFile = true;
      } else if (line.indexOf('deleted file mode') === 0) {
        cur.delFile = true;
      }
    }
    i++;
  }
  if (sections.length === 0) throw parseErr(1);
  return sections;
}

// Parse a hunk body into entries and the no-newline marker.
function parseHunkBody(raw) {
  const body = [];
  for (const bl of raw) {
    if (bl === '') body.push({ kind: 'ctx', text: '' });
    else if (bl.charAt(0) === ' ') body.push({ kind: 'ctx', text: bl.slice(1) });
    else if (bl.charAt(0) === '-') body.push({ kind: 'old', text: bl.slice(1) });
    else if (bl.charAt(0) === '+') body.push({ kind: 'new', text: bl.slice(1) });
    else if (bl.charAt(0) === '\\') body.push({ kind: 'bs', text: bl });
  }
  let noEol = false;
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j].kind === 'ctx' || body[j].kind === 'new') {
      noEol = j + 1 < body.length && body[j + 1].kind === 'bs';
      break;
    }
  }
  return { body: body, noEol: noEol };
}

function applyHunks(f, hunks, strict, path) {
  let lines = f.lines.slice();
  let ends = f.ends;
  let d = 0;
  for (const h of hunks) {
    const parsed = parseHunkBody(h.body);
    const body = parsed.body;
    const oLines = [];
    for (const b of body) {
      if (b.kind !== 'new' && b.kind !== 'bs') oLines.push(b.text);
    }
    if (oLines.length === 0) {
      const nLines = [];
      for (const b of body) {
        if (b.kind === 'new') nLines.push(b.text);
      }
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      if (pos === lines.length) ends = !parsed.noEol;
      lines.splice.apply(lines, [pos, 0].concat(nLines));
      d += nLines.length;
    } else {
      const m = matchTier(lines, oLines, strict);
      if (!m) return fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of m.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const pos = best;
      const nLines = buildNewLines(body, lines, pos, m.tier);
      if (pos + oLines.length === lines.length) ends = !parsed.noEol;
      lines.splice.apply(lines, [pos, oLines.length].concat(nLines));
      d += nLines.length - oLines.length;
    }
  }
  return { file: { eol: f.eol, lines: lines, ends: ends } };
}

function applyUnifiedSection(sec, tree, strict, moves) {
  let oldPath = sec.pairOld !== undefined ? sec.pairOld : (sec.renameOld !== null ? sec.renameOld : sec.diffOld);
  let newPath = sec.pairNew !== undefined ? sec.pairNew : (sec.renameNew !== null ? sec.renameNew : sec.diffNew);
  if (oldPath === undefined || oldPath === null) {
    if (newPath === undefined || newPath === null) throw parseErr(sec.startLine);
    oldPath = newPath;
  }
  if (newPath === undefined || newPath === null) {
    newPath = oldPath;
  }
  const isCreate = sec.pairOld === null || sec.newFile;
  const isDelete = !isCreate && (sec.pairNew === null || sec.delFile);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  const toCheck = [oldPath];
  if (newPath !== oldPath) toCheck.push(newPath);
  for (const p of toCheck) {
    if (!isSafePath(p)) return fail('unsafe', p);
  }
  if (isCreate) {
    if (tree.get(newPath).exists) return fail('exists', newPath);
    const plusLines = [];
    let noEol = false;
    for (const h of sec.hunks) {
      for (let j = 0; j < h.body.length; j++) {
        const bl = h.body[j];
        if (bl.charAt(0) === '+') {
          plusLines.push(bl.slice(1));
          noEol = j + 1 < h.body.length && h.body[j + 1].charAt(0) === '\\';
        }
      }
    }
    const text = plusLines.length === 0 ? '' : plusLines.join('\n') + (noEol ? '' : '\n');
    tree.set(newPath, text);
    return null;
  }
  if (isDelete) {
    if (!tree.get(oldPath).exists) return fail('missing', oldPath);
    tree.del(oldPath);
    return null;
  }
  if (isMove) {
    if (!tree.get(oldPath).exists) return fail('missing', oldPath);
    if (tree.get(newPath).exists) return fail('exists', newPath);
    const f = parseFile(tree.get(oldPath).text);
    const res = applyHunks(f, sec.hunks, strict, oldPath);
    if (res.code) return res;
    tree.del(oldPath);
    tree.set(newPath, renderFile(res.file));
    moves.push({ old: oldPath, new: newPath });
    return null;
  }
  if (!tree.get(oldPath).exists) return fail('missing', oldPath);
  const f = parseFile(tree.get(oldPath).text);
  const res = applyHunks(f, sec.hunks, strict, oldPath);
  if (res.code) return res;
  tree.set(oldPath, renderFile(res.file));
  return null;
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----
function parseSearchReplace(lines) {
  const blocks = [];
  let i = 0;
  const n = lines.length;
  let prevEnd = -1;
  let prevPath = null;
  while (i < n) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let p = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const cand = lines[j];
        if (cand.trim() === '') continue;
        if (cand.trimStart().indexOf('```') === 0) continue;
        p = cand.trim();
        break;
      }
      if (p === null) {
        if (prevPath === null) throw parseErr(searchLine);
        p = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < n; j++) {
        if (lines[j].trimEnd() === '=======') { eq = j; break; }
      }
      if (eq === -1) throw parseErr(searchLine);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      }
      if (rep === -1) throw parseErr(searchLine);
      blocks.push({ path: p, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = p;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw parseErr(1);
  return blocks;
}

function applySearchReplaceBlock(b, tree, strict) {
  if (!isSafePath(b.path)) return fail('unsafe', b.path);
  if (b.oldLines.length === 0) {
    if (tree.get(b.path).exists) return fail('exists', b.path);
    const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
    tree.set(b.path, text);
    return null;
  }
  const ent = tree.get(b.path);
  if (!ent.exists) return fail('missing', b.path);
  const f = parseFile(ent.text);
  const m = matchTier(f.lines, b.oldLines, strict);
  if (!m) return fail('no-match', b.path);
  if (m.occ.length > 1) return fail('ambiguous', b.path);
  const pos = m.occ[0];
  const body = [];
  for (const t of b.oldLines) body.push({ kind: 'old', text: t });
  for (const t of b.newLines) body.push({ kind: 'new', text: t });
  const nLines = buildNewLines(body, f.lines, pos, m.tier);
  const lines = f.lines.slice();
  lines.splice.apply(lines, [pos, b.oldLines.length].concat(nLines));
  tree.set(b.path, renderFile({ eol: f.eol, lines: lines, ends: f.ends }));
  return null;
}

// ---- V4A patches (SPEC section 8) ----
function parseV4a(lines) {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first === -1) throw parseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw parseErr(first + 1);
  for (let i = n - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { last = i; break; }
  }
  if (lines[last].trim() !== '*** End Patch') throw parseErr(n + 1);
  const sections = [];
  let cur = null;
  function endSection() {
    if (!cur) return;
    if (cur.kind === 'add') {
      while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    } else if (cur.kind === 'update') {
      if (cur.chunks.length === 0 && cur.moveTo === null) throw parseErr(cur.line);
      const ch = cur.chunks[cur.chunks.length - 1];
      if (ch) {
        while (ch.body.length > 0 && ch.body[ch.body.length - 1].kind === 'ctx' && ch.body[ch.body.length - 1].text === '') ch.body.pop();
      }
    }
    sections.push(cur);
    cur = null;
  }
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      if (cur && cur.kind === 'add') cur.lines.push('');
      else if (cur && cur.kind === 'update' && cur.openChunk) cur.openChunk.body.push({ kind: 'ctx', text: '' });
      i++;
      continue;
    }
    if (line.indexOf('*** Add File:') === 0 || line.indexOf('*** Delete File:') === 0 || line.indexOf('*** Update File:') === 0) {
      endSection();
      const kind = line.indexOf('*** Add File:') === 0 ? 'add' : (line.indexOf('*** Delete File:') === 0 ? 'delete' : 'update');
      const p = line.slice(line.indexOf(':') + 1).trim();
      cur = { kind: kind, path: p, line: i + 1, lines: [], moveTo: null, chunks: [], openChunk: null };
      i++;
      continue;
    }
    if (!cur) throw parseErr(i + 1);
    if (cur.kind === 'add') {
      if (line.charAt(0) === '+') cur.lines.push(line.slice(1));
      else throw parseErr(i + 1);
      i++;
      continue;
    }
    if (cur.kind === 'delete') {
      throw parseErr(i + 1);
    }
    if (line.indexOf('*** Move to:') === 0) {
      if (cur.chunks.length === 0 && cur.openChunk === null && cur.moveTo === null) {
        cur.moveTo = line.slice(line.indexOf(':') + 1).trim();
        i++;
        continue;
      }
      throw parseErr(i + 1);
    }
    if (line === '*** End of File') {
      if (!cur.openChunk) throw parseErr(i + 1);
      cur.openChunk.eof = true;
      cur.openChunk = null;
      i++;
      continue;
    }
    if (line.indexOf('@@') === 0) {
      const ch = { anchor: line.slice(2).trim(), body: [], eof: false, line: i + 1 };
      cur.chunks.push(ch);
      cur.openChunk = ch;
      i++;
      continue;
    }
    if (line.charAt(0) === ' ' || line.charAt(0) === '-' || line.charAt(0) === '+') {
      if (!cur.openChunk) {
        if (cur.chunks.length === 0) {
          const ch = { anchor: '', body: [], eof: false, line: i + 1 };
          cur.chunks.push(ch);
          cur.openChunk = ch;
        } else {
          throw parseErr(i + 1);
        }
      }
      const kind = line.charAt(0) === ' ' ? 'ctx' : (line.charAt(0) === '-' ? 'old' : 'new');
      cur.openChunk.body.push({ kind: kind, text: line.slice(1) });
      i++;
      continue;
    }
    throw parseErr(i + 1);
  }
  endSection();
  if (sections.length === 0) throw parseErr(1);
  return sections;
}

function applyV4aSection(sec, tree, strict, moves) {
  if (!isSafePath(sec.path)) return fail('unsafe', sec.path);
  if (sec.kind === 'add') {
    if (tree.get(sec.path).exists) return fail('exists', sec.path);
    const text = sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n';
    tree.set(sec.path, text);
    return null;
  }
  if (sec.kind === 'delete') {
    if (!tree.get(sec.path).exists) return fail('missing', sec.path);
    tree.del(sec.path);
    return null;
  }
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return fail('unsafe', sec.moveTo);
  const ent = tree.get(sec.path);
  if (!ent.exists) return fail('missing', sec.path);
  if (sec.moveTo !== null && tree.get(sec.moveTo).exists) return fail('exists', sec.moveTo);
  const f = parseFile(ent.text);
  let lines = f.lines.slice();
  let cursor = 0;
  for (const ch of sec.chunks) {
    if (ch.anchor !== '') {
      let found = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        if (found !== -1) break;
        for (let j = cursor; j < lines.length; j++) {
          if (lineEq(lines[j], ch.anchor, t)) { found = j; break; }
        }
      }
      if (found === -1) return fail('no-match', sec.path);
      cursor = found + 1;
    }
    const oLines = [];
    for (const b of ch.body) {
      if (b.kind !== 'new') oLines.push(b.text);
    }
    if (oLines.length === 0) {
      const nLines = [];
      for (const b of ch.body) {
        if (b.kind === 'new') nLines.push(b.text);
      }
      const pos = ch.eof ? lines.length : cursor;
      lines.splice.apply(lines, [pos, 0].concat(nLines));
      cursor = pos + nLines.length;
    } else {
      const m = matchTier(lines, oLines, strict, cursor);
      if (!m) return fail('no-match', sec.path);
      let pos;
      if (ch.eof) {
        let okPos = -1;
        for (const p of m.occ) {
          if (p + oLines.length === lines.length) { okPos = p; break; }
        }
        if (okPos === -1) return fail('no-match', sec.path);
        pos = okPos;
      } else {
        pos = m.occ[0];
      }
      const nLines = buildNewLines(ch.body, lines, pos, m.tier);
      lines.splice.apply(lines, [pos, oLines.length].concat(nLines));
      cursor = pos + nLines.length;
    }
  }
  const out = renderFile({ eol: f.eol, lines: lines, ends: f.ends });
  if (sec.moveTo !== null) {
    tree.del(sec.path);
    tree.set(sec.moveTo, out);
    moves.push({ old: sec.path, new: sec.moveTo });
  } else {
    tree.set(sec.path, out);
  }
  return null;
}

// ---- JSON edits (SPEC section 9) ----
function validateJsonEdit(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    let newStr = o.new_str;
    if (newStr === undefined) newStr = '';
    if (typeof newStr !== 'string') return null;
    return { command: 'str_replace', path: o.path, old_str: o.old_str, new_str: newStr };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { command: 'insert', path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function parseJson(lines, patchText) {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') { first = i; break; }
  }
  if (first === -1) throw parseErr(1);
  const edits = [];
  if (lines[first].trimStart().charAt(0) === '[') {
    let arr;
    try { arr = JSON.parse(patchText); } catch (e) { throw parseErr(first + 1); }
    if (!Array.isArray(arr)) throw parseErr(first + 1);
    for (const el of arr) {
      const ed = validateJsonEdit(el);
      if (!ed) throw parseErr(first + 1);
      edits.push(ed);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      let obj;
      try { obj = JSON.parse(l); } catch (e) { throw parseErr(i + 1); }
      const ed = validateJsonEdit(obj);
      if (!ed) throw parseErr(i + 1);
      edits.push(ed);
    }
  }
  if (edits.length === 0) throw parseErr(1);
  return edits;
}

function applyJsonEdit(ed, tree) {
  if (!isSafePath(ed.path)) return fail('unsafe', ed.path);
  if (ed.command === 'create') {
    if (tree.get(ed.path).exists) return fail('exists', ed.path);
    tree.set(ed.path, ed.file_text);
    return null;
  }
  const ent = tree.get(ed.path);
  if (!ent.exists) return fail('missing', ed.path);
  if (ed.command === 'str_replace') {
    const f = parseFile(ent.text);
    const isCrlf = f.eol === '\r\n';
    let text = ent.text;
    let oldStr = ed.old_str;
    let newStr = ed.new_str;
    if (isCrlf) {
      text = text.split('\r\n').join('\n');
      oldStr = oldStr.split('\r\n').join('\n');
      newStr = newStr.split('\r\n').join('\n');
    }
    let count = 0;
    let firstIdx = -1;
    let idx = 0;
    while (true) {
      const p = text.indexOf(oldStr, idx);
      if (p === -1) break;
      count++;
      if (firstIdx === -1) firstIdx = p;
      idx = p + 1;
    }
    if (count === 0) return fail('no-match', ed.path);
    if (count > 1) return fail('ambiguous', ed.path);
    let out = text.slice(0, firstIdx) + newStr + text.slice(firstIdx + oldStr.length);
    if (isCrlf) out = out.split('\n').join('\r\n');
    tree.set(ed.path, out);
    return null;
  }
  const f = parseFile(ent.text);
  if (ed.insert_line < 0 || ed.insert_line > f.lines.length) return fail('no-match', ed.path);
  const ins = splitLines(ed.new_str);
  const lines = f.lines.slice();
  lines.splice.apply(lines, [ed.insert_line, 0].concat(ins));
  tree.set(ed.path, renderFile({ eol: f.eol, lines: lines, ends: f.ends }));
  return null;
}

// ---- main run ----
function runCli() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    process.stdout.write('error: usage\n');
    process.exitCode = 2;
    return;
  }
  let patchText;
  if (parsed.patch === null || parsed.patch === '-') {
    patchText = fs.readFileSync(0, 'utf8');
  } else {
    try {
      patchText = fs.readFileSync(parsed.patch, 'utf8');
    } catch (e) {
      process.stdout.write('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }
  const lines = splitLines(patchText);
  let format = parsed.format;
  if (format === 'auto') {
    const det = detectFormat(lines);
    if (det === null) {
      process.stdout.write('error: format\n');
      process.exitCode = 2;
      return;
    }
    format = det;
  }
  let edits;
  try {
    if (format === 'unified') {
      edits = parseUnified(lines).map((s) => ({ kind: 'unified', sec: s }));
    } else if (format === 'search-replace') {
      edits = parseSearchReplace(lines).map((b) => ({ kind: 'sr', block: b }));
    } else if (format === 'v4a') {
      edits = parseV4a(lines).map((s) => ({ kind: 'v4a', sec: s }));
    } else {
      edits = parseJson(lines, patchText).map((e) => ({ kind: 'json', edit: e }));
    }
  } catch (e) {
    if (e && typeof e.parseLine === 'number') {
      process.stdout.write('error: parse ' + e.parseLine + '\n');
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const tree = new Tree();
  const moves = [];
  const failures = [];
  for (const ed of edits) {
    let res = null;
    if (ed.kind === 'unified') res = applyUnifiedSection(ed.sec, tree, parsed.strict, moves);
    else if (ed.kind === 'sr') res = applySearchReplaceBlock(ed.block, tree, parsed.strict);
    else if (ed.kind === 'v4a') res = applyV4aSection(ed.sec, tree, parsed.strict, moves);
    else res = applyJsonEdit(ed.edit, tree);
    if (res !== null) failures.push(res);
  }
  if (failures.length > 0) {
    let out = '';
    for (const fl of failures) out += 'error: ' + fl.code + ' ' + fl.path + '\n';
    out += 'failed: ' + failures.length + ' of ' + edits.length + ' edits\n';
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }
  const changes = [];
  for (const entry of tree.cache) {
    const p = entry[0];
    const e = entry[1];
    const changed = e.origExists !== e.exists || (e.exists && e.origText !== e.text);
    if (!changed) continue;
    if (e.origExists && !e.exists) changes.push({ sort: p, line: 'D ' + p, kind: 'D', path: p });
    else if (!e.origExists && e.exists) changes.push({ sort: p, line: 'A ' + p, kind: 'A', path: p });
    else changes.push({ sort: p, line: 'M ' + p, kind: 'M', path: p });
  }
  for (const mv of moves) {
    const oldEnt = tree.cache.get(mv.old);
    const newEnt = tree.cache.get(mv.new);
    if (oldEnt && newEnt && oldEnt.origExists && !oldEnt.exists && !newEnt.origExists && newEnt.exists) {
      for (let ci = changes.length - 1; ci >= 0; ci--) {
        if ((changes[ci].kind === 'D' && changes[ci].path === mv.old) || (changes[ci].kind === 'A' && changes[ci].path === mv.new)) {
          changes.splice(ci, 1);
        }
      }
      changes.push({ sort: mv.new, line: 'R ' + mv.old + ' -> ' + mv.new, kind: 'R', path: mv.new });
    }
  }
  changes.sort((a, b) => Buffer.compare(Buffer.from(a.sort, 'utf8'), Buffer.from(b.sort, 'utf8')));
  let out = '';
  for (const c of changes) out += c.line + '\n';
  out += changes.length === 1 ? 'ok: 1 file\n' : 'ok: ' + changes.length + ' files\n';
  if (!parsed.check) {
    const dels = [];
    const writes = [];
    for (const entry of tree.cache) {
      const p = entry[0];
      const e = entry[1];
      const changed = e.origExists !== e.exists || (e.exists && e.origText !== e.text);
      if (!changed) continue;
      if (e.origExists && !e.exists) dels.push(p);
      else if (e.exists) writes.push(p);
    }
    for (const p of dels) {
      try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
    }
    for (const p of writes) {
      const e = tree.cache.get(p);
      const dir = p.split('/').slice(0, -1).join('/');
      if (dir !== '') {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { /* exists */ }
      }
      fs.writeFileSync(p, e.text, 'utf8');
    }
  }
  process.stdout.write(out);
  process.exitCode = 0;
}

// Trial handover: when the trial env is present, hand over to the kit's
// runner; otherwise run the CLI.
if (process.env.MAKEFUN_ENV_URL) {
  const runner = await import('./runner.ts');
  await runner.runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  runCli();
}
