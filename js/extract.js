/* Pagewright — reads a PDF page's text and images into editable blocks
 * Text items from pdf.js are grouped into lines, then into paragraph blocks.
 * Each block keeps per-run font family / weight / italic / size / colour so editing
 * continues in the same style. Colours and the background behind each block are sampled
 * from a rendered copy of the page.
 */
'use strict';
(function () {
  const pending = {};
  const SAMPLE_SCALE = 2;

  PE.extractPage = function (docId, i) {
    const key = docId + ':' + i;
    if (PE.ex[key]) return Promise.resolve(PE.ex[key]);
    if (pending[key]) return pending[key];
    pending[key] = run(docId, i)
      .then((ex) => {
        PE.ex[key] = ex;
        delete pending[key];
        return ex;
      })
      .catch((e) => {
        console.error('extract failed', e);
        delete pending[key];
        const ex = { W: 0, H: 0, blocks: [], images: [], failed: true };
        PE.ex[key] = ex;
        return ex;
      });
    return pending[key];
  };

  async function run(docId, i) {
    const page = await PE.getPdfPage(docId, i);
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width,
      H = vp.height;

    // Render a private copy for colour sampling (also loads fonts/images into pdf.js caches)
    let scale = SAMPLE_SCALE;
    if (W * H * scale * scale > 9e6) scale = Math.sqrt(9e6 / (W * H));
    const svp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(svp.width);
    cv.height = Math.ceil(svp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: svp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const sampler = makeSampler(img, scale);

    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!('str' in it) || !it.str || !it.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      const ang = Math.atan2(tx[1], tx[0]);
      const size = Math.hypot(tx[2], tx[3]);
      if (size < 1.5 || Math.abs(ang) > 0.035) continue; // rotated text stays as part of the page
      const style = tc.styles[it.fontName] || {};
      if (style.vertical) continue;
      let fobj = null;
      try {
        if (page.commonObjs.has(it.fontName)) fobj = page.commonObjs.get(it.fontName);
      } catch (e) {}
      const fm = PE.fonts.mapPdfFont(fobj && fobj.name, fobj);
      let asc = style.ascent ? style.ascent : style.descent ? 1 + style.descent : 0.8;
      let desc = style.descent ? -style.descent : 0.21;
      asc = PE.clamp(asc, 0.6, 1.05);
      desc = PE.clamp(desc, 0.12, 0.35);
      const w = it.width; // already in page units at scale 1
      if (!(w > 0)) continue;
      const x = tx[4],
        y = tx[5];
      const box = { x, y: y - asc * size, w, h: (asc + desc) * size };
      const color = sampler.ink(box);
      items.push({ str: it.str, x, y, w, size, asc, desc, fm, color });
    }

    const lines = buildLines(items);
    const blocks = buildBlocks(lines, sampler);

    // ---------- images and simple vector graphics (rules, table lines, boxes) ----------
    const images = [];
    const graphics = [];
    try {
      const ops = await page.getOperatorList();
      const OPS = pdfjsLib.OPS;
      let ctm = PE.M.I.slice();
      let gs = { lw: 1, sc: '#000000', fc: '#000000' };
      let path = null;
      const stack = [];
      const fn = ops.fnArray,
        args = ops.argsArray;
      const hex = (a) => (typeof a[0] === 'string' ? a[0] : a && a.length >= 3 && typeof a[0] === 'number' ? PE.rgbToHex(a[0], a[1], a[2]) : '#000000');
      for (let k = 0; k < fn.length; k++) {
        const f = fn[k],
          a = args[k];
        if (f === OPS.save) stack.push([ctm, Object.assign({}, gs)]);
        else if (f === OPS.restore) {
          const st = stack.pop();
          if (st) [ctm, gs] = st;
        } else if (f === OPS.transform) ctm = PE.M.mul(ctm, a);
        else if (f === OPS.setLineWidth) gs.lw = a[0];
        else if (f === OPS.setStrokeRGBColor) gs.sc = hex(a);
        else if (f === OPS.setFillRGBColor) gs.fc = hex(a);
        else if (f === OPS.constructPath) path = collectPath(a, PE.M.mul(vp.transform, ctm), path);
        else if (f >= OPS.stroke && f <= OPS.endPath) {
          if (path && f !== OPS.endPath) {
            const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
            addGraphics(graphics, path, f, gs, gs.lw * scale, OPS, W, H);
          }
          path = null;
        } else if (f === OPS.paintFormXObjectBegin) {
          stack.push([ctm, Object.assign({}, gs)]);
          if (a && Array.isArray(a[0]) && a[0].length === 6) ctm = PE.M.mul(ctm, a[0]);
        } else if (f === OPS.paintFormXObjectEnd) {
          const st = stack.pop();
          if (st) [ctm, gs] = st;
        } else if (f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject) {
          const D = PE.M.mul(vp.transform, ctm);
          const TL = PE.M.apply(D, 0, 1),
            TR = PE.M.apply(D, 1, 1),
            BL = PE.M.apply(D, 0, 0),
            BR = PE.M.apply(D, 1, 0);
          const w = Math.hypot(TR[0] - TL[0], TR[1] - TL[1]);
          const h = Math.hypot(BL[0] - TL[0], BL[1] - TL[1]);
          if (w < 8 || h < 8) continue;
          const xs = [TL[0], TR[0], BL[0], BR[0]],
            ys = [TL[1], TR[1], BL[1], BR[1]];
          const bbox = {
            x: Math.min(...xs),
            y: Math.min(...ys),
            w: Math.max(...xs) - Math.min(...xs),
            h: Math.max(...ys) - Math.min(...ys),
          };
          if (bbox.x > W || bbox.y > H || bbox.x + bbox.w < 0 || bbox.y + bbox.h < 0) continue;
          const cross = (TR[0] - TL[0]) * (BL[1] - TL[1]) - (TR[1] - TL[1]) * (BL[0] - TL[0]);
          const rot = (Math.atan2(TR[1] - TL[1], TR[0] - TL[0]) * 180) / Math.PI;
          const cx = (TL[0] + TR[0] + BL[0] + BR[0]) / 4,
            cy = (TL[1] + TR[1] + BL[1] + BR[1]) / 4;
          images.push({
            id: 'i' + images.length,
            objId: f === OPS.paintImageXObject ? a[0] : null,
            inline: f === OPS.paintInlineImageXObject ? a[0] : null,
            x: cx - w / 2,
            y: cy - h / 2,
            w,
            h,
            rot: Math.abs(rot) < 0.05 ? 0 : rot,
            flipY: cross < 0,
            bbox,
            bg: sampler.ring(bbox),
          });
        }
      }
    } catch (e) {
      console.warn('image scan failed', e);
    }
    for (const g of graphics) g.bg = sampler.ring({ x: g.x, y: g.y, w: g.w, h: g.h });
    graphics.forEach((g, i) => (g.id = 'g' + i));
    return { W, H, blocks, images, graphics: graphics.slice(0, 1500), preds: null };
  }

  /** collect the segments of a path in page coordinates; only straight, axis-aligned pieces are kept */
  function collectPath(a, M, prev) {
    const OPS = pdfjsLib.OPS;
    const ops = a[0],
      co = a[1];
    const p = prev || { segs: [], rects: [], ok: true, cur: null, start: null };
    let j = 0;
    const pt = (x, y) => PE.M.apply(M, x, y);
    for (const op of ops) {
      if (op === OPS.moveTo) {
        p.cur = p.start = pt(co[j], co[j + 1]);
        j += 2;
      } else if (op === OPS.lineTo) {
        const q = pt(co[j], co[j + 1]);
        j += 2;
        if (p.cur) p.segs.push([p.cur, q]);
        p.cur = q;
      } else if (op === OPS.rectangle) {
        const x = co[j],
          y = co[j + 1],
          w = co[j + 2],
          h = co[j + 3];
        j += 4;
        const c = [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)];
        p.rects.push(c);
        p.cur = p.start = c[0];
      } else if (op === OPS.closePath) {
        if (p.cur && p.start && (p.cur[0] !== p.start[0] || p.cur[1] !== p.start[1])) p.segs.push([p.cur, p.start]);
        p.cur = p.start;
      } else {
        // curves: give up on this path (it stays part of the page)
        p.ok = false;
        j += op === OPS.curveTo ? 6 : 4;
      }
    }
    return p;
  }
  function addGraphics(out, p, f, gs, lw, OPS, W, H) {
    if (!p.ok || out.length > 3000) return;
    const axis = (s) => Math.abs(s[0][0] - s[1][0]) < 0.3 || Math.abs(s[0][1] - s[1][1]) < 0.3;
    const box = (pts) => {
      const xs = pts.map((q) => q[0]),
        ys = pts.map((q) => q[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    };
    const fill = f === OPS.fill || f === OPS.eoFill || f === OPS.fillStroke || f === OPS.eoFillStroke || f === OPS.closeFillStroke || f === OPS.closeEOFillStroke;
    const stroke = f !== OPS.fill && f !== OPS.eoFill;
    if (fill) {
      for (const r of p.rects) {
        const b = box(r);
        if (b.w > W * 0.92 && b.h > H * 0.92) continue; // page background
        if (b.w < 0.1 || b.h < 0.1) continue;
        out.push({ k: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, c: gs.fc });
      }
      // a filled path made of axis-aligned segments that closes into a rectangle (common for thin rules)
      if (!p.rects.length && p.segs.length >= 3 && p.segs.length <= 5 && p.segs.every(axis)) {
        const b = box(p.segs.flat());
        if (!(b.w > W * 0.92 && b.h > H * 0.92) && b.w > 0.1 && b.h > 0.1) out.push({ k: 'rect', x: b.x, y: b.y, w: b.w, h: b.h, c: gs.fc });
      }
    }
    if (stroke) {
      const half = Math.max(0.25, lw / 2);
      for (const r of p.rects) {
        for (let i = 0; i < 4; i++) p.segs.push([r[i], r[(i + 1) % 4]]);
      }
      for (const s of p.segs) {
        if (!axis(s)) continue;
        const b = box(s);
        out.push({ k: 'line', x1: s[0][0], y1: s[0][1], x2: s[1][0], y2: s[1][1], lw, c: gs.sc, x: b.x - half, y: b.y - half, w: b.w + 2 * half, h: b.h + 2 * half });
      }
    }
  }

  /* ---------- colour sampling on the rendered page ---------- */
  function makeSampler(img, scale) {
    const { data, width, height } = img;
    const px = (x, y) => {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const q = (c) => ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
    function region(b) {
      const x0 = PE.clamp(Math.floor(b.x * scale), 0, width - 1),
        y0 = PE.clamp(Math.floor(b.y * scale), 0, height - 1);
      const x1 = PE.clamp(Math.ceil((b.x + b.w) * scale), x0 + 1, width),
        y1 = PE.clamp(Math.ceil((b.y + b.h) * scale), y0 + 1, height);
      return [x0, y0, x1, y1];
    }
    function dominant(pixels) {
      const hist = new Map();
      let best = null,
        bestN = 0;
      for (const c of pixels) {
        const k = q(c);
        const e = hist.get(k) || { n: 0, r: 0, g: 0, b: 0 };
        e.n++;
        e.r += c[0];
        e.g += c[1];
        e.b += c[2];
        hist.set(k, e);
        if (e.n > bestN) {
          bestN = e.n;
          best = e;
        }
      }
      return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
    }
    function bgOf(b) {
      const [x0, y0, x1, y1] = region(b);
      const pts = [];
      const step = Math.max(1, Math.floor(((x1 - x0) * (y1 - y0)) / 4000));
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          if (n++ % step) continue;
          pts.push(px(x, y));
        }
      return dominant(pts);
    }
    return {
      bg(b) {
        const c = bgOf(b);
        return PE.rgbToHex(c[0], c[1], c[2]);
      },
      /** most common "ink" colour in a box (pixels far from the background) */
      ink(b) {
        const [x0, y0, x1, y1] = region(b);
        const bg = bgOf(b);
        let maxD = 0;
        const cand = [];
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const c = px(x, y);
            const d = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
            if (d > 60) {
              cand.push([c, d]);
              if (d > maxD) maxD = d;
            }
          }
        if (!cand.length) return bg[0] + bg[1] + bg[2] > 380 ? '#000000' : '#ffffff';
        const strong = cand.filter((c) => c[1] >= maxD * 0.72).map((c) => c[0]);
        const c = dominant(strong);
        // snap near-black to pure black (anti-aliasing leaves it slightly grey)
        if (c[0] < 40 && c[1] < 40 && c[2] < 40 && Math.abs(c[0] - c[1]) < 12 && Math.abs(c[1] - c[2]) < 12) return '#000000';
        return PE.rgbToHex(c[0], c[1], c[2]);
      },
      /** background just outside a box (for covering moved images) */
      ring(b) {
        const pad = 2 / scale;
        const pts = [];
        const [x0, y0, x1, y1] = region({ x: b.x - pad * 2, y: b.y - pad * 2, w: b.w + pad * 4, h: b.h + pad * 4 });
        for (let x = x0; x < x1; x += 2) {
          pts.push(px(x, y0));
          pts.push(px(x, y1 - 1));
        }
        for (let y = y0; y < y1; y += 2) {
          pts.push(px(x0, y));
          pts.push(px(x1 - 1, y));
        }
        const c = dominant(pts);
        return PE.rgbToHex(c[0], c[1], c[2]);
      },
    };
  }

  /* ---------- items -> lines ---------- */
  function sameStyle(a, b) {
    return a.f === b.f && a.b === b.b && a.i === b.i && Math.abs(a.s - b.s) < 0.15 && a.c === b.c;
  }
  function pushRun(runs, r) {
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, r)) last.t += r.t;
    else runs.push(r);
  }

  function buildLines(items) {
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const it of items) {
      let row = null;
      for (let k = rows.length - 1; k >= 0 && k >= rows.length - 8; k--) {
        const r = rows[k];
        if (Math.abs(r.y - it.y) <= 0.3 * Math.min(r.size, it.size)) {
          row = r;
          break;
        }
      }
      if (!row) {
        row = { y: it.y, size: it.size, items: [] };
        rows.push(row);
      }
      row.items.push(it);
      if (it.size > row.size) {
        row.size = it.size;
        row.y = it.y;
      }
    }
    const lines = [];
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let cur = null,
        prev = null;
      const flush = () => {
        if (cur) {
          finishLine(cur);
          lines.push(cur);
        }
        cur = null;
      };
      for (const it of row.items) {
        if (cur) {
          const sz = Math.max(cur.size, it.size);
          const gap = it.x - cur.right;
          // repeated glyphs used to fake bold / shadows
          if (prev && it.str === prev.str && Math.abs(it.x - prev.x) < sz * 0.4) continue;
          if (gap > 1.25 * sz) flush();
          else if (gap > 0.13 * Math.min(cur.size, it.size)) {
            const lr = cur.runs[cur.runs.length - 1];
            if (lr && !/\s$/.test(lr.t) && !/^\s/.test(it.str)) lr.t += ' ';
          }
        }
        if (!cur)
          cur = {
            x: it.x,
            right: it.x + it.w,
            y: row.y,
            top: Infinity,
            bottom: -Infinity,
            size: it.size,
            runs: [],
            charsBySize: new Map(),
            of: it.fm.original,
          };
        pushRun(cur.runs, {
          t: it.str.replace(/\s+/g, ' '),
          f: it.fm.f,
          b: it.fm.b,
          i: it.fm.i,
          s: Math.round(it.size * 10) / 10,
          c: it.color,
        });
        cur.right = Math.max(cur.right, it.x + it.w);
        cur.top = Math.min(cur.top, it.y - it.asc * it.size);
        cur.bottom = Math.max(cur.bottom, it.y + it.desc * it.size);
        const k = Math.round(it.size * 10) / 10;
        cur.charsBySize.set(k, (cur.charsBySize.get(k) || 0) + it.str.length);
        prev = it;
      }
      flush();
    }
    return lines;
  }
  function finishLine(l) {
    // dominant size = size with most characters
    let best = l.size,
      n = -1;
    for (const [s, c] of l.charsBySize) if (c > n) {
        n = c;
        best = s;
      }
    l.size = best;
    delete l.charsBySize;
    // trim
    if (l.runs.length) {
      l.runs[0].t = l.runs[0].t.replace(/^\s+/, '');
      const lr = l.runs[l.runs.length - 1];
      lr.t = lr.t.replace(/\s+$/, '');
      l.runs = l.runs.filter((r) => r.t.length);
    }
    l.text = l.runs.map((r) => r.t).join('');
  }

  /* ---------- lines -> blocks (paragraphs) ---------- */
  const BULLET = /^\s*([•▪●◦‣∙·\-–—*■□➢➤✓✔]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])\s/;

  function buildBlocks(lines, sampler) {
    lines = lines.filter((l) => l.runs.length);
    lines.sort((a, b) => a.top - b.top || a.x - b.x);
    const blocks = [];
    for (const ln of lines) {
      let target = null;
      for (let k = blocks.length - 1; k >= 0; k--) {
        const b = blocks[k];
        const last = b.lines[b.lines.length - 1];
        if (last.bottom < ln.top - 3 * ln.size) continue;
        const sz = Math.max(last.size, ln.size);
        if (Math.abs(last.size - ln.size) > 0.18 * sz) continue;
        const vgap = ln.top - last.bottom;
        if (vgap < -0.3 * sz || vgap > 0.7 * sz) continue;
        const pitch = ln.y - last.y;
        if (pitch < 0.75 * sz || pitch > 2.2 * sz) continue;
        if (b.pitch && Math.abs(pitch - b.pitch) > 0.3 * sz) continue;
        const ov = Math.min(ln.right, b.right) - Math.max(ln.x, b.x);
        const minW = Math.min(ln.right - ln.x, b.right - b.x);
        const leftAligned = Math.abs(ln.x - b.x) < 0.9 * sz;
        const centered = Math.abs((ln.x + ln.right) / 2 - (b.x + b.right) / 2) < 1.2 * sz && ov > 0;
        if (!(leftAligned || centered || ov > 0.6 * minW)) continue;
        target = b;
        break;
      }
      if (target) {
        const last = target.lines[target.lines.length - 1];
        if (!target.pitch) target.pitch = ln.y - last.y;
        target.lines.push(ln);
        target.x = Math.min(target.x, ln.x);
        target.right = Math.max(target.right, ln.right);
      } else {
        blocks.push({ lines: [ln], x: ln.x, right: ln.right, pitch: 0 });
      }
    }

    return blocks.map((b, idx) => {
      const L = b.lines;
      const first = L[0];
      const width = b.right - b.x;
      const sz = first.size;
      // paragraph breaks inside the block
      const brk = [];
      for (let k = 1; k < L.length; k++) {
        const prev = L[k - 1],
          ln = L[k];
        const short = b.right - prev.right > Math.max(2.5 * ln.size, 0.15 * width);
        const indented = ln.x - b.x > 0.9 * ln.size && L.length > 2;
        const bullet = BULLET.test(ln.text);
        brk.push(short || bullet || (indented && !BULLET.test(prev.text)));
      }
      // alignment
      let align = 'left';
      if (L.length > 1) {
        const lefts = L.map((l) => l.x),
          rights = L.map((l) => l.right),
          centers = L.map((l) => (l.x + l.right) / 2);
        const spread = (a) => Math.max(...a) - Math.min(...a);
        const fullLines = L.filter((l, k) => k < L.length - 1 && !brk[k]);
        const leftOk = spread(lefts.filter((x, k) => k === 0 || !brk[k - 1])) < 0.6 * sz;
        if (leftOk && fullLines.length >= 2 && spread(fullLines.map((l) => l.right).concat([b.right])) < 0.6 * sz) align = 'justify';
        else if (leftOk) align = 'left';
        else if (spread(centers) < 0.8 * sz) align = 'center';
        else if (spread(rights) < 0.6 * sz) align = 'right';
      }
      // merge runs into one flowing text
      const runs = [];
      const lineRuns = [];
      L.forEach((ln, k) => {
        lineRuns.push(PE.clone(ln.runs));
        const rs = PE.clone(ln.runs);
        if (k > 0) {
          const lr = runs[runs.length - 1];
          if (brk[k - 1]) lr.t += '\n';
          else if (/[A-Za-z]-$/.test(lr.t) && /^[a-z]/.test(ln.text)) lr.t = lr.t.slice(0, -1);
          else if (!/[\s­]$/.test(lr.t)) lr.t += ' ';
          if (/­$/.test(lr.t)) lr.t = lr.t.slice(0, -1);
        }
        rs.forEach((r) => pushRun(runs, r));
      });
      const top = Math.min(...L.map((l) => l.top)),
        bottom = Math.max(...L.map((l) => l.bottom));
      const lh = L.length > 1 ? PE.clamp((L[L.length - 1].y - first.y) / (L.length - 1) / sz, 0.9, 2.6) : 1.2;
      const box = { x: b.x, y: top, w: width, h: bottom - top };
      return {
        id: 'b' + idx,
        x: b.x,
        top,
        w: width,
        h: bottom - top,
        y0: first.y, // first baseline
        size0: sz,
        runs,
        lineRuns,
        align,
        lh: PE.round(lh, 3),
        single: L.length === 1,
        bg: sampler.bg({ x: box.x - 1, y: box.y - 1, w: box.w + 2, h: box.h + 2 }),
        text: runs.map((r) => r.t).join(''),
        of: first.of || '',
      };
    });
  }

  /* ---------- pixels of an image that is part of the PDF ---------- */
  PE.baseImagePixels = async function (docId, i, im) {
    const page = await PE.getPdfPage(docId, i);
    let data = im.inline || null;
    if (!data && im.objId) {
      const objs = im.objId.startsWith('g_') ? page.commonObjs : page.objs;
      data = await new Promise((res) => {
        let done = false;
        const t = setTimeout(() => !done && res(null), 4000);
        try {
          objs.get(im.objId, (d) => {
            done = true;
            clearTimeout(t);
            res(d);
          });
        } catch (e) {
          try {
            done = true;
            clearTimeout(t);
            res(objs.get(im.objId));
          } catch (e2) {
            res(null);
          }
        }
      });
    }
    let canvas = null;
    if (data) {
      canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (data.bitmap) {
        canvas.width = data.bitmap.width;
        canvas.height = data.bitmap.height;
        ctx.drawImage(data.bitmap, 0, 0);
      } else if (data.data && data.width) {
        canvas.width = data.width;
        canvas.height = data.height;
        const out = ctx.createImageData(data.width, data.height);
        const src = data.data,
          dst = out.data,
          n = data.width * data.height;
        if (data.kind === 3) dst.set(src.subarray(0, n * 4));
        else if (data.kind === 2) {
          for (let p = 0, s = 0; p < n; p++, s += 3) {
            dst[p * 4] = src[s];
            dst[p * 4 + 1] = src[s + 1];
            dst[p * 4 + 2] = src[s + 2];
            dst[p * 4 + 3] = 255;
          }
        } else if (data.kind === 1) {
          const rowBytes = (data.width + 7) >> 3;
          for (let y = 0; y < data.height; y++)
            for (let x = 0; x < data.width; x++) {
              const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
              const v = bit ? 255 : 0,
                p = (y * data.width + x) * 4;
              dst[p] = dst[p + 1] = dst[p + 2] = v;
              dst[p + 3] = 255;
            }
        } else canvas = null;
        if (canvas) ctx.putImageData(out, 0, 0);
      } else if (data instanceof HTMLCanvasElement || data instanceof HTMLImageElement) {
        canvas.width = data.width;
        canvas.height = data.height;
        ctx.drawImage(data, 0, 0);
      } else canvas = null;
    }
    if (!canvas) {
      // fall back to cutting the area out of a rendered page
      const vp = page.getViewport({ scale: 3 });
      const full = document.createElement('canvas');
      full.width = vp.width;
      full.height = vp.height;
      await page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise;
      const b = im.bbox;
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(b.w * 3));
      canvas.height = Math.max(1, Math.round(b.h * 3));
      canvas.getContext('2d').drawImage(full, -b.x * 3, -b.y * 3);
      return { canvas, cropped: true };
    }
    return { canvas, cropped: false };
  };

  /** Make an asset from a PDF image so it can be moved/resized/exported. */
  PE.materializeBaseImage = async function (docId, i, im) {
    const { canvas, cropped } = await PE.baseImagePixels(docId, i, im);
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = true;
    for (let k = 3; k < d.length; k += 4 * 7)
      if (d[k] < 250) {
        opaque = false;
        break;
      }
    const mime = opaque ? 'image/jpeg' : 'image/png';
    const bytes = await PE.canvasToBytes(canvas, mime, 0.92);
    const id = PE.uid('a');
    PE.addAssetRaw(id, bytes, mime, canvas.width, canvas.height);
    return { assetId: id, cropped };
  };

  /** Immediate-predecessor graph used to push content down when a block grows. */
  PE.buildPreds = function (ex) {
    if (ex.preds) return ex.preds;
    const els = [];
    for (const b of ex.blocks) els.push({ id: b.id, l: b.x, r: b.x + b.w, t: b.top, btm: b.top + b.h });
    for (const im of ex.images) {
      if (im.bbox.w > ex.W * 0.9 && im.bbox.h > ex.H * 0.9) continue; // page backgrounds don't move
      els.push({ id: im.id, l: im.bbox.x, r: im.bbox.x + im.bbox.w, t: im.bbox.y, btm: im.bbox.y + im.bbox.h });
    }
    for (const g of ex.graphics || []) els.push({ id: g.id, l: g.x, r: g.x + Math.max(g.w, 0.6), t: g.y, btm: g.y + Math.max(g.h, 0.6), g: true });
    els.sort((a, b) => a.t - b.t);
    const ov = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.3;
    const preds = {};
    for (const e of els) {
      const C = els.filter((p) => p !== e && p.btm <= e.t + 2 && ov(p, e)).sort((a, b) => b.btm - a.btm);
      const res = [];
      for (let i = 0; i < C.length; i++) {
        const p = C[i];
        let shadowed = false;
        for (let j = 0; j < i && !shadowed; j++) {
          const q = C[j];
          if (q.t >= p.btm - 1 && ov(p, q)) shadowed = true;
        }
        if (!shadowed) res.push(p.id);
        if (res.length > 40) break;
      }
      preds[e.id] = res;
    }
    ex.order = els.map((e) => e.id);
    ex.preds = preds;
    return preds;
  };
})();
