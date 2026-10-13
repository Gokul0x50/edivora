/* Pagewright — tools, selection, move/resize/rotate, text editing */
'use strict';
(function () {
  const V = PE.view;
  const T = (PE.tools = {
    tool: 'edit',
    sel: [], // [{pg, id, base}]
    editing: null, // {pg, id, kind:'obj'|'base'|'cell', el, r, c}
    clipboard: null,
  });
  T.defaults = Object.assign(
    {
      text: { f: 'arimo', s: 14, c: '#111111', b: false, i: false, u: false },
      pen: { stroke: '#1d3fcf', sw: 2, op: 1 },
      marker: { stroke: '#ffd400', sw: 14, op: 0.45 },
      shape: { stroke: '#1d3fcf', fill: null, sw: 2, op: 1 },
      line: { stroke: '#1d3fcf', sw: 2, op: 1 },
      highlight: { fill: '#ffe34d', op: 0.45 },
      whiteout: { fill: '#ffffff' },
      mark: { stroke: '#0a7a3b', sw: 2.5 },
    },
    PE.store.get('defaults', {})
  );
  T.saveDefaults = PE.debounce(() => PE.store.set('defaults', T.defaults), 400);

  /* ---------- tools ---------- */
  T.setTool = function (name) {
    if (T.editing) T.stopEditing();
    T.tool = name;
    document.body.setAttribute('data-tool', name);
    PE.$$('[data-tool-btn]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tool-btn') === name));
    if (name !== 'edit') T.clearSelection();
    PE.ui && PE.ui.refreshProps();
  };

  /* ---------- selection ---------- */
  T.clearSelection = function (silent) {
    T.sel = [];
    T.redrawSelection();
    if (!silent) PE.ui && PE.ui.refreshProps();
  };
  T.select = function (items, add) {
    if (add) {
      for (const it of items)
        if (!T.sel.some((s) => s.id === it.id && s.pg === it.pg) && (!T.sel.length || T.sel[0].pg === it.pg) && !it.base)
          T.sel.push(it);
    } else T.sel = items;
    T.redrawSelection();
    PE.ui && PE.ui.refreshProps();
  };
  T.selObjs = function () {
    return T.sel
      .map((s) => {
        const pg = PE.findPage(s.pg);
        if (!pg) return null;
        if (s.base) {
          const ex = PE.ex[PE.pageKey(pg)];
          const im = ex && ex.images.find((x) => x.id === s.id);
          return im ? { pg, base: true, im, id: s.id } : null;
        }
        const o = PE.findObj(pg, s.id);
        return o ? { pg, o, id: s.id } : null;
      })
      .filter(Boolean);
  };

  function baseImgGeom(pg, im) {
    const ov = pg.ov[im.id];
    const pv = V.els.get(pg.id);
    const sh = !(ov && ov.pinned) && pv && pv.shift ? pv.shift[im.id] || 0 : 0;
    const g = Object.assign({ x: im.x, y: im.y, w: im.w, h: im.h, rot: im.rot, flipX: false, flipY: im.flipY }, ov || {});
    g.y += sh;
    return g;
  }
  /** make (or get) the editable override of a PDF image */
  T.baseImgOv = function (pg, im) {
    if (!pg.ov[im.id]) {
      // freeze where it is shown now (including any push from text above); from here on the user places it
      const pv = V.els.get(pg.id);
      const sh = (pv && pv.shift && pv.shift[im.id]) || 0;
      pg.ov[im.id] = { x: im.x, y: im.y + sh, w: im.w, h: im.h, rot: im.rot, flipX: false, flipY: im.flipY, pinned: true };
      V.ensureBaseImageAsset(pg, im).then((a) => {
        if (pg.ov[im.id] && !pg.ov[im.id].a) pg.ov[im.id].a = a;
        V.layoutBase(pg);
      });
    }
    return pg.ov[im.id];
  };

  /** box of a selection item in base-frame points */
  function itemBox(it) {
    if (it.base) {
      const g = baseImgGeom(it.pg, it.im);
      return { x: g.x, y: g.y, w: g.w, h: g.h, rot: g.rot || 0 };
    }
    const o = it.o;
    if (o.type === 'text' || o.type === 'table') {
      const el = V.objEl(it.pg, o.id);
      if (el) {
        o.w = el.offsetWidth;
        o.h = el.offsetHeight;
      }
    }
    return { x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot || 0 };
  }

  T.redrawSelection = function () {
    PE.$$('.selbox, .marquee-keep').forEach((e) => e.remove());
    if (T.editing && T.editing.kind === 'base') return drawEditFrame();
    const items = T.selObjs();
    if (!items.length) return;
    const pg = items[0].pg;
    const pv = V.els.get(pg.id);
    if (!pv) return;
    if (items.length === 1) {
      const it = items[0];
      const b = itemBox(it);
      const box = PE.h('div', { class: 'selbox' + (T.editing ? ' editing' : '') });
      place(box, b);
      const o = it.o;
      if (o && o.type === 'line') {
        box.classList.add('line');
        box.style.transform = '';
        const p = V.linePoints(o);
        box.appendChild(handle('p1', p.x1, p.y1));
        box.appendChild(handle('p2', p.x2, p.y2));
      } else if (!T.editing || (o && o.type !== 'table')) {
        const widthOnly = o && (o.type === 'text' || o.type === 'table');
        const hs = widthOnly ? ['w', 'e'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
        for (const k of hs) box.appendChild(PE.h('div', { class: 'hd hd-' + k, 'data-h': k }));
        if (!(o && o.type === 'table')) box.appendChild(PE.h('div', { class: 'hd hd-rot', 'data-h': 'rot', title: 'Rotate' }));
      }
      pv.ui.appendChild(box);
    } else {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const it of items) {
        const b = itemBox(it);
        x0 = Math.min(x0, b.x);
        y0 = Math.min(y0, b.y);
        x1 = Math.max(x1, b.x + b.w);
        y1 = Math.max(y1, b.y + b.h);
      }
      const box = PE.h('div', { class: 'selbox multi' });
      place(box, { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rot: 0 });
      pv.ui.appendChild(box);
    }
  };
  function place(el, b) {
    el.style.left = b.x + 'px';
    el.style.top = b.y + 'px';
    el.style.width = Math.max(1, b.w) + 'px';
    el.style.height = Math.max(1, b.h) + 'px';
    el.style.transform = b.rot ? `rotate(${b.rot}deg)` : '';
  }
  function handle(k, x, y) {
    return PE.h('div', { class: 'hd hd-pt', 'data-h': k, style: { left: x + 'px', top: y + 'px' } });
  }
  function drawEditFrame() {
    const ed = T.editing;
    const pg = PE.findPage(ed.pg);
    const pv = pg && V.els.get(pg.id);
    if (!pv) return;
    const el = ed.el;
    const box = PE.h('div', { class: 'selbox editing base' });
    place(box, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, rot: 0 });
    box.appendChild(PE.h('div', { class: 'hd hd-w', 'data-h': 'w' }));
    box.appendChild(PE.h('div', { class: 'hd hd-e', 'data-h': 'e' }));
    box.appendChild(
      PE.h('div', { class: 'grip', 'data-h': 'move', title: 'Drag to move this text', html: PE.icon('move') })
    );
    pv.ui.appendChild(box);
  }

  /* ---------- pointer handling ---------- */
  let drag = null;
  const touches = new Map();
  let pinch = null;

  T.init = function () {
    const host = V.host;
    host.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    host.addEventListener('dblclick', onDbl);
    V.scroller.addEventListener('pointerdown', (e) => {
      // composedPath is fixed at dispatch time, so it still works if a handler re-rendered the target
      const inPage = e.composedPath().some((n) => n.classList && n.classList.contains('page'));
      if (!inPage && !e.target.closest('#find-bar')) {
        if (T.editing) T.stopEditing();
        if (T.sel.length) T.clearSelection();
      }
    });
    // pinch to zoom (touch)
    V.scroller.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          const [a, b] = e.touches;
          pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: V.zoom };
          if (drag) cancelDrag();
        }
      },
      { passive: true }
    );
    V.scroller.addEventListener(
      'touchmove',
      (e) => {
        if (pinch && e.touches.length === 2) {
          e.preventDefault();
          const [a, b] = e.touches;
          const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
          const r = V.scroller.getBoundingClientRect();
          V.setZoom(pinch.z * (d / pinch.d), { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top });
        }
      },
      { passive: false }
    );
    V.scroller.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) pinch = null;
    });
    V.scroller.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const r = V.scroller.getBoundingClientRect();
          V.setZoom(V.zoom * Math.exp(-e.deltaY * 0.0022), { x: e.clientX - r.left, y: e.clientY - r.top });
        }
      },
      { passive: false }
    );
    document.addEventListener('selectionchange', () => {
      if (T.editing) PE.ui && PE.ui.refreshPropsSoon();
    });
  };

  function pageFromEvent(e) {
    const root = e.target.closest && e.target.closest('.page');
    if (!root) return null;
    return PE.findPage(root.getAttribute('data-pid'));
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    if (pinch) return;
    const pg = pageFromEvent(e);
    if (!pg) return;
    const p = V.clientToBase(pg, e.clientX, e.clientY);
    const hd = e.target.closest('[data-h]');
    if (hd && !e.target.closest('.l-objs')) {
      e.preventDefault();
      return startHandle(e, pg, hd.getAttribute('data-h'), p);
    }
    const tool = T.tool;
    if (tool === 'edit') return downEdit(e, pg, p);
    if (tool === 'text') {
      e.preventDefault();
      return createText(pg, p);
    }
    if (tool === 'pen' || tool === 'marker') {
      e.preventDefault();
      return startInk(e, pg, p);
    }
    if (['rect', 'ellipse', 'highlight', 'whiteout', 'redact', 'tablegrab'].includes(tool)) {
      e.preventDefault();
      return startBox(e, pg, p);
    }
    if (tool === 'line' || tool === 'arrow') {
      e.preventDefault();
      return startLine(e, pg, p);
    }
    if (tool === 'check' || tool === 'cross') {
      e.preventDefault();
      const s = 16;
      const o = {
        id: PE.uid('o'),
        type: 'shape',
        shape: tool,
        x: p.x - s / 2,
        y: p.y - s / 2,
        w: s,
        h: s,
        rot: 0,
        stroke: T.defaults.mark.stroke,
        sw: T.defaults.mark.sw,
        fill: null,
      };
      addObj(pg, o);
      return;
    }
  }

  function downEdit(e, pg, p) {
    const ed = T.editing;
    if (ed && ed.el && ed.el.contains(e.target)) return; // caret / text selection inside the editor
    const objEl = e.target.closest('.l-objs .ob');
    const baseEl = e.target.closest('.l-base [data-bid]');
    if (ed) T.stopEditing();
    if (objEl) {
      const id = objEl.getAttribute('data-oid');
      const o = PE.findObj(pg, id);
      if (!o) return;
      const already = T.sel.length === 1 && T.sel[0].id === id && T.sel[0].pg === pg.id;
      if (e.shiftKey) T.select([{ pg: pg.id, id }], true);
      else if (!T.sel.some((s) => s.id === id && s.pg === pg.id)) T.select([{ pg: pg.id, id }]);
      e.preventDefault();
      startMove(e, pg, p, { clickToEdit: already && (o.type === 'text' || o.type === 'table') ? o : null });
      return;
    }
    if (baseEl) {
      const bid = baseEl.getAttribute('data-bid');
      const ex = PE.ex[PE.pageKey(pg)];
      if (bid[0] === 'b') {
        e.preventDefault();
        const b = ex.blocks.find((x) => x.id === bid);
        T.clearSelection(true);
        T.startEditBase(pg, b, { x: e.clientX, y: e.clientY });
        return;
      }
      if (bid[0] === 'i') {
        e.preventDefault();
        T.select([{ pg: pg.id, id: bid, base: true }]);
        startMove(e, pg, p, {});
        return;
      }
    }
    // empty area
    if (!e.shiftKey) T.clearSelection();
    if (e.pointerType !== 'touch') {
      e.preventDefault();
      startMarquee(e, pg, p, false);
    }
  }

  function onDbl(e) {
    const pg = pageFromEvent(e);
    if (!pg || T.tool !== 'edit') return;
    const objEl = e.target.closest('.l-objs .ob');
    if (!objEl) return;
    const o = PE.findObj(pg, objEl.getAttribute('data-oid'));
    if (o && (o.type === 'text' || o.type === 'table') && !T.editing) T.startEditObj(pg, o, { x: e.clientX, y: e.clientY });
  }

  function startMove(e, pg, p, opts) {
    const items = T.selObjs();
    drag = {
      kind: 'move',
      pg,
      start: p,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      opts,
      orig: items.map((it) => (it.base ? { it, g: baseImgGeom(pg, it.im) } : { it, o: PE.clone(it.o) })),
      pid: e.pointerId,
    };
  }

  function startHandle(e, pg, h, p) {
    if (h === 'move' && T.editing && T.editing.kind === 'base') {
      const ov = pg.ov[T.editing.id];
      drag = { kind: 'bmove', pg, sx: e.clientX, sy: e.clientY, dx0: ov.dx || 0, dy0: ov.dy || 0, ov, pid: e.pointerId };
      return;
    }
    if ((h === 'w' || h === 'e') && T.editing && T.editing.kind === 'base') {
      const ov = pg.ov[T.editing.id];
      const el = T.editing.el;
      drag = { kind: 'bwidth', pg, h, sx: e.clientX, sy: e.clientY, w0: el.offsetWidth, dx0: ov.dx || 0, ov, pid: e.pointerId };
      return;
    }
    const items = T.selObjs();
    if (items.length !== 1) return;
    const it = items[0];
    const b = itemBox(it);
    drag = {
      kind: h === 'rot' ? 'rotate' : h === 'p1' || h === 'p2' ? 'endpoint' : 'resize',
      h,
      pg,
      it,
      b0: b,
      start: p,
      sx: e.clientX,
      sy: e.clientY,
      o0: it.o ? PE.clone(it.o) : null,
      pid: e.pointerId,
    };
  }

  function onMove(e) {
    if (!drag || (drag.pid != null && e.pointerId !== drag.pid)) return;
    const pg = drag.pg;
    const [dx, dy] = V.deltaToBase(pg, e.clientX - drag.sx, e.clientY - drag.sy);
    if (drag.kind === 'move') {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      drag.moved = true;
      for (const r of drag.orig) {
        if (r.it.base) {
          const ov = T.baseImgOv(pg, r.it.im);
          ov.x = r.g.x + dx;
          ov.y = r.g.y + dy;
        } else {
          const o = r.it.o;
          o.x = r.o.x + dx;
          o.y = r.o.y + dy;
          if (o.type === 'line') {
            o.x1 = r.o.x1 + dx;
            o.y1 = r.o.y1 + dy;
            o.x2 = r.o.x2 + dx;
            o.y2 = r.o.y2 + dy;
          }
          if (o.type === 'text' && o.autoW) o.maxW = PE.baseSize(pg).W - o.x - 6;
          V.updateObj(pg, o);
        }
      }
      if (drag.orig.some((r) => r.it.base)) V.layoutBase(pg);
      T.redrawSelection();
    } else if (drag.kind === 'resize') resizeMove(e, dx, dy);
    else if (drag.kind === 'rotate') {
      const p = V.clientToBase(pg, e.clientX, e.clientY);
      const b = drag.b0;
      const cx = b.x + b.w / 2,
        cy = b.y + b.h / 2;
      let a = (Math.atan2(p[1] - cy, p[0] - cx) * 180) / Math.PI + 90;
      a = ((a % 360) + 360) % 360;
      const snap = e.shiftKey ? 15 : 0;
      if (snap) a = Math.round(a / snap) * snap;
      else for (const t of [0, 90, 180, 270, 360]) if (Math.abs(a - t) < 4) a = t % 360;
      if (a > 180) a -= 360;
      setGeom(drag.it, { rot: a });
    } else if (drag.kind === 'endpoint') {
      const p = V.clientToBase(pg, e.clientX, e.clientY);
      const o = drag.it.o;
      if (drag.h === 'p1') {
        o.x1 = p[0];
        o.y1 = p[1];
      } else {
        o.x2 = p[0];
        o.y2 = p[1];
      }
      lineBox(o);
      V.updateObj(pg, o, true);
      T.redrawSelection();
    } else if (drag.kind === 'bmove') {
      drag.ov.dx = drag.dx0 + dx;
      drag.ov.dy = drag.dy0 + dy;
      V.layoutBase(pg);
      T.redrawSelection();
    } else if (drag.kind === 'bwidth') {
      const ov = drag.ov;
      ov.auto = false;
      if (drag.h === 'e') ov.w = Math.max(20, drag.w0 + dx);
      else {
        ov.w = Math.max(20, drag.w0 - dx);
        ov.dx = drag.dx0 + (drag.w0 - ov.w);
      }
      V.layoutBase(pg);
      T.redrawSelection();
    } else if (drag.kind === 'box' || drag.kind === 'marquee') {
      const p = V.clientToBase(pg, e.clientX, e.clientY);
      drag.cur = p;
      const r = normRect(drag.start, p);
      if (drag.preview) place(drag.preview, Object.assign(r, { rot: 0 }));
    } else if (drag.kind === 'ink') {
      const p = V.clientToBase(pg, e.clientX, e.clientY);
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.6 / V.zoom) return;
      drag.pts.push([p[0], p[1]]);
      drag.path.setAttribute('d', V.inkPath(drag.pts));
    } else if (drag.kind === 'line') {
      const p = V.clientToBase(pg, e.clientX, e.clientY);
      const o = drag.o;
      o.x2 = p[0];
      o.y2 = p[1];
      if (e.shiftKey) {
        const a = Math.round(Math.atan2(o.y2 - o.y1, o.x2 - o.x1) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
        o.x2 = o.x1 + len * Math.cos(a);
        o.y2 = o.y1 + len * Math.sin(a);
      }
      lineBox(o);
      V.updateObj(pg, o, true);
    }
  }

  function resizeMove(e, dx, dy) {
    const { it, h, b0, pg } = drag;
    const r = b0.rot || 0;
    const [lx, ly] = PE.rotVec(dx, dy, -r);
    const hx = h.includes('e') ? 1 : h.includes('w') ? -1 : 0;
    const hy = h.includes('s') ? 1 : h.includes('n') ? -1 : 0;
    let nw = b0.w + hx * lx,
      nh = b0.h + hy * ly;
    const o = it.o;
    const widthOnly = o && (o.type === 'text' || o.type === 'table');
    const keepAspect = (it.base || (o && (o.type === 'image' || o.type === 'ink'))) ? !e.shiftKey && hx && hy : e.shiftKey && hx && hy;
    if (keepAspect) {
      const s = Math.max(nw / b0.w, nh / b0.h);
      nw = b0.w * s;
      nh = b0.h * s;
    }
    nw = Math.max(widthOnly ? 24 : 4, nw);
    nh = Math.max(4, nh);
    if (widthOnly) nh = b0.h;
    const [cx, cy] = PE.rotVec((hx * (nw - b0.w)) / 2, (hy * (nh - b0.h)) / 2, r);
    const ccx = b0.x + b0.w / 2 + cx,
      ccy = b0.y + b0.h / 2 + cy;
    const g = { x: ccx - nw / 2, y: ccy - nh / 2, w: nw, h: nh };
    if (o && o.type === 'text') o.autoW = false;
    if (o && o.type === 'table') {
      const k = nw / drag.o0.w;
      o.cw = drag.o0.cw.map((w) => w * k);
    }
    setGeom(it, g);
  }

  function setGeom(it, g) {
    const pg = drag ? drag.pg : PE.findPage(it.pg.id);
    if (it.base) {
      const ov = T.baseImgOv(pg, it.im);
      Object.assign(ov, g);
      V.layoutBase(pg);
    } else {
      Object.assign(it.o, g);
      V.updateObj(pg, it.o, it.o.type === 'shape' || it.o.type === 'ink' || it.o.type === 'table');
    }
    T.redrawSelection();
  }

  function onUp(e) {
    if (!drag || (drag.pid != null && e.pointerId !== drag.pid)) return;
    const d = drag;
    drag = null;
    const pg = d.pg;
    if (d.kind === 'move') {
      if (d.moved) PE.commit();
      else if (d.opts && d.opts.clickToEdit) T.startEditObj(pg, d.opts.clickToEdit, { x: e.clientX, y: e.clientY });
      PE.ui.refreshProps();
    } else if (d.kind === 'box') finishBox(d, pg);
    else if (d.kind === 'marquee') finishMarquee(d, pg);
    else if (d.kind === 'ink') finishInk(d, pg);
    else if (d.kind === 'line') {
      const o = d.o;
      if (Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 4) {
        o.x2 = o.x1 + 100;
        o.y2 = o.y1;
        lineBox(o);
        V.updateObj(pg, o, true);
      }
      PE.commit();
      T.setTool('edit');
      T.select([{ pg: pg.id, id: o.id }]);
    } else if (d.kind === 'bmove' || d.kind === 'bwidth') {
      PE.commit();
      if (T.editing) T.editing.el.focus();
    } else PE.commit();
    PE.ui.refreshProps();
  }
  function cancelDrag() {
    if (drag && drag.preview) drag.preview.remove();
    drag = null;
  }

  /* ---------- creation ---------- */
  function addObj(pg, o, select = true) {
    pg.objs.push(o);
    const pv = V.els.get(pg.id);
    pv.objs.appendChild(V.renderObj(o));
    PE.commit();
    if (select) {
      T.setTool('edit');
      T.select([{ pg: pg.id, id: o.id }]);
    }
    return o;
  }
  T.addObj = addObj;

  function normRect(a, b) {
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  }

  function startBox(e, pg, p) {
    const pv = V.els.get(pg.id);
    const preview = PE.h('div', { class: 'draft draft-' + T.tool });
    pv.ui.appendChild(preview);
    drag = { kind: 'box', tool: T.tool, pg, start: p, cur: p, preview, pid: e.pointerId, sx: e.clientX, sy: e.clientY };
    place(preview, { x: p[0], y: p[1], w: 0, h: 0 });
  }
  function finishBox(d, pg) {
    d.preview.remove();
    let r = normRect(d.start, d.cur);
    const small = r.w < 4 && r.h < 4;
    if (d.tool === 'tablegrab') {
      if (small) return PE.toast('Drag a rectangle around the table you want to edit.');
      return T.convertTable(pg, r);
    }
    if (small) {
      const def = d.tool === 'highlight' ? [120, 16] : d.tool === 'redact' || d.tool === 'whiteout' ? [120, 20] : [120, 80];
      r = { x: d.start[0] - (d.tool === 'highlight' ? 0 : def[0] / 2), y: d.start[1] - def[1] / 2, w: def[0], h: def[1] };
    }
    const D = T.defaults;
    let o = { id: PE.uid('o'), type: 'shape', shape: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, rot: 0 };
    if (d.tool === 'rect' || d.tool === 'ellipse')
      Object.assign(o, { shape: d.tool, stroke: D.shape.stroke, fill: D.shape.fill, sw: D.shape.sw, op: D.shape.op });
    else if (d.tool === 'highlight') Object.assign(o, { fill: D.highlight.fill, stroke: null, sw: 0, op: D.highlight.op, blend: 'multiply' });
    else if (d.tool === 'whiteout') Object.assign(o, { fill: D.whiteout.fill, stroke: null, sw: 0 });
    else if (d.tool === 'redact') Object.assign(o, { fill: '#000000', stroke: null, sw: 0, redact: true });
    const keep = d.tool === 'highlight' || d.tool === 'whiteout' || d.tool === 'redact';
    pg.objs.push(o);
    V.els.get(pg.id).objs.appendChild(V.renderObj(o));
    PE.commit();
    if (!keep) T.setTool('edit');
    T.select([{ pg: pg.id, id: o.id }]);
  }

  function startMarquee(e, pg, p) {
    const pv = V.els.get(pg.id);
    const preview = PE.h('div', { class: 'draft marquee' });
    pv.ui.appendChild(preview);
    drag = { kind: 'marquee', pg, start: p, cur: p, preview, pid: e.pointerId, add: e.shiftKey };
    place(preview, { x: p[0], y: p[1], w: 0, h: 0 });
  }
  function finishMarquee(d, pg) {
    d.preview.remove();
    const r = normRect(d.start, d.cur);
    if (r.w < 3 && r.h < 3) return;
    const hit = pg.objs.filter((o) => {
      const b = itemBox({ pg, o });
      return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
    });
    T.select(
      hit.map((o) => ({ pg: pg.id, id: o.id })),
      d.add
    );
  }

  function startInk(e, pg, p) {
    const pv = V.els.get(pg.id);
    const D = T.tool === 'marker' ? T.defaults.marker : T.defaults.pen;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ink-draft');
    const { W, H } = PE.baseSize(pg);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', D.stroke);
    path.setAttribute('stroke-width', D.sw);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('opacity', D.op);
    svg.appendChild(path);
    pv.ui.appendChild(svg);
    drag = { kind: 'ink', pg, pts: [[p[0], p[1]]], svg, path, D, marker: T.tool === 'marker', pid: e.pointerId };
    path.setAttribute('d', V.inkPath(drag.pts));
  }
  function finishInk(d, pg) {
    d.svg.remove();
    const pts = d.pts;
    const sw = d.D.sw;
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs) - sw,
      y0 = Math.min(...ys) - sw;
    const w = Math.max(...xs) + sw - x0,
      h = Math.max(...ys) + sw - y0;
    const o = {
      id: PE.uid('o'),
      type: 'ink',
      x: x0,
      y: y0,
      w,
      h,
      w0: w,
      h0: h,
      rot: 0,
      strokes: [simplify(pts.map((p) => [p[0] - x0, p[1] - y0]), 0.35)],
      stroke: d.D.stroke,
      sw,
      op: d.D.op,
      blend: d.marker ? 'multiply' : undefined,
    };
    pg.objs.push(o);
    V.els.get(pg.id).objs.appendChild(V.renderObj(o));
    PE.commit();
  }
  function simplify(pts, tol) {
    if (pts.length < 3) return pts.map((p) => [PE.round(p[0]), PE.round(p[1])]);
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const l = out[out.length - 1];
      if (Math.hypot(pts[i][0] - l[0], pts[i][1] - l[1]) >= tol) out.push(pts[i]);
    }
    out.push(pts[pts.length - 1]);
    return out.map((p) => [PE.round(p[0]), PE.round(p[1])]);
  }

  function lineBox(o) {
    o.x = Math.min(o.x1, o.x2);
    o.y = Math.min(o.y1, o.y2);
    o.w = Math.max(1, Math.abs(o.x2 - o.x1));
    o.h = Math.max(1, Math.abs(o.y2 - o.y1));
  }
  function startLine(e, pg, p) {
    const D = T.defaults.line;
    const o = {
      id: PE.uid('o'),
      type: 'line',
      x1: p[0],
      y1: p[1],
      x2: p[0],
      y2: p[1],
      stroke: D.stroke,
      sw: D.sw,
      op: D.op,
      arrow: T.tool === 'arrow',
      rot: 0,
    };
    lineBox(o);
    pg.objs.push(o);
    V.els.get(pg.id).objs.appendChild(V.renderObj(o));
    drag = { kind: 'line', pg, o, pid: e.pointerId };
  }

  function createText(pg, p, text) {
    const D = T.defaults.text;
    const { W } = PE.baseSize(pg);
    const m = PE.fonts.metrics(D.f, D.b, D.i);
    const o = {
      id: PE.uid('o'),
      type: 'text',
      x: p[0],
      y: p[1] - (m.asc * D.s + ((1.2 - m.asc - m.desc) * D.s) / 2) + D.s * 0.2,
      w: 10,
      h: D.s * 1.2,
      rot: 0,
      autoW: true,
      maxW: W - p[0] - 6,
      align: 'left',
      lh: 1.2,
      runs: [{ t: text || '', f: D.f, b: D.b, i: D.i, u: D.u, s: D.s, c: D.c }],
    };
    pg.objs.push(o);
    V.els.get(pg.id).objs.appendChild(V.renderObj(o));
    T.setTool('edit');
    T.select([{ pg: pg.id, id: o.id }]);
    T.startEditObj(pg, o, null, true);
    return o;
  }
  T.createText = createText;

  /* ---------- text editing ---------- */
  function attachEditor(el) {
    el.contentEditable = 'true';
    el.spellcheck = true;
    el.addEventListener('keydown', edKey);
    el.addEventListener('input', edInput);
    el.addEventListener('paste', edPaste);
    el.addEventListener('drop', (e) => e.preventDefault());
  }
  function detachEditor(el) {
    el.contentEditable = 'false';
    el.removeEventListener('keydown', edKey);
    el.removeEventListener('input', edInput);
    el.removeEventListener('paste', edPaste);
  }
  function edKey(e) {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (T.editing && T.editing.kind === 'cell' && (e.ctrlKey || e.metaKey)) return T.stopEditing();
      insertBreak();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const ed = T.editing;
      T.stopEditing();
      if (ed && ed.kind === 'obj') T.select([{ pg: ed.pg, id: ed.id }]);
    } else if (e.key === 'Tab' && T.editing && T.editing.kind === 'cell') {
      e.preventDefault();
      moveCell(e.shiftKey ? -1 : 1);
    } else if (PE.mod(e) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      const k = e.key.toLowerCase();
      const cur = T.currentTextStyle();
      T.applyTextStyle({ [k]: !(cur && cur[k]) });
    } else if (PE.mod(e) && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      T.stopEditing();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) PE.redo();
      else PE.undo();
    }
  }
  function insertBreak() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    // execCommand keeps the native undo stack and works in Chrome, Safari and Firefox
    if (!document.execCommand('insertLineBreak')) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      const br = document.createElement('br');
      r.insertNode(br);
      r.setStartAfter(br);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    edInput();
  }
  function edPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((ln, k) => {
      if (k > 0) document.execCommand('insertLineBreak');
      if (ln) document.execCommand('insertText', false, ln);
    });
    edInput();
  }

  function edInput() {
    const ed = T.editing;
    if (!ed) return;
    const pg = PE.findPage(ed.pg);
    if (!pg) return;
    // normalise structure the browser may have added (divs, font tags)
    if (ed.el.querySelector('div,p,font,b,i,strong,em')) {
      const off = T.selOffsets();
      const runs = V.readRuns(ed.el, ed.styleFallback);
      V.fillRuns(ed.el, runs);
      if (off) T.setSelOffsets(off[0], off[1]);
    }
    const runs = V.readRuns(ed.el, ed.styleFallback);
    if (runs.length) ed.styleFallback = Object.assign({}, runs[runs.length - 1], { t: undefined });
    if (ed.kind === 'obj') {
      const o = PE.findObj(pg, ed.id);
      o.runs = runs.length ? runs : [Object.assign({}, ed.styleFallback, { t: '' })];
    } else if (ed.kind === 'base') {
      pg.ov[ed.id].runs = runs;
      V.layoutBase(pg);
    } else if (ed.kind === 'cell') {
      const o = PE.findObj(pg, ed.id);
      o.rows[ed.r][ed.c].t = runs.map((r) => r.t).join('');
    }
    T.redrawSelection();
    PE.commitSoon();
  }

  T.startEditObj = function (pg, o, pt, isNew) {
    if (T.editing) T.stopEditing();
    const el = V.objEl(pg, o.id);
    if (!el) return;
    if (o.type === 'table') return startEditCell(pg, o, el, pt);
    const t = el.firstChild;
    T.editing = { pg: pg.id, id: o.id, kind: 'obj', el: t, styleFallback: Object.assign({}, o.runs[0], { t: undefined }) };
    el.classList.add('is-editing');
    attachEditor(t);
    t.focus({ preventScroll: true });
    placeCaret(t, pt);
    T.select([{ pg: pg.id, id: o.id }]);
    if (isNew) T.editing.isNew = true;
  };

  T.startEditBase = async function (pg, b, pt) {
    if (T.editing) T.stopEditing();
    const ex = PE.ex[PE.pageKey(pg)];
    const loaded = b.runs.every((r) => PE.fonts.isLoaded(r.f, r.b, r.i));
    if (!loaded) await PE.fonts.ensureRuns(b.runs);
    if (!pg.ov[b.id]) {
      const def = V.blockDefaults(ex, b);
      pg.ov[b.id] = { runs: PE.clone(b.runs), align: def.align, lh: def.lh, w: def.w, auto: def.auto, h0: def.h0, dx: 0, dy: 0 };
    } else if (pg.ov[b.id].del) {
      delete pg.ov[b.id].del;
      if (!pg.ov[b.id].runs) Object.assign(pg.ov[b.id], { runs: PE.clone(b.runs) });
    }
    V.layoutBase(pg);
    const pv = V.els.get(pg.id);
    const el = pv.baseEls[b.id];
    pv.editingEl = el;
    el.classList.add('editing');
    T.editing = { pg: pg.id, id: b.id, kind: 'base', el, styleFallback: Object.assign({}, b.runs[0], { t: undefined }) };
    attachEditor(el);
    el.focus({ preventScroll: true });
    placeCaret(el, pt);
    T.redrawSelection();
    PE.ui.refreshProps();
  };

  function startEditCell(pg, o, el, pt) {
    let td = null;
    if (pt) {
      const hit = document.elementFromPoint(pt.x, pt.y);
      td = hit && hit.closest && hit.closest('td');
      if (td && !el.contains(td)) td = null;
    }
    td = td || el.querySelector('td');
    editCellTd(pg, o, td, pt);
  }
  function editCellTd(pg, o, td, pt) {
    const div = td.querySelector('.cell');
    const r = +td.getAttribute('data-r'),
      c = +td.getAttribute('data-c');
    const el = V.objEl(pg, o.id);
    el.classList.add('is-editing');
    PE.$$('td.cur', el).forEach((x) => x.classList.remove('cur'));
    td.classList.add('cur');
    T.editing = {
      pg: pg.id,
      id: o.id,
      kind: 'cell',
      el: div,
      r,
      c,
      styleFallback: { f: o.f || 'arimo', b: !!(o.head && r === 0), i: false, u: false, s: o.size || 11, c: o.color || '#000' },
    };
    attachEditor(div);
    div.focus({ preventScroll: true });
    placeCaret(div, pt);
    T.select([{ pg: pg.id, id: o.id }]);
  }
  function moveCell(dir) {
    const ed = T.editing;
    const pg = PE.findPage(ed.pg);
    const o = PE.findObj(pg, ed.id);
    const cols = o.rows[0].length;
    let idx = ed.r * cols + ed.c + dir;
    if (idx >= o.rows.length * cols) {
      T.stopEditing();
      T.tableOp('rowBelow', o.rows.length - 1);
      idx = (o.rows.length - 1) * cols;
    } else T.stopEditing(true);
    idx = PE.clamp(idx, 0, o.rows.length * cols - 1);
    const el = V.objEl(pg, o.id);
    const td = el.querySelector(`td[data-r="${Math.floor(idx / cols)}"][data-c="${idx % cols}"]`);
    if (td) editCellTd(pg, o, td, null);
  }
  T.editCell = (pg, o, r, c) => {
    const el = V.objEl(pg, o.id);
    const td = el && el.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (td) editCellTd(pg, o, td, null);
  };

  function placeCaret(el, pt) {
    const sel = window.getSelection();
    let r = null;
    if (pt) {
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(pt.x, pt.y);
        if (p && el.contains(p.offsetNode)) {
          r = document.createRange();
          r.setStart(p.offsetNode, p.offset);
        }
      } else if (document.caretRangeFromPoint) {
        const rr = document.caretRangeFromPoint(pt.x, pt.y);
        if (rr && el.contains(rr.startContainer)) r = rr;
      }
    }
    if (!r) {
      r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      // keep the caret before a trailing placeholder <br>
      if (el.lastChild && el.lastChild.nodeName === 'BR' && el.childNodes.length > 1) {
        r.setStartBefore(el.lastChild);
        r.collapse(true);
      }
    }
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  T.stopEditing = function (keepSelection) {
    const ed = T.editing;
    if (!ed) return;
    T.editing = null;
    detachEditor(ed.el);
    ed.el.classList.remove('editing');
    const pg = PE.findPage(ed.pg);
    if (!pg) return;
    const pv = V.els.get(pg.id);
    if (pv) pv.editingEl = null;
    window.getSelection().removeAllRanges();
    if (ed.kind === 'obj') {
      const o = PE.findObj(pg, ed.id);
      const el = V.objEl(pg, ed.id);
      el && el.classList.remove('is-editing');
      if (o) {
        o.runs = V.readRuns(ed.el, ed.styleFallback);
        if (!o.runs.map((r) => r.t).join('').trim()) {
          pg.objs = pg.objs.filter((x) => x.id !== o.id);
          el && el.remove();
          T.sel = T.sel.filter((s) => s.id !== o.id);
        } else if (!o.runs.length) o.runs = [Object.assign({}, ed.styleFallback, { t: '' })];
      }
    } else if (ed.kind === 'base') {
      const ov = pg.ov[ed.id];
      if (ov) {
        ov.runs = V.readRuns(ed.el, ed.styleFallback);
        const ex = PE.ex[PE.pageKey(pg)];
        const b = ex && ex.blocks.find((x) => x.id === ed.id);
        const def = b && V.blockDefaults(ex, b);
        // nothing changed: go back to showing the original PDF text
        if (
          b &&
          JSON.stringify(ov.runs) === JSON.stringify(b.runs) &&
          !ov.dx &&
          !ov.dy &&
          ov.w === def.w &&
          ov.align === def.align &&
          ov.lh === def.lh &&
          !!ov.auto === !!def.auto
        )
          delete pg.ov[ed.id];
      }
      V.renderOverlay(pg);
    } else if (ed.kind === 'cell') {
      const el = V.objEl(pg, ed.id);
      if (el) {
        el.classList.remove('is-editing');
        PE.$$('td.cur', el).forEach((x) => x.classList.remove('cur'));
      }
      const o = PE.findObj(pg, ed.id);
      if (o) o.rows[ed.r][ed.c].t = V.readRuns(ed.el, ed.styleFallback).map((r) => r.t).join('');
    }
    PE.commit();
    if (!keepSelection) {
      if (ed.kind === 'base') T.sel = [];
    }
    T.redrawSelection();
    PE.ui.refreshProps();
  };

  /* ---------- character offsets inside an editor ---------- */
  function nodesOf(root) {
    const out = [];
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out.push({ n: c, len: c.nodeValue.length });
        else if (c.nodeName === 'BR') out.push({ n: c, len: 1 });
        else if (c.nodeType === 1) walk(c);
      }
    };
    walk(root);
    // trailing placeholder <br> is not part of the text
    const last = out[out.length - 1];
    if (last && last.n.nodeName === 'BR') {
      const prev = out[out.length - 2];
      if (prev && prev.n.nodeName === 'BR') last.len = 0;
      else if (!prev) last.len = 0;
    }
    return out;
  }
  function toIndex(root, node, offset) {
    const list = nodesOf(root);
    const b = document.createRange();
    b.setStart(node, offset);
    b.collapse(true);
    let acc = 0;
    for (const it of list) {
      if (it.n === node) return acc + (node.nodeType === 3 ? offset : 0);
      let pos;
      try {
        pos = b.comparePoint(it.n, 0);
      } catch (e) {
        pos = 1;
      }
      if (pos < 0) acc += it.len;
      else break;
    }
    return acc;
  }
  function fromIndex(root, idx) {
    const list = nodesOf(root);
    let acc = 0;
    for (const it of list) {
      if (it.n.nodeType === 3 && idx <= acc + it.len) return [it.n, idx - acc];
      if (it.n.nodeName === 'BR' && idx <= acc) return [it.n.parentNode, Array.prototype.indexOf.call(it.n.parentNode.childNodes, it.n)];
      acc += it.len;
    }
    return [root, root.childNodes.length];
  }
  T.selOffsets = function () {
    const ed = T.editing;
    const sel = window.getSelection();
    if (!ed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!ed.el.contains(r.startContainer)) return null;
    return [toIndex(ed.el, r.startContainer, r.startOffset), toIndex(ed.el, r.endContainer, r.endOffset)];
  };
  T.setSelOffsets = function (s, e) {
    const ed = T.editing;
    if (!ed) return;
    const [sn, so] = fromIndex(ed.el, s);
    const [en, eo] = fromIndex(ed.el, e);
    const r = document.createRange();
    try {
      r.setStart(sn, so);
      r.setEnd(en, eo);
    } catch (err) {
      return;
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  };

  /** split runs at [s,e) and apply props */
  PE.styleRuns = function (runs, s, e, props) {
    const out = [];
    let pos = 0;
    for (const r of runs) {
      const a = pos,
        b = pos + r.t.length;
      pos = b;
      if (b <= s || a >= e) {
        out.push(Object.assign({}, r));
        continue;
      }
      const cut = [Math.max(s, a), Math.min(e, b)];
      if (cut[0] > a) out.push(Object.assign({}, r, { t: r.t.slice(0, cut[0] - a) }));
      out.push(Object.assign({}, r, props, { t: r.t.slice(cut[0] - a, cut[1] - a) }));
      if (cut[1] < b) out.push(Object.assign({}, r, { t: r.t.slice(cut[1] - a) }));
    }
    return PE.mergeRuns(out);
  };
  PE.mergeRuns = function (runs) {
    const out = [];
    for (const r of runs) {
      if (!r.t) continue;
      const l = out[out.length - 1];
      if (l && l.f === r.f && !!l.b === !!r.b && !!l.i === !!r.i && !!l.u === !!r.u && l.s === r.s && l.c === r.c) l.t += r.t;
      else out.push(Object.assign({}, r));
    }
    return out;
  };

  /** style shown in the panel: run under caret / first run of the selection */
  T.currentTextStyle = function () {
    const ed = T.editing;
    let runs = null;
    if (ed && (ed.kind === 'obj' || ed.kind === 'base')) {
      runs = V.readRuns(ed.el, ed.styleFallback);
      const off = T.selOffsets();
      if (off && runs.length) {
        let pos = 0;
        const at = Math.max(0, off[0] === off[1] ? off[0] - 1 : off[0]);
        for (const r of runs) {
          if (at < pos + r.t.length) return r;
          pos += r.t.length;
        }
        return runs[runs.length - 1];
      }
      return runs[0] || ed.styleFallback;
    }
    const it = T.selObjs()[0];
    if (it && it.o && it.o.type === 'text') return it.o.runs[0];
    return null;
  };

  /** apply font / size / colour / bold… to the selected text (or the whole box) */
  T.applyTextStyle = function (props) {
    const ed = T.editing;
    if (ed && (ed.kind === 'obj' || ed.kind === 'base')) {
      const pg = PE.findPage(ed.pg);
      let runs = V.readRuns(ed.el, ed.styleFallback);
      const off = T.selOffsets();
      const total = runs.reduce((a, r) => a + r.t.length, 0);
      let s = 0,
        e = total;
      if (off && off[0] !== off[1]) [s, e] = off;
      if (!total) {
        ed.styleFallback = Object.assign({}, ed.styleFallback, props);
        runs = [Object.assign({}, ed.styleFallback, { t: '' })];
      } else runs = PE.styleRuns(runs, s, e, props);
      if (ed.kind === 'obj') PE.findObj(pg, ed.id).runs = runs;
      else pg.ov[ed.id].runs = runs;
      ed.styleFallback = Object.assign({}, ed.styleFallback, props);
      PE.fonts.ensureRuns(runs);
      V.fillRuns(ed.el, runs.length && runs[0].t ? runs : [Object.assign({}, ed.styleFallback, { t: '' })]);
      if (off) T.setSelOffsets(off[0], off[1]);
      if (ed.kind === 'base') V.layoutBase(pg);
      if (props.f || props.b || props.i)
        PE.fonts.ensureRuns(runs).then(() => {
          if (ed.kind === 'base') V.layoutBase(pg);
          T.redrawSelection();
        });
      T.redrawSelection();
      PE.commitSoon();
      Object.assign(T.defaults.text, pickTextProps(props));
      T.saveDefaults();
      return;
    }
    const items = T.selObjs().filter((it) => it.o && (it.o.type === 'text' || it.o.type === 'table'));
    if (items.length) {
      for (const it of items) {
        const o = it.o;
        if (o.type === 'text') o.runs = o.runs.map((r) => Object.assign({}, r, props));
        else {
          if (props.f) o.f = props.f;
          if (props.s) o.size = props.s;
          if (props.c) o.color = props.c;
        }
        V.updateObj(it.pg, o, true);
      }
      PE.fonts.ensureRuns(items.flatMap((it) => it.o.runs || [])).then(() => T.redrawSelection());
      PE.commit();
      T.redrawSelection();
    }
    Object.assign(T.defaults.text, pickTextProps(props));
    T.saveDefaults();
  };
  function pickTextProps(p) {
    const o = {};
    for (const k of ['f', 's', 'c', 'b', 'i', 'u']) if (p[k] !== undefined) o[k] = p[k];
    return o;
  }

  /** paragraph-level settings (alignment, line spacing) */
  T.applyPara = function (props) {
    const ed = T.editing;
    if (ed && ed.kind === 'base') {
      const pg = PE.findPage(ed.pg);
      Object.assign(pg.ov[ed.id], props);
      V.layoutBase(pg);
      T.redrawSelection();
      PE.commitSoon();
      return;
    }
    const items = T.selObjs().filter((it) => it.o && it.o.type === 'text');
    for (const it of items) {
      Object.assign(it.o, props);
      V.updateObj(it.pg, it.o);
    }
    if (ed && ed.kind === 'obj') {
      const pg = PE.findPage(ed.pg);
      const o = PE.findObj(pg, ed.id);
      Object.assign(o, props);
      V.updateObj(pg, o);
    }
    T.redrawSelection();
    PE.commitSoon();
  };

  /* ---------- object operations ---------- */
  T.deleteSelection = function () {
    const items = T.selObjs();
    if (!items.length) return;
    const pg = items[0].pg;
    for (const it of items) {
      if (it.base) {
        pg.ov[it.id] = Object.assign(pg.ov[it.id] || {}, { del: true });
      } else pg.objs = pg.objs.filter((o) => o.id !== it.id);
    }
    T.sel = [];
    V.renderOverlay(pg);
    PE.commit();
    PE.ui.refreshProps();
  };
  T.deleteEditingBlock = function () {
    const ed = T.editing;
    if (!ed || ed.kind !== 'base') return;
    const pg = PE.findPage(ed.pg);
    T.editing = null;
    detachEditor(ed.el);
    const pv = V.els.get(pg.id);
    pv.editingEl = null;
    pg.ov[ed.id] = { del: true };
    V.renderOverlay(pg);
    PE.commit();
    T.redrawSelection();
    PE.ui.refreshProps();
  };
  T.restoreEditingBlock = function () {
    const ed = T.editing;
    if (!ed || ed.kind !== 'base') return;
    const pg = PE.findPage(ed.pg);
    T.editing = null;
    detachEditor(ed.el);
    V.els.get(pg.id).editingEl = null;
    delete pg.ov[ed.id];
    V.renderOverlay(pg);
    PE.commit();
    T.redrawSelection();
    PE.ui.refreshProps();
  };
  T.restoreBaseImage = function () {
    const it = T.selObjs()[0];
    if (!it || !it.base) return;
    delete it.pg.ov[it.id];
    V.layoutBase(it.pg);
    PE.commit();
    T.redrawSelection();
  };

  T.duplicate = function () {
    const items = T.selObjs().filter((it) => !it.base);
    if (!items.length) return;
    const pg = items[0].pg;
    const ids = [];
    for (const it of items) {
      const o = PE.clone(it.o);
      o.id = PE.uid('o');
      o.x += 12;
      o.y += 12;
      if (o.type === 'line') {
        o.x1 += 12;
        o.x2 += 12;
        o.y1 += 12;
        o.y2 += 12;
      }
      pg.objs.push(o);
      ids.push(o.id);
    }
    V.renderOverlay(pg);
    PE.commit();
    T.select(ids.map((id) => ({ pg: pg.id, id })));
  };
  T.copy = function () {
    const items = T.selObjs().filter((it) => !it.base);
    if (items.length) T.clipboard = items.map((it) => PE.clone(it.o));
  };
  T.paste = function () {
    if (!T.clipboard) return false;
    const pg = V.currentPage();
    if (!pg) return false;
    const ids = [];
    for (const src of T.clipboard) {
      const o = PE.clone(src);
      o.id = PE.uid('o');
      o.x += 14;
      o.y += 14;
      if (o.type === 'line') {
        o.x1 += 14;
        o.x2 += 14;
        o.y1 += 14;
        o.y2 += 14;
      }
      pg.objs.push(o);
      ids.push(o.id);
    }
    T.clipboard = T.clipboard.map((o) => Object.assign(PE.clone(o), { x: o.x + 14, y: o.y + 14 }));
    V.renderOverlay(pg);
    PE.commit();
    T.select(ids.map((id) => ({ pg: pg.id, id })));
    return true;
  };
  T.nudge = function (dx, dy) {
    const items = T.selObjs();
    if (!items.length) return;
    const pg = items[0].pg;
    for (const it of items) {
      if (it.base) {
        const ov = T.baseImgOv(pg, it.im);
        ov.x += dx;
        ov.y += dy;
      } else {
        const o = it.o;
        o.x += dx;
        o.y += dy;
        if (o.type === 'line') {
          o.x1 += dx;
          o.x2 += dx;
          o.y1 += dy;
          o.y2 += dy;
        }
        V.updateObj(pg, o);
      }
    }
    V.layoutBase(pg);
    T.redrawSelection();
    PE.commitSoon();
  };
  T.arrange = function (dir) {
    const items = T.selObjs().filter((it) => !it.base);
    if (!items.length) return;
    const pg = items[0].pg;
    const ids = new Set(items.map((i) => i.id));
    const sel = pg.objs.filter((o) => ids.has(o.id)),
      rest = pg.objs.filter((o) => !ids.has(o.id));
    pg.objs = dir === 'front' ? rest.concat(sel) : sel.concat(rest);
    V.renderOverlay(pg);
    PE.commit();
  };
  T.setProps = function (props, opts = {}) {
    const items = T.selObjs();
    for (const it of items) {
      if (it.base) {
        const ov = T.baseImgOv(it.pg, it.im);
        Object.assign(ov, props);
        V.layoutBase(it.pg);
      } else {
        Object.assign(it.o, props);
        V.updateObj(it.pg, it.o, true);
      }
    }
    T.redrawSelection();
    if (opts.soon) PE.commitSoon();
    else PE.commit();
  };

  /* ---------- tables ---------- */
  T.insertTable = function (rows, cols) {
    const pg = V.currentPage();
    if (!pg) return;
    const { W } = PE.baseSize(pg);
    const d = T.defaults.text;
    const w = Math.min(W - 72, cols * 110);
    const o = {
      id: PE.uid('o'),
      type: 'table',
      x: (W - w) / 2,
      y: visibleTop(pg) + 40,
      w,
      h: rows * 22,
      rot: 0,
      rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ t: '' }))),
      cw: Array.from({ length: cols }, () => w / cols),
      f: d.f,
      size: Math.min(d.s, 12),
      color: '#111111',
      border: '#4a5568',
      bw: 0.75,
      pad: 4,
      head: true,
      headBg: '#e8ecf3',
      lh: 1.25,
    };
    addObj(pg, o);
    T.editCell(pg, o, 0, 0);
  };
  function visibleTop(pg) {
    const pv = V.els.get(pg.id);
    const sr = V.scroller.getBoundingClientRect();
    const r = pv.sheet.getBoundingClientRect();
    const top = Math.max(0, (sr.top - r.top) / V.zoom);
    const p = PE.M.apply(V.dispToBase(pg), PE.dispSize(pg).w / 2, top);
    return PE.clamp(p[1], 20, PE.baseSize(pg).H - 120);
  }
  T.visibleCenter = function (pg) {
    const pv = V.els.get(pg.id);
    const sr = V.scroller.getBoundingClientRect();
    const r = pv.sheet.getBoundingClientRect();
    const d = PE.dispSize(pg);
    const cy = PE.clamp(((sr.top + sr.bottom) / 2 - r.top) / V.zoom, 60, d.h - 60);
    return PE.M.apply(V.dispToBase(pg), d.w / 2, cy);
  };

  T.tableOp = function (op, at) {
    const it = T.selObjs()[0];
    if (!it || !it.o || it.o.type !== 'table') return;
    const o = it.o,
      pg = it.pg;
    const ed = T.editing && T.editing.kind === 'cell' ? { r: T.editing.r, c: T.editing.c } : { r: 0, c: 0 };
    if (T.editing) T.stopEditing(true);
    const r = at != null ? at : ed.r,
      c = ed.c;
    const cols = o.rows[0].length;
    const blankRow = () => Array.from({ length: cols }, () => ({ t: '' }));
    if (op === 'rowAbove') o.rows.splice(r, 0, blankRow());
    else if (op === 'rowBelow') o.rows.splice(r + 1, 0, blankRow());
    else if (op === 'rowDel' && o.rows.length > 1) o.rows.splice(r, 1);
    else if (op === 'colLeft' || op === 'colRight') {
      const at2 = op === 'colLeft' ? c : c + 1;
      const share = o.w / (cols + 1);
      o.cw = o.cw.map((w) => (w * (o.w - share)) / o.w);
      o.cw.splice(at2, 0, share);
      o.rows.forEach((row) => row.splice(at2, 0, { t: '' }));
    } else if (op === 'colDel' && cols > 1) {
      const removed = o.cw.splice(c, 1)[0];
      o.cw = o.cw.map((w) => w + removed / o.cw.length);
      o.rows.forEach((row) => row.splice(c, 1));
    }
    V.updateObj(pg, o, true);
    PE.commit();
    T.redrawSelection();
    const nr = PE.clamp(op === 'rowBelow' ? r + 1 : r, 0, o.rows.length - 1);
    const nc = PE.clamp(op === 'colRight' ? c + 1 : c, 0, o.rows[0].length - 1);
    T.editCell(pg, o, nr, nc);
  };

  /** Turn the PDF text inside a rectangle into an editable table object. */
  T.convertTable = async function (pg, r) {
    const ex = PE.ex[PE.pageKey(pg)];
    if (!ex) return PE.toast('This page has no PDF text to convert.', 'warn');
    const pv = V.els.get(pg.id);
    const shift = (pv && pv.shift) || {};
    // positions as shown (after any push from edited text above)
    const shown = (b) => {
      const ov = pg.ov[b.id] || {};
      return { x: b.x + (ov.dx || 0), top: b.top + (shift[b.id] || 0) + (ov.dy || 0) };
    };
    const inside = ex.blocks.filter((b) => {
      if (pg.ov[b.id] && pg.ov[b.id].del) return false;
      const s = shown(b);
      const cx = s.x + b.w / 2,
        cy = s.top + b.h / 2;
      return cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h;
    });
    if (inside.length < 2) return PE.toast('No table text found in that area. Drag around the whole table.', 'warn');
    // split blocks into lines (each line of a cell is kept in that cell)
    const cells = inside.map((b) => {
      const info = V.blockInfo(pg, ex, b);
      const s = shown(b);
      return { b, t: info.runs.map((x) => x.t).join(''), x: s.x, r: s.x + b.w, y: s.top, bt: s.top + b.h, run: info.runs[0] };
    });
    // the table's own lines and shading go too, so they can't show through later
    for (const g of ex.graphics || []) {
      const gy = g.y + (shift[g.id] || 0);
      if (g.x >= r.x - 2 && g.x + g.w <= r.x + r.w + 2 && gy >= r.y - 2 && gy + g.h <= r.y + r.h + 2) pg.ov[g.id] = { del: true };
    }
    // rows: cluster by vertical overlap
    cells.sort((a, b) => a.y - b.y);
    const rows = [];
    for (const c of cells) {
      const row = rows.find((rw) => Math.min(rw.bt, c.bt) - Math.max(rw.y, c.y) > Math.min(rw.bt - rw.y, c.bt - c.y) * 0.4);
      if (row) {
        row.cells.push(c);
        row.y = Math.min(row.y, c.y);
        row.bt = Math.max(row.bt, c.bt);
      } else rows.push({ y: c.y, bt: c.bt, cells: [c] });
    }
    rows.sort((a, b) => a.y - b.y);
    // columns: cluster x-intervals across all rows
    const iv = cells.map((c) => [c.x, c.r]).sort((a, b) => a[0] - b[0]);
    const cols = [];
    for (const [a, b] of iv) {
      const col = cols.find((k) => Math.min(k[1], b) - Math.max(k[0], a) > 0);
      if (col) {
        col[0] = Math.min(col[0], a);
        col[1] = Math.max(col[1], b);
      } else cols.push([a, b]);
    }
    cols.sort((a, b) => a[0] - b[0]);
    // merge overlapping columns
    for (let k = cols.length - 1; k > 0; k--)
      if (cols[k][0] < cols[k - 1][1]) {
        cols[k - 1][1] = Math.max(cols[k - 1][1], cols[k][1]);
        cols.splice(k, 1);
      }
    const grid = rows.map(() => cols.map(() => ({ t: '' })));
    rows.forEach((row, ri) =>
      row.cells
        .sort((a, b) => a.x - b.x)
        .forEach((c) => {
          const ci = cols.findIndex((k) => Math.min(k[1], c.r) - Math.max(k[0], c.x) > 0);
          const cell = grid[ri][Math.max(0, ci)];
          cell.t = cell.t ? cell.t + ' ' + c.t : c.t;
          if (c.run && c.run.b) cell.b = true;
        })
    );
    // column widths from the gaps between columns
    const x0 = Math.min(r.x, cols[0][0] - 4),
      x1 = Math.max(r.x + r.w, cols[cols.length - 1][1] + 4);
    const bounds = [x0];
    for (let k = 1; k < cols.length; k++) bounds.push((cols[k - 1][1] + cols[k][0]) / 2);
    bounds.push(x1);
    const cw = cols.map((_, k) => bounds[k + 1] - bounds[k]);
    const runs = cells.map((c) => c.run).filter(Boolean);
    const main = runs.sort((a, b) => b.t.length - a.t.length)[0] || T.defaults.text;
    const sizes = runs.map((x) => x.s).sort((a, b) => a - b);
    const size = sizes[Math.floor(sizes.length / 2)] || 10;
    for (const c of cells) pg.ov[c.b.id] = { del: true };
    const o = {
      id: PE.uid('o'),
      type: 'table',
      x: x0,
      y: Math.min(r.y, rows[0].y - 4),
      w: x1 - x0,
      h: r.h,
      rot: 0,
      rows: grid,
      cw,
      f: main.f || 'arimo',
      size,
      color: main.c || '#000000',
      border: '#555555',
      bw: 0.75,
      pad: 3,
      head: grid[0].every((c) => c.b),
      headBg: null,
      lh: 1.2,
      cover: { x: r.x, y: r.y, w: r.w, h: r.h, c: ex.blocks.find((b) => b.id === cells[0].b.id).bg || '#ffffff' },
    };
    if (o.head) grid[0].forEach((c) => delete c.b);
    pg.objs.push(o);
    V.renderOverlay(pg);
    PE.commit();
    T.setTool('edit');
    T.select([{ pg: pg.id, id: o.id }]);
    PE.toast(`Table with ${grid.length} rows and ${cols.length} columns is ready to edit.`, 'ok');
  };

  /* ---------- images & signatures ---------- */
  T.insertImageFromBytes = async function (bytes, mime, opts = {}) {
    const pg = opts.pg || V.currentPage();
    if (!pg) return;
    let id;
    try {
      id = await PE.addAsset(bytes, mime);
    } catch (e) {
      return PE.toast(e.message, 'error');
    }
    const a = PE.assets[id];
    const { W, H } = PE.baseSize(pg);
    const maxW = opts.width || Math.min(W * 0.6, a.w * 0.75);
    let w = maxW,
      h = (a.h / a.w) * w;
    if (h > H * 0.6) {
      h = H * 0.6;
      w = (a.w / a.h) * h;
    }
    const c = opts.at || T.visibleCenter(pg);
    const o = { id: PE.uid('o'), type: 'image', a: id, x: c[0] - w / 2, y: c[1] - h / 2, w, h, rot: 0, op: 1 };
    addObj(pg, o);
    return o;
  };
  T.replaceImage = async function () {
    const it = T.selObjs()[0];
    if (!it) return;
    const [file] = await PE.pickFiles('image/*');
    if (!file) return;
    const id = await PE.addAsset(await PE.readFile(file), file.type);
    if (it.base) {
      const ov = T.baseImgOv(it.pg, it.im);
      ov.a = id;
      V.layoutBase(it.pg);
    } else {
      it.o.a = id;
      V.updateObj(it.pg, it.o, true);
    }
    PE.commit();
  };
})();
