/* Edivora — Word (.docx) files: reading into editable HTML and writing back.
 *
 * The editor works on plain HTML: <p> paragraphs with inline CSS for direct formatting, data-ps for the
 * paragraph style, spans for runs, <table> for tables and <img> for pictures. Everything the editor does
 * not understand (paragraph borders, tabs, section settings, table look, fields in headers…) is kept as the
 * original XML and written back untouched, and the original package (styles, numbering, headers, footers,
 * theme, fonts) is reused when saving. Units: 1 CSS px on the page = 1 pt.
 */
'use strict';
(function () {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const REL_IMG = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
  const REL_LINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
  const REL_NUM = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
  const REL_FOOTER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';

  /** "single" line height of each bundled family, as a multiple of the font size (hhea metrics) */
  const LINE = { arimo: 1.15, carlito: 1.2207, tinos: 1.15, caladea: 1.15, cousine: 1.1328, roboto: 1.1719, 'open-sans': 1.3618, lato: 1.2, montserrat: 1.219, poppins: 1.5 };
  /** name written into the .docx for each bundled family */
  const WORD_NAME = { arimo: 'Arial', carlito: 'Calibri', tinos: 'Times New Roman', caladea: 'Cambria', cousine: 'Courier New', roboto: 'Roboto', 'open-sans': 'Open Sans', lato: 'Lato', montserrat: 'Montserrat', poppins: 'Poppins' };
  const HIGHLIGHT = {
    yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080',
    darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
  };
  const PUA = { '': '•', '': '▪', '': '□', '': '➢', '': '❖', '': '✓', '': '➔', '': '■', '': '○', '': '□', '': '▸', '': '◊' };
  const famOf = (name) => PE.fonts.mapPdfFont(name || '').f;
  const lineOf = (fam) => LINE[fam] || 1.15;

  /* ---------- XML helpers ---------- */
  const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const ser = (el) => new XMLSerializer().serializeToString(el);
  const kids = (el, name) => (el ? Array.from(el.children).filter((c) => !name || c.localName === name) : []);
  const kid = (el, name) => (el ? Array.from(el.children).find((c) => c.localName === name) || null : null);
  const at = (el, a) => {
    if (!el) return null;
    let v = el.getAttributeNS(W, a);
    if (v == null || v === '') v = el.getAttribute('w:' + a);
    return v == null || v === '' ? null : v;
  };
  const rid = (el, a = 'id') => el && (el.getAttributeNS(R, a) || el.getAttribute('r:' + a));
  const on = (el) => {
    if (!el) return undefined;
    const v = at(el, 'val');
    return !(v === '0' || v === 'false' || v === 'off' || v === 'none');
  };
  const num = (v) => (v == null ? null : parseFloat(v));
  const tw = (v) => (v == null ? null : parseFloat(v) / 20); // twips -> pt
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const hex6 = (c) => {
    if (!c) return null;
    const m = String(c).match(/\d+(\.\d+)?/g);
    if (/^#/.test(c)) return c.slice(1).toUpperCase().padEnd(6, '0').slice(0, 6);
    if (m && m.length >= 3) return [0, 1, 2].map((k) => (+m[k]).toString(16).padStart(2, '0')).join('').toUpperCase();
    return null;
  };
  const isTransparent = (c) => !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);

  /* =====================================================================
   *  READING
   * ===================================================================== */
  function relsOf(xml) {
    const out = {};
    if (!xml) return out;
    for (const r of Array.from(parseXml(xml).documentElement.children)) out[r.getAttribute('Id')] = { type: r.getAttribute('Type'), target: r.getAttribute('Target'), mode: r.getAttribute('TargetMode') };
    return out;
  }
  const joinPath = (base, target) => {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1).concat(target.split('/'));
    const out = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.') out.push(p);
    }
    return out.join('/');
  };
  const relsPath = (part) => {
    const k = part.lastIndexOf('/');
    return part.slice(0, k + 1) + '_rels/' + part.slice(k + 1) + '.rels';
  };

  /* ---------- theme ---------- */
  function parseTheme(xml) {
    const t = { major: 'Calibri Light', minor: 'Calibri', colors: {} };
    if (!xml) return t;
    const d = parseXml(xml);
    const all = (n) => Array.from(d.getElementsByTagNameNS('*', n));
    const fs = all('majorFont')[0],
      mn = all('minorFont')[0];
    if (fs && kid(fs, 'latin')) t.major = kid(fs, 'latin').getAttribute('typeface');
    if (mn && kid(mn, 'latin')) t.minor = kid(mn, 'latin').getAttribute('typeface');
    const cs = all('clrScheme')[0];
    if (cs)
      for (const c of Array.from(cs.children)) {
        const v = c.firstElementChild;
        if (!v) continue;
        t.colors[c.localName] = v.getAttribute('val') && v.localName === 'srgbClr' ? v.getAttribute('val') : v.getAttribute('lastClr') || '000000';
      }
    return t;
  }

  /* ---------- properties ---------- */
  function parseRPr(el, ctx) {
    const o = {};
    if (!el) return o;
    for (const c of Array.from(el.children)) {
      const n = c.localName;
      if (n === 'rFonts') {
        let f = at(c, 'ascii') || at(c, 'hAnsi');
        const th = at(c, 'asciiTheme') || at(c, 'hAnsiTheme');
        if (!f && th) f = /major/.test(th) ? ctx.theme.major : ctx.theme.minor;
        if (f) o.font = f;
      } else if (n === 'b') o.b = on(c);
      else if (n === 'i') o.i = on(c);
      else if (n === 'u') o.u = at(c, 'val') !== 'none' && at(c, 'val') !== '0';
      else if (n === 'strike' || n === 'dstrike') o.strike = on(c);
      else if (n === 'caps') o.caps = on(c);
      else if (n === 'smallCaps') o.smallCaps = on(c);
      else if (n === 'vanish') o.vanish = on(c);
      else if (n === 'sz') o.sz = num(at(c, 'val')) / 2;
      else if (n === 'color') {
        const v = at(c, 'val'),
          th = at(c, 'themeColor');
        if (th && ctx.theme.colors[themeKey(th)]) o.color = ctx.theme.colors[themeKey(th)];
        else if (v && v !== 'auto') o.color = v;
        else if (v === 'auto') o.color = 'auto';
      } else if (n === 'highlight') {
        const v = at(c, 'val');
        if (v && v !== 'none' && HIGHLIGHT[v]) o.bg = HIGHLIGHT[v].slice(1);
      } else if (n === 'shd') {
        const f = at(c, 'fill');
        if (f && f !== 'auto') o.bg = f;
      } else if (n === 'vertAlign') o.vert = at(c, 'val');
      else if (n === 'rStyle') o.rStyle = at(c, 'val');
    }
    return o;
  }
  const themeKey = (t) => ({ text1: 'dk1', text2: 'dk2', background1: 'lt1', background2: 'lt2', dark1: 'dk1', dark2: 'dk2', light1: 'lt1', light2: 'lt2' })[t] || t;

  function parsePPr(el) {
    const o = {};
    if (!el) return o;
    for (const c of Array.from(el.children)) {
      const n = c.localName;
      if (n === 'pStyle') o.style = at(c, 'val');
      else if (n === 'jc') o.jc = at(c, 'val');
      else if (n === 'spacing') {
        if (at(c, 'before') != null) o.before = tw(at(c, 'before'));
        if (at(c, 'after') != null) o.after = tw(at(c, 'after'));
        if (at(c, 'beforeAutospacing') === '1' || at(c, 'beforeAutospacing') === 'true') o.before = 14;
        if (at(c, 'afterAutospacing') === '1' || at(c, 'afterAutospacing') === 'true') o.after = 14;
        if (at(c, 'line') != null) {
          o.line = num(at(c, 'line'));
          o.lineRule = at(c, 'lineRule') || 'auto';
        }
      } else if (n === 'ind') {
        const l = at(c, 'left') != null ? at(c, 'left') : at(c, 'start');
        const r = at(c, 'right') != null ? at(c, 'right') : at(c, 'end');
        if (l != null) o.left = tw(l);
        if (r != null) o.right = tw(r);
        if (at(c, 'firstLine') != null) o.first = tw(at(c, 'firstLine'));
        if (at(c, 'hanging') != null) o.first = -tw(at(c, 'hanging'));
        o.hasInd = true;
      } else if (n === 'numPr') {
        const il = kid(c, 'ilvl'),
          ni = kid(c, 'numId');
        if (ni) o.numId = at(ni, 'val');
        if (il) o.ilvl = +at(il, 'val') || 0;
      } else if (n === 'shd') {
        const f = at(c, 'fill');
        if (f && f !== 'auto') o.shd = f;
      } else if (n === 'pBdr') {
        o.bdr = {};
        for (const s of Array.from(c.children)) o.bdr[s.localName] = border(s);
      } else if (n === 'pageBreakBefore') o.pbb = on(c);
      else if (n === 'keepNext') o.keepNext = on(c);
      else if (n === 'contextualSpacing') o.ctxsp = on(c);
    }
    return o;
  }
  function border(el) {
    if (!el) return null;
    const v = at(el, 'val');
    if (!v || v === 'nil' || v === 'none') return { none: true };
    const sz = num(at(el, 'sz')) || 4;
    let c = at(el, 'color');
    if (!c || c === 'auto') c = '000000';
    return { w: Math.max(0.5, sz / 8), c, style: v === 'double' ? 'double' : v === 'dotted' ? 'dotted' : /dash/.test(v) ? 'dashed' : 'solid', space: num(at(el, 'space')) || 0 };
  }
  const bcss = (b) => (!b || b.none ? 'none' : `${b.style === 'double' ? Math.max(b.w * 3, 2.5) : b.w}px ${b.style} #${b.c}`);

  /* ---------- styles ---------- */
  function parseStyles(xml, ctx) {
    const S = { byId: {}, defR: {}, defP: {}, defaultP: null, defaultT: null };
    if (!xml) return S;
    const d = parseXml(xml).documentElement;
    const dd = kid(d, 'docDefaults');
    if (dd) {
      S.defR = parseRPr(kid(kid(dd, 'rPrDefault'), 'rPr'), ctx);
      S.defP = parsePPr(kid(kid(dd, 'pPrDefault'), 'pPr'));
    }
    for (const s of kids(d, 'style')) {
      const id = at(s, 'styleId');
      const st = {
        id,
        type: at(s, 'type'),
        name: at(kid(s, 'name'), 'val') || id,
        basedOn: at(kid(s, 'basedOn'), 'val'),
        next: at(kid(s, 'next'), 'val'),
        p: parsePPr(kid(s, 'pPr')),
        r: parseRPr(kid(s, 'rPr'), ctx),
        tblPr: kid(s, 'tblPr'),
        tcPr: kid(s, 'tcPr'),
        cond: {},
        q: !!kid(s, 'qFormat'),
        hidden: !!kid(s, 'semiHidden') || !!kid(s, 'hidden'),
        ui: num(at(kid(s, 'uiPriority'), 'val')),
      };
      for (const c of kids(s, 'tblStylePr')) st.cond[at(c, 'type')] = { r: parseRPr(kid(c, 'rPr'), ctx), tcPr: kid(c, 'tcPr'), p: parsePPr(kid(c, 'pPr')) };
      S.byId[id] = st;
      if (at(s, 'default') === '1' || at(s, 'default') === 'true') {
        if (st.type === 'paragraph') S.defaultP = id;
        if (st.type === 'table') S.defaultT = id;
      }
    }
    return S;
  }
  function chain(S, id) {
    const out = [];
    let s = S.byId[id];
    const seen = new Set();
    while (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.unshift(s);
      s = s.basedOn && S.byId[s.basedOn];
    }
    return out;
  }
  function resolvedStyle(S, id) {
    const p = {},
      r = {};
    for (const s of chain(S, id)) {
      Object.assign(p, s.p);
      Object.assign(r, s.r);
    }
    return { p, r };
  }

  /* ---------- CSS from properties ---------- */
  function runCss(o, base) {
    const css = {};
    if (o.font) {
      css['font-family'] = PE.fonts.cssFamily(famOf(o.font));
    }
    if (o.sz) css['font-size'] = o.sz + 'px';
    if (o.b !== undefined) css['font-weight'] = o.b ? '700' : '400';
    if (o.i !== undefined) css['font-style'] = o.i ? 'italic' : 'normal';
    const deco = [];
    if (o.u) deco.push('underline');
    if (o.strike) deco.push('line-through');
    if (deco.length) css['text-decoration'] = deco.join(' ');
    else if (o.u === false || o.strike === false) css['text-decoration'] = 'none';
    if (o.color && o.color !== 'auto') css.color = '#' + o.color;
    if (o.bg) css['background-color'] = '#' + o.bg;
    if (o.vert === 'superscript') css['vertical-align'] = 'super';
    if (o.vert === 'subscript') css['vertical-align'] = 'sub';
    if (o.vert && o.vert !== 'baseline') css['font-size'] = ((o.sz || (base && base.sz) || 11) * 0.65).toFixed(2) + 'px';
    if (o.caps) css['text-transform'] = 'uppercase';
    if (o.smallCaps) css['font-variant'] = 'small-caps';
    return css;
  }
  function paraCss(o, fam) {
    const css = {};
    if (o.jc) css['text-align'] = { both: 'justify', distribute: 'justify', center: 'center', right: 'right', end: 'right', left: 'left', start: 'left' }[o.jc] || 'left';
    if (o.before != null) css['padding-top'] = o.before + 'px';
    if (o.after != null) css['padding-bottom'] = o.after + 'px';
    if (o.line != null) {
      if (o.lineRule === 'auto' || !o.lineRule) css['line-height'] = String(+((o.line / 240) * lineOf(fam)).toFixed(4));
      else css['line-height'] = tw(o.line) + 'px';
    }
    if (o.left != null) css['padding-left'] = o.left + 'px';
    if (o.right != null) css['padding-right'] = o.right + 'px';
    if (o.first != null) css['text-indent'] = o.first + 'px';
    if (o.shd) css['background-color'] = '#' + o.shd;
    if (o.bdr) {
      for (const side of ['top', 'left', 'bottom', 'right']) if (o.bdr[side] && !o.bdr[side].none) css['border-' + side] = bcss(o.bdr[side]);
    }
    return css;
  }
  const cssText = (css) => Object.entries(css).map(([k, v]) => `${k}:${v}`).join(';');
  function setCss(el, css) {
    for (const k in css) el.style.setProperty(k, css[k]);
  }

  function buildCss(S, ctx) {
    const defR = Object.assign({ sz: 10, font: ctx.theme.minor }, S.defR);
    const normal = S.defaultP ? resolvedStyle(S, S.defaultP) : { p: {}, r: {} };
    const baseR = Object.assign({}, defR, normal.r);
    const baseP = Object.assign({}, S.defP, normal.p);
    const fam = famOf(baseR.font);
    const fams = new Set([fam]);
    const lines = [];
    const keep = [];
    const rc = runCss(baseR);
    if (!rc.color) rc.color = '#000000';
    // the same rules style the body and the page headers / footers
    const B = ':is(.dm-body,.dm-hdr,.dm-ftr)';
    lines.push(`${B}{${cssText(rc)};line-height:${lineOf(fam)}}`);
    lines.push(`${B} p{${cssText(paraCss(baseP, fam))}}`);
    for (const id in S.byId) {
      const st = S.byId[id];
      if (st.type !== 'paragraph' || id === S.defaultP) continue;
      const rs = resolvedStyle(S, id);
      const r = Object.assign({}, defR, rs.r);
      const p = Object.assign({}, S.defP, rs.p);
      const f = famOf(r.font);
      fams.add(f);
      if (p.keepNext) keep.push(id);
      const css = Object.assign({ 'line-height': String(lineOf(f)) }, paraCss(p, f), runCss(r));
      const sel = `${B} p[data-ps="${CSS.escape(id)}"]`;
      lines.push(`${sel}{${cssText(css)}}`);
      // "don't add space between paragraphs of the same style" (lists, captions…)
      if (p.ctxsp) lines.push(`${sel} + p[data-ps="${CSS.escape(id)}"]{padding-top:0}`, `${sel}:has(+ p[data-ps="${CSS.escape(id)}"]){padding-bottom:0}`);
    }
    // paragraphs inside a table take the table style's paragraph settings
    for (const id in S.byId) {
      const st = S.byId[id];
      if (st.type !== 'table') continue;
      const rs = resolvedStyle(S, id);
      const p = rs.p,
        r = rs.r;
      const css = Object.assign({}, paraCss(p, fam), runCss(r));
      if (Object.keys(css).length) lines.push(`${B} table[data-ts="${CSS.escape(id)}"] p:not([data-ps]){${cssText(css)}}`);
    }
    for (const id in S.byId) {
      const st = S.byId[id];
      if (st.type === 'character' && st.r.font) fams.add(famOf(st.r.font));
    }
    return { css: lines.join('\n'), fams: [...fams], keep, base: { r: baseR, p: baseP, fam } };
  }

  /* ---------- numbering ---------- */
  function parseNumbering(xml) {
    const N = { abs: {}, nums: {} };
    if (!xml) return N;
    const d = parseXml(xml).documentElement;
    for (const a of kids(d, 'abstractNum')) {
      const lv = {};
      for (const l of kids(a, 'lvl')) {
        const ind = kid(kid(l, 'pPr'), 'ind');
        const rf = kid(kid(l, 'rPr'), 'rFonts');
        lv[+at(l, 'ilvl')] = {
          start: +(at(kid(l, 'start'), 'val') || 1),
          fmt: at(kid(l, 'numFmt'), 'val') || 'decimal',
          text: at(kid(l, 'lvlText'), 'val') || '',
          left: ind ? tw(at(ind, 'left') || at(ind, 'start') || 0) : 36 * (+at(l, 'ilvl') + 1),
          hang: ind ? tw(at(ind, 'hanging') || 0) : 18,
          font: rf ? at(rf, 'ascii') || at(rf, 'hAnsi') : null,
        };
      }
      N.abs[at(a, 'abstractNumId')] = { lvls: lv };
    }
    for (const n of kids(d, 'num')) {
      const over = {};
      for (const o of kids(n, 'lvlOverride')) {
        const so = kid(o, 'startOverride');
        if (so) over[+at(o, 'ilvl')] = +at(so, 'val');
      }
      N.nums[at(n, 'numId')] = { abs: at(kid(n, 'abstractNumId'), 'val'), over };
    }
    return N;
  }

  const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  function fmtNum(n, fmt) {
    if (fmt === 'lowerLetter' || fmt === 'upperLetter') {
      const ch = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
      return fmt === 'upperLetter' ? ch.toUpperCase() : ch;
    }
    if (fmt === 'lowerRoman' || fmt === 'upperRoman') {
      let s = '',
        v = n;
      for (const [k, r] of ROMAN)
        while (v >= k) {
          s += r;
          v -= k;
        }
      return fmt === 'upperRoman' ? s.toUpperCase() : s;
    }
    if (fmt === 'decimalZero') return String(n).padStart(2, '0');
    if (fmt === 'none') return '';
    return String(n);
  }
  /** marker text for every list paragraph, in document order */
  function renumber(root, N) {
    const counters = {};
    const seenNum = new Set();
    root.querySelectorAll('p.li').forEach((p) => {
      const numId = p.getAttribute('data-num');
      const lvl = +p.getAttribute('data-lvl') || 0;
      const nm = N.nums[numId];
      const ab = nm && N.abs[nm.abs];
      const L = ab && (ab.lvls[lvl] || ab.lvls[0]);
      if (!L) {
        p.setAttribute('data-marker', '•');
        return;
      }
      const key = nm.abs;
      const c = (counters[key] = counters[key] || []);
      if (!seenNum.has(numId)) {
        seenNum.add(numId);
        for (const k in nm.over) c[k] = nm.over[k] - 1;
      }
      for (let k = 0; k < lvl; k++) if (c[k] == null) c[k] = (ab.lvls[k] ? ab.lvls[k].start : 1);
      c[lvl] = c[lvl] == null ? L.start : c[lvl] + 1;
      c.length = lvl + 1;
      let text;
      if (L.fmt === 'bullet') {
        text = L.text || '•';
        text = text.replace(/[-]/g, (ch) => PUA[ch] || '•');
        if (/symbol|wingdings/i.test(L.font || '') && /^[ -ÿ]$/.test(text)) text = text === 'o' ? '○' : text === '§' ? '▪' : '•';
      } else text = L.text.replace(/%(\d)/g, (m, d) => fmtNum(c[d - 1] != null ? c[d - 1] : 1, (ab.lvls[d - 1] || L).fmt));
      p.setAttribute('data-marker', text);
      if (!p.hasAttribute('data-pind')) {
        p.style.paddingLeft = L.left + 'px';
        p.style.textIndent = '0px';
      }
      p.style.setProperty('--hang', Math.max(L.hang, 10) + 'px');
    });
  }

  /* ---------- body ---------- */
  function newRaw(ctx, data) {
    const id = 'x' + ctx.D.rawSeq++;
    ctx.D.raw[id] = data;
    return id;
  }
  const P_MANAGED = new Set(['pStyle', 'jc', 'spacing', 'ind', 'numPr']);
  const R_MANAGED = new Set(['rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'color', 'sz', 'szCs', 'highlight', 'u', 'vertAlign']);
  function extras(el, managed) {
    if (!el) return null;
    const out = [];
    for (const c of Array.from(el.children)) if (!managed.has(c.localName)) out.push([c.localName, ser(c)]);
    return out.length ? out : null;
  }

  async function convBlocks(parent, ctx, out) {
    for (const c of Array.from(parent.children)) {
      const n = c.localName;
      if (n === 'p') await convP(c, ctx, out);
      else if (n === 'tbl') out.push(await convTable(c, ctx));
      else if (n === 'sdt') await convBlocks(kid(c, 'sdtContent') || c, ctx, out);
      else if (n === 'customXml' || n === 'ins' || n === 'moveTo') await convBlocks(c, ctx, out);
      else if (n === 'altChunk') continue;
    }
    return out;
  }

  async function convP(p, ctx, out) {
    const pPr = kid(p, 'pPr');
    const P = parsePPr(pPr);
    const el = document.createElement('p');
    const S = ctx.S;
    const styleId = P.style && S.byId[P.style] ? P.style : null;
    if (styleId && styleId !== S.defaultP) el.setAttribute('data-ps', styleId);
    const rs = styleId ? resolvedStyle(S, styleId) : { p: {}, r: {} };
    const fam = famOf(rs.r.font || ctx.base.r.font);
    const direct = Object.assign({}, P);
    delete direct.style;
    setCss(el, paraCss(direct, fam));
    let numId = P.numId != null ? P.numId : rs.p.numId;
    let ilvl = P.ilvl != null ? P.ilvl : rs.p.ilvl || 0;
    if (numId && numId !== '0' && ctx.N.nums[numId]) {
      el.classList.add('li');
      el.setAttribute('data-num', numId);
      el.setAttribute('data-lvl', ilvl);
      if (P.hasInd) el.setAttribute('data-pind', '1');
    }
    const ex = extras(pPr, P_MANAGED);
    if (ex) el.setAttribute('data-raw', newRaw(ctx, { k: 'p', items: ex }));
    if (P.pbb || (styleId && rs.p.pbb)) out.push(pageBreak());
    const after = [];
    ctx.fld = [];
    await convInline(p, ctx, el, after, Object.assign({}, rs.r));
    // a page break inside the paragraph: split into two paragraphs around it
    if (!el.firstChild) el.appendChild(document.createElement('br'));
    out.push(el);
    out.push(...after);
  }
  function pageBreak() {
    return PE.h('div', { class: 'dm-pb', contenteditable: 'false' });
  }

  async function convInline(parent, ctx, el, after, pStyleR) {
    for (const c of Array.from(parent.children)) {
      const n = c.localName;
      if (n === 'r') await convRun(c, ctx, el, after, pStyleR);
      else if (n === 'hyperlink') {
        const a = document.createElement('a');
        const id = rid(c);
        const rel = id && ctx.rels[id];
        if (rel) {
          a.setAttribute('href', rel.target);
          a.setAttribute('data-rid', id);
        } else if (at(c, 'anchor')) a.setAttribute('data-anchor', at(c, 'anchor'));
        await convInline(c, ctx, a, after, pStyleR);
        el.appendChild(a);
      } else if (n === 'fldSimple') {
        const instr = (at(c, 'instr') || '').trim().split(/\s+/)[0].toUpperCase();
        if (instr === 'PAGE' || instr === 'NUMPAGES') {
          const sp = PE.h('span', { class: 'dm-field', 'data-f': instr, contenteditable: 'false' }, '1');
          el.appendChild(sp);
        } else await convInline(c, ctx, el, after, pStyleR);
      } else if (['ins', 'smartTag', 'customXml', 'moveTo', 'dir', 'bdo'].includes(n)) await convInline(c, ctx, el, after, pStyleR);
      else if (n === 'sdt') await convInline(kid(c, 'sdtContent') || c, ctx, el, after, pStyleR);
      else if (n === 'AlternateContent') {
        const ch = kid(c, 'Choice');
        await convInline(ch || kid(c, 'Fallback') || c, ctx, el, after, pStyleR);
      }
    }
  }

  async function convRun(r, ctx, el, after, pStyleR) {
    const rPr = kid(r, 'rPr');
    const direct = parseRPr(rPr, ctx);
    if (direct.vanish) return;
    let props = direct;
    if (direct.rStyle && ctx.S.byId[direct.rStyle]) props = Object.assign({}, resolvedStyle(ctx.S, direct.rStyle).r, direct);
    const css = runCss(props, Object.assign({}, ctx.base.r, pStyleR));
    const ex = extras(rPr, R_MANAGED);
    let target = el;
    const mk = () => {
      if (target !== el) return target;
      if (!Object.keys(css).length && !ex && !props.font) return el;
      const sp = document.createElement('span');
      setCss(sp, css);
      if (props.font) sp.setAttribute('data-font', props.font);
      if (ex) sp.setAttribute('data-raw', newRaw(ctx, { k: 'r', items: ex }));
      el.appendChild(sp);
      target = sp;
      return sp;
    };
    const fld = ctx.fld;
    const inInstr = () => fld.length && !fld[fld.length - 1].res;
    for (const c of Array.from(r.children)) {
      const n = c.localName;
      if (n === 'fldChar') {
        const t = at(c, 'fldCharType');
        if (t === 'begin') fld.push({ instr: '', res: false });
        else if (t === 'separate' && fld.length) {
          const f = fld[fld.length - 1];
          f.res = true;
          const k = f.instr.trim().split(/\s+/)[0].toUpperCase();
          if (k === 'PAGE' || k === 'NUMPAGES') f.page = k;
        } else if (t === 'end') fld.pop();
        continue;
      }
      if (n === 'instrText') {
        if (fld.length) fld[fld.length - 1].instr += c.textContent;
        continue;
      }
      if (inInstr()) continue;
      const pf = fld.length && fld[fld.length - 1].page;
      if (n === 't' || n === 'delText') {
        if (n === 'delText') continue;
        const txt = c.textContent.replace(/[-]/g, (ch) => PUA[ch] || ch);
        if (pf) {
          if (!fld[fld.length - 1].shown) {
            mk().appendChild(PE.h('span', { class: 'dm-field', 'data-f': pf, contenteditable: 'false' }, txt));
            fld[fld.length - 1].shown = true;
          }
        } else mk().appendChild(document.createTextNode(txt));
      } else if (n === 'tab') mk().appendChild(document.createTextNode('\t'));
      else if (n === 'br' || n === 'cr') {
        if (at(c, 'type') === 'page' || at(c, 'type') === 'column') mk().appendChild(PE.h('span', { class: 'dm-pbr', contenteditable: 'false' }));
        else mk().appendChild(document.createElement('br'));
      } else if (n === 'noBreakHyphen') mk().appendChild(document.createTextNode('‑'));
      else if (n === 'softHyphen') mk().appendChild(document.createTextNode('­'));
      else if (n === 'sym') {
        const ch = String.fromCharCode(parseInt(at(c, 'char') || '2022', 16));
        mk().appendChild(document.createTextNode(PUA[ch] || (ch.charCodeAt(0) >= 0xf000 ? '•' : ch)));
      } else if (n === 'footnoteReference' || n === 'endnoteReference') {
        const id = at(c, 'id');
        ctx.fnCount = (ctx.fnCount || 0) + 1;
        el.appendChild(PE.h('span', { class: 'dm-fn', 'data-fn': id, 'data-kind': n === 'footnoteReference' ? 'footnote' : 'endnote', contenteditable: 'false' }, String(ctx.fnCount)));
      } else if (n === 'drawing' || n === 'pict' || n === 'object') await convDrawing(c, ctx, mk, after, r);
      else if (n === 'AlternateContent') {
        const ch = kid(c, 'Choice') || kid(c, 'Fallback');
        const dr = ch && (kid(ch, 'drawing') || kid(ch, 'pict'));
        if (dr) await convDrawing(dr, ctx, mk, after, r, c);
      }
    }
  }

  async function convDrawing(d, ctx, mk, after, run, alt) {
    const all = (n) => Array.from(d.getElementsByTagNameNS('*', n));
    // text box: its paragraphs become an editable box placed after the paragraph
    const txbx = all('txbxContent')[0];
    if (txbx) {
      const box = PE.h('div', { class: 'dm-tb' });
      const inner = [];
      await convBlocks(txbx, ctx, inner);
      inner.forEach((x) => box.appendChild(x));
      const ext = all('extent')[0];
      if (ext) box.style.width = Math.min(ctx.page.w - ctx.page.ml - ctx.page.mr, num(ext.getAttribute('cx')) / 12700) + 'px';
      box.setAttribute('data-raw', newRaw(ctx, { k: 'tb', xml: ser(alt || d) }));
      after.push(box);
      return;
    }
    const blip = all('blip')[0];
    const imd = all('imagedata')[0];
    const id = blip ? rid(blip, 'embed') || rid(blip, 'link') : imd ? rid(imd, 'id') : null;
    const rel = id && ctx.rels[id];
    if (!rel || rel.mode === 'External') return;
    const path = joinPath(ctx.part, rel.target);
    const f = ctx.zip.file(path);
    if (!f) return;
    let w = 0,
      h = 0;
    const ext = all('extent')[0];
    if (ext) {
      w = num(ext.getAttribute('cx')) / 12700;
      h = num(ext.getAttribute('cy')) / 12700;
    } else {
      const shape = all('shape')[0];
      const st = shape && shape.getAttribute('style');
      if (st) {
        const mw = st.match(/width:\s*([\d.]+)(pt|in|px)?/),
          mh = st.match(/height:\s*([\d.]+)(pt|in|px)?/);
        const u = (m) => (m ? +m[1] * (m[2] === 'in' ? 72 : m[2] === 'px' ? 0.75 : 1) : 0);
        w = u(mw);
        h = u(mh);
      }
    }
    const bytes = await f.async('uint8array');
    const ext2 = path.split('.').pop().toLowerCase();
    let mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' }[ext2];
    if (!mime) return; // emf/wmf/tiff can't be shown by browsers
    const key = 'm' + ctx.D.mediaSeq++;
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    ctx.D.media[key] = { bytes, mime, url, path: ctx.part === ctx.mainPart ? path : null, rid: ctx.part === ctx.mainPart ? id : null };
    const maxW = ctx.page.w - ctx.page.ml - ctx.page.mr;
    if (!w || !h) {
      const im = await PE.view.loadImg(url).catch(() => null);
      w = im ? im.naturalWidth * 0.75 : 100;
      h = im ? im.naturalHeight * 0.75 : 100;
    }
    const img = PE.h('img', { class: 'dm-img', src: url, alt: '', 'data-m': key, draggable: 'false' });
    img.style.width = +w.toFixed(2) + 'px';
    img.style.height = +h.toFixed(2) + 'px';
    if (w > maxW) {
      img.style.height = +((h * maxW) / w).toFixed(2) + 'px';
      img.style.width = maxW + 'px';
    }
    // floating pictures keep their original placement in Word when left unchanged
    if (ctx.part === ctx.mainPart) {
      const rpr = kid(run, 'rPr');
      img.setAttribute('data-raw', newRaw(ctx, { k: 'img', xml: ser(alt || d), rpr: rpr ? ser(rpr) : '', w: img.style.width, h: img.style.height }));
    }
    if (all('anchor').length) img.classList.add('dm-float');
    mk().appendChild(img);
  }

  async function convTable(tbl, ctx) {
    const S = ctx.S;
    const tblPr = kid(tbl, 'tblPr');
    const tsId = at(kid(tblPr, 'tblStyle'), 'val') || S.defaultT;
    const tstyles = tsId ? chain(S, tsId) : [];
    // borders and cell margins: table style chain, then direct
    const bd = {};
    const mar = { left: 5.4, right: 5.4, top: 0, bottom: 0 };
    const readTblPr = (pr) => {
      if (!pr) return;
      const b = kid(pr, 'tblBorders');
      if (b) for (const s of Array.from(b.children)) bd[s.localName === 'start' ? 'left' : s.localName === 'end' ? 'right' : s.localName] = border(s);
      const m = kid(pr, 'tblCellMar');
      if (m)
        for (const s of Array.from(m.children)) {
          const k = s.localName === 'start' ? 'left' : s.localName === 'end' ? 'right' : s.localName;
          if (at(s, 'w') != null) mar[k] = tw(at(s, 'w'));
        }
    };
    tstyles.forEach((s) => readTblPr(s.tblPr));
    readTblPr(tblPr);
    const look = kid(tblPr, 'tblLook');
    const lookVal = look ? parseInt(at(look, 'val') || '0', 16) : 0x04a0;
    const firstRow = look ? at(look, 'firstRow') === '1' || (at(look, 'firstRow') == null && !!(lookVal & 0x20)) : true;
    const banded = look ? at(look, 'noHBand') === '0' || (at(look, 'noHBand') == null && !(lookVal & 0x200)) : true;
    const cond = {};
    tstyles.forEach((s) => Object.assign(cond, s.cond));
    const table = PE.h('table', { class: 'dm-tbl' });
    if (tsId) table.setAttribute('data-ts', tsId);
    if (tblPr) table.setAttribute('data-raw', newRaw(ctx, { k: 'tbl', xml: ser(tblPr) }));
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => tw(at(g, 'w')) || 0);
    const total = grid.reduce((a, b) => a + b, 0);
    const maxW = ctx.page.w - ctx.page.ml - ctx.page.mr;
    const k = total > maxW * 1.02 && total > 0 ? maxW / total : 1;
    const cg = PE.h('colgroup');
    grid.forEach((w) => cg.appendChild(PE.h('col', { style: { width: (w * k).toFixed(2) + 'px' } })));
    table.appendChild(cg);
    if (total) table.style.width = (total * k).toFixed(2) + 'px';
    const jc = at(kid(tblPr, 'jc'), 'val');
    if (jc === 'center') table.style.margin = '0 auto';
    else if (jc === 'right' || jc === 'end') table.style.marginLeft = 'auto';
    const ind = kid(tblPr, 'tblInd');
    if (ind && at(ind, 'w') && jc !== 'center') table.style.marginLeft = tw(at(ind, 'w')) + 'px';
    table.style.setProperty('--cpl', mar.left + 'px');
    table.style.setProperty('--cpr', mar.right + 'px');
    table.style.setProperty('--cpt', mar.top + 'px');
    table.style.setProperty('--cpb', mar.bottom + 'px');
    const tb = PE.h('tbody');
    table.appendChild(tb);
    const rows = kids(tbl, 'tr');
    const above = []; // grid column -> td that may continue (vMerge)
    for (let ri = 0; ri < rows.length; ri++) {
      const tr = rows[ri];
      const row = PE.h('tr');
      const trPr = kid(tr, 'trPr');
      if (trPr) {
        const th = kid(trPr, 'trHeight');
        if (th && at(th, 'val')) row.style.height = tw(at(th, 'val')) + 'px';
        row.setAttribute('data-raw', newRaw(ctx, { k: 'tr', xml: ser(trPr) }));
      }
      let gc = 0;
      const cells = kids(tr, 'tc');
      const isFirst = ri === 0,
        isLast = ri === rows.length - 1;
      for (const tc of cells) {
        const tcPr = kid(tc, 'tcPr');
        const span = +(at(kid(tcPr, 'gridSpan'), 'val') || 1);
        const vm = kid(tcPr, 'vMerge');
        const vmv = vm ? at(vm, 'val') || 'continue' : null;
        if (vmv === 'continue' && above[gc]) {
          above[gc].rowSpan = (above[gc].rowSpan || 1) + 1;
          gc += span;
          continue;
        }
        const td = PE.h('td');
        if (span > 1) td.colSpan = span;
        const cb = {};
        const tcb = kid(tcPr, 'tcBorders');
        const cBorders = {};
        // conditional formatting from the table style (header row, banded rows)
        let cnd = null;
        if (firstRow && isFirst && cond.firstRow) cnd = cond.firstRow;
        else if (banded && cond.band1Horz && (ri - (firstRow && cond.firstRow ? 1 : 0)) % 2 === 0 && !(firstRow && isFirst)) cnd = cond.band1Horz;
        const applyTc = (pr) => {
          if (!pr) return;
          const b = kid(pr, 'tcBorders');
          if (b) for (const s of Array.from(b.children)) cBorders[s.localName === 'start' ? 'left' : s.localName === 'end' ? 'right' : s.localName] = border(s);
          const shd = kid(pr, 'shd');
          if (shd && at(shd, 'fill') && at(shd, 'fill') !== 'auto') td.style.backgroundColor = '#' + at(shd, 'fill');
          const va = kid(pr, 'vAlign');
          if (va) td.style.verticalAlign = { center: 'middle', bottom: 'bottom', top: 'top' }[at(va, 'val')] || 'top';
          const m = kid(pr, 'tcMar');
          if (m)
            for (const s of Array.from(m.children)) {
              const kk = s.localName === 'start' ? 'left' : s.localName === 'end' ? 'right' : s.localName;
              if (at(s, 'w') != null) td.style.setProperty('padding-' + kk, tw(at(s, 'w')) + 'px');
            }
        };
        tstyles.forEach((s) => applyTc(s.tcPr));
        if (cnd) applyTc(cnd.tcPr);
        applyTc(tcPr);
        const lastCol = gc + span >= grid.length;
        cb.top = cBorders.top || (isFirst ? bd.top : bd.insideH);
        cb.bottom = cBorders.bottom || (isLast ? bd.bottom : bd.insideH);
        cb.left = cBorders.left || (gc === 0 ? bd.left : bd.insideV);
        cb.right = cBorders.right || (lastCol ? bd.right : bd.insideV);
        for (const s of ['top', 'right', 'bottom', 'left']) td.style.setProperty('border-' + s, bcss(cb[s]));
        if (tcPr) {
          const ex = Array.from(tcPr.children).filter((c) => !['tcW', 'gridSpan', 'vMerge', 'hMerge'].includes(c.localName)).map((c) => [c.localName, ser(c)]);
          if (ex.length) td.setAttribute('data-raw', newRaw(ctx, { k: 'tc', items: ex }));
        }
        if (cnd && (cnd.r.b || cnd.r.color)) {
          if (cnd.r.b) td.style.fontWeight = '700';
          if (cnd.r.color && cnd.r.color !== 'auto') td.style.color = '#' + cnd.r.color;
          td.setAttribute('data-cond', '1');
        }
        const inner = [];
        await convBlocks(tc, ctx, inner);
        inner.forEach((x) => td.appendChild(x));
        if (!td.firstChild) td.appendChild(PE.h('p', {}, [PE.h('br')]));
        row.appendChild(td);
        for (let g = gc; g < gc + span; g++) above[g] = vmv === 'restart' ? td : null;
        gc += span;
      }
      tb.appendChild(row);
    }
    return table;
  }

  /* ---------- the whole package ---------- */
  PE.docx = {};
  PE.docx.LINE = LINE;
  PE.docx.WORD_NAME = WORD_NAME;
  PE.docx.lineOf = lineOf;
  PE.docx.famOf = famOf;
  PE.docx.renumber = renumber;
  PE.docx.HIGHLIGHT = HIGHLIGHT;

  PE.docx.read = async function (bytes, name) {
    if (!window.JSZip) throw new Error('The Word file library is missing (lib/jszip.min.js).');
    const zip = await JSZip.loadAsync(bytes);
    const rootRels = relsOf(await textOf(zip, '_rels/.rels'));
    let main = 'word/document.xml';
    for (const id in rootRels) if (/officeDocument$/.test(rootRels[id].type)) main = joinPath('', rootRels[id].target);
    const docXml = await textOf(zip, main);
    if (!docXml) throw new Error('This file is not a Word document.');
    const rels = relsOf(await textOf(zip, relsPath(main)));
    const partOf = (type) => {
      for (const id in rels) if (rels[id].type.endsWith('/' + type)) return joinPath(main, rels[id].target);
      return null;
    };
    const D = newDocState(name);
    D.pkg = zip;
    D.mainPart = main;
    D.rels = rels;
    const theme = parseTheme(await textOf(zip, partOf('theme')));
    const ctx = { D, zip, theme, rels, part: main, mainPart: main };
    const S = parseStyles(await textOf(zip, partOf('styles')), ctx);
    ctx.S = S;
    const N = parseNumbering(await textOf(zip, partOf('numbering')));
    ctx.N = N;
    D.N = N;
    const st = buildCss(S, ctx);
    ctx.base = st.base;
    D.css = st.css;
    D.fams = st.fams;
    D.keep = st.keep;
    D.styles = Object.values(S.byId)
      .filter((s) => s.type === 'paragraph' && (!s.hidden || s.q) && (s.q || s.id === S.defaultP || /^heading|title|subtitle|quote|list/i.test(s.name)))
      .map((s) => ({ id: s.id === S.defaultP ? '' : s.id, name: s.name.replace(/^heading (\d)$/i, 'Heading $1').replace(/^normal$/i, 'Normal'), next: s.next, ui: s.ui == null ? 99 : s.ui }))
      .sort((a, b) => (a.id === '' ? -1 : b.id === '' ? 1 : a.ui - b.ui || a.name.localeCompare(b.name)));
    D.styleNext = Object.fromEntries(Object.values(S.byId).map((s) => [s.id, s.next]));
    D.defaultP = S.defaultP;
    const settings = await textOf(zip, partOf('settings'));
    if (settings) {
      const tab = settings.match(/defaultTabStop[^>]*w:val="(\d+)"/);
      if (tab) D.tab = +tab[1] / 20;
    }
    // page setup from the last section
    const xd = parseXml(docXml);
    const body = kid(xd.documentElement, 'body');
    const sect = kid(body, 'sectPr');
    if (sect) {
      D.sectXml = ser(sect);
      readSect(sect, D.page);
    }
    D.rootTag = docXml.match(/<w:document[^>]*>/)[0];
    const bg = kid(xd.documentElement, 'background');
    D.bgXml = bg ? ser(bg) : '';
    ctx.page = D.page;
    // headers and footers (shown on every page, kept as they are in the file)
    if (sect) {
      for (const ref of kids(sect, 'headerReference').concat(kids(sect, 'footerReference'))) {
        const type = at(ref, 'type') || 'default';
        const rel = rels[rid(ref)];
        if (!rel) continue;
        const part = joinPath(main, rel.target);
        const xml = await textOf(zip, part);
        if (!xml) continue;
        const hctx = Object.assign({}, ctx, { part, rels: relsOf(await textOf(zip, relsPath(part))) });
        const blocks = [];
        await convBlocks(parseXml(xml).documentElement, hctx, blocks);
        const div = PE.h('div');
        blocks.forEach((b) => div.appendChild(b));
        const isHeader = ref.localName === 'headerReference';
        (isHeader ? D.hdr : D.ftr)[type] = div.innerHTML;
      }
      D.titlePg = !!kid(sect, 'titlePg');
    }
    const blocks = [];
    await convBlocks(body, ctx, blocks);
    const host = PE.h('div');
    blocks.forEach((b) => host.appendChild(b));
    if (!host.firstChild) host.appendChild(PE.h('p', {}, [PE.h('br')]));
    D.html = host.innerHTML;
    D.fams = [...new Set(D.fams.concat([...host.querySelectorAll('[data-font]')].map((s) => famOf(s.getAttribute('data-font')))))];
    return D;
  };
  async function textOf(zip, path) {
    if (!path) return null;
    const f = zip.file(path);
    return f ? f.async('string') : null;
  }
  function readSect(sect, page) {
    const sz = kid(sect, 'pgSz'),
      mg = kid(sect, 'pgMar');
    if (sz) {
      page.w = tw(at(sz, 'w')) || page.w;
      page.h = tw(at(sz, 'h')) || page.h;
    }
    if (mg) {
      page.mt = Math.abs(tw(at(mg, 'top')) || 72);
      page.mb = Math.abs(tw(at(mg, 'bottom')) || 72);
      page.ml = tw(at(mg, 'left') || at(mg, 'start')) || 72;
      page.mr = tw(at(mg, 'right') || at(mg, 'end')) || 72;
      page.hd = tw(at(mg, 'header')) || 36;
      page.fd = tw(at(mg, 'footer')) || 36;
    }
  }

  function newDocState(name) {
    return {
      name: name || 'Document.docx',
      pkg: null,
      page: { w: 595.3, h: 841.9, mt: 72, mb: 72, ml: 72, mr: 72, hd: 36, fd: 36 },
      css: '',
      fams: ['carlito'],
      styles: [],
      styleNext: {},
      raw: {},
      rawSeq: 1,
      media: {},
      mediaSeq: 1,
      hdr: {},
      ftr: {},
      N: { abs: {}, nums: {} },
      added: [], // list definitions created in the editor
      tab: 36,
      html: '',
      sectXml: '',
      pageNumbers: false,
    };
  }
  PE.docx.newDocState = newDocState;

  /* ---------- a new, empty Word document ---------- */
  const NS =
    'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  function blankFiles(font) {
    font = font || 'Calibri';
    const st = (id, name, extra) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>${extra}</w:style>`;
    return {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
      'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title></dc:title><dc:creator></dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`,
      'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Edivora</Application></Properties>`,
      'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId3" Type="${REL_NUM}" Target="numbering.xml"/></Relationships>`,
      'word/settings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
      'word/numbering.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W}"></w:numbering>`,
      'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
        `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
        st('Title', 'Title', `<w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:spacing w:val="-10"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr>`).replace('<w:uiPriority w:val="9"/>', '<w:uiPriority w:val="10"/>') +
        st('Heading1', 'heading 1', `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:color w:val="1F3864"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr>`) +
        st('Heading2', 'heading 2', `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>`) +
        st('Heading3', 'heading 3', `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:color w:val="1F3864"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>`) +
        st('Quote', 'Quote', `<w:pPr><w:spacing w:before="160"/><w:ind w:left="864" w:right="864"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr>`).replace('<w:uiPriority w:val="9"/>', '<w:uiPriority w:val="29"/>') +
        `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>` +
        `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>` +
        `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
        `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
        `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>` +
        `</w:styles>`,
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`,
    };
  }
  /** bytes of a new empty .docx (A4, or US Letter where that's the local default) */
  PE.docx.blank = async function (opts = {}) {
    const zip = new JSZip();
    const files = blankFiles(opts.font);
    for (const p in files) zip.file(p, files[p]);
    if (opts.letter) zip.file('word/document.xml', files['word/document.xml'].replace('w:w="11906" w:h="16838"', 'w:w="12240" w:h="15840"'));
    if (opts.page) {
      const p = opts.page;
      zip.file(
        'word/document.xml',
        files['word/document.xml']
          .replace('w:w="11906" w:h="16838"', `w:w="${Math.round(p.w * 20)}" w:h="${Math.round(p.h * 20)}"${p.w > p.h ? ' w:orient="landscape"' : ''}`)
          .replace('w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"', `w:top="${Math.round(p.mt * 20)}" w:right="${Math.round(p.mr * 20)}" w:bottom="${Math.round(p.mb * 20)}" w:left="${Math.round(p.ml * 20)}"`)
      );
    }
    return zip.generateAsync({ type: 'uint8array' });
  };

  /* =====================================================================
   *  WRITING
   * ===================================================================== */
  const P_ORDER = 'pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange'.split(' ');
  const R_ORDER = 'rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath'.split(' ');
  const TC_ORDER = 'cnfStyle tcW gridSpan hMerge vMerge tcBorders shd noWrap tcMar textDirection tcFitText vAlign hideMark headers cellIns cellDel cellMerge tcPrChange'.split(' ');
  const sortBy = (order) => (a, b) => {
    const ia = order.indexOf(a[0]),
      ib = order.indexOf(b[0]);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  };
  /** remove the xmlns declarations XMLSerializer adds to stored fragments (the root declares them) */
  const clean = (xml) => xml.replace(/ xmlns:[a-z0-9]+="[^"]*"/gi, (m) => (/xmlns:(w|r|wp|a|pic|v|o|mc|w10|w14|w15|wps|wpg|wp14|m|wne|wpc|wpi|w16[a-z]*|cx\d*|aink|am3d|w16cid|w16se|w16sdtdh|w16du)=/.test(m) ? '' : m));

  function writer(D) {
    const st = {
      D,
      newRels: [],
      relSeq: 0,
      docPr: 5000,
      usedRels: new Set(),
      mediaFiles: [],
      factor: (el) => lineOf(famOfEl(el)),
    };
    const existing = Object.keys(D.rels || {}).map((k) => +(k.match(/\d+/) || [0])[0]);
    st.relSeq = Math.max(100, ...existing) + 1;
    st.rel = (type, target, external) => {
      const id = 'rId' + st.relSeq++;
      st.newRels.push({ id, type, target, external });
      return id;
    };
    return st;
  }
  function famOfEl(el) {
    const ff = getComputedStyle(el).fontFamily || '';
    const m = ff.match(/PEF-([a-z-]+)/);
    return m ? m[1] : 'carlito';
  }

  function writeBlocks(container, st) {
    let out = '';
    for (const el of Array.from(container.children)) {
      if (el.tagName === 'P') out += writeP(el, st);
      else if (el.tagName === 'TABLE') out += writeTable(el, st) + (el.nextElementSibling && el.nextElementSibling.tagName === 'TABLE' ? '<w:p/>' : '');
      else if (el.classList.contains('dm-pb')) out += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      else if (el.classList.contains('dm-tb')) out += writeTextBox(el, st);
      else if (el.tagName === 'DIV' || el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'BLOCKQUOTE') out += writeBlocks(el, st);
    }
    return out;
  }
  function writeTextBox(el, st) {
    const raw = st.D.raw[el.getAttribute('data-raw')];
    const inner = writeBlocks(el, st) || '<w:p/>';
    if (!raw) return inner;
    const xml = clean(raw.xml).replace(/(<w:txbxContent[^>]*>)[\s\S]*?(<\/w:txbxContent>)/g, (m, a, b) => a + inner + b);
    return `<w:p><w:r>${xml}</w:r></w:p>`;
  }

  function writeP(p, st) {
    const items = [];
    const ps = p.getAttribute('data-ps');
    if (ps) items.push(['pStyle', `<w:pStyle w:val="${esc(ps)}"/>`]);
    if (p.classList.contains('li') && p.getAttribute('data-num'))
      items.push(['numPr', `<w:numPr><w:ilvl w:val="${+p.getAttribute('data-lvl') || 0}"/><w:numId w:val="${esc(p.getAttribute('data-num'))}"/></w:numPr>`]);
    const s = p.style;
    const sp = [];
    const pt = parseFloat(s.paddingTop),
      pb = parseFloat(s.paddingBottom);
    if (s.paddingTop && !isNaN(pt)) sp.push(`w:before="${Math.round(pt * 20)}"`);
    if (s.paddingBottom && !isNaN(pb)) sp.push(`w:after="${Math.round(pb * 20)}"`);
    if (s.lineHeight) {
      const lh = s.lineHeight;
      if (/px$/.test(lh)) sp.push(`w:line="${Math.round(parseFloat(lh) * 20)}" w:lineRule="exact"`);
      else if (!isNaN(parseFloat(lh))) sp.push(`w:line="${Math.round((parseFloat(lh) / st.factor(p)) * 240)}" w:lineRule="auto"`);
    }
    if (sp.length) items.push(['spacing', `<w:spacing ${sp.join(' ')}/>`]);
    const isLi = p.classList.contains('li') && !p.hasAttribute('data-pind');
    const ind = [];
    if (!isLi) {
      if (s.paddingLeft) ind.push(`w:left="${Math.round(parseFloat(s.paddingLeft) * 20)}"`);
      if (s.paddingRight) ind.push(`w:right="${Math.round(parseFloat(s.paddingRight) * 20)}"`);
      if (s.textIndent) {
        const ti = parseFloat(s.textIndent);
        if (ti > 0) ind.push(`w:firstLine="${Math.round(ti * 20)}"`);
        else if (ti < 0) ind.push(`w:hanging="${Math.round(-ti * 20)}"`);
      }
    } else if (s.paddingRight) ind.push(`w:right="${Math.round(parseFloat(s.paddingRight) * 20)}"`);
    if (ind.length) items.push(['ind', `<w:ind ${ind.join(' ')}/>`]);
    if (s.textAlign) items.push(['jc', `<w:jc w:val="${{ justify: 'both', center: 'center', right: 'right', left: 'left' }[s.textAlign] || 'left'}"/>`]);
    const raw = st.D.raw[p.getAttribute('data-raw')];
    if (raw && raw.items) for (const it of raw.items) if (!items.some((x) => x[0] === it[0])) items.push([it[0], clean(it[1])]);
    // a paragraph made by pressing Enter must not repeat a section break
    if (p.hasAttribute('data-nosect')) {
      const k = items.findIndex((x) => x[0] === 'sectPr');
      if (k >= 0) items.splice(k, 1);
    }
    items.sort(sortBy(P_ORDER));
    const pPr = items.length ? `<w:pPr>${items.map((x) => x[1]).join('')}</w:pPr>` : '';
    return `<w:p>${pPr}${writeInline(p, p, st)}</w:p>`;
  }

  /** runs for the inline content of a block */
  function writeInline(node, block, st) {
    let out = '';
    let pending = null; // [rPrXml, textXml]
    const flush = () => {
      if (pending) out += `<w:r>${pending[0]}${pending[1]}</w:r>`;
      pending = null;
    };
    const addText = (rpr, txt) => {
      const xml = txt
        .split('\t')
        .map((t) => (t ? `<w:t xml:space="preserve">${esc(t.replace(/ /g, ' '))}</w:t>` : ''))
        .join('<w:tab/>');
      if (pending && pending[0] === rpr) pending[1] += xml;
      else {
        flush();
        pending = [rpr, xml];
      }
    };
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          const t = c.nodeValue.replace(/[​﻿]/g, '');
          if (t) addText(rPrFor(c.parentNode, block, st), t);
        } else if (c.nodeType === 1) {
          const tag = c.tagName;
          const cls = c.classList;
          if (cls.contains('dm-lsp')) continue;
          if (tag === 'BR') {
            if (c === block.lastChild || (c.nextSibling == null && c.parentNode !== block && isLastIn(c, block))) continue; // placeholder
            flush();
            out += `<w:r>${rPrFor(c.parentNode, block, st)}<w:br/></w:r>`;
          } else if (cls.contains('dm-pbr')) {
            flush();
            out += '<w:r><w:br w:type="page"/></w:r>';
          } else if (cls.contains('dm-fn')) {
            flush();
            const kind = c.getAttribute('data-kind') === 'endnote' ? 'endnote' : 'footnote';
            out += `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Reference w:id="${esc(c.getAttribute('data-fn'))}"/></w:r>`;
          } else if (cls.contains('dm-field')) {
            flush();
            const f = c.getAttribute('data-f');
            out += `<w:r>${rPrFor(c.parentNode, block, st)}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rPrFor(c.parentNode, block, st)}<w:instrText xml:space="preserve"> ${f} </w:instrText></w:r><w:r>${rPrFor(c.parentNode, block, st)}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rPrFor(c.parentNode, block, st)}<w:t>${esc(c.textContent)}</w:t></w:r><w:r>${rPrFor(c.parentNode, block, st)}<w:fldChar w:fldCharType="end"/></w:r>`;
          } else if (tag === 'IMG') {
            flush();
            out += writeImage(c, st);
          } else if (tag === 'A' && (c.getAttribute('href') || c.getAttribute('data-anchor'))) {
            flush();
            let attr;
            if (c.getAttribute('data-anchor')) attr = `w:anchor="${esc(c.getAttribute('data-anchor'))}"`;
            else {
              const href = c.getAttribute('href');
              let id = c.getAttribute('data-rid');
              if (!id || !st.D.rels || !st.D.rels[id] || st.D.rels[id].target !== href) id = st.rel(REL_LINK, href, true);
              attr = `r:id="${id}"`;
            }
            const inner = writeInline(c, block, st);
            out += `<w:hyperlink ${attr}>${inner}</w:hyperlink>`;
          } else walk(c);
        }
      }
    };
    walk(node);
    flush();
    return out;
  }
  function isLastIn(c, block) {
    let n = c;
    while (n && n !== block) {
      if (n.nextSibling) return false;
      n = n.parentNode;
    }
    return true;
  }

  /** direct run formatting of a text node: inline styles of its ancestors up to the block */
  function rPrFor(el, block, st) {
    const chainEls = [];
    for (let n = el; n && n !== block && n.nodeType === 1; n = n.parentNode) chainEls.unshift(n);
    const o = {};
    let rawItems = null;
    for (const n of chainEls) {
      const s = n.style;
      const tag = n.tagName;
      if (tag === 'B' || tag === 'STRONG') o.b = true;
      if (tag === 'I' || tag === 'EM') o.i = true;
      if (tag === 'U') o.u = true;
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') o.strike = true;
      if (tag === 'SUP') o.vert = 'superscript';
      if (tag === 'SUB') o.vert = 'subscript';
      if (tag === 'TD') continue;
      if (!s) continue;
      if (n.getAttribute('data-font')) o.font = n.getAttribute('data-font');
      else if (s.fontFamily) {
        const m = s.fontFamily.match(/PEF-([a-z-]+)/);
        if (m) o.font = WORD_NAME[m[1]] || m[1];
      }
      if (s.fontSize && !(s.verticalAlign === 'super' || s.verticalAlign === 'sub')) o.sz = parseFloat(s.fontSize);
      if (s.fontWeight) o.b = +s.fontWeight >= 600 || s.fontWeight === 'bold';
      if (s.fontStyle) o.i = s.fontStyle === 'italic';
      const td = s.textDecorationLine || s.textDecoration;
      if (td) {
        if (/none/.test(td)) o.u = o.strike = false;
        if (/underline/.test(td)) o.u = true;
        if (/line-through/.test(td)) o.strike = true;
      }
      if (s.color) o.color = hex6(s.color);
      if (s.backgroundColor && !isTransparent(s.backgroundColor)) o.bg = hex6(s.backgroundColor);
      if (s.verticalAlign === 'super') o.vert = 'superscript';
      if (s.verticalAlign === 'sub') o.vert = 'subscript';
      if (s.textTransform === 'uppercase') o.caps = true;
      if (s.fontVariant === 'small-caps') o.smallCaps = true;
      if (n.getAttribute('data-raw') && st.D.raw[n.getAttribute('data-raw')] && st.D.raw[n.getAttribute('data-raw')].k === 'r') rawItems = st.D.raw[n.getAttribute('data-raw')].items;
    }
    // links keep their look in Word even without the Hyperlink style
    const items = [];
    if (o.font) items.push(['rFonts', `<w:rFonts w:ascii="${esc(o.font)}" w:hAnsi="${esc(o.font)}" w:cs="${esc(o.font)}"/>`]);
    if (o.b !== undefined) items.push(['b', o.b ? '<w:b/>' : '<w:b w:val="0"/>'], ['bCs', o.b ? '<w:bCs/>' : '<w:bCs w:val="0"/>']);
    if (o.i !== undefined) items.push(['i', o.i ? '<w:i/>' : '<w:i w:val="0"/>'], ['iCs', o.i ? '<w:iCs/>' : '<w:iCs w:val="0"/>']);
    if (o.caps) items.push(['caps', '<w:caps/>']);
    if (o.smallCaps) items.push(['smallCaps', '<w:smallCaps/>']);
    if (o.strike !== undefined) items.push(['strike', o.strike ? '<w:strike/>' : '<w:strike w:val="0"/>']);
    if (o.color) items.push(['color', `<w:color w:val="${o.color}"/>`]);
    if (o.sz) items.push(['sz', `<w:sz w:val="${Math.round(o.sz * 2)}"/>`], ['szCs', `<w:szCs w:val="${Math.round(o.sz * 2)}"/>`]);
    if (o.bg) {
      const hl = Object.keys(HIGHLIGHT).find((k) => HIGHLIGHT[k].slice(1).toUpperCase() === o.bg);
      if (hl) items.push(['highlight', `<w:highlight w:val="${hl}"/>`]);
      else items.push(['shd', `<w:shd w:val="clear" w:color="auto" w:fill="${o.bg}"/>`]);
    }
    if (o.u !== undefined) items.push(['u', `<w:u w:val="${o.u ? 'single' : 'none'}"/>`]);
    if (o.vert) items.push(['vertAlign', `<w:vertAlign w:val="${o.vert}"/>`]);
    if (rawItems) for (const it of rawItems) if (!items.some((x) => x[0] === it[0])) items.push([it[0], clean(it[1])]);
    if (!items.length) return '';
    items.sort(sortBy(R_ORDER));
    return `<w:rPr>${items.map((x) => x[1]).join('')}</w:rPr>`;
  }

  function writeImage(img, st) {
    const raw = st.D.raw[img.getAttribute('data-raw')];
    const w = parseFloat(img.style.width) || img.width,
      h = parseFloat(img.style.height) || img.height;
    if (raw && raw.k === 'img' && raw.w === img.style.width && raw.h === img.style.height && !img.hasAttribute('data-moved'))
      return `<w:r>${clean(raw.rpr || '')}${clean(raw.xml)}</w:r>`;
    const m = st.D.media[img.getAttribute('data-m')];
    if (!m) return '';
    let id = m.rid;
    if (!id) {
      if (!m.newPath) {
        const ext = m.mime === 'image/jpeg' ? 'jpeg' : m.mime === 'image/gif' ? 'gif' : 'png';
        m.newPath = 'word/media/folio_' + img.getAttribute('data-m') + '.' + ext;
      }
      if (!st.mediaFiles.some((f) => f.path === m.newPath)) st.mediaFiles.push({ path: m.newPath, bytes: m.bytes });
      id = m.relId && st.D.rels && st.D.rels[m.relId] ? m.relId : st.rel(REL_IMG, m.newPath.replace(/^word\//, ''));
      m.relId = id;
    }
    const cx = Math.round(w * 12700),
      cy = Math.round(h * 12700);
    const n = st.docPr++;
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="${n}" name="Picture ${n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    );
  }

  function writeTable(t, st) {
    const raw = st.D.raw[t.getAttribute('data-raw')];
    const cols = Array.from(t.querySelectorAll(':scope > colgroup > col')).map((c) => parseFloat(c.style.width) || 0);
    const rows = Array.from(t.querySelectorAll(':scope > tbody > tr, :scope > tr'));
    let tblPr;
    if (raw && raw.xml) {
      tblPr = clean(raw.xml);
      // width follows the columns
      const tot = Math.round(cols.reduce((a, b) => a + b, 0) * 20);
      if (tot) tblPr = tblPr.replace(/<w:tblW [^>]*\/>/, `<w:tblW w:w="${tot}" w:type="dxa"/>`);
    } else {
      const ts = t.getAttribute('data-ts');
      const borders = ts
        ? ''
        : '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('') + '</w:tblBorders>';
      tblPr = `<w:tblPr>${ts ? `<w:tblStyle w:val="${esc(ts)}"/>` : ''}<w:tblW w:w="${Math.round(cols.reduce((a, b) => a + b, 0) * 20)}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`;
    }
    const grid = '<w:tblGrid>' + cols.map((w) => `<w:gridCol w:w="${Math.round(w * 20)}"/>`).join('') + '</w:tblGrid>';
    // occupancy grid for row spans (vMerge)
    const spans = []; // per grid col: {left: rows remaining, td}
    let body = '';
    rows.forEach((tr) => {
      const trRaw = st.D.raw[tr.getAttribute('data-raw')];
      let trPr = trRaw ? clean(trRaw.xml) : '';
      if (tr.style.height && !trRaw) trPr = `<w:trPr><w:trHeight w:val="${Math.round(parseFloat(tr.style.height) * 20)}"/></w:trPr>`;
      let cells = '';
      let g = 0;
      const tds = Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
      let k = 0;
      const emitCont = () => {
        while (spans[g] && spans[g].left > 0) {
          const s = spans[g];
          s.left--;
          cells += `<w:tc><w:tcPr>${tcPrXml(s.td, cols, g, s.span, '<w:vMerge/>', st)}</w:tcPr><w:p/></w:tc>`;
          g += s.span;
        }
      };
      emitCont();
      for (; k < tds.length; k++) {
        const td = tds[k];
        const span = td.colSpan || 1;
        const rs = td.rowSpan || 1;
        const vm = rs > 1 ? '<w:vMerge w:val="restart"/>' : '';
        if (rs > 1) spans[g] = { left: rs - 1, td, span };
        else spans[g] = null;
        let inner = writeBlocks(td, st);
        // a cell must end with a paragraph
        if (!/<\/w:p>$|<w:p\/>$/.test(inner.trim())) inner += '<w:p/>';
        cells += `<w:tc><w:tcPr>${tcPrXml(td, cols, g, span, vm, st)}</w:tcPr>${inner}</w:tc>`;
        g += span;
        emitCont();
      }
      body += `<w:tr>${trPr}${cells}</w:tr>`;
    });
    return `<w:tbl>${tblPr}${grid}${body}</w:tbl>`;
  }
  function tcPrXml(td, cols, g, span, vm, st) {
    const w = cols.slice(g, g + span).reduce((a, b) => a + b, 0);
    const items = [['tcW', `<w:tcW w:w="${Math.round(w * 20)}" w:type="dxa"/>`]];
    if (span > 1) items.push(['gridSpan', `<w:gridSpan w:val="${span}"/>`]);
    if (vm) items.push(['vMerge', vm]);
    const raw = st.D.raw[td.getAttribute('data-raw')];
    if (raw && raw.items) for (const it of raw.items) items.push([it[0], clean(it[1])]);
    else if (!raw) {
      // cells made in the editor: borders and shading from the cell's own style
      const s = td.style;
      if (s.borderTopStyle || s.borderLeftStyle || s.borderBottomStyle || s.borderRightStyle) {
        let bx = '';
        for (const [side, w] of [['top', 'Top'], ['left', 'Left'], ['bottom', 'Bottom'], ['right', 'Right']]) {
          const st = s['border' + w + 'Style'];
          if (!st || st === 'none' || st === 'hidden' || parseFloat(s['border' + w + 'Width']) === 0) {
            bx += `<w:${side} w:val="nil"/>`;
            continue;
          }
          const wd = parseFloat(s['border' + w + 'Width']) || 0.5;
          const val = st === 'double' ? 'double' : st === 'dotted' ? 'dotted' : st === 'dashed' ? 'dashed' : 'single';
          bx += `<w:${side} w:val="${val}" w:sz="${Math.max(2, Math.round((st === 'double' ? wd / 3 : wd) * 8))}" w:space="0" w:color="${hex6(s['border' + w + 'Color']) || '000000'}"/>`;
        }
        items.push(['tcBorders', `<w:tcBorders>${bx}</w:tcBorders>`]);
      }
      const bg = td.style.backgroundColor;
      if (bg && !isTransparent(bg)) items.push(['shd', `<w:shd w:val="clear" w:color="auto" w:fill="${hex6(bg)}"/>`]);
      const va = td.style.verticalAlign;
      if (va === 'middle' || va === 'bottom') items.push(['vAlign', `<w:vAlign w:val="${va === 'middle' ? 'center' : 'bottom'}"/>`]);
    }
    items.sort(sortBy(TC_ORDER));
    return items.map((x) => x[1]).join('');
  }

  /** list definitions added in the editor (bullets / numbers) */
  function numberingXml(D) {
    let abs = '',
      nums = '';
    for (const a of D.added) {
      const lvls = [];
      for (let l = 0; l < 9; l++) {
        const left = 720 * (l + 1);
        if (a.kind === 'bullet') {
          const ch = ['•', '○', '▪'][l % 3];
          lvls.push(`<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${ch}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`);
        } else {
          const fmt = ['decimal', 'lowerLetter', 'lowerRoman'][l % 3];
          lvls.push(`<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`);
        }
      }
      abs += `<w:abstractNum w:abstractNumId="${a.abs}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls.join('')}</w:abstractNum>`;
      nums += `<w:num w:numId="${a.num}"><w:abstractNumId w:val="${a.abs}"/></w:num>`;
    }
    return { abs, nums };
  }
  /** register a new bullet / numbered list definition; returns its numId */
  PE.docx.addList = function (D, kind) {
    const have = D.added.find((a) => a.kind === kind);
    if (have) return have.num;
    const absIds = Object.keys(D.N.abs).map(Number);
    const numIds = Object.keys(D.N.nums).map(Number);
    const abs = String(Math.max(900, ...absIds) + 1);
    const n = String(Math.max(900, ...numIds) + 1);
    const lv = {};
    for (let l = 0; l < 9; l++)
      lv[l] =
        kind === 'bullet'
          ? { start: 1, fmt: 'bullet', text: ['•', '○', '▪'][l % 3], left: 36 * (l + 1), hang: 18, font: null }
          : { start: 1, fmt: ['decimal', 'lowerLetter', 'lowerRoman'][l % 3], text: `%${l + 1}.`, left: 36 * (l + 1), hang: 18, font: null };
    D.N.abs[abs] = { lvls: lv };
    D.N.nums[n] = { abs, over: {} };
    D.added.push({ kind, abs, num: n });
    return n;
  };

  /**
   * Build the .docx bytes from the editor content.
   * `body` is the editor's root element (pagination spacers are ignored).
   */
  PE.docx.write = async function (D, body) {
    let zip = D.pkg;
    if (!zip) {
      zip = await JSZip.loadAsync(await PE.docx.blank());
      D.pkg = zip;
      D.mainPart = 'word/document.xml';
      D.rels = relsOf(await textOf(zip, 'word/_rels/document.xml.rels'));
    }
    const main = D.mainPart || 'word/document.xml';
    const st = writer(D);
    let bodyXml = writeBlocks(body, st);
    if (!bodyXml) bodyXml = '<w:p/>';
    let sect = D.sectXml ? clean(D.sectXml) : '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
    // page numbers added in the editor: a footer with a PAGE field
    if (D.pageNumbers && !/<w:footerReference[^>]*w:type="default"/.test(sect)) {
      const fpath = 'word/folio_footer1.xml';
      const align = D.pageNumbers === true ? 'center' : D.pageNumbers;
      zip.file(
        fpath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${NS}><w:p><w:pPr><w:jc w:val="${align}"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`
      );
      const fid = st.rel(REL_FOOTER, 'folio_footer1.xml');
      sect = sect.replace(/<w:sectPr([^>]*)>/, `<w:sectPr$1><w:footerReference w:type="default" r:id="${fid}"/>`);
      st.ctOverride = st.ctOverride || [];
      st.ctOverride.push(['/word/folio_footer1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml']);
    }
    let root = D.rootTag || `<w:document ${NS}>`;
    // make sure the namespaces used by pictures and links are declared
    for (const [p, uri] of [
      ['r', R],
      ['wp', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'],
      ['a', 'http://schemas.openxmlformats.org/drawingml/2006/main'],
      ['pic', 'http://schemas.openxmlformats.org/drawingml/2006/picture'],
    ])
      if (!new RegExp(`xmlns:${p}=`).test(root)) root = root.replace(/>$/, ` xmlns:${p}="${uri}">`);
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${root}${D.bgXml ? clean(D.bgXml) : ''}<w:body>${bodyXml}${sect}</w:body></w:document>`;
    zip.file(main, xml);
    for (const f of st.mediaFiles) zip.file(f.path, f.bytes);
    // numbering for lists made here
    if (D.added.length) {
      const { abs, nums } = numberingXml(D);
      let numPath = null;
      for (const id in D.rels || {}) if (D.rels[id].type === REL_NUM) numPath = joinPath(main, D.rels[id].target);
      if (numPath && zip.file(numPath)) {
        let nx = D.numOrig;
        if (nx == null) nx = D.numOrig = await zip.file(numPath).async('string');
        let out = nx;
        if (/<w:num[ >]/.test(out)) out = out.replace(/<w:num[ >]/, (m) => abs + m);
        else out = out.replace(/<\/w:numbering>/, abs + '</w:numbering>');
        out = out.replace(/<\/w:numbering>/, nums + '</w:numbering>');
        if (/<w:numbering[^>]*\/>/.test(out)) out = out.replace(/<w:numbering([^>]*)\/>/, `<w:numbering$1>${abs}${nums}</w:numbering>`);
        zip.file(numPath, out);
      } else {
        zip.file('word/numbering.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W}">${abs}${nums}</w:numbering>`);
        st.rel(REL_NUM, 'numbering.xml');
        st.ctOverride = st.ctOverride || [];
        st.ctOverride.push(['/word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml']);
      }
    }
    // relationships
    if (st.newRels.length) {
      const rp = relsPath(main);
      let rx = (await textOf(zip, rp)) || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
      const add = st.newRels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('');
      rx = rx.replace(/<\/Relationships>/, add + '</Relationships>');
      zip.file(rp, rx);
      D.rels = relsOf(rx);
      for (const r of st.newRels) if (r.type === REL_IMG) for (const k in D.media) if (D.media[k].relId === r.id) D.media[k].rid = r.id;
    }
    // content types for new media / parts
    let ct = await textOf(zip, '[Content_Types].xml');
    for (const [ext, type] of [
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
      ['jpg', 'image/jpeg'],
      ['gif', 'image/gif'],
    ])
      if (st.mediaFiles.some((f) => f.path.endsWith('.' + ext)) && !new RegExp(`Extension="${ext}"`, 'i').test(ct)) ct = ct.replace('<Default ', `<Default Extension="${ext}" ContentType="${type}"/><Default `);
    for (const [p, type] of st.ctOverride || []) if (!ct.includes(`PartName="${p}"`)) ct = ct.replace('</Types>', `<Override PartName="${p}" ContentType="${type}"/></Types>`);
    zip.file('[Content_Types].xml', ct);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  };
})();
