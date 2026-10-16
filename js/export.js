/* Edivora — builds the final PDF with pdf-lib
 * Pages are copied from the original files (text stays vector and selectable), edits are drawn on top.
 * Text positions come from the browser's own layout of the same fonts, so the file matches the screen.
 */
'use strict';
(function () {
  const V = PE.view;
  const { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFStream, degrees, StandardFonts, BlendMode, LineCapStyle } = PDFLib;

  /* ---------- measuring text as laid out on screen ---------- */
  const ZW = /[​-‍︀-️]/g;

  async function coverage(id) {
    const f = await PE.fonts.fontkitFont(id);
    return (cp) => f.hasGlyphForCodePoint(cp);
  }

  /**
   * Lay out an element (text box, PDF text block, table) off-screen at scale 1 and return
   * one segment per word with its font, size, colour and position relative to the element.
   */
  async function measure(el, ctx) {
    const c = el.cloneNode(true);
    c.style.left = '0px';
    c.style.top = '0px';
    c.style.transform = 'none';
    c.style.position = 'absolute';
    c.style.opacity = '';
    c.classList.remove('editing', 'is-editing');
    c.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    c.removeAttribute('contenteditable');
    V.measureHost.appendChild(c);
    const base = c.getBoundingClientRect();
    const segs = [];
    const cells = [];
    try {
      c.querySelectorAll('td').forEach((td) => {
        const r = td.getBoundingClientRect();
        cells.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height, bg: td.style.background || td.style.backgroundColor });
      });
      const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let node;
      while ((node = walker.nextNode())) {
        const txt = node.nodeValue;
        if (!txt) continue;
        const span = node.parentNode.closest('span') || node.parentNode;
        const st = spanRun(span);
        const prim = PE.fonts.fontId(st.f, st.b, st.i);
        const covPrim = await ctx.cov(prim);
        let pos = 0;
        let cur = null;
        for (const g of PE.graphemes(txt)) {
          const start = pos;
          pos += g.length;
          const clean = g.replace(ZW, '');
          const isSpace = !clean.trim();
          range.setStart(node, start);
          range.setEnd(node, pos);
          const rects = range.getClientRects();
          const r = rects[0];
          if (isSpace || !r) {
            if (cur && st.u && r) {
              cur.uRight = r.right - base.left;
            }
            cur = null;
            continue;
          }
          // which font draws this character (same order as the CSS font stack)
          let fid = prim;
          const cps = Array.from(clean).map((ch) => ch.codePointAt(0));
          if (!cps.every(covPrim)) {
            fid = null;
            for (const fb of PE.fonts.FALLBACKS) {
              const id = PE.fonts.fontId(fb.key, st.b, false);
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
          const top = r.top - base.top;
          if (!cur || cur.fid !== fid || Math.abs(cur.top - top) > 1.5 || r.left < cur.right - 1.5) {
            const famKey = fid.replace(/-(r|b|i|bi)$/, '');
            const m = PE.fonts.metrics(famKey, st.b, PE.fonts.famByKey[famKey] ? st.i : false);
            cur = {
              t: '',
              fid,
              x: r.left - base.left,
              top,
              baseline: top + m.asc * st.s,
              right: r.right - base.left,
              s: st.s,
              c: st.c,
              u: st.u,
            };
            segs.push(cur);
          }
          cur.t += clean;
          cur.right = r.right - base.left;
          cur.uRight = cur.right;
        }
      }
    } finally {
      c.remove();
    }
    return { segs, cells, w: base.width, h: base.height };
  }
  function spanRun(span) {
    const st = span.style || {};
    const fam = ((st.fontFamily || '').match(/PEF-([a-z-]+)/) || [])[1] || 'arimo';
    const rgb = (st.color || '').match(/\d+/g);
    return {
      f: PE.fonts.famByKey[fam] ? fam : 'arimo',
      b: st.fontWeight === '700' || st.fontWeight === 'bold',
      i: st.fontStyle === 'italic',
      u: /underline/.test(st.textDecoration || st.textDecorationLine || ''),
      s: parseFloat(st.fontSize) || 12,
      c: rgb ? PE.rgbToHex(+rgb[0], +rgb[1], +rgb[2]) : '#000000',
    };
  }

  /* ---------- drawing helpers ---------- */
  function push(page, m) {
    page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]));
  }
  function pop(page) {
    page.pushOperators(PDFLib.popGraphicsState());
  }
  /** matrix mapping an object's local frame (origin top-left, y up) into PDF user space */
  function objMatrix(B2U, x, y, w, h, rot) {
    return PE.M.chain(B2U, PE.M.tr(x + w / 2, y + h / 2), PE.M.rot(rot || 0), PE.M.tr(-w / 2, -h / 2), PE.M.sc(1, -1));
  }

  async function font(ctx, id) {
    if (!ctx.fontCache[id]) {
      ctx.fontCache[id] = (async () => {
        const bytes = await PE.fonts.loadBytes(id);
        // fontkit's subsetter mishandles fonts with a long 'loca' table; embed those whole
        let subset = true;
        try {
          const fk = await PE.fonts.fontkitFont(id);
          if (fk.head && fk.head.indexToLocFormat === 1) subset = false;
        } catch (e) {}
        return ctx.out.embedFont(bytes, { subset });
      })();
    }
    return ctx.fontCache[id];
  }
  async function image(ctx, assetId) {
    if (!ctx.imgCache[assetId]) {
      const a = PE.assets[assetId];
      ctx.imgCache[assetId] = a.mime === 'image/jpeg' ? ctx.out.embedJpg(a.bytes) : ctx.out.embedPng(a.bytes);
    }
    return ctx.imgCache[assetId];
  }

  async function drawSegs(ctx, page, segs, opacity) {
    const opts = opacity != null && opacity < 1 ? { opacity } : {};
    // underline: join consecutive underlined words on a line
    for (const s of segs) {
      const f = await font(ctx, s.fid);
      try {
        page.drawText(s.t, Object.assign({ x: s.x, y: -s.baseline, size: s.s, font: f, color: PE.pdfColor(s.c) }, opts));
      } catch (e) {
        ctx.missing++;
      }
    }
    let run = null;
    const flush = () => {
      if (!run) return;
      const th = Math.max(0.5, run.s * 0.06);
      page.drawLine(
        Object.assign(
          { start: { x: run.x, y: -run.baseline - run.s * 0.12 }, end: { x: run.r, y: -run.baseline - run.s * 0.12 }, thickness: th, color: PE.pdfColor(run.c) },
          opts
        )
      );
      run = null;
    };
    for (const s of segs) {
      if (!s.u) {
        flush();
        continue;
      }
      if (run && Math.abs(run.baseline - s.baseline) < 1 && run.c === s.c) run.r = s.uRight || s.right;
      else {
        flush();
        run = { x: s.x, r: s.uRight || s.right, baseline: s.baseline, s: s.s, c: s.c };
      }
    }
    flush();
  }

  async function drawTextEl(ctx, page, B2U, el, box, rot, opacity) {
    const m = await measure(el, ctx);
    push(page, objMatrix(B2U, box.x, box.y, box.w || m.w, box.h || m.h, rot));
    await drawSegs(ctx, page, m.segs, opacity);
    pop(page);
  }

  async function drawObj(ctx, page, B2U, pg, o, el) {
    const op = o.op != null && o.op < 1 ? o.op : undefined;
    if (o.type === 'text') {
      if (!el) return;
      if (!o.runs.map((r) => r.t).join('').trim()) return;
      const w = o.virtual ? o.w : el.offsetWidth,
        h = o.virtual ? o.h : el.offsetHeight;
      return drawTextEl(ctx, page, B2U, el, { x: o.x, y: o.y, w, h }, o.rot, op);
    }
    if (o.type === 'table') {
      if (!el) return;
      if (o.cover) {
        push(page, PE.M.mul(B2U, PE.M.sc(1, -1)));
        page.drawRectangle({ x: o.cover.x, y: -(o.cover.y + o.cover.h), width: o.cover.w, height: o.cover.h, color: PE.pdfColor(o.cover.c || '#ffffff') });
        pop(page);
      }
      const m = await measure(el, ctx);
      push(page, objMatrix(B2U, o.x, o.y, m.w, m.h, o.rot));
      const bw = o.bw != null ? o.bw : 1;
      for (const c of m.cells) {
        const bg = c.bg && c.bg.match(/\d+/g);
        if (bg) page.drawRectangle({ x: c.x, y: -(c.y + c.h), width: c.w, height: c.h, color: PDFLib.rgb(bg[0] / 255, bg[1] / 255, bg[2] / 255) });
      }
      await drawSegs(ctx, page, m.segs, op);
      if (bw > 0)
        for (const c of m.cells)
          page.drawRectangle({ x: c.x, y: -(c.y + c.h), width: c.w, height: c.h, borderColor: PE.pdfColor(o.border || '#000'), borderWidth: bw });
      pop(page);
      return;
    }
    if (o.type === 'image') {
      const a = PE.assets[o.a];
      if (!a) return;
      const img = await image(ctx, o.a);
      let M = objMatrix(B2U, o.x, o.y, o.w, o.h, o.rot);
      if (o.flipX) M = PE.M.mul(M, [-1, 0, 0, 1, o.w, 0]);
      if (o.flipY) M = PE.M.mul(M, [1, 0, 0, -1, 0, -o.h]);
      push(page, M);
      page.drawImage(img, Object.assign({ x: 0, y: -o.h, width: o.w, height: o.h }, op != null ? { opacity: op } : {}));
      pop(page);
      return;
    }
    const blend = o.blend === 'multiply' ? { blendMode: BlendMode.Multiply } : {};
    if (o.type === 'shape') {
      push(page, objMatrix(B2U, o.x, o.y, o.w, o.h, o.rot));
      const sw = o.stroke ? o.sw || 0 : 0;
      const common = Object.assign({}, blend);
      if (op != null) Object.assign(common, { opacity: op, borderOpacity: op });
      if (o.shape === 'rect')
        page.drawRectangle(
          Object.assign(
            {
              x: sw / 2,
              y: -o.h + sw / 2,
              width: Math.max(0, o.w - sw),
              height: Math.max(0, o.h - sw),
              color: o.fill ? PE.pdfColor(o.fill) : undefined,
              borderColor: sw ? PE.pdfColor(o.stroke) : undefined,
              borderWidth: sw || undefined,
            },
            common
          )
        );
      else if (o.shape === 'ellipse')
        page.drawEllipse(
          Object.assign(
            {
              x: o.w / 2,
              y: -o.h / 2,
              xScale: Math.max(0.1, o.w / 2 - sw / 2),
              yScale: Math.max(0.1, o.h / 2 - sw / 2),
              color: o.fill ? PE.pdfColor(o.fill) : undefined,
              borderColor: sw ? PE.pdfColor(o.stroke) : undefined,
              borderWidth: sw || undefined,
            },
            common
          )
        );
      else
        page.drawSvgPath(
          V.symbolPath(o.shape, o.w, o.h),
          Object.assign({ x: 0, y: 0, borderColor: PE.pdfColor(o.stroke || '#000'), borderWidth: o.sw || 2, borderLineCap: LineCapStyle.Round }, common)
        );
      pop(page);
      return;
    }
    if (o.type === 'line') {
      push(page, objMatrix(B2U, o.x, o.y, o.w, o.h, 0));
      page.drawSvgPath(
        V.linePath(o, V.linePoints(o)),
        Object.assign(
          { x: 0, y: 0, borderColor: PE.pdfColor(o.stroke), borderWidth: o.sw || 1, borderLineCap: LineCapStyle.Round },
          op != null ? { borderOpacity: op } : {}
        )
      );
      pop(page);
      return;
    }
    if (o.type === 'ink') {
      push(page, objMatrix(B2U, o.x, o.y, o.w, o.h, o.rot));
      const kx = o.w / o.w0,
        ky = o.h / o.h0;
      for (const st of o.strokes) {
        const pts = st.map((p) => [p[0] * kx, p[1] * ky]);
        page.drawSvgPath(
          V.inkPath(pts),
          Object.assign(
            { x: 0, y: 0, borderColor: PE.pdfColor(o.stroke), borderWidth: o.sw, borderLineCap: LineCapStyle.Round },
            op != null ? { borderOpacity: op } : {},
            blend
          )
        );
      }
      pop(page);
    }
  }

  /* ---------- page modes ---------- */
  async function rasterize(pg, redacts) {
    const { W, H } = PE.baseSize(pg);
    const s = 200 / 72;
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * s);
    cv.height = Math.round(H * s);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (pg.src.t === 'pdf') {
      const page = await PE.getPdfPage(pg.src.doc, pg.src.i);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: s }), annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    } else if (pg.src.t === 'img') {
      const im = await V.loadImg(PE.assets[pg.src.a].url);
      ctx.drawImage(im, 0, 0, cv.width, cv.height);
    }
    ctx.fillStyle = '#000';
    for (const r of redacts) {
      ctx.save();
      ctx.translate((r.x + r.w / 2) * s, (r.y + r.h / 2) * s);
      ctx.rotate(((r.rot || 0) * Math.PI) / 180);
      ctx.fillRect((-r.w / 2) * s, (-r.h / 2) * s, r.w * s, r.h * s);
      ctx.restore();
    }
    return PE.canvasToBytes(cv, 'image/jpeg', 0.9);
  }

  async function libDoc(ctx, docId, fresh) {
    const key = docId + (fresh ? ':copy' : '');
    if (ctx.libDocs[key] !== undefined) return ctx.libDocs[key];
    try {
      ctx.libDocs[key] = await PDFDocument.load(PE.docs[docId].bytes, { updateMetadata: false });
    } catch (e) {
      console.warn('pdf-lib could not open', docId, e);
      ctx.libDocs[key] = null; // encrypted or damaged: pages from it are saved as images
    }
    return ctx.libDocs[key];
  }

  /** Make sure every page with edits has its PDF content read and laid out. */
  async function prepare(pages) {
    for (const pg of pages) {
      const needs = (pg.src.t === 'pdf' && (Object.keys(pg.ov).length || (PE.S.ocr && PE.S.ocr[PE.pageKey(pg)]))) || (pg.src.t === 'img' && Object.keys(pg.ov).length);
      if (needs) {
        if (pg.src.t === 'pdf') await PE.extractPage(pg.src.doc, pg.src.i);
        else PE.ocr && PE.ocr.ensureImageEx(pg);
        V.renderOverlay(pg);
      }
    }
    const runs = [];
    for (const pg of pages) {
      for (const o of pg.objs) if (o.runs) runs.push(...o.runs);
      for (const id in pg.ov) if (pg.ov[id].runs) runs.push(...pg.ov[id].runs);
    }
    await PE.fonts.ensureRuns(runs);
    await PE.fonts.allLoaded();
    await document.fonts.ready;
    await PE.raf();
    for (const pg of pages) V.renderOverlay(pg);
  }

  PE.exportPdf = async function (opts = {}) {
    if (PE.tools.editing) PE.tools.stopEditing();
    PE.commit();
    const ids = opts.pageIds ? new Set(opts.pageIds) : null;
    const pages = PE.S.pages.filter((p) => !ids || ids.has(p.id));
    if (!pages.length) throw new Error('There are no pages to save.');
    const progress = opts.onProgress || (() => {});
    progress(0, 'Preparing pages');
    await prepare(pages);

    const ctx = { libDocs: {}, fontCache: {}, imgCache: {}, missing: 0, covCache: {}, out: null };
    ctx.cov = async (id) => {
      if (!ctx.covCache[id]) ctx.covCache[id] = coverage(id);
      return ctx.covCache[id];
    };
    const primaryId = PE.app.primary && PE.docs[PE.app.primary] ? PE.app.primary : null;
    let out = primaryId ? await libDoc(ctx, primaryId) : null;
    if (out) delete ctx.libDocs[primaryId]; // `out` is modified; copies of its pages come from a fresh load
    const primaryLoaded = !!out;
    if (!out) out = await PDFDocument.create();
    ctx.out = out;
    out.registerFontkit(fontkit);
    const origPages = primaryLoaded ? out.getPages() : [];
    for (let k = out.getPageCount() - 1; k >= 0; k--) out.removePage(k);
    const used = new Set();

    for (let n = 0; n < pages.length; n++) {
      const pg = pages[n];
      progress(n / pages.length, `Saving page ${n + 1} of ${pages.length}`);
      const { W, H, srcRot } = PE.baseSize(pg);
      const redacts = pg.objs.filter((o) => o.redact);
      let page,
        B2U,
        mode = 'pdf';
      if (pg.src.t === 'pdf') {
        const src = primaryLoaded && pg.src.doc === primaryId && !used.has(pg.src.i) ? 'orig' : 'copy';
        let srcDoc = null;
        if (src === 'copy') srcDoc = await libDoc(ctx, pg.src.doc, pg.src.doc === primaryId);
        if (redacts.length || (src === 'copy' && !srcDoc)) mode = 'raster';
        else if (src === 'orig') {
          page = origPages[pg.src.i];
          used.add(pg.src.i);
          out.addPage(page);
        } else {
          [page] = await out.copyPages(srcDoc, [pg.src.i]);
          out.addPage(page);
        }
        if (mode === 'pdf') {
          const pjs = await PE.getPdfPage(pg.src.doc, pg.src.i);
          B2U = PE.M.inv(pjs.getViewport({ scale: 1 }).transform);
          page.setRotation(degrees((srcRot + pg.rot) % 360));
        }
      } else if (redacts.length && pg.src.t === 'img') mode = 'raster';
      else mode = pg.src.t;

      if (mode === 'raster' || mode === 'blank' || mode === 'img') {
        page = out.addPage([W, H]);
        B2U = [1, 0, 0, -1, 0, H];
        page.setRotation(degrees(pg.rot % 360));
        if (mode === 'raster') {
          const bytes = await rasterize(pg, redacts);
          const img = await out.embedJpg(bytes);
          page.drawImage(img, { x: 0, y: 0, width: W, height: H });
        } else if (mode === 'img') {
          const img = await image(ctx, pg.src.a);
          page.drawImage(img, { x: 0, y: 0, width: W, height: H });
        }
      }

      const pv = V.els.get(pg.id);
      // cover original content that was edited, moved or deleted
      if (mode === 'pdf' || mode === 'raster' || mode === 'img') {
        const rects = V.coverRects(pg);
        if (rects.length) {
          push(page, PE.M.mul(B2U, PE.M.sc(1, -1)));
          for (const r of rects) {
            if (r.a) page.drawImage(await image(ctx, r.a), { x: r.x, y: -(r.y + r.h), width: r.w, height: r.h });
            else page.drawRectangle({ x: r.x, y: -(r.y + r.h), width: r.w, height: r.h, color: PE.pdfColor(r.c || '#ffffff') });
          }
          pop(page);
        }
        const ex = (pg.src.t === 'pdf' || pg.src.t === 'img') && PE.ex[PE.pageKey(pg)];
        if (ex && pv && pv.baseEls) {
          const shift = pv.shift || {};
          for (const im of ex.images) {
            const ov = pg.ov[im.id];
            const sh = shift[im.id] || 0;
            if (!(ov || sh) || (ov && ov.del)) continue;
            const g = Object.assign({ x: im.x, y: im.y, w: im.w, h: im.h, rot: im.rot, flipX: false, flipY: im.flipY }, ov || {});
            if (!(ov && ov.pinned)) g.y += sh;
            const a = (ov && ov.a) || (await V.ensureBaseImageAsset(pg, im));
            await drawObj(ctx, page, B2U, pg, { type: 'image', a, x: g.x, y: g.y, w: g.w, h: g.h, rot: g.rot, flipX: g.flipX, flipY: g.flipY });
          }
          const gpos = pv.gpos || {};
          if (Object.keys(gpos).length) {
            push(page, PE.M.mul(B2U, PE.M.sc(1, -1)));
            for (const id in gpos) {
              const r = gpos[id];
              page.drawRectangle({ x: r.x, y: -(r.y + r.h), width: r.w, height: r.h, color: PE.pdfColor(r.c) });
            }
            pop(page);
          }
          for (const b of ex.blocks) {
            const ov = pg.ov[b.id];
            if (!(ov || shift[b.id]) || (ov && ov.del)) continue;
            const el = pv.baseEls[b.id];
            if (!el || !el.classList.contains('mat')) continue;
            await drawTextEl(ctx, page, B2U, el, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }, 0);
          }
          // recognised text that wasn't edited: invisible, so the saved PDF can be searched and copied
          if (PE.ocr && mode !== 'raster')
            for (const b of ex.blocks)
              if (b.ocr && !pg.ov[b.id] && !shift[b.id])
                try {
                  await PE.ocr.drawInvisible(page, B2U, b, (id) => font(ctx, id));
                } catch (e) {
                  console.warn('ocr text layer', e);
                }
        }
      }
      for (const o of pg.objs) await drawObj(ctx, page, B2U, pg, o, pv && pv.objs.querySelector(`[data-oid="${o.id}"]`));
      const idx = PE.pageIndex(pg.id);
      for (const o of V.virtualObjs(pg, idx)) await drawObj(ctx, page, B2U, pg, o, pv && pv.virt.querySelector(`[data-oid="${o.id}"]`));
    }

    // pages of the original file that were deleted: strip their content so it can't be recovered
    const removed = origPages.filter((p, i) => !used.has(i));
    for (const p of removed) {
      for (const k of ['Contents', 'Resources', 'Annots', 'Thumb']) p.node.delete(PDFName.of(k));
    }
    if (removed.length) pruneForm(out, new Set(removed.map((p) => p.ref.tag)));
    applyForm(out, ctx);
    progress(0.96, 'Writing file');
    const meta = PE.S.meta;
    if (meta.title) out.setTitle(meta.title);
    if (meta.author) out.setAuthor(meta.author);
    out.setProducer('Edivora');
    out.setModificationDate(new Date());
    if (typeof out.flush === 'function') await out.flush();
    collectGarbage(out);
    const bytes = await out.save({ useObjectStreams: true });
    progress(1, 'Done');
    return { bytes, missing: ctx.missing };
  };

  function applyForm(out, ctx) {
    const vals = PE.S.form || {};
    if (!Object.keys(vals).length) return;
    let form;
    try {
      form = out.getForm();
    } catch (e) {
      return;
    }
    for (const name in vals) {
      try {
        const f = form.getField(name);
        const v = vals[name];
        const L = PDFLib;
        if (f instanceof L.PDFTextField) f.setText(String(v));
        else if (f instanceof L.PDFCheckBox) v ? f.check() : f.uncheck();
        else if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList) v ? f.select(String(v)) : f.clear();
        else if (f instanceof L.PDFRadioGroup) v ? f.select(String(v)) : f.clear();
      } catch (e) {
        console.warn('form field', name, e);
      }
    }
    try {
      form.updateFieldAppearances();
    } catch (e) {
      console.warn('field appearances', e);
    }
  }

  function pruneForm(out, removedTags) {
    try {
      const form = out.getForm();
      for (const f of form.getFields()) {
        const ws = f.acroField.getWidgets();
        if (ws.length && ws.every((w) => w.P() && removedTags.has(w.P().tag))) form.removeField(f);
      }
    } catch (e) {}
  }

  /** drop objects nothing points to (keeps the file small, removes deleted pages' data) */
  function collectGarbage(doc) {
    const ctx = doc.context;
    const seen = new Set();
    const stack = [];
    const visit = (v) => {
      if (!v) return;
      if (v instanceof PDFRef) {
        if (seen.has(v.tag)) return;
        seen.add(v.tag);
        const o = ctx.lookup(v);
        if (o) stack.push(o);
      } else stack.push(v);
    };
    visit(ctx.trailerInfo.Root);
    visit(ctx.trailerInfo.Info);
    visit(ctx.trailerInfo.Encrypt);
    while (stack.length) {
      const o = stack.pop();
      if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v);
      else if (o instanceof PDFArray) for (const v of o.asArray()) visit(v);
      else if (o instanceof PDFStream) visit(o.dict);
    }
    for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
  }

  // shared with the Word document export
  PE.exportKit = { font, coverage, drawSegs, push, pop, ZW };

  /* ---------- images of pages ---------- */
  PE.renderPdfBytesPage = async function (bytes, index, scale) {
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const page = await pdf.getPage(index + 1);
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const c = cv.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: c, viewport: vp }).promise;
    pdf.destroy();
    return cv;
  };
})();
