/* Edivora — making scanned pages editable (OCR with Tesseract, all in the browser).
 * Recognised paragraphs become ordinary editable text blocks of the page: tapping one edits it in a
 * matching font, the scan behind it is covered with its paper colour, and unedited paragraphs are added
 * to the saved PDF as invisible text so the document becomes searchable.
 */
'use strict';
(function () {
  const O = (PE.ocr = {});
  const V = PE.view;
  let engine = null; // { worker, lang }
  const LANGS = [
    ['eng', 'English (built in)'],
    ['eng+hin', 'English + Hindi (e.g. CBSE certificates)'],
    ['eng+tam', 'English + Tamil'],
    ['eng+tel', 'English + Telugu'],
    ['eng+kan', 'English + Kannada'],
    ['eng+mal', 'English + Malayalam'],
    ['hin', 'Hindi'],
    ['tam', 'Tamil'],
    ['tel', 'Telugu'],
    ['kan', 'Kannada'],
    ['mal', 'Malayalam'],
    ['ben', 'Bengali'],
    ['mar', 'Marathi'],
    ['guj', 'Gujarati'],
    ['fra', 'French'],
    ['deu', 'German'],
    ['spa', 'Spanish'],
    ['por', 'Portuguese'],
    ['ita', 'Italian'],
  ];

  /* ---------- engine ---------- */
  async function getEngine(lang, onStatus) {
    if (engine && engine.lang === lang) return engine.worker;
    if (engine) {
      try {
        await engine.worker.terminate();
      } catch (e) {}
      engine = null;
    }
    onStatus && onStatus('Loading the text recogniser', 0.02);
    if (!window.Tesseract) await PE.loadScript('lib/tesseract/tesseract.min.js');
    if (!window.PE_TWORKER) await PE.loadScript('lib/tesseract/worker.js');
    if (!window.PE_TCORE) await PE.loadScript('lib/tesseract/core.js');
    const opts = { workerBlobURL: false, cacheMethod: 'none', gzip: true };
    const codes = lang.split('+');
    if (codes.includes('eng') && !window.PE_TLANG_ENG) await PE.loadScript('lib/tesseract/eng.js');
    // English is bundled; other languages come from the CDN (downloaded once per session)
    const langArg = codes.map((c) => (c === 'eng' ? { code: 'eng', data: PE.b64ToBytes(window.PE_TLANG_ENG) } : c));
    if (codes.some((c) => c !== 'eng')) opts.langPath = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/' + codes.find((c) => c !== 'eng') + '/4.0.0_best_int';
    // the worker and engine are created from in-memory copies, so this also works when opened from a file
    // engine + worker in one script: a worker started from a file:// page can't load a second script
    if (!O._workerUrl) O._workerUrl = URL.createObjectURL(new Blob([window.PE_TCORE, '\n;\n', window.PE_TWORKER], { type: 'application/javascript' }));
    opts.workerPath = O._workerUrl;
    opts.logger = (m) => {
      if (onStatus && m && m.status && /loading|initializ/.test(m.status)) onStatus('Loading the text recogniser', 0.04);
      if (O._onRec && m && m.status === 'recognizing text') O._onRec(m.progress || 0);
    };
    let worker;
    try {
      worker = await Tesseract.createWorker(langArg, 1, opts);
    } catch (e) {
      throw new Error(lang === 'eng' ? 'The text recogniser could not start (' + (e.message || e) + ').' : 'Could not download the language data for ' + lang.replace('eng+', '') + '. Check your internet connection.');
    }
    await worker.setParameters({ preserve_interword_spaces: '1' });
    engine = { worker, lang };
    return worker;
  }

  /* ---------- which pages need it ---------- */
  O.key = (pg) => PE.pageKey(pg);
  O.done = (pg) => !!(PE.S.ocr && PE.S.ocr[O.key(pg)]);
  /** a page that is a picture of text: almost no real text, a big image */
  O.isScanned = function (pg) {
    if (O.done(pg)) return false;
    if (pg.src.t === 'img') return true;
    if (pg.src.t !== 'pdf') return false;
    const ex = PE.ex[O.key(pg)];
    if (!ex || ex.failed) return false;
    const chars = ex.blocks.reduce((n, b) => n + b.text.replace(/\s/g, '').length, 0);
    const area = ex.W * ex.H;
    const big = ex.images.some((im) => im.bbox.w * im.bbox.h > area * 0.35);
    return chars < 25 && big;
  };

  /* banner under scanned pages */
  O.banner = function (pg, pv) {
    if (!pv) return;
    let b = pv.ocrBanner;
    const show = O.isScanned(pg);
    if (!show) {
      if (b) b.hidden = true;
      return;
    }
    if (!b) {
      b = PE.h('div', { class: 'ocr-banner' }, [
        PE.h('span', { html: PE.icon('scan') }),
        PE.h('span', {}, 'This page is a scanned image.'),
        PE.h('button', { class: 'btn primary', onclick: () => O.run([pg]) }, 'Make text editable'),
        PE.h('button', { class: 'btn ghost', title: 'Choose pages and language (e.g. English + Hindi)', onclick: () => O.dialog() }, 'Options…'),
      ]);
      pv.root.appendChild(b);
      pv.ocrBanner = b;
    }
    b.hidden = false;
    if (!O._hinted) {
      O._hinted = true;
      setTimeout(() => PE.toast('This looks like a scanned document. Use “Make text editable” under a page (or More → OCR) to edit its text.', 'info', 7000), 600);
    }
  };

  /* ---------- extraction data for OCR'd pages ---------- */
  /** blocks found by OCR are merged into the page's extracted content */
  O.mergeInto = function (key, ex) {
    if (!ex || !ex.blocks) return ex;
    const list = PE.S.ocr && PE.S.ocr[key];
    if (!list && !ex.blocks.some((b) => b.ocr)) return ex;
    ex.blocks = ex.blocks.filter((b) => !b.ocr).concat(list ? PE.clone(list) : []);
    ex.preds = null;
    ex.order = null;
    return ex;
  };
  /** image pages have no PDF content: build their extraction entry from the OCR result */
  O.ensureImageEx = function (pg) {
    if (pg.src.t !== 'img') return null;
    const key = O.key(pg);
    if (!PE.S.ocr || !PE.S.ocr[key]) return null;
    if (!PE.ex[key]) {
      const { W, H } = PE.baseSize(pg);
      PE.ex[key] = O.mergeInto(key, { W, H, blocks: [], images: [], graphics: [], tables: [], preds: null });
    }
    return PE.ex[key];
  };

  /* ---------- running ---------- */
  async function renderForOcr(pg) {
    const { W, H } = PE.baseSize(pg);
    const scale = Math.min(4, 3000 / Math.max(W, H));
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * scale);
    cv.height = Math.round(H * scale);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (pg.src.t === 'pdf') {
      const page = await PE.getPdfPage(pg.src.doc, pg.src.i);
      const vp = page.getViewport({ scale });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } else {
      const a = PE.assets[pg.src.a];
      const im = await V.loadImg(a.url);
      ctx.drawImage(im, 0, 0, cv.width, cv.height);
    }
    return { cv, ctx, scale, W, H };
  }

  O.run = async function (pages, lang = O.lang || 'eng') {
    pages = pages.filter((p) => p.src.t === 'pdf' || p.src.t === 'img');
    if (!pages.length) return;
    if (PE.tools.editing) PE.tools.stopEditing();
    const U = PE.ui;
    U.busy(true, 'Loading the text recogniser', 0.02);
    let found = 0;
    try {
      const worker = await getEngine(lang, (t, f) => U.busy(true, t, f));
      PE.S.ocr = PE.S.ocr || {};
      for (let n = 0; n < pages.length; n++) {
        const pg = pages[n];
        const base = n / pages.length;
        const label = pages.length > 1 ? `Reading page ${n + 1} of ${pages.length}` : 'Reading the page';
        U.busy(true, label, 0.06 + base * 0.9);
        O._onRec = (p) => U.busy(true, label, 0.06 + (base + p / pages.length) * 0.9);
        if (pg.src.t === 'pdf') await PE.extractPage(pg.src.doc, pg.src.i);
        const R = await renderForOcr(pg);
        const res = await worker.recognize(R.cv, {}, { blocks: true, text: false, hocr: false, tsv: false });
        if (O.debug) console.log('ocr-raw', JSON.stringify((res.data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.map((l) => l.words.map((w) => w.text + '(' + Math.round(w.confidence) + ')').join(' '))))));
        await loadCandidates();
        R.W = PE.baseSize(pg).W;
        const blocks = await toBlocks(res.data, R, n);
        found += blocks.length;
        const key = O.key(pg);
        PE.S.ocr[key] = blocks;
        // rebuild the page's content with the new paragraphs
        if (pg.src.t === 'pdf') {
          if (PE.ex[key]) O.mergeInto(key, PE.ex[key]);
        } else {
          delete PE.ex[key];
          O.ensureImageEx(pg);
        }
        await PE.fonts.ensureRuns(blocks.flatMap((b) => b.runs));
        V.renderOverlay(pg);
      }
      O._onRec = null;
      PE.commit();
      PE.ui.refreshAll && PE.ui.refreshAll();
      if (found) PE.toast(`Found ${found} piece${found === 1 ? '' : 's'} of text. Tap any text on the page to edit it.`, 'ok', 6000);
      else PE.toast('No text was found on that page.', 'warn');
    } catch (e) {
      console.error(e);
      PE.toast(e.message || 'Text recognition failed.', 'error', 7000);
    } finally {
      O._onRec = null;
      U.busy(false);
    }
  };

  O.dialog = function () {
    const U = PE.ui,
      h = PE.h;
    const pages = PE.S.pages;
    if (!pages.length) return;
    const scanned = pages.filter(O.isScanned);
    const cur = V.currentPage();
    const which = h('select', { class: 'field', 'aria-label': 'Pages' }, [
      h('option', { value: 'scanned', selected: scanned.length > 0 }, scanned.length ? `Scanned pages (${scanned.length})` : 'Scanned pages (none found)'),
      h('option', { value: 'current', selected: !scanned.length }, 'This page' + (cur ? ` (page ${PE.pageIndex(cur.id) + 1})` : '')),
      h('option', { value: 'all' }, `All pages (${pages.length})`),
    ]);
    const lang = h('select', { class: 'field', 'aria-label': 'Language' }, LANGS.map(([k, n]) => h('option', { value: k, selected: k === (O.lang || 'eng') }, n)));
    U.dialog({
      title: 'Make scanned text editable',
      body: [
        h('p', {}, 'Reads the text in scanned pages and photos so you can edit, copy and search it. Everything runs on this device.'),
        h('label', { class: 'fld' }, ['Pages', which]),
        h('label', { class: 'fld' }, ['Language of the text', lang]),
        h('p', { class: 'p-note' }, 'English works offline. Other languages are downloaded once (a few MB) when you use them. Clear, straight scans at 300 dpi give the best results; check the text after recognition.'),
      ],
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Recognise text',
          primary: true,
          onClick: () => {
            O.lang = lang.value;
            const list = which.value === 'all' ? pages.slice() : which.value === 'current' ? (cur ? [cur] : []) : scanned;
            if (!list.length) {
              PE.toast('No scanned pages were found. Choose “This page” or “All pages”.', 'warn');
              return false;
            }
            setTimeout(() => O.run(list, lang.value), 50);
          },
        },
      ],
    });
  };

  /* ---------- OCR result -> editable blocks ---------- */
  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  let mctx = null;
  function textWidth(t, fam, b, size) {
    mctx = mctx || document.createElement('canvas').getContext('2d');
    mctx.font = `${b ? 700 : 400} ${size}px ${PE.fonts.cssFamily(fam)}`;
    return mctx.measureText(t).width;
  }
  /* which bundled font looks most like the scanned letters: draw the line in each candidate and compare the ink */
  const CANDS = [
    ['arimo', false],
    ['arimo', true],
    ['tinos', false],
    ['tinos', true],
    ['carlito', false],
    ['carlito', true],
    ['caladea', false],
    ['caladea', true],
  ];
  async function loadCandidates() {
    await Promise.race([Promise.all(CANDS.map(([f, b]) => PE.fonts.ensure(f, b, false))), PE.sleep(3000)]);
  }
  function inkMap(data, n, dark) {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = dark(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]) ? 1 : 0;
    return m;
  }
  /** compare each longer word of the line, drawn in every candidate font and stretched to the word's box */
  function classify(src, l, scale) {
    const scores = {};
    let n = 0;
    // only words read with confidence: a misread word compares badly with every font
    for (const w of (l.words || []).filter((x) => x.t.length >= 3 && (x.conf == null || x.conf >= 75)).slice(0, 6)) {
      const r = classifyBox(src, Object.assign({}, l, { bb: { x0: w.bb.x0, y0: l.bb.y0, x1: w.bb.x1, y1: l.bb.y1 }, text: w.t, x: w.bb.x0 / scale, right: w.bb.x1 / scale }), scale);
      if (!r) continue;
      n++;
      for (const k in r.all) scores[k] = (scores[k] || 0) + r.all[k];
    }
    if (!n) return null;
    let best = null;
    for (const k in scores) {
      scores[k] /= n;
      if (!best || scores[k] > best.score) best = { f: k.split('|')[0], b: k.split('|')[1] === 'true', score: scores[k] };
    }
    best.all = scores;
    return best;
  }
  function classifyBox(src, l, scale) {
    const bb = l.bb;
    const W0 = bb.x1 - bb.x0,
      H0 = bb.y1 - bb.y0;
    if (W0 < 12 || H0 < 8 || l.text.length < 3) return null;
    const k = Math.min(1.5, 56 / H0);
    const w = Math.max(10, Math.round(W0 * k)),
      h = Math.max(8, Math.round(H0 * k));
    const c1 = document.createElement('canvas');
    c1.width = w;
    c1.height = h;
    const g1 = c1.getContext('2d', { willReadFrequently: true });
    g1.drawImage(src, bb.x0, bb.y0, W0, H0, 0, 0, w, h);
    const d1 = g1.getImageData(0, 0, w, h).data;
    let lo = 255,
      hi = 0;
    for (let i = 0; i < d1.length; i += 4) {
      const v = 0.299 * d1[i] + 0.587 * d1[i + 1] + 0.114 * d1[i + 2];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const thr = (lo + hi) / 2;
    const A = inkMap(d1, w * h, (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b < thr);
    let nA = 0;
    for (const v of A) nA += v;
    if (!nA) return null;
    const c2 = document.createElement('canvas');
    c2.width = w;
    c2.height = h;
    const g2 = c2.getContext('2d', { willReadFrequently: true });
    const base = (l.base * scale - bb.y0) * k;
    let best = null;
    const scores = {};
    for (const [f, b] of CANDS) {
      if (!PE.fonts.isLoaded(f, b, false)) continue;
      const m = PE.fonts.metrics(f, b, false);
      // size from the measured cap height, then stretch to the line's width
      const size = l.size * scale * k;
      g2.setTransform(1, 0, 0, 1, 0, 0);
      g2.clearRect(0, 0, w, h);
      g2.font = `${b ? 700 : 400} ${size}px ${PE.fonts.cssFamily(f)}`;
      const tw = g2.measureText(l.text).width;
      if (!(tw > 0)) continue;
      g2.setTransform(w / tw, 0, 0, 1, 0, 0);
      g2.fillStyle = '#000';
      g2.fillText(l.text, 0, base);
      const B = inkMap(g2.getImageData(0, 0, w, h).data, w * h, (r, g, bl, a) => a > 110);
      let both = 0,
        nB = 0;
      for (let i = 0; i < A.length; i++) {
        nB += B[i];
        both += A[i] & B[i];
      }
      const score = (2 * both) / (nA + nB);
      scores[f + '|' + b] = score;
      if (!best || score > best.score) best = { f, b, score };
      void m;
    }
    if (best) best.all = scores;
    return best;
  }

  /** colour of the strokes (median of clearly-inked pixels), and how much ink there is */
  /** thickness of the letters' stems compared with the font size: about 0.08–0.11 for regular, 0.14+ for bold */
  function stemRatio(ctx, bb, sizePx) {
    const x0 = Math.max(0, Math.floor(bb.x0)),
      y0 = Math.max(0, Math.floor(bb.y0));
    const w = Math.max(1, Math.ceil(bb.x1 - bb.x0)),
      h = Math.max(1, Math.ceil(bb.y1 - bb.y0));
    let d;
    try {
      d = ctx.getImageData(x0, y0, w, h).data;
    } catch (e) {
      return 0;
    }
    const L = new Float32Array(w * h);
    let lo = 255,
      hi = 0;
    for (let k = 0; k < w * h; k++) {
      const v = 0.299 * d[k * 4] + 0.587 * d[k * 4 + 1] + 0.114 * d[k * 4 + 2];
      L[k] = v;
    }
    const sorted = Array.from(L).sort((a, b) => a - b);
    lo = sorted[Math.floor(sorted.length * 0.02)];
    hi = sorted[Math.floor(sorted.length * 0.8)];
    const thr = (lo + hi) / 2;
    const runs = [];
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        if (L[y * w + x] < thr) run++;
        else if (run) {
          runs.push(run);
          run = 0;
        }
      }
      if (run) runs.push(run);
    }
    if (!runs.length || !sizePx) return 0;
    return median(runs) / sizePx;
  }

  function strokeColor(ctx, bb) {
    const x0 = Math.max(0, Math.floor(bb.x0)),
      y0 = Math.max(0, Math.floor(bb.y0));
    const w = Math.max(1, Math.ceil(bb.x1 - bb.x0)),
      h = Math.max(1, Math.ceil(bb.y1 - bb.y0));
    let d;
    try {
      d = ctx.getImageData(x0, y0, w, h).data;
    } catch (e) {
      return { color: '#000000', density: 0 };
    }
    const L = [];
    for (let i = 0; i < d.length; i += 4) L.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    const sorted = L.slice().sort((a, b) => a - b);
    const dark = sorted[Math.floor(sorted.length * 0.02)],
      paper = sorted[Math.floor(sorted.length * 0.8)];
    if (paper - dark < 40) return { color: '#000000', density: 0 };
    // pixels well inside the strokes: darker than 30% of the way from ink to paper
    const thr = dark + (paper - dark) * 0.3;
    const R = [],
      G = [],
      B = [];
    let inked = 0;
    for (let k = 0; k < L.length; k++) {
      if (L[k] < paper - 60) inked++;
      if (L[k] <= thr) {
        R.push(d[k * 4]);
        G.push(d[k * 4 + 1]);
        B.push(d[k * 4 + 2]);
      }
    }
    const r = median(R),
      g = median(G),
      b = median(B);
    let color = PE.rgbToHex(r, g, b);
    // near-neutral dark ink is printed black
    if (Math.max(r, g, b) < 110 && Math.max(r, g, b) - Math.min(r, g, b) < 28) color = '#000000';
    return { color, density: inked / L.length };
  }

  const JUNK = /^[|=~_\-—–:;.,'"`!*•°^()\[\]{}<>\/\\+]+$/;
  /** words worth keeping: confident, and containing letters or digits */
  function goodWord(w) {
    const t = (w.text || '').trim();
    if (!t || JUNK.test(t)) return false;
    if (!/[\p{L}\p{N}]/u.test(t)) return false;
    if (w.confidence >= 52) return true;
    // long words of letters/digits are real even when the recogniser is unsure (e.g. letter-spaced names)
    return w.confidence >= 28 && t.length >= 6 && /^[\p{L}\p{N}.,'\-\/]+$/u.test(t) && !/[a-z][A-Z]/.test(t);
  }

  /**
   * Scanned forms and certificates put labels and values side by side, so every line is cut into
   * separate pieces wherever there's a wide gap; only lines of running text are joined into paragraphs.
   */
  async function toBlocks(data, R, pageN) {
    const { ctx, scale, cv } = R;
    const segs = [];
    for (const blk of data.blocks || [])
      for (const par of blk.paragraphs || [])
        for (const l of par.lines || []) {
          const words = (l.words || []).filter(goodWord).sort((a, b) => a.bbox.x0 - b.bbox.x0);
          if (!words.length) continue;
          const lb = l.baseline && l.baseline.has_baseline !== false ? l.baseline : null;
          const baseAt = (x) => {
            if (lb && lb.x1 !== lb.x0) return lb.y0 + ((lb.y1 - lb.y0) * (x - lb.x0)) / (lb.x1 - lb.x0);
            if (lb) return (lb.y0 + lb.y1) / 2;
            return l.bbox.y1 - (l.bbox.y1 - l.bbox.y0) * 0.22;
          };
          const charW = median(words.map((w) => (w.bbox.x1 - w.bbox.x0) / Math.max(1, w.text.length)));
          const lineH = l.bbox.y1 - l.bbox.y0;
          const gapMax = Math.max(charW * 2.4, lineH * 0.9);
          let cur = [];
          const flush = () => {
            if (cur.length) segs.push(makeSeg(cur, baseAt));
            cur = [];
          };
          for (const w of words) {
            const prev = cur[cur.length - 1];
            if (prev && w.bbox.x0 - prev.bbox.x1 > gapMax) flush();
            cur.push(w);
          }
          flush();
        }
    function makeSeg(words, baseAt) {
      const x0 = Math.min(...words.map((w) => w.bbox.x0)),
        x1 = Math.max(...words.map((w) => w.bbox.x1));
      const y0 = Math.min(...words.map((w) => w.bbox.y0)),
        y1 = Math.max(...words.map((w) => w.bbox.y1));
      let base = baseAt((x0 + x1) / 2);
      if (!(base > y0) || base > y1 + 2) base = y1 - (y1 - y0) * 0.22;
      const text = words.map((w) => w.text).join(' ');
      return {
        text,
        words: words.map((w) => ({ t: w.text, bb: w.bbox, conf: w.confidence })),
        bb: { x0, y0, x1, y1 },
        conf: words.reduce((a, w) => a + w.confidence, 0) / words.length,
        x: x0 / scale,
        right: x1 / scale,
        top: y0 / scale,
        bottom: y1 / scale,
        base: base / scale,
        asc: (base - y0) / scale,
        hasCap: /[A-Z0-9bdfhklt]/.test(text),
      };
    }
    // drop what's most likely noise (stamps, patterns, scripts the chosen language can't read)
    const keep = segs.filter((s) => {
      const alnum = (s.text.match(/[\p{L}\p{N}]/gu) || []).length;
      if (s.conf < 62 && alnum < 4) return false;
      if (s.conf < 50 && alnum < 6) return false;
      return alnum >= 1;
    });
    for (const s of keep) {
      s.size = PE.clamp((s.hasCap ? s.asc / 0.71 : s.asc / 0.52) || (s.bottom - s.top) / 1.2, 4, 300);
      const st = strokeColor(ctx, s.bb);
      s.color = st.color;
      s.density = st.density;
      s.stem = stemRatio(ctx, s.bb, s.size * scale);
    }
    const bodyDensity = median(keep.map((s) => s.density));
    const bodySize = median(keep.map((s) => s.size));
    // fonts: page-wide family vote from the letter shapes, bold per piece
    const famVotes = {};
    for (const s of keep) {
      const c = classify(cv, s, scale);
      s.cls = c;
      if (!c) continue;
      const wt = Math.sqrt(s.text.length);
      for (const f of new Set(CANDS.map((x) => x[0]))) famVotes[f] = (famVotes[f] || 0) + wt * Math.max(c.all[f + '|false'] || 0, c.all[f + '|true'] || 0);
    }
    const mainFam = (Object.entries(famVotes).sort((a, b) => b[1] - a[1])[0] || ['arimo'])[0];
    for (const s of keep) {
      let fam = mainFam;
      const c = s.cls;
      if (c) {
        const own = c.f;
        const ownScore = Math.max(c.all[own + '|false'] || 0, c.all[own + '|true'] || 0);
        const mainScore = Math.max(c.all[mainFam + '|false'] || 0, c.all[mainFam + '|true'] || 0);
        if (own !== mainFam && ownScore > mainScore * 1.12) fam = own;
      }
      const boldShape = c ? (c.all[fam + '|true'] || 0) > (c.all[fam + '|false'] || 0) * 1.03 : false;
      s.fam = fam;
      // stem thickness decides; letter shapes break the tie in between
      s.bold = s.stem > 0.125;
      void boldShape;
      if (O.debug) console.log('ocr-seg', s.text, s.stem.toFixed(3), boldShape, s.density.toFixed(3));
      // size so the line is exactly as long as in the scan
      const w = textWidth(s.text, fam, s.bold, s.size);
      // unsure readings (missing spaces, odd letters) would distort the size: keep the measured one
      const fit = s.conf >= 70 ? (s.right - s.x) / Math.max(1, w) : 1;
      s.s = PE.round(s.size * PE.clamp(fit, 0.7, 1.35), 1);
    }
    // join lines of running text into paragraphs (wide lines, same column, same look, normal spacing)
    keep.sort((a, b) => a.top - b.top || a.x - b.x);
    const pageW = R.W;
    const groups = [];
    for (const s of keep) {
      let joined = false;
      for (let k = groups.length - 1; k >= 0 && k >= groups.length - 6; k--) {
        const g = groups[k];
        const last = g[g.length - 1];
        const pitch = s.base - last.base;
        const sz = Math.max(s.s, last.s);
        if (pitch < 0.95 * sz || pitch > 1.75 * sz) continue;
        if (Math.abs(s.x - g[0].x) > 0.8 * sz) continue;
        if (Math.abs(s.s - last.s) > 0.12 * sz || s.fam !== last.fam || s.bold !== last.bold || s.color !== last.color) continue;
        if (last.right - last.x < pageW * 0.45) continue; // the line before must be a long one
        g.push(s);
        joined = true;
        break;
      }
      if (!joined) groups.push([s]);
    }
    const out = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const L = groups[gi];
      const s = L.length > 1 ? PE.round(median(L.map((l) => l.s)), 1) : L[0].s;
      const fam = L[0].fam,
        bold = L[0].bold,
        color = L[0].color;
      const x = Math.min(...L.map((l) => l.x)),
        right = Math.max(...L.map((l) => l.right));
      const top = Math.min(...L.map((l) => l.top)),
        bottom = Math.max(...L.map((l) => l.bottom));
      let align = 'left';
      if (L.length > 2) {
        const full = L.slice(0, -1);
        if (Math.max(...full.map((l) => l.right)) - Math.min(...full.map((l) => l.right)) < 0.8 * s) align = 'justify';
      }
      let text = '';
      L.forEach((l, k) => {
        if (k > 0) text = /[A-Za-z]-$/.test(text) ? text.slice(0, -1) : text + ' ';
        text += l.text;
      });
      const run = { t: text, f: fam, b: bold, i: false, s, c: color };
      const lh = L.length > 1 ? PE.clamp((L[L.length - 1].base - L[0].base) / (L.length - 1) / s, 0.9, 2.6) : 1.2;
      const words = L.flatMap((l) => l.words);
      const patch = await makePatch(ctx, cv, words, scale);
      out.push({
        id: 'bq' + pageN + '_' + gi,
        x,
        top,
        w: right - x,
        h: bottom - top,
        y0: L[0].base,
        size0: s,
        runs: [run],
        lineRuns: L.map((l) => [Object.assign({}, run, { t: l.text })]),
        align,
        lh: PE.round(lh, 3),
        single: L.length === 1,
        bg: patch ? patch.c : '#ffffff',
        patch: patch ? { a: patch.a, x: patch.x, y: patch.y, w: patch.w, h: patch.h } : null,
        text,
        of: 'scanned text (recognised)',
        ocr: true,
        lines: L.map((l) => ({ x: l.x, y: l.base, w: l.right - l.x, t: l.text })),
      });
    }
    return out;
  }

  /**
   * A copy of the scan around the text with the letters removed: ink inside the word boxes is
   * filled in from the paper around it, so the background pattern and colour stay when the text is replaced.
   */
  async function makePatch(ctx, cv, words, scale) {
    const pad = Math.max(2, Math.round(1.6 * scale));
    const bx0 = Math.min(...words.map((w) => w.bb.x0)),
      by0 = Math.min(...words.map((w) => w.bb.y0));
    const bx1 = Math.max(...words.map((w) => w.bb.x1)),
      by1 = Math.max(...words.map((w) => w.bb.y1));
    const x0 = Math.max(0, Math.floor(bx0 - pad)),
      y0 = Math.max(0, Math.floor(by0 - pad));
    const x1 = Math.min(cv.width, Math.ceil(bx1 + pad)),
      y1 = Math.min(cv.height, Math.ceil(by1 + pad));
    const w = x1 - x0,
      h = y1 - y0;
    if (w < 2 || h < 2) return null;
    let img;
    try {
      img = ctx.getImageData(x0, y0, w, h);
    } catch (e) {
      return null;
    }
    const d = img.data;
    const n = w * h;
    const lum = new Float32Array(n);
    for (let k = 0; k < n; k++) lum[k] = 0.299 * d[k * 4] + 0.587 * d[k * 4 + 1] + 0.114 * d[k * 4 + 2];
    const sorted = Array.from(lum).sort((a, b) => a - b);
    const paper = sorted[Math.floor(n * 0.75)],
      darkest = sorted[Math.floor(n * 0.02)];
    const thr = paper - Math.max(8, (paper - darkest) * 0.08);
    // ink = clearly darker pixels inside a word box (lines and stamps outside the words stay)
    const inWord = new Uint8Array(n);
    const grow = Math.max(2, Math.round(1.3 * scale));
    for (const wd of words) {
      const a0 = Math.max(0, Math.floor(wd.bb.x0 - x0 - grow)),
        a1 = Math.min(w, Math.ceil(wd.bb.x1 - x0 + grow));
      const b0 = Math.max(0, Math.floor(wd.bb.y0 - y0 - grow)),
        b1 = Math.min(h, Math.ceil(wd.bb.y1 - y0 + grow));
      for (let y = b0; y < b1; y++) for (let x = a0; x < a1; x++) inWord[y * w + x] = 1;
    }
    // clean paper: the colour the letters are filled with comes only from these pixels
    const clean = new Uint8Array(n);
    const cleanThr = paper - Math.max(6, (paper - darkest) * 0.04);
    for (let k = 0; k < n; k++) clean[k] = lum[k] >= cleanThr ? 1 : 0;
    let mask = new Uint8Array(n);
    for (let k = 0; k < n; k++) mask[k] = inWord[k] && lum[k] < thr ? 1 : 0;
    // grow the mask a little to take the anti-aliased edges of the letters too
    const r = Math.max(2, Math.round(0.8 * scale));
    const m2 = new Uint8Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w && inWord[yy * w + xx]) m2[yy * w + xx] = 1;
          }
        }
      }
    mask = m2;
    // the whole word boxes are refilled from the paper just outside them, so no trace of the letters stays
    for (let k = 0; k < n; k++) if (inWord[k]) mask[k] = 1;
    for (let k = 0; k < n; k++) if (!inWord[k] && !clean[k]) clean[k] = 0;
    const src0 = mask;
    // fill each masked pixel from the nearest clean pixels above/below and left/right
    const up = new Int32Array(n),
      dn = new Int32Array(n),
      lf = new Int32Array(n),
      rt = new Int32Array(n);
    for (let x = 0; x < w; x++) {
      let last = -1;
      for (let y = 0; y < h; y++) {
        const k = y * w + x;
        if (!mask[k] && clean[k]) last = y;
        up[k] = last;
      }
      last = -1;
      for (let y = h - 1; y >= 0; y--) {
        const k = y * w + x;
        if (!mask[k] && clean[k]) last = y;
        dn[k] = last;
      }
    }
    for (let y = 0; y < h; y++) {
      let last = -1;
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (!mask[k] && clean[k]) last = x;
        lf[k] = last;
      }
      last = -1;
      for (let x = w - 1; x >= 0; x--) {
        const k = y * w + x;
        if (!mask[k] && clean[k]) last = x;
        rt[k] = last;
      }
    }
    const src = new Uint8ClampedArray(d);
    let pr = 0,
      pg = 0,
      pb = 0,
      pc = 0;
    for (let k = 0; k < n; k++) {
      if (mask[k]) continue;
      pr += src[k * 4];
      pg += src[k * 4 + 1];
      pb += src[k * 4 + 2];
      pc++;
    }
    const avg = pc ? [pr / pc, pg / pc, pb / pc] : [255, 255, 255];
    // fill colours are read from a smoothed copy of the paper (no streaks from single pixels)
    const sm = new Float32Array(n * 3);
    for (let k = 0; k < n; k++)
      for (let ch = 0; ch < 3; ch++) sm[k * 3 + ch] = clean[k] && !mask[k] ? src[k * 4 + ch] : avg[ch];
    const R = Math.max(3, Math.round(2 * scale));
    const tmp = new Float32Array(n * 3);
    for (let y = 0; y < h; y++)
      for (let ch = 0; ch < 3; ch++) {
        let acc = 0,
          cnt = 0;
        for (let x = -R; x < w + R; x++) {
          if (x + R < w) {
            acc += sm[(y * w + x + R) * 3 + ch];
            cnt++;
          }
          if (x - R - 1 >= 0) {
            acc -= sm[(y * w + x - R - 1) * 3 + ch];
            cnt--;
          }
          if (x >= 0 && x < w) tmp[(y * w + x) * 3 + ch] = acc / cnt;
        }
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (!mask[k]) continue;
        let sr = 0,
          sg = 0,
          sb = 0,
          sw = 0;
        const add = (kk, dist) => {
          const wt = 1 / (dist * dist);
          sr += tmp[kk * 3] * wt;
          sg += tmp[kk * 3 + 1] * wt;
          sb += tmp[kk * 3 + 2] * wt;
          sw += wt;
        };
        if (up[k] >= 0) add(up[k] * w + x, y - up[k]);
        if (dn[k] >= 0) add(dn[k] * w + x, dn[k] - y);
        if (lf[k] >= 0) add(y * w + lf[k], x - lf[k]);
        if (rt[k] >= 0) add(y * w + rt[k], rt[k] - x);
        const o = k * 4;
        if (sw) {
          d[o] = sr / sw;
          d[o + 1] = sg / sw;
          d[o + 2] = sb / sw;
        } else {
          d[o] = avg[0];
          d[o + 1] = avg[1];
          d[o + 2] = avg[2];
        }
        d[o + 3] = 255;
      }
    // soften the filled area a little so it has no streaks
    for (let pass = 0; pass < 2; pass++) {
      const cp = new Uint8ClampedArray(d);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const k = y * w + x;
          if (!mask[k]) continue;
          for (let ch = 0; ch < 3; ch++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += cp[((y + dy) * w + x + dx) * 4 + ch];
            d[k * 4 + ch] = sum / 9;
          }
        }
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').putImageData(img, 0, 0);
    // PNG: no compression ringing around the removed letters
    const bytes = await PE.canvasToBytes(c, 'image/png');
    const id = PE.uid('a');
    PE.addAssetRaw(id, bytes, 'image/png', w, h);
    return { a: id, x: x0 / scale, y: y0 / scale, w: w / scale, h: h / scale, c: PE.rgbToHex(avg[0], avg[1], avg[2]) };
  }

  /* ---------- searchable text in the saved PDF ---------- */
  /** invisible text over the scan for paragraphs that were not edited */
  O.drawInvisible = async function (page, B2U, b, fontFor) {
    const L = PDFLib;
    const r0 = b.runs[0];
    const f = await fontFor(PE.fonts.fontId(r0.f, r0.b, false));
    page.setFont(f);
    const key = page.fontKey;
    for (const ln of b.lines || []) {
      const t = ln.t.replace(/[^ -ɏ -⃿]/g, ' ');
      if (!t.trim()) continue;
      let width;
      try {
        width = f.widthOfTextAtSize(t, r0.s);
      } catch (e) {
        continue;
      }
      const hs = PE.clamp((ln.w / Math.max(1, width)) * 100, 30, 300);
      const M = PE.M.mul(B2U, [1, 0, 0, -1, ln.x, ln.y]);
      page.pushOperators(
        L.pushGraphicsState(),
        L.beginText(),
        L.setFontAndSize(key, r0.s),
        L.setTextRenderingMode(L.TextRenderingMode.Invisible),
        L.PDFOperator.of('Tz', [L.PDFNumber.of(hs)]),
        L.setTextMatrix(M[0], M[1], M[2], M[3], M[4], M[5]),
        L.showText(f.encodeText(t)),
        L.endText(),
        L.popGraphicsState()
      );
    }
  };
})();
