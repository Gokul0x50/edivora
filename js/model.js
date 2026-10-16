/* Edivora — document model, undo/redo history, autosave
 *
 * State (PE.S) is plain JSON so it can be snapshotted for undo/redo:
 *  pages: [{ id, src, rot, objs:[], ov:{} }]
 *    src: {t:'pdf', doc, i} | {t:'blank', w, h} | {t:'img', a, w, h}
 *    rot: extra rotation the user applied (0/90/180/270)
 *    objs: user-added objects (text, image, shape, line, ink, table)
 *    ov: overrides for content that came from the PDF (edited text blocks, moved images)
 *  hf: header/footer & page numbers, wm: watermark, meta, form: field values
 * Coordinates of everything on a page are in "base frame" points: the page as the PDF
 * displays it (its own /Rotate applied), origin top-left, y down, before the user rotation.
 */
'use strict';
(function () {
  PE.docs = {}; // docId -> {name, bytes, pdf, sizes:[{w,h,rot}], n}
  PE.assets = {}; // assetId -> {bytes, mime, w, h, url}
  PE.ex = {}; // extraction cache: pageKey -> {blocks, images, ...}
  PE.app = { fileName: 'document.pdf', dirty: false, primary: null, sessionKeys: [] };

  PE.defaultHF = () => ({
    on: false,
    tl: '',
    tc: '',
    tr: '',
    bl: '',
    bc: '{n}',
    br: '',
    size: 10,
    color: '#444444',
    f: 'arimo',
    margin: 28,
    start: 1,
    skipFirst: false,
  });
  PE.defaultWM = () => ({
    on: false,
    text: 'CONFIDENTIAL',
    size: 64,
    color: '#c0392b',
    opacity: 0.14,
    angle: -40,
    f: 'arimo',
    b: true,
  });

  PE.newState = () => ({
    pages: [],
    hf: PE.defaultHF(),
    wm: PE.defaultWM(),
    meta: { title: '', author: '' },
    form: {},
    ocr: {}, // page key -> paragraphs recognised in a scanned page
  });
  PE.S = PE.newState();

  /* ---------- page geometry ---------- */
  PE.pageKey = (pg) => (pg.src.t === 'pdf' ? pg.src.doc + ':' + pg.src.i : pg.src.t === 'img' ? 'img:' + pg.src.a : null);
  PE.baseSize = (pg) => {
    if (pg.src.t === 'pdf') {
      const d = PE.docs[pg.src.doc];
      const s = d && d.sizes[pg.src.i];
      if (s) return { W: s.w, H: s.h, srcRot: s.rot };
      return { W: 612, H: 792, srcRot: 0 };
    }
    return { W: pg.src.w, H: pg.src.h, srcRot: 0 };
  };
  PE.dispSize = (pg) => {
    const { W, H } = PE.baseSize(pg);
    return pg.rot % 180 ? { w: H, h: W } : { w: W, h: H };
  };
  PE.findPage = (id) => PE.S.pages.find((p) => p.id === id);
  PE.pageIndex = (id) => PE.S.pages.findIndex((p) => p.id === id);
  PE.findObj = (pg, id) => pg && pg.objs.find((o) => o.id === id);

  /* ---------- open documents ---------- */
  PE.openPdf = async function (bytes, name, onPassword) {
    const id = PE.uid('d');
    const task = pdfjsLib.getDocument({
      data: bytes.slice(), // pdf.js transfers the buffer; keep our own copy intact
      isEvalSupported: false,
      disableAutoFetch: true,
      cMapUrl: undefined,
      standardFontDataUrl: undefined,
    });
    if (onPassword)
      task.onPassword = (update, reason) => {
        Promise.resolve(onPassword(reason)).then((pw) => (pw == null ? task.destroy() : update(pw)));
      };
    const pdf = await task.promise;
    const sizes = [];
    // fetch page sizes (needed for layout before rendering)
    const batch = 16;
    for (let s = 0; s < pdf.numPages; s += batch) {
      const ps = [];
      for (let i = s; i < Math.min(pdf.numPages, s + batch); i++) ps.push(pdf.getPage(i + 1));
      const pages = await Promise.all(ps);
      for (const p of pages) {
        const vp = p.getViewport({ scale: 1 });
        sizes.push({ w: vp.width, h: vp.height, rot: p.rotate });
      }
    }
    // pdf-lib cannot write encrypted files; look for an /Encrypt entry so we can warn early
    let encrypted = false;
    try {
      const head = new TextDecoder('latin1').decode(bytes.length > 4e6 ? bytes.subarray(bytes.length - 4e6) : bytes);
      encrypted = head.includes('/Encrypt');
    } catch (e) {}
    PE.docs[id] = { id, name, bytes, pdf, sizes, n: pdf.numPages, encrypted, pageCache: {} };
    return id;
  };

  PE.getPdfPage = async (docId, i) => {
    const d = PE.docs[docId];
    if (!d.pageCache[i]) d.pageCache[i] = d.pdf.getPage(i + 1);
    return d.pageCache[i];
  };

  PE.addAsset = async function (bytes, mime) {
    const norm = await PE.normalizeImage(bytes, mime);
    const id = PE.uid('a');
    const url = URL.createObjectURL(new Blob([norm.bytes], { type: norm.mime }));
    PE.assets[id] = { id, bytes: norm.bytes, mime: norm.mime, w: norm.w, h: norm.h, url };
    return id;
  };
  PE.addAssetRaw = function (id, bytes, mime, w, h) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    PE.assets[id] = { id, bytes, mime, w, h, url };
    return id;
  };

  /* ---------- history ---------- */
  const LIMIT = 150;
  const H = (PE.hist = { stack: [], idx: -1 });
  H.reset = function () {
    H.stack = [JSON.stringify(PE.S)];
    H.idx = 0;
    PE.ui && PE.ui.updateHistoryButtons();
  };
  H.canUndo = () => H.idx > 0;
  H.canRedo = () => H.idx < H.stack.length - 1;

  /** Record the current state as a new undo step. */
  PE.commit = function () {
    PE.commitSoon.cancel();
    const snap = JSON.stringify(PE.S);
    if (H.stack[H.idx] === snap) return;
    H.stack = H.stack.slice(0, H.idx + 1);
    H.stack.push(snap);
    if (H.stack.length > LIMIT) H.stack.shift();
    H.idx = H.stack.length - 1;
    PE.markDirty();
    PE.ui && PE.ui.updateHistoryButtons();
  };
  PE.commitSoon = PE.debounce(() => PE.commit(), 600);

  function restore(i) {
    PE.commitSoon.cancel();
    H.idx = i;
    PE.S = JSON.parse(H.stack[i]);
    if (!PE.S.ocr) PE.S.ocr = {};
    // recognised text belongs to the state: refresh the pages' content to match
    for (const key in PE.ex) if (PE.ex[key] && !PE.ex[key].failed && PE.ocr) PE.ocr.mergeInto(key, PE.ex[key]);
    for (const key in PE.ex) if (key.startsWith('img:') && !PE.S.ocr[key]) delete PE.ex[key];
    PE.tools && PE.tools.clearSelection(true);
    PE.view.sync();
    PE.markDirty();
    PE.ui.updateHistoryButtons();
    PE.ui.refreshAll();
  }
  PE.undo = function () {
    // flush pending typing first so it becomes its own step
    if (PE.tools && PE.tools.editing) PE.tools.stopEditing();
    PE.commit();
    if (H.canUndo()) restore(H.idx - 1);
  };
  PE.redo = function () {
    if (PE.tools && PE.tools.editing) PE.tools.stopEditing();
    PE.commit();
    if (H.canRedo()) restore(H.idx + 1);
  };

  PE.markDirty = function () {
    PE.app.dirty = true;
    PE.autosave();
  };

  /* ---------- autosave to IndexedDB, so a refresh or crash doesn't lose work ---------- */
  PE.autosave = PE.debounce(async function () {
    if (!PE.S.pages.length) return;
    try {
      const keys = [];
      for (const id in PE.docs) {
        const k = 'doc:' + id;
        keys.push(k);
        if (!PE.docs[id].saved) {
          await PE.idb.set(k, { id, name: PE.docs[id].name, bytes: PE.docs[id].bytes });
          PE.docs[id].saved = true;
        }
      }
      for (const id in PE.assets) {
        const k = 'asset:' + id;
        keys.push(k);
        const a = PE.assets[id];
        if (!a.saved) {
          await PE.idb.set(k, { id, bytes: a.bytes, mime: a.mime, w: a.w, h: a.h });
          a.saved = true;
        }
      }
      await PE.idb.set('session', {
        time: Date.now(),
        fileName: PE.app.fileName,
        primary: PE.app.primary,
        state: JSON.stringify(PE.S),
        keys,
      });
      PE.app.sessionKeys = keys;
    } catch (e) {
      console.warn('autosave failed', e);
    }
  }, 1500);

  PE.clearSession = async function () {
    const s = await PE.idb.get('session');
    if (s && s.keys) for (const k of s.keys) await PE.idb.del(k);
    await PE.idb.del('session');
  };

  PE.loadSession = async function () {
    const s = await PE.idb.get('session');
    if (!s) return false;
    const st = JSON.parse(s.state);
    for (const k of s.keys) {
      const v = await PE.idb.get(k);
      if (!v) continue;
      if (k.startsWith('doc:')) {
        const realId = v.id;
        const tmp = await PE.openPdf(v.bytes, v.name);
        // keep the original id so the saved state still points at it
        PE.docs[realId] = PE.docs[tmp];
        PE.docs[realId].id = realId;
        PE.docs[realId].saved = true;
        delete PE.docs[tmp];
      } else if (k.startsWith('asset:')) {
        PE.addAssetRaw(v.id, v.bytes, v.mime, v.w, v.h);
        PE.assets[v.id].saved = true;
      }
    }
    // drop pages whose source could not be restored
    st.pages = st.pages.filter(
      (p) => (p.src.t !== 'pdf' || PE.docs[p.src.doc]) && (p.src.t !== 'img' || PE.assets[p.src.a])
    );
    PE.S = Object.assign(PE.newState(), st);
    PE.app.fileName = s.fileName || 'document.pdf';
    PE.app.primary = s.primary && PE.docs[s.primary] ? s.primary : Object.keys(PE.docs)[0] || null;
    return true;
  };
})();
