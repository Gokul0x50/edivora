/* Edivora — Word document mode: a page-based rich text editor for .docx files.
 * Text flows across pages like a word processor: paragraphs that don't fit move to the next page,
 * and long paragraphs are split between pages at a line. Saves as .docx (keeping the original file's
 * styles, headers, footers and anything not edited) or as PDF.
 */
'use strict';
(function () {
  const $ = PE.$,
    h = PE.h;
  const GAP = 24; // space between pages (pt)
  const ZWSP = '​';
  const Doc = (PE.doc = { active: false, D: null, zoom: 1 });
  let els = null; // DOM refs
  let pageCount = 1;

  /* =================================================================
   *  opening / closing
   * ================================================================= */
  Doc.open = async function (D, opts = {}) {
    if (PE.app.showOriginal) PE.app.showOriginal(false);
    Doc._edited = null;
    Doc.D = D;
    Doc.active = true;
    if (D.origHtml == null) D.origHtml = D.html || '';
    document.body.classList.add('mode-doc');
    $('#app').classList.remove('no-doc');
    build();
    $('#dm-css').textContent = D.css || '';
    els.body.innerHTML = D.html || '<p><br></p>';
    els.body.style.tabSize = (D.tab || 36) + 'px';
    // phones get a reading layout: text reflows to the screen width at a readable size
    Doc.web = matchMedia('(max-width: 600px)').matches;
    document.body.classList.toggle('dm-webview', Doc.web);
    sizePages();
    await loadFonts(D.fams);
    PE.docx.renumber(els.body, D.N);
    paginate();
    hist.reset();
    PE.app.dirty = !!opts.dirty;
    fillStyleSelect();
    PE.ui.updateHistoryButtons();
    await PE.raf();
    Doc.fitWidth();
    els.scroller.scrollTop = 0;
    placeCaretAtStart();
    updateBar();
    if (!opts.quiet) PE.app.setFileName(D.name);
  };
  Doc.close = function () {
    if (!els) return;
    Doc.active = false;
    Doc.D = null;
    document.body.classList.remove('mode-doc');
    els.body.innerHTML = '';
    els.sheets.innerHTML = '';
    hist.reset();
  };
  function placeCaretAtStart() {
    const p = els.body.querySelector('p');
    if (!p) return;
    const r = document.createRange();
    r.setStart(p, 0);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  async function loadFonts(fams) {
    const ps = [];
    for (const f of new Set((fams || []).concat(['carlito']))) {
      if (!PE.fonts.famByKey[f]) continue;
      for (const [b, i] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ])
        ps.push(PE.fonts.ensure(f, b, i));
    }
    await Promise.race([Promise.all(ps), PE.sleep(4000)]);
    await document.fonts.ready;
  }

  /* =================================================================
   *  DOM
   * ================================================================= */
  function build() {
    if (els) return;
    const view = $('#doc-view');
    const scroller = h('div', { class: 'dm-scroller', id: 'dm-scroller', tabindex: '-1' });
    const wrap = h('div', { class: 'dm-zoomwrap' });
    const pages = h('div', { class: 'dm-pages' });
    const sheets = h('div', { class: 'dm-sheets', 'aria-hidden': 'true' });
    const body = h('div', { class: 'dm-body', contenteditable: 'true', spellcheck: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Document' });
    const ui = h('div', { class: 'dm-ui' });
    pages.append(sheets, body, ui);
    wrap.appendChild(pages);
    scroller.appendChild(wrap);
    view.appendChild(scroller);
    els = { view, scroller, wrap, pages, sheets, body, ui };
    body.addEventListener('keydown', onKey);
    body.addEventListener('beforeinput', onBeforeInput);
    body.addEventListener('input', onInput);
    body.addEventListener('paste', onPaste);
    body.addEventListener('drop', onDrop);
    body.addEventListener('pointerdown', onPointer);
    body.addEventListener('click', onClick);
    document.addEventListener('selectionchange', () => {
      if (!Doc.active) return;
      const s = getSelection();
      if (s.rangeCount && els.body.contains(s.anchorNode)) {
        saveRange();
        updateBarSoon();
      }
    });
    PE.fonts.onLoad(() => Doc.active && paginateSoon());
    window.addEventListener(
      'resize',
      PE.debounce(() => {
        if (!Doc.active) return;
        if (Doc.web) {
          sizePages();
          paginate();
        }
        positionImageUi();
      }, 150)
    );
    wireBar();
  }

  const WEB_PAD = 14;
  function sizePages() {
    const P = Doc.D.page;
    if (Doc.web) {
      const cw = Math.max(160, els.scroller.clientWidth / Doc.zoom - 2 * WEB_PAD);
      els.body.style.left = WEB_PAD + 'px';
      els.body.style.top = WEB_PAD + 'px';
      els.body.style.width = cw + 'px';
      els.pages.style.width = cw + 2 * WEB_PAD + 'px';
    } else {
      els.body.style.left = P.ml + 'px';
      els.body.style.top = P.mt + 'px';
      els.body.style.width = P.w - P.ml - P.mr + 'px';
      els.pages.style.width = P.w + 'px';
    }
    applyZoom();
  }
  function applyZoom() {
    const P = Doc.D.page;
    const z = Doc.zoom;
    els.pages.style.transform = `scale(${z})`;
    if (Doc.web) {
      const w = parseFloat(els.pages.style.width);
      const hgt = els.body.offsetHeight + 2 * WEB_PAD;
      els.pages.style.height = hgt + 'px';
      els.wrap.style.width = w * z + 'px';
      els.wrap.style.height = hgt * z + 'px';
      const s = els.sheets.firstChild;
      if (s) Object.assign(s.style, { width: w + 'px', height: hgt + 'px', top: '0px' });
      if (Doc.active) $('#btn-zoom').textContent = Math.round(z * 100) + '%';
      positionImageUi();
      return;
    }
    const hgt = pageCount * (P.h + GAP) - GAP;
    els.pages.style.height = hgt + 'px';
    els.wrap.style.width = P.w * z + 'px';
    els.wrap.style.height = hgt * z + 'px';
    if (PE.ui && Doc.active) $('#btn-zoom').textContent = Math.round(z * 100) + '%';
    positionImageUi();
  }
  Doc.setZoom = function (z) {
    z = PE.clamp(z, 0.3, 4);
    const sc = els.scroller;
    const fy = sc.scrollTop / Math.max(1, sc.scrollHeight);
    Doc.zoom = z;
    if (Doc.web) {
      sizePages();
      paginate();
    } else applyZoom();
    sc.scrollTop = fy * sc.scrollHeight;
  };
  Doc.fitWidth = function () {
    if (Doc.web) return Doc.setZoom(1.15);
    const avail = els.scroller.clientWidth - (window.innerWidth < 720 ? 16 : 64);
    Doc.setZoom(PE.clamp(avail / Doc.D.page.w, 0.3, 1.25));
  };
  /** switch between the page layout and the phone reading layout */
  Doc.setLayout = function (web) {
    const sel = saveSel();
    Doc.web = !!web;
    document.body.classList.toggle('dm-webview', Doc.web);
    pageCount = -1;
    sizePages();
    paginate();
    Doc.fitWidth();
    if (sel) restoreSel(sel);
    PE.toast(Doc.web ? 'Mobile view: text fits your screen. Downloads still use the real page layout.' : 'Page view: pages as they will print.', 'info');
  };

  /* =================================================================
   *  pagination: blocks that cross a page end move to the next page,
   *  long paragraphs break at a line
   * ================================================================= */
  const paginateSoon = PE.debounce(() => paginate(), 90);
  function clearPagination(root) {
    root.querySelectorAll('.dm-lsp').forEach((n) => n.remove());
    root.querySelectorAll('[data-push]').forEach((n) => {
      n.style.removeProperty('--push');
      n.removeAttribute('data-push');
    });
  }
  function paginate() {
    if (!Doc.active) return;
    if (Doc.web) {
      const s0 = getSelection();
      const si = s0.rangeCount && els.body.contains(s0.anchorNode) ? saveSel() : null;
      clearPagination(els.body);
      if (si && els.body.querySelector('.dm-lsp') === null) restoreSel(si);
      if (els.sheets.children.length !== 1 || pageCount !== 1) {
        pageCount = 1;
        els.sheets.innerHTML = '';
        els.sheets.appendChild(h('div', { class: 'dm-sheet' }));
      }
      applyZoom();
      const pc = $('#dm-pagecount');
      if (pc) pc.textContent = 'Mobile view';
      return;
    }
    const D = Doc.D,
      P = D.page;
    const CH = P.h - P.mt - P.mb; // content height of a page
    const PH = P.h + GAP;
    const body = els.body;
    // keep the selection across the DOM changes below
    const sel = getSelection();
    const selInfo = sel.rangeCount && body.contains(sel.anchorNode) ? saveSel() : null;
    clearPagination(body);
    const blocks = Array.from(body.children);
    const bodyTop = body.getBoundingClientRect().top;
    const z = Doc.zoom;
    const geo = blocks.map((b) => {
      const r = b.getBoundingClientRect();
      return { el: b, top: (r.top - bodyTop) / z, h: r.height / z };
    });
    const pushes = [];
    const splits = [];
    let add = 0;
    let forceNext = false;
    const startOf = (k) => k * PH;
    const keepSet = new Set(D.keep || []);
    const keeps = (el) => el && el.tagName === 'P' && keepSet.has(el.getAttribute('data-ps') || '');
    const pushed = new Set();
    for (let gi = 0; gi < geo.length; gi++) {
      const g = geo[gi];
      const top = g.top + add;
      const bot = top + g.h;
      let k = Math.max(0, Math.floor(top / PH));
      const end = startOf(k) + CH;
      if (g.el.classList.contains('dm-pb')) {
        forceNext = true;
        continue;
      }
      if (forceNext) {
        forceNext = false;
        const target = startOf(top >= end ? k + 1 : k + 1);
        const d = target - top;
        if (d > 0) {
          pushes.push([g.el, d]);
          add += d;
        }
        continue;
      }
      if (top >= end - 0.5) {
        // starts in the gap between pages
        const d = startOf(k + 1) - top;
        pushes.push([g.el, d]);
        add += d;
        continue;
      }
      if (bot > end + 0.5) {
        // crosses the end of the page
        if (g.el.tagName === 'P' && g.h > 30) {
          const line = lineBreakFor(g.el, (end - add) * z + bodyTop, z);
          if (line) {
            const d = startOf(k + 1) - (line.top - bodyTop) / z - add;
            if (d > 0 && d < CH) {
              splits.push([line, d]);
              add += d;
              // the rest of a very long paragraph may cross more pages
              let rest = bot + d;
              let kk = k + 1;
              while (rest > startOf(kk) + CH + 0.5 && kk < k + 40) {
                const lineN = lineBreakFor(g.el, (startOf(kk) + CH - add) * z + bodyTop, z);
                if (!lineN) break;
                const dn = startOf(kk + 1) - (lineN.top - bodyTop) / z - add;
                if (!(dn > 0 && dn < CH)) break;
                splits.push([lineN, dn]);
                add += dn;
                rest += dn;
                kk++;
              }
              continue;
            }
          }
        }
        if (g.h <= CH && top > startOf(k) + 0.5) {
          // a heading stays with the paragraph after it
          const prev = geo[gi - 1];
          if (prev && keeps(prev.el) && !pushed.has(prev.el)) {
            const ptop = prev.top + add;
            if (ptop > startOf(k) + 0.5 && ptop < end) {
              const d = startOf(k + 1) - ptop;
              pushes.push([prev.el, d]);
              pushed.add(prev.el);
              add += d;
              continue;
            }
          }
          const d = startOf(k + 1) - top;
          pushes.push([g.el, d]);
          pushed.add(g.el);
          add += d;
        }
      }
    }
    for (const [el, d] of pushes) {
      el.setAttribute('data-push', '1');
      el.style.setProperty('--push', d + 'px');
    }
    for (const [line, d] of splits) {
      const sp = h('span', { class: 'dm-lsp', contenteditable: 'false', style: { height: d + 'px' } });
      insertAt(line.node, line.offset, sp);
    }
    // page count from where the last content ends
    const last = blocks[blocks.length - 1];
    let total = 1;
    if (last) {
      const r = last.getBoundingClientRect();
      const bottom = (r.bottom - bodyTop) / z;
      total = Math.max(1, Math.floor(Math.max(0, bottom - 1) / PH) + 1);
    }
    if (total !== pageCount || els.sheets.children.length !== total) {
      pageCount = total;
      renderSheets();
      applyZoom();
    } else updateFields();
    if (selInfo) restoreSel(selInfo);
    positionImageUi();
    const pc = $('#dm-pagecount');
    if (pc) pc.textContent = pageCount === 1 ? '1 page' : pageCount + ' pages';
  }
  /** text position where the line that crosses y (client coords) starts */
  function lineBreakFor(p, yClient, z) {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) if (n.nodeValue.length && !n.parentNode.closest('.dm-lsp,.dm-field,.dm-fn')) nodes.push(n);
    if (!nodes.length) return null;
    const range = document.createRange();
    const rectOf = (node, i) => {
      range.setStart(node, i);
      range.setEnd(node, Math.min(node.nodeValue.length, i + 1));
      const rs = range.getClientRects();
      return rs[0] || null;
    };
    // the first character whose line bottom passes y
    let found = null;
    for (const node of nodes) {
      const len = node.nodeValue.length;
      const lastR = rectOf(node, len - 1);
      if (!lastR || lastR.bottom <= yClient) continue;
      let lo = 0,
        hi = len - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const r = rectOf(node, mid);
        if (r && r.bottom > yClient) hi = mid;
        else lo = mid + 1;
      }
      const r = rectOf(node, lo);
      found = { node, offset: lo, top: r ? r.top : yClient };
      break;
    }
    if (!found) return null;
    // move to the start of that visual line
    const lineTop = found.top;
    let { node, offset } = found;
    let idx = nodes.indexOf(node);
    for (;;) {
      if (offset > 0) {
        const r = rectOf(node, offset - 1);
        if (r && Math.abs(r.top - lineTop) < 2) {
          offset--;
          continue;
        }
        break;
      }
      if (idx > 0) {
        const prev = nodes[idx - 1];
        const r = rectOf(prev, prev.nodeValue.length - 1);
        if (r && Math.abs(r.top - lineTop) < 2) {
          idx--;
          node = prev;
          offset = prev.nodeValue.length - 1;
          continue;
        }
      }
      break;
    }
    // the very first line: move the whole paragraph instead
    const first = nodes[0];
    if (node === first && offset === 0) return null;
    const lr = rectOf(node, offset);
    return { node, offset, top: lr ? lr.top : lineTop };
  }
  function insertAt(node, offset, el) {
    if (offset <= 0) node.parentNode.insertBefore(el, node);
    else if (offset >= node.nodeValue.length) node.parentNode.insertBefore(el, node.nextSibling);
    else {
      const rest = node.splitText(offset);
      rest.parentNode.insertBefore(el, rest);
    }
  }

  function renderSheets() {
    const D = Doc.D,
      P = D.page;
    els.sheets.innerHTML = '';
    for (let k = 0; k < pageCount; k++) {
      const s = h('div', { class: 'dm-sheet', style: { top: k * (P.h + GAP) + 'px', width: P.w + 'px', height: P.h + 'px' } });
      const hdr = (k === 0 && D.titlePg ? D.hdr.first : D.hdr.default) || '';
      let ftr = (k === 0 && D.titlePg ? D.ftr.first : D.ftr.default) || '';
      if (!ftr && D.pageNumbers) ftr = `<p style="text-align:${D.pageNumbers === true ? 'center' : D.pageNumbers}"><span class="dm-field" data-f="PAGE">1</span></p>`;
      if (hdr) s.appendChild(h('div', { class: 'dm-hdr', html: hdr, style: { left: P.ml + 'px', top: P.hd + 'px', width: P.w - P.ml - P.mr + 'px' } }));
      if (ftr) s.appendChild(h('div', { class: 'dm-ftr', html: ftr, style: { left: P.ml + 'px', bottom: P.fd + 'px', width: P.w - P.ml - P.mr + 'px' } }));
      s.setAttribute('data-n', k + 1);
      els.sheets.appendChild(s);
    }
    updateFields();
  }
  function updateFields() {
    PE.$$('.dm-sheet', els.sheets).forEach((s, k) => {
      s.querySelectorAll('.dm-field').forEach((f) => (f.textContent = f.getAttribute('data-f') === 'NUMPAGES' ? pageCount : k + 1));
    });
  }

  /* =================================================================
   *  selection helpers
   * ================================================================= */
  const isBlock = (n) => n && n.nodeType === 1 && (n.tagName === 'P' || n.classList.contains('dm-pb'));
  function blockOf(node) {
    for (let n = node; n && n !== els.body; n = n.parentNode) if (n.nodeType === 1 && n.tagName === 'P') return n;
    return null;
  }
  let lastRange = null;
  function saveRange() {
    const s = getSelection();
    if (s.rangeCount && els.body.contains(s.anchorNode)) lastRange = s.getRangeAt(0).cloneRange();
  }
  function curRange() {
    const s = getSelection();
    if (s.rangeCount && els.body.contains(s.anchorNode)) return s.getRangeAt(0);
    if (lastRange && els.body.contains(lastRange.startContainer)) {
      s.removeAllRanges();
      s.addRange(lastRange);
      return s.getRangeAt(0);
    }
    return null;
  }
  function selectedBlocks(r) {
    r = r || curRange();
    if (!r) return [];
    const all = Array.from(els.body.querySelectorAll('p'));
    const out = all.filter((p) => r.intersectsNode(p) && !p.closest('.dm-hdr,.dm-ftr'));
    // ignore a paragraph the selection only touches at its very start
    if (out.length > 1 && !r.collapsed) {
      const last = out[out.length - 1];
      const t = document.createRange();
      t.selectNodeContents(last);
      if (r.compareBoundaryPoints(Range.END_TO_START, t) === 0) out.pop();
    }
    if (!out.length) {
      const b = blockOf(r.startContainer);
      if (b) out.push(b);
    }
    return out;
  }
  /** position as (paragraph index, characters before the caret) so it survives HTML rebuilds */
  function saveSel() {
    const s = getSelection();
    if (!s.rangeCount) return null;
    const r = s.getRangeAt(0);
    const pt = (node, off) => {
      const ps = Array.from(els.body.querySelectorAll('p'));
      const p = blockOf(node);
      const i = ps.indexOf(p);
      if (i < 0) return null;
      const t = document.createRange();
      t.setStart(p, 0);
      try {
        t.setEnd(node, off);
      } catch (e) {
        return { i, o: 0 };
      }
      return { i, o: t.toString().length };
    };
    return { a: pt(r.startContainer, r.startOffset), b: pt(r.endContainer, r.endOffset) };
  }
  function locate(pt) {
    const ps = Array.from(els.body.querySelectorAll('p'));
    const p = ps[PE.clamp(pt.i, 0, ps.length - 1)];
    if (!p) return null;
    let left = pt.o;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n,
      last = null;
    while ((n = walker.nextNode())) {
      last = n;
      if (left <= n.nodeValue.length) return [n, left];
      left -= n.nodeValue.length;
    }
    if (last) return [last, last.nodeValue.length];
    return [p, 0];
  }
  function restoreSel(info) {
    if (!info || !info.a) return;
    const a = locate(info.a),
      b = info.b ? locate(info.b) : a;
    if (!a) return;
    const r = document.createRange();
    try {
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
    } catch (e) {
      r.setStart(a[0], a[1]);
      r.collapse(true);
    }
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  /* =================================================================
   *  history (snapshots of the content)
   * ================================================================= */
  const hist = {
    stack: [],
    idx: -1,
    reset() {
      this.stack = [];
      this.idx = -1;
      if (els && Doc.active) this.push(true);
    },
    snapshot() {
      if (Doc._edited != null) return Doc._edited; // the original is on screen; the edits are kept aside
      const c = els.body.cloneNode(true);
      clearPagination(c);
      return c.innerHTML;
    },
    push(initial) {
      const html = this.snapshot();
      if (!initial && this.stack[this.idx] && this.stack[this.idx].html === html) return;
      this.stack.length = this.idx + 1;
      this.stack.push({ html, sel: saveSel(), N: JSON.stringify(Doc.D.N), added: JSON.stringify(Doc.D.added), pn: Doc.D.pageNumbers });
      if (this.stack.length > 120) this.stack.shift();
      this.idx = this.stack.length - 1;
      if (!initial) changed();
      PE.ui.updateHistoryButtons();
    },
    go(d) {
      commitNow();
      const k = this.idx + d;
      if (k < 0 || k >= this.stack.length) return;
      // the caret goes back to where the undone change was made
      const selFrom = d < 0 ? this.stack[this.idx].sel : this.stack[k].sel;
      this.idx = k;
      const s = this.stack[k];
      els.body.innerHTML = s.html;
      Doc.D.N = JSON.parse(s.N);
      Doc.D.added = JSON.parse(s.added);
      Doc.D.pageNumbers = s.pn;
      PE.docx.renumber(els.body, Doc.D.N);
      deselectImage();
      paginate();
      els.body.focus({ preventScroll: true });
      restoreSel(selFrom);
      changed();
      PE.ui.updateHistoryButtons();
      updateBar();
    },
  };
  Doc.hist = {
    canUndo: () => hist.idx > 0 || commitSoon.pending,
    canRedo: () => hist.idx < hist.stack.length - 1,
  };
  Doc.undo = () => hist.go(-1);
  Doc.redo = () => hist.go(1);
  const commitSoon = PE.debounce(() => {
    commitSoon.pending = false;
    hist.push();
  }, 700);
  function commitNow() {
    if (commitSoon.pending) {
      commitSoon.cancel();
      commitSoon.pending = false;
      hist.push();
    }
  }
  function changed() {
    PE.app.dirty = true;
    PE.ui.updateHistoryButtons();
    autosave();
  }
  /** after any programmatic edit */
  function edited(renumber) {
    if (renumber) PE.docx.renumber(els.body, Doc.D.N);
    paginate();
    hist.push();
    updateBar();
  }

  /* =================================================================
   *  autosave (IndexedDB)
   * ================================================================= */
  const autosave = PE.debounce(async () => {
    if (!Doc.active) return;
    try {
      const D = Doc.D;
      const pkg = D.pkg ? await D.pkg.generateAsync({ type: 'uint8array' }) : null;
      const media = {};
      for (const k in D.media) media[k] = { bytes: D.media[k].bytes, mime: D.media[k].mime, path: D.media[k].path, rid: D.media[k].rid, newPath: D.media[k].newPath, relId: D.media[k].relId };
      const state = Object.assign({}, D, { pkg: null, media, html: hist.snapshot() });
      await PE.idb.set('docsession', { time: Date.now(), name: PE.app.fileName, state, pkg });
    } catch (e) {
      console.warn('autosave', e);
    }
  }, 1500);
  Doc.flushAutosave = () => autosave.flush();
  Doc.loadSession = async function () {
    const s = await PE.idb.get('docsession');
    if (!s) return false;
    const D = s.state;
    D.pkg = s.pkg ? await JSZip.loadAsync(s.pkg) : null;
    for (const k in D.media) {
      const m = D.media[k];
      m.url = URL.createObjectURL(new Blob([m.bytes], { type: m.mime }));
    }
    // image sources were blob URLs of the previous session
    const host = h('div', { html: D.html });
    host.querySelectorAll('img[data-m]').forEach((im) => {
      const m = D.media[im.getAttribute('data-m')];
      if (m) im.setAttribute('src', m.url);
    });
    D.html = host.innerHTML;
    D.name = s.name || D.name;
    await Doc.open(D, { dirty: true });
    return true;
  };
  Doc.clearSession = () => PE.idb.del('docsession');

  /* =================================================================
   *  typing
   * ================================================================= */
  function onBeforeInput(e) {
    if (e.inputType === 'historyUndo') {
      e.preventDefault();
      Doc.undo();
    } else if (e.inputType === 'historyRedo') {
      e.preventDefault();
      Doc.redo();
    } else if (e.inputType === 'insertParagraph') {
      e.preventDefault();
      splitParagraph();
    } else if (e.inputType === 'formatBold' || e.inputType === 'formatItalic' || e.inputType === 'formatUnderline') {
      e.preventDefault();
      toggle({ formatBold: 'b', formatItalic: 'i', formatUnderline: 'u' }[e.inputType]);
    } else if (/^delete/.test(e.inputType)) {
      // a selected picture is removed as a whole
      if (selImg) {
        e.preventDefault();
        removeSelectedImage();
      }
    }
  }
  function onInput() {
    // tidy structure the browser may create
    for (const n of Array.from(els.body.childNodes)) {
      if (n.nodeType === 3) {
        if (!n.nodeValue.trim()) {
          n.remove();
          continue;
        }
        const p = h('p');
        n.replaceWith(p);
        p.appendChild(n);
      } else if (n.nodeType === 1 && n.tagName === 'DIV' && !n.classList.contains('dm-pb') && !n.classList.contains('dm-tb')) {
        const p = h('p');
        while (n.firstChild) p.appendChild(n.firstChild);
        n.replaceWith(p);
      } else if (n.nodeType === 1 && n.tagName === 'SPAN' && !n.classList.contains('dm-lsp')) {
        const p = h('p');
        n.replaceWith(p);
        p.appendChild(n);
      }
    }
    els.body.querySelectorAll('font, b:not([data-keep]), i:not([data-keep])').forEach((n) => {
      const sp = h('span');
      if (n.tagName === 'B') sp.style.fontWeight = '700';
      if (n.tagName === 'I') sp.style.fontStyle = 'italic';
      if (n.tagName === 'FONT') {
        if (n.color) sp.style.color = n.color;
      }
      while (n.firstChild) sp.appendChild(n.firstChild);
      n.replaceWith(sp);
    });
    if (!els.body.firstChild) els.body.appendChild(h('p', {}, [h('br')]));
    commitSoon.pending = true;
    commitSoon();
    PE.app.dirty = true;
    PE.ui.updateHistoryButtons();
    paginateSoon();
    if (els.body.querySelector('p.li')) renumberSoon();
  }
  const renumberSoon = PE.debounce(() => PE.docx.renumber(els.body, Doc.D.N), 120);

  function onKey(e) {
    const mod = PE.mod(e);
    const k = e.key.toLowerCase();
    if (mod && !e.altKey) {
      if (k === 'z') {
        e.preventDefault();
        return e.shiftKey ? Doc.redo() : Doc.undo();
      }
      if (k === 'y') {
        e.preventDefault();
        return Doc.redo();
      }
      if (k === 'b' || k === 'i' || k === 'u') {
        e.preventDefault();
        return toggle(k);
      }
      if (k === 'e' || k === 'l' || k === 'r' || k === 'j') {
        e.preventDefault();
        return setAlign({ e: 'center', l: 'left', r: 'right', j: 'justify' }[k]);
      }
      if (k === 'enter') {
        e.preventDefault();
        return Doc.insertPageBreak();
      }
    }
    if (e.key === 'Enter' && !mod) {
      e.preventDefault();
      if (e.shiftKey) return insertLineBreak();
      return splitParagraph();
    }
    if (e.key === 'Tab') {
      const r = curRange();
      const td = r && r.startContainer.parentNode && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode).closest('td');
      if (td && els.body.contains(td)) {
        e.preventDefault();
        return moveCell(td, e.shiftKey ? -1 : 1);
      }
      const blocks = selectedBlocks();
      if (blocks.length && blocks.every((p) => p.classList.contains('li'))) {
        e.preventDefault();
        return Doc.indent(e.shiftKey ? -1 : 1);
      }
      e.preventDefault();
      if (!e.shiftKey) document.execCommand('insertText', false, '\t');
      return;
    }
    if (e.key === 'Backspace' && !mod) {
      const r = curRange();
      if (r && r.collapsed) {
        const p = blockOf(r.startContainer);
        if (p && atStart(p, r)) {
          // Backspace at the start of a list item first removes the bullet, like Word
          if (p.classList.contains('li')) {
            e.preventDefault();
            removeList([p]);
            return edited(true);
          }
          const prev = p.previousElementSibling;
          if (prev && prev.classList.contains('dm-pb')) {
            e.preventDefault();
            prev.remove();
            return edited();
          }
          if (prev && prev.tagName === 'TABLE' && isEmpty(p)) {
            e.preventDefault();
            p.remove();
            return edited();
          }
        }
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selImg) {
        e.preventDefault();
        return removeSelectedImage();
      }
    }
  }
  function atStart(p, r) {
    const t = document.createRange();
    t.setStart(p, 0);
    t.setEnd(r.startContainer, r.startOffset);
    return !t.toString().replace(/​/g, '').length && !t.cloneContents().querySelector('img,br:not(:last-child)');
  }
  const isEmpty = (p) => !p.textContent.replace(/[​\s]/g, '').length && !p.querySelector('img,.dm-field,.dm-fn');

  function insertLineBreak() {
    const r = curRange();
    if (!r) return;
    r.deleteContents();
    const br = h('br');
    r.insertNode(br);
    // a trailing <br> needs another one to show the empty line
    const p = blockOf(br);
    if (p && isLastIn(br, p)) br.after(h('br'));
    r.setStartAfter(br);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    onInput();
  }
  function isLastIn(n, p) {
    for (let x = n; x && x !== p; x = x.parentNode) if (x.nextSibling) return false;
    return true;
  }

  /** Enter: split the paragraph at the caret, keeping its formatting */
  function splitParagraph() {
    const r = curRange();
    if (!r) return;
    commitNow();
    if (!r.collapsed) r.deleteContents();
    const p = blockOf(r.startContainer);
    if (!p) {
      document.execCommand('insertParagraph');
      return;
    }
    if (p.classList.contains('li') && isEmpty(p)) {
      removeList([p]);
      return edited(true);
    }
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(p, p.childNodes.length);
    const frag = tail.extractContents();
    const np = p.cloneNode(false);
    np.removeAttribute('data-push');
    np.style.removeProperty('--push');
    // a section break (kept in the paragraph's raw settings) stays with the last part
    if (p.hasAttribute('data-raw')) p.setAttribute('data-nosect', '1');
    frag.querySelectorAll && frag.querySelectorAll('.dm-lsp').forEach((x) => x.remove());
    np.appendChild(frag);
    const atEnd = !np.textContent.replace(/​/g, '').length && !np.querySelector('img');
    // headings are followed by normal text
    if (atEnd) {
      const ps = p.getAttribute('data-ps');
      const next = ps ? Doc.D.styleNext[ps] : null;
      if (ps && next !== ps) {
        if (!next || next === Doc.D.defaultP) np.removeAttribute('data-ps');
        else np.setAttribute('data-ps', next);
      }
    }
    fixEmpty(p);
    const caretNode = fixEmpty(np);
    p.after(np);
    const s = getSelection();
    const nr = document.createRange();
    if (caretNode) nr.setStart(caretNode, caretNode.nodeValue.length);
    else {
      const w = document.createTreeWalker(np, NodeFilter.SHOW_TEXT);
      const t = w.nextNode();
      if (t) nr.setStart(t, 0);
      else nr.setStart(np, 0);
    }
    nr.collapse(true);
    s.removeAllRanges();
    s.addRange(nr);
    edited(p.classList.contains('li'));
    scrollCaretIntoView();
  }
  /** empty paragraphs keep a <br> for height; returns where the caret goes */
  function fixEmpty(p) {
    const hasText = p.textContent.replace(/​/g, '').length || p.querySelector('img,.dm-field,.dm-fn,br');
    if (hasText) return null;
    // keep the formatting of the (empty) run so typing continues in it
    let deepest = p;
    while (deepest.lastElementChild && deepest.lastElementChild.tagName === 'SPAN' && !deepest.lastElementChild.classList.contains('dm-lsp')) deepest = deepest.lastElementChild;
    if (deepest !== p) {
      deepest.textContent = ZWSP;
      p.appendChild(h('br'));
      return deepest.firstChild;
    }
    p.innerHTML = '<br>';
    return null;
  }
  function scrollCaretIntoView() {
    const s = getSelection();
    if (!s.rangeCount) return;
    const r = s.getRangeAt(0).getClientRects()[0] || (blockOf(s.anchorNode) && blockOf(s.anchorNode).getBoundingClientRect());
    if (!r) return;
    const sr = els.scroller.getBoundingClientRect();
    if (r.bottom > sr.bottom - 40) els.scroller.scrollTop += r.bottom - sr.bottom + 80;
    else if (r.top < sr.top + 20) els.scroller.scrollTop -= sr.top - r.top + 60;
  }

  function moveCell(td, dir) {
    const table = td.closest('table');
    const cells = Array.from(table.querySelectorAll('td')).filter((c) => c.closest('table') === table);
    let i = cells.indexOf(td) + dir;
    if (i >= cells.length) {
      Doc.tableOp('rowBelow');
      const cs = Array.from(table.querySelectorAll('td')).filter((c) => c.closest('table') === table);
      i = cs.length - (td.parentNode.children.length || 1);
      return caretIn(cs[Math.max(0, i)]);
    }
    if (i < 0) return;
    caretIn(cells[i], true);
  }
  function caretIn(el, selectAll) {
    if (!el) return;
    const r = document.createRange();
    const p = el.querySelector('p') || el;
    r.selectNodeContents(p);
    if (!selectAll) r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  /* ---------- paste & drop ---------- */
  function onPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    const file = Array.from(cd.items || []).find((i) => i.kind === 'file' && /^image\//.test(i.type));
    e.preventDefault();
    if (file) {
      const f = file.getAsFile();
      return PE.readFile(f).then((b) => Doc.insertImageBytes(b, f.type));
    }
    const html = cd.getData('text/html');
    if (html) return pasteHtml(html);
    const text = cd.getData('text/plain');
    if (text) pasteText(text);
  }
  function pasteText(text) {
    commitNow();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === 1) {
      document.execCommand('insertText', false, lines[0]);
      return;
    }
    const r = curRange();
    if (!r) return;
    r.deleteContents();
    const p = blockOf(r.startContainer);
    document.execCommand('insertText', false, lines[0]);
    let cur = blockOf(getSelection().anchorNode) || p;
    for (const ln of lines.slice(1)) {
      splitParagraphQuiet();
      if (ln) document.execCommand('insertText', false, ln);
      cur = blockOf(getSelection().anchorNode);
    }
    edited(true);
  }
  function splitParagraphQuiet() {
    splitParagraph();
  }
  /** paste rich text: keep paragraphs, bold/italic/underline, links and tables' text, drop the rest */
  function pasteHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    const blockTags = /^(P|DIV|H[1-6]|LI|TR|BLOCKQUOTE|PRE|SECTION|ARTICLE|HEADER|FOOTER|TABLE|UL|OL)$/;
    let cur = null;
    const newP = (tag) => {
      cur = h('p');
      if (/^H[1-3]$/.test(tag)) {
        const st = Doc.D.styles.find((s) => s.name === 'Heading ' + tag[1]);
        if (st) cur.setAttribute('data-ps', st.id);
      }
      out.push(cur);
      return cur;
    };
    const walk = (node, fmt) => {
      for (const c of Array.from(node.childNodes)) {
        if (c.nodeType === 3) {
          const t = c.nodeValue.replace(/\s+/g, ' ');
          if (!t.trim() && (!cur || !cur.textContent)) continue;
          if (!cur) newP();
          if (fmt.b || fmt.i || fmt.u) {
            const sp = h('span', {}, t);
            if (fmt.b) sp.style.fontWeight = '700';
            if (fmt.i) sp.style.fontStyle = 'italic';
            if (fmt.u) sp.style.textDecoration = 'underline';
            cur.appendChild(sp);
          } else cur.appendChild(document.createTextNode(t));
        } else if (c.nodeType === 1) {
          const tag = c.tagName;
          if (/^(SCRIPT|STYLE|META|LINK|TITLE)$/.test(tag)) continue;
          if (tag === 'BR') {
            if (!cur) newP();
            cur.appendChild(h('br'));
            continue;
          }
          const f = Object.assign({}, fmt);
          const st = c.getAttribute('style') || '';
          if (tag === 'B' || tag === 'STRONG' || /font-weight:\s*(bold|[6-9]00)/.test(st)) f.b = true;
          if (tag === 'I' || tag === 'EM' || /font-style:\s*italic/.test(st)) f.i = true;
          if (tag === 'U' || /text-decoration:[^;]*underline/.test(st)) f.u = true;
          if (blockTags.test(tag)) {
            newP(tag);
            if (tag === 'LI') cur.appendChild(document.createTextNode('• '));
            walk(c, f);
            cur = null;
          } else if (tag === 'TD' || tag === 'TH') {
            walk(c, f);
            if (cur) cur.appendChild(document.createTextNode('\t'));
          } else walk(c, f);
        }
      }
    };
    walk(doc.body, {});
    const ps = out.filter((p) => p.textContent.trim() || p.querySelector('br'));
    if (!ps.length) return;
    commitNow();
    if (ps.length === 1) {
      const r = curRange();
      if (!r) return;
      r.deleteContents();
      const frag = document.createDocumentFragment();
      while (ps[0].firstChild) frag.appendChild(ps[0].firstChild);
      const last = frag.lastChild;
      r.insertNode(frag);
      if (last) {
        r.setStartAfter(last);
        r.collapse(true);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      }
      return edited();
    }
    const r = curRange();
    if (!r) return;
    r.deleteContents();
    const p = blockOf(r.startContainer);
    if (!p) return;
    // split at the caret and put the pasted paragraphs between the halves
    const tail = document.createRange();
    tail.setStart(r.startContainer, r.startOffset);
    tail.setEnd(p, p.childNodes.length);
    const frag = tail.extractContents();
    const firstNew = ps.shift();
    while (firstNew.firstChild) p.appendChild(firstNew.firstChild);
    let after = p;
    for (const q of ps) {
      after.after(q);
      after = q;
    }
    const lastP = after;
    const caretAt = lastP.childNodes.length;
    lastP.appendChild(frag);
    fixEmpty(p);
    const nr = document.createRange();
    nr.setStart(lastP, Math.min(caretAt, lastP.childNodes.length));
    nr.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(nr);
    edited();
  }
  function onDrop(e) {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const img = files.find((f) => /^image\//.test(f.type));
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) {
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      }
    }
    PE.readFile(img).then((b) => Doc.insertImageBytes(b, img.type));
  }

  /* =================================================================
   *  formatting
   * ================================================================= */
  function textNodesIn(r) {
    const root = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode;
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (!r.intersectsNode(n)) continue;
      if (n.parentNode.closest('.dm-lsp,.dm-field,.dm-fn')) continue;
      out.push(n);
    }
    return out;
  }
  /** split text at the range ends so whole text nodes are selected */
  function splitRange(r) {
    let { startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo } = r;
    if (ec.nodeType === 3 && eo < ec.nodeValue.length && eo > 0) ec.splitText(eo);
    if (sc.nodeType === 3 && so > 0 && so < sc.nodeValue.length) {
      const rest = sc.splitText(so);
      if (ec === sc) {
        ec = rest;
        eo = eo - so;
      }
      sc = rest;
      so = 0;
    }
    const nr = document.createRange();
    nr.setStart(sc, so);
    nr.setEnd(ec, ec.nodeType === 3 ? Math.min(eo, ec.nodeValue.length) : eo);
    return nr;
  }
  /**
   * Apply inline CSS to the selected text. `css` maps property -> value (null removes it).
   * `attrs` sets attributes (e.g. data-font). With no selection the style applies to what's typed next.
   */
  function applyInline(css, attrs) {
    const r0 = curRange();
    if (!r0) return;
    commitNow();
    const set = (sp) => {
      for (const k in css) {
        if (css[k] == null) sp.style.removeProperty(k);
        else sp.style.setProperty(k, css[k]);
      }
      for (const k in attrs || {}) {
        if (attrs[k] == null) sp.removeAttribute(k);
        else sp.setAttribute(k, attrs[k]);
      }
    };
    if (r0.collapsed) {
      // typing continues with the new style
      const sp = h('span', {}, ZWSP);
      const host = r0.startContainer.nodeType === 3 ? r0.startContainer.parentNode : r0.startContainer;
      const parentSpan = host.closest && host.closest('span');
      if (parentSpan && els.body.contains(parentSpan) && !parentSpan.classList.contains('dm-lsp')) {
        sp.setAttribute('style', parentSpan.getAttribute('style') || '');
        if (parentSpan.getAttribute('data-font')) sp.setAttribute('data-font', parentSpan.getAttribute('data-font'));
      }
      set(sp);
      r0.insertNode(sp);
      const nr = document.createRange();
      nr.setStart(sp.firstChild, 1);
      nr.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(nr);
      updateBar();
      return;
    }
    const r = splitRange(r0);
    const nodes = textNodesIn(r).filter((n) => n.nodeValue.length);
    const touched = [];
    for (const t of nodes) {
      const par = t.parentNode;
      if (par.tagName === 'SPAN' && par.childNodes.length === 1 && !par.classList.contains('dm-lsp')) {
        set(par);
        touched.push(par);
      } else {
        const sp = h('span');
        par.insertBefore(sp, t);
        sp.appendChild(t);
        set(sp);
        touched.push(sp);
      }
    }
    if (!touched.length) return;
    const nr = document.createRange();
    nr.setStartBefore(touched[0]);
    nr.setEndAfter(touched[touched.length - 1]);
    getSelection().removeAllRanges();
    getSelection().addRange(nr);
    mergeSpans(touched);
    edited();
  }
  /** join neighbouring spans that look the same */
  function mergeSpans(spans) {
    const same = (a, b) =>
      a && b && a.tagName === 'SPAN' && b.tagName === 'SPAN' && a.getAttribute('style') === b.getAttribute('style') && a.getAttribute('data-font') === b.getAttribute('data-font') && a.getAttribute('data-raw') === b.getAttribute('data-raw') && !a.className && !b.className;
    const sel = getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    for (const sp of spans) {
      if (!sp.parentNode) continue;
      const prev = sp.previousSibling;
      if (same(prev, sp) && range && !range.intersectsNode(prev)) {
        // keep the selection valid: move children forward
        while (prev.lastChild) sp.insertBefore(prev.lastChild, sp.firstChild);
        prev.remove();
      }
    }
  }
  /** effective style at the caret / selection start */
  function styleAt() {
    const r = curRange();
    if (!r) return null;
    let n = r.startContainer;
    if (n.nodeType === 1 && n.childNodes[r.startOffset] && !r.collapsed) n = n.childNodes[r.startOffset];
    if (n.nodeType === 3) n = n.parentNode;
    if (!n || !els.body.contains(n)) return null;
    const cs = getComputedStyle(n);
    const fam = (cs.fontFamily.match(/PEF-([a-z-]+)/) || [])[1] || 'carlito';
    let deco = '';
    for (let x = n; x && x !== els.body; x = x.parentNode) deco += ' ' + getComputedStyle(x).textDecorationLine;
    let fontName = null;
    for (let x = n; x && x !== els.body; x = x.parentNode) if (x.getAttribute && x.getAttribute('data-font')) {
        fontName = x.getAttribute('data-font');
        break;
      }
    return {
      fam,
      fontName,
      size: parseFloat(cs.fontSize),
      b: +cs.fontWeight >= 600,
      i: cs.fontStyle === 'italic',
      u: /underline/.test(deco),
      s: /line-through/.test(deco),
      color: cs.color,
      sup: cs.verticalAlign === 'super',
      sub: cs.verticalAlign === 'sub',
    };
  }
  function toggle(k) {
    const st = styleAt();
    if (!st) return;
    if (k === 'b') applyInline({ 'font-weight': st.b ? '400' : '700' });
    else if (k === 'i') applyInline({ 'font-style': st.i ? 'normal' : 'italic' });
    else if (k === 'u' || k === 's') {
      const u = k === 'u' ? !st.u : st.u,
        s = k === 's' ? !st.s : st.s;
      applyInline({ 'text-decoration': [u ? 'underline' : '', s ? 'line-through' : ''].filter(Boolean).join(' ') || 'none' });
    } else if (k === 'sup' || k === 'sub') {
      const onNow = k === 'sup' ? st.sup : st.sub;
      const base = st.sup || st.sub ? st.size / 0.65 : st.size;
      applyInline(onNow ? { 'vertical-align': null, 'font-size': base.toFixed(2) + 'px' } : { 'vertical-align': k === 'sup' ? 'super' : 'sub', 'font-size': (base * 0.65).toFixed(2) + 'px' });
    }
  }
  Doc.toggle = toggle;
  Doc.setFont = (key) => applyInline({ 'font-family': PE.fonts.cssFamily(key) }, { 'data-font': PE.docx.WORD_NAME[key] || key }) || loadFonts([key]).then(paginateSoon);
  Doc.setSize = (s) => applyInline({ 'font-size': s + 'px' });
  Doc.setColor = (c) => applyInline({ color: c });
  Doc.setHighlight = (c) => applyInline({ 'background-color': c });
  Doc.clearFormat = function () {
    const r0 = curRange();
    if (!r0 || r0.collapsed) return;
    commitNow();
    const r = splitRange(r0);
    const nodes = textNodesIn(r);
    for (const t of nodes) {
      // lift the text out of formatting spans inside its paragraph
      let par = t.parentNode;
      while (par && par.tagName === 'SPAN' && !par.classList.contains('dm-lsp') && blockOf(par)) {
        const before = par.cloneNode(false),
          after = par.cloneNode(false);
        let x = par.firstChild;
        while (x && x !== t) {
          const nx = x.nextSibling;
          before.appendChild(x);
          x = nx;
        }
        x = t.nextSibling;
        while (x) {
          const nx = x.nextSibling;
          after.appendChild(x);
          x = nx;
        }
        if (before.firstChild) par.parentNode.insertBefore(before, par);
        par.parentNode.insertBefore(t, par);
        if (after.firstChild) par.parentNode.insertBefore(after, par);
        par.remove();
        par = t.parentNode;
      }
    }
    for (const p of selectedBlocks(r)) {
      p.removeAttribute('data-ps');
      ['text-align', 'line-height', 'padding-top', 'padding-bottom', 'text-indent', 'background-color'].forEach((k) => p.style.removeProperty(k));
    }
    edited();
  };

  /* ---------- paragraphs ---------- */
  function setAlign(a) {
    commitNow();
    for (const p of selectedBlocks()) p.style.textAlign = a;
    const img = selImg && selImg.closest('p');
    if (img) img.style.textAlign = a;
    edited();
  }
  Doc.setAlign = setAlign;
  Doc.setLineSpacing = function (m) {
    commitNow();
    for (const p of selectedBlocks()) {
      const fam = (getComputedStyle(p).fontFamily.match(/PEF-([a-z-]+)/) || [])[1] || 'carlito';
      p.style.lineHeight = String(+(m * PE.docx.lineOf(fam)).toFixed(4));
    }
    edited();
  };
  Doc.setSpacing = function (before, after) {
    commitNow();
    for (const p of selectedBlocks()) {
      if (before != null) p.style.paddingTop = before + 'px';
      if (after != null) p.style.paddingBottom = after + 'px';
    }
    edited();
  };
  Doc.setStyle = function (id) {
    commitNow();
    for (const p of selectedBlocks()) {
      if (id) p.setAttribute('data-ps', id);
      else p.removeAttribute('data-ps');
    }
    edited();
  };
  function removeList(ps) {
    for (const p of ps) {
      p.classList.remove('li');
      ['data-num', 'data-lvl', 'data-marker'].forEach((a) => p.removeAttribute(a));
      if (!p.hasAttribute('data-pind')) {
        p.style.removeProperty('padding-left');
        p.style.removeProperty('text-indent');
      }
      p.style.removeProperty('--hang');
      if (!p.className) p.removeAttribute('class');
    }
  }
  const listKind = (p) => {
    const D = Doc.D;
    const nm = D.N.nums[p.getAttribute('data-num')];
    const ab = nm && D.N.abs[nm.abs];
    const L = ab && ab.lvls[+p.getAttribute('data-lvl') || 0];
    return L && L.fmt === 'bullet' ? 'bullet' : 'number';
  };
  Doc.toggleList = function (kind) {
    const ps = selectedBlocks();
    if (!ps.length) return;
    commitNow();
    const allSame = ps.every((p) => p.classList.contains('li') && listKind(p) === kind);
    if (allSame) removeList(ps);
    else {
      // reuse the list just above when it's the same kind, so numbering continues
      let numId = null;
      const prev = ps[0].previousElementSibling;
      if (prev && prev.classList.contains('li') && listKind(prev) === kind) numId = prev.getAttribute('data-num');
      if (!numId) numId = PE.docx.addList(Doc.D, kind === 'bullet' ? 'bullet' : 'decimal');
      for (const p of ps) {
        p.classList.add('li');
        p.setAttribute('data-num', numId);
        if (!p.hasAttribute('data-lvl')) p.setAttribute('data-lvl', '0');
        p.removeAttribute('data-pind');
      }
    }
    edited(true);
  };
  Doc.indent = function (d) {
    commitNow();
    for (const p of selectedBlocks()) {
      if (p.classList.contains('li')) p.setAttribute('data-lvl', PE.clamp((+p.getAttribute('data-lvl') || 0) + d, 0, 8));
      else {
        const cur = parseFloat(p.style.paddingLeft) || parseFloat(getComputedStyle(p).paddingLeft) || 0;
        const v = Math.max(0, Math.round((cur + d * 36) / 36) * 36);
        p.style.paddingLeft = v + 'px';
      }
    }
    edited(true);
  };

  /* ---------- insert ---------- */
  function insertBlockAfterCaret(el) {
    const r = curRange();
    let p = r ? blockOf(r.startContainer) : null;
    if (!p) p = els.body.lastElementChild;
    // split the paragraph at the caret when it's in the middle
    if (r && p && !isEmpty(p) && !atStart(p, r)) {
      const tail = document.createRange();
      tail.setStart(r.startContainer, r.startOffset);
      tail.setEnd(p, p.childNodes.length);
      const frag = tail.extractContents();
      const np = p.cloneNode(false);
      np.appendChild(frag);
      if (np.textContent.replace(/​/g, '').length || np.querySelector('img')) {
        p.after(np);
        fixEmpty(np);
      }
      p.after(el);
    } else if (p && isEmpty(p) && p.parentNode === els.body) {
      p.before(el);
    } else if (p && r && atStart(p, r)) p.before(el);
    else if (p) p.after(el);
    else els.body.appendChild(el);
    let next = el.nextElementSibling;
    if (!next || next.tagName !== 'P') {
      next = h('p', {}, [h('br')]);
      el.after(next);
    }
    return next;
  }
  Doc.insertPageBreak = function () {
    commitNow();
    const next = insertBlockAfterCaret(h('div', { class: 'dm-pb', contenteditable: 'false' }));
    caretIn(next);
    edited();
  };
  Doc.insertTable = function (rows, cols) {
    commitNow();
    const D = Doc.D;
    const w = D.page.w - D.page.ml - D.page.mr;
    const t = h('table', { class: 'dm-tbl' });
    if (/data-ts="TableGrid"/.test(D.css) || /TableGrid/.test(D.css)) t.setAttribute('data-ts', 'TableGrid');
    const cg = h('colgroup');
    for (let c = 0; c < cols; c++) cg.appendChild(h('col', { style: { width: (w / cols).toFixed(2) + 'px' } }));
    t.appendChild(cg);
    t.style.width = w + 'px';
    const tb = h('tbody');
    for (let r = 0; r < rows; r++) {
      const tr = h('tr');
      for (let c = 0; c < cols; c++) {
        const td = h('td', {}, [h('p', {}, [h('br')])]);
        for (const s of ['top', 'right', 'bottom', 'left']) td.style.setProperty('border-' + s, '0.5px solid #000000');
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    insertBlockAfterCaret(t);
    caretIn(t.querySelector('td'));
    edited();
  };
  Doc.insertImageBytes = async function (bytes, mime) {
    try {
      const n = await PE.normalizeImage(bytes, mime);
      bytes = n.bytes;
      mime = n.mime;
    } catch (e) {
      return PE.toast(e.message || 'This image could not be read.', 'error');
    }
    const D = Doc.D;
    const key = 'm' + D.mediaSeq++;
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    D.media[key] = { bytes, mime, url };
    const im = await PE.view.loadImg(url);
    const maxW = D.page.w - D.page.ml - D.page.mr;
    let w = im.naturalWidth * 0.75,
      hh = im.naturalHeight * 0.75;
    if (w > maxW) {
      hh *= maxW / w;
      w = maxW;
    }
    commitNow();
    const img = h('img', { class: 'dm-img', src: url, alt: '', 'data-m': key, draggable: 'false', style: { width: w.toFixed(2) + 'px', height: hh.toFixed(2) + 'px' } });
    const r = curRange();
    if (r) {
      r.deleteContents();
      r.insertNode(img);
      r.setStartAfter(img);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    } else {
      const p = h('p', {}, [img]);
      els.body.appendChild(p);
    }
    const p = blockOf(img);
    if (p) p.querySelectorAll(':scope > br:last-child').forEach((b) => b.previousSibling && b.remove());
    edited();
    selectImage(img);
  };
  Doc.insertLink = async function () {
    const r = curRange();
    if (!r) return;
    const url = await PE.ui.prompt('Insert link', 'Web address', 'https://');
    if (!url) return;
    commitNow();
    const a = h('a', { href: url });
    if (r.collapsed) {
      a.textContent = url;
      r.insertNode(a);
    } else {
      const frag = r.extractContents();
      a.appendChild(frag);
      r.insertNode(a);
    }
    a.style.color = '#0563c1';
    a.style.textDecoration = 'underline';
    edited();
  };

  /* ---------- tables ---------- */
  function tableAtCaret() {
    const r = curRange();
    if (!r) return null;
    const n = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode;
    const td = n.closest && n.closest('td');
    return td && els.body.contains(td) ? td : null;
  }
  /** grid of the table: rows x columns -> td (spanning cells repeat) */
  function gridOf(table) {
    const rows = Array.from(table.rows);
    const g = rows.map(() => []);
    rows.forEach((tr, ri) => {
      let c = 0;
      for (const td of Array.from(tr.cells)) {
        while (g[ri][c]) c++;
        for (let a = 0; a < (td.rowSpan || 1); a++) for (let b = 0; b < (td.colSpan || 1); b++) if (g[ri + a]) g[ri + a][c + b] = td;
        c += td.colSpan || 1;
      }
    });
    return g;
  }
  Doc.inTable = () => !!tableAtCaret();
  Doc.tableOp = function (op) {
    const td = tableAtCaret();
    if (!td) return PE.toast('Put the cursor in a table cell first.', 'warn');
    commitNow();
    const table = td.closest('table');
    const g = gridOf(table);
    const tr = td.parentNode;
    const ri = Array.from(table.rows).indexOf(tr);
    const ci = g[ri].indexOf(td);
    const newCell = (like) => {
      const c = h('td', {}, [h('p', {}, [h('br')])]);
      if (like) {
        c.setAttribute('style', like.getAttribute('style') || '');
        if (like.getAttribute('data-raw')) c.setAttribute('data-raw', like.getAttribute('data-raw'));
        c.style.removeProperty('background-color');
      }
      return c;
    };
    const cols = table.querySelector('colgroup');
    if (op === 'rowAbove' || op === 'rowBelow') {
      const nr = tr.cloneNode(false);
      const seen = new Set();
      for (const cell of g[ri]) {
        if (seen.has(cell)) continue;
        seen.add(cell);
        const c = newCell(cell);
        c.colSpan = cell.colSpan || 1;
        nr.appendChild(c);
      }
      if (op === 'rowAbove') tr.before(nr);
      else {
        let last = tr;
        // below a cell that spans rows: after the span
        const span = td.rowSpan || 1;
        for (let k = 1; k < span; k++) last = last.nextElementSibling || last;
        last.after(nr);
      }
      caretIn(nr.cells[Math.min(ci, nr.cells.length - 1)]);
    } else if (op === 'rowDel') {
      if (table.rows.length <= 1) return Doc.tableOp('tableDel');
      const next = tr.nextElementSibling || tr.previousElementSibling;
      tr.remove();
      caretIn(next && next.cells[0]);
    } else if (op === 'colLeft' || op === 'colRight') {
      const at = op === 'colLeft' ? ci : ci + (td.colSpan || 1);
      Array.from(table.rows).forEach((row, r) => {
        const ref = g[r][at];
        const c = newCell(g[r][Math.min(at, g[r].length - 1)] || td);
        if (ref && ref.parentNode === row) ref.before(c);
        else row.appendChild(c);
      });
      if (cols) {
        const list = Array.from(cols.children);
        const total = list.reduce((a, c) => a + parseFloat(c.style.width || 0), 0);
        const nw = total / (list.length + 1);
        list.forEach((c) => (c.style.width = ((parseFloat(c.style.width) * (total - nw)) / total).toFixed(2) + 'px'));
        const col = h('col', { style: { width: nw.toFixed(2) + 'px' } });
        if (list[at]) list[at].before(col);
        else cols.appendChild(col);
      }
    } else if (op === 'colDel') {
      const width = g[0].length;
      if (width <= 1) return Doc.tableOp('tableDel');
      const seen = new Set();
      Array.from(table.rows).forEach((row, r) => {
        const c = g[r][ci];
        if (!c || seen.has(c)) return;
        seen.add(c);
        if ((c.colSpan || 1) > 1) c.colSpan--;
        else c.remove();
      });
      if (cols && cols.children[ci]) {
        const w = parseFloat(cols.children[ci].style.width) || 0;
        cols.children[ci].remove();
        const list = Array.from(cols.children);
        list.forEach((c) => (c.style.width = (parseFloat(c.style.width) + w / list.length).toFixed(2) + 'px'));
      }
      caretIn(table.querySelector('td'));
    } else if (op === 'tableDel') {
      const next = table.nextElementSibling;
      table.remove();
      if (next) caretIn(next);
    } else if (op === 'shade') {
      return;
    }
    edited();
  };
  Doc.cellShade = function (c) {
    const td = tableAtCaret();
    if (!td) return;
    commitNow();
    const r = curRange();
    const tds = Array.from(td.closest('table').querySelectorAll('td')).filter((x) => r.intersectsNode(x));
    (tds.length ? tds : [td]).forEach((x) => {
      if (c) x.style.backgroundColor = c;
      else x.style.removeProperty('background-color');
      x.removeAttribute('data-raw');
    });
    edited();
  };

  /* ---------- pictures: select, resize, delete ---------- */
  let selImg = null;
  function onPointer(e) {
    const img = e.target.closest && e.target.closest('img.dm-img');
    if (img) {
      e.preventDefault();
      selectImage(img);
      return;
    }
    if (selImg && !e.target.closest('.dm-ui')) deselectImage();
  }
  function onClick(e) {
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && (e.ctrlKey || e.metaKey)) window.open(a.href, '_blank', 'noopener');
  }
  function selectImage(img) {
    deselectImage();
    selImg = img;
    img.classList.add('dm-sel');
    const r = document.createRange();
    r.selectNode(img);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    positionImageUi();
    updateBar();
  }
  function deselectImage() {
    if (selImg) selImg.classList.remove('dm-sel');
    selImg = null;
    if (els) els.ui.innerHTML = '';
  }
  function removeSelectedImage() {
    if (!selImg) return;
    commitNow();
    const p = blockOf(selImg);
    selImg.remove();
    deselectImage();
    if (p) fixEmpty(p);
    edited();
  }
  Doc.removeImage = removeSelectedImage;
  function positionImageUi() {
    if (!els) return;
    els.ui.innerHTML = '';
    if (!selImg || !els.body.contains(selImg)) {
      selImg = null;
      return;
    }
    const z = Doc.zoom;
    const pr = els.pages.getBoundingClientRect();
    const r = selImg.getBoundingClientRect();
    const box = h('div', { class: 'dm-imgbox', style: { left: (r.left - pr.left) / z + 'px', top: (r.top - pr.top) / z + 'px', width: r.width / z + 'px', height: r.height / z + 'px' } });
    for (const k of ['nw', 'ne', 'sw', 'se']) {
      const hd = h('div', { class: 'dm-hd dm-hd-' + k, 'data-h': k });
      hd.addEventListener('pointerdown', (ev) => startResize(ev, k));
      box.appendChild(hd);
    }
    els.ui.appendChild(box);
  }
  function startResize(e, k) {
    e.preventDefault();
    e.stopPropagation();
    const img = selImg;
    const w0 = parseFloat(img.style.width) || img.width,
      h0 = parseFloat(img.style.height) || img.height;
    const x0 = e.clientX;
    const maxW = Doc.D.page.w - Doc.D.page.ml - Doc.D.page.mr;
    const dir = k.includes('w') ? -1 : 1;
    commitNow();
    const move = (ev) => {
      const dx = ((ev.clientX - x0) / Doc.zoom) * dir;
      const w = PE.clamp(w0 + dx, 12, maxW);
      img.style.width = w.toFixed(2) + 'px';
      img.style.height = ((h0 * w) / w0).toFixed(2) + 'px';
      positionImageUi();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      edited();
      positionImageUi();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* =================================================================
   *  toolbar
   * ================================================================= */
  const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
  const PALETTE = ['#000000', '#404040', '#7f7f7f', '#c00000', '#e46c0a', '#d4a017', '#2e7d32', '#1f6fb5', '#1f3864', '#7030a0', '#ffffff', '#c0504d', '#f79646', '#9bbb59', '#4bacc6', '#8064a2'];
  const HL = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#c0c0c0', '#ffc000'];
  function wireBar() {
    const bar = $('#doc-bar');
    const fs = $('#dm-font');
    for (const f of PE.fonts.FAMILIES) fs.appendChild(h('option', { value: f.key }, PE.docx.WORD_NAME[f.key] || f.name));
    fs.addEventListener('change', () => {
      restoreFocus();
      Doc.setFont(fs.value);
    });
    const sz = $('#dm-size');
    const dl = $('#dm-sizes');
    for (const s of SIZES) dl.appendChild(h('option', { value: s }));
    const applySize = () => {
      const v = parseFloat(sz.value);
      if (v >= 1 && v <= 400) {
        restoreFocus();
        Doc.setSize(v);
      }
    };
    sz.addEventListener('change', applySize);
    sz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applySize();
      }
    });
    $('#dm-style').addEventListener('change', (e) => {
      restoreFocus();
      Doc.setStyle(e.target.value);
    });
    bar.addEventListener('mousedown', (e) => {
      // keep the text selection when clicking toolbar buttons
      if (e.target.closest('button')) e.preventDefault();
    });
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dm]');
      if (!b) return;
      const a = b.getAttribute('data-dm');
      restoreFocus();
      const acts = {
        b: () => toggle('b'),
        i: () => toggle('i'),
        u: () => toggle('u'),
        s: () => toggle('s'),
        sup: () => toggle('sup'),
        sub: () => toggle('sub'),
        left: () => setAlign('left'),
        center: () => setAlign('center'),
        right: () => setAlign('right'),
        justify: () => setAlign('justify'),
        bullets: () => Doc.toggleList('bullet'),
        numbers: () => Doc.toggleList('number'),
        outdent: () => Doc.indent(-1),
        indent: () => Doc.indent(1),
        clear: () => Doc.clearFormat(),
        color: () => colorMenu(b, PALETTE, (c) => Doc.setColor(c), 'Text colour'),
        hl: () => colorMenu(b, HL, (c) => Doc.setHighlight(c), 'Highlight', true),
        spacing: () => spacingMenu(b),
        table: () => tableMenu(b),
        image: async () => {
          const [f] = await PE.pickFiles('image/*');
          if (f) Doc.insertImageBytes(await PE.readFile(f), f.type);
        },
        link: () => Doc.insertLink(),
        pagebreak: () => Doc.insertPageBreak(),
        more: () => insertMenu(b),
      };
      acts[a] && acts[a]();
    });
  }
  function restoreFocus() {
    if (document.activeElement !== els.body) {
      els.body.focus({ preventScroll: true });
      if (lastRange && els.body.contains(lastRange.startContainer)) {
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(lastRange);
      }
    }
  }
  function colorMenu(anchor, colors, fn, label, allowNone) {
    const m = PE.ui.menu(anchor, [{ heading: label }]);
    const grid = h('div', { class: 'swatches' });
    for (const c of colors) grid.appendChild(h('button', { class: 'sw', style: { background: c }, title: c, 'aria-label': c, onclick: () => (PE.ui.closeMenu(), restoreFocus(), fn(c)) }));
    if (allowNone) grid.appendChild(h('button', { class: 'sw none', title: 'None', 'aria-label': 'No highlight', onclick: () => (PE.ui.closeMenu(), restoreFocus(), fn(null)) }));
    const custom = h('input', { type: 'color', class: 'dm-cc', 'aria-label': 'Custom colour', value: '#1f3fcf' });
    custom.addEventListener('change', () => {
      PE.ui.closeMenu();
      restoreFocus();
      fn(custom.value);
    });
    m.appendChild(grid);
    m.appendChild(h('label', { class: 'sw-row' }, ['Custom ', custom]));
  }
  function spacingMenu(anchor) {
    const ps = selectedBlocks();
    const p = ps[0];
    let cur = null;
    if (p) {
      const cs = getComputedStyle(p);
      const fam = (cs.fontFamily.match(/PEF-([a-z-]+)/) || [])[1] || 'carlito';
      cur = cs.lineHeight === 'normal' ? 1 : parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) / PE.docx.lineOf(fam);
    }
    const items = [{ heading: 'Line spacing' }];
    for (const m of [1, 1.15, 1.5, 2, 2.5, 3]) items.push({ label: m.toFixed(m % 1 ? 2 : 1).replace(/0$/, ''), on: cur && Math.abs(cur - m) < 0.03, onClick: () => (restoreFocus(), Doc.setLineSpacing(m)) });
    items.push('-', { label: 'Add space before paragraph', onClick: () => (restoreFocus(), Doc.setSpacing(12, null)) });
    items.push({ label: 'Add space after paragraph', onClick: () => (restoreFocus(), Doc.setSpacing(null, 8)) });
    items.push({ label: 'Remove space before & after', onClick: () => (restoreFocus(), Doc.setSpacing(0, 0)) });
    PE.ui.menu(anchor, items);
  }
  function tableMenu(anchor) {
    const inT = Doc.inTable();
    const items = [{ label: 'Insert table…', icon: 'table', onClick: () => tableDialog() }];
    if (inT)
      items.push(
        '-',
        { label: 'Insert row above', icon: 'up', onClick: () => (restoreFocus(), Doc.tableOp('rowAbove')) },
        { label: 'Insert row below', icon: 'down', onClick: () => (restoreFocus(), Doc.tableOp('rowBelow')) },
        { label: 'Insert column left', icon: 'left', onClick: () => (restoreFocus(), Doc.tableOp('colLeft')) },
        { label: 'Insert column right', icon: 'right', onClick: () => (restoreFocus(), Doc.tableOp('colRight')) },
        '-',
        { label: 'Shade cells…', icon: 'drop', onClick: () => colorMenu(anchor, ['#d9e2f3', '#e2efd9', '#fff2cc', '#fbe4d5', '#ededed', '#d0cece', '#1f3864', '#ffffff'], (c) => Doc.cellShade(c), 'Cell shading', true) },
        '-',
        { label: 'Delete row', icon: 'trash', onClick: () => (restoreFocus(), Doc.tableOp('rowDel')) },
        { label: 'Delete column', icon: 'trash', onClick: () => (restoreFocus(), Doc.tableOp('colDel')) },
        { label: 'Delete table', icon: 'trash', onClick: () => (restoreFocus(), Doc.tableOp('tableDel')) }
      );
    PE.ui.menu(anchor, items);
  }
  function insertMenu(anchor) {
    const D = Doc.D;
    PE.ui.menu(anchor, [
      { label: 'Picture…', icon: 'image', onClick: async () => {
          const [f] = await PE.pickFiles('image/*');
          if (f) Doc.insertImageBytes(await PE.readFile(f), f.type);
        } },
      { label: 'Link…', icon: 'tag', onClick: () => Doc.insertLink() },
      { label: 'Page break', icon: 'file-plus', kbd: PE.isMac ? '⌘↵' : 'Ctrl+Enter', onClick: () => (restoreFocus(), Doc.insertPageBreak()) },
      '-',
      { label: 'Superscript', onClick: () => (restoreFocus(), toggle('sup')) },
      { label: 'Subscript', onClick: () => (restoreFocus(), toggle('sub')) },
      { label: 'Strikethrough', onClick: () => (restoreFocus(), toggle('s')) },
      '-',
      { label: Doc.web ? 'Page view' : 'Mobile view (fit text to screen)', icon: 'pages', onClick: () => Doc.setLayout(!Doc.web) },
      { label: D.pageNumbers ? 'Remove page numbers' : 'Add page numbers', icon: 'hash', disabled: !!D.ftr.default && !D.pageNumbers, onClick: () => Doc.togglePageNumbers() },
      { label: 'Page setup…', icon: 'file', onClick: () => pageSetupDialog() },
    ]);
  }
  /** look at the document as it was opened (read-only); the edited version comes back unchanged */
  Doc.showOriginal = function (on) {
    if (!els || !Doc.D) return;
    if (on) {
      commitNow();
      deselectImage();
      Doc._edited = hist.snapshot();
      Doc._editedSel = saveSel();
      els.body.innerHTML = Doc.D.origHtml || '<p><br></p>';
      els.body.setAttribute('contenteditable', 'false');
    } else if (Doc._edited != null) {
      els.body.innerHTML = Doc._edited;
      Doc._edited = null;
      els.body.setAttribute('contenteditable', 'true');
    }
    PE.docx.renumber(els.body, Doc.D.N);
    paginate();
    if (!on && Doc._editedSel) restoreSel(Doc._editedSel);
  };
  Doc.revert = function () {
    commitNow();
    els.body.innerHTML = Doc.D.origHtml || '<p><br></p>';
    edited(true);
    PE.toast('Back to the original document. Undo brings your changes back.', 'ok', 5000);
  };
  Doc.togglePageNumbers = function () {
    commitNow();
    Doc.D.pageNumbers = Doc.D.pageNumbers ? false : true;
    renderSheets();
    hist.push();
    changed();
  };
  function tableDialog() {
    const r = h('input', { class: 'field', type: 'number', min: 1, max: 60, value: 3, 'aria-label': 'Rows' });
    const c = h('input', { class: 'field', type: 'number', min: 1, max: 20, value: 3, 'aria-label': 'Columns' });
    PE.ui.dialog({
      title: 'Insert table',
      body: [h('div', { class: 'p-grid2' }, [h('label', { class: 'fld' }, ['Rows', r]), h('label', { class: 'fld' }, ['Columns', c])])],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Insert', primary: true, onClick: () => (restoreFocus(), Doc.insertTable(PE.clamp(+r.value || 3, 1, 60), PE.clamp(+c.value || 3, 1, 20))) },
      ],
    });
  }
  function pageSetupDialog() {
    const D = Doc.D,
      P = D.page;
    const sizes = { A4: [595.3, 841.9], Letter: [612, 792], Legal: [612, 1008], A5: [419.5, 595.3] };
    const cur = Object.keys(sizes).find((k) => Math.abs(sizes[k][0] - Math.min(P.w, P.h)) < 2 && Math.abs(sizes[k][1] - Math.max(P.w, P.h)) < 2) || 'Custom';
    const sel = h('select', { class: 'field', 'aria-label': 'Paper size' });
    for (const k of Object.keys(sizes).concat(cur === 'Custom' ? ['Custom'] : [])) sel.appendChild(h('option', { value: k, selected: k === cur }, k));
    const orient = h('select', { class: 'field', 'aria-label': 'Orientation' }, [h('option', { value: 'p', selected: P.h >= P.w }, 'Portrait'), h('option', { value: 'l', selected: P.w > P.h }, 'Landscape')]);
    const mar = h('input', { class: 'field', type: 'number', min: 0.2, max: 3, step: 0.1, value: (P.ml / 72).toFixed(2), 'aria-label': 'Margins in inches' });
    PE.ui.dialog({
      title: 'Page setup',
      body: [h('label', { class: 'fld' }, ['Paper size', sel]), h('label', { class: 'fld' }, ['Orientation', orient]), h('label', { class: 'fld' }, ['Margins (inches, all sides)', mar])],
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Apply',
          primary: true,
          onClick: () => {
            commitNow();
            let [w, hh] = sel.value === 'Custom' ? [Math.min(P.w, P.h), Math.max(P.w, P.h)] : sizes[sel.value];
            if (orient.value === 'l') [w, hh] = [hh, w];
            const m = PE.clamp(+mar.value || 1, 0.2, 3) * 72;
            Object.assign(P, { w, h: hh, ml: m, mr: m, mt: m, mb: m });
            D.sectXml = setSectGeometry(D.sectXml, P);
            sizePages();
            renderSheets();
            paginate();
            hist.push();
            changed();
          },
        },
      ],
    });
  }
  function setSectGeometry(xml, P) {
    const sz = `<w:pgSz w:w="${Math.round(P.w * 20)}" w:h="${Math.round(P.h * 20)}"${P.w > P.h ? ' w:orient="landscape"' : ''}/>`;
    const mg = `<w:pgMar w:top="${Math.round(P.mt * 20)}" w:right="${Math.round(P.mr * 20)}" w:bottom="${Math.round(P.mb * 20)}" w:left="${Math.round(P.ml * 20)}" w:header="${Math.round(P.hd * 20)}" w:footer="${Math.round(P.fd * 20)}" w:gutter="0"/>`;
    if (!xml) return `<w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${sz}${mg}</w:sectPr>`;
    xml = /<w:pgSz[^>]*\/>/.test(xml) ? xml.replace(/<w:pgSz[^>]*\/>/, sz) : xml.replace(/(<w:sectPr[^>]*>)/, '$1' + sz);
    xml = /<w:pgMar[^>]*\/>/.test(xml) ? xml.replace(/<w:pgMar[^>]*\/>/, mg) : xml.replace(sz, sz + mg);
    return xml;
  }

  function fillStyleSelect() {
    const sel = $('#dm-style');
    sel.innerHTML = '';
    const styles = Doc.D.styles.length ? Doc.D.styles : [{ id: '', name: 'Normal' }];
    for (const s of styles) sel.appendChild(h('option', { value: s.id }, s.name));
  }
  const updateBarSoon = PE.debounce(() => updateBar(), 60);
  function updateBar() {
    if (!Doc.active) return;
    const st = styleAt();
    const bar = $('#doc-bar');
    const set = (k, on) => {
      const b = bar.querySelector(`[data-dm="${k}"]`);
      if (b) {
        b.classList.toggle('on', !!on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    };
    if (st) {
      const fs = $('#dm-font');
      fs.value = st.fam;
      fs.title = st.fontName && (PE.docx.WORD_NAME[st.fam] || '') !== st.fontName ? `${st.fontName} (shown with ${PE.docx.WORD_NAME[st.fam] || st.fam})` : '';
      if (document.activeElement !== $('#dm-size')) $('#dm-size').value = +st.size.toFixed(1);
      set('b', st.b);
      set('i', st.i);
      set('u', st.u);
      set('s', st.s);
      const cbar = bar.querySelector('[data-dm="color"] .cbar');
      if (cbar) cbar.style.background = st.color;
    }
    const ps = selectedBlocks();
    const p = ps[0];
    if (p) {
      const al = getComputedStyle(p).textAlign;
      for (const a of ['left', 'center', 'right', 'justify']) set(a, al === a || (a === 'left' && al === 'start'));
      $('#dm-style').value = p.getAttribute('data-ps') || '';
      if ($('#dm-style').selectedIndex < 0) $('#dm-style').value = '';
      set('bullets', p.classList.contains('li') && listKind(p) === 'bullet');
      set('numbers', p.classList.contains('li') && listKind(p) === 'number');
    }
    set('table', Doc.inTable());
  }

  /* =================================================================
   *  saving
   * ================================================================= */
  Doc.docxBytes = async function () {
    commitNow();
    const c = els.body.cloneNode(true);
    clearPagination(c);
    // the writer reads computed styles, so it works on a live (hidden) copy
    const host = h('div', { class: 'dm-body dm-shadow', style: { width: els.body.style.width } });
    host.innerHTML = c.innerHTML;
    els.pages.appendChild(host);
    try {
      return await PE.docx.write(Doc.D, host);
    } finally {
      host.remove();
    }
  };
  /** write any editor HTML (e.g. a converted PDF) as a .docx */
  PE.docx.fromHtml = async function (D) {
    const style = h('style', {}, D.css || '');
    document.head.appendChild(style);
    const host = h('div', { class: 'dm-body dm-shadow', html: D.html, style: { width: D.page.w - D.page.ml - D.page.mr + 'px', position: 'absolute', left: '-99999px', top: '0' } });
    document.body.appendChild(host);
    try {
      PE.docx.renumber(host, D.N);
      return await PE.docx.write(D, host);
    } finally {
      host.remove();
      style.remove();
    }
  };

  /** PDF of the document, laid out exactly as on screen */
  Doc.pdfBytes = async function (onProgress) {
    // the PDF always uses the real pages
    if (Doc.web) {
      Doc.web = false;
      const z = Doc.zoom;
      Doc.zoom = 1;
      sizePages();
      paginate();
      try {
        return await Doc.pdfBytes(onProgress);
      } finally {
        Doc.web = true;
        Doc.zoom = z;
        pageCount = -1;
        sizePages();
        paginate();
      }
    }
    commitNow();
    deselectImage();
    await loadFonts(Doc.D.fams.concat(fontsInUse()));
    paginate();
    await PE.raf();
    const { PDFDocument } = PDFLib;
    const kit = PE.exportKit;
    const D = Doc.D,
      P = D.page;
    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const ctx = { fontCache: {}, imgCache: {}, missing: 0, covCache: {}, out };
    ctx.cov = async (id) => {
      if (!ctx.covCache[id]) ctx.covCache[id] = kit.coverage(id);
      return ctx.covCache[id];
    };
    const pages = [];
    for (let k = 0; k < pageCount; k++) pages.push(out.addPage([P.w, P.h]));
    const z = Doc.zoom;
    const org = els.pages.getBoundingClientRect();
    const loc = (r) => ({ x: (r.left - org.left) / z, y: (r.top - org.top) / z, w: r.width / z, h: r.height / z });
    const PH = P.h + GAP;
    const pageAt = (y) => PE.clamp(Math.floor(y / PH), 0, pageCount - 1);
    const pdfY = (y) => P.h - (y - pageAt(y) * PH);
    const rgbOf = (c) => {
      const m = (c || '').match(/[\d.]+/g);
      return m ? PDFLib.rgb(+m[0] / 255, +m[1] / 255, +m[2] / 255) : PDFLib.rgb(0, 0, 0);
    };
    const opaque = (c) => c && !isClear(c);
    const fillRect = (x, y, w, hh, color) => {
      if (w <= 0 || hh <= 0) return;
      const k = pageAt(y + Math.min(hh, 2) / 2);
      const top = y - k * PH;
      pages[k].drawRectangle({ x, y: P.h - top - hh, width: w, height: hh, color });
    };
    const roots = [els.sheets, els.body];
    // 1) backgrounds: paragraph shading, cell shading, highlighted text
    for (const root of roots)
      for (const el of root.querySelectorAll('p, td, span, a')) {
        const cs = getComputedStyle(el);
        if (!opaque(cs.backgroundColor)) continue;
        const rects = el.tagName === 'SPAN' || el.tagName === 'A' ? Array.from(el.getClientRects()) : [el.getBoundingClientRect()];
        for (const r of rects) {
          const l = loc(r);
          fillRect(l.x, l.y, l.w, l.h, rgbOf(cs.backgroundColor));
        }
      }
    // 2) borders of cells and paragraphs
    for (const root of roots)
      for (const el of root.querySelectorAll('td, p')) {
        const cs = getComputedStyle(el);
        const l = loc(el.getBoundingClientRect());
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const w = parseFloat(cs.getPropertyValue(`border-${side}-width`));
          const st = cs.getPropertyValue(`border-${side}-style`);
          if (!(w > 0) || st === 'none' || st === 'hidden') continue;
          const col = rgbOf(cs.getPropertyValue(`border-${side}-color`));
          if (side === 'top') fillRect(l.x, l.y, l.w, w, col);
          if (side === 'bottom') fillRect(l.x, l.y + l.h - w, l.w, w, col);
          if (side === 'left') fillRect(l.x, l.y, w, l.h, col);
          if (side === 'right') fillRect(l.x + l.w - w, l.y, w, l.h, col);
        }
      }
    if (onProgress) onProgress(0.3, 'Placing pictures');
    // 3) pictures
    for (const img of els.pages.querySelectorAll('img')) {
      const m = D.media[img.getAttribute('data-m')];
      if (!m) continue;
      const l = loc(img.getBoundingClientRect());
      const k = pageAt(l.y + l.h / 2);
      try {
        let pimg;
        if (m.mime === 'image/jpeg') pimg = await out.embedJpg(m.bytes);
        else if (m.mime === 'image/png') pimg = await out.embedPng(m.bytes);
        else {
          const n = await PE.normalizeImage(m.bytes, m.mime);
          pimg = n.mime === 'image/jpeg' ? await out.embedJpg(n.bytes) : await out.embedPng(n.bytes);
        }
        pages[k].drawImage(pimg, { x: l.x, y: P.h - (l.y - k * PH) - l.h, width: l.w, height: l.h });
      } catch (e) {
        console.warn('picture', e);
      }
    }
    if (onProgress) onProgress(0.45, 'Writing text');
    // 4) text, word by word, in the bundled fonts
    const segs = await measureText(els.pages, loc, ctx);
    // list markers
    for (const p of els.body.querySelectorAll('p.li[data-marker]')) {
      const mk = p.getAttribute('data-marker');
      if (!mk) continue;
      const first = firstTextRect(p);
      const cs = getComputedStyle(p);
      const fam = (cs.fontFamily.match(/PEF-([a-z-]+)/) || [])[1] || 'carlito';
      const size = first ? first.size : parseFloat(cs.fontSize);
      const fb = first ? first.b : false;
      const pr = loc(p.getBoundingClientRect());
      const hang = parseFloat(cs.getPropertyValue('--hang')) || 18;
      const x = pr.x + parseFloat(cs.paddingLeft) - hang;
      const m = PE.fonts.metrics(fam, fb, false);
      const baseline = first ? first.baseline : pr.y + parseFloat(cs.paddingTop) + m.asc * size;
      let fid = PE.fonts.fontId(fam, fb, false);
      const cov = await ctx.cov(fid);
      if (!Array.from(mk).every((ch) => cov(ch.codePointAt(0)))) fid = PE.fonts.fontId('arimo', false, false);
      segs.push({ t: mk, fid, x, baseline, s: size, c: first ? first.c : '#000000', top: baseline - size });
    }
    const byPage = pages.map(() => []);
    for (const s of segs) {
      const k = pageAt(s.top + s.s * 0.5);
      byPage[k].push(Object.assign({}, s, { baseline: s.baseline - k * PH, x: s.x }));
    }
    for (let k = 0; k < pages.length; k++) {
      kit.push(pages[k], [1, 0, 0, 1, 0, P.h]);
      await kit.drawSegs(ctx, pages[k], byPage[k]);
      kit.pop(pages[k]);
      if (onProgress) onProgress(0.5 + (0.45 * (k + 1)) / pages.length, `Writing page ${k + 1} of ${pages.length}`);
    }
    out.setTitle(D.name.replace(/\.docx$/i, ''));
    out.setProducer('Edivora');
    return { bytes: await out.save({ useObjectStreams: true }), missing: ctx.missing };
  };
  function fontsInUse() {
    const s = new Set();
    els.body.querySelectorAll('[style*="PEF-"]').forEach((n) => {
      const m = n.style.fontFamily.match(/PEF-([a-z-]+)/);
      if (m) s.add(m[1]);
    });
    return [...s];
  }
  const isClear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  function firstTextRect(p) {
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.nodeValue.replace(/[​\s]/g, '');
      if (!t) continue;
      const i = n.nodeValue.search(/[^​\s]/);
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 1);
      const rect = r.getClientRects()[0];
      if (!rect) continue;
      const cs = getComputedStyle(n.parentNode);
      const fam = (cs.fontFamily.match(/PEF-([a-z-]+)/) || [])[1] || 'carlito';
      const size = parseFloat(cs.fontSize);
      const b = +cs.fontWeight >= 600;
      const m = PE.fonts.metrics(fam, b, cs.fontStyle === 'italic');
      const z = Doc.zoom;
      const org = els.pages.getBoundingClientRect();
      const top = (rect.top - org.top) / z;
      return { baseline: top + m.asc * size, size, b, c: hexOf(cs.color) };
    }
    return null;
  }
  const hexOf = (c) => {
    const m = (c || '').match(/\d+/g);
    return m ? PE.rgbToHex(+m[0], +m[1], +m[2]) : '#000000';
  };
  /** one segment per run of characters on a line in the same font */
  async function measureText(root, loc, ctx) {
    const segs = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node;
    const z = Doc.zoom;
    while ((node = walker.nextNode())) {
      const txt = node.nodeValue;
      if (!txt || !txt.replace(/[​\s]/g, '')) continue;
      const parent = node.parentNode;
      if (parent.closest('.dm-shadow,.dm-ui')) continue;
      const cs = getComputedStyle(parent);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const fam = (cs.fontFamily.match(/PEF-([a-z-]+)/) || [])[1] || 'carlito';
      const b = +cs.fontWeight >= 600,
        it = cs.fontStyle === 'italic';
      const size = parseFloat(cs.fontSize);
      let deco = '';
      for (let x = parent; x && x !== root && x !== els.body; x = x.parentNode) deco += ' ' + getComputedStyle(x).textDecorationLine;
      const u = /underline/.test(deco);
      const color = hexOf(cs.color);
      const upper = cs.textTransform === 'uppercase';
      const prim = PE.fonts.fontId(fam, b, it);
      const covPrim = await ctx.cov(prim);
      let pos = 0,
        cur = null;
      for (const g0 of PE.graphemes(txt)) {
        const start = pos;
        pos += g0.length;
        const g = upper ? g0.toUpperCase() : g0;
        const clean = g.replace(PE.exportKit.ZW, '').replace(/[​­]/g, '');
        const isSpace = !clean.trim();
        range.setStart(node, start);
        range.setEnd(node, pos);
        const r = range.getClientRects()[0];
        if (isSpace || !r) {
          if (cur && u && r) cur.uRight = loc(r).x + r.width / z;
          cur = null;
          continue;
        }
        let fid = prim;
        const cps = Array.from(clean).map((ch) => ch.codePointAt(0));
        if (!cps.every(covPrim)) {
          fid = null;
          for (const fb of PE.fonts.FALLBACKS.concat([{ key: 'arimo' }])) {
            const id = PE.fonts.fontId(fb.key, b, false);
            const cv = await ctx.cov(id);
            if (cps.every(cv)) {
              fid = id;
              break;
            }
          }
          if (!fid) {
            ctx.missing++;
            cur = null;
            continue;
          }
        }
        const l = loc(r);
        if (!cur || cur.fid !== fid || Math.abs(cur.top - l.y) > 1.5 || l.x < cur.right - 1.5) {
          const famKey = fid.replace(/-(r|b|i|bi)$/, '');
          const m = PE.fonts.metrics(famKey, b, PE.fonts.famByKey[famKey] ? it : false);
          cur = { t: '', fid, x: l.x, top: l.y, baseline: l.y + m.asc * size, right: l.x + l.w, s: size, c: color, u };
          segs.push(cur);
        }
        cur.t += clean;
        cur.right = l.x + l.w;
        cur.uRight = cur.right;
      }
    }
    // drawSegs draws at y = -baseline: flip into the page frame
    return segs.map((s) => Object.assign(s, { baseline: s.baseline }));
  }

  /* =================================================================
   *  PDF -> Word
   * ================================================================= */
  /** Build an editable Word document from the PDF pages (text, tables, pictures). */
  PE.pdfToDoc = async function (onProgress) {
    const V = PE.view;
    const pages = PE.S.pages;
    const name = PE.app.fileName.replace(/\.pdf$/i, '') + '.docx';
    const D = await PE.docx.read(await PE.docx.blank(), name);
    const first = pages[0];
    const fsz = first ? PE.dispSize(first) : { w: 595.3, h: 841.9 };
    // margins from where the content sits
    let minX = Infinity,
      minY = Infinity,
      maxR = 0,
      maxB = 0;
    const items = [];
    for (let n = 0; n < pages.length; n++) {
      const pg = pages[n];
      if (onProgress) onProgress(n / pages.length, `Reading page ${n + 1} of ${pages.length}`);
      const its = [];
      const { W, H } = PE.baseSize(pg);
      let ex = null;
      if (pg.src.t === 'pdf') ex = await PE.extractPage(pg.src.doc, pg.src.i);
      if (ex && !ex.failed) {
        V.renderOverlay(pg);
        const pv = V.els.get(pg.id);
        const shift = (pv && pv.shift) || {};
        const inTbl = new Set();
        for (const T of ex.tables || []) {
          const mem = T.mem.filter((m) => !m.g);
          if (!mem.some((m) => !(pg.ov[m.id] && pg.ov[m.id].del))) continue;
          mem.forEach((m) => inTbl.add(m.id));
          its.push({ kind: 'table', T, ex, pg, top: T.y + (shift[T.id] || 0), x: T.x, w: T.w, h: T.h });
        }
        for (const b of ex.blocks) {
          const ov = pg.ov[b.id];
          if ((ov && ov.del) || inTbl.has(b.id)) continue;
          const info = V.blockInfo(pg, ex, b);
          const el = pv && pv.baseEls && pv.baseEls[b.id];
          const top = b.top + (shift[b.id] || 0) + ((ov && ov.dy) || 0);
          const x = b.x + ((ov && ov.dx) || 0);
          const hh = el && el.classList.contains('mat') ? el.offsetHeight : b.h;
          its.push({ kind: 'text', runs: info.runs, align: info.align, lh: info.lh, x, top, w: Math.max(b.w, info.w || 0), h: hh, size: b.size0, multi: !b.single });
        }
        const hasText = ex.blocks.length > 0;
        for (const im of ex.images) {
          const ov = pg.ov[im.id];
          if (ov && ov.del) continue;
          if (im.bbox.w > W * 0.9 && im.bbox.h > H * 0.9 && hasText) continue; // scan / page background
          const g = Object.assign({ x: im.bbox.x, y: im.bbox.y + (shift[im.id] || 0), w: im.bbox.w, h: im.bbox.h }, ov && ov.x != null ? { x: ov.x, y: ov.y, w: ov.w, h: ov.h } : {});
          const a = (ov && ov.a) || (await V.ensureBaseImageAsset(pg, im).catch(() => null));
          if (a && PE.assets[a]) its.push({ kind: 'img', a, x: g.x, top: g.y, w: g.w, h: g.h });
        }
      } else if (pg.src.t === 'img') its.push({ kind: 'img', a: pg.src.a, x: 0, top: 0, w: W, h: H });
      for (const o of pg.objs) {
        if (o.type === 'text' && o.runs.map((r) => r.t).join('').trim()) {
          const el = V.objEl(pg, o.id);
          its.push({ kind: 'text', runs: o.runs, align: o.align || 'left', lh: o.lh || 1.2, x: o.x, top: o.y, w: el ? el.offsetWidth : o.w, h: el ? el.offsetHeight : 14, size: o.runs[0].s, multi: true });
        } else if (o.type === 'image') its.push({ kind: 'img', a: o.a, x: o.x, top: o.y, w: o.w, h: o.h });
        else if (o.type === 'table') {
          const el = V.objEl(pg, o.id);
          its.push({ kind: 'tobj', o, x: o.x, top: o.y, w: o.w, h: el ? el.offsetHeight : o.h || 40 });
        }
      }
      for (const it of its) {
        minX = Math.min(minX, it.x);
        minY = Math.min(minY, it.top);
        maxR = Math.max(maxR, it.x + it.w);
        maxB = Math.max(maxB, it.top + it.h);
      }
      its.sort((a, b) => a.top - b.top || a.x - b.x);
      items.push({ pg, its, W, H });
    }
    const page = D.page;
    page.w = fsz.w;
    page.h = fsz.h;
    page.ml = PE.clamp(isFinite(minX) ? minX - 2 : 72, 18, 90);
    page.mt = PE.clamp(isFinite(minY) ? minY - 4 : 72, 18, 90);
    page.mr = PE.clamp(isFinite(maxR) ? page.w - maxR - 2 : 72, 18, 90);
    page.mb = PE.clamp(isFinite(maxB) ? page.h - maxB - 4 : 72, 18, 72);
    const cw = page.w - page.ml - page.mr;
    D.sectXml = setSectGeometry('', page);
    const host = h('div');
    const fams = new Set(['carlito']);
    items.forEach((pgItems, n) => {
      if (n > 0) host.appendChild(h('div', { class: 'dm-pb', contenteditable: 'false' }));
      let prevBottom = page.mt;
      for (const it of pgItems.its) {
        const gap = Math.max(0, it.top - prevBottom);
        if (it.kind === 'text') {
          const p = h('p');
          const lh = PE.clamp(it.lh || 1.2, 0.9, 3);
          p.style.lineHeight = String(+lh.toFixed(3));
          p.style.paddingTop = Math.max(0, gap - ((lh - 1.15) * it.size) / 2).toFixed(1) + 'px';
          p.style.paddingBottom = '0px';
          const indent = Math.max(0, it.x - page.ml);
          if (it.align === 'center') p.style.textAlign = 'center';
          else if (it.align === 'right') {
            p.style.textAlign = 'right';
            p.style.paddingRight = Math.max(0, page.w - page.mr - (it.x + it.w)).toFixed(1) + 'px';
          } else {
            if (it.align === 'justify') p.style.textAlign = 'justify';
            if (indent > 1) p.style.paddingLeft = indent.toFixed(1) + 'px';
            if (it.multi) p.style.paddingRight = Math.max(0, page.w - page.mr - (it.x + it.w) - 2).toFixed(1) + 'px';
          }
          for (const r of it.runs) {
            const parts = r.t.split('\n');
            parts.forEach((t, k) => {
              if (k > 0) p.appendChild(h('br'));
              if (!t) return;
              const sp = h('span', {}, t);
              sp.style.fontFamily = PE.fonts.cssFamily(r.f);
              sp.setAttribute('data-font', PE.docx.WORD_NAME[r.f] || r.f);
              sp.style.fontSize = r.s + 'px';
              sp.style.fontWeight = r.b ? '700' : '400';
              sp.style.fontStyle = r.i ? 'italic' : 'normal';
              if (r.u) sp.style.textDecoration = 'underline';
              if (r.c && r.c !== '#000000') sp.style.color = r.c;
              fams.add(r.f);
              p.appendChild(sp);
            });
          }
          if (!p.firstChild) p.appendChild(h('br'));
          host.appendChild(p);
          prevBottom = Math.max(prevBottom, it.top + it.h);
        } else if (it.kind === 'img') {
          const a = PE.assets[it.a];
          const key = 'm' + D.mediaSeq++;
          D.media[key] = { bytes: a.bytes, mime: a.mime, url: a.url };
          let w = Math.min(it.w, cw),
            hh = (it.h * w) / it.w;
          const p = h('p', { style: { paddingTop: gap.toFixed(1) + 'px', paddingBottom: '0px', lineHeight: '1' } });
          const indent = Math.max(0, Math.min(it.x - page.ml, cw - w));
          if (indent > 1) p.style.paddingLeft = indent.toFixed(1) + 'px';
          p.appendChild(h('img', { class: 'dm-img', src: a.url, alt: '', 'data-m': key, draggable: 'false', style: { width: w.toFixed(2) + 'px', height: hh.toFixed(2) + 'px' } }));
          host.appendChild(p);
          prevBottom = Math.max(prevBottom, it.top + it.h);
        } else if (it.kind === 'table' || it.kind === 'tobj') {
          if (gap > 3) host.appendChild(h('p', { style: { lineHeight: gap.toFixed(1) + 'px', paddingTop: '0px', paddingBottom: '0px' } }, [h('br')]));
          host.appendChild(it.kind === 'table' ? tableFromPdf(it, page, fams) : tableFromObj(it.o, page, fams));
          prevBottom = Math.max(prevBottom, it.top + it.h);
        }
      }
    });
    if (!host.firstChild) host.appendChild(h('p', {}, [h('br')]));
    D.html = host.innerHTML;
    D.fams = [...fams];
    if (onProgress) onProgress(1, 'Done');
    return D;
  };
  function cellBorder(td, c, w) {
    for (const s of ['top', 'right', 'bottom', 'left']) td.style.setProperty('border-' + s, w > 0 ? `${w}px solid ${c}` : 'none');
  }
  function tableFromPdf(it, page, fams) {
    const { T, ex, pg } = it;
    const V = PE.view;
    let xs = T.xs.length >= 2 ? T.xs.slice() : null;
    const blocks = ex.blocks.filter((b) => T.mem.some((m) => m.id === b.id) && !(pg.ov[b.id] && pg.ov[b.id].del));
    if (!xs) {
      xs = [T.x];
      blocks
        .map((b) => b.x)
        .sort((a, b) => a - b)
        .forEach((x) => {
          if (x - xs[xs.length - 1] > 14) xs.push(x - 5);
        });
      xs.push(T.x + T.w);
    }
    const ys = [T.ys[0]];
    for (let k = 1; k < T.ys.length; k++) if (T.ys[k] - ys[ys.length - 1] > 5 || k === T.ys.length - 1) ys.push(T.ys[k]);
    const nr = ys.length - 1,
      nc = xs.length - 1;
    const color = (ex.graphics.find((g) => T.gids.includes(g.id) && g.k === 'line') || {}).c || '#000000';
    const t = h('table', { class: 'dm-tbl' });
    const cg = h('colgroup');
    for (let c = 0; c < nc; c++) cg.appendChild(h('col', { style: { width: (xs[c + 1] - xs[c]).toFixed(2) + 'px' } }));
    t.appendChild(cg);
    t.style.width = (xs[nc] - xs[0]).toFixed(2) + 'px';
    if (xs[0] - page.ml > 2) t.style.marginLeft = (xs[0] - page.ml).toFixed(1) + 'px';
    const tb = h('tbody');
    const cells = [];
    for (let r = 0; r < nr; r++) {
      const tr = h('tr', { style: { height: (ys[r + 1] - ys[r]).toFixed(1) + 'px' } });
      cells.push([]);
      for (let c = 0; c < nc; c++) {
        const td = h('td');
        cellBorder(td, color, T.xs.length >= 2 ? 0.5 : 0);
        if (T.xs.length < 2) {
          td.style.borderTop = r === 0 ? `0.75px solid ${color}` : 'none';
          td.style.borderBottom = r === nr - 1 || r === 0 ? `0.75px solid ${color}` : 'none';
        }
        tr.appendChild(td);
        cells[r].push(td);
      }
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    const find = (arr, v) => {
      let k = 0;
      while (k < arr.length - 2 && v > arr[k + 1]) k++;
      return k;
    };
    for (const g of ex.graphics)
      if (T.gids.includes(g.id) && g.k === 'rect' && g.w > 3 && g.h > 3)
        for (let r = 0; r < nr; r++)
          for (let c = 0; c < nc; c++) {
            const cx = (xs[c] + xs[c + 1]) / 2,
              cy = (ys[r] + ys[r + 1]) / 2;
            if (cx > g.x && cx < g.x + g.w && cy > g.y && cy < g.y + g.h) cells[r][c].style.backgroundColor = g.c;
          }
    for (const b of blocks.sort((a, c) => a.top - c.top || a.x - c.x)) {
      const info = V.blockInfo(pg, ex, b);
      const ri = find(ys, b.top + b.h / 2);
      const td = cells[ri][find(xs, b.x + b.w / 2)];
      // keep the text's distance from the cell's top border
      const padTop = td.firstChild ? 0 : PE.clamp(b.top - ys[ri] - 1.5, 0, 12);
      const p = h('p', { style: { paddingTop: padTop.toFixed(1) + 'px', paddingBottom: '0px', lineHeight: '1.15' } });
      if (info.align === 'center' || info.align === 'right') p.style.textAlign = info.align;
      for (const r of info.runs) {
        const parts = r.t.split('\n');
        parts.forEach((tx, k) => {
          if (k > 0) p.appendChild(h('br'));
          if (!tx) return;
          const sp = h('span', {}, tx);
          sp.style.fontFamily = PE.fonts.cssFamily(r.f);
          sp.setAttribute('data-font', PE.docx.WORD_NAME[r.f] || r.f);
          sp.style.fontSize = r.s + 'px';
          sp.style.fontWeight = r.b ? '700' : '400';
          sp.style.fontStyle = r.i ? 'italic' : 'normal';
          if (r.c && r.c !== '#000000') sp.style.color = r.c;
          fams.add(r.f);
          p.appendChild(sp);
        });
      }
      td.appendChild(p);
    }
    for (const row of cells) for (const td of row) if (!td.firstChild) td.appendChild(h('p', { style: { paddingTop: '0px', paddingBottom: '0px' } }, [h('br')]));
    return t;
  }
  function tableFromObj(o, page, fams) {
    const t = h('table', { class: 'dm-tbl' });
    const cg = h('colgroup');
    const total = o.cw.reduce((a, b) => a + b, 0);
    o.cw.forEach((w) => cg.appendChild(h('col', { style: { width: ((w / total) * o.w).toFixed(2) + 'px' } })));
    t.appendChild(cg);
    t.style.width = o.w + 'px';
    if (o.x - page.ml > 2) t.style.marginLeft = (o.x - page.ml).toFixed(1) + 'px';
    const tb = h('tbody');
    fams.add(o.f || 'arimo');
    o.rows.forEach((row, ri) => {
      const tr = h('tr');
      if (o.rh && o.rh[ri]) tr.style.height = o.rh[ri] + 'px';
      row.forEach((cell) => {
        const td = h('td');
        cellBorder(td, o.border || '#000000', o.bw != null ? o.bw : 1);
        const bg = o.head && ri === 0 && o.headBg ? o.headBg : cell.bg;
        if (bg) td.style.backgroundColor = bg;
        const p = h('p', { style: { paddingTop: '0px', paddingBottom: '0px' } });
        if (cell.align) p.style.textAlign = cell.align;
        String(cell.t || '')
          .split('\n')
          .forEach((tx, k) => {
            if (k) p.appendChild(h('br'));
            if (!tx) return;
            const sp = h('span', {}, tx);
            sp.style.fontFamily = PE.fonts.cssFamily(o.f || 'arimo');
            sp.setAttribute('data-font', PE.docx.WORD_NAME[o.f || 'arimo']);
            sp.style.fontSize = (o.size || 11) + 'px';
            if (cell.b || (o.head && ri === 0)) sp.style.fontWeight = '700';
            if (o.color && o.color !== '#000000') sp.style.color = o.color;
            p.appendChild(sp);
          });
        if (!p.firstChild) p.appendChild(h('br'));
        td.appendChild(p);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    return t;
  }
})();
