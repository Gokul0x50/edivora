/* Pagewright — start-up, opening files, keyboard, drag & drop, saving */
'use strict';
(function () {
  const V = PE.view,
    T = PE.tools,
    U = PE.ui;
  const A = PE.app;
  const $ = PE.$;

  A.setFileName = function (n) {
    n = (n || '').trim() || 'document.pdf';
    if (!/\.pdf$/i.test(n)) n += '.pdf';
    A.fileName = n;
    $('#file-name').value = n;
    $('#file-name').style.width = Math.min(46, n.length + 3) + 'ch';
    document.title = n.replace(/\.pdf$/i, '') + ' · Pagewright';
  };

  function resetAll() {
    if (T.editing) T.stopEditing();
    T.sel = [];
    for (const id in PE.docs) {
      try {
        PE.docs[id].pdf.destroy();
      } catch (e) {}
    }
    for (const id in PE.assets) URL.revokeObjectURL(PE.assets[id].url);
    PE.docs = {};
    PE.assets = {};
    PE.ex = {};
    V.imgCache = {};
    A.formFields = null;
    A.primary = null;
    A.dirty = false;
    PE.S = PE.newState();
    U.pageSel.clear();
    U.closeFind && U.closeFind();
    V.sync();
  }

  async function openPdfBytes(bytes, name) {
    let attempt = 0;
    return PE.openPdf(bytes, name, async (reason) => {
      attempt++;
      return U.askPassword(name, reason === 2 || attempt > 1);
    });
  }
  function pagesOf(docId) {
    const d = PE.docs[docId];
    return Array.from({ length: d.n }, (_, i) => ({ id: PE.uid('p'), src: { t: 'pdf', doc: docId, i }, rot: 0, objs: [], ov: {} }));
  }
  async function imagePage(file) {
    const id = await PE.addAsset(await PE.readFile(file), file.type);
    const a = PE.assets[id];
    // fit to A4 width, keep the image's shape
    const w = 595.28,
      hgt = (a.h / a.w) * w;
    return { id: PE.uid('p'), src: { t: 'img', a: id, w, h: hgt }, rot: 0, objs: [], ov: {} };
  }

  async function startDoc(fresh) {
    $('#app').classList.remove('no-doc');
    document.body.classList.remove('pages-open');
    V.sync();
    await PE.raf();
    V.fitWidth();
    if (V.zoom > 1.6) V.setZoom(1.6);
    V.scroller.scrollTop = 0;
    if (fresh) PE.hist.reset();
    U.refreshAll();
    T.setTool('edit');
    detectForms();
  }

  /** Open files as a new document (first PDF/image starts it, the rest are appended). */
  A.openFiles = async function (files) {
    files = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name) || /^image\//.test(f.type));
    if (!files.length) return PE.toast('Choose a PDF or an image file.', 'warn');
    if (PE.S.pages.length && A.dirty) {
      const ok = await U.confirm('Open another file?', `Your changes to ${A.fileName} will be lost unless you download it first.`, 'Open file', true);
      if (!ok) return;
    }
    U.busy(true, 'Opening ' + files[0].name, 0.1);
    try {
      resetAll();
      await PE.clearSession();
      const pages = [];
      for (const f of files) {
        if (/^image\//.test(f.type)) pages.push(await imagePage(f));
        else {
          const id = await openPdfBytes(await PE.readFile(f), f.name);
          if (!A.primary) A.primary = id;
          pages.push(...pagesOf(id));
        }
      }
      PE.S.pages = pages;
      A.setFileName(files[0].name.replace(/\.[^.]+$/, '') + '.pdf');
      const d = A.primary && PE.docs[A.primary];
      if (d)
        try {
          const meta = await d.pdf.getMetadata();
          PE.S.meta.title = (meta.info && meta.info.Title) || '';
          PE.S.meta.author = (meta.info && meta.info.Author) || '';
        } catch (e) {}
      await startDoc(true);
      if (d && d.encrypted) PE.toast('This PDF is protected. Pages you download from it will be saved as images.', 'warn', 6000);
    } catch (e) {
      console.error(e);
      resetAll();
      $('#app').classList.add('no-doc');
      if (e && /destroy|cancel/i.test(e.message || '')) PE.toast('Opening cancelled.');
      else PE.toast('This file could not be opened. ' + (e.message || ''), 'error', 6000);
    } finally {
      U.busy(false);
    }
  };

  /** Insert PDFs/images into the current document at a position. Returns pages added. */
  A.addFiles = async function (files, at) {
    let added = 0;
    U.busy(true, 'Adding files', 0.2);
    try {
      const pages = [];
      for (const f of files) {
        if (/^image\//.test(f.type)) pages.push(await imagePage(f));
        else if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
          const id = await openPdfBytes(await PE.readFile(f), f.name);
          if (!A.primary) A.primary = id;
          pages.push(...pagesOf(id));
        }
      }
      PE.S.pages.splice(at, 0, ...pages);
      added = pages.length;
    } catch (e) {
      console.error(e);
      PE.toast('A file could not be added. ' + (e.message || ''), 'error');
    } finally {
      U.busy(false);
    }
    return added;
  };

  A.openPicker = async function () {
    const files = await PE.pickFiles('application/pdf,.pdf,image/*', true);
    if (files.length) A.openFiles(files);
  };

  A.newBlank = async function () {
    resetAll();
    await PE.clearSession();
    PE.S.pages = [{ id: PE.uid('p'), src: { t: 'blank', w: 595.28, h: 841.89 }, rot: 0, objs: [], ov: {} }];
    A.setFileName('Untitled.pdf');
    await startDoc(true);
    T.setTool('text');
  };

  A.closeDoc = async function () {
    if (A.dirty) {
      const ok = await U.confirm('Close this document?', 'Changes you have not downloaded will be lost.', 'Close', true);
      if (!ok) return;
    }
    resetAll();
    await PE.clearSession();
    $('#app').classList.add('no-doc');
    PE.hist.reset();
    U.refreshAll();
    checkRestore();
  };

  A.download = async function (opts = {}) {
    if (!PE.S.pages.length) return;
    U.busy(true, 'Preparing your PDF', 0.02);
    try {
      const { bytes, missing } = await PE.exportPdf({ pageIds: opts.pageIds, onProgress: (f, t) => U.busy(true, t, f) });
      const name = opts.name || A.fileName;
      PE.download(bytes, name);
      if (!opts.pageIds) {
        A.dirty = false;
        U.updateHistoryButtons();
      }
      if (missing) PE.toast(`Downloaded. ${missing} character(s) such as emoji are not in the bundled fonts and were left out.`, 'warn', 7000);
      else if (!opts.quiet) PE.toast('Downloaded ' + name, 'ok');
    } catch (e) {
      console.error(e);
      PE.toast('Could not create the PDF: ' + (e.message || e), 'error', 7000);
    } finally {
      U.busy(false);
    }
  };

  /* ---------- sample document (built in the browser) ---------- */
  A.sample = async function () {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const hb = await doc.embedFont(StandardFonts.HelveticaBold);
    const hr = await doc.embedFont(StandardFonts.Helvetica);
    const tr = await doc.embedFont(StandardFonts.TimesRoman);
    const ti = await doc.embedFont(StandardFonts.TimesRomanItalic);
    const cr = await doc.embedFont(StandardFonts.Courier);
    const ink = rgb(0.09, 0.12, 0.17),
      blue = rgb(0.12, 0.25, 0.81),
      grey = rgb(0.4, 0.44, 0.5);
    page.drawRectangle({ x: 0, y: 781.89, width: 595.28, height: 60, color: rgb(0.93, 0.95, 0.99) });
    page.drawText('Northwind Field Report', { x: 56, y: 800, size: 24, font: hb, color: ink });
    page.drawText('Quarterly site inspection  ·  Chennai depot', { x: 56, y: 760, size: 11, font: hr, color: grey });
    const para = (lines, y, font, size, color, lead) => {
      lines.forEach((l, i) => page.drawText(l, { x: 56, y: y - i * lead, size, font, color }));
      return y - lines.length * lead;
    };
    let y = 720;
    page.drawText('Summary', { x: 56, y, size: 15, font: hb, color: blue });
    y -= 22;
    y = para(
      [
        'The depot passed all safety checks this quarter. Loading bays two and three',
        'were resurfaced in August, and the new cold-storage unit is now in service.',
        'Click any line of this paragraph to edit it, then press Enter a few times:',
        'everything below moves down to make room, just like a word processor.',
      ],
      y,
      tr,
      12,
      ink,
      16
    );
    y -= 18;
    page.drawText('Inspection results', { x: 56, y, size: 15, font: hb, color: blue });
    y -= 26;
    const cols = [56, 226, 356, 456],
      rowsT = [
        ['Area', 'Inspector', 'Score', 'Status'],
        ['Loading bays', 'R. Kumar', '94', 'Passed'],
        ['Cold storage', 'A. Iyer', '88', 'Passed'],
        ['Fire exits', 'S. Menon', '97', 'Passed'],
      ];
    const tTop = y + 14;
    rowsT.forEach((r, ri) => {
      r.forEach((c, ci) => page.drawText(c, { x: cols[ci] + 6, y: y - ri * 22, size: 10.5, font: ri ? hr : hb, color: ink }));
    });
    for (let ri = 0; ri <= rowsT.length; ri++)
      page.drawLine({ start: { x: 56, y: tTop - ri * 22 }, end: { x: 540, y: tTop - ri * 22 }, thickness: 0.6, color: grey });
    for (const x of cols.concat([540])) page.drawLine({ start: { x, y: tTop }, end: { x, y: tTop - rowsT.length * 22 }, thickness: 0.6, color: grey });
    y = tTop - rowsT.length * 22 - 30;
    page.drawText('Notes', { x: 56, y, size: 15, font: hb, color: blue });
    y -= 22;
    y = para(['•  Replace two worn dock levellers before the monsoon.', '•  Repaint lane markings near gate 4.', '•  Schedule the next audit for the first week of January.'], y, hr, 11, ink, 17);
    y -= 14;
    // a small chart image
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#f4f6fb';
    g.fillRect(0, 0, 480, 200);
    [62, 88, 74, 94, 97].forEach((v, i) => {
      g.fillStyle = i === 4 ? '#1f3fcf' : '#9fb0ec';
      g.fillRect(40 + i * 86, 180 - v * 1.6, 54, v * 1.6);
    });
    g.fillStyle = '#4b5766';
    g.font = '16px sans-serif';
    g.fillText('Safety score by quarter', 40, 28);
    const png = await doc.embedPng(await PE.canvasToBytes(c));
    page.drawImage(png, { x: 56, y: y - 150, width: 240, height: 100 });
    page.drawText('Click the chart to move, resize or rotate it.', { x: 310, y: y - 70, size: 11, font: ti, color: grey });
    page.drawText('Ref: NW-2026-Q3-CHN', { x: 56, y: 60, size: 9, font: cr, color: grey });
    const bytes = await doc.save();
    const file = new File([bytes], 'Northwind field report.pdf', { type: 'application/pdf' });
    await A.openFiles([file]);
  };

  /* ---------- form fields ---------- */
  async function detectForms() {
    A.formFields = null;
    const d = A.primary && PE.docs[A.primary];
    if (!d) return;
    try {
      const fo = await d.pdf.getFieldObjects();
      if (!fo) return;
      const out = {};
      for (const name in fo) {
        const list = fo[name];
        const f = list.find((x) => x.type) || list[0];
        if (!f || !f.type || f.type === 'button' || f.type === 'signature') continue;
        const entry = { type: f.type, value: f.value, multiline: !!f.multiline, label: name };
        if (f.type === 'radiobutton') entry.options = list.filter((x) => x.exportValues).map((x) => ({ v: x.exportValues, label: x.exportValues }));
        if (f.type === 'combobox' || f.type === 'listbox')
          entry.options = (f.items || []).map((it) => ({ v: it.exportValue, label: it.displayValue || it.exportValue }));
        if (f.type === 'checkbox') entry.on = f.exportValues;
        out[name] = entry;
      }
      if (Object.keys(out).length) {
        A.formFields = out;
        PE.toast(`This PDF has ${Object.keys(out).length} form fields. Type straight into them on the page.`, 'info', 5000);
        V.relayoutAll();
        V.rerenderVisible();
      }
    } catch (e) {
      console.warn('form detection', e);
    }
  }

  /** inputs placed over the PDF's own form fields */
  const annCache = {};
  PE.forms = {
    active: (pg) => !!(A.formFields && pg.src.t === 'pdf' && pg.src.doc === A.primary),
    async render(pg, pv) {
      pv.forms.innerHTML = '';
      if (!PE.forms.active(pg)) return;
      const key = PE.pageKey(pg);
      if (!annCache[key]) {
        const page = await PE.getPdfPage(pg.src.doc, pg.src.i);
        annCache[key] = { anns: await page.getAnnotations(), vp: page.getViewport({ scale: 1 }) };
      }
      const { anns, vp } = annCache[key];
      pv.forms.innerHTML = '';
      for (const a of anns) {
        if (a.subtype !== 'Widget' || !a.fieldName || !A.formFields[a.fieldName] || a.hidden) continue;
        const r = vp.convertToViewportRectangle(a.rect);
        const x = Math.min(r[0], r[2]),
          y = Math.min(r[1], r[3]),
          w = Math.abs(r[2] - r[0]),
          hh = Math.abs(r[3] - r[1]);
        const name = a.fieldName;
        const has = name in PE.S.form;
        const val = has ? PE.S.form[name] : a.fieldValue;
        const st = { left: x + 'px', top: y + 'px', width: w + 'px', height: hh + 'px' };
        let el;
        const set = (v) => {
          PE.S.form[name] = v;
          PE.commit();
          V.relayoutAll();
        };
        if (a.fieldType === 'Tx') {
          el = PE.h(a.multiLine ? 'textarea' : 'input', { class: 'ff ff-text', 'aria-label': a.alternativeText || name, readonly: a.readOnly });
          el.value = val == null ? '' : String(val);
          const fs = a.multiLine ? 10 : PE.clamp(hh * 0.62, 6, 14);
          el.style.fontSize = fs + 'px';
          el.style.textAlign = ['left', 'center', 'right'][a.textAlignment || 0];
          el.addEventListener('change', () => set(el.value));
        } else if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) {
          const onVal = a.radioButton ? a.buttonValue : a.exportValue || 'Yes';
          const checked = a.radioButton ? String(val) === String(onVal) : !!val && val !== 'Off' && val !== false;
          el = PE.h('button', { class: 'ff ff-check' + (checked ? ' on' : '') + (a.radioButton ? ' radio' : ''), type: 'button', 'aria-pressed': checked ? 'true' : 'false', 'aria-label': name });
          el.textContent = checked ? (a.radioButton ? '●' : '✓') : '';
          el.style.fontSize = PE.clamp(hh * 0.8, 6, 18) + 'px';
          el.addEventListener('click', () => set(a.radioButton ? onVal : !checked));
        } else if (a.fieldType === 'Ch') {
          el = PE.h('select', { class: 'ff ff-select', 'aria-label': name });
          el.appendChild(PE.h('option', { value: '' }, ''));
          for (const o of a.options || []) el.appendChild(PE.h('option', { value: o.exportValue, selected: String(val) === String(o.exportValue) }, o.displayValue));
          el.style.fontSize = PE.clamp(hh * 0.6, 6, 13) + 'px';
          el.addEventListener('change', () => set(el.value));
        } else continue;
        Object.assign(el.style, st);
        el.addEventListener('pointerdown', (e) => e.stopPropagation());
        pv.forms.appendChild(el);
      }
    },
  };

  /* ---------- restore unsaved work ---------- */
  async function checkRestore() {
    const s = await PE.idb.get('session');
    const card = $('#restore-card');
    if (!s || !s.keys || !s.keys.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $('#restore-name').textContent = s.fileName || 'Unsaved document';
    const mins = Math.round((Date.now() - s.time) / 60000);
    $('#restore-time').textContent =
      'Last edited ' + (mins < 1 ? 'a moment ago' : mins < 60 ? mins + ' min ago' : mins < 1440 ? Math.round(mins / 60) + ' h ago' : new Date(s.time).toLocaleString()) + '. Pick up where you left off.';
  }
  async function restore() {
    U.busy(true, 'Restoring your work', 0.3);
    try {
      resetAll();
      const ok = await PE.loadSession();
      if (!ok || !PE.S.pages.length) throw new Error('Nothing to restore.');
      A.setFileName(A.fileName);
      await startDoc(true);
      A.dirty = true;
      U.updateHistoryButtons();
      PE.toast('Your unsaved work is back.', 'ok');
    } catch (e) {
      console.error(e);
      resetAll();
      $('#app').classList.add('no-doc');
      PE.toast('Saved work could not be restored. ' + (e.message || ''), 'error');
    } finally {
      U.busy(false);
    }
  }

  /* ---------- keyboard ---------- */
  function onKey(e) {
    if ($('#modal-root').children.length) return;
    const t = e.target;
    const inField = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    const mod = PE.mod(e);
    const k = e.key.toLowerCase();
    if (mod && k === 's') {
      e.preventDefault();
      return A.download();
    }
    if (mod && k === 'o') {
      e.preventDefault();
      return A.openPicker();
    }
    if (mod && k === 'f') {
      e.preventDefault();
      return U.openFind();
    }
    if (!PE.S.pages.length) return;
    if (mod && (k === 'z' || k === 'y') && !T.editing && !inField) {
      e.preventDefault();
      return k === 'y' || e.shiftKey ? PE.redo() : PE.undo();
    }
    if (mod && (k === '=' || k === '+')) {
      e.preventDefault();
      return V.setZoom(V.zoom * 1.2);
    }
    if (mod && k === '-') {
      e.preventDefault();
      return V.setZoom(V.zoom / 1.2);
    }
    if (mod && k === '0') {
      e.preventDefault();
      return V.fitWidth();
    }
    if (inField) return;
    if (k === 'escape') {
      if (!$('#find-bar').hidden) return U.closeFind();
      if (T.sel.length) return T.clearSelection();
      if (T.tool !== 'edit') return T.setTool('edit');
    }
    if ((k === 'delete' || k === 'backspace') && T.sel.length) {
      e.preventDefault();
      return T.deleteSelection();
    }
    if (k.startsWith('arrow') && T.sel.length) {
      e.preventDefault();
      const s = e.shiftKey ? 10 : 1;
      const d = { arrowleft: [-s, 0], arrowright: [s, 0], arrowup: [0, -s], arrowdown: [0, s] }[k];
      const pg = PE.findPage(T.sel[0].pg);
      const [bx, by] = PE.rotVec(d[0], d[1], -pg.rot);
      return T.nudge(bx, by);
    }
    if (mod && k === 'd') {
      e.preventDefault();
      return T.duplicate();
    }
    if (mod && k === 'c') return T.copy();
    if (mod && k === 'x') {
      T.copy();
      return T.deleteSelection();
    }
    if (k === 'enter' && T.sel.length === 1) {
      const it = T.selObjs()[0];
      if (it && it.o && (it.o.type === 'text' || it.o.type === 'table')) {
        e.preventDefault();
        return T.startEditObj(it.pg, it.o, null);
      }
    }
    if (mod || e.altKey) return;
    const tools = { v: 'edit', t: 'text', d: 'pen', h: 'highlight', w: 'whiteout' };
    if (tools[k]) return T.setTool(tools[k]);
    if (k === 'i') return U.insertImage();
  }

  /* ---------- paste & drop ---------- */
  async function onPaste(e) {
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
    if (!PE.S.pages.length || $('#modal-root').children.length) return;
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const img = items.find((i) => i.kind === 'file' && /^image\//.test(i.type));
    if (img) {
      e.preventDefault();
      const f = img.getAsFile();
      return T.insertImageFromBytes(await PE.readFile(f), f.type);
    }
    if (T.clipboard) {
      e.preventDefault();
      return T.paste();
    }
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (text) {
      e.preventDefault();
      const pg = V.currentPage();
      if (!pg) return;
      const c = T.visibleCenter(pg);
      const o = T.createText(pg, [c[0] - 100, c[1]], '');
      T.stopEditing();
      o.runs[0].t = text.replace(/\r\n?/g, '\n');
      o.autoW = false;
      o.w = Math.min(PE.baseSize(pg).W - o.x - 30, 360);
      V.updateObj(pg, o, true);
      PE.commit();
      T.select([{ pg: pg.id, id: o.id }]);
    }
  }
  function setupDrop() {
    let depth = 0;
    const veil = $('#drag-veil');
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      veil.hidden = false;
      veil.querySelector('p').textContent = PE.S.pages.length ? 'Drop PDFs to add pages, or an image to place it' : 'Drop to open';
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) veil.hidden = true;
    });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      veil.hidden = true;
      const files = Array.from(e.dataTransfer.files);
      if (!PE.S.pages.length) return A.openFiles(files);
      const pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
      const imgs = files.filter((f) => /^image\//.test(f.type));
      if (pdfs.length) {
        const cur = V.currentPage();
        const at = cur ? PE.pageIndex(cur.id) + 1 : PE.S.pages.length;
        const n = await A.addFiles(pdfs, at);
        if (n) {
          V.sync();
          PE.commit();
          U.refreshAll();
          PE.toast(`${n} page${n > 1 ? 's' : ''} added after page ${at}.`, 'ok');
        }
      }
      for (const f of imgs) {
        const pg = (e.target.closest && e.target.closest('.page') && PE.findPage(e.target.closest('.page').getAttribute('data-pid'))) || V.currentPage();
        const at = pg && V.els.get(pg.id) && e.target.closest('.page') ? V.clientToBase(pg, e.clientX, e.clientY) : null;
        await T.insertImageFromBytes(await PE.readFile(f), f.type, { pg, at });
      }
    });
  }

  /* ---------- boot ---------- */
  function boot() {
    if (!window.pdfjsLib || !window.PDFLib || !window.fontkit) {
      document.body.innerHTML = '<p style="padding:24px;font:16px system-ui">The editor could not load its libraries. Check that the lib/ folder was uploaded next to index.html.</p>';
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    V.init();
    T.init();
    U.init();
    PE.hist.reset();
    A.setFileName('document.pdf');
    $('#file-name').addEventListener('change', (e) => {
      A.setFileName(e.target.value);
      PE.markDirty();
    });
    $('#file-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
    });
    $('#btn-open').addEventListener('click', A.openPicker);
    $('#btn-open-2').addEventListener('click', (e) => {
      e.stopPropagation();
      A.openPicker();
    });
    $('#drop-zone').addEventListener('click', A.openPicker);
    $('#drop-zone').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        A.openPicker();
      }
    });
    $('#btn-blank').addEventListener('click', A.newBlank);
    $('#btn-sample').addEventListener('click', A.sample);
    $('#btn-restore').addEventListener('click', restore);
    $('#btn-restore-x').addEventListener('click', async () => {
      await PE.clearSession();
      $('#restore-card').hidden = true;
    });
    $('#btn-download').addEventListener('click', () => A.download());
    $('#btn-pages-toggle').addEventListener('click', () => {
      if (!window.matchMedia('(max-width: 860px)').matches) {
        document.body.classList.toggle('pages-hidden');
        document.body.classList.remove('pages-open');
      }
    });
    document.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    setupDrop();
    window.addEventListener('beforeunload', (e) => {
      if (A.dirty && PE.S.pages.length) {
        PE.autosave.flush();
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    });
    if (location.protocol === 'file:')
      console.info('Pagewright works best from a web server (for example GitHub Pages, or `python -m http.server`).');
    checkRestore();
    U.updateHistoryButtons();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
