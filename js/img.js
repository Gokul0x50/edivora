/* Edivora — image editor: layers, adjustments & filters, crop / rotate / resize, brush, eraser, heal,
 * text, shapes, blur & pixelate areas, magic eraser, background removal, fill, and export.
 * Everything is drawn on canvases; colour adjustments run on the GPU (WebGL) when available.
 */
'use strict';
(function () {
  const $ = PE.$,
    h = PE.h,
    icon = PE.icon;
  const I = (PE.img = { name: 'image', label: 'Image', ext: '.png', active: false });
  PE.mm.register(I);

  let D = null; // document: { w, h, bg, layers: [], sel }
  const R = new Map(); // raster id -> canvas (never changed once in history; edits make a new one)
  const proc = new Map(); // layer id -> { key, canvas } adjusted pixels
  let els = null,
    gl = null,
    zoom = 1,
    tool = 'move',
    panelTab = 'props';
  const opts = {
    brush: { size: 24, color: '#e8313b', hard: 0.85, op: 1 },
    eraser: { size: 40, hard: 0.8, op: 1 },
    heal: { size: 28 },
    text: { color: '#ffffff', f: 'montserrat' },
    shape: { shape: 'rect', fill: '#1f3fcf', stroke: '', sw: 6, radius: 0 },
    area: { mode: 'blur', amount: 14 },
    magic: { tol: 40 },
    fill: { color: '#1f3fcf', tol: 32 },
  };
  const TOOLS = [
    ['move', 'Move & select', 'move', 'V'],
    ['crop', 'Crop, rotate & straighten', 'crop', 'C'],
    ['brush', 'Brush', 'brush', 'B'],
    ['eraser', 'Eraser', 'eraser', 'E'],
    ['heal', 'Heal (remove spots and objects)', 'heal', 'J'],
    ['text', 'Text', 'text', 'T'],
    ['shape', 'Shapes', 'shapes', 'U'],
    ['area', 'Blur / pixelate an area', 'blurarea', 'R'],
    ['magic', 'Magic eraser (click a colour to remove it)', 'magic', 'W'],
    ['fill', 'Fill (paint bucket)', 'bucket', 'G'],
    ['picker', 'Colour picker', 'picker', 'I'],
    ['hand', 'Pan', 'hand', 'H'],
  ];
  const BLENDS = [
    ['source-over', 'Normal'],
    ['multiply', 'Multiply'],
    ['screen', 'Screen'],
    ['overlay', 'Overlay'],
    ['darken', 'Darken'],
    ['lighten', 'Lighten'],
    ['color-dodge', 'Colour dodge'],
    ['color-burn', 'Colour burn'],
    ['hard-light', 'Hard light'],
    ['soft-light', 'Soft light'],
    ['difference', 'Difference'],
    ['exclusion', 'Exclusion'],
    ['hue', 'Hue'],
    ['saturation', 'Saturation'],
    ['color', 'Colour'],
    ['luminosity', 'Luminosity'],
  ];
  const MAX_SIDE = 8192;

  /* =========================================================
   *  rasters
   * ========================================================= */
  let rasterSeq = 1;
  function newRaster(w, hh) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(hh));
    const id = 'r' + rasterSeq++;
    R.set(id, c);
    return { id, c };
  }
  function cloneRaster(id) {
    const src = R.get(id);
    const r = newRaster(src.width, src.height);
    r.c.getContext('2d').drawImage(src, 0, 0);
    return r;
  }
  function rasterFromSource(src, w, hh) {
    const r = newRaster(w, hh);
    r.c.getContext('2d').drawImage(src, 0, 0, r.c.width, r.c.height);
    return r;
  }
  const isRaster = (L) => L && (L.type === 'image' || L.type === 'draw');
  const selLayer = () => D && D.layers.find((l) => l.id === D.sel);
  let layerSeq = 1;
  const nid = () => 'L' + Date.now().toString(36) + (layerSeq++).toString(36);

  /* =========================================================
   *  history (document JSON + raster ids; rasters are copy-on-write)
   * ========================================================= */
  const H = { stack: [], idx: -1 };
  function commit() {
    const snap = JSON.stringify(D);
    if (H.stack[H.idx] === snap) return;
    H.stack.length = H.idx + 1;
    H.stack.push(snap);
    if (H.stack.length > 60) H.stack.shift();
    H.idx = H.stack.length - 1;
    PE.app.dirty = true;
    gcRasters();
    PE.ui.updateHistoryButtons();
  }
  function gcRasters() {
    const keep = new Set();
    for (const s of H.stack.concat([JSON.stringify(D)])) for (const m of s.matchAll(/"raster":"(r\d+)"/g)) keep.add(m[1]);
    for (const id of [...R.keys()]) if (!keep.has(id) && !(stroke && stroke.ids && stroke.ids.has(id))) R.delete(id);
  }
  function restore(i) {
    H.idx = i;
    D = JSON.parse(H.stack[i]);
    proc.clear();
    endTextEdit(false);
    render();
    refreshPanel();
    PE.ui.updateHistoryButtons();
  }
  I.undo = () => H.idx > 0 && restore(H.idx - 1);
  I.redo = () => H.idx < H.stack.length - 1 && restore(H.idx + 1);
  I.canUndo = () => H.idx > 0;
  I.canRedo = () => H.idx < H.stack.length - 1;

  /* =========================================================
   *  open / new / close
   * ========================================================= */
  I.open = async function (files, opts2 = {}) {
    build();
    I.active = true;
    document.body.classList.add('mode-image');
    $('#app').classList.remove('no-doc');
    if (!gl) gl = PE.createAdjuster();
    D = null;
    R.clear();
    proc.clear();
    H.stack = [];
    H.idx = -1;
    if (files && files.length) {
      const first = await loadImage(files[0]);
      let w = first.w,
        hh = first.h;
      const k = Math.min(1, MAX_SIDE / Math.max(w, hh));
      if (k < 1) PE.toast('This image is very large; it was scaled to ' + Math.round(w * k) + ' × ' + Math.round(hh * k) + ' pixels for editing.', 'info', 6000);
      w = Math.round(w * k);
      hh = Math.round(hh * k);
      D = { w, h: hh, bg: null, layers: [], sel: null };
      addImageLayer(first.src, first.name, { fit: 'exact' });
      for (const f of files.slice(1)) {
        const im = await loadImage(f);
        addImageLayer(im.src, im.name);
      }
      PE.app.setFileName(files[0].name.replace(/\.[^.]+$/, '') + '.png');
    } else {
      const o = opts2.size || { w: 1080, h: 1080, bg: '#ffffff' };
      D = { w: o.w, h: o.h, bg: o.bg, layers: [], sel: null };
      PE.app.setFileName('Untitled.png');
    }
    D.sel = D.layers.length > 1 ? D.layers[D.layers.length - 1].id : null;
    commit();
    PE.app.dirty = false;
    setTool('move');
    await PE.raf();
    I.fit();
    refreshPanel();
    PE.ui.updateHistoryButtons();
  };
  I.close = function () {
    I.active = false;
    document.body.classList.remove('mode-image');
    endTextEdit(false);
    D = null;
    R.clear();
    proc.clear();
    H.stack = [];
    H.idx = -1;
    if (els) {
      els.ui.innerHTML = '';
      const c = els.canvas;
      c.width = c.height = 1;
    }
  };
  I.accepts = ['image'];
  I.dropText = 'Drop pictures to add them as layers';
  I.onPaste = async function (e) {
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
    const it = Array.from((e.clipboardData && e.clipboardData.items) || []).find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (!it) return;
    e.preventDefault();
    const f = it.getAsFile();
    await I.add([new File([f], 'Pasted picture.png', { type: f.type })]);
    PE.toast('Pasted as a new layer.', 'ok');
  };
  I.addFiles = (files) => I.add(files);
  I.add = async function (files) {
    for (const f of files) {
      if (PE.kindOf(f) !== 'image') continue;
      const im = await loadImage(f);
      addImageLayer(im.src, im.name);
    }
    commit();
    render();
    refreshPanel();
  };
  async function loadImage(file) {
    const bytes = await PE.readFile(file);
    const blob = new Blob([bytes], { type: file.type || 'image/png' });
    let src = null;
    try {
      src = await createImageBitmap(blob);
    } catch (e) {
      const url = URL.createObjectURL(blob);
      try {
        src = await PE.view.loadImg(url);
      } catch (e2) {
        throw new Error('This image format can’t be opened here (' + (file.name || '') + ').');
      }
    }
    return { src, w: src.width || src.naturalWidth, h: src.height || src.naturalHeight, name: (file.name || 'Image').replace(/\.[^.]+$/, '') };
  }
  function addImageLayer(src, name, o = {}) {
    const sw = src.width || src.naturalWidth,
      sh = src.height || src.naturalHeight;
    const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const r = rasterFromSource(src, sw * k, sh * k);
    let w = r.c.width,
      hh = r.c.height;
    if (o.fit !== 'exact') {
      const f = Math.min(1, (D.w * 0.9) / w, (D.h * 0.9) / hh);
      w *= f;
      hh *= f;
    } else {
      w = D.w;
      hh = D.h;
    }
    const L = { id: nid(), type: 'image', name: name || 'Image', x: D.w / 2, y: D.h / 2, w, h: hh, rot: 0, op: 1, blend: 'source-over', raster: r.id, adj: {} };
    D.layers.push(L);
    D.sel = L.id;
    return L;
  }
  function addDrawLayer() {
    const r = newRaster(D.w, D.h);
    const L = { id: nid(), type: 'draw', name: 'Drawing', x: D.w / 2, y: D.h / 2, w: D.w, h: D.h, rot: 0, op: 1, blend: 'source-over', raster: r.id, adj: {} };
    const s = selLayer();
    const at = s ? D.layers.indexOf(s) + 1 : D.layers.length;
    D.layers.splice(at, 0, L);
    D.sel = L.id;
    return L;
  }

  /* =========================================================
   *  DOM
   * ========================================================= */
  function build() {
    if (els) return;
    const view = $('#img-view');
    const tools = h('nav', { class: 'mtools', 'aria-label': 'Image tools' });
    for (const [k, title, ic, key] of TOOLS)
      tools.appendChild(h('button', { class: 'mtool', 'data-t': k, title: `${title} (${key})`, 'aria-label': title, html: icon(ic) + `<span>${title.split(' ')[0].replace(/[,&]/g, '')}</span>`, onclick: () => setTool(k) }));
    const stage = h('div', { class: 'mstage istage', tabindex: '-1' });
    const pad = h('div', { class: 'ipad' });
    const wrap = h('div', { class: 'iwrap' });
    const canvas = h('canvas', { class: 'icanvas' });
    const ui = h('div', { class: 'iui' });
    wrap.append(canvas, ui);
    pad.appendChild(wrap);
    stage.appendChild(pad);
    const panel = h('aside', { class: 'mpanel', 'aria-label': 'Image settings' });
    const tabs = h('div', { class: 'mtabs', role: 'tablist' });
    for (const [k, label] of [
      ['props', 'Edit'],
      ['adjust', 'Adjust'],
      ['filters', 'Filters'],
      ['layers', 'Layers'],
    ])
      tabs.appendChild(h('button', { role: 'tab', 'data-tab': k, onclick: () => ((panelTab = k), refreshPanel()) }, label));
    const body = h('div', { class: 'mpanel-body' });
    const handle = h('button', { class: 'sheet-handle only-narrow', 'aria-label': 'Collapse panel', html: '<i></i>', onclick: () => document.body.classList.toggle('mpanel-min') });
    panel.append(handle, tabs, body);
    view.append(tools, stage, panel);
    els = { view, tools, stage, pad, wrap, canvas, ui, panel, tabs, body };
    stage.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    stage.addEventListener('dblclick', onDbl);
    stage.addEventListener(
      'wheel',
      (e) => {
        if (!I.active) return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          setZoom(zoom * Math.exp(-e.deltaY * 0.0022), e);
        }
      },
      { passive: false }
    );
    PE.fonts.onLoad(() => I.active && (render(), drawUI()));
    window.addEventListener('resize', PE.debounce(() => I.active && drawUI(), 120));
  }

  /* =========================================================
   *  rendering
   * ========================================================= */
  function layerBitmap(L) {
    const base = R.get(L.raster);
    if (!base) return null;
    if (PE.isNeutral(L.adj)) return base;
    const key = L.raster + JSON.stringify(L.adj);
    const c = proc.get(L.id);
    if (c && c.key === key) return c.canvas;
    const out = c ? c.canvas : document.createElement('canvas');
    let w = base.width,
      hh = base.height;
    if (gl.maxTex && Math.max(w, hh) > gl.maxTex) {
      const k = gl.maxTex / Math.max(w, hh);
      w *= k;
      hh *= k;
    }
    const g = gl.draw(base, L.adj, w, hh);
    out.width = g.width;
    out.height = g.height;
    const ctx = out.getContext('2d');
    ctx.clearRect(0, 0, out.width, out.height);
    ctx.drawImage(g, 0, 0);
    proc.set(L.id, { key, canvas: out });
    return out;
  }
  function textFont(L) {
    return `${L.i ? 'italic ' : ''}${L.b ? 700 : 400} ${L.size}px ${PE.fonts.cssFamily(L.f)}`;
  }
  /** measure a text layer and set its size */
  function measureText(L) {
    const c = measureText.ctx || (measureText.ctx = document.createElement('canvas').getContext('2d'));
    c.font = textFont(L);
    const lines = String(L.text || ' ').split('\n');
    let w = 0;
    for (const ln of lines) w = Math.max(w, c.measureText(ln || ' ').width + (L.ls || 0) * Math.max(0, ln.length - 1));
    const pad = L.bg ? L.size * 0.35 : 0;
    L.w = Math.max(4, w + pad * 2 + (L.sw || 0) * 2);
    L.h = Math.max(4, lines.length * L.size * (L.lh || 1.2) + pad * 2);
    PE.fonts.ensure(L.f, !!L.b, !!L.i);
  }
  function drawLayer(ctx, L) {
    ctx.save();
    ctx.globalAlpha = L.op == null ? 1 : L.op;
    ctx.globalCompositeOperation = L.blend || 'source-over';
    ctx.translate(L.x, L.y);
    if (L.rot) ctx.rotate((L.rot * Math.PI) / 180);
    ctx.scale(L.flipX ? -1 : 1, L.flipY ? -1 : 1);
    if (L.shadow) {
      ctx.shadowColor = L.shadowColor || 'rgba(0,0,0,.55)';
      ctx.shadowBlur = L.shadowBlur != null ? L.shadowBlur : 12;
      ctx.shadowOffsetX = L.shadowX != null ? L.shadowX : 4;
      ctx.shadowOffsetY = L.shadowY != null ? L.shadowY : 4;
    }
    if (isRaster(L)) {
      const bm = editingRaster && editingRaster.layer === L.id ? editingRaster.canvas : layerBitmap(L);
      if (bm) {
        if (L.radius) {
          roundRect(ctx, -L.w / 2, -L.h / 2, L.w, L.h, L.radius);
          ctx.clip();
        }
        ctx.drawImage(bm, -L.w / 2, -L.h / 2, L.w, L.h);
      }
    } else if (L.type === 'text') drawText(ctx, L);
    else if (L.type === 'shape') drawShape(ctx, L);
    ctx.restore();
  }
  function roundRect(ctx, x, y, w, hh, r) {
    r = Math.max(0, Math.min(r, w / 2, hh / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hh, r);
    ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawText(ctx, L) {
    if (textEdit && textEdit.id === L.id) return; // the editor box shows it
    const lines = String(L.text || '').split('\n');
    const pad = L.bg ? L.size * 0.35 : 0;
    if (L.bg) {
      const sh = ctx.shadowColor;
      roundRect(ctx, -L.w / 2, -L.h / 2, L.w, L.h, L.bgRadius != null ? L.bgRadius : L.size * 0.25);
      ctx.fillStyle = L.bg;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      void sh;
    }
    ctx.font = textFont(L);
    ctx.textBaseline = 'middle';
    ctx.textAlign = L.align || 'center';
    const lh = L.size * (L.lh || 1.2);
    const x = L.align === 'left' ? -L.w / 2 + pad + (L.sw || 0) : L.align === 'right' ? L.w / 2 - pad - (L.sw || 0) : 0;
    lines.forEach((ln, i) => {
      const y = -L.h / 2 + pad + lh * (i + 0.5);
      const drawRun = (fn) => {
        if (!L.ls) return fn(ln, x, y);
        // letter spacing: place each character
        const c = ctx.measureText(ln).width + L.ls * Math.max(0, ln.length - 1);
        let cx = L.align === 'left' ? x : L.align === 'right' ? x - c : x - c / 2;
        const al = ctx.textAlign;
        ctx.textAlign = 'left';
        for (const ch of ln) {
          fn(ch, cx, y);
          cx += ctx.measureText(ch).width + L.ls;
        }
        ctx.textAlign = al;
      };
      if (L.sw && L.stroke) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = L.sw * 2;
        ctx.strokeStyle = L.stroke;
        drawRun((t, a, b) => ctx.strokeText(t, a, b));
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = L.color || '#000';
      drawRun((t, a, b) => ctx.fillText(t, a, b));
    });
  }
  function shapePath(ctx, L) {
    const w = L.w,
      hh = L.h;
    ctx.beginPath();
    if (L.shape === 'ellipse') ctx.ellipse(0, 0, w / 2, hh / 2, 0, 0, Math.PI * 2);
    else if (L.shape === 'triangle') {
      ctx.moveTo(0, -hh / 2);
      ctx.lineTo(w / 2, hh / 2);
      ctx.lineTo(-w / 2, hh / 2);
      ctx.closePath();
    } else if (L.shape === 'star') {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.45 : 1;
        ctx.lineTo((Math.cos(a) * w * r) / 2, (Math.sin(a) * hh * r) / 2 + hh * 0.05);
      }
      ctx.closePath();
    } else if (L.shape === 'heart') {
      ctx.moveTo(0, hh * 0.35);
      ctx.bezierCurveTo(-w * 0.55, -hh * 0.05, -w * 0.3, -hh * 0.55, 0, -hh * 0.2);
      ctx.bezierCurveTo(w * 0.3, -hh * 0.55, w * 0.55, -hh * 0.05, 0, hh * 0.35);
      ctx.closePath();
    } else if (L.shape === 'line' || L.shape === 'arrow') {
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2 - (L.shape === 'arrow' ? Math.min(w * 0.3, (L.sw || 4) * 3) : 0), 0);
    } else roundRect(ctx, -w / 2, -hh / 2, w, hh, L.radius || 0);
  }
  function drawShape(ctx, L) {
    shapePath(ctx, L);
    const line = L.shape === 'line' || L.shape === 'arrow';
    if (!line && L.fill) {
      ctx.fillStyle = L.fill;
      ctx.fill();
      ctx.shadowColor = 'transparent';
    }
    if (line || (L.stroke && L.sw)) {
      ctx.strokeStyle = (line ? L.fill || L.stroke : L.stroke) || '#000';
      ctx.lineWidth = L.sw || 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    if (L.shape === 'arrow') {
      const s = Math.min(L.w * 0.3, (L.sw || 4) * 3.2);
      ctx.beginPath();
      ctx.moveTo(L.w / 2, 0);
      ctx.lineTo(L.w / 2 - s, -s * 0.75);
      ctx.lineTo(L.w / 2 - s, s * 0.75);
      ctx.closePath();
      ctx.fillStyle = L.fill || L.stroke || '#000';
      ctx.fill();
    }
  }
  /** draw the whole picture into ctx (scale k for exports) */
  function compose(ctx, k = 1, o = {}) {
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, D.w, D.h);
    if (D.bg || o.bg) {
      ctx.fillStyle = D.bg || o.bg;
      ctx.fillRect(0, 0, D.w, D.h);
    }
    for (const L of D.layers) if (!L.hidden) drawLayer(ctx, L);
    ctx.restore();
  }
  let rq = 0;
  function render() {
    if (!D || !els) return;
    cancelAnimationFrame(rq);
    rq = requestAnimationFrame(() => {
      const c = els.canvas;
      if (c.width !== D.w || c.height !== D.h) {
        c.width = D.w;
        c.height = D.h;
      }
      for (const L of D.layers) if (L.type === 'text') measureText(L);
      compose(c.getContext('2d'));
      sizeView();
      drawUI();
    });
  }
  function renderNow() {
    cancelAnimationFrame(rq);
    const c = els.canvas;
    if (c.width !== D.w || c.height !== D.h) {
      c.width = D.w;
      c.height = D.h;
    }
    for (const L of D.layers) if (L.type === 'text') measureText(L);
    compose(c.getContext('2d'));
    sizeView();
    drawUI();
  }
  function sizeView() {
    const w = D.w * zoom,
      hh = D.h * zoom;
    els.wrap.style.width = w + 'px';
    els.wrap.style.height = hh + 'px';
    els.canvas.style.width = w + 'px';
    els.canvas.style.height = hh + 'px';
    if (PE.mm.cur === I) $('#btn-zoom').textContent = Math.round(zoom * 100) + '%';
  }

  /* =========================================================
   *  zoom
   * ========================================================= */
  function setZoom(z, at) {
    if (!D) return;
    z = PE.clamp(z, 0.02, 16);
    const st = els.stage;
    const r = st.getBoundingClientRect();
    const ax = at ? at.clientX - r.left : st.clientWidth / 2,
      ay = at ? at.clientY - r.top : st.clientHeight / 2;
    const wr = els.wrap.getBoundingClientRect();
    const dx = (r.left + ax - wr.left) / zoom,
      dy = (r.top + ay - wr.top) / zoom;
    zoom = z;
    sizeView();
    drawUI();
    const wr2 = els.wrap.getBoundingClientRect();
    st.scrollLeft += wr2.left + dx * zoom - (r.left + ax);
    st.scrollTop += wr2.top + dy * zoom - (r.top + ay);
  }
  I.fit = function () {
    if (!D || !els) return;
    const st = els.stage;
    const pad = parseFloat(getComputedStyle(els.pad).paddingLeft) || 0;
    const z = Math.min((st.clientWidth - pad * 2 - 8) / D.w, (st.clientHeight - pad * 2 - 8) / D.h);
    zoom = PE.clamp(z, 0.02, 4);
    render();
    requestAnimationFrame(() => {
      st.scrollLeft = (st.scrollWidth - st.clientWidth) / 2;
      st.scrollTop = (st.scrollHeight - st.clientHeight) / 2;
    });
  };
  I.zoomIn = () => setZoom(zoom * 1.25);
  I.zoomOut = () => setZoom(zoom / 1.25);
  I.zoomMenu = (anchor) =>
    PE.ui.menu(anchor, [{ label: 'Fit to screen', icon: 'fit', onClick: () => I.fit() }, '-', ...[25, 50, 100, 200, 400].map((z) => ({ label: z + '%', on: Math.round(zoom * 100) === z, onClick: () => setZoom(z / 100) }))]);

  /* =========================================================
   *  geometry
   * ========================================================= */
  function toDoc(e) {
    const r = els.wrap.getBoundingClientRect();
    return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom];
  }
  function toLocal(L, p) {
    const a = (-(L.rot || 0) * Math.PI) / 180;
    const dx = p[0] - L.x,
      dy = p[1] - L.y;
    let lx = dx * Math.cos(a) - dy * Math.sin(a),
      ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (L.flipX) lx = -lx;
    if (L.flipY) ly = -ly;
    return [lx, ly];
  }
  function fromLocal(L, lx, ly) {
    if (L.flipX) lx = -lx;
    if (L.flipY) ly = -ly;
    const a = ((L.rot || 0) * Math.PI) / 180;
    return [L.x + lx * Math.cos(a) - ly * Math.sin(a), L.y + lx * Math.sin(a) + ly * Math.cos(a)];
  }
  /** point inside a raster layer -> pixel of its raster */
  function toRasterPx(L, p) {
    const [lx, ly] = toLocal(L, p);
    const c = R.get(L.raster);
    return [((lx + L.w / 2) / L.w) * c.width, ((ly + L.h / 2) / L.h) * c.height];
  }
  function hitLayer(p) {
    for (let i = D.layers.length - 1; i >= 0; i--) {
      const L = D.layers[i];
      if (L.hidden || L.locked) continue;
      const [lx, ly] = toLocal(L, p);
      const tol = L.type === 'shape' && (L.shape === 'line' || L.shape === 'arrow') ? Math.max(8 / zoom, L.sw) : 0;
      if (Math.abs(lx) > L.w / 2 + tol || Math.abs(ly) > L.h / 2 + tol) continue;
      if (isRaster(L)) {
        // transparent parts of a picture don't count
        const c = R.get(L.raster);
        const [px, py] = toRasterPx(L, p);
        try {
          const a = c.getContext('2d', { willReadFrequently: true }).getImageData(PE.clamp(px | 0, 0, c.width - 1), PE.clamp(py | 0, 0, c.height - 1), 1, 1).data[3];
          if (a < 8 && L.type === 'draw') continue;
          if (a < 8 && D.layers.length > 1 && i > 0) continue;
        } catch (e) {}
      }
      return L;
    }
    return null;
  }

  /* =========================================================
   *  selection UI
   * ========================================================= */
  function drawUI() {
    if (!els || !D) return;
    els.ui.innerHTML = '';
    els.ui.style.width = D.w * zoom + 'px';
    els.ui.style.height = D.h * zoom + 'px';
    if (tool === 'crop') return drawCropUI();
    const L = selLayer();
    if (!L || L.hidden || tool !== 'move' || (textEdit && textEdit.id === L.id)) return;
    const box = h('div', { class: 'isel' + (L.locked ? ' locked' : '') });
    box.style.left = (L.x - L.w / 2) * zoom + 'px';
    box.style.top = (L.y - L.h / 2) * zoom + 'px';
    box.style.width = L.w * zoom + 'px';
    box.style.height = L.h * zoom + 'px';
    box.style.transform = `rotate(${L.rot || 0}deg)`;
    if (!L.locked) {
      const hs = L.type === 'shape' && (L.shape === 'line' || L.shape === 'arrow') ? ['w', 'e'] : L.type === 'text' ? ['nw', 'ne', 'sw', 'se'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      for (const k of hs) box.appendChild(h('div', { class: 'ihd ihd-' + k, 'data-h': k }));
      box.appendChild(h('div', { class: 'ihd ihd-rot', 'data-h': 'rot', title: 'Rotate (Shift: 15° steps)' }));
    }
    els.ui.appendChild(box);
  }

  /* =========================================================
   *  crop
   * ========================================================= */
  let crop = null; // {x,y,w,h, aspect}
  function startCrop() {
    crop = { x: 0, y: 0, w: D.w, h: D.h, aspect: crop ? crop.aspect : 0 };
  }
  function drawCropUI() {
    if (!crop) startCrop();
    const z = zoom;
    const box = h('div', { class: 'icrop', style: { left: crop.x * z + 'px', top: crop.y * z + 'px', width: crop.w * z + 'px', height: crop.h * z + 'px' } });
    box.appendChild(h('div', { class: 'icrop-grid' }));
    box.appendChild(h('div', { class: 'icrop-size' }, `${Math.round(crop.w)} × ${Math.round(crop.h)}`));
    for (const k of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) box.appendChild(h('div', { class: 'ihd ihd-' + k, 'data-c': k }));
    els.ui.appendChild(box);
  }
  function setCropAspect(a) {
    crop = crop || { x: 0, y: 0, w: D.w, h: D.h };
    crop.aspect = a;
    if (a) {
      let w = D.w,
        hh = w / a;
      if (hh > D.h) {
        hh = D.h;
        w = hh * a;
      }
      crop.w = w;
      crop.h = hh;
      crop.x = (D.w - w) / 2;
      crop.y = (D.h - hh) / 2;
    }
    drawUI();
  }
  function applyCrop() {
    if (!crop) return;
    const x = Math.round(crop.x),
      y = Math.round(crop.y),
      w = Math.max(1, Math.round(crop.w)),
      hh = Math.max(1, Math.round(crop.h));
    for (const L of D.layers) {
      L.x -= x;
      L.y -= y;
    }
    D.w = w;
    D.h = hh;
    crop = null;
    commit();
    setTool('move');
    I.fit();
    PE.toast(`Cropped to ${w} × ${hh}.`, 'ok');
  }
  /** turn the whole picture 90° */
  function rotateDoc(dir) {
    for (const L of D.layers) {
      const { x, y } = L;
      if (dir > 0) {
        L.x = D.h - y;
        L.y = x;
      } else {
        L.x = y;
        L.y = D.w - x;
      }
      L.rot = ((L.rot || 0) + 90 * dir + 360) % 360;
    }
    [D.w, D.h] = [D.h, D.w];
    crop = null;
    commit();
    I.fit();
  }
  function flipDoc(axis) {
    for (const L of D.layers) {
      if (axis === 'h') {
        L.x = D.w - L.x;
        L.flipX = !L.flipX;
        L.rot = -(L.rot || 0);
      } else {
        L.y = D.h - L.y;
        L.flipY = !L.flipY;
        L.rot = -(L.rot || 0);
      }
    }
    commit();
    render();
  }
  /** straighten: rotate the picture layers about the centre, enlarged so no corners show */
  let straightenBase = null;
  function straighten(deg, live) {
    if (!straightenBase) straightenBase = JSON.parse(JSON.stringify(D.layers));
    const a = (Math.abs(deg) * Math.PI) / 180;
    const k = Math.cos(a) + Math.max(D.w / D.h, D.h / D.w) * Math.sin(a);
    D.layers = JSON.parse(JSON.stringify(straightenBase));
    for (const L of D.layers) {
      const dx = L.x - D.w / 2,
        dy = L.y - D.h / 2;
      const r = (deg * Math.PI) / 180;
      L.x = D.w / 2 + (dx * Math.cos(r) - dy * Math.sin(r)) * k;
      L.y = D.h / 2 + (dx * Math.sin(r) + dy * Math.cos(r)) * k;
      L.w *= k;
      L.h *= k;
      if (L.type === 'text') L.size *= k;
      L.rot = (L.rot || 0) + deg;
    }
    render();
    if (!live) {
      straightenBase = null;
      commit();
    }
  }

  /* =========================================================
   *  pointer interaction
   * ========================================================= */
  let drag = null,
    stroke = null,
    editingRaster = null,
    spaceDown = false;
  const pointers = new Map();
  let pinch = null;
  function onDown(e) {
    if (!I.active || !D) return;
    if (e.target.closest('.itext-edit')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // two fingers: pinch-zoom & pan
      cancelStroke();
      drag = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, sl: els.stage.scrollLeft, st: els.stage.scrollTop };
      return;
    }
    if (e.button === 1 || tool === 'hand' || spaceDown) {
      e.preventDefault();
      drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: els.stage.scrollLeft, st: els.stage.scrollTop };
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (textEdit) endTextEdit(true);
    const p = toDoc(e);
    if (tool === 'crop') {
      const c = e.target.getAttribute && e.target.getAttribute('data-c');
      if (!crop) startCrop();
      e.preventDefault();
      drag = { kind: c ? 'crop-h' : 'crop-move', h: c, p, c0: Object.assign({}, crop) };
      if (!c && !(p[0] >= crop.x && p[0] <= crop.x + crop.w && p[1] >= crop.y && p[1] <= crop.y + crop.h)) drag = { kind: 'crop-new', p, c0: Object.assign({}, crop) };
      return;
    }
    if (tool === 'move') {
      const hd = e.target.getAttribute && e.target.getAttribute('data-h');
      const L = selLayer();
      if (hd && L) {
        e.preventDefault();
        drag = { kind: hd === 'rot' ? 'rot' : 'resize', h: hd, L0: JSON.parse(JSON.stringify(L)), p };
        return;
      }
      const hit = hitLayer(p);
      if (hit) {
        D.sel = hit.id;
        e.preventDefault();
        drag = { kind: 'move', p, x0: hit.x, y0: hit.y, moved: false };
        drawUI();
        refreshPanel();
      } else {
        D.sel = null;
        drawUI();
        refreshPanel();
        drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: els.stage.scrollLeft, st: els.stage.scrollTop };
      }
      return;
    }
    e.preventDefault();
    if (tool === 'brush' || tool === 'eraser' || tool === 'heal') return startStroke(p, e);
    if (tool === 'text') {
      const L = { id: nid(), type: 'text', name: 'Text', text: 'Your text', f: opts.text.f, size: Math.round(Math.max(24, Math.min(D.w, D.h) / 12)), color: opts.text.color, b: true, i: false, align: 'center', lh: 1.2, x: p[0], y: p[1], w: 10, h: 10, rot: 0, op: 1, blend: 'source-over', stroke: '#000000', sw: 0 };
      measureText(L);
      D.layers.push(L);
      D.sel = L.id;
      commit();
      setTool('move');
      renderNow();
      startTextEdit(L, true);
      return;
    }
    if (tool === 'shape') {
      drag = { kind: 'shape', p, cur: p };
      return;
    }
    if (tool === 'area') {
      drag = { kind: 'area', p, cur: p };
      return;
    }
    if (tool === 'picker') return pickColor(p);
    if (tool === 'magic') return magicErase(p, e.shiftKey);
    if (tool === 'fill') return bucketFill(p);
  }
  function onMove(e) {
    if (!I.active || !D) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setZoom(pinch.z * (d / pinch.d), { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      return;
    }
    if (stroke) return moveStroke(toDoc(e), e);
    if (!drag) return;
    const p = toDoc(e);
    if (drag.kind === 'pan') {
      els.stage.scrollLeft = drag.sl - (e.clientX - drag.x);
      els.stage.scrollTop = drag.st - (e.clientY - drag.y);
      return;
    }
    const L = selLayer();
    if (drag.kind === 'move' && L) {
      let nx = drag.x0 + p[0] - drag.p[0],
        ny = drag.y0 + p[1] - drag.p[1];
      // snap to the centre and edges of the canvas
      const snap = 6 / zoom;
      guides = [];
      if (Math.abs(nx - D.w / 2) < snap) {
        nx = D.w / 2;
        guides.push(['v', D.w / 2]);
      }
      if (Math.abs(ny - D.h / 2) < snap) {
        ny = D.h / 2;
        guides.push(['h', D.h / 2]);
      }
      L.x = nx;
      L.y = ny;
      drag.moved = true;
      render();
      showGuides();
    } else if (drag.kind === 'resize' && L) resizeTo(L, drag, p, e.shiftKey);
    else if (drag.kind === 'rot' && L) {
      let a = (Math.atan2(p[1] - L.y, p[0] - L.x) * 180) / Math.PI + 90;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      else if (Math.abs(((a % 90) + 90) % 90) < 2 || Math.abs(((a % 90) + 90) % 90) > 88) a = Math.round(a / 90) * 90;
      L.rot = ((a % 360) + 360) % 360;
      render();
    } else if (drag.kind.startsWith('crop')) cropDrag(p, e.shiftKey);
    else if (drag.kind === 'shape' || drag.kind === 'area') {
      drag.cur = p;
      showDraft();
    }
  }
  let guides = [];
  function showGuides() {
    els.ui.querySelectorAll('.iguide').forEach((g) => g.remove());
    for (const [k, v] of guides) els.ui.appendChild(h('div', { class: 'iguide ' + k, style: k === 'v' ? { left: v * zoom + 'px' } : { top: v * zoom + 'px' } }));
  }
  function showDraft() {
    els.ui.querySelectorAll('.idraft').forEach((g) => g.remove());
    const [x0, y0] = drag.p,
      [x1, y1] = drag.cur;
    if (drag.kind === 'shape' && (opts.shape.shape === 'line' || opts.shape.shape === 'arrow')) {
      const len = Math.hypot(x1 - x0, y1 - y0);
      els.ui.appendChild(
        h('div', { class: 'idraft line', style: { left: x0 * zoom + 'px', top: y0 * zoom + 'px', width: len * zoom + 'px', transform: `rotate(${Math.atan2(y1 - y0, x1 - x0)}rad)` } })
      );
      return;
    }
    els.ui.appendChild(
      h('div', {
        class: 'idraft' + (drag.kind === 'area' ? ' area' : ''),
        style: { left: Math.min(x0, x1) * zoom + 'px', top: Math.min(y0, y1) * zoom + 'px', width: Math.abs(x1 - x0) * zoom + 'px', height: Math.abs(y1 - y0) * zoom + 'px', borderRadius: opts.shape.shape === 'ellipse' && drag.kind === 'shape' ? '50%' : '' },
      })
    );
  }
  function resizeTo(L, d, p, free) {
    const L0 = d.L0;
    const hd = d.h;
    const sx = hd.includes('e') ? 1 : hd.includes('w') ? -1 : 0;
    const sy = hd.includes('s') ? 1 : hd.includes('n') ? -1 : 0;
    // opposite point stays fixed
    const anchorLocal = [(-sx * L0.w) / 2, (-sy * L0.h) / 2];
    const anchor = fromLocal(L0, anchorLocal[0], anchorLocal[1]);
    const pl = toLocal(L0, p);
    let w = sx ? Math.max(4, Math.abs(pl[0] - anchorLocal[0])) : L0.w;
    let hh = sy ? Math.max(4, Math.abs(pl[1] - anchorLocal[1])) : L0.h;
    const keep = (L.type === 'image' || L.type === 'text' || L.type === 'draw') && sx && sy ? !free : sx && sy && free;
    if ((keep || L.type === 'text') && sx && sy) {
      // proportional: project the pointer onto the box's diagonal
      const k = Math.max(0.02, ((pl[0] - anchorLocal[0]) * sx * L0.w + (pl[1] - anchorLocal[1]) * sy * L0.h) / (L0.w * L0.w + L0.h * L0.h));
      w = L0.w * k;
      hh = L0.h * k;
    }
    if (L.type === 'text') L.size = Math.max(4, (L0.size * w) / L0.w);
    L.w = w;
    L.h = hh;
    const cl = [anchorLocal[0] + (sx * w) / 2, anchorLocal[1] + (sy * hh) / 2];
    const c = fromLocal(L0, cl[0] + (sx ? 0 : 0), cl[1]);
    if (!sx) {
      const c2 = fromLocal(L0, 0, cl[1]);
      L.x = c2[0];
      L.y = c2[1];
    } else if (!sy) {
      const c2 = fromLocal(L0, cl[0], 0);
      L.x = c2[0];
      L.y = c2[1];
    } else {
      L.x = c[0];
      L.y = c[1];
    }
    void anchor;
    render();
  }
  function cropDrag(p, free) {
    const c0 = drag.c0;
    let { x, y, w, h: hh } = c0;
    const dx = p[0] - drag.p[0],
      dy = p[1] - drag.p[1];
    if (drag.kind === 'crop-move') {
      x = PE.clamp(c0.x + dx, 0, D.w - c0.w);
      y = PE.clamp(c0.y + dy, 0, D.h - c0.h);
    } else if (drag.kind === 'crop-new') {
      x = Math.min(drag.p[0], p[0]);
      y = Math.min(drag.p[1], p[1]);
      w = Math.abs(dx);
      hh = Math.abs(dy);
      if (crop.aspect) hh = w / crop.aspect;
    } else {
      const k = drag.h;
      let x1 = c0.x,
        y1 = c0.y,
        x2 = c0.x + c0.w,
        y2 = c0.y + c0.h;
      if (k.includes('w')) x1 = c0.x + dx;
      if (k.includes('e')) x2 = c0.x + c0.w + dx;
      if (k.includes('n')) y1 = c0.y + dy;
      if (k.includes('s')) y2 = c0.y + c0.h + dy;
      x1 = PE.clamp(x1, 0, D.w);
      x2 = PE.clamp(x2, 0, D.w);
      y1 = PE.clamp(y1, 0, D.h);
      y2 = PE.clamp(y2, 0, D.h);
      x = Math.min(x1, x2);
      y = Math.min(y1, y2);
      w = Math.abs(x2 - x1);
      hh = Math.abs(y2 - y1);
      if (crop.aspect && !free) {
        if (k === 'n' || k === 's') w = hh * crop.aspect;
        else hh = w / crop.aspect;
        if (k.includes('n')) y = y2 - hh;
        if (k.includes('w')) x = x2 - w;
      }
    }
    w = Math.max(4, Math.min(w, D.w - x));
    hh = Math.max(4, Math.min(hh, D.h - y));
    Object.assign(crop, { x, y, w, h: hh });
    drawUI();
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (!I.active || !D) return;
    if (stroke) return endStroke();
    if (!drag) return;
    const d = drag;
    drag = null;
    guides = [];
    els.ui.querySelectorAll('.iguide,.idraft').forEach((g) => g.remove());
    if (d.kind === 'move' && d.moved) commit();
    else if (d.kind === 'resize' || d.kind === 'rot') {
      commit();
      refreshPanel();
    } else if (d.kind === 'shape') finishShape(d);
    else if (d.kind === 'area') applyArea(d);
  }
  function onDbl(e) {
    if (!I.active || tool !== 'move') return;
    const L = hitLayer(toDoc(e));
    if (L && L.type === 'text') startTextEdit(L);
  }
  function finishShape(d) {
    const [x0, y0] = d.p,
      [x1, y1] = d.cur;
    const s = opts.shape;
    let L;
    if (s.shape === 'line' || s.shape === 'arrow') {
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 3) return;
      L = { w: len, h: Math.max(s.sw * 3, 12), x: (x0 + x1) / 2, y: (y0 + y1) / 2, rot: (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI };
    } else {
      let w = Math.abs(x1 - x0),
        hh = Math.abs(y1 - y0);
      if (w < 3 && hh < 3) {
        w = hh = Math.min(D.w, D.h) / 4;
        L = { w, h: hh, x: x0, y: y0, rot: 0 };
      } else L = { w, h: hh, x: (x0 + x1) / 2, y: (y0 + y1) / 2, rot: 0 };
    }
    Object.assign(L, { id: nid(), type: 'shape', name: s.shape[0].toUpperCase() + s.shape.slice(1), shape: s.shape, fill: s.fill, stroke: s.stroke, sw: s.sw, radius: s.radius, op: 1, blend: 'source-over' });
    D.layers.push(L);
    D.sel = L.id;
    commit();
    setTool('move');
    render();
    refreshPanel();
  }

  /* =========================================================
   *  painting: brush / eraser / heal
   * ========================================================= */
  function targetRaster(create) {
    let L = selLayer();
    if (isRaster(L) && !L.locked) return L;
    if (!create) return D.layers.slice().reverse().find((l) => l.type === 'image' && !l.hidden && !l.locked) || null;
    return addDrawLayer();
  }
  function dab(ctx, x, y, size, hard, color) {
    const r = size / 2;
    if (hard >= 0.99) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const g = ctx.createRadialGradient(x, y, r * hard, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, color.length === 7 ? color + '00' : 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  function startStroke(p, e) {
    const L = tool === 'heal' ? targetRaster(false) : targetRaster(true);
    if (!L) return PE.toast('Select a picture layer first.', 'warn');
    D.sel = L.id;
    const base = R.get(L.raster);
    const tmp = document.createElement('canvas');
    tmp.width = base.width;
    tmp.height = base.height;
    const out = document.createElement('canvas');
    out.width = base.width;
    out.height = base.height;
    const k = base.width / L.w; // raster px per doc px
    stroke = { L, base, tmp, out, k, last: toRasterPx(L, p), ids: new Set([L.raster]) };
    editingRaster = { layer: L.id, canvas: out };
    paintTo(toRasterPx(L, p), e.pressure);
  }
  function paintTo(pt, pressure) {
    const s = stroke;
    const o = tool === 'brush' ? opts.brush : tool === 'eraser' ? opts.eraser : opts.heal;
    const size = Math.max(1, o.size * s.k * (pressure && pressure !== 0.5 && pressure > 0 ? 0.4 + pressure * 0.9 : 1));
    const ctx = s.tmp.getContext('2d');
    const [x0, y0] = s.last,
      [x1, y1] = pt;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(1, size / 5);
    const col = tool === 'heal' ? '#ff00ff' : tool === 'eraser' ? '#000000' : o.color;
    const hard = tool === 'heal' ? 1 : o.hard;
    for (let t = 0; t <= dist; t += step) dab(ctx, x0 + ((x1 - x0) * t) / (dist || 1), y0 + ((y1 - y0) * t) / (dist || 1), size, hard, col);
    if (!dist) dab(ctx, x1, y1, size, hard, col);
    s.last = pt;
    // preview: base + stroke
    const oc = s.out.getContext('2d');
    oc.globalCompositeOperation = 'copy';
    oc.drawImage(s.base, 0, 0);
    oc.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    oc.globalAlpha = tool === 'heal' ? 0.45 : o.op;
    oc.drawImage(s.tmp, 0, 0);
    oc.globalAlpha = 1;
    oc.globalCompositeOperation = 'source-over';
    proc.delete(s.L.id);
    render();
  }
  function moveStroke(p, e) {
    paintTo(toRasterPx(stroke.L, p), e.pressure);
  }
  function cancelStroke() {
    stroke = null;
    editingRaster = null;
    render();
  }
  function endStroke() {
    const s = stroke;
    stroke = null;
    editingRaster = null;
    const r = newRaster(s.base.width, s.base.height);
    const ctx = r.c.getContext('2d');
    ctx.drawImage(s.base, 0, 0);
    if (tool === 'heal') {
      // fill the painted area from the pixels around it
      const m = s.tmp.getContext('2d').getImageData(0, 0, s.tmp.width, s.tmp.height).data;
      let x0 = s.tmp.width,
        y0 = s.tmp.height,
        x1 = 0,
        y1 = 0;
      for (let y = 0; y < s.tmp.height; y++)
        for (let x = 0; x < s.tmp.width; x++)
          if (m[(y * s.tmp.width + x) * 4 + 3] > 20) {
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
          }
      if (x1 >= x0) {
        const pad = 6;
        x0 = Math.max(0, x0 - pad);
        y0 = Math.max(0, y0 - pad);
        x1 = Math.min(s.tmp.width - 1, x1 + pad);
        y1 = Math.min(s.tmp.height - 1, y1 + pad);
        const w = x1 - x0 + 1,
          hh = y1 - y0 + 1;
        const img = ctx.getImageData(x0, y0, w, hh);
        const mask = new Uint8Array(w * hh);
        for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) mask[y * w + x] = m[((y + y0) * s.tmp.width + x + x0) * 4 + 3] > 20 ? 1 : 0;
        PE.inpaint(img, mask);
        ctx.putImageData(img, x0, y0);
      }
    } else {
      ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
      ctx.globalAlpha = tool === 'eraser' ? opts.eraser.op : opts.brush.op;
      ctx.drawImage(s.tmp, 0, 0);
    }
    s.L.raster = r.id;
    proc.delete(s.L.id);
    commit();
    render();
    refreshPanel();
  }

  /* =========================================================
   *  pixel tools
   * ========================================================= */
  function pickColor(p) {
    const c = els.canvas.getContext('2d', { willReadFrequently: true }).getImageData(PE.clamp(p[0] | 0, 0, D.w - 1), PE.clamp(p[1] | 0, 0, D.h - 1), 1, 1).data;
    const hex = PE.rgbToHex(c[0], c[1], c[2]);
    opts.brush.color = opts.fill.color = opts.shape.fill = opts.text.color = hex;
    const L = selLayer();
    if (L && L.type === 'text') L.color = hex;
    else if (L && L.type === 'shape') L.fill = hex;
    if (L && (L.type === 'text' || L.type === 'shape')) commit();
    render();
    refreshPanel();
    PE.toast('Picked ' + hex.toUpperCase(), 'ok');
  }
  /** flood region from a point (tolerance on colour distance) -> mask */
  function flood(img, sx, sy, tol) {
    const { width: w, height: hh, data: d } = img;
    const mask = new Uint8Array(w * hh);
    const k0 = (sy * w + sx) * 4;
    const r0 = d[k0],
      g0 = d[k0 + 1],
      b0 = d[k0 + 2],
      a0 = d[k0 + 3];
    const t = tol * tol * 3;
    const stack = [sy * w + sx];
    while (stack.length) {
      const k = stack.pop();
      if (mask[k]) continue;
      const i = k * 4;
      const dr = d[i] - r0,
        dg = d[i + 1] - g0,
        db = d[i + 2] - b0,
        da = d[i + 3] - a0;
      if (dr * dr + dg * dg + db * db + da * da > t) continue;
      mask[k] = 1;
      const x = k % w,
        y = (k / w) | 0;
      if (x > 0) stack.push(k - 1);
      if (x < w - 1) stack.push(k + 1);
      if (y > 0) stack.push(k - w);
      if (y < hh - 1) stack.push(k + w);
    }
    return mask;
  }
  function featherMask(mask, w, hh) {
    // soften the edge by one pixel so cut-outs don't look jagged
    const a = new Float32Array(w * hh);
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < w; x++) {
        let s = 0,
          n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= hh) continue;
            s += mask[yy * w + xx];
            n++;
          }
        a[y * w + x] = s / n;
      }
    return a;
  }
  function editRaster(L, fn) {
    const r = cloneRaster(L.raster);
    const ctx = r.c.getContext('2d', { willReadFrequently: true });
    const res = fn(ctx, r.c);
    if (res === false) {
      R.delete(r.id);
      return false;
    }
    L.raster = r.id;
    proc.delete(L.id);
    commit();
    render();
    refreshPanel();
    return true;
  }
  function magicErase(p, contiguousOff) {
    const L = targetRaster(false);
    if (!L) return PE.toast('Select a picture layer first.', 'warn');
    const [px, py] = toRasterPx(L, p).map((v) => v | 0);
    editRaster(L, (ctx, c) => {
      if (px < 0 || py < 0 || px >= c.width || py >= c.height) return false;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      let mask;
      if (contiguousOff) {
        // Shift-click: every pixel of that colour, not just the touching ones
        const d = img.data,
          i0 = (py * c.width + px) * 4,
          t = opts.magic.tol * opts.magic.tol * 3;
        mask = new Uint8Array(c.width * c.height);
        for (let k = 0; k < mask.length; k++) {
          const dr = d[k * 4] - d[i0],
            dg = d[k * 4 + 1] - d[i0 + 1],
            db = d[k * 4 + 2] - d[i0 + 2];
          mask[k] = dr * dr + dg * dg + db * db <= t ? 1 : 0;
        }
      } else mask = flood(img, px, py, opts.magic.tol);
      const a = featherMask(mask, c.width, c.height);
      for (let k = 0; k < a.length; k++) if (a[k]) img.data[k * 4 + 3] = img.data[k * 4 + 3] * (1 - a[k]);
      ctx.putImageData(img, 0, 0);
    });
  }
  /** remove a plain background: everything connected to the edges that looks like the edges */
  I.removeBackground = function (tol = 38) {
    const L = targetRaster(false);
    if (!L) return PE.toast('Select a picture layer first.', 'warn');
    PE.ui.busy(true, 'Removing the background', 0.3);
    setTimeout(() => {
      editRaster(L, (ctx, c) => {
        const w = c.width,
          hh = c.height;
        const img = ctx.getImageData(0, 0, w, hh);
        const d = img.data;
        const mask = new Uint8Array(w * hh);
        const t = tol * tol * 3;
        const tStep = (tol * 0.55) ** 2 * 3;
        const stack = [];
        const seeds = [];
        for (let x = 0; x < w; x += 2) seeds.push(x, (hh - 1) * w + x);
        for (let y = 0; y < hh; y += 2) seeds.push(y * w, y * w + w - 1);
        // the most common edge colours are the background
        const ref = new Map();
        for (const k of seeds) {
          const i = k * 4;
          const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
          ref.set(key, (ref.get(key) || 0) + 1);
        }
        const refs = [...ref.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .filter((e) => e[1] > seeds.length * 0.03)
          .map(([k]) => [((k >> 8) & 15) * 16 + 8, ((k >> 4) & 15) * 16 + 8, (k & 15) * 16 + 8]);
        const nearRef = (i) => refs.some((r) => (d[i] - r[0]) ** 2 + (d[i + 1] - r[1]) ** 2 + (d[i + 2] - r[2]) ** 2 <= t);
        for (const k of seeds) if (nearRef(k * 4)) stack.push([k, k]);
        while (stack.length) {
          const [k, from] = stack.pop();
          if (mask[k]) continue;
          const i = k * 4,
            j = from * 4;
          if (d[i + 3] > 10) {
            const step = (d[i] - d[j]) ** 2 + (d[i + 1] - d[j + 1]) ** 2 + (d[i + 2] - d[j + 2]) ** 2;
            if (step > tStep || !nearRef(i)) continue;
          }
          mask[k] = 1;
          const x = k % w,
            y = (k / w) | 0;
          if (x > 0) stack.push([k - 1, k]);
          if (x < w - 1) stack.push([k + 1, k]);
          if (y > 0) stack.push([k - w, k]);
          if (y < hh - 1) stack.push([k + w, k]);
        }
        let removed = 0;
        const a = featherMask(mask, w, hh);
        for (let k = 0; k < a.length; k++)
          if (a[k]) {
            d[k * 4 + 3] = d[k * 4 + 3] * (1 - a[k]);
            removed++;
          }
        if (removed < w * hh * 0.01) {
          PE.toast('No plain background was found around the edges. Try the magic eraser on the background.', 'warn', 6000);
          return false;
        }
        ctx.putImageData(img, 0, 0);
        PE.toast('Background removed. Use the eraser or magic eraser to tidy any leftovers.', 'ok', 5000);
      });
      PE.ui.busy(false);
    }, 30);
  };
  function bucketFill(p) {
    const L = targetRaster(false);
    if (!L) return PE.toast('Select a picture layer first.', 'warn');
    const [px, py] = toRasterPx(L, p).map((v) => v | 0);
    editRaster(L, (ctx, c) => {
      if (px < 0 || py < 0 || px >= c.width || py >= c.height) return false;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const mask = flood(img, px, py, opts.fill.tol);
      const m = opts.fill.color.match(/[0-9a-f]{2}/gi).map((x) => parseInt(x, 16));
      for (let k = 0; k < mask.length; k++)
        if (mask[k]) {
          img.data[k * 4] = m[0];
          img.data[k * 4 + 1] = m[1];
          img.data[k * 4 + 2] = m[2];
          img.data[k * 4 + 3] = 255;
        }
      ctx.putImageData(img, 0, 0);
    });
  }
  function applyArea(d) {
    const [x0, y0] = d.p,
      [x1, y1] = d.cur;
    if (Math.abs(x1 - x0) < 3 || Math.abs(y1 - y0) < 3) return;
    const L = targetRaster(false);
    if (!L) return PE.toast('Select a picture layer first.', 'warn');
    const a = toRasterPx(L, [Math.min(x0, x1), Math.min(y0, y1)]),
      b = toRasterPx(L, [Math.max(x0, x1), Math.max(y0, y1)]);
    editRaster(L, (ctx, c) => {
      const rx = PE.clamp(Math.min(a[0], b[0]) | 0, 0, c.width),
        ry = PE.clamp(Math.min(a[1], b[1]) | 0, 0, c.height);
      const rw = PE.clamp(Math.abs(b[0] - a[0]) | 0, 1, c.width - rx),
        rh = PE.clamp(Math.abs(b[1] - a[1]) | 0, 1, c.height - ry);
      if (rw < 2 || rh < 2) return false;
      const amt = opts.area.amount * (c.width / L.w);
      if (opts.area.mode === 'pixelate') {
        const s = Math.max(2, Math.round(amt));
        const t = document.createElement('canvas');
        t.width = Math.max(1, Math.ceil(rw / s));
        t.height = Math.max(1, Math.ceil(rh / s));
        t.getContext('2d').drawImage(c, rx, ry, rw, rh, 0, 0, t.width, t.height);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(rx, ry, rw, rh);
        ctx.drawImage(t, 0, 0, t.width, t.height, rx, ry, rw, rh);
        ctx.imageSmoothingEnabled = true;
      } else if (opts.area.mode === 'black') {
        ctx.fillStyle = '#000';
        ctx.fillRect(rx, ry, rw, rh);
      } else {
        // blur by repeated down/up scaling (works everywhere)
        const t = document.createElement('canvas');
        const f = Math.max(2, amt / 2);
        t.width = Math.max(1, Math.round(rw / f));
        t.height = Math.max(1, Math.round(rh / f));
        const tc = t.getContext('2d');
        tc.imageSmoothingQuality = 'high';
        tc.drawImage(c, rx, ry, rw, rh, 0, 0, t.width, t.height);
        const t2 = document.createElement('canvas');
        t2.width = rw;
        t2.height = rh;
        const t2c = t2.getContext('2d');
        t2c.imageSmoothingQuality = 'high';
        t2c.drawImage(t, 0, 0, rw, rh);
        // second pass smooths the blocks
        tc.clearRect(0, 0, t.width, t.height);
        tc.drawImage(t2, 0, 0, t.width, t.height);
        t2c.clearRect(0, 0, rw, rh);
        t2c.drawImage(t, 0, 0, rw, rh);
        ctx.clearRect(rx, ry, rw, rh);
        ctx.drawImage(t2, rx, ry);
      }
    });
  }

  /* =========================================================
   *  text editing on the canvas
   * ========================================================= */
  let textEdit = null;
  function startTextEdit(L, selectAll) {
    endTextEdit(true);
    const ta = h('textarea', { class: 'itext-edit', spellcheck: 'false' });
    ta.value = L.text;
    textEdit = { id: L.id, ta };
    const place = () => {
      measureText(L);
      Object.assign(ta.style, {
        left: (L.x - L.w / 2) * zoom + 'px',
        top: (L.y - L.h / 2) * zoom + 'px',
        width: L.w * zoom + 4 + 'px',
        height: L.h * zoom + 'px',
        font: `${L.i ? 'italic ' : ''}${L.b ? 700 : 400} ${L.size * zoom}px ${PE.fonts.cssFamily(L.f)}`,
        lineHeight: L.lh || 1.2,
        color: L.color,
        textAlign: L.align || 'center',
        transform: `rotate(${L.rot || 0}deg)`,
        letterSpacing: (L.ls || 0) * zoom + 'px',
        background: L.bg || 'transparent',
        padding: (L.bg ? L.size * 0.35 * zoom : 0) + 'px',
        WebkitTextStroke: L.sw ? `${L.sw * zoom}px ${L.stroke}` : '',
      });
    };
    place();
    ta.addEventListener('input', () => {
      L.text = ta.value;
      place();
      render();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        endTextEdit(true);
      }
    });
    ta.addEventListener('blur', () => setTimeout(() => textEdit && textEdit.ta === ta && endTextEdit(true), 120));
    els.wrap.appendChild(ta);
    render();
    setTimeout(() => {
      ta.focus();
      if (selectAll) ta.select();
    }, 20);
  }
  function endTextEdit(save) {
    if (!textEdit) return;
    const t = textEdit;
    textEdit = null;
    const L = D && D.layers.find((l) => l.id === t.id);
    if (L && save) {
      L.text = t.ta.value;
      if (!L.named) L.name = L.text.trim().split('\n')[0].slice(0, 32) || 'Text';
      if (!L.text.trim()) {
        D.layers = D.layers.filter((x) => x !== L);
        D.sel = null;
      }
      commit();
    }
    t.ta.remove();
    if (D) {
      render();
      refreshPanel();
    }
  }

  /* =========================================================
   *  tools & panel
   * ========================================================= */
  function setTool(t) {
    if (textEdit) endTextEdit(true);
    if (tool === 'crop' && t !== 'crop') crop = null;
    tool = t;
    if (t === 'crop') startCrop();
    if (els) {
      els.tools.querySelectorAll('.mtool').forEach((b) => b.classList.toggle('on', b.getAttribute('data-t') === t));
      els.stage.setAttribute('data-tool', t);
      if (['crop', 'brush', 'eraser', 'heal', 'text', 'shape', 'area', 'magic', 'fill', 'picker'].includes(t)) panelTab = 'props';
    }
    drawUI();
    refreshPanel();
  }
  I.setTool = setTool;

  const C = () => PE.ui.controls;
  function section(title, children) {
    return h('section', { class: 'msec' }, [title ? h('h3', {}, title) : null].concat(children));
  }
  function btn(label, ic, fn, cls) {
    return h('button', { class: 'btn ' + (cls || ''), type: 'button', html: (ic ? icon(ic) : '') + '<span>' + PE.esc(label) + '</span>', onclick: fn });
  }
  function colorRow(label, value, fn, none) {
    return h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, label), C().colors(value, fn, { none })]);
  }
  function select(value, list, fn, label) {
    const s = h('select', { class: 'field', 'aria-label': label || '' });
    for (const [v, t] of list) s.appendChild(h('option', { value: v, selected: v === value }, t));
    s.addEventListener('change', () => fn(s.value));
    return s;
  }
  function refreshPanel() {
    if (!els || !D) return;
    els.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === panelTab));
    const body = els.body;
    const keepScroll = body.scrollTop;
    body.innerHTML = '';
    const parts = panelTab === 'adjust' ? adjustPanel() : panelTab === 'filters' ? filtersPanel() : panelTab === 'layers' ? layersPanel() : propsPanel();
    parts.filter(Boolean).forEach((p) => body.appendChild(p));
    body.scrollTop = keepScroll;
  }
  I.refreshPanel = refreshPanel;

  function propsPanel() {
    const out = [];
    const t = tool;
    if (t === 'crop') {
      const asp = [
        [0, 'Free'],
        [D.w / D.h, 'Original'],
        [1, '1:1'],
        [4 / 5, '4:5'],
        [4 / 3, '4:3'],
        [3 / 2, '3:2'],
        [16 / 9, '16:9'],
        [9 / 16, '9:16'],
      ];
      const grid = h('div', { class: 'chips' });
      for (const [a, l] of asp) grid.appendChild(h('button', { class: 'chip' + (crop && Math.abs((crop.aspect || 0) - a) < 0.001 ? ' on' : ''), onclick: () => (setCropAspect(a), refreshPanel()) }, l));
      out.push(
        section('Crop', [
          grid,
          h('div', { class: 'mbtns' }, [btn('Rotate left', 'rotate-ccw', () => rotateDoc(-1)), btn('Rotate right', 'rotate-cw', () => rotateDoc(1)), btn('Flip ↔', 'flip-h', () => flipDoc('h')), btn('Flip ↕', 'flip-v', () => flipDoc('v'))]),
          PE.slider('Straighten', 0, -45, 45, 0.5, (v, live) => straighten(v, live), (v) => v + '°'),
          h('div', { class: 'mbtns' }, [btn('Apply crop', 'check', applyCrop, 'primary'), btn('Cancel', 'close', () => setTool('move'))]),
          h('p', { class: 'p-note' }, 'Drag the corners or edges, or drag a new area. Shift ignores the ratio. Enter applies.'),
        ])
      );
      return out;
    }
    if (t === 'brush' || t === 'eraser') {
      const o = opts[t];
      const kids = [PE.slider('Size', o.size, 1, 400, 1, (v) => (o.size = v), (v) => v + ' px'), PE.slider('Hardness', o.hard, 0, 1, 0.01, (v) => (o.hard = v)), PE.slider('Opacity', o.op, 0.05, 1, 0.01, (v) => (o.op = v))];
      if (t === 'brush') kids.unshift(colorRow('Colour', o.color, (c) => (o.color = c)));
      kids.push(h('p', { class: 'p-note' }, t === 'brush' ? 'Paints on the selected picture or drawing layer (a new drawing layer is made if needed). [ and ] change the size.' : 'Erases from the selected picture or drawing layer.'));
      out.push(section(t === 'brush' ? 'Brush' : 'Eraser', kids));
      return out;
    }
    if (t === 'heal') {
      out.push(section('Heal', [PE.slider('Size', opts.heal.size, 4, 300, 1, (v) => (opts.heal.size = v), (v) => v + ' px'), h('p', { class: 'p-note' }, 'Paint over a spot, mark, wire or small object; when you let go it is filled in from the picture around it.')]));
      return out;
    }
    if (t === 'shape') {
      const s = opts.shape;
      const kinds = h('div', { class: 'chips' });
      for (const k of ['rect', 'ellipse', 'triangle', 'star', 'heart', 'line', 'arrow'])
        kinds.appendChild(h('button', { class: 'chip' + (s.shape === k ? ' on' : ''), onclick: () => ((s.shape = k), refreshPanel()) }, k[0].toUpperCase() + k.slice(1)));
      out.push(section('Shape', [kinds, colorRow(s.shape === 'line' || s.shape === 'arrow' ? 'Colour' : 'Fill', s.fill, (c) => (s.fill = c), true), PE.slider('Line width', s.sw, 0, 60, 1, (v) => (s.sw = v)), h('p', { class: 'p-note' }, 'Drag on the picture to draw the shape.')]));
      return out;
    }
    if (t === 'area') {
      const a = opts.area;
      out.push(
        section('Blur or pixelate an area', [
          C().seg(
            [
              { v: 'blur', text: 'Blur' },
              { v: 'pixelate', text: 'Pixelate' },
              { v: 'black', text: 'Black box' },
            ],
            a.mode,
            (v) => (a.mode = v)
          ),
          PE.slider('Strength', a.amount, 4, 80, 1, (v) => (a.amount = v)),
          h('p', { class: 'p-note' }, 'Drag over faces, number plates or private details on the selected picture.'),
        ])
      );
      return out;
    }
    if (t === 'magic') {
      out.push(section('Magic eraser', [PE.slider('Tolerance', opts.magic.tol, 1, 150, 1, (v) => (opts.magic.tol = v)), h('p', { class: 'p-note' }, 'Click a colour to make it transparent. Shift-click removes that colour everywhere in the picture.'), btn('Remove background automatically', 'magic', () => I.removeBackground())]));
      return out;
    }
    if (t === 'fill') {
      out.push(section('Fill', [colorRow('Colour', opts.fill.color, (c) => (opts.fill.color = c)), PE.slider('Tolerance', opts.fill.tol, 0, 150, 1, (v) => (opts.fill.tol = v)), h('p', { class: 'p-note' }, 'Click an area of similar colour to fill it.')]));
      return out;
    }
    if (t === 'text') {
      out.push(section('Text', [h('p', { class: 'p-note' }, 'Click on the picture to add text. Double-click text later to change it.')]));
      return out;
    }
    if (t === 'picker') {
      out.push(section('Colour picker', [h('p', { class: 'p-note' }, 'Click anywhere to pick its colour for the brush, fill, shapes and text.')]));
      return out;
    }
    const L = selLayer();
    if (!L) return documentPanel();
    out.push(layerProps(L));
    return out;
  }
  function documentPanel() {
    const out = [];
    out.push(
      section('Picture', [
        h('p', { class: 'p-note' }, `${D.w} × ${D.h} pixels · ${D.layers.length} layer${D.layers.length === 1 ? '' : 's'}`),
        h('div', { class: 'mbtns' }, [btn('Resize image…', 'fit', resizeDialog), btn('Canvas size…', 'crop', canvasDialog), btn('Crop', 'crop', () => setTool('crop')), btn('Rotate right', 'rotate-cw', () => rotateDoc(1))]),
        colorRow('Background', D.bg, (c) => {
          D.bg = c;
          commit();
          render();
        }, true),
      ])
    );
    out.push(
      section('Add', [
        h('div', { class: 'mbtns' }, [
          btn('Picture…', 'image', addPictureFromPicker),
          btn('Text', 'text', () => setTool('text')),
          btn('Shape', 'shapes', () => setTool('shape')),
          btn('Drawing layer', 'brush', () => {
            addDrawLayer();
            commit();
            render();
            refreshPanel();
          }),
        ]),
      ])
    );
    out.push(section('', [h('p', { class: 'p-note' }, 'Select a layer on the picture to move, resize, rotate or style it. Use the Adjust and Filters tabs to change colours.')]));
    return out;
  }
  async function addPictureFromPicker() {
    const files = await PE.pickFiles('image/*', true);
    if (files.length) I.add(files);
  }
  function layerProps(L) {
    const kids = [];
    const upd = (fn, live) => {
      fn();
      render();
      if (!live) commit();
    };
    kids.push(
      h('div', { class: 'mrow' }, [
        h('input', {
          class: 'field',
          value: L.name || '',
          'aria-label': 'Layer name',
          onchange: (e) => upd(() => ((L.name = e.target.value), (L.named = true))),
        }),
      ])
    );
    if (L.type === 'text') {
      const ta = h('textarea', { class: 'field', rows: 3, 'aria-label': 'Text' });
      ta.value = L.text;
      ta.addEventListener('input', () => upd(() => (L.text = ta.value), true));
      ta.addEventListener('change', () => commit());
      kids.push(ta);
      kids.push(
        C().fontSelect(L.f, (f) => upd(() => (L.f = f))),
        h('div', { class: 'p-grid2' }, [
          C().num(Math.round(L.size), { min: 4, max: 1000, step: 2, label: 'Size' }, (v) => upd(() => (L.size = v))),
          C().seg(
            [
              { v: 'b', icon: 'bold', title: 'Bold', on: L.b },
              { v: 'i', icon: 'italic', title: 'Italic', on: L.i },
            ],
            null,
            (k, on) => upd(() => (L[k] = on)),
            true
          ),
        ]),
        C().seg(
          [
            { v: 'left', icon: 'al-left', title: 'Left' },
            { v: 'center', icon: 'al-center', title: 'Centre' },
            { v: 'right', icon: 'al-right', title: 'Right' },
          ],
          L.align || 'center',
          (v) => upd(() => (L.align = v))
        ),
        colorRow('Colour', L.color, (c, live) => upd(() => (L.color = c), live)),
        PE.slider('Letter spacing', L.ls || 0, -10, 60, 1, (v, live) => upd(() => (L.ls = v), live), (v) => v),
        PE.slider('Line height', L.lh || 1.2, 0.8, 2.5, 0.05, (v, live) => upd(() => (L.lh = v), live), (v) => v.toFixed(2)),
        colorRow('Outline', L.sw ? L.stroke : null, (c, live) => upd(() => ((L.stroke = c || '#000000'), (L.sw = c ? L.sw || Math.max(2, L.size / 16) : 0)), live), true),
        L.sw ? PE.slider('Outline width', L.sw, 1, 40, 1, (v, live) => upd(() => (L.sw = v), live), (v) => v) : null,
        colorRow('Background', L.bg || null, (c, live) => upd(() => (L.bg = c), live), true)
      );
    }
    if (L.type === 'shape') {
      const line = L.shape === 'line' || L.shape === 'arrow';
      kids.push(colorRow(line ? 'Colour' : 'Fill', L.fill, (c, live) => upd(() => (L.fill = c), live), !line));
      if (!line) kids.push(colorRow('Outline', L.stroke || null, (c, live) => upd(() => ((L.stroke = c), (L.sw = c ? L.sw || 4 : L.sw)), live), true));
      kids.push(PE.slider(line ? 'Thickness' : 'Outline width', L.sw || 0, 0, 80, 1, (v, live) => upd(() => (L.sw = v), live), (v) => v));
      if (L.shape === 'rect') kids.push(PE.slider('Corner radius', L.radius || 0, 0, Math.min(L.w, L.h) / 2, 1, (v, live) => upd(() => (L.radius = v), live), (v) => v));
    }
    if (L.type === 'image') kids.push(PE.slider('Rounded corners', L.radius || 0, 0, Math.min(L.w, L.h) / 2, 1, (v, live) => upd(() => (L.radius = v), live), (v) => Math.round(v)));
    kids.push(PE.slider('Opacity', L.op == null ? 1 : L.op, 0, 1, 0.01, (v, live) => upd(() => (L.op = v), live)));
    kids.push(h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, 'Blend'), select(L.blend || 'source-over', BLENDS, (v) => upd(() => (L.blend = v)), 'Blend mode')]));
    kids.push(
      h('div', { class: 'mrow' }, [
        h('label', { class: 'chk' }, [
          h('input', { type: 'checkbox', checked: !!L.shadow, onchange: (e) => upd(() => (L.shadow = e.target.checked)) }),
          ' Drop shadow',
        ]),
      ])
    );
    // position & size
    const geo = h('div', { class: 'mgeo' });
    const numf = (lbl, v, fn) => h('label', {}, [h('span', {}, lbl), h('input', { class: 'field', type: 'number', value: Math.round(v), onchange: (e) => upd(() => fn(+e.target.value)) })]);
    geo.append(
      numf('X', L.x - L.w / 2, (v) => (L.x = v + L.w / 2)),
      numf('Y', L.y - L.h / 2, (v) => (L.y = v + L.h / 2)),
      numf('W', L.w, (v) => {
        const k = v / L.w;
        if (L.type === 'text') L.size *= k;
        else if (L.type !== 'shape') L.h *= k;
        L.w = v;
      }),
      numf('H', L.h, (v) => {
        const k = v / L.h;
        if (L.type === 'text') L.size *= k;
        else if (L.type !== 'shape') L.w *= k;
        L.h = v;
      }),
      numf('°', L.rot || 0, (v) => (L.rot = v))
    );
    kids.push(geo);
    const acts = [
      btn('Duplicate', 'copy', () => duplicate()),
      btn('Flip ↔', 'flip-h', () => upd(() => (L.flipX = !L.flipX))),
      btn('Flip ↕', 'flip-v', () => upd(() => (L.flipY = !L.flipY))),
      btn('Centre', 'fit', () => upd(() => ((L.x = D.w / 2), (L.y = D.h / 2)))),
      btn('Forward', 'front', () => arrange(1)),
      btn('Backward', 'back', () => arrange(-1)),
    ];
    if (isRaster(L)) {
      acts.push(btn('Fill canvas', 'fit', () => upd(() => fillCanvas(L))));
      acts.push(btn('Remove background', 'magic', () => I.removeBackground()));
      if (L.type === 'image') acts.push(btn('Replace…', 'image', () => replaceImage(L)));
    }
    acts.push(btn(L.locked ? 'Unlock' : 'Lock', 'lock', () => upd(() => (L.locked = !L.locked))), btn('Delete', 'trash', () => deleteSel(), 'danger'));
    kids.push(h('div', { class: 'mbtns' }, acts));
    return section(L.type === 'text' ? 'Text' : L.type === 'shape' ? 'Shape' : L.type === 'draw' ? 'Drawing' : 'Picture', kids);
  }
  function fillCanvas(L) {
    const k = Math.max(D.w / L.w, D.h / L.h);
    L.w *= k;
    L.h *= k;
    L.x = D.w / 2;
    L.y = D.h / 2;
    L.rot = 0;
  }
  async function replaceImage(L) {
    const [f] = await PE.pickFiles('image/*');
    if (!f) return;
    const im = await loadImage(f);
    const r = rasterFromSource(im.src, im.w, im.h);
    const k = Math.min(L.w / r.c.width, L.h / r.c.height);
    L.raster = r.id;
    L.w = r.c.width * k;
    L.h = r.c.height * k;
    proc.delete(L.id);
    commit();
    render();
  }

  function adjustPanel() {
    let L = selLayer();
    if (!isRaster(L)) L = D.layers.slice().reverse().find((l) => l.type === 'image');
    if (!L) return [section('Adjust', [h('p', { class: 'p-note' }, 'Add a picture to adjust its colours.')])];
    L.adj = L.adj || {};
    const kids = [h('p', { class: 'p-note' }, `Adjusting “${L.name}”. Double-click a slider to reset it.`)];
    if (!gl.ok) kids.push(h('p', { class: 'p-note warn' }, 'Colour adjustments need WebGL, which this browser has turned off.'));
    for (const d of PE.ADJ)
      kids.push(
        PE.slider(d.label, L.adj[d.k] || 0, d.min, d.max, d.step, (v, live) => {
          L.adj[d.k] = v;
          renderNow();
          if (!live) commit();
        }, d.k === 'hue' ? (v) => v + '°' : null)
      );
    kids.push(
      h('div', { class: 'mbtns' }, [
        btn('Auto enhance', 'magic', () => autoEnhance(L)),
        btn('Reset all', 'history', () => {
          L.adj = {};
          commit();
          render();
          refreshPanel();
        }),
      ])
    );
    return [section('Adjust', kids)];
  }
  /** simple auto levels: stretch contrast, fix exposure, a touch of colour */
  function autoEnhance(L) {
    const c = R.get(L.raster);
    const t = document.createElement('canvas');
    const k = Math.min(1, 256 / Math.max(c.width, c.height));
    t.width = Math.max(1, c.width * k);
    t.height = Math.max(1, c.height * k);
    const tc = t.getContext('2d', { willReadFrequently: true });
    tc.drawImage(c, 0, 0, t.width, t.height);
    const d = tc.getImageData(0, 0, t.width, t.height).data;
    const lums = [];
    let sat = 0,
      wb = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      lums.push(l);
      sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      wb += d[i + 2] - d[i];
    }
    if (!lums.length) return;
    lums.sort((a, b) => a - b);
    const lo = lums[Math.floor(lums.length * 0.02)],
      hi = lums[Math.floor(lums.length * 0.98)],
      mid = lums[Math.floor(lums.length / 2)];
    sat /= lums.length;
    wb /= lums.length;
    L.adj = Object.assign({}, L.adj, {
      contrast: PE.clamp((200 / Math.max(40, hi - lo) - 1) * 0.5, -0.2, 0.45),
      exposure: PE.clamp((118 - mid) / 300, -0.35, 0.45),
      shadows: lo > 30 ? 0 : 0.15,
      highlights: hi > 245 ? -0.15 : 0,
      vibrance: sat < 60 ? 0.25 : 0.1,
      temperature: PE.clamp(wb / 300, -0.2, 0.2),
    });
    commit();
    render();
    refreshPanel();
    PE.toast('Enhanced. Fine-tune with the sliders.', 'ok');
  }

  let filterAmount = 1;
  function filtersPanel() {
    let L = selLayer();
    if (!isRaster(L)) L = D.layers.slice().reverse().find((l) => l.type === 'image');
    if (!L) return [section('Filters', [h('p', { class: 'p-note' }, 'Add a picture to use filters.')])];
    const src = R.get(L.raster);
    const small = document.createElement('canvas');
    const k = Math.min(1, 140 / Math.max(src.width, src.height));
    small.width = Math.max(1, src.width * k);
    small.height = Math.max(1, src.height * k);
    small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);
    const grid = h('div', { class: 'fgrid' });
    const curName = L.filter || 'Original';
    for (const f of PE.FILTERS) {
      const cv = h('canvas', { width: small.width, height: small.height });
      const g = gl.draw(small, f.a, small.width, small.height);
      cv.getContext('2d').drawImage(g, 0, 0);
      grid.appendChild(
        h('button', { class: 'fthumb' + (curName === f.name ? ' on' : ''), onclick: () => applyFilter(L, f) }, [cv, h('span', {}, f.name)])
      );
    }
    return [
      section('Filters', [
        h('p', { class: 'p-note' }, `For “${L.name}”. A filter replaces the colour settings; fine-tune them in Adjust.`),
        PE.slider('Intensity', filterAmount, 0, 1, 0.01, (v, live) => {
          filterAmount = v;
          const f = PE.FILTERS.find((x) => x.name === (L.filter || 'Original'));
          if (f) {
            L.adj = scaled(f.a, v);
            renderNow();
            if (!live) commit();
          }
        }),
        grid,
      ]),
    ];
  }
  const scaled = (a, k) => Object.fromEntries(Object.entries(a).map(([x, v]) => [x, v * k]));
  function applyFilter(L, f) {
    L.filter = f.name;
    L.adj = scaled(f.a, filterAmount);
    commit();
    render();
    refreshPanel();
  }

  function layersPanel() {
    const list = h('div', { class: 'llist', role: 'list' });
    const layers = D.layers.slice().reverse();
    for (const L of layers) {
      const th = h('canvas', { class: 'lthumb', width: 48, height: 36 });
      const tc = th.getContext('2d');
      const k = Math.min(48 / L.w, 36 / L.h);
      tc.save();
      tc.translate(24, 18);
      tc.scale(k, k);
      tc.translate(-L.x, -L.y);
      drawLayer(tc, Object.assign({}, L, { op: 1, blend: 'source-over', shadow: false }));
      tc.restore();
      const row = h('div', { class: 'lrow' + (L.id === D.sel ? ' on' : '') + (L.hidden ? ' off' : ''), role: 'listitem', draggable: 'true', 'data-id': L.id }, [
        h('button', { class: 'icon-btn sm', title: L.hidden ? 'Show' : 'Hide', 'aria-label': L.hidden ? 'Show layer' : 'Hide layer', html: icon(L.hidden ? 'eye-off' : 'eye'), onclick: (e) => (e.stopPropagation(), (L.hidden = !L.hidden), commit(), render(), refreshPanel()) }),
        th,
        h('span', { class: 'lname' }, (L.locked ? '🔒 ' : '') + (L.name || L.type)),
      ]);
      row.addEventListener('click', () => {
        D.sel = L.id;
        setTool('move');
        panelTab = 'layers';
        refreshPanel();
      });
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', L.id);
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain');
        const from = D.layers.findIndex((x) => x.id === id),
          to = D.layers.findIndex((x) => x.id === L.id);
        if (from < 0 || to < 0 || from === to) return;
        const [m] = D.layers.splice(from, 1);
        D.layers.splice(to, 0, m);
        commit();
        render();
        refreshPanel();
      });
      list.appendChild(row);
    }
    if (!layers.length) list.appendChild(h('p', { class: 'p-note' }, 'No layers yet.'));
    const L = selLayer();
    return [
      section('Layers', [
        h('p', { class: 'p-note' }, 'Top of the list is in front. Drag to reorder.'),
        list,
        h('div', { class: 'mbtns' }, [
          btn('Picture…', 'image', addPictureFromPicker),
          btn('Text', 'text', () => setTool('text')),
          btn('Drawing', 'brush', () => {
            addDrawLayer();
            commit();
            render();
            refreshPanel();
          }),
          L ? btn('Duplicate', 'copy', duplicate) : null,
          L ? btn('Merge down', 'down', mergeDown) : null,
          D.layers.length > 1 ? btn('Flatten', 'pages', flatten) : null,
          L ? btn('Delete', 'trash', deleteSel, 'danger') : null,
        ]),
      ]),
    ];
  }
  function duplicate() {
    const L = selLayer();
    if (!L) return;
    const c = JSON.parse(JSON.stringify(L));
    c.id = nid();
    c.name = (L.name || 'Layer') + ' copy';
    c.x += 20;
    c.y += 20;
    D.layers.splice(D.layers.indexOf(L) + 1, 0, c);
    D.sel = c.id;
    commit();
    render();
    refreshPanel();
  }
  function deleteSel() {
    const L = selLayer();
    if (!L) return;
    D.layers = D.layers.filter((x) => x !== L);
    D.sel = D.layers.length ? D.layers[D.layers.length - 1].id : null;
    commit();
    render();
    refreshPanel();
  }
  function arrange(d) {
    const L = selLayer();
    if (!L) return;
    const i = D.layers.indexOf(L),
      j = PE.clamp(i + d, 0, D.layers.length - 1);
    if (i === j) return;
    D.layers.splice(i, 1);
    D.layers.splice(j, 0, L);
    commit();
    render();
    refreshPanel();
  }
  /** draw layers into one picture layer the size of the canvas */
  function rasterize(layers) {
    const r = newRaster(D.w, D.h);
    const ctx = r.c.getContext('2d');
    for (const L of layers) if (!L.hidden) drawLayer(ctx, L);
    return r;
  }
  function mergeDown() {
    const L = selLayer();
    const i = D.layers.indexOf(L);
    if (i <= 0) return PE.toast('There is no layer below to merge into.', 'warn');
    const below = D.layers[i - 1];
    const r = rasterize([below, L]);
    const M = { id: nid(), type: 'image', name: below.name, x: D.w / 2, y: D.h / 2, w: D.w, h: D.h, rot: 0, op: 1, blend: 'source-over', raster: r.id, adj: {} };
    D.layers.splice(i - 1, 2, M);
    D.sel = M.id;
    commit();
    render();
    refreshPanel();
  }
  function flatten() {
    const r = rasterize(D.layers);
    D.layers = [{ id: nid(), type: 'image', name: 'Picture', x: D.w / 2, y: D.h / 2, w: D.w, h: D.h, rot: 0, op: 1, blend: 'source-over', raster: r.id, adj: {} }];
    D.sel = D.layers[0].id;
    commit();
    render();
    refreshPanel();
  }

  /* =========================================================
   *  dialogs: new, resize, canvas size, export
   * ========================================================= */
  const PRESETS = [
    ['Instagram post', 1080, 1080],
    ['Instagram portrait', 1080, 1350],
    ['Story / Reel', 1080, 1920],
    ['YouTube thumbnail', 1280, 720],
    ['Full HD', 1920, 1080],
    ['Facebook cover', 1640, 624],
    ['LinkedIn banner', 1584, 396],
    ['A4 (300 dpi)', 2480, 3508],
    ['Passport photo (35×45 mm)', 413, 531],
  ];
  I.newDialog = function () {
    return new Promise((res) => {
      const w = h('input', { class: 'field', type: 'number', value: 1080, min: 1, max: MAX_SIDE, 'aria-label': 'Width' });
      const hh = h('input', { class: 'field', type: 'number', value: 1080, min: 1, max: MAX_SIDE, 'aria-label': 'Height' });
      let bg = '#ffffff';
      const chips = h('div', { class: 'chips' });
      for (const [n, a, b] of PRESETS)
        chips.appendChild(
          h('button', {
            class: 'chip',
            type: 'button',
            onclick: () => {
              w.value = a;
              hh.value = b;
            },
          }, `${n} · ${a}×${b}`)
        );
      PE.ui.dialog({
        title: 'New image',
        wide: true,
        body: [chips, h('div', { class: 'p-grid2' }, [h('label', { class: 'fld' }, ['Width (px)', w]), h('label', { class: 'fld' }, ['Height (px)', hh])]), h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, 'Background'), PE.ui.controls.colors(bg, (c) => (bg = c), { none: true })])],
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Create', primary: true, onClick: () => ({ w: PE.clamp(+w.value || 1080, 1, MAX_SIDE), h: PE.clamp(+hh.value || 1080, 1, MAX_SIDE), bg }) },
        ],
        onClose: (v) => res(v),
      });
    });
  };
  function resizeDialog() {
    const w = h('input', { class: 'field', type: 'number', value: D.w, min: 1, max: MAX_SIDE, 'aria-label': 'Width' });
    const hh = h('input', { class: 'field', type: 'number', value: D.h, min: 1, max: MAX_SIDE, 'aria-label': 'Height' });
    const keep = h('input', { type: 'checkbox', checked: true });
    const ar = D.w / D.h;
    w.addEventListener('input', () => keep.checked && (hh.value = Math.round(+w.value / ar)));
    hh.addEventListener('input', () => keep.checked && (w.value = Math.round(+hh.value * ar)));
    const pct = h('div', { class: 'chips' }, [25, 50, 75, 150, 200].map((p) => h('button', { class: 'chip', type: 'button', onclick: () => ((w.value = Math.round((D.w * p) / 100)), (hh.value = Math.round((D.h * p) / 100))) }, p + '%')));
    PE.ui.dialog({
      title: 'Resize image',
      body: [pct, h('div', { class: 'p-grid2' }, [h('label', { class: 'fld' }, ['Width (px)', w]), h('label', { class: 'fld' }, ['Height (px)', hh])]), h('label', { class: 'chk' }, [keep, ' Keep proportions'])],
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Resize',
          primary: true,
          onClick: () => {
            const nw = PE.clamp(+w.value || D.w, 1, MAX_SIDE),
              nh = PE.clamp(+hh.value || D.h, 1, MAX_SIDE);
            const kx = nw / D.w,
              ky = nh / D.h;
            for (const L of D.layers) {
              L.x *= kx;
              L.y *= ky;
              L.w *= kx;
              L.h *= ky;
              if (L.type === 'text') L.size *= Math.min(kx, ky);
              if (L.sw && L.type === 'shape') L.sw *= Math.min(kx, ky);
            }
            D.w = nw;
            D.h = nh;
            commit();
            I.fit();
          },
        },
      ],
    });
  }
  function canvasDialog() {
    const w = h('input', { class: 'field', type: 'number', value: D.w, min: 1, max: MAX_SIDE, 'aria-label': 'Width' });
    const hh = h('input', { class: 'field', type: 'number', value: D.h, min: 1, max: MAX_SIDE, 'aria-label': 'Height' });
    let anchor = 'c';
    const grid = h('div', { class: 'anchor-grid' });
    for (const a of ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'])
      grid.appendChild(h('button', { type: 'button', class: a === 'c' ? 'on' : '', onclick: (e) => (grid.querySelectorAll('button').forEach((b) => b.classList.remove('on')), e.currentTarget.classList.add('on'), (anchor = a)) }));
    PE.ui.dialog({
      title: 'Canvas size',
      body: [h('p', { class: 'p-note' }, 'Adds or removes space around the picture without resizing it.'), h('div', { class: 'p-grid2' }, [h('label', { class: 'fld' }, ['Width (px)', w]), h('label', { class: 'fld' }, ['Height (px)', hh])]), h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, 'Anchor'), grid])],
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Apply',
          primary: true,
          onClick: () => {
            const nw = PE.clamp(+w.value || D.w, 1, MAX_SIDE),
              nh = PE.clamp(+hh.value || D.h, 1, MAX_SIDE);
            const dx = anchor.includes('l') ? 0 : anchor.includes('r') ? nw - D.w : (nw - D.w) / 2;
            const dy = anchor.includes('t') ? 0 : anchor.includes('b') ? nh - D.h : (nh - D.h) / 2;
            for (const L of D.layers) {
              L.x += dx;
              L.y += dy;
            }
            D.w = nw;
            D.h = nh;
            commit();
            I.fit();
          },
        },
      ],
    });
  }

  /** picture as file bytes */
  I.exportBytes = async function (fmt = 'png', q = 0.92, scale = 1) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(D.w * scale));
    c.height = Math.max(1, Math.round(D.h * scale));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    for (const L of D.layers) if (L.type === 'text') measureText(L);
    compose(ctx, scale, { bg: fmt === 'jpeg' || fmt === 'pdf' ? '#ffffff' : null });
    if (fmt === 'pdf') {
      const jpg = await PE.canvasToBytes(c, 'image/jpeg', q);
      const doc = await PDFLib.PDFDocument.create();
      const img = await doc.embedJpg(jpg);
      const pw = c.width * 0.75,
        ph = c.height * 0.75;
      const page = doc.addPage([pw, ph]);
      page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
      return { bytes: await doc.save(), mime: 'application/pdf', ext: 'pdf' };
    }
    const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
    const blob = await new Promise((r) => c.toBlob(r, mime, q));
    if (!blob) throw new Error('This browser can’t save ' + fmt.toUpperCase() + ' files.');
    if (fmt === 'webp' && blob.type !== 'image/webp') PE.toast('This browser can’t write WebP; saved as PNG instead.', 'warn');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, ext: blob.type.split('/')[1].replace('jpeg', 'jpg'), canvas: c };
  };
  I.exportDialog = function (fmt0) {
    let fmt = fmt0 || 'png',
      q = 0.92,
      scale = 1;
    const sizeOut = h('p', { class: 'p-note' });
    const upd = () => (sizeOut.textContent = `${Math.round(D.w * scale)} × ${Math.round(D.h * scale)} pixels`);
    upd();
    const qs = PE.slider('Quality', q, 0.3, 1, 0.01, (v) => (q = v));
    const formats = PE.ui.controls.seg(
      [
        { v: 'png', text: 'PNG' },
        { v: 'jpeg', text: 'JPG' },
        { v: 'webp', text: 'WebP' },
        { v: 'pdf', text: 'PDF' },
      ],
      fmt,
      (v) => {
        fmt = v;
        qs.style.display = v === 'png' ? 'none' : '';
      }
    );
    qs.style.display = fmt === 'png' ? 'none' : '';
    const sc = PE.ui.controls.seg(
      [0.25, 0.5, 1, 2].map((v) => ({ v, text: v * 100 + '%' })),
      1,
      (v) => {
        scale = v;
        upd();
      }
    );
    PE.ui.dialog({
      title: 'Download picture',
      body: [h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, 'Format'), formats]), qs, h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, 'Size'), sc]), sizeOut, h('p', { class: 'p-note' }, 'PNG keeps transparency. JPG is smallest for photos. PDF makes a one-page document.')],
      actions: [
        { label: 'Copy to clipboard', onClick: async () => {
            try {
              const r = await I.exportBytes('png', 1, scale);
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([r.bytes], { type: 'image/png' }) })]);
              PE.toast('Copied. Paste it into any app.', 'ok');
            } catch (e) {
              PE.toast('Copying pictures isn’t allowed here. Download instead.', 'warn');
            }
            return false;
          } },
        { label: 'Cancel', value: null },
        {
          label: 'Download',
          primary: true,
          onClick: async () => {
            PE.ui.busy(true, 'Saving picture', 0.5);
            try {
              const r = await I.exportBytes(fmt, q, scale);
              const name = PE.app.fileName.replace(/\.[^.]+$/, '') + '.' + r.ext;
              PE.download2(r.bytes, name, r.mime);
              PE.app.dirty = false;
              PE.ui.updateHistoryButtons();
              PE.toast('Downloaded ' + name, 'ok');
            } catch (e) {
              PE.toast(e.message || 'Could not save the picture.', 'error');
            } finally {
              PE.ui.busy(false);
            }
          },
        },
      ],
    });
  };
  I.downloadMenu = function (anchor) {
    PE.ui.menu(anchor, [
      { label: 'PNG (keeps transparency)', icon: 'image', onClick: () => I.exportDialog('png') },
      { label: 'JPG (smaller photos)', icon: 'image', onClick: () => I.exportDialog('jpeg') },
      { label: 'WebP', icon: 'image', onClick: () => I.exportDialog('webp') },
      { label: 'PDF', icon: 'file', onClick: () => I.exportDialog('pdf') },
      '-',
      { label: 'Open as PDF to edit further', icon: 'convert', onClick: () => toPdfEditor() },
    ]);
  };
  I.download = () => I.exportDialog('png');
  async function toPdfEditor() {
    const r = await I.exportBytes('png', 1, 1);
    const name = PE.app.fileName.replace(/\.[^.]+$/, '') + '.png';
    PE.app.dirty = false;
    PE.app.openFiles([new File([r.bytes], name, { type: 'image/png' })], { force: true, asPdf: true });
  }
  I.moreItems = function () {
    return [
      { label: 'New image…', icon: 'file-plus', onClick: () => PE.app.newImage() },
      { label: 'Add a picture as a layer…', icon: 'image', onClick: addPictureFromPicker },
      '-',
      { label: 'Resize image…', icon: 'fit', onClick: resizeDialog },
      { label: 'Canvas size…', icon: 'crop', onClick: canvasDialog },
      { label: 'Rotate right', icon: 'rotate-cw', onClick: () => rotateDoc(1) },
      { label: 'Rotate left', icon: 'rotate-ccw', onClick: () => rotateDoc(-1) },
      { label: 'Flip horizontally', icon: 'flip-h', onClick: () => flipDoc('h') },
      { label: 'Remove background', icon: 'magic', onClick: () => I.removeBackground() },
      { label: 'Flatten layers', icon: 'pages', disabled: !D || D.layers.length < 2, onClick: flatten },
    ];
  };

  I.shortcuts = (k) => [
    ['Move / Crop / Brush / Eraser', 'V / C / B / E'],
    ['Heal / Text / Shapes / Blur area', 'J / T / U / R'],
    ['Magic eraser / Fill / Colour picker / Pan', 'W / G / I / H'],
    ['Pan while held', 'Space'],
    ['Brush size smaller / bigger', '[ / ]'],
    ['Apply crop', 'Enter'],
    ['Nudge layer 1 px / 10 px', 'Arrows / Shift+Arrows'],
    ['Duplicate layer', `${k}D`],
    ['Delete layer', 'Delete'],
    ['Undo / Redo', `${k}Z / ${k}Shift+Z`],
    ['Zoom in / out / fit', `${k}+ / ${k}− / ${k}0`],
    ['Download', `${k}S`],
  ];

  /* =========================================================
   *  keyboard
   * ========================================================= */
  I.onKey = function (e) {
    const mod = PE.mod(e);
    const k = e.key.toLowerCase();
    const inField = e.target && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
    if (e.key === ' ' && !inField) {
      spaceDown = e.type === 'keydown';
      if (els) els.stage.classList.toggle('panning', spaceDown);
      e.preventDefault();
      return true;
    }
    if (e.type !== 'keydown') return false;
    if (mod && k === 'z') {
      if (inField) return false;
      e.preventDefault();
      e.shiftKey ? I.redo() : I.undo();
      return true;
    }
    if (mod && k === 'y') {
      if (inField) return false;
      e.preventDefault();
      I.redo();
      return true;
    }
    if (inField) return false;
    if (mod && k === 'd') {
      e.preventDefault();
      duplicate();
      return true;
    }
    if (mod && (k === '=' || k === '+')) {
      e.preventDefault();
      I.zoomIn();
      return true;
    }
    if (mod && k === '-') {
      e.preventDefault();
      I.zoomOut();
      return true;
    }
    if (mod && k === '0') {
      e.preventDefault();
      I.fit();
      return true;
    }
    if (mod) return false;
    if (k === 'enter' && tool === 'crop') {
      applyCrop();
      return true;
    }
    if (k === 'escape') {
      if (tool !== 'move') setTool('move');
      else {
        D.sel = null;
        drawUI();
        refreshPanel();
      }
      return true;
    }
    if ((k === 'delete' || k === 'backspace') && selLayer()) {
      e.preventDefault();
      deleteSel();
      return true;
    }
    if (k.startsWith('arrow') && selLayer()) {
      e.preventDefault();
      const L = selLayer();
      const s = e.shiftKey ? 10 : 1;
      if (k === 'arrowleft') L.x -= s;
      if (k === 'arrowright') L.x += s;
      if (k === 'arrowup') L.y -= s;
      if (k === 'arrowdown') L.y += s;
      render();
      commitSoon();
      return true;
    }
    if (k === '[' || k === ']') {
      const o = opts[tool] && opts[tool].size != null ? opts[tool] : null;
      if (o) {
        o.size = PE.clamp(Math.round(o.size * (k === ']' ? 1.2 : 0.83)), 1, 400);
        refreshPanel();
        return true;
      }
    }
    const t = TOOLS.find((x) => x[3].toLowerCase() === k);
    if (t) {
      setTool(t[0]);
      return true;
    }
    return false;
  };
  const commitSoon = PE.debounce(() => commit(), 400);
})();
