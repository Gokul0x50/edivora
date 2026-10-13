/* Pagewright — shared helpers */
'use strict';
const PE = (window.PE = window.PE || {});

PE.$ = (s, r = document) => r.querySelector(s);
PE.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/** Small element factory: PE.h('div', {class:'x', onclick:fn}, [children]) */
PE.h = function (tag, attrs, children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  if (children != null) {
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  return el;
};

PE.icon = (name, cls) =>
  `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

let _uidN = 0;
PE.uid = (p = 'o') => p + (++_uidN).toString(36) + Math.random().toString(36).slice(2, 7);
PE.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
PE.round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
PE.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
PE.raf = () => new Promise((r) => requestAnimationFrame(() => r()));

PE.debounce = function (fn, ms) {
  let t;
  const d = function (...a) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  d.cancel = () => clearTimeout(t);
  return d;
};

PE.clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

/* ---------- 2D affine matrices [a,b,c,d,e,f]: x' = a x + c y + e ; y' = b x + d y + f ---------- */
PE.M = {
  I: [1, 0, 0, 1, 0, 0],
  mul(m, n) {
    // result = m ∘ n (apply n first, then m)
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  },
  chain(...ms) {
    return ms.reduce((acc, m) => PE.M.mul(acc, m), PE.M.I);
  },
  inv(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return PE.M.I.slice();
    return [
      m[3] / det,
      -m[1] / det,
      -m[2] / det,
      m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det,
      (m[1] * m[4] - m[0] * m[5]) / det,
    ];
  },
  apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  },
  tr: (x, y) => [1, 0, 0, 1, x, y],
  sc: (x, y = x) => [x, 0, 0, y, 0, 0],
  rot(deg) {
    const r = (deg * Math.PI) / 180,
      c = Math.cos(r),
      s = Math.sin(r);
    return [c, s, -s, c, 0, 0];
  },
};

/** rotate vector by deg (clockwise in y-down screen space) */
PE.rotVec = (x, y, deg) => {
  const r = (deg * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
};

/* ---------- colors ---------- */
PE.hexToRgb01 = (hex) => {
  hex = (hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
PE.rgbToHex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(PE.clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
PE.pdfColor = (hex) => {
  const [r, g, b] = PE.hexToRgb01(hex);
  return PDFLib.rgb(r, g, b);
};

/* ---------- files ---------- */
PE.readFile = (file) =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(new Uint8Array(fr.result));
    fr.onerror = () => rej(fr.error);
    fr.readAsArrayBuffer(file);
  });

PE.download = (bytesOrBlob, name, mime = 'application/pdf') => {
  const blob = bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = PE.h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 4000);
};

PE.pickFiles = (accept, multiple = false) =>
  new Promise((res) => {
    const inp = PE.h('input', { type: 'file', accept, style: { display: 'none' } });
    if (multiple) inp.multiple = true;
    inp.addEventListener('change', () => {
      res(Array.from(inp.files || []));
      inp.remove();
    });
    // resolve empty when dialog is cancelled (best effort)
    window.addEventListener(
      'focus',
      () =>
        setTimeout(() => {
          if (!inp.files || !inp.files.length) res([]);
        }, 800),
      { once: true }
    );
    document.body.appendChild(inp);
    inp.click();
  });

PE.loadScript = (src) =>
  new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });

PE.b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Decode an image file into {bytes(png|jpg), mime, w, h} usable by pdf-lib */
PE.normalizeImage = async (bytes, mime) => {
  const blob = new Blob([bytes], { type: mime || 'image/png' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('This image format could not be read.'));
      im.src = url;
    });
    const w = img.naturalWidth,
      h = img.naturalHeight;
    if (mime === 'image/jpeg' || mime === 'image/png') return { bytes, mime, w, h };
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0);
    const out = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { bytes: new Uint8Array(await out.arrayBuffer()), mime: 'image/png', w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
};

PE.canvasToBytes = async (canvas, mime = 'image/png', q = 0.92) => {
  const blob = await new Promise((r) => canvas.toBlob(r, mime, q));
  return new Uint8Array(await blob.arrayBuffer());
};

/* ---------- IndexedDB key/value (session restore) ---------- */
PE.idb = (() => {
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('pagewright', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) {
        rej(e);
      }
    });
    return dbp;
  };
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const st = t.objectStore('kv');
      const r = fn(st);
      t.oncomplete = () => res(r && r.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => undefined),
    del: (k) => tx('readwrite', (s) => s.delete(k)).catch(() => undefined),
  };
})();

PE.store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('pw.' + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('pw.' + k, JSON.stringify(v));
    } catch (e) {}
  },
};

/* ---------- toast ---------- */
PE.toast = (msg, kind = 'info', ms = 3200) => {
  const host = PE.$('#toasts');
  if (!host) return;
  const t = PE.h('div', { class: 'toast ' + kind, role: 'status' }, msg);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  }, ms);
};

PE.isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
PE.mod = (e) => (PE.isMac ? e.metaKey : e.ctrlKey);
PE.esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Split string into grapheme clusters (keeps Indic syllables together) */
PE.graphemes = (() => {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return (s) => (seg ? Array.from(seg.segment(s), (x) => x.segment) : Array.from(s));
})();
