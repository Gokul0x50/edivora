/* Edivora — video editor: multitrack timeline (video, pictures, text, shapes, music), trim / split / speed / volume,
 * transitions and motion, colour adjustments and filters, captions (.srt), and export to MP4 / WebM (WebCodecs,
 * with a real-time recorder as fallback), animated GIF, audio-only and still frames.
 */
'use strict';
(function () {
  const $ = PE.$,
    h = PE.h,
    icon = PE.icon;
  const VE = (PE.vid = { name: 'video', label: 'Video', ext: '.mp4', accepts: ['video', 'audio', 'image'], dropText: 'Drop videos, pictures or music to add them' });
  PE.mm.register(VE);

  /* project */
  let V = null; // { w, h, fps, bg, tracks: [{id,name,kind,mute,hidden,lock}], items: [...] }
  const M = new Map(); // media id -> { id, name, kind, blob, url, w, h, dur, hasAudio, bmp, abuf, thumbs }
  let sel = null; // selected item id
  let t = 0; // playhead
  let els = null,
    gl = null,
    panelTab = 'add',
    pps = 40,
    scrollX = 0,
    scrollY = 0,
    snap = true;
  let idSeq = 1;
  const nid = (p) => p + Date.now().toString(36) + (idSeq++).toString(36);
  const RULER = 24;
  const TH = () => (window.innerWidth < 860 ? 46 : 54);
  
  const TRANSITIONS = [
    ['none', 'None'],
    ['fade', 'Fade'],
    ['slide-left', 'Slide ←'],
    ['slide-right', 'Slide →'],
    ['slide-up', 'Slide ↑'],
    ['slide-down', 'Slide ↓'],
    ['zoom', 'Zoom'],
    ['wipe-left', 'Wipe →'],
    ['wipe-right', 'Wipe ←'],
    ['blur', 'Blur'],
    ['spin', 'Spin'],
  ];
  const TEXT_IN = [['type', 'Typewriter'], ['pop', 'Pop']];
  const ANIMS = [
    ['none', 'None'],
    ['zoom-in', 'Slow zoom in'],
    ['zoom-out', 'Slow zoom out'],
    ['pan-left', 'Pan left'],
    ['pan-right', 'Pan right'],
    ['pulse', 'Pulse'],
    ['shake', 'Shake'],
  ];
  const TEXT_STYLES = [
    { name: 'Title', o: { size: 0.11, b: true, color: '#ffffff', f: 'montserrat', stroke: '', sw: 0, bg: null, shadow: true, y: 0.5 } },
    { name: 'Subtitle', o: { size: 0.06, b: false, color: '#ffffff', f: 'opensans', bg: null, shadow: true, y: 0.62 } },
    { name: 'Caption', o: { size: 0.05, b: true, color: '#ffffff', f: 'arimo', bg: 'rgba(0,0,0,0.6)', shadow: false, y: 0.86 } },
    { name: 'Lower third', o: { size: 0.055, b: true, color: '#111111', f: 'poppins', bg: '#ffffff', shadow: true, y: 0.8, x: 0.3 } },
    { name: 'Outline', o: { size: 0.1, b: true, color: '#ffde3b', f: 'montserrat', stroke: '#000000', sw: 6, bg: null, shadow: false, y: 0.5 } },
    { name: 'Neon', o: { size: 0.09, b: true, color: '#7cf7ff', f: 'poppins', bg: null, shadow: true, glow: '#00e5ff', y: 0.5 } },
    { name: 'Handwritten', o: { size: 0.08, b: false, i: true, color: '#ffffff', f: 'lato', bg: null, shadow: true, y: 0.5 } },
    { name: 'Label', o: { size: 0.045, b: true, color: '#ffffff', f: 'arimo', bg: '#e5484d', shadow: false, y: 0.15, x: 0.2 } },
  ];
  const SIZES = [
    ['16:9', 1920, 1080, 'YouTube, TV'],
    ['9:16', 1080, 1920, 'Reels, Shorts, TikTok'],
    ['1:1', 1080, 1080, 'Square post'],
    ['4:5', 1080, 1350, 'Portrait post'],
    ['4:3', 1440, 1080, 'Classic'],
    ['21:9', 2560, 1080, 'Cinema'],
  ];

  /* =========================================================
   *  history
   * ========================================================= */
  const H = { stack: [], idx: -1 };
  function commit() {
    const s = JSON.stringify(V);
    if (H.stack[H.idx] === s) return;
    H.stack.length = H.idx + 1;
    H.stack.push(s);
    if (H.stack.length > 80) H.stack.shift();
    H.idx = H.stack.length - 1;
    PE.app.dirty = true;
    PE.ui.updateHistoryButtons();
  }
  function restore(i) {
    pause();
    H.idx = i;
    V = JSON.parse(H.stack[i]);
    if (sel && !item(sel)) sel = null;
    refreshAll();
    PE.ui.updateHistoryButtons();
  }
  VE.undo = () => H.idx > 0 && restore(H.idx - 1);
  VE.redo = () => H.idx < H.stack.length - 1 && restore(H.idx + 1);
  VE.canUndo = () => H.idx > 0;
  VE.canRedo = () => H.idx < H.stack.length - 1;

  /* =========================================================
   *  model helpers
   * ========================================================= */
  const item = (id) => V && V.items.find((x) => x.id === id);
  const track = (id) => V.tracks.find((x) => x.id === id);
  const end = (it) => it.start + it.dur;
  const isVisual = (it) => it.type !== 'audio';
  const hasSound = (it) => (it.type === 'video' && M.get(it.media) && M.get(it.media).hasAudio !== false) || it.type === 'audio';
  function duration() {
    let d = 0;
    for (const it of V.items) d = Math.max(d, end(it));
    return d;
  }
  function newTrack(kind, at) {
    const n = V.tracks.filter((x) => x.kind === kind).length + 1;
    const tr = { id: nid('T'), name: kind === 'audio' ? 'Audio ' + n : kind === 'main' ? 'Video' : 'Overlay ' + n, kind, mute: false, hidden: false, lock: false };
    if (at == null) {
      // visual tracks above the main one, audio at the bottom
      if (kind === 'audio') V.tracks.push(tr);
      else V.tracks.unshift(tr);
    } else V.tracks.splice(at, 0, tr);
    return tr;
  }
  function mainTrack() {
    return V.tracks.find((x) => x.kind === 'main') || newTrack('main', V.tracks.findIndex((x) => x.kind === 'audio') < 0 ? V.tracks.length : V.tracks.findIndex((x) => x.kind === 'audio'));
  }
  const fits = (tr, it) => (it.type === 'audio' ? tr.kind === 'audio' : tr.kind !== 'audio');
  function free(tr, a, b, ignore) {
    return !V.items.some((x) => x.track === tr.id && x.id !== ignore && x.start < b - 0.001 && end(x) > a + 0.001);
  }
  /** a track of the right kind with room for [a,b], made if needed */
  function trackFor(type, a, b, prefer) {
    const kind = type === 'audio' ? 'audio' : null;
    const order = prefer ? [prefer].concat(V.tracks.filter((x) => x !== prefer)) : V.tracks;
    for (const tr of order) if ((kind ? tr.kind === 'audio' : tr.kind !== 'audio') && !tr.lock && free(tr, a, b)) return tr;
    return newTrack(kind || 'overlay');
  }
  function fitBox(sw, sh, mode = 'contain') {
    const k = mode === 'cover' ? Math.max(V.w / sw, V.h / sh) : Math.min(V.w / sw, V.h / sh);
    return { w: sw * k, h: sh * k, x: V.w / 2, y: V.h / 2 };
  }
  function baseItem(type, o) {
    return Object.assign({ id: nid('i'), type, start: t, dur: 5, in: 0, speed: 1, vol: 1, mute: false, fadeIn: 0, fadeOut: 0, x: V.w / 2, y: V.h / 2, w: V.w, h: V.h, rot: 0, op: 1, flipX: false, flipY: false, crop: null, adj: {}, filter: null, trIn: { type: 'none', dur: 0.6 }, trOut: { type: 'none', dur: 0.6 }, anim: 'none', name: '' }, o);
  }

  /* =========================================================
   *  media library
   * ========================================================= */
  async function importMedia(file) {
    const kind = PE.kindOf(file);
    if (!/^(video|audio|image)$/.test(kind)) return null;
    const id = nid('m');
    const blob = file instanceof Blob ? file : new Blob([file]);
    const m = { id, name: (file.name || kind).replace(/\.[^.]+$/, ''), kind, blob, url: URL.createObjectURL(blob), w: 0, h: 0, dur: 0, hasAudio: kind === 'audio' ? true : null, thumbs: [], size: blob.size };
    if (kind === 'image') {
      let bmp;
      try {
        bmp = await createImageBitmap(blob);
      } catch (e) {
        bmp = await PE.view.loadImg(m.url);
      }
      m.bmp = bmp;
      m.w = bmp.width || bmp.naturalWidth;
      m.h = bmp.height || bmp.naturalHeight;
      m.dur = 5;
    } else {
      const el = document.createElement(kind === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      el.muted = true;
      el.src = m.url;
      await new Promise((res, rej) => {
        el.onloadedmetadata = res;
        el.onerror = () => rej(new Error(`“${file.name}” can’t be played in this browser.`));
        setTimeout(() => rej(new Error(`“${file.name}” took too long to open.`)), 20000);
      });
      // some files report Infinity until they are scanned
      if (!isFinite(el.duration)) {
        el.currentTime = 1e7;
        await new Promise((r) => (el.ontimeupdate = r));
        el.currentTime = 0;
      }
      m.dur = el.duration;
      if (kind === 'video') {
        m.w = el.videoWidth;
        m.h = el.videoHeight;
        if (!m.w) {
          m.kind = 'audio';
          m.hasAudio = true;
        }
      }
      // decode the sound for waveforms and export (in the background)
      m.audioReady = decodeMediaAudio(m);
      if (m.kind === 'video') makeThumbs(m);
    }
    M.set(id, m);
    return m;
  }
  async function decodeMediaAudio(m) {
    if (m.abuf || m.hasAudio === false) return m.abuf;
    try {
      const bytes = new Uint8Array(await m.blob.arrayBuffer());
      m.abuf = await PE.decodeAudio(bytes);
      m.hasAudio = true;
    } catch (e) {
      m.hasAudio = m.kind === 'audio' ? true : false;
    }
    if (els) draw();
    return m.abuf;
  }
  /** small frames along the clip for the timeline */
  async function makeThumbs(m) {
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'auto';
    el.src = m.url;
    await new Promise((r) => {
      el.onloadeddata = r;
      el.onerror = r;
    });
    const n = Math.min(60, Math.max(4, Math.ceil(m.dur / 2)));
    const th = 54,
      tw = Math.max(16, Math.round((th * m.w) / Math.max(1, m.h)));
    for (let i = 0; i < n; i++) {
      const at = Math.min(m.dur - 0.05, ((i + 0.5) / n) * m.dur);
      if (await seekEl(el, at)) {
        const c = document.createElement('canvas');
        c.width = tw;
        c.height = th;
        try {
          c.getContext('2d').drawImage(el, 0, 0, tw, th);
        } catch (e) {}
        m.thumbs[i] = { t: at, c };
        if (i % 4 === 3 && els) draw();
      }
      if (!VE.active) break;
    }
    m.thumbN = n;
    el.removeAttribute('src');
    el.load();
    if (els) draw();
  }
  function seekEl(el, at) {
    return new Promise((res) => {
      if (Math.abs(el.currentTime - at) < 0.0005 && el.readyState >= 2) return res(true);
      let done = false;
      const fin = (ok) => {
        if (done) return;
        done = true;
        el.removeEventListener('seeked', on);
        clearTimeout(to);
        res(ok);
      };
      const on = () => fin(true);
      el.addEventListener('seeked', on);
      const to = setTimeout(() => fin(el.readyState >= 2), 4000);
      try {
        el.currentTime = at;
      } catch (e) {
        fin(false);
      }
    });
  }

  /** put media on the timeline */
  function addMediaItem(m, at, prefer) {
    if (m.kind === 'audio') {
      const a = at != null ? at : t;
      const tr = trackFor('audio', a, a + m.dur, prefer);
      const it = baseItem('audio', { media: m.id, start: a, dur: m.dur, track: tr.id, name: m.name });
      V.items.push(it);
      return it;
    }
    const mt = mainTrack();
    let a = at;
    let tr = prefer && fits(prefer, { type: 'video' }) ? prefer : null;
    if (a == null) {
      // after the last clip of the main track
      a = 0;
      for (const x of V.items) if (x.track === mt.id) a = Math.max(a, end(x));
      tr = mt;
    }
    const dur = m.kind === 'image' ? 5 : m.dur;
    if (!tr || !free(tr, a, a + dur)) tr = trackFor('video', a, a + dur, mt);
    const box = fitBox(m.w, m.h, 'contain');
    const it = baseItem(m.kind === 'image' ? 'image' : 'video', Object.assign({ media: m.id, start: a, dur, track: tr.id, name: m.name }, box));
    V.items.push(it);
    return it;
  }

  /* =========================================================
   *  open / close
   * ========================================================= */
  VE.open = async function (files, o = {}) {
    build();
    VE.active = true;
    document.body.classList.add('mode-video');
    if (!gl) gl = PE.createAdjuster();
    for (const m of M.values()) URL.revokeObjectURL(m.url);
    M.clear();
    dropEls();
    V = { w: 1920, h: 1080, fps: 30, bg: '#000000', tracks: [], items: [] };
    sel = null;
    t = 0;
    scrollX = scrollY = 0;
    H.stack = [];
    H.idx = -1;
    newTrack('main');
    await PE.raf();
    if (files.length) {
      const ms = [];
      for (const f of files) {
        PE.ui.busy(true, 'Reading ' + f.name, 0.3);
        try {
          const m = await importMedia(f);
          if (m) ms.push(m);
        } catch (e) {
          PE.toast(e.message, 'error', 6000);
        }
      }
      PE.ui.busy(false);
      // the first video (or picture) sets the project size
      const first = ms.find((m) => m.kind === 'video') || ms.find((m) => m.kind === 'image');
      if (first) {
        let w = first.w,
          hh = first.h;
        const k = Math.min(1, 3840 / Math.max(w, hh));
        V.w = Math.round((w * k) / 2) * 2;
        V.h = Math.round((hh * k) / 2) * 2;
      }
      for (const m of ms) {
        if (m.kind === 'audio') {
          t = 0;
          addMediaItem(m, 0);
        } else addMediaItem(m);
      }
      t = 0;
      if (!ms.length) throw new Error('These files could not be opened.');
      PE.app.setFileName(files[0].name.replace(/\.[^.]+$/, '') + '.mp4');
    }
    commit();
    PE.app.dirty = false;
    panelTab = V.items.length ? 'edit' : 'add';
    refreshAll();
    await PE.raf();
    fitTimeline();
    layoutPreview();
  };
  VE.close = function () {
    pause();
    VE.active = false;
    document.body.classList.remove('mode-video');
    dropEls();
    for (const m of M.values()) URL.revokeObjectURL(m.url);
    M.clear();
    V = null;
    H.stack = [];
    H.idx = -1;
  };
  VE.addFiles = async function (files, e) {
    const at = null;
    let n = 0;
    for (const f of files) {
      PE.ui.busy(true, 'Reading ' + f.name, 0.4);
      try {
        const m = await importMedia(f);
        if (!m) continue;
        const wasEmpty = !V.items.length;
        if (wasEmpty && m.kind !== 'audio') {
          V.w = Math.round(Math.min(3840, m.w) / 2) * 2 || V.w;
          V.h = Math.round((V.w * m.h) / m.w / 2) * 2 || V.h;
        }
        addMediaItem(m, m.kind === 'audio' ? t : at);
        n++;
      } catch (err) {
        PE.toast(err.message, 'error', 6000);
      }
    }
    PE.ui.busy(false);
    void e;
    if (n) {
      commit();
      refreshAll();
      layoutPreview();
    }
  };
  VE.onPaste = async function (e) {
    const tg = e.target;
    if (tg && (/^(INPUT|TEXTAREA)$/.test(tg.tagName) || tg.isContentEditable)) return;
    const it = Array.from((e.clipboardData && e.clipboardData.items) || []).find((i) => i.kind === 'file');
    if (!it) return;
    e.preventDefault();
    const f = it.getAsFile();
    VE.addFiles([new File([f], f.name || 'Pasted', { type: f.type })]);
  };

  /* =========================================================
   *  DOM
   * ========================================================= */
  function build() {
    if (els) return;
    const view = $('#vid-view');
    const stage = h('div', { class: 'vstage' });
    const canvas = h('canvas', { class: 'vcanvas' });
    const ui = h('div', { class: 'vui' });
    const frame = h('div', { class: 'vframe' }, [canvas, ui]);
    stage.appendChild(frame);
    const tb = (id, ic, title, fn, cls) => h('button', { class: 'icon-btn ' + (cls || ''), 'data-a': id, title, 'aria-label': title, html: icon(ic), onclick: fn });
    const time = h('div', { class: 'atime' }, [h('b', {}, '0:00.0'), h('span', {}, '/ 0:00.0')]);
    const sizeBtn = h('button', { class: 'btn sm ghost vsize', title: 'Video size', onclick: (e) => sizeMenu(e.currentTarget) }, '16:9');
    const transport = h('div', { class: 'vtrans' }, [
      h('div', { class: 'agrp' }, [tb('start', 'skip-back', 'Go to start (Home)', () => seek(0)), tb('back', 'left', 'Previous frame (←)', () => seek(t - 1 / V.fps)), tb('play', 'play', 'Play / pause (Space)', togglePlay, 'aplay'), tb('fwd', 'right', 'Next frame (→)', () => seek(t + 1 / V.fps)), tb('end', 'skip-fwd', 'Go to end (End)', () => seek(duration()))]),
      time,
      h('div', { class: 'agrp aright' }, [sizeBtn, tb('snapshot', 'photo', 'Save this frame as a picture', snapshot), tb('full', 'fit', 'Full screen preview', fullscreen)]),
    ]);
    const prev = h('div', { class: 'vprev' }, [stage, transport]);
    // timeline
    const tbar = h('div', { class: 'vtbar' }, [
      h('div', { class: 'agrp' }, [
        tb('split', 'split', 'Split at the playhead (S)', splitHere),
        tb('del', 'trash', 'Delete (Del)', () => del(false)),
        tb('ripple', 'scissors', 'Delete and close the gap (Shift+Del)', () => del(true)),
        tb('dup', 'copy', 'Duplicate (Ctrl+D)', duplicate),
      ]),
      h('div', { class: 'agrp' }, [tb('addmedia', 'upload', 'Add videos, pictures or music', importPicker), tb('addtext', 'text', 'Add text', () => addText(TEXT_STYLES[0])), tb('snap', 'magnet', 'Snap to clips and playhead', () => ((snap = !snap), syncBar()))]),
      h('div', { class: 'agrp aright' }, [tb('zout', 'minus', 'Zoom out timeline', () => setPps(pps / 1.4)), tb('zfit', 'fit', 'Fit timeline', fitTimeline), tb('zin', 'plus', 'Zoom in timeline', () => setPps(pps * 1.4))]),
    ]);
    const heads = h('div', { class: 'vheads' });
    const headsIn = h('div', { class: 'aheads-in' });
    heads.append(h('div', { class: 'aheads-top', style: { height: RULER + 'px' } }), headsIn);
    const lanes = h('div', { class: 'alanes vlanes', tabindex: '-1' });
    const cv = h('canvas', { class: 'acv' });
    const empty = h('div', { class: 'aempty vempty' }, [h('span', {}, 'Drop videos, pictures and music here, or use '), btn('Add media', 'upload', importPicker, 'sm primary')]);
    lanes.append(cv, empty);
    const hs = h('div', { class: 'ahscroll' }, [h('div', { class: 'ahscroll-in' })]);
    const tl = h('div', { class: 'vtl' }, [tbar, h('div', { class: 'atl' }, [heads, h('div', { class: 'alanes-col' }, [lanes, hs])])]);
    const col = h('div', { class: 'vcol' }, [prev, tl]);
    const panel = h('aside', { class: 'mpanel vpanel', 'aria-label': 'Video settings' });
    const tabs = h('div', { class: 'mtabs', role: 'tablist' });
    for (const [k, l] of [
      ['add', 'Add'],
      ['edit', 'Edit'],
      ['adjust', 'Colour'],
      ['motion', 'Motion'],
    ])
      tabs.appendChild(h('button', { role: 'tab', 'data-tab': k, onclick: () => ((panelTab = k), refreshPanel()) }, l));
    const body = h('div', { class: 'mpanel-body' });
    panel.append(h('button', { class: 'sheet-handle only-narrow', 'aria-label': 'Collapse panel', html: '<i></i>', onclick: () => (document.body.classList.toggle('mpanel-min'), setTimeout(() => (resizeTl(), layoutPreview()), 60)) }), tabs, body);
    view.append(col, panel);
    els = { view, stage, frame, canvas, ui, time, sizeBtn, transport, tbar, heads, headsIn, lanes, cv, empty, hs, panel, tabs, body };
    hs.addEventListener('scroll', () => {
      if (hs._lock) return;
      scrollX = hs.scrollLeft;
      draw();
    });
    lanes.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    lanes.addEventListener('wheel', onWheel, { passive: false });
    lanes.addEventListener('dragover', (e) => e.dataTransfer.types.includes('text/folio-media') && e.preventDefault());
    lanes.addEventListener('drop', onLibDrop);
    ui.addEventListener('pointerdown', onPrevDown);
    ui.addEventListener('dblclick', () => {
      const it = item(sel);
      if (it && it.type === 'text') {
        panelTab = 'edit';
        refreshPanel();
        setTimeout(() => {
          const ta = els.body.querySelector('textarea');
          ta && (ta.focus(), ta.select());
        }, 30);
      }
    });
    new ResizeObserver(() => VE.active && (layoutPreview(), resizeTl())).observe(stage);
    new ResizeObserver(() => VE.active && resizeTl()).observe(lanes);
    PE.fonts.onLoad(() => VE.active && renderPreview());
  }
  function btn(label, ic, fn, cls) {
    return h('button', { class: 'btn ' + (cls || ''), type: 'button', html: (ic ? icon(ic) : '') + '<span>' + PE.esc(label) + '</span>', onclick: fn });
  }
  function syncBar() {
    if (!els) return;
    els.transport.querySelector('[data-a="play"]').innerHTML = icon(PL.playing ? 'pause' : 'play');
    const s = els.tbar.querySelector('[data-a="snap"]');
    s.classList.toggle('on', snap);
    const cur = SIZES.find((x) => Math.abs(x[1] / x[2] - V.w / V.h) < 0.01);
    els.sizeBtn.textContent = (cur ? cur[0] : V.w + '×' + V.h) + ' · ' + V.h + 'p';
  }
  function refreshAll() {
    if (!els || !V) return;
    els.empty.hidden = V.items.length > 0;
    refreshHeads();
    refreshPanel();
    syncBar();
    resizeTl();
    layoutPreview();
  }
  VE.refresh = refreshAll;

  /* =========================================================
   *  preview
   * ========================================================= */
  let prevK = 1; // css px per project px
  function layoutPreview() {
    if (!els || !V) return;
    const st = els.stage;
    const aw = st.clientWidth - 16,
      ah = st.clientHeight - 16;
    if (aw <= 0 || ah <= 0) return;
    prevK = Math.min(aw / V.w, ah / V.h);
    const cw = Math.max(1, Math.round(V.w * prevK)),
      ch = Math.max(1, Math.round(V.h * prevK));
    els.frame.style.width = cw + 'px';
    els.frame.style.height = ch + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = Math.min(1, (cw * dpr) / V.w);
    const iw = Math.max(2, Math.round(V.w * k)),
      ih = Math.max(2, Math.round(V.h * k));
    if (els.canvas.width !== iw || els.canvas.height !== ih) {
      els.canvas.width = iw;
      els.canvas.height = ih;
    }
    els.canvas.style.width = cw + 'px';
    els.canvas.style.height = ch + 'px';
    renderPreview();
  }
  let rqp = 0;
  function renderPreview() {
    cancelAnimationFrame(rqp);
    rqp = requestAnimationFrame(() => {
      if (!V || !els) return;
      if (!PL.playing) syncMedia(t, false);
      drawFrame(els.canvas.getContext('2d'), t, els.canvas.width / V.w, pool);
      drawSelUI();
      updTime();
    });
  }
  function updTime() {
    els.time.firstChild.textContent = PE.fmtTime(t, 2);
    els.time.lastChild.textContent = '/ ' + PE.fmtTime(duration(), 2);
  }

  /* ---------- frame renderer (shared by preview and export) ---------- */
  const tmpC = document.createElement('canvas');
  const procCache = new Map(); // image item id -> {key, canvas}
  function trProgress(it, lt) {
    // 0..1 entering / leaving; 1 = fully visible
    let pin = 1,
      pout = 1;
    if (it.trIn && it.trIn.type !== 'none' && it.trIn.dur > 0 && lt < it.trIn.dur) pin = ease(lt / it.trIn.dur);
    if (it.trOut && it.trOut.type !== 'none' && it.trOut.dur > 0 && lt > it.dur - it.trOut.dur) pout = ease((it.dur - lt) / it.trOut.dur);
    return { pin, pout };
  }
  const ease = (x) => {
    x = PE.clamp(x, 0, 1);
    return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  };
  function applyTr(ctx, type, p, it, W, Hh, k) {
    // returns extra alpha; may translate/scale/clip the context
    if (p >= 1) return 1;
    switch (type) {
      case 'fade':
        return p;
      case 'slide-left':
        ctx.translate((1 - p) * W * k, 0);
        return 1;
      case 'slide-right':
        ctx.translate(-(1 - p) * W * k, 0);
        return 1;
      case 'slide-up':
        ctx.translate(0, (1 - p) * Hh * k);
        return 1;
      case 'slide-down':
        ctx.translate(0, -(1 - p) * Hh * k);
        return 1;
      case 'zoom': {
        const s = 0.5 + 0.5 * p;
        const cx = it.x * k,
          cy = it.y * k;
        ctx.translate(cx, cy);
        ctx.scale(s, s);
        ctx.translate(-cx, -cy);
        return p;
      }
      case 'spin': {
        const cx = it.x * k,
          cy = it.y * k;
        ctx.translate(cx, cy);
        ctx.rotate((1 - p) * Math.PI);
        ctx.scale(p, p);
        ctx.translate(-cx, -cy);
        return p;
      }
      case 'wipe-left':
      case 'wipe-right': {
        ctx.beginPath();
        if (type === 'wipe-left') ctx.rect(0, 0, W * k * p, Hh * k);
        else ctx.rect(W * k * (1 - p), 0, W * k * p, Hh * k);
        ctx.clip();
        return 1;
      }
      case 'blur':
        if ('filter' in ctx) ctx.filter = `blur(${(1 - p) * 30 * k}px)`;
        return p;
      case 'pop': {
        const s = p < 1 ? 0.6 + 0.4 * (1 + Math.sin(p * Math.PI * 1.5) * (1 - p) * 0.6) * p : 1;
        const cx = it.x * k,
          cy = it.y * k;
        ctx.translate(cx, cy);
        ctx.scale(s, s);
        ctx.translate(-cx, -cy);
        return Math.min(1, p * 2);
      }
      default:
        return 1;
    }
  }
  function sourceOf(it, elPool) {
    const m = M.get(it.media);
    if (!m) return null;
    if (it.type === 'image') return m.bmp;
    const el = elPool && elPool.get(it.id);
    if (!el || el.readyState < 2) return null;
    return el;
  }
  function drawFrame(ctx, time, k, elPool, o = {}) {
    const W = V.w,
      Hh = V.h;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = V.bg || '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (let ti = V.tracks.length - 1; ti >= 0; ti--) {
      const tr = V.tracks[ti];
      if (tr.hidden || tr.kind === 'audio') continue;
      for (const it of V.items) {
        if (it.track !== tr.id || it.type === 'audio') continue;
        if (time < it.start - 1e-6 || time >= end(it) - 1e-6) continue;
        drawItem(ctx, it, time - it.start, k, elPool, W, Hh, o);
      }
    }
    ctx.restore();
  }
  function drawItem(ctx, it, lt, k, elPool, W, Hh) {
    const { pin, pout } = trProgress(it, lt);
    ctx.save();
    let a = it.op == null ? 1 : it.op;
    a *= applyTr(ctx, it.trIn.type, pin, it, W, Hh, k);
    a *= applyTr(ctx, it.trOut.type === 'pop' ? 'fade' : it.trOut.type, pout, it, W, Hh, k);
    ctx.globalAlpha = PE.clamp(a, 0, 1);
    // motion over the whole clip
    let s = 1,
      dx = 0,
      dy = 0,
      rot = 0;
    const f = it.dur > 0 ? lt / it.dur : 0;
    switch (it.anim) {
      case 'zoom-in':
        s = 1 + 0.18 * f;
        break;
      case 'zoom-out':
        s = 1.18 - 0.18 * f;
        break;
      case 'pan-left':
        s = 1.15;
        dx = (0.5 - f) * it.w * 0.12;
        break;
      case 'pan-right':
        s = 1.15;
        dx = (f - 0.5) * it.w * 0.12;
        break;
      case 'pulse':
        s = 1 + 0.05 * Math.sin(lt * Math.PI * 2);
        break;
      case 'shake':
        dx = Math.sin(lt * 53) * it.w * 0.008;
        dy = Math.cos(lt * 47) * it.h * 0.008;
        rot = Math.sin(lt * 31) * 0.6;
        break;
    }
    ctx.translate((it.x + dx) * k, (it.y + dy) * k);
    if (it.rot || rot) ctx.rotate((((it.rot || 0) + rot) * Math.PI) / 180);
    ctx.scale((it.flipX ? -1 : 1) * s, (it.flipY ? -1 : 1) * s);
    const w = it.w * k,
      hh = it.h * k;
    if (it.type === 'video' || it.type === 'image') {
      const src = sourceOf(it, elPool);
      if (src) {
        const m = M.get(it.media);
        const sw = m.w,
          sh = m.h;
        const c = it.crop || { l: 0, t: 0, r: 0, b: 0 };
        let img = src,
          sx = c.l * sw,
          sy = c.t * sh,
          sWid = sw * (1 - c.l - c.r),
          sHei = sh * (1 - c.t - c.b);
        if (!PE.isNeutral(it.adj) && gl && gl.ok) {
          // colour work on the GPU, at the size it is drawn
          const tw = Math.max(2, Math.min(gl.maxTex || 4096, Math.round(Math.abs(w)))),
            th = Math.max(2, Math.min(gl.maxTex || 4096, Math.round(Math.abs(hh))));
          tmpC.width = tw;
          tmpC.height = th;
          const tc = tmpC.getContext('2d');
          tc.drawImage(src, sx, sy, sWid, sHei, 0, 0, tw, th);
          const key = it.type === 'image' ? it.media + JSON.stringify(it.adj) + JSON.stringify(c) + tw + 'x' + th : null;
          const cached = key && procCache.get(it.id);
          if (cached && cached.key === key) img = cached.canvas;
          else {
            const g = gl.draw(tmpC, it.adj, tw, th);
            if (key) {
              const cc = document.createElement('canvas');
              cc.width = tw;
              cc.height = th;
              cc.getContext('2d').drawImage(g, 0, 0);
              procCache.set(it.id, { key, canvas: cc });
              img = cc;
            } else img = g;
          }
          sx = sy = 0;
          sWid = tw;
          sHei = th;
        }
        if (it.radius) {
          rr(ctx, -w / 2, -hh / 2, w, hh, it.radius * k);
          ctx.clip();
        }
        try {
          ctx.drawImage(img, sx, sy, sWid, sHei, -w / 2, -hh / 2, w, hh);
        } catch (e) {}
      }
    } else if (it.type === 'color') {
      ctx.fillStyle = it.fill || '#1f3fcf';
      if (it.grad) {
        const g = ctx.createLinearGradient(-w / 2, -hh / 2, w / 2, hh / 2);
        g.addColorStop(0, it.fill);
        g.addColorStop(1, it.grad);
        ctx.fillStyle = g;
      }
      rr(ctx, -w / 2, -hh / 2, w, hh, (it.radius || 0) * k);
      ctx.fill();
    } else if (it.type === 'shape') drawShape(ctx, it, w, hh, k);
    else if (it.type === 'text') drawText(ctx, it, k, lt);
    ctx.restore();
  }
  function rr(ctx, x, y, w, hh, r) {
    r = Math.max(0, Math.min(r || 0, Math.abs(w) / 2, Math.abs(hh) / 2));
    ctx.beginPath();
    if (!r) return ctx.rect(x, y, w, hh);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hh, r);
    ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawShape(ctx, it, w, hh, k) {
    ctx.beginPath();
    if (it.shape === 'ellipse') ctx.ellipse(0, 0, w / 2, hh / 2, 0, 0, Math.PI * 2);
    else if (it.shape === 'triangle') {
      ctx.moveTo(0, -hh / 2);
      ctx.lineTo(w / 2, hh / 2);
      ctx.lineTo(-w / 2, hh / 2);
      ctx.closePath();
    } else if (it.shape === 'arrow') {
      ctx.moveTo(-w / 2, -hh * 0.18);
      ctx.lineTo(w * 0.15, -hh * 0.18);
      ctx.lineTo(w * 0.15, -hh / 2);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(w * 0.15, hh / 2);
      ctx.lineTo(w * 0.15, hh * 0.18);
      ctx.lineTo(-w / 2, hh * 0.18);
      ctx.closePath();
    } else if (it.shape === 'star') {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.45 : 1;
        ctx.lineTo((Math.cos(a) * w * r) / 2, (Math.sin(a) * hh * r) / 2);
      }
      ctx.closePath();
    } else rr(ctx, -w / 2, -hh / 2, w, hh, (it.radius || 0) * k);
    if (it.fill) {
      ctx.fillStyle = it.fill;
      ctx.fill();
    }
    if (it.stroke && it.sw) {
      ctx.strokeStyle = it.stroke;
      ctx.lineWidth = it.sw * k;
      ctx.stroke();
    }
  }
  function textFont(it, k) {
    return `${it.i ? 'italic ' : ''}${it.b ? 700 : 400} ${it.size * k}px ${PE.fonts.cssFamily(it.f)}`;
  }
  const mctx = document.createElement('canvas').getContext('2d');
  function measureText(it) {
    mctx.font = textFont(it, 1);
    const lines = String(it.text || ' ').split('\n');
    let w = 0;
    for (const ln of lines) w = Math.max(w, mctx.measureText(ln || ' ').width + (it.ls || 0) * Math.max(0, ln.length - 1));
    const pad = it.bg ? it.size * 0.4 : 0;
    it.w = Math.max(10, w + pad * 2 + (it.sw || 0) * 2);
    it.h = Math.max(10, lines.length * it.size * (it.lh || 1.2) + pad * 2 * 0.6);
    PE.fonts.ensure(it.f, !!it.b, !!it.i);
  }
  function drawText(ctx, it, k, lt) {
    let text = String(it.text || '');
    if (it.trIn && it.trIn.type === 'type' && it.trIn.dur > 0 && lt < it.trIn.dur) text = text.slice(0, Math.floor((text.length * lt) / it.trIn.dur));
    const lines = text.split('\n');
    const pad = it.bg ? it.size * 0.4 * k : 0;
    const w = it.w * k,
      hh = it.h * k;
    if (it.bg) {
      ctx.fillStyle = it.bg;
      rr(ctx, -w / 2, -hh / 2, w, hh, it.size * 0.18 * k);
      ctx.fill();
    }
    ctx.font = textFont(it, k);
    ctx.textBaseline = 'middle';
    ctx.textAlign = it.align || 'center';
    const lh = it.size * (it.lh || 1.2) * k;
    const x = it.align === 'left' ? -w / 2 + pad + (it.sw || 0) * k : it.align === 'right' ? w / 2 - pad - (it.sw || 0) * k : 0;
    const y0 = -((lines.length - 1) * lh) / 2;
    if (it.shadow || it.glow) {
      ctx.shadowColor = it.glow || 'rgba(0,0,0,.6)';
      ctx.shadowBlur = (it.glow ? it.size * 0.35 : it.size * 0.12) * k;
      ctx.shadowOffsetY = it.glow ? 0 : it.size * 0.04 * k;
    }
    if ('letterSpacing' in ctx) ctx.letterSpacing = (it.ls || 0) * k + 'px';
    lines.forEach((ln, i) => {
      const y = y0 + i * lh;
      if (it.sw && it.stroke) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = it.sw * 2 * k;
        ctx.strokeStyle = it.stroke;
        ctx.strokeText(ln, x, y);
      }
      ctx.fillStyle = it.color || '#fff';
      ctx.fillText(ln, x, y);
    });
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  /* ---------- media elements for preview playback ---------- */
  const pool = new Map(); // item id -> media element
  function elFor(it, p = pool, muted = false) {
    let el = p.get(it.id);
    const m = M.get(it.media);
    if (!m) return null;
    if (el && el._media !== m.id) {
      el.pause();
      el = null;
    }
    if (!el) {
      el = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
      el._media = m.id;
      el.preload = 'auto';
      el.playsInline = true;
      el.muted = muted;
      el.src = m.url;
      el.addEventListener('seeked', () => !PL.playing && p === pool && renderPreview());
      el.addEventListener('loadeddata', () => p === pool && renderPreview());
      p.set(it.id, el);
    }
    return el;
  }
  function dropEls() {
    for (const el of pool.values()) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    pool.clear();
  }
  function itemVol(it, lt) {
    let v = it.vol == null ? 1 : it.vol;
    if (it.fadeIn && lt < it.fadeIn) v *= lt / it.fadeIn;
    if (it.fadeOut && lt > it.dur - it.fadeOut) v *= Math.max(0, (it.dur - lt) / it.fadeOut);
    return v;
  }
  function syncMedia(time, playing) {
    if (!V) return;
    const live = new Set();
    for (const it of V.items) {
      if (it.type !== 'video' && it.type !== 'audio') continue;
      const tr = track(it.track);
      const active = time >= it.start - 0.001 && time < end(it) - 0.001 && !(tr && tr.hidden && it.type === 'video');
      // keep elements of clips about to start ready
      if (!active && !(time > it.start - 2 && time < it.start)) {
        const el = pool.get(it.id);
        if (el && !el.paused) el.pause();
        continue;
      }
      const el = elFor(it);
      if (!el) continue;
      live.add(it.id);
      const lt = time - it.start;
      const st = it.in + Math.max(0, lt) * it.speed;
      if (!active) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - it.in) > 0.05 && el.readyState >= 1) el.currentTime = it.in;
        continue;
      }
      const muted = it.mute || (tr && tr.mute);
      el.muted = !!muted;
      el.volume = PE.clamp(itemVol(it, lt), 0, 1);
      if (playing) {
        if (el.playbackRate !== it.speed) el.playbackRate = it.speed;
        if (el.paused) {
          if (Math.abs(el.currentTime - st) > 0.04) el.currentTime = st;
          const p = el.play();
          if (p && p.catch) p.catch(() => {});
        } else if (Math.abs(el.currentTime - st) > 0.25) el.currentTime = st;
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - st) > 0.5 / V.fps) el.currentTime = st;
      }
    }
    for (const [id, el] of pool) if (!live.has(id) && !el.paused) el.pause();
  }

  /* ---------- playback clock ---------- */
  const PL = { playing: false, t0: 0, start: 0, raf: 0 };
  function play() {
    if (!V || !V.items.length) return;
    if (t >= duration() - 0.02) t = 0;
    PL.playing = true;
    PL.t0 = t;
    PL.start = performance.now();
    syncMedia(t, true);
    syncBar();
    loopPlay();
  }
  function loopPlay() {
    cancelAnimationFrame(PL.raf);
    if (!PL.playing) return;
    t = PL.t0 + (performance.now() - PL.start) / 1000;
    if (t >= duration()) {
      t = duration();
      pause();
      renderPreview();
      return;
    }
    syncMedia(t, true);
    drawFrame(els.canvas.getContext('2d'), t, els.canvas.width / V.w, pool);
    drawSelUI();
    updTime();
    followPlayhead();
    paintTl();
    PL.raf = requestAnimationFrame(loopPlay);
  }
  function pause() {
    PL.playing = false;
    cancelAnimationFrame(PL.raf);
    for (const el of pool.values()) if (!el.paused) el.pause();
    if (els) syncBar();
  }
  function togglePlay() {
    PL.playing ? (pause(), renderPreview()) : play();
  }
  VE.togglePlay = togglePlay;
  function seek(x) {
    t = PE.clamp(x, 0, Math.max(duration(), 0));
    if (PL.playing) {
      PL.t0 = t;
      PL.start = performance.now();
      syncMedia(t, true);
    } else renderPreview();
    followPlayhead();
    paintTl();
  }
  function followPlayhead() {
    const x = tx(t);
    if (x > TW - 30 || x < 0) {
      scrollX = Math.max(0, t * pps - (PL.playing ? 30 : TW / 2));
      clampScroll();
      baseDirty = true;
    }
  }

  /* ---------- selection on the preview ---------- */
  function drawSelUI() {
    const ui = els.ui;
    ui.innerHTML = '';
    const it = item(sel);
    if (!it || !isVisual(it) || t < it.start || t >= end(it)) return;
    const tr = track(it.track);
    if (tr && tr.hidden) return;
    const k = prevK;
    const box = h('div', { class: 'isel' + (tr && tr.lock ? ' locked' : ''), style: { left: (it.x - it.w / 2) * k + 'px', top: (it.y - it.h / 2) * k + 'px', width: it.w * k + 'px', height: it.h * k + 'px', transform: `rotate(${it.rot || 0}deg)` } });
    if (!(tr && tr.lock)) {
      for (const c of it.type === 'text' ? ['nw', 'ne', 'sw', 'se'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) box.appendChild(h('div', { class: 'ihd ihd-' + c, 'data-h': c }));
      box.appendChild(h('div', { class: 'ihd ihd-rot', 'data-h': 'rot' }));
    }
    ui.appendChild(box);
  }
  let pdrag = null;
  function prevPt(e) {
    const r = els.frame.getBoundingClientRect();
    return [(e.clientX - r.left) / prevK, (e.clientY - r.top) / prevK];
  }
  function toLocal(it, p) {
    const a = (-(it.rot || 0) * Math.PI) / 180;
    const dx = p[0] - it.x,
      dy = p[1] - it.y;
    return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
  }
  function fromLocal(it, lx, ly) {
    const a = ((it.rot || 0) * Math.PI) / 180;
    return [it.x + lx * Math.cos(a) - ly * Math.sin(a), it.y + lx * Math.sin(a) + ly * Math.cos(a)];
  }
  function hitPreview(p) {
    for (let ti = 0; ti < V.tracks.length; ti++) {
      const tr = V.tracks[ti];
      if (tr.hidden || tr.kind === 'audio') continue;
      const its = V.items.filter((x) => x.track === tr.id && x.type !== 'audio' && t >= x.start && t < end(x));
      for (let i = its.length - 1; i >= 0; i--) {
        const [lx, ly] = toLocal(its[i], p);
        if (Math.abs(lx) <= its[i].w / 2 && Math.abs(ly) <= its[i].h / 2) return its[i];
      }
    }
    return null;
  }
  function onPrevDown(e) {
    if (!V) return;
    const p = prevPt(e);
    const hd = e.target.getAttribute && e.target.getAttribute('data-h');
    let it = item(sel);
    if (hd && it) {
      e.preventDefault();
      pdrag = { kind: hd === 'rot' ? 'rot' : 'resize', h: hd, it0: JSON.parse(JSON.stringify(it)), p };
      return;
    }
    it = hitPreview(p);
    if (it) {
      e.preventDefault();
      if (sel !== it.id) select(it.id);
      const tr = track(it.track);
      if (!(tr && tr.lock)) pdrag = { kind: 'move', p, x0: it.x, y0: it.y, moved: false };
    } else select(null);
  }
  function prevMove(e) {
    if (!pdrag) return false;
    const it = item(sel);
    if (!it) return true;
    const p = prevPt(e);
    if (pdrag.kind === 'move') {
      let nx = pdrag.x0 + p[0] - pdrag.p[0],
        ny = pdrag.y0 + p[1] - pdrag.p[1];
      const sn = 8 / prevK;
      if (Math.abs(nx - V.w / 2) < sn) nx = V.w / 2;
      if (Math.abs(ny - V.h / 2) < sn) ny = V.h / 2;
      it.x = nx;
      it.y = ny;
      pdrag.moved = true;
    } else if (pdrag.kind === 'rot') {
      let a = (Math.atan2(p[1] - it.y, p[0] - it.x) * 180) / Math.PI + 90;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      else if (Math.abs(((a % 90) + 90) % 90) < 2.5 || Math.abs(((a % 90) + 90) % 90) > 87.5) a = Math.round(a / 90) * 90;
      it.rot = ((a % 360) + 360) % 360;
      if (it.rot > 180) it.rot -= 360;
    } else {
      const i0 = pdrag.it0,
        hd = pdrag.h;
      const sx = hd.includes('e') ? 1 : hd.includes('w') ? -1 : 0,
        sy = hd.includes('s') ? 1 : hd.includes('n') ? -1 : 0;
      const an = [(-sx * i0.w) / 2, (-sy * i0.h) / 2];
      const pl = toLocal(i0, p);
      let w = sx ? Math.max(8, Math.abs(pl[0] - an[0])) : i0.w,
        hh = sy ? Math.max(8, Math.abs(pl[1] - an[1])) : i0.h;
      if ((sx && sy && !e.shiftKey && it.type !== 'shape' && it.type !== 'color') || it.type === 'text') {
        const k = Math.max(0.02, ((pl[0] - an[0]) * sx * i0.w + (pl[1] - an[1]) * sy * i0.h) / (i0.w * i0.w + i0.h * i0.h));
        w = i0.w * k;
        hh = i0.h * k;
      }
      if (it.type === 'text') {
        it.size = Math.max(6, (i0.size * w) / i0.w);
        if (it.sw) it.sw = (i0.sw * w) / i0.w;
      }
      it.w = w;
      it.h = hh;
      const c = fromLocal(i0, an[0] + (sx * w) / 2, an[1] + (sy * hh) / 2);
      it.x = c[0];
      it.y = c[1];
    }
    renderPreview();
    return true;
  }
  function prevUp() {
    if (!pdrag) return false;
    const d = pdrag;
    pdrag = null;
    if (d.kind !== 'move' || d.moved) {
      commit();
      refreshPanel();
    }
    return true;
  }

  /* =========================================================
   *  timeline
   * ========================================================= */
  let TW = 0,
    THh = 0,
    tdpr = 1,
    baseDirty = true;
  const tbase = document.createElement('canvas');
  function resizeTl() {
    if (!els || !V || !VE.active) return;
    const r = els.lanes.getBoundingClientRect();
    tdpr = Math.min(2, window.devicePixelRatio || 1);
    TW = Math.max(10, r.width);
    THh = Math.max(10, r.height);
    els.cv.width = tbase.width = Math.round(TW * tdpr);
    els.cv.height = tbase.height = Math.round(THh * tdpr);
    els.cv.style.width = TW + 'px';
    els.cv.style.height = THh + 'px';
    clampScroll();
    draw();
  }
  const contentW = () => Math.max(duration() + 20, TW / pps) * pps;
  function clampScroll() {
    scrollX = PE.clamp(scrollX, 0, Math.max(0, contentW() - TW));
    scrollY = PE.clamp(scrollY, 0, Math.max(0, V.tracks.length * TH() + 40 - (THh - RULER)));
    els.hs.firstChild.style.width = contentW() + 'px';
    els.hs._lock = true;
    els.hs.scrollLeft = scrollX;
    els.hs._lock = false;
    els.headsIn.style.transform = `translateY(${-scrollY}px)`;
  }
  const tx = (x) => x * pps - scrollX;
  const xt = (x) => (x + scrollX) / pps;
  const trackY = (i) => RULER + i * TH() - scrollY;
  function trackAtY(y) {
    const i = Math.floor((y - RULER + scrollY) / TH());
    return i >= 0 && i < V.tracks.length ? i : -1;
  }
  function setPps(v, ax) {
    const a = ax == null ? (tx(t) >= 0 && tx(t) <= TW ? tx(t) : TW / 2) : ax;
    const tt = xt(a);
    pps = PE.clamp(v, 2, 800);
    scrollX = tt * pps - a;
    clampScroll();
    draw();
  }
  function fitTimeline() {
    pps = PE.clamp((Math.max(200, TW) - 30) / Math.max(5, duration()), 2, 800);
    scrollX = 0;
    if (els) {
      clampScroll();
      draw();
    }
  }
  VE.zoomIn = () => setPps(pps * 1.4);
  VE.zoomOut = () => setPps(pps / 1.4);
  VE.zoomMenu = (a) => PE.ui.menu(a, [{ label: 'Fit timeline', icon: 'fit', onClick: fitTimeline }, { label: 'Zoom in timeline', icon: 'plus', onClick: VE.zoomIn }, { label: 'Zoom out timeline', icon: 'minus', onClick: VE.zoomOut }]);
  function onWheel(e) {
    e.preventDefault();
    const r = els.lanes.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) return setPps(pps * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) scrollX += e.shiftKey ? e.deltaY : e.deltaX;
    else if (V.tracks.length * TH() + RULER > THh) scrollY += e.deltaY;
    else scrollX += e.deltaY;
    clampScroll();
    draw();
  }
  function draw() {
    baseDirty = true;
    paintTl();
  }
  let rqt = 0;
  function paintTl() {
    cancelAnimationFrame(rqt);
    rqt = requestAnimationFrame(paintNow);
  }
  function paintNow() {
    if (!els || !V || !VE.active) return;
    if (baseDirty) {
      drawTlBase();
      baseDirty = false;
    }
    const ctx = els.cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.cv.width, els.cv.height);
    ctx.drawImage(tbase, 0, 0);
    ctx.setTransform(tdpr, 0, 0, tdpr, 0, 0);
    if (snapLine != null) {
      ctx.fillStyle = '#f5a623';
      ctx.fillRect(Math.round(tx(snapLine)), RULER, 1, THh);
    }
    if (dropGhost) {
      ctx.fillStyle = 'rgba(80,120,255,.3)';
      ctx.fillRect(tx(dropGhost.a), trackY(dropGhost.i) + 3, dropGhost.d * pps, TH() - 6);
    }
    const x = tx(t);
    ctx.fillStyle = '#e5484d';
    ctx.fillRect(Math.round(x) - 0.5, 0, 1.5, THh);
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }
  function css(n, d) {
    return getComputedStyle(els.view).getPropertyValue(n).trim() || d;
  }
  const TYPE_COL = { video: '#3b6cf6', image: '#17a673', audio: '#c27c0e', text: '#9b4dd8', shape: '#d8418f', color: '#d8418f' };
  function drawTlBase() {
    const ctx = tbase.getContext('2d');
    ctx.setTransform(tdpr, 0, 0, tdpr, 0, 0);
    const bg = css('--desk', '#dde2e8'),
      panel = css('--panel', '#f6f7f9'),
      line = css('--line', '#d3d9e0'),
      ink2 = css('--ink-2', '#4a5563');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, TW, THh);
    const th = TH();
    V.tracks.forEach((tr, i) => {
      const y = trackY(i);
      ctx.fillStyle = tr.kind === 'main' ? 'rgba(59,108,246,.06)' : i % 2 ? 'rgba(128,128,128,.04)' : 'rgba(128,128,128,.09)';
      ctx.fillRect(0, y, TW, th);
      ctx.fillStyle = line;
      ctx.fillRect(0, y + th - 1, TW, 1);
    });
    // grid + ruler
    const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let step = 600;
    for (const s of steps)
      if (s * pps >= 64) {
        step = s;
        break;
      }
    const t0 = Math.floor(xt(0) / step) * step;
    ctx.fillStyle = line;
    for (let x = t0; tx(x) < TW; x += step) ctx.fillRect(Math.round(tx(x)), RULER, 1, THh);
    for (const it of V.items) drawTlItem(ctx, it, th);
    ctx.fillStyle = panel;
    ctx.fillRect(0, 0, TW, RULER);
    ctx.fillStyle = line;
    ctx.fillRect(0, RULER - 1, TW, 1);
    ctx.fillStyle = ink2;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (let x = Math.max(0, t0); tx(x) < TW; x += step) {
      const px = Math.round(tx(x));
      ctx.fillRect(px, RULER - 8, 1, 7);
      ctx.fillText(step < 1 ? PE.fmtTime(x, step < 0.1 ? 2 : 1) : PE.fmtTime(x, 0), px + 3, 5);
    }
    // project end
    const de = tx(duration());
    if (de > 0 && de < TW) {
      ctx.fillStyle = 'rgba(0,0,0,.08)';
      ctx.fillRect(de, RULER, TW - de, THh);
    }
  }
  function drawTlItem(ctx, it, th) {
    const i = V.tracks.findIndex((x) => x.id === it.track);
    if (i < 0) return;
    const y = trackY(i) + 3,
      hh = th - 6;
    const x0 = tx(it.start),
      x1 = tx(end(it));
    if (x1 < 0 || x0 > TW || y > THh || y + hh < RULER) return;
    const on = it.id === sel;
    const col = TYPE_COL[it.type] || '#888';
    const tr = V.tracks[i];
    ctx.save();
    ctx.globalAlpha = tr.hidden || (tr.mute && it.type === 'audio') ? 0.4 : 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x0, y, Math.max(2, x1 - x0), hh, 5) : ctx.rect(x0, y, x1 - x0, hh);
    ctx.fillStyle = hexA(col, 0.22);
    ctx.fill();
    ctx.save();
    ctx.clip();
    const m = M.get(it.media);
    if (it.type === 'video' && m && m.thumbs.length) {
      const tw = m.thumbs.find(Boolean) ? m.thumbs.find(Boolean).c.width * (hh / 54) : hh;
      for (let x = Math.max(x0, x0 + Math.floor((0 - x0) / tw) * tw); x < Math.min(x1, TW); x += tw) {
        const st = it.in + xt(x - 0 + tw / 2) * 1 - it.start;
        const srcT = it.in + (xt(x + tw / 2) - it.start) * it.speed;
        void st;
        const n = m.thumbN || m.thumbs.length;
        const idx = PE.clamp(Math.floor((srcT / m.dur) * n), 0, m.thumbs.length - 1);
        const th2 = m.thumbs[idx] || m.thumbs.find(Boolean);
        if (th2) ctx.drawImage(th2.c, x, y, tw, hh);
      }
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(x0, y, x1 - x0, hh);
    } else if (it.type === 'image' && m && m.bmp) {
      const tw = (hh * m.w) / m.h;
      for (let x = x0; x < Math.min(x1, TW); x += tw) if (x + tw > 0) ctx.drawImage(m.bmp, x, y, tw, hh);
    }
    // waveform for sound
    if ((it.type === 'audio' || (it.type === 'video' && !it.mute)) && m && m.abuf) {
      const buf = m.abuf;
      const pk = PE.peaks(buf, 1024);
      const mid = it.type === 'audio' ? y + hh / 2 : y + hh - 9,
        amp = it.type === 'audio' ? hh / 2 - 4 : 8;
      if (it.type === 'video') {
        ctx.fillStyle = 'rgba(0,0,0,.45)';
        ctx.fillRect(x0, y + hh - 18, x1 - x0, 18);
      }
      ctx.fillStyle = it.type === 'audio' ? col : 'rgba(255,255,255,.85)';
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(TW, x1); x++) {
        const lt = xt(x) - it.start;
        const sA = ((it.in + lt * it.speed) * buf.sampleRate) / 1024,
          sB = ((it.in + (lt + 1 / pps) * it.speed) * buf.sampleRate) / 1024;
        let hi = 0;
        for (let j = Math.floor(sA); j < Math.ceil(sB) && j < pk.mx.length; j++) if (j >= 0) hi = Math.max(hi, pk.mx[j], -pk.mn[j]);
        hi *= Math.min(2, itemVol(it, lt));
        const a = Math.min(1, hi) * amp;
        ctx.fillRect(x, mid - a, 1, Math.max(1, a * 2));
      }
    }
    if (it.type === 'color' || it.type === 'shape') {
      ctx.fillStyle = hexA(it.fill || col, 0.5);
      ctx.fillRect(x0, y + hh - 6, x1 - x0, 6);
    }
    ctx.restore();
    ctx.lineWidth = on ? 2.5 : 1;
    ctx.strokeStyle = on ? '#ffb020' : hexA(col, 0.8);
    ctx.stroke();
    // label
    const label = (it.type === 'text' ? '“' + String(it.text || '').split('\n')[0] + '”' : it.name || it.type) + (it.speed !== 1 ? `  ${it.speed}×` : '');
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const lw = Math.min(ctx.measureText(label).width + 10, Math.max(0, x1 - Math.max(x0, 0) - 4));
    if (lw > 12) {
      ctx.fillStyle = hexA(col, 0.92);
      ctx.fillRect(Math.max(x0, 0) + 2, y + 2, lw, 16);
      ctx.fillStyle = '#fff';
      ctx.save();
      ctx.beginPath();
      ctx.rect(Math.max(x0, 0) + 2, y + 2, lw, 16);
      ctx.clip();
      ctx.fillText(label, Math.max(x0, 0) + 7, y + 4);
      ctx.restore();
    }
    // transitions marks
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    if (it.trIn && it.trIn.type !== 'none') {
      ctx.beginPath();
      ctx.moveTo(x0, y + hh);
      ctx.lineTo(x0 + Math.min(it.trIn.dur * pps, (x1 - x0) / 2), y + hh);
      ctx.lineTo(x0, y + hh - 10);
      ctx.fill();
    }
    if (it.trOut && it.trOut.type !== 'none') {
      ctx.beginPath();
      ctx.moveTo(x1, y + hh);
      ctx.lineTo(x1 - Math.min(it.trOut.dur * pps, (x1 - x0) / 2), y + hh);
      ctx.lineTo(x1, y + hh - 10);
      ctx.fill();
    }
    if (on) {
      ctx.fillStyle = '#ffb020';
      ctx.fillRect(x0, y + hh / 2 - 9, 4, 18);
      ctx.fillRect(x1 - 4, y + hh / 2 - 9, 4, 18);
    }
    ctx.restore();
  }
  function hexA(hex, a) {
    const m = String(hex).match(/^#([0-9a-f]{6})$/i);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ---------- track headers ---------- */
  function refreshHeads() {
    const host = els.headsIn;
    host.innerHTML = '';
    const th = TH();
    V.tracks.forEach((tr, i) => {
      const tog = (k, ic, icOff, title) =>
        h('button', {
          class: 'icon-btn sm vtog' + (tr[k] ? ' on' : ''),
          title,
          'aria-label': title,
          'aria-pressed': tr[k] ? 'true' : 'false',
          html: icon(tr[k] ? icOff : ic),
          onclick: () => {
            tr[k] = !tr[k];
            commit();
            refreshHeads();
            draw();
            renderPreview();
            if (PL.playing) syncMedia(t, true);
          },
        });
      host.appendChild(
        h('div', { class: 'vhead ' + tr.kind, style: { height: th + 'px' } }, [
          h('span', { class: 'vh-ic', html: icon(tr.kind === 'audio' ? 'music' : tr.kind === 'main' ? 'film' : 'layers') }),
          h('span', { class: 'vh-name', title: tr.name }, tr.name),
          tr.kind === 'audio' ? tog('mute', 'volume', 'mute', 'Mute track') : tog('hidden', 'eye', 'eye-off', 'Hide track'),
          tog('lock', 'lock', 'lock', 'Lock track'),
          h('button', { class: 'icon-btn sm vh-more', 'aria-label': 'Track options', html: icon('more'), onclick: (e) => trackMenu(e.currentTarget, tr, i) }),
        ])
      );
    });
    host.appendChild(
      h('div', { class: 'vh-add' }, [
        h('button', { class: 'btn sm ghost', title: 'Add an overlay track', html: icon('plus') + '<span>Track</span>', onclick: () => (newTrack('overlay'), commit(), refreshAll()) }),
      ])
    );
    host.style.transform = `translateY(${-scrollY}px)`;
  }
  function trackMenu(anchor, tr, i) {
    PE.ui.menu(anchor, [
      { label: 'Rename…', icon: 'edit', onClick: async () => {
          const n = await PE.ui.prompt('Rename track', 'Name', tr.name);
          if (n) {
            tr.name = n;
            commit();
            refreshHeads();
          }
        } },
      { label: 'Add overlay track above', icon: 'layers', onClick: () => (newTrack('overlay', i), commit(), refreshAll()) },
      { label: 'Add audio track', icon: 'music', onClick: () => (newTrack('audio'), commit(), refreshAll()) },
      { label: 'Move up', icon: 'up', disabled: i === 0, onClick: () => moveTrack(tr, -1) },
      { label: 'Move down', icon: 'down', disabled: i === V.tracks.length - 1, onClick: () => moveTrack(tr, 1) },
      '-',
      { label: 'Delete track and its clips', icon: 'trash', disabled: tr.kind === 'main', onClick: () => {
          V.tracks = V.tracks.filter((x) => x !== tr);
          V.items = V.items.filter((x) => x.track !== tr.id);
          if (sel && !item(sel)) sel = null;
          commit();
          refreshAll();
        } },
    ]);
  }
  function moveTrack(tr, d) {
    const i = V.tracks.indexOf(tr);
    V.tracks.splice(i, 1);
    V.tracks.splice(PE.clamp(i + d, 0, V.tracks.length), 0, tr);
    commit();
    refreshAll();
  }

  /* ---------- timeline pointer ---------- */
  let drag = null,
    snapLine = null,
    dropGhost = null;
  const pointers = new Map();
  let pinch = null;
  function local(e) {
    const r = els.lanes.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function hitItem(x, y) {
    const i = trackAtY(y);
    if (i < 0) return null;
    const tr = V.tracks[i];
    const touch = matchMedia('(pointer: coarse)').matches;
    const edge = touch ? 12 : 7;
    const its = V.items.filter((it) => it.track === tr.id);
    for (let k = its.length - 1; k >= 0; k--) {
      const it = its[k];
      const x0 = tx(it.start),
        x1 = tx(end(it));
      if (x < x0 - 2 || x > x1 + 2) continue;
      let part = 'move';
      if (x - x0 < edge && x1 - x0 > edge * 2.5) part = 'trimL';
      else if (x1 - x < edge && x1 - x0 > edge * 2.5) part = 'trimR';
      return { it, tr, i, part };
    }
    return { it: null, tr, i, part: 'lane' };
  }
  function snapT(v, ignore) {
    snapLine = null;
    if (!snap) return v;
    const lim = 8 / pps;
    let best = null,
      bd = lim;
    const c = [0, t];
    for (const it of V.items) if (it.id !== ignore) c.push(it.start, end(it));
    for (const x of c)
      if (Math.abs(x - v) < bd) {
        bd = Math.abs(x - v);
        best = x;
      }
    if (best != null) {
      snapLine = best;
      return best;
    }
    return v;
  }
  function onDown(e) {
    if (!V) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      drag = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.abs(a.x - b.x) || 1, pps, cx: (a.x + b.x) / 2, sx: scrollX, sy: scrollY, y: (a.y + b.y) / 2 };
      return;
    }
    if (e.button === 1) {
      drag = { kind: 'pan', x: e.clientX, y: e.clientY, sx: scrollX, sy: scrollY };
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    els.lanes.focus({ preventScroll: true });
    const [x, y] = local(e);
    if (y < RULER) {
      drag = { kind: 'seek' };
      if (PL.playing) pause();
      seek(snapT(Math.max(0, xt(x))));
      return;
    }
    const hit = hitItem(x, y);
    if (!hit || !hit.it) {
      drag = { kind: e.pointerType === 'touch' ? 'pan' : 'seekLane', x: e.clientX, y: e.clientY, sx: scrollX, sy: scrollY, lx: x, moved: false };
      return;
    }
    if (hit.tr.lock) {
      select(hit.it.id);
      return;
    }
    select(hit.it.id);
    drag = { kind: hit.part, it: hit.it, i0: hit.i, x, y, t0: xt(x), o: JSON.parse(JSON.stringify(hit.it)), moved: false, touch: e.pointerType === 'touch' };
  }
  function onMove(e) {
    if (!VE.active || !V) return;
    if (prevMove(e)) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const r = els.lanes.getBoundingClientRect();
      const tAt = (pinch.cx - r.left + pinch.sx) / pinch.pps;
      pps = PE.clamp(pinch.pps * ((Math.abs(a.x - b.x) || 1) / pinch.d), 2, 800);
      scrollX = tAt * pps - ((a.x + b.x) / 2 - r.left);
      scrollY = pinch.sy - ((a.y + b.y) / 2 - pinch.y);
      clampScroll();
      draw();
      return;
    }
    if (!drag) {
      if (e.target === els.cv) {
        const [x, y] = local(e);
        const hit = y >= RULER ? hitItem(x, y) : null;
        els.cv.style.cursor = y < RULER ? 'pointer' : !hit || !hit.it ? 'default' : hit.part === 'move' ? 'grab' : 'ew-resize';
      }
      return;
    }
    const [x, y] = local(e);
    if (drag.kind === 'pan' || drag.kind === 'seekLane') {
      if (drag.kind === 'seekLane') {
        if (Math.abs(e.clientX - drag.x) > 4) drag.moved = true;
        if (drag.moved) seek(snapT(Math.max(0, xt(x))));
        return;
      }
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
      scrollX = drag.sx - (e.clientX - drag.x);
      scrollY = drag.sy - (e.clientY - drag.y);
      clampScroll();
      draw();
      return;
    }
    if (drag.kind === 'seek') return seek(snapT(Math.max(0, xt(x))));
    // touch: hold still a moment before dragging a clip, so swipes scroll
    if (!drag.moved && Math.abs(x - drag.x) < (drag.touch ? 8 : 3) && Math.abs(y - drag.y) < (drag.touch ? 8 : 3)) return;
    drag.moved = true;
    const it = drag.it,
      o = drag.o;
    const dt = xt(x) - drag.t0;
    const m = M.get(it.media);
    const srcMax = m && (it.type === 'video' || it.type === 'audio') ? m.dur : Infinity;
    if (drag.kind === 'move') {
      let ns = Math.max(0, o.start + dt);
      const a = snapT(ns, it.id);
      if (snapLine != null) ns = a;
      else {
        const b = snapT(ns + it.dur, it.id);
        if (snapLine != null) ns = b - it.dur;
      }
      it.start = Math.max(0, ns);
      const i = trackAtY(y);
      if (i >= 0 && V.tracks[i].id !== it.track && fits(V.tracks[i], it) && !V.tracks[i].lock) it.track = V.tracks[i].id;
    } else if (drag.kind === 'trimL') {
      let ns = snapT(o.start + dt, it.id);
      const minS = srcMax === Infinity ? 0 : Math.max(0, o.start - o.in / o.speed);
      ns = PE.clamp(ns, minS, end(o) - 0.1);
      it.start = ns;
      it.dur = end(o) - ns;
      if (srcMax !== Infinity) it.in = Math.max(0, o.in + (ns - o.start) * o.speed);
    } else if (drag.kind === 'trimR') {
      let ne = snapT(end(o) + dt, it.id);
      const maxE = srcMax === Infinity ? Infinity : o.start + (srcMax - o.in) / o.speed;
      ne = PE.clamp(ne, o.start + 0.1, maxE);
      it.dur = ne - o.start;
    }
    draw();
    renderPreview();
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (prevUp()) return;
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (!drag || !V) return;
    const d = drag;
    drag = null;
    snapLine = null;
    if (d.kind === 'seekLane' || (d.kind === 'pan' && !d.moved)) {
      if (!d.moved) {
        select(null);
        seek(snapT(Math.max(0, xt(d.lx != null ? d.lx : local(e)[0]))));
        snapLine = null;
      }
      return draw();
    }
    if (d.kind === 'pan' || d.kind === 'seek') return draw();
    if (d.moved) {
      // keep clips from sitting on top of each other on the same track
      const it = d.it;
      const tr = track(it.track);
      if (!free(tr, it.start, end(it), it.id)) {
        const alt = V.tracks.find((x) => fits(x, it) && !x.lock && free(x, it.start, end(it), it.id));
        it.track = (alt || newTrack(it.type === 'audio' ? 'audio' : 'overlay')).id;
        refreshHeads();
      }
      commit();
      refreshPanel();
    } else if (!d.moved && d.kind === 'move') {
      // a tap on a clip also moves the playhead into it when it is outside
      if (t < d.it.start || t >= end(d.it)) seek(Math.max(d.it.start, Math.min(xt(d.x), end(d.it) - 0.01)));
    }
    draw();
    renderPreview();
  }
  function onLibDrop(e) {
    const id = e.dataTransfer.getData('text/folio-media');
    if (!id) return;
    e.preventDefault();
    const m = M.get(id);
    if (!m) return;
    const [x, y] = local(e);
    const i = trackAtY(y);
    const it = addMediaItem(m, Math.max(0, xt(x)), i >= 0 ? V.tracks[i] : null);
    select(it.id);
    commit();
    refreshAll();
  }

  /* =========================================================
   *  editing commands
   * ========================================================= */
  function select(id) {
    sel = id;
    if (id && panelTab === 'add') panelTab = 'edit';
    refreshPanel();
    draw();
    renderPreview();
  }
  function splitItem(it, at) {
    if (at <= it.start + 0.05 || at >= end(it) - 0.05) return null;
    const b = JSON.parse(JSON.stringify(it));
    b.id = nid('i');
    const lt = at - it.start;
    b.start = at;
    b.dur = it.dur - lt;
    if (it.type === 'video' || it.type === 'audio') b.in = it.in + lt * it.speed;
    b.trIn = { type: 'none', dur: it.trIn.dur };
    b.fadeIn = 0;
    it.dur = lt;
    it.trOut = { type: 'none', dur: it.trOut.dur };
    it.fadeOut = 0;
    V.items.push(b);
    return b;
  }
  function splitHere() {
    const cur = item(sel);
    let list = cur && t > cur.start && t < end(cur) ? [cur] : V.items.filter((x) => t > x.start + 0.05 && t < end(x) - 0.05 && !(track(x.track) || {}).lock);
    let n = 0;
    for (const it of list) if (splitItem(it, t)) n++;
    if (!n) return PE.toast('Move the playhead over a clip to split it.', 'warn');
    commit();
    draw();
  }
  function del(ripple) {
    const it = item(sel);
    if (!it) return PE.toast('Select a clip first.', 'warn');
    V.items = V.items.filter((x) => x !== it);
    if (ripple) for (const x of V.items) if (x.track === it.track && x.start >= end(it) - 0.001) x.start -= it.dur;
    sel = null;
    commit();
    refreshAll();
  }
  function duplicate() {
    const it = item(sel);
    if (!it) return PE.toast('Select a clip first.', 'warn');
    const c = JSON.parse(JSON.stringify(it));
    c.id = nid('i');
    c.start = end(it);
    const tr = track(it.track);
    if (!free(tr, c.start, end(c))) c.track = trackFor(c.type, c.start, end(c), tr).id;
    V.items.push(c);
    select(c.id);
    commit();
    refreshAll();
  }
  let clip = null;
  function copyItem() {
    const it = item(sel);
    if (!it) return;
    clip = JSON.parse(JSON.stringify(it));
    PE.toast('Copied.', 'ok', 1500);
  }
  function pasteItem() {
    if (!clip) return;
    const c = JSON.parse(JSON.stringify(clip));
    c.id = nid('i');
    c.start = t;
    const tr = track(c.track) || mainTrack();
    c.track = (free(tr, c.start, end(c)) ? tr : trackFor(c.type, c.start, end(c), tr)).id;
    V.items.push(c);
    select(c.id);
    commit();
    refreshAll();
  }
  function addText(style, o = {}) {
    const so = style.o;
    const it = baseItem('text', {
      text: o.text || (style.name === 'Lower third' ? 'Your name\nTitle' : style.name === 'Caption' ? 'Caption text' : style.name),
      f: so.f,
      size: Math.round(Math.min(V.w, V.h) * so.size),
      color: so.color,
      b: !!so.b,
      i: !!so.i,
      bg: so.bg,
      stroke: so.stroke || '#000000',
      sw: so.sw || 0,
      shadow: !!so.shadow,
      glow: so.glow || null,
      align: so.x != null && so.x < 0.5 ? 'left' : 'center',
      lh: 1.15,
      x: V.w * (so.x != null ? so.x : 0.5),
      y: V.h * so.y,
      dur: o.dur || 4,
      start: o.start != null ? o.start : t,
      name: style.name,
      trIn: { type: 'fade', dur: 0.4 },
      trOut: { type: 'fade', dur: 0.4 },
    });
    measureText(it);
    if (so.x != null && so.x < 0.5) it.x = V.w * 0.06 + it.w / 2;
    const tr = o.track || trackFor('text', it.start, end(it), V.tracks.find((x) => x.kind === 'overlay'));
    it.track = tr.id;
    V.items.push(it);
    if (!o.quiet) {
      select(it.id);
      commit();
      refreshAll();
    }
    return it;
  }
  function addShape(kind) {
    const s = Math.min(V.w, V.h) * 0.3;
    const it = baseItem(kind === 'color' ? 'color' : 'shape', {
      shape: kind,
      fill: kind === 'color' ? '#1f3fcf' : '#ffffff',
      w: kind === 'color' ? V.w : kind === 'arrow' ? s * 1.4 : s,
      h: kind === 'color' ? V.h : kind === 'arrow' ? s * 0.6 : s,
      dur: 5,
      name: kind === 'color' ? 'Colour' : kind[0].toUpperCase() + kind.slice(1),
    });
    if (kind === 'color') it.grad = null;
    const tr = kind === 'color' ? (free(mainTrack(), it.start, end(it)) ? mainTrack() : trackFor('shape', it.start, end(it))) : trackFor('shape', it.start, end(it), V.tracks.find((x) => x.kind === 'overlay'));
    it.track = tr.id;
    V.items.push(it);
    select(it.id);
    commit();
    refreshAll();
  }
  async function freezeFrame() {
    const it = item(sel);
    if (!it || it.type !== 'video') return;
    const el = pool.get(it.id);
    if (!el || el.readyState < 2) return PE.toast('Move the playhead over the clip first.', 'warn');
    const m = M.get(it.media);
    const c = document.createElement('canvas');
    c.width = m.w;
    c.height = m.h;
    c.getContext('2d').drawImage(el, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const mm = await importMedia(new File([blob], m.name + ' frame.png', { type: 'image/png' }));
    // split the clip and put a 2 s still between the halves
    const at = PE.clamp(t, it.start, end(it));
    const right = splitItem(it, at);
    const shift = 2;
    for (const x of V.items) if (x.track === it.track && x.start >= at - 0.001) x.start += shift;
    const st = baseItem('image', { media: mm.id, start: at, dur: shift, track: it.track, x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot, adj: Object.assign({}, it.adj), name: 'Freeze frame' });
    V.items.push(st);
    void right;
    select(st.id);
    commit();
    refreshAll();
  }
  function detachAudio() {
    const it = item(sel);
    if (!it || it.type !== 'video') return;
    const m = M.get(it.media);
    if (m.hasAudio === false) return PE.toast('This video has no sound.', 'warn');
    const tr = trackFor('audio', it.start, end(it));
    const a = baseItem('audio', { media: it.media, start: it.start, dur: it.dur, in: it.in, speed: it.speed, vol: it.vol, fadeIn: it.fadeIn, fadeOut: it.fadeOut, track: tr.id, name: (it.name || 'Video') + ' audio' });
    V.items.push(a);
    it.mute = true;
    select(a.id);
    commit();
    refreshAll();
    PE.toast('The sound is now a separate clip on an audio track.', 'ok');
  }
  /* captions (.srt / .vtt) */
  function parseSubs(text) {
    const out = [];
    const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
    const tm = (s) => {
      const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
      if (!m) return null;
      return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]);
    };
    for (const b of blocks) {
      const lines = b.split('\n').filter((l) => l.trim() && !/^WEBVTT/.test(l));
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, c] = lines[i].split('-->');
      const s = tm(a),
        e = tm(c);
      if (s == null || e == null || e <= s) continue;
      out.push({ s, e, text: lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '') });
    }
    return out;
  }
  async function importSubs() {
    const [f] = await PE.pickFiles('.srt,.vtt,text/vtt');
    if (!f) return;
    const subs = parseSubs(new TextDecoder().decode(await PE.readFile(f)));
    if (!subs.length) return PE.toast('No captions were found in that file.', 'warn');
    const tr = newTrack('overlay', 0);
    tr.name = 'Captions';
    for (const s of subs) addText(TEXT_STYLES[2], { text: s.text, start: s.s, dur: s.e - s.s, track: tr, quiet: true });
    for (const it of V.items) if (it.track === tr.id) it.trIn = it.trOut = { type: 'none', dur: 0.3 };
    commit();
    refreshAll();
    PE.toast(subs.length + ' captions added on a new “Captions” track.', 'ok');
  }
  function exportSubs() {
    const tr = V.tracks.find((x) => /caption/i.test(x.name)) || null;
    const items = V.items.filter((x) => x.type === 'text' && (!tr || x.track === tr.id)).sort((a, b) => a.start - b.start);
    if (!items.length) return PE.toast('There is no text to save as captions.', 'warn');
    const f = (s) => {
      const ms = Math.round(s * 1000);
      const p = (n, l = 2) => String(n).padStart(l, '0');
      return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
    };
    const srt = items.map((x, i) => `${i + 1}\n${f(x.start)} --> ${f(end(x))}\n${x.text}\n`).join('\n');
    PE.download2(new TextEncoder().encode(srt), PE.app.fileName.replace(/\.[^.]+$/, '') + '.srt', 'text/plain');
  }

  /* =========================================================
   *  panel
   * ========================================================= */
  function section(title, kids) {
    return h('section', { class: 'msec' }, [title ? h('h3', {}, title) : null].concat(kids));
  }
  function refreshPanel() {
    if (!els || !V) return;
    els.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === panelTab));
    const body = els.body;
    const st = body.scrollTop;
    body.innerHTML = '';
    const parts = panelTab === 'add' ? addPanel() : panelTab === 'adjust' ? colourPanel() : panelTab === 'motion' ? motionPanel() : editPanel();
    parts.filter(Boolean).forEach((p) => body.appendChild(p));
    body.scrollTop = st;
  }
  function addPanel() {
    const lib = h('div', { class: 'vlib' });
    for (const m of M.values()) {
      const th = h('div', { class: 'vlib-th' });
      if (m.kind === 'image' && m.bmp) {
        const c = h('canvas', { width: 120, height: 68 });
        const cx = c.getContext('2d');
        const k = Math.max(120 / m.w, 68 / m.h);
        cx.drawImage(m.bmp, (120 - m.w * k) / 2, (68 - m.h * k) / 2, m.w * k, m.h * k);
        th.appendChild(c);
      } else if (m.kind === 'video' && m.thumbs.find(Boolean)) {
        const c = h('canvas', { width: 120, height: 68 });
        const s = m.thumbs.find(Boolean).c;
        const k = Math.max(120 / s.width, 68 / s.height);
        c.getContext('2d').drawImage(s, (120 - s.width * k) / 2, (68 - s.height * k) / 2, s.width * k, s.height * k);
        th.appendChild(c);
      } else th.innerHTML = icon(m.kind === 'audio' ? 'music' : 'video');
      const card = h('button', { class: 'vlib-item', draggable: 'true', title: 'Add to the timeline (or drag it there)', onclick: () => {
          const it = addMediaItem(m, m.kind === 'audio' ? t : null);
          select(it.id);
          commit();
          refreshAll();
        } }, [th, h('span', { class: 'vlib-name' }, m.name), h('span', { class: 'vlib-meta' }, (m.kind === 'image' ? m.w + '×' + m.h : PE.fmtTime(m.dur, 0)) + ' · ' + PE.fmtBytes(m.size))]);
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/folio-media', m.id));
      lib.appendChild(card);
    }
    const styles = h('div', { class: 'vtstyles' });
    for (const s of TEXT_STYLES) {
      const prev = h('span', { style: { fontFamily: PE.fonts.cssFamily(s.o.f), fontWeight: s.o.b ? 700 : 400, fontStyle: s.o.i ? 'italic' : '', color: s.o.color, background: s.o.bg || 'transparent', WebkitTextStroke: s.o.sw ? '1px ' + s.o.stroke : '', textShadow: s.o.glow ? '0 0 8px ' + s.o.glow : '' } }, s.name);
      styles.appendChild(h('button', { class: 'vts', onclick: () => addText(s) }, [prev]));
    }
    return [
      section('Media', [h('div', { class: 'mbtns' }, [btn('Import videos, pictures, music…', 'upload', importPicker, 'primary')]), M.size ? lib : h('p', { class: 'p-note' }, 'Imported files appear here. Click one to add it to the end of the video, or drag it onto a track.')]),
      section('Text', [styles]),
      section('Shapes & backgrounds', [
        h('div', { class: 'mbtns' }, [
          btn('Colour background', 'drop', () => addShape('color')),
          btn('Rectangle', 'rect', () => addShape('rect')),
          btn('Circle', 'ellipse', () => addShape('ellipse')),
          btn('Arrow', 'arrow', () => addShape('arrow')),
          btn('Star', 'fx', () => addShape('star')),
        ]),
      ]),
      section('Captions', [h('p', { class: 'p-note' }, 'Import subtitles (.srt or .vtt) as text on the video, or save your captions as .srt.'), h('div', { class: 'mbtns' }, [btn('Import .srt / .vtt…', 'captions', importSubs), btn('Save captions (.srt)', 'download', exportSubs)])]),
    ];
  }
  function timeInput(label, v, fn) {
    const inp = h('input', { class: 'field', value: PE.fmtTime(v, 2), 'aria-label': label });
    inp.addEventListener('change', () => {
      const parts = inp.value.trim().split(':').map(Number);
      if (parts.some(isNaN)) return (inp.value = PE.fmtTime(v, 2));
      let s = 0;
      for (const p of parts) s = s * 60 + p;
      fn(Math.max(0, s));
    });
    return h('label', {}, [h('span', {}, label), inp]);
  }
  function editPanel() {
    const it = item(sel);
    if (!it) return projectPanel();
    const out = [];
    const upd = (fn, live) => {
      fn();
      if (it.type === 'text') measureText(it);
      draw();
      renderPreview();
      if (!live) commit();
    };
    const m = M.get(it.media);
    const media = it.type === 'video' || it.type === 'audio';
    // timing
    out.push(
      section(it.type === 'text' ? 'Text' : it.type === 'audio' ? 'Audio clip' : it.type === 'video' ? 'Video clip' : it.type === 'image' ? 'Picture' : it.type === 'color' ? 'Colour' : 'Shape', [
        h('div', { class: 'mgeo vtimes' }, [
          timeInput('Starts', it.start, (v) => upd(() => (it.start = v))),
          timeInput('Length', it.dur, (v) =>
            upd(() => {
              it.dur = media ? Math.min(v, (m.dur - it.in) / it.speed) : Math.max(0.1, v);
            })
          ),
        ]),
        media ? h('p', { class: 'p-note' }, `Uses ${PE.fmtTime(it.in, 2)}–${PE.fmtTime(it.in + it.dur * it.speed, 2)} of “${m.name}” (${PE.fmtTime(m.dur, 1)}).`) : null,
      ])
    );
    if (it.type === 'text') {
      const ta = h('textarea', { class: 'field', rows: 3, 'aria-label': 'Text' });
      ta.value = it.text;
      ta.addEventListener('input', () => upd(() => (it.text = ta.value), true));
      ta.addEventListener('change', () => commit());
      out.push(
        section('', [
          ta,
          PE.ui.controls.fontSelect(it.f, (f) => upd(() => (it.f = f))),
          h('div', { class: 'p-grid2' }, [
            PE.ui.controls.num(Math.round(it.size), { min: 6, max: 1000, step: 2, label: 'Size' }, (v) => upd(() => (it.size = v))),
            PE.ui.controls.seg(
              [
                { v: 'b', icon: 'bold', title: 'Bold', on: it.b },
                { v: 'i', icon: 'italic', title: 'Italic', on: it.i },
              ],
              null,
              (k, on) => upd(() => (it[k] = on)),
              true
            ),
          ]),
          PE.ui.controls.seg(
            [
              { v: 'left', icon: 'al-left', title: 'Left' },
              { v: 'center', icon: 'al-center', title: 'Centre' },
              { v: 'right', icon: 'al-right', title: 'Right' },
            ],
            it.align || 'center',
            (v) => upd(() => (it.align = v))
          ),
          colorRow('Colour', it.color, (c, live) => upd(() => (it.color = c), live)),
          colorRow('Background', it.bg || null, (c, live) => upd(() => (it.bg = c), live), true),
          colorRow('Outline', it.sw ? it.stroke : null, (c, live) => upd(() => ((it.stroke = c || '#000000'), (it.sw = c ? it.sw || Math.max(2, it.size / 18) : 0)), live), true),
          h('div', { class: 'mrow' }, [h('label', { class: 'chk' }, [h('input', { type: 'checkbox', checked: !!it.shadow, onchange: (e) => upd(() => (it.shadow = e.target.checked)) }), ' Shadow']), h('label', { class: 'chk' }, [h('input', { type: 'checkbox', checked: !!it.glow, onchange: (e) => upd(() => (it.glow = e.target.checked ? it.color : null)) }), ' Glow'])]),
          PE.slider('Letter spacing', it.ls || 0, -10, 60, 1, (v, live) => upd(() => (it.ls = v), live), (v) => v),
          PE.slider('Line height', it.lh || 1.2, 0.8, 2.5, 0.05, (v, live) => upd(() => (it.lh = v), live), (v) => v.toFixed(2)),
        ])
      );
    }
    if (it.type === 'shape' || it.type === 'color') {
      out.push(
        section('', [
          colorRow('Fill', it.fill, (c, live) => upd(() => (it.fill = c), live), it.type === 'shape'),
          it.type === 'color' ? colorRow('Gradient to', it.grad || null, (c, live) => upd(() => (it.grad = c), live), true) : colorRow('Outline', it.sw ? it.stroke : null, (c, live) => upd(() => ((it.stroke = c), (it.sw = c ? it.sw || 6 : 0)), live), true),
          PE.slider('Corner radius', it.radius || 0, 0, Math.min(it.w, it.h) / 2, 1, (v, live) => upd(() => (it.radius = v), live), (v) => Math.round(v)),
        ])
      );
    }
    if (media) {
      const sp = h('div', { class: 'chips' });
      for (const s of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4])
        sp.appendChild(
          h('button', {
            class: 'chip' + (Math.abs(it.speed - s) < 0.001 ? ' on' : ''),
            onclick: () =>
              upd(() => {
                const srcLen = it.dur * it.speed;
                it.speed = s;
                it.dur = srcLen / s;
                refreshPanel();
              }),
          }, s + '×')
        );
      out.push(
        section('Speed', [sp]),
        section('Sound', [
          it.type === 'video' && m.hasAudio === false ? h('p', { class: 'p-note' }, 'This video has no sound.') : null,
          PE.slider('Volume', it.vol, 0, 2, 0.01, (v, live) => upd(() => (it.vol = v), live), (v) => Math.round(v * 100) + '%'),
          h('label', { class: 'chk' }, [h('input', { type: 'checkbox', checked: !!it.mute, onchange: (e) => upd(() => (it.mute = e.target.checked)) }), ' Mute']),
          PE.slider('Fade in', it.fadeIn || 0, 0, Math.min(10, it.dur / 2), 0.1, (v, live) => upd(() => (it.fadeIn = v), live), (v) => v.toFixed(1) + ' s'),
          PE.slider('Fade out', it.fadeOut || 0, 0, Math.min(10, it.dur / 2), 0.1, (v, live) => upd(() => (it.fadeOut = v), live), (v) => v.toFixed(1) + ' s'),
          it.type === 'video' ? h('div', { class: 'mbtns' }, [btn('Detach audio', 'music', detachAudio), btn('Freeze frame', 'photo', freezeFrame)]) : null,
        ])
      );
    }
    if (isVisual(it)) {
      const geo = h('div', { class: 'mgeo' });
      const numf = (lbl, v, fn) => h('label', {}, [h('span', {}, lbl), h('input', { class: 'field', type: 'number', value: Math.round(v), onchange: (e) => upd(() => fn(+e.target.value)) })]);
      geo.append(
        numf('X', it.x - it.w / 2, (v) => (it.x = v + it.w / 2)),
        numf('Y', it.y - it.h / 2, (v) => (it.y = v + it.h / 2)),
        numf('W', it.w, (v) => {
          if (it.type === 'text') it.size *= v / it.w;
          else if (it.type === 'video' || it.type === 'image') it.h *= v / it.w;
          it.w = v;
        }),
        numf('H', it.h, (v) => {
          if (it.type === 'text') it.size *= v / it.h;
          else if (it.type === 'video' || it.type === 'image') it.w *= v / it.h;
          it.h = v;
        }),
        numf('°', it.rot || 0, (v) => (it.rot = v))
      );
      const kids = [geo, PE.slider('Opacity', it.op == null ? 1 : it.op, 0, 1, 0.01, (v, live) => upd(() => (it.op = v), live))];
      if (it.type === 'video' || it.type === 'image') {
        const c = it.crop || { l: 0, t: 0, r: 0, b: 0 };
        kids.push(
          h('div', { class: 'mbtns' }, [
            btn('Fit', 'fit', () => upd(() => Object.assign(it, fitBox(m.w * (1 - c.l - c.r), m.h * (1 - c.t - c.b), 'contain'), { rot: 0 }))),
            btn('Fill frame', 'crop', () => upd(() => Object.assign(it, fitBox(m.w * (1 - c.l - c.r), m.h * (1 - c.t - c.b), 'cover'), { rot: 0 }))),
            btn('Flip ↔', 'flip-h', () => upd(() => (it.flipX = !it.flipX))),
            btn('Flip ↕', 'flip-v', () => upd(() => (it.flipY = !it.flipY))),
          ]),
          PE.slider('Rounded corners', it.radius || 0, 0, Math.min(it.w, it.h) / 2, 1, (v, live) => upd(() => (it.radius = v), live), (v) => Math.round(v))
        );
        const cropS = (k, label) =>
          PE.slider(label, c[k], 0, 0.45, 0.01, (v, live) =>
            upd(() => {
              const old = Object.assign({}, c);
              c[k] = v;
              it.crop = c;
              // keep the scale: the box shrinks with the crop
              const kx = it.w / (m.w * (1 - old.l - old.r)),
                ky = it.h / (m.h * (1 - old.t - old.b));
              it.w = m.w * (1 - c.l - c.r) * kx;
              it.h = m.h * (1 - c.t - c.b) * ky;
            }, live)
          );
        kids.push(h('details', { class: 'vcrop' }, [h('summary', {}, 'Crop'), cropS('l', 'Left'), cropS('r', 'Right'), cropS('t', 'Top'), cropS('b', 'Bottom')]));
      }
      kids.push(h('div', { class: 'mbtns' }, [btn('Centre', 'fit', () => upd(() => ((it.x = V.w / 2), (it.y = V.h / 2))))]));
      out.push(section('Position', kids));
    }
    out.push(
      section('', [
        h('div', { class: 'mbtns' }, [btn('Split', 'split', splitHere), btn('Duplicate', 'copy', duplicate), btn('Delete', 'trash', () => del(false), 'danger'), btn('Delete & close gap', 'scissors', () => del(true))]),
      ])
    );
    return out;
  }
  function colorRow(label, v, fn, none) {
    return h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, label), PE.ui.controls.colors(v, fn, { none })]);
  }
  function projectPanel() {
    const chips = h('div', { class: 'vsizes' });
    for (const [n, w, hh, d] of SIZES)
      chips.appendChild(
        h('button', { class: 'vsz' + (Math.abs(w / hh - V.w / V.h) < 0.01 ? ' on' : ''), onclick: () => setSize(w, hh) }, [
          h('i', { style: { aspectRatio: w + '/' + hh } }),
          h('b', {}, n),
          h('span', {}, d),
        ])
      );
    const res = h('div', { class: 'chips' });
    for (const p of [480, 720, 1080, 1440, 2160]) {
      const landscape = V.w >= V.h;
      res.appendChild(
        h('button', {
          class: 'chip' + (Math.min(V.w, V.h) === p ? ' on' : ''),
          onclick: () => {
            const k = p / Math.min(V.w, V.h);
            setSize(Math.round((V.w * k) / 2) * 2, Math.round((V.h * k) / 2) * 2, true);
          },
        }, p + 'p')
      );
      void landscape;
    }
    return [
      section('Video', [
        h('p', { class: 'p-note' }, `${V.w} × ${V.h} · ${V.fps} fps · ${PE.fmtTime(duration(), 1)} long · ${V.items.length} clip${V.items.length === 1 ? '' : 's'}`),
        chips,
        h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, 'Quality'), res]),
        h('div', { class: 'mrow' }, [
          h('span', { class: 'mlbl' }, 'Frame rate'),
          PE.ui.controls.seg(
            [24, 25, 30, 60].map((v) => ({ v, text: v + '' })),
            V.fps,
            (v) => ((V.fps = v), commit(), refreshPanel())
          ),
        ]),
        colorRow('Background', V.bg, (c) => ((V.bg = c || '#000000'), commit(), renderPreview())),
        h('p', { class: 'p-note' }, 'Select a clip on the timeline or the preview to edit it. Changing the shape keeps clips centred and scales them to fit.'),
      ]),
    ];
  }
  function setSize(w, hh, scaleAll) {
    const kx = w / V.w,
      ky = hh / V.h;
    const k = scaleAll ? kx : Math.min(kx, ky);
    for (const it of V.items) {
      if (it.type === 'audio') continue;
      if (scaleAll) {
        it.x *= kx;
        it.y *= ky;
      } else {
        it.x = w / 2 + (it.x - V.w / 2) * k;
        it.y = hh / 2 + (it.y - V.h / 2) * k;
      }
      if (it.type === 'color' && !scaleAll) {
        it.w = w;
        it.h = hh;
        it.x = w / 2;
        it.y = hh / 2;
        continue;
      }
      it.w *= scaleAll ? kx : k;
      it.h *= scaleAll ? ky : k;
      if (it.type === 'text') it.size *= scaleAll ? kx : k;
    }
    V.w = w;
    V.h = hh;
    commit();
    refreshAll();
    layoutPreview();
  }
  function sizeMenu(anchor) {
    PE.ui.menu(anchor, [{ heading: 'Shape' }, ...SIZES.map(([n, w, hh, d]) => ({ label: `${n} · ${d}`, on: Math.abs(w / hh - V.w / V.h) < 0.01, onClick: () => setSize(w, hh) })), '-', { label: 'More settings…', icon: 'sliders', onClick: () => ((sel = null), (panelTab = 'edit'), refreshPanel(), draw(), renderPreview()) }]);
  }
  let filterAmt = 1;
  function colourPanel() {
    const it = item(sel);
    if (!it || !(it.type === 'video' || it.type === 'image')) return [section('Colour', [h('p', { class: 'p-note' }, 'Select a video clip or a picture to change its colours or add a filter.')])];
    it.adj = it.adj || {};
    const upd = (live) => {
      procCache.delete(it.id);
      renderPreview();
      if (!live) commit();
    };
    // filter previews from the current frame
    const src = sourceOf(it, pool) || (M.get(it.media) && M.get(it.media).bmp);
    const grid = h('div', { class: 'fgrid' });
    if (src && gl && gl.ok) {
      const sw = src.videoWidth || src.width,
        sh = src.videoHeight || src.height;
      const small = document.createElement('canvas');
      const k = Math.min(1, 140 / Math.max(sw, sh));
      small.width = Math.max(1, sw * k);
      small.height = Math.max(1, sh * k);
      small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);
      for (const f of PE.FILTERS) {
        const cv = h('canvas', { width: small.width, height: small.height });
        cv.getContext('2d').drawImage(gl.draw(small, f.a, small.width, small.height), 0, 0);
        grid.appendChild(
          h('button', { class: 'fthumb' + ((it.filter || 'Original') === f.name ? ' on' : ''), onclick: () => ((it.filter = f.name), (it.adj = scaled(f.a, filterAmt)), upd(false), refreshPanel()) }, [cv, h('span', {}, f.name)])
        );
      }
    }
    const kids = [
      PE.slider('Filter strength', filterAmt, 0, 1, 0.01, (v, live) => {
        filterAmt = v;
        const f = PE.FILTERS.find((x) => x.name === (it.filter || 'Original'));
        if (f) {
          it.adj = scaled(f.a, v);
          upd(live);
        }
      }),
      grid,
    ];
    const adj = [];
    for (const d of PE.ADJ)
      adj.push(
        PE.slider(d.label, it.adj[d.k] || 0, d.min, d.max, d.step, (v, live) => {
          it.adj[d.k] = v;
          upd(live);
        }, d.k === 'hue' ? (v) => v + '°' : null)
      );
    return [
      section('Filters', kids),
      section('Adjust', adj.concat([btn('Reset colours', 'history', () => ((it.adj = {}), (it.filter = null), upd(false), refreshPanel()))])),
    ];
  }
  const scaled = (a, k) => Object.fromEntries(Object.entries(a).map(([x, v]) => [x, v * k]));
  function motionPanel() {
    const it = item(sel);
    if (!it || !isVisual(it)) return [section('Motion', [h('p', { class: 'p-note' }, 'Select a clip, picture or text to add transitions and movement.')])];
    const upd = (fn) => {
      fn();
      commit();
      draw();
      renderPreview();
      refreshPanel();
    };
    const trList = it.type === 'text' ? TRANSITIONS.concat(TEXT_IN) : TRANSITIONS;
    const trChips = (key, list) => {
      const c = h('div', { class: 'chips' });
      for (const [v, l] of list) c.appendChild(h('button', { class: 'chip' + (it[key].type === v ? ' on' : ''), onclick: () => upd(() => (it[key].type = v)) }, l));
      return c;
    };
    const maxT = Math.max(0.1, Math.min(5, it.dur / 2));
    return [
      section('In', [trChips('trIn', trList), PE.slider('Duration', Math.min(it.trIn.dur, maxT), 0.1, maxT, 0.05, (v, live) => ((it.trIn.dur = v), renderPreview(), draw(), !live && commit()), (v) => v.toFixed(2) + ' s')]),
      section('Out', [trChips('trOut', TRANSITIONS), PE.slider('Duration', Math.min(it.trOut.dur, maxT), 0.1, maxT, 0.05, (v, live) => ((it.trOut.dur = v), renderPreview(), draw(), !live && commit()), (v) => v.toFixed(2) + ' s')]),
      section('Movement', [
        (() => {
          const c = h('div', { class: 'chips' });
          for (const [v, l] of ANIMS) c.appendChild(h('button', { class: 'chip' + (it.anim === v ? ' on' : ''), onclick: () => upd(() => (it.anim = v)) }, l));
          return c;
        })(),
        h('p', { class: 'p-note' }, 'Slow zoom and pan (the “Ken Burns” effect) bring still pictures to life.'),
      ]),
      section('', [btn('Apply these to all clips on this track', 'layers', () => upd(() => V.items.filter((x) => x.track === it.track && x !== it).forEach((x) => ((x.trIn = Object.assign({}, it.trIn)), (x.trOut = Object.assign({}, it.trOut)), (x.anim = it.anim)))))]),
    ];
  }
  async function importPicker() {
    const files = await PE.pickFiles('video/*,audio/*,image/*,.mkv,.mov', true);
    if (files.length) VE.addFiles(files);
  }

  /* =========================================================
   *  export
   * ========================================================= */
  async function mixAudio(rate, from = 0, to = duration()) {
    const len = Math.max(1, Math.ceil((to - from) * rate));
    const oc = new OfflineAudioContext(2, len, rate);
    let any = false;
    for (const it of V.items) {
      if (!hasSound(it) || it.mute) continue;
      const tr = track(it.track);
      if (tr && (tr.mute || (tr.hidden && it.type === 'video'))) continue;
      const m = M.get(it.media);
      if (!m) continue;
      await (m.audioReady || decodeMediaAudio(m));
      if (!m.abuf) continue;
      if (end(it) <= from || it.start >= to) continue;
      const s = oc.createBufferSource();
      s.buffer = m.abuf;
      s.playbackRate.value = it.speed;
      const g = oc.createGain();
      s.connect(g);
      g.connect(oc.destination);
      const a = Math.max(from, it.start),
        b = Math.min(to, end(it));
      const at = a - from;
      const lt0 = a - it.start;
      // volume envelope with fades
      const steps = Math.min(400, Math.max(2, Math.ceil((b - a) * 20)));
      const curve = new Float32Array(steps);
      for (let i = 0; i < steps; i++) curve[i] = itemVol(it, lt0 + ((b - a) * i) / (steps - 1));
      try {
        g.gain.setValueCurveAtTime(curve, at, Math.max(0.01, b - a));
      } catch (e) {
        g.gain.value = it.vol;
      }
      s.start(at, it.in + lt0 * it.speed, (b - a) * it.speed);
      any = true;
    }
    if (!any) return null;
    return oc.startRendering();
  }
  VE.mixAudio = mixAudio;
  /** draw the frame at time `time` for export, waiting for videos to seek */
  async function exportFrame(ctx, time, k, xpool) {
    const waits = [];
    for (const it of V.items) {
      if (it.type !== 'video') continue;
      const tr = track(it.track);
      if (tr && tr.hidden) continue;
      if (time < it.start - 1e-6 || time >= end(it) - 1e-6) continue;
      const el = elFor(it, xpool, true);
      if (el.readyState < 1) await new Promise((r) => el.addEventListener('loadedmetadata', r, { once: true }));
      const st = Math.min(M.get(it.media).dur - 0.001, it.in + (time - it.start) * it.speed);
      if (Math.abs(el.currentTime - st) > 0.0005 || el.readyState < 2) waits.push(seekEl(el, st));
    }
    if (waits.length) await Promise.all(waits);
    drawFrame(ctx, time, k, xpool);
  }
  function evenSize(w, hh, maxShort) {
    let k = maxShort ? Math.min(1, maxShort / Math.min(w, hh)) : 1;
    return [Math.max(2, Math.round((w * k) / 2) * 2), Math.max(2, Math.round((hh * k) / 2) * 2)];
  }
  async function pickVideoCodec(fmt, w, hh, fps, bitrate) {
    if (!window.VideoEncoder) return null;
    const tries =
      fmt === 'mp4'
        ? [
            ['avc1.640033', 'avc'],
            ['avc1.4d0033', 'avc'],
            ['avc1.42003e', 'avc'],
            ['avc1.640028', 'avc'],
            ['avc1.42001f', 'avc'],
            ['vp09.00.40.08', 'vp9'],
            ['av01.0.08M.08', 'av1'],
          ]
        : [
            ['vp09.00.40.08', 'V_VP9'],
            ['vp8', 'V_VP8'],
            ['av01.0.08M.08', 'V_AV1'],
          ];
    for (const [codec, mux] of tries) {
      const cfg = { codec, width: w, height: hh, bitrate, framerate: fps, latencyMode: 'quality' };
      if (codec.startsWith('avc')) cfg.avc = { format: 'avc' };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported) return { cfg: r.config || cfg, mux };
      } catch (e) {}
    }
    return null;
  }
  async function pickAudioCodec(fmt, rate) {
    if (!window.AudioEncoder) return null;
    const tries = fmt === 'mp4' ? [['mp4a.40.2', 'aac'], ['opus', 'opus']] : [['opus', 'A_OPUS']];
    for (const [codec, mux] of tries) {
      const cfg = { codec, sampleRate: rate, numberOfChannels: 2, bitrate: 192000 };
      try {
        const r = await AudioEncoder.isConfigSupported(cfg);
        if (r.supported) return { cfg, mux };
      } catch (e) {}
    }
    return null;
  }
  let cancelExport = false;
  async function exportVideo(o) {
    const [w, hh] = evenSize(V.w, V.h, o.res);
    const fps = o.fps;
    const dur = duration();
    const frames = Math.max(1, Math.round(dur * fps));
    const bitrate = Math.round(w * hh * fps * (o.quality === 'high' ? 0.2 : o.quality === 'low' ? 0.06 : 0.11));
    let fmt = o.fmt;
    let vc = await pickVideoCodec(fmt, w, hh, fps, bitrate);
    if (fmt === 'mp4' && vc && vc.mux !== 'avc') {
      // no H.264 encoder here: WebM plays everywhere except old Apple devices
      const wv = await pickVideoCodec('webm', w, hh, fps, bitrate);
      if (wv) {
        fmt = 'webm';
        vc = wv;
        PE.toast('This browser can’t make H.264 MP4 files, so the video is saved as WebM.', 'warn', 7000);
      }
    }
    const rate = 48000;
    PE.ui.busy(true, 'Mixing the sound', 0.01);
    const mix = await mixAudio(rate);
    if (!vc) return recordFallback(o, w, hh, mix);
    const ac = mix ? await pickAudioCodec(fmt, rate) : null;
    if (mix && !ac) PE.toast('This browser can’t encode sound for this format; the video is saved without sound.', 'warn', 7000);
    if (!window.Mp4Muxer && fmt === 'mp4') await PE.loadScript('lib/mp4-muxer.js');
    if (!window.WebMMuxer && fmt === 'webm') await PE.loadScript('lib/webm-muxer.js');
    const Mx = fmt === 'mp4' ? window.Mp4Muxer : window.WebMMuxer;
    const muxOpts = {
      target: new Mx.ArrayBufferTarget(),
      video: fmt === 'mp4' ? { codec: vc.mux, width: w, height: hh, frameRate: fps } : { codec: vc.mux, width: w, height: hh, frameRate: fps },
      firstTimestampBehavior: 'offset',
    };
    if (fmt === 'mp4') muxOpts.fastStart = 'in-memory';
    if (ac) muxOpts.audio = { codec: ac.mux, sampleRate: rate, numberOfChannels: 2 };
    const muxer = new Mx.Muxer(muxOpts);
    let err = null;
    const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (err = e) });
    venc.configure(vc.cfg);
    // sound first (fast)
    if (ac && mix) {
      const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => (err = e) });
      aenc.configure(ac.cfg);
      const L = mix.getChannelData(0),
        R = mix.getChannelData(1);
      const block = 4800;
      for (let i = 0; i < mix.length; i += block) {
        const n = Math.min(block, mix.length - i);
        const data = new Float32Array(n * 2);
        data.set(L.subarray(i, i + n), 0);
        data.set(R.subarray(i, i + n), n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / rate) * 1e6), data });
        aenc.encode(ad);
        ad.close();
      }
      await aenc.flush();
      aenc.close();
    }
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = hh;
    const ctx = cv.getContext('2d', { alpha: false });
    ctx.imageSmoothingQuality = 'high';
    const xpool = new Map();
    const t0 = performance.now();
    try {
      for (let i = 0; i < frames; i++) {
        if (cancelExport) throw new Error('cancelled');
        if (err) throw err;
        await exportFrame(ctx, i / fps, w / V.w, xpool);
        const vf = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
        vf.close();
        while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
        if (i % 3 === 0) {
          const el = (performance.now() - t0) / 1000;
          const left = (el / (i + 1)) * (frames - i - 1);
          PE.ui.busy(true, `Making the video: frame ${i + 1} of ${frames}` + (i > 10 ? ` · about ${PE.fmtTime(left, 0)} left` : ''), 0.03 + (0.95 * i) / frames);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      await venc.flush();
      venc.close();
      muxer.finalize();
    } finally {
      for (const el of xpool.values()) {
        el.removeAttribute('src');
        el.load();
      }
    }
    if (err) throw err;
    const bytes = new Uint8Array(muxer.target.buffer);
    return { bytes, mime: fmt === 'mp4' ? 'video/mp4' : 'video/webm', ext: fmt };
  }
  /** fallback for browsers without WebCodecs: play the project in real time and record it */
  async function recordFallback(o, w, hh, mix) {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('This browser can’t make video files. Try Chrome, Edge or Firefox.');
    const mime = (o.fmt === 'mp4' ? ['video/mp4;codecs=avc1,mp4a', 'video/mp4'] : []).concat(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']).find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('This browser can’t record video.');
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = hh;
    const ctx = cv.getContext('2d');
    const stream = cv.captureStream(o.fps);
    const actx = PE.audioCtx();
    let src = null;
    if (mix) {
      const dest = actx.createMediaStreamDestination();
      src = actx.createBufferSource();
      src.buffer = mix;
      src.connect(dest);
      dest.stream.getAudioTracks().forEach((tk) => stream.addTrack(tk));
    }
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(w * hh * o.fps * 0.12) });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const xpool = new Map();
    // warm up media elements
    for (const it of V.items) if (it.type === 'video') elFor(it, xpool, true);
    await PE.sleep(300);
    const dur = duration();
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(500);
    const start = performance.now();
    if (src) src.start();
    await new Promise((res) => {
      const step = () => {
        const tt = (performance.now() - start) / 1000;
        if (tt >= dur || cancelExport) return res();
        for (const it of V.items) {
          if (it.type !== 'video') continue;
          const el = xpool.get(it.id);
          const active = tt >= it.start && tt < end(it);
          if (active) {
            const st = it.in + (tt - it.start) * it.speed;
            el.playbackRate = it.speed;
            if (el.paused) {
              el.currentTime = st;
              el.play().catch(() => {});
            } else if (Math.abs(el.currentTime - st) > 0.2) el.currentTime = st;
          } else if (!el.paused) el.pause();
        }
        drawFrame(ctx, tt, w / V.w, xpool);
        PE.ui.busy(true, 'Recording the video in real time (this browser has no fast encoder)…', tt / dur);
        requestAnimationFrame(step);
      };
      step();
    });
    rec.stop();
    if (src) src.stop();
    await stopped;
    for (const el of xpool.values()) el.pause();
    if (cancelExport) throw new Error('cancelled');
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, ext: /mp4/.test(mime) ? 'mp4' : 'webm' };
  }
  async function exportGif(o) {
    if (!window.gifenc) await PE.loadScript('lib/gifenc.js');
    const { GIFEncoder, quantize, applyPalette } = window.gifenc;
    const dur = duration();
    const fps = o.gifFps;
    const frames = Math.max(1, Math.round(dur * fps));
    const [w, hh] = evenSize(V.w, V.h, null);
    const k = Math.min(1, o.gifW / Math.max(w, hh));
    const gw = Math.max(2, Math.round(V.w * k)),
      gh = Math.max(2, Math.round(V.h * k));
    const cv = document.createElement('canvas');
    cv.width = gw;
    cv.height = gh;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const enc = GIFEncoder();
    const xpool = new Map();
    try {
      for (let i = 0; i < frames; i++) {
        if (cancelExport) throw new Error('cancelled');
        await exportFrame(ctx, i / fps, gw / V.w, xpool);
        const { data } = ctx.getImageData(0, 0, gw, gh);
        const pal = quantize(data, 256);
        const idx = applyPalette(data, pal);
        enc.writeFrame(idx, gw, gh, { palette: pal, delay: Math.round(1000 / fps) });
        if (i % 2 === 0) {
          PE.ui.busy(true, `Making the GIF: frame ${i + 1} of ${frames}`, i / frames);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    } finally {
      for (const el of xpool.values()) {
        el.removeAttribute('src');
        el.load();
      }
    }
    enc.finish();
    return { bytes: enc.bytes(), mime: 'image/gif', ext: 'gif' };
  }
  function exportDialog(fmt0) {
    if (!V.items.length) return PE.toast('Add some clips first.', 'warn');
    pause();
    const o = { fmt: fmt0 || 'mp4', res: Math.min(V.w, V.h) > 1080 ? 1080 : Math.min(V.w, V.h), fps: V.fps, quality: 'medium', gifFps: 12, gifW: 480, audioFmt: 'mp3' };
    const opts = h('div', { class: 'msec' });
    const info = h('p', { class: 'p-note' });
    const fill = () => {
      opts.innerHTML = '';
      if (o.fmt === 'mp4' || o.fmt === 'webm') {
        const short = Math.min(V.w, V.h);
        opts.append(
          h('div', { class: 'mrow' }, [
            h('span', { class: 'mlbl' }, 'Resolution'),
            PE.ui.controls.seg(
              [480, 720, 1080, 1440, 2160].filter((p) => p <= Math.max(short, 480)).map((p) => ({ v: p, text: p + 'p' })),
              o.res,
              (v) => ((o.res = v), est())
            ),
          ]),
          h('div', { class: 'mrow' }, [
            h('span', { class: 'mlbl' }, 'Frame rate'),
            PE.ui.controls.seg(
              [24, 25, 30, 60].map((v) => ({ v, text: v + ' fps' })),
              o.fps,
              (v) => ((o.fps = v), est())
            ),
          ]),
          h('div', { class: 'mrow' }, [
            h('span', { class: 'mlbl' }, 'Quality'),
            PE.ui.controls.seg(
              [
                { v: 'low', text: 'Smaller file' },
                { v: 'medium', text: 'Standard' },
                { v: 'high', text: 'Best' },
              ],
              o.quality,
              (v) => ((o.quality = v), est())
            ),
          ])
        );
      } else if (o.fmt === 'gif') {
        opts.append(
          h('div', { class: 'mrow' }, [
            h('span', { class: 'mlbl' }, 'Width'),
            PE.ui.controls.seg(
              [320, 480, 640, 800].map((v) => ({ v, text: v + ' px' })),
              o.gifW,
              (v) => ((o.gifW = v), est())
            ),
          ]),
          h('div', { class: 'mrow' }, [
            h('span', { class: 'mlbl' }, 'Frame rate'),
            PE.ui.controls.seg(
              [8, 12, 15, 20].map((v) => ({ v, text: v + ' fps' })),
              o.gifFps,
              (v) => ((o.gifFps = v), est())
            ),
          ])
        );
      } else {
        opts.append(
          h('div', { class: 'mrow' }, [
            h('span', { class: 'mlbl' }, 'Format'),
            PE.ui.controls.seg(
              [
                { v: 'mp3', text: 'MP3' },
                { v: 'wav', text: 'WAV' },
              ],
              o.audioFmt,
              (v) => (o.audioFmt = v)
            ),
          ])
        );
      }
      est();
    };
    const est = () => {
      const d = duration();
      if (o.fmt === 'gif') info.textContent = `${Math.round(d * o.gifFps)} frames. GIFs have no sound and get large quickly; keep them short.`;
      else if (o.fmt === 'audio') info.textContent = 'Only the sound of the video, mixed.';
      else {
        const [w, hh] = evenSize(V.w, V.h, o.res);
        const mb = (w * hh * o.fps * (o.quality === 'high' ? 0.2 : o.quality === 'low' ? 0.06 : 0.11) * d) / 8e6 + (d * 192) / 8000;
        info.textContent = `${w} × ${hh}, ${PE.fmtTime(d, 1)} · about ${mb < 1 ? Math.max(0.1, mb).toFixed(1) : Math.round(mb)} MB`;
      }
    };
    fill();
    const fmts = PE.ui.controls.seg(
      [
        { v: 'mp4', text: 'MP4' },
        { v: 'webm', text: 'WebM' },
        { v: 'gif', text: 'GIF' },
        { v: 'audio', text: 'Sound only' },
      ],
      o.fmt,
      (v) => ((o.fmt = v), fill())
    );
    const fast = !!window.VideoEncoder;
    PE.ui.dialog({
      title: 'Export video',
      body: [h('div', { class: 'mrow' }, [h('span', { class: 'mlbl' }, 'Save as'), fmts]), opts, info, fast ? null : h('p', { class: 'p-note warn' }, 'This browser has no fast video encoder, so the video is recorded while it plays (it takes as long as the video).')],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Export', primary: true, onClick: () => runExport(o) },
      ],
    });
  }
  async function runExport(o) {
    cancelExport = false;
    PE.ui.busy(true, 'Getting ready', 0.01);
    const cancelBtn = h('button', { class: 'btn sm', onclick: () => (cancelExport = true) }, 'Cancel');
    const card = $('#busy .busy-card');
    card.appendChild(cancelBtn);
    try {
      let r;
      if (o.fmt === 'gif') r = await exportGif(o);
      else if (o.fmt === 'audio') {
        const mix = await mixAudio(48000);
        if (!mix) throw new Error('This video has no sound.');
        if (o.audioFmt === 'wav') r = { bytes: PE.encodeWav(mix, 16), mime: 'audio/wav', ext: 'wav' };
        else r = { bytes: await PE.encodeMp3(mix, 192, (f) => PE.ui.busy(true, 'Encoding MP3', f)), mime: 'audio/mpeg', ext: 'mp3' };
      } else r = await exportVideo(o);
      const name = PE.app.fileName.replace(/\.[^.]+$/, '') + '.' + r.ext;
      PE.download2(r.bytes, name, r.mime);
      if (o.fmt === 'mp4' || o.fmt === 'webm') {
        PE.app.dirty = false;
        PE.ui.updateHistoryButtons();
      }
      VE.lastExport = { bytes: r.bytes.length, mime: r.mime, name };
      PE.toast(`Saved ${name} (${PE.fmtBytes(r.bytes.length)})`, 'ok', 5000);
    } catch (e) {
      console.error(e);
      if (/cancel/.test(e.message || '')) PE.toast('Export cancelled.');
      else PE.toast('Export failed: ' + (e.message || e), 'error', 8000);
      VE.lastError = String(e && e.message);
    } finally {
      cancelBtn.remove();
      PE.ui.busy(false);
      renderPreview();
    }
  }
  VE.runExport = runExport;
  async function snapshot() {
    const c = document.createElement('canvas');
    c.width = V.w;
    c.height = V.h;
    const xpool = new Map();
    await exportFrame(c.getContext('2d'), t, 1, xpool);
    for (const el of xpool.values()) el.removeAttribute('src');
    const bytes = await PE.canvasToBytes(c, 'image/png');
    PE.download2(bytes, PE.app.fileName.replace(/\.[^.]+$/, '') + ' ' + PE.fmtTime(t, 1).replace(/[:.]/g, '-') + '.png', 'image/png');
  }
  function fullscreen() {
    const el = els.stage;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().then(() => setTimeout(layoutPreview, 100));
  }
  VE.download = () => exportDialog('mp4');
  VE.downloadMenu = (anchor) =>
    PE.ui.menu(anchor, [
      { label: 'MP4 video', icon: 'video', kbd: PE.isMac ? '⌘S' : 'Ctrl+S', onClick: () => exportDialog('mp4') },
      { label: 'WebM video', icon: 'video', onClick: () => exportDialog('webm') },
      { label: 'Animated GIF', icon: 'gif', onClick: () => exportDialog('gif') },
      { label: 'Sound only (MP3 / WAV)', icon: 'music', onClick: () => exportDialog('audio') },
      '-',
      { label: 'This frame as a picture (PNG)', icon: 'photo', onClick: snapshot },
      { label: 'Captions (.srt)', icon: 'captions', onClick: exportSubs },
    ]);
  VE.moreItems = () => [
    { label: 'New video project', icon: 'video', onClick: () => PE.app.newVideo() },
    { label: 'Add videos, pictures or music…', icon: 'upload', onClick: importPicker },
    { label: 'Add text', icon: 'text', onClick: () => addText(TEXT_STYLES[0]) },
    { label: 'Import captions (.srt / .vtt)…', icon: 'captions', onClick: importSubs },
    '-',
    { label: 'Video size and frame rate…', icon: 'sliders', onClick: () => ((sel = null), (panelTab = 'edit'), refreshPanel(), draw(), renderPreview()) },
    { label: 'Fit timeline', icon: 'fit', onClick: fitTimeline },
  ];
  VE.shortcuts = (k) => [
    ['Play / pause', 'Space'],
    ['Previous / next frame', '← / →'],
    ['Back / forward 1 second', 'Shift+← / Shift+→'],
    ['Go to start / end', 'Home / End'],
    ['Split at the playhead', 'S'],
    ['Delete clip', 'Delete'],
    ['Delete and close the gap', 'Shift+Delete'],
    ['Duplicate clip', `${k}D`],
    ['Copy / paste clip', `${k}C / ${k}V`],
    ['Add text', 'T'],
    ['Undo / Redo', `${k}Z / ${k}Shift+Z`],
    ['Timeline zoom', `${k}+ / ${k}− or ${k}+wheel`],
    ['Export', `${k}S`],
  ];
  VE.onKey = function (e) {
    if (e.type !== 'keydown' || !V) return;
    const tg = e.target;
    if (tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
    const mod = PE.mod(e);
    const k = e.key.toLowerCase();
    const go = (fn) => (e.preventDefault(), fn());
    if (mod && k === 'z') return go(() => (e.shiftKey ? VE.redo() : VE.undo()));
    if (mod && k === 'y') return go(VE.redo);
    if (mod && k === 'd') return go(duplicate);
    if (mod && k === 'c') return go(copyItem);
    if (mod && k === 'v' && clip) return go(pasteItem);
    if (mod && (k === '=' || k === '+')) return go(VE.zoomIn);
    if (mod && k === '-') return go(VE.zoomOut);
    if (mod && k === '0') return go(fitTimeline);
    if (mod) return;
    if (k === ' ') return go(togglePlay);
    if (k === 'home') return go(() => seek(0));
    if (k === 'end') return go(() => seek(duration()));
    if (k === 'arrowleft') return go(() => seek(t - (e.shiftKey ? 1 : 1 / V.fps)));
    if (k === 'arrowright') return go(() => seek(t + (e.shiftKey ? 1 : 1 / V.fps)));
    if (k === 'delete' || k === 'backspace') return go(() => del(e.shiftKey));
    if (k === 's') return go(splitHere);
    if (k === 't') return go(() => addText(TEXT_STYLES[0]));
    if (k === 'escape') return go(() => select(null));
  };
  VE.state = () => ({ V, t, sel, media: [...M.values()].map((m) => ({ id: m.id, kind: m.kind, dur: m.dur, w: m.w, h: m.h, hasAudio: m.hasAudio })) });
})();
