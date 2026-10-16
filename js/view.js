/* Edivora — page views: canvas rendering, PDF-content overlay, objects, reflow layout */
'use strict';
(function () {
  const V = (PE.view = {
    zoom: 1,
    els: new Map(), // pageId -> page view
    imgCache: {}, // pageKey:imageId -> assetId (pixels of PDF images that were moved by reflow)
  });
  PE.settings = Object.assign({ reflow: true }, PE.store.get('settings', {}));

  V.init = function () {
    V.scroller = PE.$('#scroller');
    V.host = PE.$('#pages');
    V.measureHost = PE.$('#measure');
    V.io = new IntersectionObserver(onIntersect, { root: V.scroller, rootMargin: '900px 0px' });
    V.farIo = new IntersectionObserver(onFar, { root: V.scroller, rootMargin: '4000px 0px' });
    PE.fonts.onLoad(() => V.relayoutAll());
    let lastDpr = window.devicePixelRatio;
    window.addEventListener('resize', () => {
      if (window.devicePixelRatio !== lastDpr) {
        lastDpr = window.devicePixelRatio;
        V.rerenderVisible();
      }
    });
  };

  /* ---------- geometry ---------- */
  /** layer transform (base frame -> page box), unscaled */
  V.layerMatrix = function (pg) {
    const { W, H } = PE.baseSize(pg);
    const r = pg.rot;
    const t = r === 90 ? [H, 0] : r === 180 ? [W, H] : r === 270 ? [0, W] : [0, 0];
    return PE.M.mul(PE.M.tr(t[0], t[1]), PE.M.rot(r));
  };
  V.dispToBase = (pg) => PE.M.inv(V.layerMatrix(pg));

  /** client (screen) point -> base frame point of a page */
  V.clientToBase = function (pg, cx, cy) {
    const pv = V.els.get(pg.id);
    const r = pv.sheet.getBoundingClientRect();
    const dx = (cx - r.left) / V.zoom,
      dy = (cy - r.top) / V.zoom;
    return PE.M.apply(V.dispToBase(pg), dx, dy);
  };
  /** screen delta -> base frame delta */
  V.deltaToBase = (pg, dx, dy) => PE.rotVec(dx / V.zoom, dy / V.zoom, -pg.rot);

  /* ---------- page list ---------- */
  V.sync = function () {
    const seen = new Set();
    let prev = null;
    PE.S.pages.forEach((pg, idx) => {
      let pv = V.els.get(pg.id);
      if (!pv) pv = createPageView(pg);
      seen.add(pg.id);
      pv.label.textContent = 'Page ' + (idx + 1) + ' of ' + PE.S.pages.length;
      const want = prev ? prev.nextSibling : V.host.firstChild;
      if (want !== pv.root) V.host.insertBefore(pv.root, want);
      prev = pv.root;
      sizePage(pg, pv);
      V.renderOverlay(pg);
      const key = canvasKey(pg);
      if (pv.canvasKey !== key) {
        pv.canvasKey = null;
        if (pv.visible) renderCanvas(pg, pv);
      }
    });
    for (const [id, pv] of V.els)
      if (!seen.has(id)) {
        V.io.unobserve(pv.root);
        V.farIo.unobserve(pv.root);
        pv.root.remove();
        V.els.delete(id);
      }
    PE.$('#empty-pages').hidden = PE.S.pages.length > 0;
  };

  function createPageView(pg) {
    const root = PE.h('section', { class: 'page', 'data-pid': pg.id });
    const sheet = PE.h('div', { class: 'sheet' });
    const canvas = PE.h('canvas', { class: 'pg-canvas' });
    const layer = PE.h('div', { class: 'layer' });
    const covers = PE.h('div', { class: 'l-covers' });
    const base = PE.h('div', { class: 'l-base' });
    const objs = PE.h('div', { class: 'l-objs' });
    const virt = PE.h('div', { class: 'l-virt' });
    const forms = PE.h('div', { class: 'l-forms' });
    const ui = PE.h('div', { class: 'l-ui' });
    layer.append(covers, base, objs, virt, forms, ui);
    const spinner = PE.h('div', { class: 'pg-spin', html: '<i></i>' });
    const warn = PE.h('div', { class: 'pg-warn', hidden: true }, 'Some content was pushed past the bottom of this page');
    sheet.append(canvas, layer, spinner);
    const label = PE.h('div', { class: 'pg-label' });
    root.append(sheet, label, warn);
    const pv = { id: pg.id, root, sheet, canvas, layer, covers, base, objs, virt, forms, ui, label, spinner, warn, visible: false };
    V.els.set(pg.id, pv);
    V.io.observe(root);
    V.farIo.observe(root);
    return pv;
  }

  function sizePage(pg, pv) {
    const { W, H } = PE.baseSize(pg);
    const d = PE.dispSize(pg);
    const z = V.zoom;
    pv.sheet.style.width = d.w * z + 'px';
    pv.sheet.style.height = d.h * z + 'px';
    pv.layer.style.width = W + 'px';
    pv.layer.style.height = H + 'px';
    const m = V.layerMatrix(pg);
    pv.layer.style.transform = `matrix(${m[0] * z},${m[1] * z},${m[2] * z},${m[3] * z},${m[4] * z},${m[5] * z})`;
    pv.layer.style.setProperty('--iz', 1 / z);
  }

  const canvasKey = (pg) =>
    JSON.stringify(pg.src) + '|' + pg.rot + '|' + V.zoom.toFixed(3) + '|' + (window.devicePixelRatio || 1) + (PE.forms && PE.forms.active(pg) ? '|f' : '');

  function onIntersect(entries) {
    for (const e of entries) {
      const id = e.target.getAttribute('data-pid');
      const pv = V.els.get(id),
        pg = PE.findPage(id);
      if (!pv || !pg) continue;
      pv.visible = e.isIntersecting;
      if (e.isIntersecting) renderCanvas(pg, pv);
    }
  }
  function onFar(entries) {
    if (PE.S.pages.length < 12) return;
    for (const e of entries) {
      if (e.isIntersecting) continue;
      const pv = V.els.get(e.target.getAttribute('data-pid'));
      if (pv && pv.canvasKey) {
        pv.canvas.width = pv.canvas.height = 0;
        pv.canvasKey = null;
      }
    }
  }

  V.rerenderVisible = function () {
    for (const pg of PE.S.pages) {
      const pv = V.els.get(pg.id);
      if (!pv) continue;
      sizePage(pg, pv);
      if (pv.visible) renderCanvas(pg, pv);
      else pv.canvasKey = null;
    }
  };

  async function renderCanvas(pg, pv) {
    const key = canvasKey(pg);
    if (pv.canvasKey === key || pv.rendering === key) return;
    pv.rendering = key;
    const dpr = window.devicePixelRatio || 1;
    const d = PE.dispSize(pg);
    let scale = V.zoom * dpr;
    const maxPx = 14e6;
    if (d.w * d.h * scale * scale > maxPx) scale = Math.sqrt(maxPx / (d.w * d.h));
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(d.w * scale));
    off.height = Math.max(1, Math.round(d.h * scale));
    const ctx = off.getContext('2d');
    pv.spinner.classList.add('on');
    try {
      if (pg.src.t === 'pdf') {
        const page = await PE.getPdfPage(pg.src.doc, pg.src.i);
        const { srcRot } = PE.baseSize(pg);
        const vp = page.getViewport({ scale, rotation: (srcRot + pg.rot) % 360 });
        if (pv.task) pv.task.cancel();
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, off.width, off.height);
        const mode = PE.forms && PE.forms.active(pg) ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE;
        pv.task = page.render({ canvasContext: ctx, viewport: vp, annotationMode: mode });
        await pv.task.promise;
        pv.task = null;
        // read text & images once the page is visible
        const fresh = !PE.ex[PE.pageKey(pg)];
        const ex = await PE.extractPage(pg.src.doc, pg.src.i);
        if (ex) {
          // load the fonts this page uses now, so a tap on text can start editing instantly
          if (fresh && ex.blocks) PE.fonts.ensureRuns(ex.blocks.flatMap((b) => b.runs));
          V.renderOverlay(pg);
        }
      } else {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, off.width, off.height);
        if (pg.src.t === 'img') {
          if (PE.ocr && PE.ocr.ensureImageEx(pg)) V.renderOverlay(pg);
          const a = PE.assets[pg.src.a];
          const im = await loadImg(a.url);
          const { W, H } = PE.baseSize(pg);
          ctx.setTransform(scale, 0, 0, scale, 0, 0);
          const m = V.layerMatrix(pg);
          ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
          ctx.drawImage(im, 0, 0, W, H);
        }
      }
      if (pv.rendering !== key) return;
      pv.canvas.width = off.width;
      pv.canvas.height = off.height;
      pv.canvas.getContext('2d').drawImage(off, 0, 0);
      pv.canvasKey = key;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.warn('render failed', e);
    } finally {
      if (pv.rendering === key) pv.rendering = null;
      pv.spinner.classList.remove('on');
    }
  }
  const imgCache = {};
  function loadImg(url) {
    if (imgCache[url]) return imgCache[url];
    imgCache[url] = new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    return imgCache[url];
  }
  V.loadImg = loadImg;

  /* ---------- zoom ---------- */
  V.setZoom = function (z, anchor) {
    z = PE.clamp(z, 0.25, 5);
    if (Math.abs(z - V.zoom) < 0.001) return;
    const sc = V.scroller;
    const ax = anchor ? anchor.x : sc.clientWidth / 2,
      ay = anchor ? anchor.y : sc.clientHeight / 2;
    const fx = (sc.scrollLeft + ax) / Math.max(1, sc.scrollWidth),
      fy = (sc.scrollTop + ay) / Math.max(1, sc.scrollHeight);
    V.zoom = z;
    for (const pg of PE.S.pages) {
      const pv = V.els.get(pg.id);
      if (pv) sizePage(pg, pv);
    }
    sc.scrollLeft = fx * sc.scrollWidth - ax;
    sc.scrollTop = fy * sc.scrollHeight - ay;
    PE.ui && PE.ui.updateZoom();
    PE.tools && PE.tools.redrawSelection();
    rerenderSoon();
  };
  const rerenderSoon = PE.debounce(() => V.rerenderVisible(), 180);

  V.fitWidth = function () {
    if (!PE.S.pages.length) return;
    const maxW = Math.max(...PE.S.pages.map((p) => PE.dispSize(p).w));
    const avail = V.scroller.clientWidth - (window.innerWidth < 720 ? 20 : 64);
    V.setZoom(PE.clamp(avail / maxW, 0.25, 2.5));
  };
  V.fitPage = function () {
    if (!PE.S.pages.length) return;
    const pg = V.currentPage() || PE.S.pages[0];
    const d = PE.dispSize(pg);
    const z = Math.min((V.scroller.clientWidth - 64) / d.w, (V.scroller.clientHeight - 64) / d.h);
    V.setZoom(PE.clamp(z, 0.25, 3));
  };

  /** page nearest the viewport centre */
  V.currentPage = function () {
    const sc = V.scroller.getBoundingClientRect();
    const mid = sc.top + sc.height / 3;
    let best = null,
      bestD = Infinity;
    for (const pg of PE.S.pages) {
      const pv = V.els.get(pg.id);
      if (!pv) continue;
      const r = pv.sheet.getBoundingClientRect();
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < bestD) {
        bestD = d;
        best = pg;
      }
    }
    return best;
  };
  V.scrollToPage = function (id, smooth = true) {
    const pv = V.els.get(id);
    if (pv) pv.root.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  };

  /* ---------- text rendering shared by text boxes, PDF text blocks, tables ---------- */
  V.runStyle = function (r) {
    return (
      `font-family:${PE.fonts.cssFamily(r.f)};font-size:${r.s}px;font-weight:${r.b ? 700 : 400};` +
      `font-style:${r.i ? 'italic' : 'normal'};color:${r.c || '#000'};` +
      (r.u ? 'text-decoration:underline;' : '')
    );
  };
  V.fillRuns = function (el, runs) {
    el.innerHTML = '';
    if (!runs || !runs.length) return;
    PE.fonts.ensureRuns(runs);
    const frag = document.createDocumentFragment();
    for (const r of runs) {
      if (!r.t) continue;
      const span = document.createElement('span');
      span.setAttribute('style', V.runStyle(r));
      const parts = r.t.split('\n');
      parts.forEach((p, k) => {
        if (k > 0) span.appendChild(document.createElement('br'));
        if (p) span.appendChild(document.createTextNode(p));
      });
      frag.appendChild(span);
    }
    const all = runs.map((r) => r.t).join('');
    if (all.endsWith('\n') || !all.length) frag.appendChild(document.createElement('br'));
    el.appendChild(frag);
    const first = runs[0];
    el.style.fontSize = first.s + 'px';
    el.style.fontFamily = PE.fonts.cssFamily(first.f);
  };

  /** read runs back from a contenteditable element */
  V.readRuns = function (el, fallback) {
    const runs = [];
    const base = fallback || { f: 'arimo', b: false, i: false, u: false, s: 12, c: '#000000' };
    const push = (t, st) => {
      const last = runs[runs.length - 1];
      if (last && last.f === st.f && last.b === st.b && last.i === st.i && last.u === st.u && last.s === st.s && last.c === st.c)
        last.t += t;
      else runs.push(Object.assign({}, st, { t }));
    };
    const styleOf = (node) => {
      let n = node.nodeType === 1 ? node : node.parentNode;
      while (n && n !== el && !(n.tagName === 'SPAN' && n.style && n.style.fontSize)) n = n.parentNode;
      if (!n || n === el) return Object.assign({}, runs.length ? runs[runs.length - 1] : base, { t: undefined });
      return spanStyle(n, base);
    };
    const walk = (node, isFirstBlock) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          if (c.nodeValue) push(c.nodeValue.replace(/​/g, ''), styleOf(c));
        } else if (c.nodeType === 1) {
          const tag = c.tagName;
          if (tag === 'BR') push('\n', styleOf(c));
          else if (tag === 'DIV' || tag === 'P') {
            const all = runs.map((r) => r.t).join('');
            if (all.length && !all.endsWith('\n')) push('\n', styleOf(c));
            walk(c);
          } else walk(c);
        }
      }
    };
    walk(el);
    // drop the browser's trailing placeholder <br>
    const last = runs[runs.length - 1];
    if (last && last.t.endsWith('\n')) {
      const lastNode = el.lastChild;
      const trailingBr =
        (lastNode && lastNode.nodeName === 'BR') ||
        (lastNode && lastNode.lastChild && lastNode.lastChild.nodeName === 'BR' && lastNode.nodeName !== 'DIV');
      if (trailingBr) last.t = last.t.slice(0, -1);
    }
    for (const r of runs) delete r.undefined;
    return runs.filter((r) => r.t.length);
  };
  function spanStyle(n, base) {
    const st = n.style;
    const fam = (st.fontFamily.match(/PEF-([a-z-]+)/) || [])[1];
    const rgb = st.color.match(/\d+/g);
    return {
      f: fam && PE.fonts.famByKey[fam] ? fam : base.f,
      b: st.fontWeight === '700' || st.fontWeight === 'bold',
      i: st.fontStyle === 'italic',
      u: /underline/.test(st.textDecoration || st.textDecorationLine || ''),
      s: parseFloat(st.fontSize) || base.s,
      c: rgb ? PE.rgbToHex(+rgb[0], +rgb[1], +rgb[2]) : base.c,
    };
  }

  /* ---------- PDF text block layout info ---------- */
  function measureW(runs) {
    const span = PE.h('div', { class: 'txt measure-line' });
    V.fillRuns(span, runs);
    span.style.whiteSpace = 'pre';
    span.style.width = 'max-content';
    V.measureHost.appendChild(span);
    const w = span.getBoundingClientRect().width;
    span.remove();
    return w;
  }
  function measureH(el) {
    const c = el.cloneNode(true);
    c.style.position = 'absolute';
    c.style.left = '0';
    c.style.top = '0';
    c.style.transform = 'none';
    V.measureHost.appendChild(c);
    const h = c.offsetHeight;
    c.remove();
    return h;
  }

  /** default (unedited) geometry of a PDF text block rendered with our fonts */
  V.blockDefaults = function (ex, b) {
    const ready = b.runs.every((r) => PE.fonts.isLoaded(r.f, r.b, r.i));
    if (b.def && (b.def.ready || !ready)) return b.def;
    let w = b.w;
    for (const lr of b.lineRuns) w = Math.max(w, measureW(lr));
    w = Math.ceil(w + 1);
    const info = { runs: b.runs, align: b.align, lh: b.lh, w, auto: b.single, dx: 0, dy: 0 };
    const el = PE.h('div', { class: 'bb mat txt' });
    applyBlockStyle(el, ex, b, info);
    V.fillRuns(el, b.runs);
    info.h0 = measureH(el);
    info.ready = ready;
    b.def = info;
    return info;
  };
  V.blockInfo = function (pg, ex, b) {
    const ov = pg.ov[b.id];
    const def = V.blockDefaults(ex, b);
    if (!ov) return def;
    return Object.assign({}, def, ov);
  };
  function htmlTop(b, info) {
    const r0 = (info.runs && info.runs[0]) || b.runs[0];
    const m = PE.fonts.metrics(r0.f, r0.b, r0.i);
    const size = b.size0;
    return b.y0 - ((info.lh * size - (m.asc + m.desc) * size) / 2 + m.asc * size);
  }
  function applyBlockStyle(el, ex, b, info) {
    el.style.left = b.x + (info.dx || 0) + 'px';
    el.style.lineHeight = info.lh;
    el.style.textAlign = info.align;
    if (info.auto) {
      el.style.width = 'max-content';
      el.style.minWidth = info.w + 'px';
      // text in a table cell wraps at the cell's edge; other single lines may grow to the page edge
      const limit = b.maxR && !info.dx ? b.maxR - b.x : ex.W - b.x - (info.dx || 0) - 8;
      el.style.maxWidth = Math.max(info.w, limit) + 'px';
    } else {
      el.style.width = info.w + 'px';
      el.style.minWidth = el.style.maxWidth = '';
    }
  }

  /* ---------- overlay ---------- */
  V.renderOverlay = function (pg) {
    const pv = V.els.get(pg.id);
    if (!pv) return;
    const editingId = PE.tools && PE.tools.editing && PE.tools.editing.pg === pg.id ? PE.tools.editing.id : null;
    renderBase(pg, pv, editingId);
    // objects (the one being edited stays in the DOM so it keeps focus)
    let keepEl = null;
    for (const el of Array.from(pv.objs.children)) {
      if (editingId && el.getAttribute('data-oid') === editingId) keepEl = el;
      else el.remove();
    }
    let passed = false;
    for (const o of pg.objs) {
      if (keepEl && o.id === editingId) {
        V.styleObj(keepEl, o);
        passed = true;
        continue;
      }
      const el = V.renderObj(o);
      if (keepEl && !passed) pv.objs.insertBefore(el, keepEl);
      else pv.objs.appendChild(el);
    }
    renderVirtual(pg, pv);
    V.layoutBase(pg);
    if (PE.forms) PE.forms.render(pg, pv);
    if (PE.ocr) PE.ocr.banner(pg, pv);
    PE.tools && PE.tools.redrawSelection();
  };
  V.relayoutAll = function () {
    for (const pg of PE.S.pages) V.renderOverlay(pg);
  };

  function renderBase(pg, pv, editingId) {
    const key = PE.pageKey(pg);
    const ex = key && PE.ex[key];
    const keepEl = editingId && pv.editingEl && pv.editingEl.parentNode === pv.base ? pv.editingEl : null;
    for (const el of Array.from(pv.base.children)) if (el !== keepEl) el.remove();
    pv.covers.innerHTML = '';
    pv.baseEls = {};
    if (!ex || ex.failed) return;
    pv.ex = ex;
    const frag = document.createDocumentFragment();
    for (const im of ex.images) {
      const el = PE.h('div', { class: 'bi', 'data-bid': im.id });
      pv.baseEls[im.id] = el;
      frag.appendChild(el);
    }
    for (const b of ex.blocks) {
      if (keepEl && b.id === editingId) {
        pv.baseEls[b.id] = keepEl;
        continue;
      }
      const el = PE.h('div', { class: b.ocr ? 'bb ocr' : 'bb', 'data-bid': b.id });
      pv.baseEls[b.id] = el;
      frag.appendChild(el);
    }
    pv.base.insertBefore(frag, pv.base.firstChild);
  }

  /** position PDF content, applying edits and pushing content below grown blocks */
  V.layoutBase = function (pg) {
    const pv = V.els.get(pg.id);
    const key = PE.pageKey(pg);
    const ex = key && PE.ex[key];
    if (!pv || !ex || ex.failed || !pv.baseEls) return;
    const grow = {};
    const edId = PE.tools && PE.tools.editing && PE.tools.editing.pg === pg.id ? PE.tools.editing.id : null;
    // 1) render edited blocks so we can measure them
    for (const b of ex.blocks) {
      const ov = pg.ov[b.id];
      const el = pv.baseEls[b.id];
      if (!ov) continue;
      if (ov.del) {
        el.className = 'bb del';
        el.innerHTML = '';
        continue;
      }
      const info = V.blockInfo(pg, ex, b);
      if (b.id !== edId) {
        el.className = 'bb mat txt';
        V.fillRuns(el, info.runs);
      }
      el.style.height = '';
      applyBlockStyle(el, ex, b, info);
      const h = el.offsetHeight;
      const g = h - info.h0;
      // in a scan, single-line pieces (form fields, labels) don't push anything; paragraphs of running text do
      if (Math.abs(g) > 0.5 && !(b.ocr && b.single)) grow[b.id] = g;
    }
    // 2) propagate shifts top-down (tables grow row by row and stretch their borders)
    const { shift, gpos, tys } = computeShifts(pg, ex, grow);
    pv.shift = shift;
    pv.gpos = gpos;
    pv.tys = tys;
    pv.covers.innerHTML = '';
    let overflow = false;
    // 3) place blocks
    for (const b of ex.blocks) {
      const el = pv.baseEls[b.id];
      const ov = pg.ov[b.id];
      const sh = shift[b.id] || 0;
      if (ov && ov.del) {
        addCover(pv, b, b.bg);
        continue;
      }
      if (ov || sh) {
        const info = V.blockInfo(pg, ex, b);
        if (!ov && b.id !== edId) {
          el.className = 'bb mat txt';
          V.fillRuns(el, info.runs);
          applyBlockStyle(el, ex, b, info);
        }
        el.style.top = htmlTop(b, info) + sh + (info.dy || 0) + 'px';
        el.style.height = '';
        addCover(pv, b, b.bg);
        if (htmlTop(b, info) + sh + (info.dy || 0) + el.offsetHeight > ex.H + 1) overflow = true;
      } else {
        el.className = b.ocr ? 'bb ocr' : 'bb';
        el.innerHTML = '';
        el.removeAttribute('style');
        el.style.left = b.x + 'px';
        el.style.top = b.top + 'px';
        el.style.width = b.w + 'px';
        el.style.height = b.h + 'px';
      }
    }
    // 4) place images
    for (const im of ex.images) {
      const el = pv.baseEls[im.id];
      const ov = pg.ov[im.id];
      const sh = shift[im.id] || 0;
      if (ov && ov.del) {
        el.className = 'bi del';
        el.innerHTML = '';
        addCoverRect(pv, im.bbox, im.bg);
        continue;
      }
      if (ov || sh) {
        const g = Object.assign({ x: im.x, y: im.y, w: im.w, h: im.h, rot: im.rot, flipX: false, flipY: im.flipY }, ov || {});
        if (!(ov && ov.pinned)) g.y += sh;
        el.className = 'bi mat';
        el.style.cssText = `left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px;transform:rotate(${g.rot || 0}deg)`;
        const assetId = (ov && ov.a) || V.imgCache[key + ':' + im.id];
        if (assetId && PE.assets[assetId]) {
          if (!el.firstChild || el.firstChild.getAttribute('src') !== PE.assets[assetId].url)
            el.innerHTML = `<img draggable="false" alt="" src="${PE.assets[assetId].url}">`;
          el.firstChild.style.transform = `scale(${g.flipX ? -1 : 1},${g.flipY ? -1 : 1})`;
        } else {
          el.innerHTML = '';
          V.ensureBaseImageAsset(pg, im).then(() => V.layoutBase(pg));
        }
        addCoverRect(pv, im.bbox, im.bg);
        if (g.y + g.h > ex.H + 1) overflow = true;
      } else {
        el.className = 'bi';
        el.innerHTML = '';
        el.style.cssText = `left:${im.bbox.x}px;top:${im.bbox.y}px;width:${im.bbox.w}px;height:${im.bbox.h}px`;
      }
    }
    // 5) table lines, rules and boxes that moved or stretched with the content
    for (const g of ex.graphics || []) if (pg.ov[g.id] && pg.ov[g.id].del) addCoverRect(pv, { x: g.x, y: g.y, w: g.w, h: g.h }, g.bg);
    const gById = {};
    for (const g of ex.graphics || []) gById[g.id] = g;
    for (const id in gpos) {
      const c = V.graphicCover(gById[id], gpos[id]);
      if (c) addCoverRect(pv, c, gById[id].bg, 0);
    }
    for (const id in gpos) {
      const r = gpos[id];
      pv.covers.appendChild(PE.h('div', { class: 'gm', style: { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', background: r.c } }));
      if (r.y > ex.H) overflow = true;
    }
    // areas covered by tables that replaced a table from the PDF
    for (const o of pg.objs) if (o.type === 'table' && o.cover) addCoverRect(pv, o.cover, o.cover.c, 0);
    pv.warn.hidden = !overflow;
  };
  /** how far each element moves down, and where moved/stretched lines and boxes end up */
  function computeShifts(pg, ex, grow) {
    const shift = {},
      gpos = {},
      tys = {};
    // tables from the PDF that were turned into editable tables push what's below them
    const objGrow = {};
    for (const o of pg.objs)
      if (o.type === 'table' && o.src) {
        const el = V.objEl(pg, o.id);
        const D = (ex.tables || []).find((t) => t.id === o.src);
        if (el && D) objGrow[o.src] = o.y + el.offsetHeight - (D.y + D.h);
      }
    if (!PE.settings.reflow || (!Object.keys(grow).length && !Object.values(objGrow).some((v) => Math.abs(v) > 0.3))) return { shift, gpos, tys };
    PE.buildPreds(ex);
    const propagate = (order, preds, out, extra) => {
      for (const id of order) {
        const ps = preds[id];
        if (!ps || !ps.length) continue;
        let s = -Infinity;
        for (const p of ps) {
          let g = grow[p] || 0;
          if (extra && p in objGrow) g = objGrow[p] - (out[p] || 0);
          else if (extra) g += extra[p] || 0;
          s = Math.max(s, (out[p] || 0) + g);
        }
        if (Math.abs(s) > 0.3) out[id] = s;
      }
    };
    // growth of each table: rows get taller when the text in one of their cells needs more room
    const tgrow = {},
      tinfo = {};
    for (const T of ex.tables || []) {
      const n = T.ys.length - 1;
      const cum = [0],
        intra = {};
      for (let r = 0; r < n; r++) {
        const rg = T.rowGraphs[r];
        let need = 0;
        if (rg && rg.els.length && rg.els.some((m) => grow[m.id])) {
          propagate(rg.order, rg.preds, intra);
          let best = -Infinity;
          for (const m of rg.els) if (!m.g) best = Math.max(best, (intra[m.id] || 0) + (grow[m.id] || 0) - (m.gap - rg.minGap));
          if (best > -Infinity && Math.abs(best) > 0.3) need = best;
        }
        cum.push(cum[r] + need);
      }
      tinfo[T.id] = { cum, intra };
      if (Math.abs(cum[n]) > 0.3) tgrow[T.id] = cum[n];
    }
    propagate(ex.order, ex.preds, shift, tgrow);
    for (const T of ex.tables || []) {
      const ts = shift[T.id] || 0;
      tys[T.id] = T.ys.map((y, k) => y + ts + tinfo[T.id].cum[k]);
    }
    const gById = {};
    for (const g of ex.graphics || []) gById[g.id] = g;
    for (const T of ex.tables || []) {
      const { cum, intra } = tinfo[T.id];
      const ts = shift[T.id] || 0;
      if (!ts && !tgrow[T.id] && !Object.keys(intra).length) continue;
      for (const m of T.mem) {
        const s = ts + cum[m.row] + (intra[m.id] || 0);
        if (Math.abs(s) > 0.3) shift[m.id] = s;
        else delete shift[m.id];
      }
      const ys = T.ys;
      const mapY = (y) => {
        for (let k = 0; k < ys.length; k++) if (Math.abs(ys[k] - y) <= 1.6) return y + ts + cum[k];
        if (y < ys[0]) return y + ts;
        let r = 0;
        while (r < ys.length - 2 && y > ys[r + 1]) r++;
        return y + ts + cum[Math.min(r, cum.length - 1)];
      };
      for (const id of T.gids) {
        const g = gById[id];
        if (!g || (pg.ov[id] && pg.ov[id].del)) continue;
        const r = V.graphicRect(g, mapY),
          r0 = V.graphicRect(g, (y) => y);
        if (Math.abs(r.y - r0.y) > 0.3 || Math.abs(r.h - r0.h) > 0.3) gpos[id] = r;
      }
    }
    for (const g of ex.graphics || []) {
      if (gpos[g.id] || !shift[g.id] || (pg.ov[g.id] && pg.ov[g.id].del)) continue;
      const sh = shift[g.id];
      gpos[g.id] = V.graphicRect(g, (y) => y + sh);
    }
    return { shift, gpos, tys };
  }
  /** display rectangle of a rule / box from the PDF, with its top and bottom edges mapped by mapY */
  V.graphicRect = function (g, mapY) {
    if (g.k === 'line') {
      const lw = Math.max(g.lw || 0, 0.5);
      const hor = Math.abs(g.y1 - g.y2) < 0.5;
      const t = mapY(Math.min(g.y1, g.y2)),
        b = mapY(Math.max(g.y1, g.y2));
      if (hor) return { x: Math.min(g.x1, g.x2), w: Math.max(lw, Math.abs(g.x2 - g.x1)), y: t - lw / 2, h: lw, c: g.c };
      return { x: Math.min(g.x1, g.x2) - lw / 2, w: lw, y: t, h: Math.max(lw, b - t), c: g.c };
    }
    const t = mapY(g.y),
      b = mapY(g.y + g.h);
    return { x: g.x, y: t, w: g.w, h: Math.max(0.1, b - t), c: g.c };
  };
  function addCover(pv, b, bg) {
    // scanned text: a copy of the scan with the letters removed, so the paper texture stays
    if (b.patch && PE.assets[b.patch.a]) {
      const p = b.patch;
      pv.covers.appendChild(
        PE.h('div', {
          class: 'cv',
          style: { left: p.x + 'px', top: p.y + 'px', width: p.w + 'px', height: p.h + 'px', backgroundImage: `url("${PE.assets[p.a].url}")`, backgroundSize: '100% 100%' },
        })
      );
      return;
    }
    const r = V.blockCover(b);
    addCoverRect(pv, r, bg, 0);
  }
  /** area hiding a PDF text block's original drawing (kept inside its table cell) */
  V.blockCover = function (b) {
    let x0 = b.x - 1,
      y0 = b.top - 1,
      x1 = b.x + b.w + 1,
      y1 = b.top + b.h + 1;
    if (b.cell) {
      x0 = Math.max(x0, b.cell.l);
      y0 = Math.max(y0, b.cell.t);
      x1 = Math.min(x1, b.cell.r);
      y1 = Math.min(y1, b.cell.b);
    }
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  };
  /** cover for a moved/stretched rule: none when the new drawing already spans the old one */
  V.graphicCover = function (g, r) {
    const r0 = V.graphicRect(g, (y) => y);
    if (Math.abs(r.x - r0.x) < 0.01 && Math.abs(r.w - r0.w) < 0.01 && r.y <= r0.y + 0.01 && r.y + r.h >= r0.y + r0.h - 0.01) return null;
    return { x: g.x - 0.4, y: g.y - 0.4, w: g.w + 0.8, h: g.h + 0.8 };
  };
  function addCoverRect(pv, r, bg, padding) {
    const pad = padding != null ? padding : 1;
    pv.covers.appendChild(
      PE.h('div', {
        class: 'cv',
        style: {
          left: r.x - pad + 'px',
          top: r.y - pad + 'px',
          width: r.w + pad * 2 + 'px',
          height: r.h + pad * 2 + 'px',
          background: bg || '#fff',
        },
      })
    );
  }
  V.coverRects = function (pg) {
    // used by export: same rectangles the screen shows
    const key = PE.pageKey(pg);
    const ex = key && PE.ex[key];
    const pv = V.els.get(pg.id);
    const out = [];
    if (!ex || !pv) return out;
    const shift = pv.shift || {};
    for (const b of ex.blocks)
      if (pg.ov[b.id] || shift[b.id]) {
        if (b.patch && PE.assets[b.patch.a]) out.push({ x: b.patch.x, y: b.patch.y, w: b.patch.w, h: b.patch.h, a: b.patch.a });
        else out.push(Object.assign(V.blockCover(b), { c: b.bg }));
      }
    for (const im of ex.images)
      if (pg.ov[im.id] || shift[im.id]) out.push({ x: im.bbox.x - 1, y: im.bbox.y - 1, w: im.bbox.w + 2, h: im.bbox.h + 2, c: im.bg });
    const gpos = pv.gpos || {};
    for (const g of ex.graphics || []) {
      if (pg.ov[g.id] && pg.ov[g.id].del) out.push({ x: g.x - 1, y: g.y - 1, w: g.w + 2, h: g.h + 2, c: g.bg });
      else if (gpos[g.id]) {
        const c = V.graphicCover(g, gpos[g.id]);
        if (c) out.push(Object.assign(c, { c: g.bg }));
      }
    }
    return out;
  };

  V.ensureBaseImageAsset = async function (pg, im) {
    const k = PE.pageKey(pg) + ':' + im.id;
    if (V.imgCache[k] && PE.assets[V.imgCache[k]]) return V.imgCache[k];
    if (V.imgCache['p:' + k]) return V.imgCache['p:' + k];
    V.imgCache['p:' + k] = PE.materializeBaseImage(pg.src.doc, pg.src.i, im).then((r) => {
      V.imgCache[k] = r.assetId;
      return r.assetId;
    });
    return V.imgCache['p:' + k];
  };

  /* ---------- objects ---------- */
  V.renderObj = function (o) {
    const el = PE.h('div', { class: 'ob ob-' + o.type, 'data-oid': o.id });
    V.fillObj(el, o);
    V.styleObj(el, o);
    return el;
  };
  V.fillObj = function (el, o) {
    if (o.type === 'text') {
      const t = PE.h('div', { class: 'txt' });
      V.fillRuns(t, o.runs);
      el.innerHTML = '';
      el.appendChild(t);
    } else if (o.type === 'image') {
      const a = PE.assets[o.a];
      el.innerHTML = a ? `<img draggable="false" alt="" src="${a.url}">` : '';
    } else if (o.type === 'table') {
      el.innerHTML = '';
      el.appendChild(V.buildTable(o));
    } else {
      el.innerHTML = V.svgFor(o);
    }
  };
  V.styleObj = function (el, o) {
    const s = el.style;
    s.left = o.x + 'px';
    s.top = o.y + 'px';
    s.transform = o.rot ? `rotate(${o.rot}deg)` : '';
    s.opacity = o.op != null && o.op < 1 ? o.op : '';
    s.mixBlendMode = o.blend === 'multiply' ? 'multiply' : '';
    if (o.type === 'text') {
      const t = el.firstChild;
      t.style.lineHeight = o.lh || 1.2;
      t.style.textAlign = o.align || 'left';
      if (o.autoW) {
        s.width = 'max-content';
        s.maxWidth = Math.max(40, o.maxW || 400) + 'px';
      } else {
        s.width = o.w + 'px';
        s.maxWidth = '';
      }
      s.height = '';
      t.style.whiteSpace = o.nowrap ? 'pre' : '';
    } else if (o.type === 'table') {
      s.width = o.w + 'px';
      s.height = '';
    } else {
      s.width = o.w + 'px';
      s.height = o.h + 'px';
    }
    if (o.type === 'image') {
      const im = el.firstChild;
      if (im) im.style.transform = `scale(${o.flipX ? -1 : 1},${o.flipY ? -1 : 1})`;
    }
  };
  V.updateObj = function (pg, o, full) {
    const pv = V.els.get(pg.id);
    const el = pv && pv.objs.querySelector(`[data-oid="${o.id}"]`);
    if (!el) return;
    if (full) V.fillObj(el, o);
    V.styleObj(el, o);
    if (o.type === 'table' && o.src) V.layoutBase(pg);
  };
  V.objEl = (pg, id) => {
    const pv = V.els.get(pg.id);
    return pv && pv.objs.querySelector(`[data-oid="${id}"]`);
  };

  V.svgFor = function (o) {
    const w = Math.max(1, o.w),
      h = Math.max(1, o.h);
    const sw = o.sw || 0;
    const stroke = o.stroke ? `stroke="${o.stroke}" stroke-width="${sw}"` : 'stroke="none"';
    const fill = o.fill ? `fill="${o.fill}"` : 'fill="none"';
    let inner = '';
    if (o.type === 'shape') {
      const i = o.stroke ? sw / 2 : 0;
      if (o.shape === 'rect')
        inner = `<rect x="${i}" y="${i}" width="${Math.max(0, w - sw * (o.stroke ? 1 : 0))}" height="${Math.max(0, h - sw * (o.stroke ? 1 : 0))}" ${fill} ${stroke}/>`;
      else if (o.shape === 'ellipse')
        inner = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - i)}" ry="${Math.max(0, h / 2 - i)}" ${fill} ${stroke}/>`;
      else if (o.shape === 'check' || o.shape === 'cross')
        inner = `<path d="${V.symbolPath(o.shape, w, h)}" fill="none" stroke="${o.stroke || '#000'}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (o.type === 'line') {
      const p = V.linePoints(o);
      inner = `<path d="${V.linePath(o, p)}" fill="none" stroke="${o.stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    } else if (o.type === 'ink') {
      inner = `<g transform="scale(${w / o.w0},${h / o.h0})">` +
        o.strokes
          .map((st) => `<path d="${V.inkPath(st)}" fill="none" stroke="${o.stroke}" stroke-width="${sw}" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`)
          .join('') + '</g>';
    }
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="visible">${inner}</svg>`;
  };
  V.symbolPath = (kind, w, h) =>
    kind === 'check'
      ? `M ${w * 0.12} ${h * 0.55} L ${w * 0.4} ${h * 0.82} L ${w * 0.88} ${h * 0.18}`
      : `M ${w * 0.15} ${h * 0.15} L ${w * 0.85} ${h * 0.85} M ${w * 0.85} ${h * 0.15} L ${w * 0.15} ${h * 0.85}`;
  /** line endpoints relative to the object box */
  V.linePoints = (o) => ({ x1: o.x1 - o.x, y1: o.y1 - o.y, x2: o.x2 - o.x, y2: o.y2 - o.y });
  V.linePath = function (o, p) {
    let d = `M ${p.x1} ${p.y1} L ${p.x2} ${p.y2}`;
    if (o.arrow) {
      const a = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
      const len = Math.max(8, (o.sw || 2) * 4);
      const l = [p.x2 - len * Math.cos(a - 0.45), p.y2 - len * Math.sin(a - 0.45)];
      const r = [p.x2 - len * Math.cos(a + 0.45), p.y2 - len * Math.sin(a + 0.45)];
      d += ` M ${l[0]} ${l[1]} L ${p.x2} ${p.y2} L ${r[0]} ${r[1]}`;
    }
    return d;
  };
  V.inkPath = function (pts) {
    if (!pts.length) return '';
    if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]} l 0.01 0`;
    let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2,
        my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ` Q ${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
    }
    const l = pts[pts.length - 1];
    d += ` L ${l[0].toFixed(2)} ${l[1].toFixed(2)}`;
    return d;
  };

  /* ---------- tables ---------- */
  V.buildTable = function (o) {
    const tbl = PE.h('table', { class: 'ptable' });
    const cg = PE.h('colgroup');
    const total = o.cw.reduce((a, b) => a + b, 0);
    o.cw.forEach((w) => cg.appendChild(PE.h('col', { style: { width: (w / total) * 100 + '%' } })));
    tbl.appendChild(cg);
    tbl.style.setProperty('--tb', o.border || '#000');
    tbl.style.setProperty('--tbw', (o.bw != null ? o.bw : 1) + 'px');
    tbl.style.setProperty('--tpad', (o.pad != null ? o.pad : 4) + 'px');
    tbl.style.setProperty('--tpady', (o.padY != null ? o.padY : o.pad != null ? o.pad : 4) + 'px');
    const tb = PE.h('tbody');
    o.rows.forEach((row, ri) => {
      const tr = PE.h('tr');
      if (o.rh && o.rh[ri]) tr.style.height = o.rh[ri] + 'px';
      row.forEach((cell, ci) => {
        const td = PE.h('td', { 'data-r': ri, 'data-c': ci });
        const isHead = o.head && ri === 0;
        if (isHead && o.headBg) td.style.background = o.headBg;
        else if (cell.bg) td.style.background = cell.bg;
        const div = PE.h('div', { class: 'txt cell' });
        const run = {
          t: cell.t || '',
          f: o.f || 'arimo',
          b: !!(cell.b || isHead),
          i: !!cell.i,
          u: false,
          s: o.size || 11,
          c: o.color || '#000000',
        };
        V.fillRuns(div, [run]);
        if (!cell.t) div.innerHTML = '<br>';
        div.style.fontFamily = PE.fonts.cssFamily(o.f || 'arimo');
        div.style.fontSize = (o.size || 11) + 'px';
        div.style.lineHeight = o.lh || 1.25;
        div.style.textAlign = cell.align || 'left';
        td.appendChild(div);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    PE.fonts.ensure(o.f || 'arimo', false, false);
    PE.fonts.ensure(o.f || 'arimo', true, false);
    return tbl;
  };

  /* ---------- header / footer / watermark (generated per page) ---------- */
  V.virtualObjs = function (pg, idx) {
    const out = [];
    const S = PE.S;
    const total = S.pages.length;
    const d = PE.dispSize(pg);
    const toBase = V.dispToBase(pg);
    const place = (o, cx, cy) => {
      // o is laid out in the display frame centred at (cx,cy); convert to base frame
      const [bx, by] = PE.M.apply(toBase, cx, cy);
      o.x = bx - o.w / 2;
      o.y = by - o.h / 2;
      o.rot = (o.rot || 0) - pg.rot;
      out.push(o);
    };
    const hf = S.hf;
    if (hf.on && !(hf.skipFirst && idx === 0)) {
      const n = idx + (hf.start || 1) - (hf.skipFirst ? 1 : 0);
      const tok = (s) =>
        String(s || '')
          .replace(/\{n\}/g, n)
          .replace(/\{total\}/g, total - (hf.skipFirst ? 1 : 0) + (hf.start || 1) - 1)
          .replace(/\{date\}/g, new Date().toLocaleDateString())
          .replace(/\{file\}/g, PE.app.fileName.replace(/\.pdf$/i, ''));
      const m = hf.margin || 28;
      const lh = 1.2,
        h = hf.size * lh;
      const w = d.w - 2 * m;
      for (const [k, align, top] of [
        ['tl', 'left', true],
        ['tc', 'center', true],
        ['tr', 'right', true],
        ['bl', 'left', false],
        ['bc', 'center', false],
        ['br', 'right', false],
      ]) {
        const txt = tok(hf[k]);
        if (!txt) continue;
        const cy = top ? m + h / 2 : d.h - m - h / 2;
        place(
          {
            id: 'v-' + k,
            type: 'text',
            virtual: true,
            w,
            h,
            lh,
            align,
            nowrap: true,
            runs: [{ t: txt, f: hf.f || 'arimo', b: false, i: false, u: false, s: hf.size, c: hf.color }],
          },
          d.w / 2,
          cy
        );
      }
    }
    const wm = S.wm;
    if (wm.on && wm.text) {
      const w = Math.max(d.w, d.h) * 1.4,
        h = wm.size * 1.2;
      place(
        {
          id: 'v-wm',
          type: 'text',
          virtual: true,
          w,
          h,
          lh: 1.2,
          align: 'center',
          nowrap: true,
          rot: wm.angle,
          op: wm.opacity,
          runs: [{ t: wm.text, f: wm.f || 'arimo', b: !!wm.b, i: false, u: false, s: wm.size, c: wm.color }],
        },
        d.w / 2,
        d.h / 2
      );
    }
    return out;
  };
  function renderVirtual(pg, pv) {
    pv.virt.innerHTML = '';
    const idx = PE.pageIndex(pg.id);
    for (const o of V.virtualObjs(pg, idx)) {
      const el = V.renderObj(o);
      el.style.width = o.w + 'px';
      el.style.height = o.h + 'px';
      pv.virt.appendChild(el);
    }
  }
  V.renderVirtualAll = function () {
    for (const pg of PE.S.pages) {
      const pv = V.els.get(pg.id);
      if (pv) renderVirtual(pg, pv);
    }
  };
})();
