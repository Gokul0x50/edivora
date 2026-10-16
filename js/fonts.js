/* Edivora — bundled fonts: same bytes are used for on-screen display and for the exported PDF */
'use strict';
(function () {
  const FAMILIES = [
    { key: 'arimo', name: 'Arial / Helvetica', generic: 'sans-serif' },
    { key: 'carlito', name: 'Calibri', generic: 'sans-serif' },
    { key: 'tinos', name: 'Times New Roman', generic: 'serif' },
    { key: 'caladea', name: 'Cambria', generic: 'serif' },
    { key: 'cousine', name: 'Courier New', generic: 'monospace' },
    { key: 'roboto', name: 'Roboto', generic: 'sans-serif' },
    { key: 'open-sans', name: 'Open Sans', generic: 'sans-serif' },
    { key: 'lato', name: 'Lato', generic: 'sans-serif' },
    { key: 'montserrat', name: 'Montserrat', generic: 'sans-serif' },
    { key: 'poppins', name: 'Poppins', generic: 'sans-serif' },
  ];
  const FALLBACKS = [
    { key: 'noto-sans-tamil', re: /[஀-௿]/ },
    { key: 'noto-sans-devanagari', re: /[ऀ-ॿ꣠-ꣿ]/ },
  ];
  const famByKey = Object.fromEntries(FAMILIES.map((f) => [f.key, f]));
  const isFallback = (k) => FALLBACKS.some((f) => f.key === k);

  const bytes = {}; // id -> Uint8Array
  const pendingBytes = {}; // id -> Promise
  const resolvers = {};
  const faces = {}; // id -> Promise
  const loadedFaces = new Set();
  const fkCache = {};
  const metricsCache = {};
  const listeners = [];

  window.PE_FONT = function (id, b64) {
    bytes[id] = PE.b64ToBytes(b64);
    if (resolvers[id]) resolvers[id](bytes[id]);
  };

  const styleKey = (b, i) => (b && i ? 'bi' : b ? 'b' : i ? 'i' : 'r');
  function fontId(fam, b, i) {
    if (!famByKey[fam] && !isFallback(fam)) fam = 'arimo';
    if (isFallback(fam)) return fam + '-' + (b ? 'b' : 'r');
    return fam + '-' + styleKey(b, i);
  }

  function loadBytes(id) {
    if (bytes[id]) return Promise.resolve(bytes[id]);
    if (pendingBytes[id]) return pendingBytes[id];
    pendingBytes[id] = new Promise((res, rej) => {
      resolvers[id] = res;
      PE.loadScript('fonts/' + id + '.js').catch((e) => {
        delete pendingBytes[id];
        rej(e);
      });
    });
    return pendingBytes[id];
  }

  const notify = PE.debounce(() => listeners.forEach((fn) => fn()), 60);

  function ensureId(id) {
    if (faces[id]) return faces[id];
    const [fam] = splitId(id);
    const st = id.slice(fam.length + 1);
    faces[id] = loadBytes(id)
      .then(async (b) => {
        const face = new FontFace('PEF-' + fam, b, {
          weight: st.includes('b') ? '700' : '400',
          style: st.includes('i') ? 'italic' : 'normal',
        });
        await face.load();
        document.fonts.add(face);
        loadedFaces.add(id);
        notify();
      })
      .catch((e) => {
        console.warn('Font failed', id, e);
      });
    return faces[id];
  }
  function splitId(id) {
    const m = id.match(/^(.*)-(r|b|i|bi)$/);
    return m ? [m[1], m[2]] : [id, 'r'];
  }

  /** Load every face a list of runs needs (including script fallbacks). */
  function ensureRuns(runs) {
    const ps = [];
    for (const r of runs || []) {
      ps.push(ensureId(fontId(r.f, r.b, r.i)));
      for (const fb of FALLBACKS) if (fb.re.test(r.t || '')) ps.push(ensureId(fontId(fb.key, r.b, false)));
    }
    return Promise.all(ps);
  }
  function ensure(fam, b, i) {
    return ensureId(fontId(fam, b, i));
  }
  const isLoaded = (fam, b, i) => loadedFaces.has(fontId(fam, b, i));

  function cssFamily(fam) {
    const f = famByKey[fam] || famByKey.arimo;
    return `"PEF-${f.key}", "PEF-noto-sans-tamil", "PEF-noto-sans-devanagari", ${f.generic}`;
  }

  /** Ascent/descent (per 1px of font size) exactly as the browser lays it out. */
  let mctx;
  function metrics(fam, b, i) {
    const id = fontId(fam, b, i);
    const loaded = loadedFaces.has(id);
    const ck = id + (loaded ? '' : '?');
    if (metricsCache[ck]) return metricsCache[ck];
    mctx = mctx || document.createElement('canvas').getContext('2d');
    mctx.font = `${i ? 'italic ' : ''}${b ? 700 : 400} 100px ${cssFamily(fam)}`;
    const m = mctx.measureText('Hgéy');
    let asc = m.fontBoundingBoxAscent,
      desc = m.fontBoundingBoxDescent;
    if (!(asc > 0)) {
      asc = 90;
      desc = 22;
    }
    const r = { asc: asc / 100, desc: desc / 100 };
    if (loaded) metricsCache[ck] = r;
    return r;
  }

  async function fontkitFont(id) {
    if (fkCache[id]) return fkCache[id];
    const b = await loadBytes(id);
    fkCache[id] = fontkit.create(b);
    return fkCache[id];
  }

  /** Map a font name found in a PDF to the closest bundled family + style. */
  function mapPdfFont(name, fobj) {
    fobj = fobj || {};
    const raw = String(name || fobj.name || '').replace(/^[A-Z]{6}\+/, '');
    const n = raw.toLowerCase().replace(/[\s_,]/g, '');
    const bold =
      /bold|black|heavy|semibold|demibold|extrabold|ultrabold|cmbx|-bd|,bd/.test(n) || !!fobj.bold || !!fobj.black;
    const italic = /italic|oblique|cmti|cmsl|-it$|-bdit|boldit|slanted/.test(n) || !!fobj.italic;
    let fam;
    if (/calibri|carlito/.test(n)) fam = 'carlito';
    else if (/cambria|caladea/.test(n)) fam = 'caladea';
    else if (/courier|cousine|consolas|mono|menlo|lucidaconsole|inconsolata|cmtt|liberationmono/.test(n)) fam = 'cousine';
    else if (/roboto/.test(n)) fam = 'roboto';
    else if (/opensans/.test(n)) fam = 'open-sans';
    else if (/lato/.test(n)) fam = 'lato';
    else if (/montserrat/.test(n)) fam = 'montserrat';
    else if (/poppins/.test(n)) fam = 'poppins';
    else if (
      /times|tinos|liberationserif|georgia|garamond|bookantiqua|palatino|minion|^cm[a-z]*\d|lmroman|nimbusrom|century|baskerville|bodoni|caslon|serif|cambria|bookman|didot|charter|utopia|sabon|playfair|merriweather|lora/.test(
        n
      ) &&
      !/sans/.test(n)
    )
      fam = 'tinos';
    else if (
      /arial|helvetica|arimo|liberationsans|nimbussans|verdana|tahoma|segoe|trebuchet|sans|gothic|franklin|futura|frutiger|myriad|gill|univers|inter|ubuntu|noto|dejavu|source|avenir|proxima|nunito|raleway|candara|corbel|aptos/.test(
        n
      )
    )
      fam = 'arimo';
    else fam = fobj.isMonospace ? 'cousine' : fobj.isSerifFont ? 'tinos' : 'arimo';
    return { f: fam, b: bold, i: italic, original: raw };
  }

  PE.fonts = {
    FAMILIES,
    FALLBACKS,
    famByKey,
    fontId,
    ensure,
    ensureRuns,
    ensureId,
    isLoaded,
    cssFamily,
    metrics,
    loadBytes,
    fontkitFont,
    mapPdfFont,
    onLoad: (fn) => listeners.push(fn),
    allLoaded: () => Promise.all(Object.values(faces)),
  };
})();
