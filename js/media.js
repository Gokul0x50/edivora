/* Edivora — shared pieces of the image, audio and video editors:
 * mode switching, the WebGL colour/effects engine, filter presets, audio decoding and WAV/MP3 encoding,
 * time formatting and a small "fill in from the surroundings" (inpaint) routine.
 */
'use strict';
(function () {
  const MM = (PE.mm = { list: {}, cur: null });

  /** register an editor mode: { name, label, ext, open(files), close(), ... } */
  MM.register = (m) => (MM.list[m.name] = m);
  MM.active = () => MM.cur;

  /* ---------- formatting ---------- */
  PE.fmtTime = function (s, frac = 1) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60),
      sec = s - m * 60;
    const hh = Math.floor(m / 60);
    const ss = frac ? sec.toFixed(frac).padStart(frac + 3, '0') : String(Math.floor(sec)).padStart(2, '0');
    return (hh ? hh + ':' + String(m % 60).padStart(2, '0') : m) + ':' + ss;
  };
  PE.fmtBytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');

  /* ---------- file kinds ---------- */
  PE.kindOf = function (f) {
    const n = (f.name || '').toLowerCase(),
      t = f.type || '';
    if (/\.docx$/.test(n)) return 'docx';
    if (/pdf$/.test(t) || /\.pdf$/.test(n)) return 'pdf';
    if (/^image\//.test(t) || /\.(png|jpe?g|webp|gif|bmp|avif|heic|svg|ico)$/.test(n)) return 'image';
    if (/^video\//.test(t) || /\.(mp4|webm|mov|m4v|mkv|ogv|avi|3gp)$/.test(n)) return 'video';
    if (/^audio\//.test(t) || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|wma|amr)$/.test(n)) return 'audio';
    return 'other';
  };

  /* ---------- audio ---------- */
  let actx = null;
  PE.audioCtx = function () {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  };
  PE.decodeAudio = async function (bytes) {
    const ctx = PE.audioCtx();
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(ab, res, (e) => rej(e || new Error('This audio could not be decoded.')));
      if (p && p.then) p.then(res, rej);
    });
  };
  PE.newBuffer = (ch, len, rate) => PE.audioCtx().createBuffer(Math.max(1, ch), Math.max(1, len | 0), rate);

  /** 16-bit (or 24-bit / 32-bit float) WAV file */
  PE.encodeWav = function (buf, bits = 16) {
    const ch = buf.numberOfChannels,
      len = buf.length,
      rate = buf.sampleRate;
    const bps = bits / 8;
    const fmt = bits === 32 ? 3 : 1;
    const dataLen = len * ch * bps;
    const out = new ArrayBuffer(44 + dataLen);
    const v = new DataView(out);
    const str = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    str(0, 'RIFF');
    v.setUint32(4, 36 + dataLen, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, fmt, true);
    v.setUint16(22, ch, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * ch * bps, true);
    v.setUint16(32, ch * bps, true);
    v.setUint16(34, bits, true);
    str(36, 'data');
    v.setUint32(40, dataLen, true);
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++)
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        if (bits === 16) {
          v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          o += 2;
        } else if (bits === 24) {
          const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
          v.setUint8(o, x & 255);
          v.setUint8(o + 1, (x >> 8) & 255);
          v.setUint8(o + 2, (x >> 16) & 255);
          o += 3;
        } else {
          v.setFloat32(o, s, true);
          o += 4;
        }
      }
    return new Uint8Array(out);
  };

  /** MP3 with LAME (loaded on first use); yields to the page so progress can show */
  PE.encodeMp3 = async function (buf, kbps = 192, onProgress) {
    if (!window.lamejs) await PE.loadScript('lib/lame.min.js');
    const ch = Math.min(2, buf.numberOfChannels);
    let rate = buf.sampleRate;
    // LAME supports the usual MPEG rates only
    if (![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(rate)) {
      buf = await PE.resample(buf, 44100);
      rate = 44100;
    }
    const enc = new lamejs.Mp3Encoder(ch, rate, kbps);
    const L = buf.getChannelData(0),
      R = ch > 1 ? buf.getChannelData(1) : null;
    const block = 1152 * 20;
    const parts = [];
    const toI16 = (f, a, b) => {
      const o = new Int16Array(b - a);
      for (let i = a; i < b; i++) {
        const s = Math.max(-1, Math.min(1, f[i]));
        o[i - a] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return o;
    };
    let t = performance.now();
    for (let i = 0; i < L.length; i += block) {
      const e = Math.min(L.length, i + block);
      const d = R ? enc.encodeBuffer(toI16(L, i, e), toI16(R, i, e)) : enc.encodeBuffer(toI16(L, i, e));
      if (d.length) parts.push(new Uint8Array(d.buffer, d.byteOffset, d.length).slice());
      if (performance.now() - t > 60) {
        onProgress && onProgress(i / L.length);
        await new Promise((r) => setTimeout(r, 0));
        t = performance.now();
      }
    }
    const end = enc.flush();
    if (end.length) parts.push(new Uint8Array(end.buffer, end.byteOffset, end.length).slice());
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  PE.resample = async function (buf, rate, channels) {
    const ch = channels || buf.numberOfChannels;
    const off = new OfflineAudioContext(ch, Math.max(1, Math.ceil((buf.length * rate) / buf.sampleRate)), rate);
    const s = off.createBufferSource();
    s.buffer = buf;
    s.connect(off.destination);
    s.start();
    return off.startRendering();
  };

  /** min/max peaks of a buffer, cached (for waveforms) */
  const peakCache = new WeakMap();
  PE.peaks = function (buf, spp = 256) {
    let c = peakCache.get(buf);
    if (!c) {
      c = {};
      peakCache.set(buf, c);
    }
    if (c[spp]) return c[spp];
    const n = Math.ceil(buf.length / spp);
    const mn = new Float32Array(n),
      mx = new Float32Array(n);
    const chans = [];
    for (let k = 0; k < buf.numberOfChannels; k++) chans.push(buf.getChannelData(k));
    for (let i = 0; i < n; i++) {
      let lo = 0,
        hi = 0;
      const a = i * spp,
        b = Math.min(buf.length, a + spp);
      for (const d of chans)
        for (let j = a; j < b; j++) {
          const v = d[j];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      mn[i] = lo;
      mx[i] = hi;
    }
    c[spp] = { mn, mx, spp };
    return c[spp];
  };

  /* ---------- colour & effects engine (WebGL) ---------- */
  /** every adjustment, its range and default; shared by the image and video editors */
  PE.ADJ = [
    { k: 'exposure', label: 'Exposure', min: -1, max: 1, step: 0.01 },
    { k: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.01 },
    { k: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01 },
    { k: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01 },
    { k: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01 },
    { k: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01 },
    { k: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01 },
    { k: 'temperature', label: 'Warmth', min: -1, max: 1, step: 0.01 },
    { k: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01 },
    { k: 'hue', label: 'Hue', min: -180, max: 180, step: 1 },
    { k: 'fade', label: 'Fade', min: 0, max: 1, step: 0.01 },
    { k: 'sharpen', label: 'Sharpen', min: 0, max: 1, step: 0.01 },
    { k: 'blur', label: 'Blur', min: 0, max: 1, step: 0.01 },
    { k: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01 },
    { k: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01 },
  ];
  PE.ADJ_EXTRA = ['grayscale', 'sepia', 'invert'];
  PE.isNeutral = (a) => !a || (PE.ADJ.every((d) => !a[d.k]) && PE.ADJ_EXTRA.every((k) => !a[k]));
  PE.FILTERS = [
    { name: 'Original', a: {} },
    { name: 'Vivid', a: { contrast: 0.15, saturation: 0.35, vibrance: 0.2 } },
    { name: 'Warm', a: { temperature: 0.35, saturation: 0.1, exposure: 0.05 } },
    { name: 'Cool', a: { temperature: -0.35, tint: -0.05, contrast: 0.05 } },
    { name: 'B&W', a: { grayscale: 1, contrast: 0.15 } },
    { name: 'Noir', a: { grayscale: 1, contrast: 0.45, exposure: -0.1, vignette: 0.5 } },
    { name: 'Sepia', a: { sepia: 1, fade: 0.1 } },
    { name: 'Vintage', a: { sepia: 0.35, fade: 0.3, contrast: -0.1, vignette: 0.35, grain: 0.25, temperature: 0.15 } },
    { name: 'Faded', a: { fade: 0.45, saturation: -0.25, contrast: -0.15 } },
    { name: 'Dramatic', a: { contrast: 0.5, highlights: -0.3, shadows: 0.2, saturation: -0.1, vignette: 0.4 } },
    { name: 'Matte', a: { fade: 0.3, contrast: 0.1, saturation: -0.1 } },
    { name: 'Golden', a: { temperature: 0.5, tint: 0.1, exposure: 0.1, saturation: 0.15 } },
    { name: 'Teal', a: { temperature: -0.25, tint: -0.2, contrast: 0.2, saturation: 0.15 } },
    { name: 'Lomo', a: { contrast: 0.35, saturation: 0.4, vignette: 0.7 } },
    { name: 'Soft', a: { blur: 0.08, fade: 0.15, exposure: 0.08 } },
    { name: 'Bright', a: { exposure: 0.25, shadows: 0.25, vibrance: 0.15 } },
    { name: 'Moody', a: { exposure: -0.15, contrast: 0.2, saturation: -0.3, temperature: -0.1, vignette: 0.45 } },
    { name: 'Invert', a: { invert: 1 } },
  ];

  const VS = `attribute vec2 p; varying vec2 uv; void main(){ uv = (p + 1.0) * 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;
  const FS = `precision highp float;
varying vec2 uv; uniform sampler2D tex; uniform vec2 px; uniform float seed;
uniform float exposure, brightness, contrast, highlights, shadows, saturation, vibrance, temperature, tint, hue, fade, sharpen, blur, vignette, grain, grayscale, sepia, invert;
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float rnd(vec2 co){ return fract(sin(dot(co + seed, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec4 base = texture2D(tex, uv);
  vec4 col = base;
  if (blur > 0.0) {
    float r = blur * 24.0; vec4 acc = vec4(0.0); float wsum = 0.0;
    for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) {
      vec2 o = vec2(float(i), float(j)) * r / 3.0;
      float w = exp(-dot(o, o) / (2.0 * max(1.0, r * r / 2.0)));
      acc += texture2D(tex, uv + o * px) * w; wsum += w;
    }
    col = acc / wsum;
  }
  if (sharpen > 0.0) {
    vec4 n = texture2D(tex, uv + vec2(px.x, 0.0)) + texture2D(tex, uv - vec2(px.x, 0.0)) + texture2D(tex, uv + vec2(0.0, px.y)) + texture2D(tex, uv - vec2(0.0, px.y));
    col.rgb += (col.rgb * 4.0 - n.rgb) * sharpen * 1.5;
  }
  vec3 c = col.rgb / max(col.a, 0.0001); // work on straight (un-premultiplied) colour
  c *= pow(2.0, exposure * 1.5);
  c += brightness * 0.35;
  c = (c - 0.5) * (1.0 + contrast * (contrast > 0.0 ? 1.4 : 1.0)) + 0.5;
  float l = lum(c);
  c += shadows * 0.45 * (1.0 - smoothstep(0.0, 0.55, l)) * (1.0 - l);
  c += highlights * 0.45 * smoothstep(0.45, 1.0, l) * l;
  c.r += temperature * 0.12; c.b -= temperature * 0.12; c.g += tint * 0.1;
  l = lum(c);
  c = mix(vec3(l), c, 1.0 + saturation);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  c = mix(vec3(lum(c)), c, 1.0 + vibrance * (1.0 - (mx - mn)) * 1.2);
  if (hue != 0.0) {
    float a = radians(hue);
    mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
    mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
    vec3 yiq = toYIQ * c; float cs = cos(a), sn = sin(a);
    yiq = vec3(yiq.x, yiq.y * cs - yiq.z * sn, yiq.y * sn + yiq.z * cs);
    c = toRGB * yiq;
  }
  c = mix(c, c * (1.0 - fade * 0.35) + fade * 0.18, 1.0);
  if (grayscale > 0.0) c = mix(c, vec3(lum(c)), grayscale);
  if (sepia > 0.0) { vec3 s = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131))); c = mix(c, s, sepia); }
  if (invert > 0.0) c = mix(c, 1.0 - c, invert);
  if (vignette > 0.0) { float d = distance(uv, vec2(0.5)); c *= 1.0 - vignette * smoothstep(0.3, 0.85, d) * 0.85; }
  if (grain > 0.0) c += (rnd(uv * 1000.0) - 0.5) * grain * 0.25;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0) * col.a, col.a);
}`;
  const UNIFORMS = PE.ADJ.map((d) => d.k).concat(PE.ADJ_EXTRA);

  /** WebGL renderer: draw(src, params, w, h) -> canvas with the adjustments applied (premultiplied alpha kept) */
  PE.createAdjuster = function () {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true }) || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
    if (!gl) return { ok: false, canvas, draw: (src, p, w, h) => fallbackDraw(canvas, src, w, h) };
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    const U = {};
    for (const k of UNIFORMS.concat(['px', 'seed'])) U[k] = gl.getUniformLocation(prog, k);
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    return {
      ok: true,
      canvas,
      maxTex,
      draw(src, p, w, h) {
        w = Math.max(1, Math.round(w));
        h = Math.max(1, Math.round(h));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        } catch (e) {
          return fallbackDraw(canvas, src, w, h);
        }
        p = p || {};
        for (const k of UNIFORMS) gl.uniform1f(U[k], +p[k] || 0);
        const sw = src.videoWidth || src.naturalWidth || src.width,
          shh = src.videoHeight || src.naturalHeight || src.height;
        // blur/sharpen strength relative to the output size
        gl.uniform2f(U.px, 1 / Math.max(1, Math.min(sw, w)), 1 / Math.max(1, Math.min(shh, h)));
        gl.uniform1f(U.seed, p.grain ? Math.random() * 10 : 0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return canvas;
      },
    };
  };
  function fallbackDraw(canvas, src, w, h) {
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(src, 0, 0, w, h);
    return canvas;
  }

  /* ---------- inpaint: fill masked pixels from the clean pixels around them ---------- */
  PE.inpaint = function (img, mask) {
    const { width: w, height: h, data: d } = img;
    const n = w * h;
    const up = new Int32Array(n),
      dn = new Int32Array(n),
      lf = new Int32Array(n),
      rt = new Int32Array(n);
    for (let x = 0; x < w; x++) {
      let last = -1;
      for (let y = 0; y < h; y++) {
        if (!mask[y * w + x]) last = y;
        up[y * w + x] = last;
      }
      last = -1;
      for (let y = h - 1; y >= 0; y--) {
        if (!mask[y * w + x]) last = y;
        dn[y * w + x] = last;
      }
    }
    for (let y = 0; y < h; y++) {
      let last = -1;
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) last = x;
        lf[y * w + x] = last;
      }
      last = -1;
      for (let x = w - 1; x >= 0; x--) {
        if (!mask[y * w + x]) last = x;
        rt[y * w + x] = last;
      }
    }
    const src = new Uint8ClampedArray(d);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (!mask[k]) continue;
        let s = [0, 0, 0, 0],
          sw = 0;
        const add = (kk, dist) => {
          const wt = 1 / (dist * dist);
          for (let c = 0; c < 4; c++) s[c] += src[kk * 4 + c] * wt;
          sw += wt;
        };
        if (up[k] >= 0) add(up[k] * w + x, y - up[k]);
        if (dn[k] >= 0) add(dn[k] * w + x, dn[k] - y);
        if (lf[k] >= 0) add(y * w + lf[k], x - lf[k]);
        if (rt[k] >= 0) add(y * w + rt[k], rt[k] - x);
        if (sw) for (let c = 0; c < 4; c++) d[k * 4 + c] = s[c] / sw;
      }
    // smooth the filled area
    for (let pass = 0; pass < 2; pass++) {
      const cp = new Uint8ClampedArray(d);
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const k = y * w + x;
          if (!mask[k]) continue;
          for (let c = 0; c < 4; c++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += cp[((y + dy) * w + x + dx) * 4 + c];
            d[k * 4 + c] = sum / 9;
          }
        }
    }
    return img;
  };

  /* ---------- small UI helpers shared by the media editors ---------- */
  /** labelled slider with a live value; onChange(v, live) */
  PE.slider = function (label, value, min, max, step, onChange, fmt) {
    const f = fmt || ((v) => (max <= 1 && min >= -1 && step < 1 ? Math.round(v * 100) : Math.round(v * 10) / 10));
    const out = PE.h('output', {}, String(f(value)));
    const inp = PE.h('input', { type: 'range', min, max, step, value, 'aria-label': label });
    inp.addEventListener('input', () => {
      out.textContent = f(+inp.value);
      onChange(+inp.value, true);
    });
    inp.addEventListener('change', () => onChange(+inp.value, false));
    // double-click resets to the middle / zero
    inp.addEventListener('dblclick', () => {
      const z = min < 0 ? 0 : min;
      inp.value = z;
      out.textContent = f(z);
      onChange(z, false);
    });
    return PE.h('label', { class: 'mslider' }, [PE.h('span', {}, label), inp, out]);
  };
  PE.download2 = (bytes, name, mime) => PE.download(bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime }), name, mime);
})();
