/* Pagewright — interface: properties panel, pages panel, menus, dialogs, find & replace */
'use strict';
(function () {
  const V = PE.view,
    T = PE.tools;
  const U = (PE.ui = { pageSel: new Set() });
  const $ = PE.$,
    h = PE.h,
    icon = PE.icon;

  const PALETTE = ['#000000', '#3d4451', '#8a929e', '#ffffff', '#c0392b', '#e8710a', '#f2c200', '#1d8a4e', '#1f3fcf', '#0e7c97', '#7b3fbf', '#d61f69'];
  const HL_PALETTE = ['#ffe34d', '#9ef0a0', '#8fd3ff', '#ffb3d1', '#ffc078'];
  const narrow = () => window.matchMedia('(max-width: 860px)').matches;

  /* ---------- controls ---------- */
  function num(value, opts, onChange) {
    const step = opts.step || 1;
    const inp = h('input', { type: 'text', inputmode: 'decimal', value: fmt(value), 'aria-label': opts.label || 'Value', id: opts.id });
    const set = (v) => {
      v = PE.clamp(Math.round(v * 100) / 100, opts.min != null ? opts.min : -1e9, opts.max != null ? opts.max : 1e9);
      inp.value = fmt(v);
      onChange(v);
    };
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) set(v);
      else inp.value = fmt(value);
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        set((parseFloat(inp.value) || 0) + (e.key === 'ArrowUp' ? step : -step));
      }
    });
    const dec = h('button', { type: 'button', 'aria-label': 'Decrease', html: icon('minus'), onclick: () => set((parseFloat(inp.value) || 0) - step) });
    const inc = h('button', { type: 'button', 'aria-label': 'Increase', html: icon('plus'), onclick: () => set((parseFloat(inp.value) || 0) + step) });
    return h('div', { class: 'num' }, [dec, inp, inc]);
  }
  function fmt(v) {
    return String(Math.round(v * 100) / 100);
  }
  function seg(options, value, onChange, multi) {
    const el = h('div', { class: 'seg', role: multi ? 'group' : 'radiogroup' });
    options.forEach((o) => {
      const on = multi ? !!o.on : o.v === value;
      const b = h('button', {
        type: 'button',
        class: on ? 'on' : '',
        title: o.title,
        'aria-label': o.title,
        'aria-pressed': on ? 'true' : 'false',
        html: o.icon ? icon(o.icon) : o.text,
        onmousedown: (e) => e.preventDefault(), // keep the text selection while editing
        onclick: () => {
          if (multi) {
            const now = !b.classList.contains('on');
            b.classList.toggle('on', now);
            onChange(o.v, now);
          } else {
            el.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
            b.classList.add('on');
            onChange(o.v);
          }
        },
      });
      el.appendChild(b);
    });
    return el;
  }
  function colors(value, onChange, opts = {}) {
    const el = h('div', { class: 'swatches' });
    const pal = opts.palette || PALETTE;
    const all = opts.none ? [null].concat(pal) : pal;
    const lower = value ? String(value).toLowerCase() : null;
    for (const c of all) {
      const b = h('button', {
        type: 'button',
        class: 'sw' + (c === null ? ' none' : '') + (c === lower || (c === null && value == null) ? ' on' : ''),
        title: c || 'None',
        'aria-label': c ? 'Colour ' + c : 'No colour',
        style: c ? { background: c } : null,
        onmousedown: (e) => e.preventDefault(),
        onclick: () => {
          el.querySelectorAll('.sw').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          onChange(c);
        },
      });
      el.appendChild(b);
    }
    const custom = h('label', { class: 'sw-custom', title: 'Custom colour' }, [
      h('input', {
        type: 'color',
        value: value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000',
        'aria-label': 'Custom colour',
        oninput: (e) => onChange(e.target.value, true),
        onchange: (e) => onChange(e.target.value),
      }),
    ]);
    el.appendChild(custom);
    return el;
  }
  function range(value, min, max, step, fmtFn, onChange, label) {
    const out = h('output', {}, fmtFn(value));
    const inp = h('input', { type: 'range', min, max, step, value, 'aria-label': label || 'Value' });
    inp.addEventListener('input', () => {
      out.textContent = fmtFn(+inp.value);
      onChange(+inp.value, true);
    });
    inp.addEventListener('change', () => onChange(+inp.value, false));
    return h('div', { class: 'range' }, [inp, out]);
  }
  function fontSelect(value, onChange) {
    const sel = h('select', { class: 'field font-pick', 'aria-label': 'Font' });
    for (const f of PE.fonts.FAMILIES) sel.appendChild(h('option', { value: f.key, selected: f.key === value }, f.name));
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }
  function row(label, ctrl) {
    return h('div', { class: 'p-row' }, [h('label', {}, label), ctrl]);
  }
  function sec(title, ic, children) {
    return h('section', { class: 'p-sec' }, [title ? h('h3', { class: 'p-title', html: (ic ? icon(ic) : '') + PE.esc(title) }) : null].concat(children));
  }
  function actBtn(label, ic, fn, cls) {
    return h('button', { type: 'button', class: 'btn ' + (cls || ''), html: icon(ic) + '<span>' + PE.esc(label) + '</span>', onclick: fn, onmousedown: (e) => e.preventDefault() });
  }
  U.controls = { num, seg, colors, range, fontSelect, row, sec, actBtn };

  /* ---------- properties panel ---------- */
  U.refreshPropsSoon = PE.debounce(() => U.refreshProps(), 120);
  U.refreshProps = function () {
    const body = $('#props-body');
    if (!body) return;
    if ($('#props').contains(document.activeElement) && document.activeElement.matches('input,select,textarea')) return;
    body.innerHTML = '';
    const items = T.selObjs();
    const ed = T.editing;
    let content = [];
    let active = true;
    if (ed && (ed.kind === 'obj' || ed.kind === 'base')) content = textProps(ed.kind === 'base');
    else if (items.length > 1) content = multiProps(items);
    else if (items.length === 1) content = objProps(items[0]);
    else {
      content = toolProps();
      active = T.tool !== 'edit';
    }
    content.forEach((c) => c && body.appendChild(c));
    document.body.classList.toggle('props-open', active);
    if (!active) document.body.classList.remove('props-min');
  };

  function textProps(isBase) {
    const st = T.currentTextStyle() || T.defaults.text;
    const out = [];
    const ed = T.editing;
    const pg = ed && PE.findPage(ed.pg);
    let note = null;
    if (isBase && pg) {
      const ex = PE.ex[PE.pageKey(pg)];
      const b = ex && ex.blocks.find((x) => x.id === ed.id);
      if (b && b.of)
        note = h('p', { class: 'p-note' }, `Original font: ${b.of.replace(/[-,]/g, ' ')}. Shown with the closest matching font, ${PE.fonts.famByKey[st.f].name}.`);
    }
    out.push(
      sec(isBase ? 'Editing PDF text' : 'Text', 'text', [
        note,
        fontSelect(st.f, (f) => T.applyTextStyle({ f })),
        h('div', { class: 'p-grid2' }, [
          num(st.s, { min: 2, max: 400, step: st.s < 10 ? 0.5 : 1, label: 'Font size', id: 'p-size' }, (s) => T.applyTextStyle({ s })),
          seg(
            [
              { v: 'b', icon: 'bold', title: 'Bold (Ctrl+B)', on: st.b },
              { v: 'i', icon: 'italic', title: 'Italic (Ctrl+I)', on: st.i },
              { v: 'u', icon: 'underline', title: 'Underline (Ctrl+U)', on: st.u },
            ],
            null,
            (k, on) => T.applyTextStyle({ [k]: on }),
            true
          ),
        ]),
        colors(st.c, (c, live) => {
          if (!live) T.applyTextStyle({ c });
        }),
      ])
    );
    let para = { align: 'left', lh: 1.2 };
    if (isBase && pg && pg.ov[ed.id]) para = pg.ov[ed.id];
    else if (pg) {
      const o = PE.findObj(pg, ed ? ed.id : T.sel[0] && T.sel[0].id);
      if (o) para = o;
    }
    const lhSel = h('select', { class: 'field', 'aria-label': 'Line spacing', id: 'p-lh' });
    const lhs = [1, 1.15, 1.2, 1.4, 1.5, 2, 2.5];
    const cur = PE.round(para.lh || 1.2, 2);
    if (!lhs.includes(cur)) lhs.push(cur);
    lhs.sort((a, b) => a - b).forEach((v) => lhSel.appendChild(h('option', { value: v, selected: v === cur }, v.toFixed(2))));
    lhSel.addEventListener('change', () => T.applyPara({ lh: +lhSel.value }));
    out.push(
      sec('Paragraph', 'al-left', [
        seg(
          [
            { v: 'left', icon: 'al-left', title: 'Align left' },
            { v: 'center', icon: 'al-center', title: 'Centre' },
            { v: 'right', icon: 'al-right', title: 'Align right' },
            { v: 'justify', icon: 'al-justify', title: 'Justify' },
          ],
          para.align || 'left',
          (a) => T.applyPara({ align: a })
        ),
        row('Line spacing', lhSel),
      ])
    );
    if (isBase)
      out.push(
        sec('', null, [
          h('p', { class: 'p-note', html: 'Press <kbd>Enter</kbd> for a new line. Content below moves down as the text grows. Drag the blue handle to move the block.' }),
          h('div', { class: 'p-actions' }, [
            actBtn('Done', 'check', () => T.stopEditing()),
            actBtn('Restore original', 'history', () => T.restoreEditingBlock()),
            actBtn('Delete text', 'trash', () => T.deleteEditingBlock(), 'danger'),
          ]),
        ])
      );
    else
      out.push(
        sec('', null, [
          h('div', { class: 'p-actions' }, [
            actBtn('Done', 'check', () => {
              const e2 = T.editing;
              T.stopEditing();
              if (e2) T.select([{ pg: e2.pg, id: e2.id }]);
            }),
            actBtn('Delete', 'trash', () => {
              const e2 = T.editing;
              T.stopEditing();
              if (e2) {
                T.select([{ pg: e2.pg, id: e2.id }]);
                T.deleteSelection();
              }
            }, 'danger'),
          ]),
        ])
      );
    return out;
  }

  function objActions(it, extra = []) {
    const base = it.base;
    return sec('', null, [
      h(
        'div',
        { class: 'p-actions' },
        extra.concat(
          base
            ? [actBtn('Restore original', 'history', () => T.restoreBaseImage()), actBtn('Delete', 'trash', () => T.deleteSelection(), 'danger')]
            : [
                actBtn('Duplicate', 'copy', () => T.duplicate()),
                actBtn('Bring to front', 'front', () => T.arrange('front')),
                actBtn('Send to back', 'back', () => T.arrange('back')),
                actBtn('Delete', 'trash', () => T.deleteSelection(), 'danger'),
              ]
        )
      ),
    ]);
  }
  function opacityRow(val) {
    return row(
      'Opacity',
      range(val != null ? val : 1, 0.05, 1, 0.05, (v) => Math.round(v * 100) + '%', (v, live) => T.setProps({ op: v }, { soon: live }), 'Opacity')
    );
  }
  function rotateRow(g) {
    return row(
      'Rotation',
      h('div', { class: 'p-grid2', style: { flex: 1 } }, [
        num(Math.round(g.rot || 0), { min: -180, max: 180, step: 1, label: 'Rotation in degrees' }, (v) => T.setProps({ rot: v })),
        seg(
          [
            { v: -90, icon: 'rotate-ccw', title: 'Rotate left 90°' },
            { v: 90, icon: 'rotate-cw', title: 'Rotate right 90°' },
          ],
          null,
          (d) => {
            let r = ((g.rot || 0) + d) % 360;
            if (r > 180) r -= 360;
            if (r <= -180) r += 360;
            g.rot = r;
            T.setProps({ rot: r });
          }
        ),
      ])
    );
  }

  function objProps(it) {
    if (it.base) {
      const g = Object.assign({ rot: it.im.rot }, it.pg.ov[it.id] || {});
      return [
        sec('Image from the PDF', 'image', [
          h('p', { class: 'p-note' }, 'Drag to move. Drag a corner to resize (hold Shift to stretch freely). Use the top handle to rotate.'),
          rotateRow(g),
          row('Flip', seg([{ v: 'x', icon: 'flip-h', title: 'Flip horizontally' }, { v: 'y', icon: 'flip-v', title: 'Flip vertically' }], null, (k) => {
            const ov = T.baseImgOv(it.pg, it.im);
            T.setProps(k === 'x' ? { flipX: !ov.flipX } : { flipY: !ov.flipY });
          })),
        ]),
        objActions(it, [actBtn('Replace image', 'upload', () => T.replaceImage())]),
      ];
    }
    const o = it.o;
    if (o.type === 'text') {
      T.defaults.text && null;
      return textProps(false).slice(0, 2).concat([sec('', null, [rotateRow(o), opacityRow(o.op), h('p', { class: 'p-note', html: 'Click again or press <kbd>Enter</kbd> to edit the text.' })]), objActions(it)]);
    }
    if (o.type === 'image')
      return [
        sec('Image', 'image', [
          rotateRow(o),
          row('Flip', seg([{ v: 'x', icon: 'flip-h', title: 'Flip horizontally' }, { v: 'y', icon: 'flip-v', title: 'Flip vertically' }], null, (k) => T.setProps(k === 'x' ? { flipX: !o.flipX } : { flipY: !o.flipY }))),
          opacityRow(o.op),
        ]),
        objActions(it, [actBtn('Replace image', 'upload', () => T.replaceImage())]),
      ];
    if (o.type === 'shape') {
      if (o.redact)
        return [
          sec('Redaction', 'redact', [
            h('p', { class: 'p-note' }, 'When you download, everything under this box is removed for good. To make that possible the page is saved as an image, so its text can no longer be selected.'),
            rotateRow(o),
          ]),
          objActions(it),
        ];
      const isHl = o.blend === 'multiply';
      const isWo = !o.stroke && !isHl && o.shape === 'rect' && !o.redact;
      const kids = [];
      if (o.shape === 'check' || o.shape === 'cross') {
        kids.push(colors(o.stroke, (c, live) => T.setProps({ stroke: c }, { soon: live })));
        kids.push(row('Line width', range(o.sw, 0.5, 8, 0.5, (v) => v + ' pt', (v, live) => T.setProps({ sw: v }, { soon: live }), 'Line width')));
      } else if (isHl) {
        kids.push(colors(o.fill, (c, live) => T.setProps({ fill: c }, { soon: live }), { palette: HL_PALETTE }));
        kids.push(opacityRow(o.op));
      } else {
        kids.push(h('div', { class: 'p-lbl' }, 'Outline'));
        kids.push(colors(o.stroke, (c, live) => T.setProps({ stroke: c, sw: c && !o.sw ? 2 : o.sw }, { soon: live }), { none: !isWo }));
        kids.push(h('div', { class: 'p-lbl' }, 'Fill'));
        kids.push(colors(o.fill, (c, live) => T.setProps({ fill: c }, { soon: live }), { none: true }));
        if (o.stroke) kids.push(row('Line width', range(o.sw || 1, 0.5, 20, 0.5, (v) => v + ' pt', (v, live) => T.setProps({ sw: v }, { soon: live }), 'Line width')));
        kids.push(opacityRow(o.op));
      }
      kids.push(rotateRow(o));
      return [sec(isHl ? 'Highlight' : isWo ? 'Whiteout' : 'Shape', isHl ? 'highlight' : isWo ? 'whiteout' : 'shapes', kids), objActions(it)];
    }
    if (o.type === 'line')
      return [
        sec(o.arrow ? 'Arrow' : 'Line', o.arrow ? 'arrow' : 'line', [
          colors(o.stroke, (c, live) => T.setProps({ stroke: c }, { soon: live })),
          row('Width', range(o.sw, 0.5, 16, 0.5, (v) => v + ' pt', (v, live) => T.setProps({ sw: v }, { soon: live }), 'Line width')),
          row('Arrow head', h('label', { class: 'chk' }, [h('input', { type: 'checkbox', checked: !!o.arrow, onchange: (e) => T.setProps({ arrow: e.target.checked }) }), 'Show'])),
          opacityRow(o.op),
        ]),
        objActions(it),
      ];
    if (o.type === 'ink')
      return [
        sec('Drawing', 'pen', [
          colors(o.stroke, (c, live) => T.setProps({ stroke: c }, { soon: live }), { palette: o.blend ? HL_PALETTE.concat(PALETTE.slice(0, 4)) : PALETTE }),
          row('Width', range(o.sw, 0.5, 30, 0.5, (v) => v + ' pt', (v, live) => T.setProps({ sw: v }, { soon: live }), 'Line width')),
          opacityRow(o.op),
          rotateRow(o),
        ]),
        objActions(it),
      ];
    if (o.type === 'table') return tableProps(it);
    return [objActions(it)];
  }

  function tableProps(it) {
    const o = it.o;
    const ed = T.editing && T.editing.kind === 'cell' ? T.editing : null;
    const setT = (p) => {
      Object.assign(o, p);
      V.updateObj(it.pg, o, true);
      T.redrawSelection();
      PE.commitSoon();
      if (ed) setTimeout(() => T.editCell(it.pg, o, ed.r, ed.c), 0);
    };
    return [
      sec('Table', 'table', [
        h('p', { class: 'p-note', html: ed ? `Editing row ${ed.r + 1}, column ${ed.c + 1}. <kbd>Tab</kbd> moves to the next cell and adds a row at the end.` : 'Click a cell to type in it. Drag the table to move it; drag a side handle to change its width.' }),
        row(
          'Rows',
          seg(
            [
              { v: 'rowAbove', icon: 'up', title: 'Insert a row above' },
              { v: 'rowBelow', icon: 'down', title: 'Insert a row below' },
              { v: 'rowDel', icon: 'trash', title: 'Delete this row' },
            ],
            null,
            (v) => T.tableOp(v)
          )
        ),
        row(
          'Columns',
          seg(
            [
              { v: 'colLeft', icon: 'left', title: 'Insert a column to the left' },
              { v: 'colRight', icon: 'right', title: 'Insert a column to the right' },
              { v: 'colDel', icon: 'trash', title: 'Delete this column' },
            ],
            null,
            (v) => T.tableOp(v)
          )
        ),
      ]),
      sec('Table text', 'text', [
        fontSelect(o.f || 'arimo', (f) => setT({ f })),
        row('Size', num(o.size || 11, { min: 4, max: 72, step: 0.5, label: 'Table font size' }, (s) => setT({ size: s }))),
        colors(o.color || '#000000', (c, live) => !live && setT({ color: c })),
      ]),
      sec('Borders and header', 'rect', [
        colors(o.border || '#000000', (c, live) => !live && setT({ border: c })),
        row('Border', range(o.bw != null ? o.bw : 1, 0, 4, 0.25, (v) => v + ' pt', (v, live) => setT({ bw: v }), 'Border width')),
        row('Padding', range(o.pad != null ? o.pad : 4, 0, 16, 0.5, (v) => v + ' pt', (v) => setT({ pad: v }), 'Cell padding')),
        h('label', { class: 'chk' }, [h('input', { type: 'checkbox', checked: !!o.head, onchange: (e) => setT({ head: e.target.checked }) }), 'Bold header row']),
        o.head ? colors(o.headBg, (c, live) => !live && setT({ headBg: c }), { none: true, palette: ['#e8ecf3', '#dbe7ff', '#e6f4ea', '#fff4cc', '#f2f2f2', '#1f3fcf', '#3d4451'] }) : null,
      ]),
      objActions(it),
    ];
  }

  function multiProps(items) {
    return [
      sec(`${items.length} items selected`, 'shapes', [h('p', { class: 'p-note' }, 'Drag any of them to move all together. Arrow keys nudge by 1 pt, Shift+Arrow by 10 pt.')]),
      sec('', null, [
        h('div', { class: 'p-actions' }, [
          actBtn('Duplicate', 'copy', () => T.duplicate()),
          actBtn('Bring to front', 'front', () => T.arrange('front')),
          actBtn('Send to back', 'back', () => T.arrange('back')),
          actBtn('Delete', 'trash', () => T.deleteSelection(), 'danger'),
        ]),
      ]),
    ];
  }

  function hint(text, ic) {
    return h('div', { class: 'tool-hint', html: icon(ic || 'info') + '<div>' + text + '</div>' });
  }
  function toolProps() {
    const D = T.defaults;
    const t = T.tool;
    const save = () => T.saveDefaults();
    if (t === 'text')
      return [
        hint('Click anywhere on a page to start typing.', 'text'),
        sec('New text', null, [
          fontSelect(D.text.f, (f) => {
            D.text.f = f;
            PE.fonts.ensure(f, D.text.b, D.text.i);
            save();
          }),
          h('div', { class: 'p-grid2' }, [
            num(D.text.s, { min: 2, max: 400, label: 'Font size' }, (s) => {
              D.text.s = s;
              save();
            }),
            seg(
              [
                { v: 'b', icon: 'bold', title: 'Bold', on: D.text.b },
                { v: 'i', icon: 'italic', title: 'Italic', on: D.text.i },
                { v: 'u', icon: 'underline', title: 'Underline', on: D.text.u },
              ],
              null,
              (k, on) => {
                D.text[k] = on;
                save();
              },
              true
            ),
          ]),
          colors(D.text.c, (c) => {
            D.text.c = c;
            save();
          }),
        ]),
      ];
    if (t === 'pen' || t === 'marker') {
      const P = t === 'pen' ? D.pen : D.marker;
      return [
        hint(t === 'pen' ? 'Draw freely with mouse, pen or finger.' : 'Mark up the page with a translucent highlighter.', t),
        sec(t === 'pen' ? 'Pen' : 'Highlighter pen', null, [
          seg([{ v: 'pen', icon: 'pen', title: 'Pen' }, { v: 'marker', icon: 'marker', title: 'Highlighter' }], t, (v) => setSubTool('draw', v)),
          colors(P.stroke, (c) => {
            P.stroke = c;
            save();
          }, { palette: t === 'marker' ? HL_PALETTE : PALETTE }),
          row('Width', range(P.sw, 0.5, 30, 0.5, (v) => v + ' pt', (v) => {
            P.sw = v;
            save();
          })),
          row('Opacity', range(P.op, 0.1, 1, 0.05, (v) => Math.round(v * 100) + '%', (v) => {
            P.op = v;
            save();
          })),
        ]),
      ];
    }
    if (['rect', 'ellipse', 'line', 'arrow'].includes(t)) {
      const P = t === 'line' || t === 'arrow' ? D.line : D.shape;
      return [
        hint('Drag on the page to draw. Hold Shift while drawing a line to keep it straight.', t),
        sec('Style', null, [
          h('div', { class: 'p-lbl' }, 'Outline'),
          colors(P.stroke, (c) => {
            P.stroke = c;
            save();
          }),
          t === 'rect' || t === 'ellipse' ? h('div', { class: 'p-lbl' }, 'Fill') : null,
          t === 'rect' || t === 'ellipse'
            ? colors(P.fill, (c) => {
                P.fill = c;
                save();
              }, { none: true })
            : null,
          row('Width', range(P.sw, 0.5, 16, 0.5, (v) => v + ' pt', (v) => {
            P.sw = v;
            save();
          })),
        ]),
      ];
    }
    if (t === 'check' || t === 'cross')
      return [
        hint('Click where the mark should go. Handy for forms.', t),
        sec('Mark', null, [
          colors(D.mark.stroke, (c) => {
            D.mark.stroke = c;
            save();
          }),
        ]),
      ];
    if (t === 'highlight')
      return [
        hint('Drag across text to highlight it.', 'highlight'),
        sec('Colour', null, [
          colors(D.highlight.fill, (c) => {
            D.highlight.fill = c;
            save();
          }, { palette: HL_PALETTE }),
        ]),
      ];
    if (t === 'whiteout')
      return [
        hint('Drag over anything you want to hide behind a solid box. The original stays in the file underneath; use Redact to remove it for good.', 'whiteout'),
        sec('Colour', null, [
          colors(D.whiteout.fill, (c) => {
            D.whiteout.fill = c;
            save();
          }),
        ]),
      ];
    if (t === 'redact')
      return [hint('Drag over confidential content. On download it is removed permanently: the page is saved as an image so nothing can be copied out from under the box.', 'redact')];
    if (t === 'tablegrab')
      return [hint('Drag a box around a table in the PDF. Its text becomes an editable table where you can add rows and columns.', 'table')];
    return pageInfo();
  }

  function pageInfo() {
    const out = [];
    const pg = V.currentPage();
    if (pg) {
      const d = PE.dispSize(pg);
      const idx = PE.pageIndex(pg.id);
      const mm = (v) => Math.round((v / 72) * 25.4);
      out.push(
        sec('Page ' + (idx + 1), 'file', [
          h('dl', { class: 'p-kv' }, [
            h('dt', {}, 'Size'),
            h('dd', {}, `${mm(d.w)} × ${mm(d.h)} mm (${Math.round(d.w)} × ${Math.round(d.h)} pt)`),
            h('dt', {}, 'Source'),
            h('dd', {}, pg.src.t === 'pdf' ? PE.docs[pg.src.doc].name + ', page ' + (pg.src.i + 1) : pg.src.t === 'img' ? 'Image' : 'Blank page'),
          ]),
          h('div', { class: 'p-actions' }, [
            actBtn('Rotate', 'rotate-cw', () => U.pageOp('rotr', [pg.id])),
            actBtn('Duplicate', 'copy', () => U.pageOp('dup', [pg.id])),
            actBtn('Delete page', 'trash', () => U.pageOp('del', [pg.id]), 'danger'),
          ]),
        ])
      );
    }
    out.push(
      sec('How editing works', 'info', [
        h('p', { class: 'p-note' }, 'Click any text in the PDF to change it; it keeps its font, size and colour. Click a PDF image to move, resize or rotate it. Choose a tool on the left to add new content.'),
        h('label', { class: 'chk' }, [
          h('input', {
            type: 'checkbox',
            checked: PE.settings.reflow,
            onchange: (e) => {
              PE.settings.reflow = e.target.checked;
              PE.store.set('settings', PE.settings);
              V.relayoutAll();
            },
          }),
          'Move content down when edited text grows',
        ]),
      ])
    );
    return out;
  }

  /* ---------- tool rail & sub-tools ---------- */
  const SUB = {
    draw: [
      { v: 'pen', label: 'Pen', icon: 'pen' },
      { v: 'marker', label: 'Highlighter', icon: 'marker' },
    ],
    shapes: [
      { v: 'rect', label: 'Rectangle', icon: 'rect' },
      { v: 'ellipse', label: 'Ellipse', icon: 'ellipse' },
      { v: 'line', label: 'Line', icon: 'line' },
      { v: 'arrow', label: 'Arrow', icon: 'arrow' },
      { v: 'check', label: 'Check mark', icon: 'check' },
      { v: 'cross', label: 'Cross mark', icon: 'cross' },
    ],
  };
  function setSubTool(group, v) {
    const btn = $(`[data-group="${group}"]`);
    const item = SUB[group].find((x) => x.v === v);
    btn.setAttribute('data-tool-btn', v);
    btn.querySelector('use').setAttribute('href', '#i-' + item.icon);
    T.setTool(v);
  }
  function railClick(btn) {
    const group = btn.getAttribute('data-group');
    const action = btn.getAttribute('data-action');
    if (!PE.S.pages.length) return PE.toast('Open a PDF first.');
    if (action === 'image') return U.insertImage();
    if (action === 'sign') return U.signatureDialog();
    if (group === 'table')
      return U.menu(btn, [
        { label: 'Insert a new table', icon: 'table', onClick: () => U.tableDialog() },
        { label: 'Edit a table in the PDF', icon: 'scissors', onClick: () => T.setTool('tablegrab') },
      ]);
    if (group) {
      const cur = btn.getAttribute('data-tool-btn');
      if (group === 'draw' && !btn.classList.contains('on')) return setSubTool('draw', cur || 'pen');
      return U.menu(
        btn,
        SUB[group].map((s) => ({ label: s.label, icon: s.icon, on: T.tool === s.v, onClick: () => setSubTool(group, s.v) })),
        { grid: group === 'shapes' }
      );
    }
    const t = btn.getAttribute('data-tool-btn');
    T.setTool(T.tool === t && t !== 'edit' ? 'edit' : t);
  }

  /* ---------- menus ---------- */
  U.menu = function (anchor, items, opts = {}) {
    U.closeMenu();
    const m = h('div', { class: 'menu' + (opts.grid ? ' tools' : ''), role: 'menu' });
    for (const it of items) {
      if (it === '-') {
        m.appendChild(h('hr'));
        continue;
      }
      if (it.heading) {
        m.appendChild(h('div', { class: 'mlabel' }, it.heading));
        continue;
      }
      const b = h('button', {
        role: 'menuitem',
        class: it.on ? 'on' : '',
        disabled: it.disabled,
        html: (it.icon ? icon(it.icon) : '') + '<span>' + PE.esc(it.label) + '</span>' + (it.kbd ? `<span class="kbd">${it.kbd}</span>` : ''),
        onclick: () => {
          U.closeMenu();
          it.onClick && it.onClick();
        },
      });
      m.appendChild(b);
    }
    $('#menu-root').appendChild(m);
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth,
      mh = m.offsetHeight;
    let x = r.left,
      y = r.bottom + 6;
    if (opts.side || r.left < 90) {
      x = r.right + 8;
      y = r.top;
    }
    if (x + mw > window.innerWidth - 8) x = Math.max(8, r.right - mw);
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    m.style.left = x + 'px';
    m.style.top = y + 'px';
    const first = m.querySelector('button:not(:disabled)');
    first && first.focus({ preventScroll: true });
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', escClose, true);
    });
    function outside(e) {
      if (!m.contains(e.target)) U.closeMenu();
    }
    function escClose(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        U.closeMenu();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const bs = PE.$$('button:not(:disabled)', m);
        const i = bs.indexOf(document.activeElement);
        bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus();
      }
    }
    U._menuCleanup = () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escClose, true);
    };
    return m;
  };
  U.closeMenu = function () {
    $('#menu-root').innerHTML = '';
    U._menuCleanup && U._menuCleanup();
    U._menuCleanup = null;
  };

  /* ---------- dialogs ---------- */
  U.dialog = function ({ title, body, actions = [], wide, onClose }) {
    const veil = h('div', { class: 'modal-veil' });
    const modal = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    const close = (v) => {
      veil.remove();
      document.removeEventListener('keydown', onKey, true);
      onClose && onClose(v);
    };
    const head = h('div', { class: 'modal-head' }, [
      h('h2', {}, title),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Close', html: icon('close'), onclick: () => close(null) }),
    ]);
    const bodyEl = h('div', { class: 'modal-body' }, body);
    const foot = h('div', { class: 'modal-foot' });
    for (const a of actions)
      foot.appendChild(
        h('button', {
          class: 'btn ' + (a.primary ? 'primary' : a.danger ? 'danger' : ''),
          onclick: async () => {
            const r = a.onClick ? await a.onClick() : a.value;
            if (r !== false) close(a.value !== undefined ? a.value : r);
          },
        }, a.label)
      );
    modal.append(head, bodyEl, foot);
    veil.appendChild(modal);
    veil.addEventListener('pointerdown', (e) => {
      if (e.target === veil) close(null);
    });
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    }
    document.addEventListener('keydown', onKey, true);
    $('#modal-root').appendChild(veil);
    setTimeout(() => {
      const f = modal.querySelector('input,select,textarea,.btn.primary');
      f && f.focus();
    }, 30);
    return { close, el: modal };
  };
  U.confirm = (title, text, ok = 'OK', danger) =>
    new Promise((res) => {
      U.dialog({
        title,
        body: [h('p', {}, text)],
        actions: [
          { label: 'Cancel', value: false },
          { label: ok, value: true, primary: !danger, danger },
        ],
        onClose: (v) => res(!!v),
      });
    });
  U.askPassword = (name, retry) =>
    new Promise((res) => {
      const inp = h('input', { class: 'field', type: 'password', autocomplete: 'off', 'aria-label': 'Password', id: 'pw-input' });
      const d = U.dialog({
        title: 'This PDF is password-protected',
        body: [
          h('p', {}, retry ? 'That password was not right. Try again.' : `Enter the password to open ${name}.`),
          inp,
        ],
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Open', primary: true, onClick: () => inp.value },
        ],
        onClose: (v) => res(v),
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') d.close(inp.value);
      });
    });

  U.busy = function (on, text, frac) {
    $('#busy').hidden = !on;
    if (text) $('#busy-text').textContent = text;
    $('#busy-fill').style.width = Math.round((frac || 0) * 100) + '%';
  };

  /* ---------- top bar ---------- */
  U.updateHistoryButtons = function () {
    $('#btn-undo').disabled = !PE.hist.canUndo();
    $('#btn-redo').disabled = !PE.hist.canRedo();
    const s = $('#save-state');
    s.hidden = !PE.S.pages.length;
    s.classList.toggle('dirty', PE.app.dirty);
    s.textContent = PE.app.dirty ? 'Unsaved changes' : 'No changes';
  };
  U.updateZoom = function () {
    $('#btn-zoom').textContent = Math.round(V.zoom * 100) + '%';
  };
  U.refreshAll = function () {
    U.renderThumbs();
    U.refreshProps();
    U.updateHistoryButtons();
    $('#file-name').value = PE.app.fileName;
  };

  function themeIcon() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    $('#btn-theme use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
    $('#btn-theme').title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }
  U.toggleTheme = function () {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    PE.store.set('theme', next);
    themeIcon();
  };

  U.moreMenu = function (anchor) {
    const has = PE.S.pages.length > 0;
    const fields = PE.app.formFields ? Object.keys(PE.app.formFields).length : 0;
    U.menu(anchor, [
      { label: 'Open a PDF', icon: 'open', kbd: PE.isMac ? '⌘O' : 'Ctrl+O', onClick: () => PE.app.openPicker() },
      { label: 'Merge in PDFs or images', icon: 'upload', disabled: !has, onClick: () => U.insertFiles(true) },
      '-',
      { label: 'Page numbers, header & footer', icon: 'hash', disabled: !has, onClick: () => U.headerFooterDialog() },
      { label: 'Watermark', icon: 'drop', disabled: !has, onClick: () => U.watermarkDialog() },
      { label: fields ? `Fill form fields (${fields})` : 'Fill form fields', icon: 'form', disabled: !fields, onClick: () => U.formDialog() },
      { label: 'Find and replace', icon: 'search', kbd: PE.isMac ? '⌘F' : 'Ctrl+F', disabled: !has, onClick: () => U.openFind() },
      '-',
      { label: 'Split into separate files', icon: 'scissors', disabled: !has, onClick: () => U.splitDialog() },
      { label: 'Save current page as PNG', icon: 'image', disabled: !has, onClick: () => U.exportPng() },
      { label: 'Document properties', icon: 'tag', disabled: !has, onClick: () => U.propsDialog() },
      '-',
      { label: 'Zoom to fit width', icon: 'fit', disabled: !has, onClick: () => V.fitWidth() },
      { label: 'Keyboard shortcuts', icon: 'keyboard', onClick: () => U.shortcutsDialog() },
      { label: 'About & limits', icon: 'info', onClick: () => U.aboutDialog() },
      '-',
      { label: 'Close document', icon: 'close', disabled: !has, onClick: () => PE.app.closeDoc() },
    ]);
  };

  /* ---------- thumbnails ---------- */
  const thumbCache = new Map(); // pageId -> {el, key}
  let thumbIo = null;
  U.renderThumbs = function () {
    const host = $('#thumbs');
    $('#page-count').textContent = PE.S.pages.length ? PE.S.pages.length : '';
    if (!thumbIo)
      thumbIo = new IntersectionObserver(
        (es) =>
          es.forEach((e) => {
            if (e.isIntersecting) drawThumb(e.target.getAttribute('data-pid'));
          }),
        { root: host, rootMargin: '300px 0px' }
      );
    const seen = new Set();
    let prev = null;
    // drop selections of pages that no longer exist
    for (const id of [...U.pageSel]) if (!PE.findPage(id)) U.pageSel.delete(id);
    PE.S.pages.forEach((pg, i) => {
      let t = thumbCache.get(pg.id);
      if (!t) {
        const el = h('div', { class: 'thumb', 'data-pid': pg.id, role: 'option', tabindex: '0' }, [h('div', { class: 'tcan' }), h('div', { class: 'tnum' })]);
        t = { el, key: null };
        thumbCache.set(pg.id, t);
        thumbIo.observe(el);
        bindThumb(el);
      }
      seen.add(pg.id);
      t.el.querySelector('.tnum').textContent = i + 1;
      t.el.classList.toggle('sel', U.pageSel.has(pg.id));
      t.el.setAttribute('aria-selected', U.pageSel.has(pg.id) ? 'true' : 'false');
      const d = PE.dispSize(pg);
      const tw = 132;
      const can = t.el.querySelector('.tcan');
      can.style.width = tw + 'px';
      can.style.height = (tw * d.h) / d.w + 'px';
      const edited = pg.objs.length || Object.keys(pg.ov).length;
      let dot = can.querySelector('.tedit');
      if (edited && !dot) can.appendChild(h('i', { class: 'tedit', title: 'Edited' }));
      else if (!edited && dot) dot.remove();
      const key = JSON.stringify(pg.src) + pg.rot;
      if (t.key !== key) {
        t.key = null;
        t.want = key;
        const r = host.getBoundingClientRect(),
          er = t.el.getBoundingClientRect();
        if (er.bottom > r.top - 300 && er.top < r.bottom + 300) drawThumb(pg.id);
      }
      const want = prev ? prev.nextSibling : host.firstChild;
      if (want !== t.el) host.insertBefore(t.el, want);
      prev = t.el;
    });
    for (const [id, t] of thumbCache)
      if (!seen.has(id)) {
        thumbIo.unobserve(t.el);
        t.el.remove();
        thumbCache.delete(id);
      }
    U.markCurrentThumb();
  };
  async function drawThumb(id) {
    const t = thumbCache.get(id);
    const pg = PE.findPage(id);
    if (!t || !pg || t.key === t.want || t.drawing === t.want) return;
    const key = t.want;
    t.drawing = key;
    const can = t.el.querySelector('.tcan');
    const d = PE.dispSize(pg);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = (132 / d.w) * dpr;
    const c = document.createElement('canvas');
    c.width = Math.round(d.w * scale);
    c.height = Math.round(d.h * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    try {
      if (pg.src.t === 'pdf') {
        const page = await PE.getPdfPage(pg.src.doc, pg.src.i);
        const { srcRot } = PE.baseSize(pg);
        await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale, rotation: (srcRot + pg.rot) % 360 }) }).promise;
      } else if (pg.src.t === 'img') {
        const im = await V.loadImg(PE.assets[pg.src.a].url);
        const { W, H } = PE.baseSize(pg);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        const m = V.layerMatrix(pg);
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.drawImage(im, 0, 0, W, H);
      }
    } catch (e) {
      console.warn('thumb', e);
    }
    if (t.drawing !== key) return;
    t.drawing = null;
    t.key = key;
    const old = can.querySelector('canvas');
    if (old) old.remove();
    can.prepend(c);
  }
  U.markCurrentThumb = PE.debounce(() => {
    const cur = V.currentPage();
    for (const [id, t] of thumbCache) t.el.classList.toggle('cur', !!cur && cur.id === id);
    if (cur && !narrow()) {
      const t = thumbCache.get(cur.id);
      const host = $('#thumbs');
      if (t) {
        const r = host.getBoundingClientRect(),
          er = t.el.getBoundingClientRect();
        if (er.top < r.top || er.bottom > r.bottom) host.scrollTop += er.top - r.top - r.height / 3;
      }
    }
    if (!T.sel.length && !T.editing && T.tool === 'edit') U.refreshPropsSoon();
  }, 120);

  let lastClicked = null;
  function bindThumb(el) {
    let press = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      press = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, touch: e.pointerType === 'touch' };
      if (press.touch) press.timer = setTimeout(() => press && startThumbDrag(el, e), 380);
    });
    el.addEventListener('pointermove', (e) => {
      if (!press || dragState) return;
      const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      if (press.touch) {
        if (dist > 10) {
          clearTimeout(press.timer);
          press = null;
        }
      } else if (dist > 6) startThumbDrag(el, e);
    });
    el.addEventListener('pointerup', (e) => {
      if (!press || dragState) return;
      clearTimeout(press.timer);
      press = null;
      clickThumb(el, e);
    });
    el.addEventListener('pointercancel', () => {
      if (press) clearTimeout(press.timer);
      press = null;
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        clickThumb(el, e);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        U.pageOp('del');
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
        e.preventDefault();
        movePagesBy(e.key === 'ArrowUp' ? -1 : 1);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const id = el.getAttribute('data-pid');
      if (!U.pageSel.has(id)) {
        U.pageSel = new Set([id]);
        U.renderThumbs();
      }
      U.menu(el, pageMenuItems(), {});
    });
  }
  function pageMenuItems() {
    return [
      { label: 'Rotate right', icon: 'rotate-cw', onClick: () => U.pageOp('rotr') },
      { label: 'Rotate left', icon: 'rotate-ccw', onClick: () => U.pageOp('rotl') },
      { label: 'Duplicate', icon: 'copy', onClick: () => U.pageOp('dup') },
      { label: 'Insert blank page after', icon: 'file-plus', onClick: () => U.pageOp('add') },
      { label: 'Move up', icon: 'up', onClick: () => movePagesBy(-1) },
      { label: 'Move down', icon: 'down', onClick: () => movePagesBy(1) },
      { label: 'Download these pages', icon: 'extract', onClick: () => U.pageOp('extract') },
      '-',
      { label: 'Delete', icon: 'trash', onClick: () => U.pageOp('del') },
    ];
  }
  function clickThumb(el, e) {
    const id = el.getAttribute('data-pid');
    if (e.shiftKey && lastClicked) {
      const a = PE.pageIndex(lastClicked),
        b = PE.pageIndex(id);
      U.pageSel = new Set(PE.S.pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id));
    } else if (e.ctrlKey || e.metaKey) {
      U.pageSel.has(id) ? U.pageSel.delete(id) : U.pageSel.add(id);
      lastClicked = id;
    } else {
      U.pageSel = new Set([id]);
      lastClicked = id;
      V.scrollToPage(id);
      if (narrow()) document.body.classList.remove('pages-open');
    }
    U.renderThumbs();
  }

  let dragState = null;
  function startThumbDrag(el, e) {
    const id = el.getAttribute('data-pid');
    if (!U.pageSel.has(id)) U.pageSel = new Set([id]);
    U.renderThumbs();
    const ids = PE.S.pages.filter((p) => U.pageSel.has(p.id)).map((p) => p.id);
    const ghost = el.querySelector('.tcan').cloneNode(true);
    ghost.classList.add('thumb-ghost');
    ghost.style.width = '90px';
    ghost.style.height = 'auto';
    document.body.appendChild(ghost);
    const marker = h('div', { class: 'thumb-drop' });
    ids.forEach((i) => thumbCache.get(i) && thumbCache.get(i).el.classList.add('dragging'));
    dragState = { ids, ghost, marker, to: null, pid: e.pointerId };
    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {}
    const move = (ev) => {
      ghost.style.left = ev.clientX + 12 + 'px';
      ghost.style.top = ev.clientY + 12 + 'px';
      const host = $('#thumbs');
      const hr = host.getBoundingClientRect();
      if (ev.clientY < hr.top + 40) host.scrollTop -= 12;
      else if (ev.clientY > hr.bottom - 40) host.scrollTop += 12;
      let to = PE.S.pages.length;
      for (let i = 0; i < PE.S.pages.length; i++) {
        const t = thumbCache.get(PE.S.pages[i].id);
        const r = t.el.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          to = i;
          break;
        }
      }
      dragState.to = to;
      const before = PE.S.pages[to] ? thumbCache.get(PE.S.pages[to].id).el : null;
      host.insertBefore(marker, before);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      ghost.remove();
      marker.remove();
      PE.$$('.thumb.dragging').forEach((x) => x.classList.remove('dragging'));
      const st = dragState;
      dragState = null;
      if (st.to == null) return;
      const moving = PE.S.pages.filter((p) => st.ids.includes(p.id));
      const before = PE.S.pages.slice(0, st.to).filter((p) => !st.ids.includes(p.id));
      const after = PE.S.pages.slice(st.to).filter((p) => !st.ids.includes(p.id));
      const next = before.concat(moving, after);
      if (next.map((p) => p.id).join() === PE.S.pages.map((p) => p.id).join()) return;
      PE.S.pages = next;
      afterPagesChanged('Pages moved');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    move(e);
  }
  function movePagesBy(dir) {
    const ids = selectedPageIds();
    const idx = ids.map((id) => PE.pageIndex(id)).sort((a, b) => a - b);
    if (dir < 0 && idx[0] === 0) return;
    if (dir > 0 && idx[idx.length - 1] === PE.S.pages.length - 1) return;
    const pages = PE.S.pages.slice();
    const order = dir < 0 ? idx : idx.slice().reverse();
    for (const i of order) {
      const j = i + dir;
      [pages[i], pages[j]] = [pages[j], pages[i]];
    }
    PE.S.pages = pages;
    afterPagesChanged();
  }

  function selectedPageIds() {
    const sel = PE.S.pages.filter((p) => U.pageSel.has(p.id)).map((p) => p.id);
    if (sel.length) return sel;
    const cur = V.currentPage();
    return cur ? [cur.id] : [];
  }
  function afterPagesChanged(msg) {
    T.clearSelection(true);
    V.sync();
    V.renderVirtualAll();
    PE.commit();
    U.refreshAll();
    if (msg) PE.toast(msg, 'ok', 1800);
  }
  function clonePage(pg) {
    const c = PE.clone(pg);
    c.id = PE.uid('p');
    c.objs.forEach((o) => (o.id = PE.uid('o')));
    return c;
  }

  U.pageOp = async function (op, ids) {
    ids = ids || selectedPageIds();
    if (!ids.length && op !== 'add') return;
    const pages = PE.S.pages;
    if (op === 'rotl' || op === 'rotr') {
      for (const id of ids) {
        const pg = PE.findPage(id);
        pg.rot = (pg.rot + (op === 'rotr' ? 90 : 270)) % 360;
      }
      return afterPagesChanged();
    }
    if (op === 'dup') {
      const newIds = [];
      for (const id of ids.slice().reverse()) {
        const i = PE.pageIndex(id);
        const c = clonePage(pages[i]);
        pages.splice(i + 1, 0, c);
        newIds.push(c.id);
      }
      U.pageSel = new Set(newIds);
      return afterPagesChanged(ids.length > 1 ? `${ids.length} pages duplicated` : 'Page duplicated');
    }
    if (op === 'add') {
      const ref = ids.length ? PE.findPage(ids[ids.length - 1]) : null;
      const d = ref ? PE.dispSize(ref) : { w: 595.28, h: 841.89 };
      const pg = { id: PE.uid('p'), src: { t: 'blank', w: d.w, h: d.h }, rot: 0, objs: [], ov: {} };
      const at = ref ? PE.pageIndex(ref.id) + 1 : pages.length;
      pages.splice(at, 0, pg);
      U.pageSel = new Set([pg.id]);
      afterPagesChanged('Blank page added');
      setTimeout(() => V.scrollToPage(pg.id), 60);
      return;
    }
    if (op === 'del') {
      const n = ids.length;
      const edited = ids.some((id) => {
        const p = PE.findPage(id);
        return p.objs.length || Object.keys(p.ov).length;
      });
      if (n > 1 || edited) {
        const ok = await U.confirm(n > 1 ? `Delete ${n} pages?` : 'Delete this page?', 'You can undo this with Ctrl+Z.', 'Delete', true);
        if (!ok) return;
      }
      PE.S.pages = pages.filter((p) => !ids.includes(p.id));
      U.pageSel.clear();
      return afterPagesChanged(n > 1 ? `${n} pages deleted` : 'Page deleted');
    }
    if (op === 'extract') {
      const name = PE.app.fileName.replace(/\.pdf$/i, '') + '-pages-' + ids.map((id) => PE.pageIndex(id) + 1).join('_').slice(0, 40) + '.pdf';
      return PE.app.download({ pageIds: ids, name });
    }
    if (op === 'insert') return U.insertFiles(false);
  };

  U.insertFiles = async function (append) {
    const files = await PE.pickFiles('application/pdf,.pdf,image/*', true);
    if (!files.length) return;
    let at = PE.S.pages.length;
    if (!append) {
      const ids = selectedPageIds();
      if (ids.length) at = PE.pageIndex(ids[ids.length - 1]) + 1;
    }
    const added = await PE.app.addFiles(files, at);
    if (added) afterPagesChanged(`${added} page${added > 1 ? 's' : ''} added`);
  };

  /* ---------- insert image / signature / table ---------- */
  U.insertImage = async function () {
    const [file] = await PE.pickFiles('image/*');
    if (!file) return;
    await T.insertImageFromBytes(await PE.readFile(file), file.type);
  };

  U.tableDialog = function () {
    let rows = 3,
      cols = 3;
    const grid = h('div', { class: 'grid-pick', role: 'grid', 'aria-label': 'Table size' });
    const label = h('p', {}, '3 × 3');
    const cells = [];
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const i = h('i', {
          'data-r': r,
          'data-c': c,
          onpointerenter: () => paint(r + 1, c + 1),
          onclick: () => {
            paint(r + 1, c + 1);
            d.close('ok');
          },
        });
        cells.push(i);
        grid.appendChild(i);
      }
    const rIn = num(rows, { min: 1, max: 60, label: 'Rows' }, (v) => paint(v, cols));
    const cIn = num(cols, { min: 1, max: 20, label: 'Columns' }, (v) => paint(rows, v));
    function paint(r, c) {
      rows = r;
      cols = c;
      cells.forEach((x) => x.classList.toggle('on', +x.getAttribute('data-r') < r && +x.getAttribute('data-c') < c));
      label.textContent = `${r} rows × ${c} columns`;
      rIn.querySelector('input').value = r;
      cIn.querySelector('input').value = c;
    }
    paint(3, 3);
    const d = U.dialog({
      title: 'Insert a table',
      body: [grid, label, h('div', { class: 'p-grid2' }, [h('label', { class: 'lbl' }, ['Rows', rIn]), h('label', { class: 'lbl' }, ['Columns', cIn])])],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Insert table', primary: true, value: 'ok' },
      ],
      onClose: (v) => {
        if (v === 'ok') T.insertTable(rows, cols);
      },
    });
  };

  U.signatureDialog = function () {
    const saved = PE.store.get('signatures', []);
    const pad = h('canvas', { class: 'sig-pad', 'aria-label': 'Signature pad' });
    let strokes = [],
      cur = null;
    let color = '#14286e',
      width = 2.4;
    const ctx = pad.getContext('2d');
    const redraw = () => {
      const r = pad.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (pad.width !== Math.round(r.width * dpr)) {
        pad.width = Math.round(r.width * dpr);
        pad.height = Math.round(r.height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);
      ctx.strokeStyle = '#c9d0da';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(20, r.height - 40);
      ctx.lineTo(r.width - 20, r.height - 40);
      ctx.stroke();
      for (const s of strokes.concat(cur ? [cur] : [])) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();
        s.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
        ctx.stroke();
      }
    };
    const pt = (e) => {
      const r = pad.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      cur = { color, width, pts: [pt(e)] };
      redraw();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!cur) return;
      cur.pts.push(pt(e));
      redraw();
    });
    pad.addEventListener('pointerup', () => {
      if (cur) strokes.push(cur);
      cur = null;
      redraw();
    });
    const typed = h('input', { class: 'field', placeholder: 'Or type your name', id: 'sig-typed', 'aria-label': 'Type your name' });
    typed.addEventListener('input', () => {
      strokes = [];
      redraw();
      const r = pad.getBoundingClientRect();
      ctx.fillStyle = color;
      ctx.font = `italic 400 ${Math.min(56, r.height * 0.36)}px ${PE.fonts.cssFamily('tinos')}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(typed.value, 24, r.height - 48);
    });
    const savedRow = h('div', { class: 'sig-saved' });
    const renderSaved = () => {
      savedRow.innerHTML = '';
      saved.forEach((url, i) => {
        const b = h('button', { title: 'Use this signature', onclick: () => place(url, false) }, [h('img', { src: url, alt: 'Saved signature' })]);
        const x = h('span', {
          class: 'x',
          title: 'Remove',
          role: 'button',
          onclick: (e) => {
            e.stopPropagation();
            saved.splice(i, 1);
            PE.store.set('signatures', saved);
            renderSaved();
          },
        }, '×');
        b.appendChild(x);
        savedRow.appendChild(b);
      });
    };
    renderSaved();
    PE.fonts.ensure('tinos', false, true);
    const keep = h('input', { type: 'checkbox', checked: true, id: 'sig-keep' });
    async function place(url, store) {
      const bytes = PE.b64ToBytes(url.split(',')[1]);
      if (store && keep.checked) {
        saved.unshift(url);
        PE.store.set('signatures', saved.slice(0, 6));
      }
      d.close();
      const o = await T.insertImageFromBytes(bytes, 'image/png', { width: 170 });
      if (o) PE.toast('Signature added. Drag it into place.', 'ok');
    }
    function exportPad() {
      // crop to the ink
      const src = pad;
      const c2 = src.getContext('2d');
      const { width: w, height: hh } = src;
      const data = c2.getImageData(0, 0, w, hh).data;
      let x0 = w,
        y0 = hh,
        x1 = 0,
        y1 = 0;
      for (let y = 0; y < hh; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = data[i],
            g = data[i + 1],
            b = data[i + 2],
            a = data[i + 3];
          // ignore the guide line (light grey)
          if (a > 40 && !(r > 180 && g > 190 && b > 200)) {
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
          }
        }
      if (x1 <= x0) return null;
      const pad2 = 6;
      x0 = Math.max(0, x0 - pad2);
      y0 = Math.max(0, y0 - pad2);
      x1 = Math.min(w, x1 + pad2);
      y1 = Math.min(hh, y1 + pad2);
      const out = document.createElement('canvas');
      out.width = x1 - x0;
      out.height = y1 - y0;
      const oc = out.getContext('2d');
      oc.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      // remove guide-line pixels
      const id = oc.getImageData(0, 0, out.width, out.height);
      for (let i = 0; i < id.data.length; i += 4)
        if (id.data[i] > 180 && id.data[i + 1] > 190 && id.data[i + 2] > 200) id.data[i + 3] = 0;
      oc.putImageData(id, 0, 0);
      return out.toDataURL('image/png');
    }
    const colorRow = colors(color, (c) => {
      color = c;
      strokes.forEach((s) => (s.color = c));
      if (typed.value) typed.dispatchEvent(new Event('input'));
      else redraw();
    }, { palette: ['#14286e', '#000000', '#1f3fcf', '#0e7c97'] });
    const d = U.dialog({
      title: 'Add a signature',
      wide: true,
      body: [
        saved.length ? h('div', { class: 'lbl' }, ['Saved on this device', savedRow]) : null,
        h('p', {}, 'Sign with your mouse, finger or pen.'),
        pad,
        typed,
        h('div', { class: 'p-row', style: { justifyContent: 'space-between', flexWrap: 'wrap' } }, [
          colorRow,
          h('label', { class: 'chk' }, [keep, 'Remember on this device']),
        ]),
      ],
      actions: [
        {
          label: 'Clear',
          onClick: () => {
            strokes = [];
            typed.value = '';
            redraw();
            return false;
          },
        },
        { label: 'Cancel', value: null },
        {
          label: 'Add signature',
          primary: true,
          onClick: () => {
            const url = exportPad();
            if (!url) {
              PE.toast('Draw or type a signature first.', 'warn');
              return false;
            }
            place(url, true);
            return false;
          },
        },
      ],
    });
    setTimeout(redraw, 40);
  };

  /* ---------- document dialogs ---------- */
  U.headerFooterDialog = function () {
    const before = PE.clone(PE.S.hf);
    const hf = PE.S.hf;
    hf.on = true;
    const live = () => V.renderVirtualAll();
    const inp = (k, ph) => {
      const el = h('input', { class: 'field', value: hf[k] || '', placeholder: ph, 'aria-label': ph, id: 'hf-' + k });
      el.addEventListener('input', () => {
        hf[k] = el.value;
        live();
      });
      return el;
    };
    const presets = [
      ['1', { bc: '{n}', tl: '', tc: '', tr: '', bl: '', br: '' }],
      ['Page 1 of 9', { br: 'Page {n} of {total}', bc: '', tl: '', tc: '', tr: '', bl: '' }],
      ['1 / 9', { tr: '{n} / {total}', bc: '', tl: '', tc: '', bl: '', br: '' }],
      ['- 1 -', { bc: '– {n} –', tl: '', tc: '', tr: '', bl: '', br: '' }],
    ];
    const slots = {};
    const body = [
      h('p', {}, 'Choose a style, or write your own text. {n} is the page number, {total} the page count, {date} today’s date, {file} the file name.'),
      h(
        'div',
        { class: 'p-row', style: { flexWrap: 'wrap' } },
        presets.map(([label, p]) =>
          h('button', {
            class: 'btn sm',
            onclick: () => {
              Object.assign(hf, p);
              for (const k in slots) slots[k].value = hf[k] || '';
              live();
            },
          }, label)
        )
      ),
      h('div', { class: 'lbl' }, 'Header'),
      h('div', { class: 'form-grid' }, ['tl', 'tc', 'tr'].map((k, i) => (slots[k] = inp(k, ['Left', 'Centre', 'Right'][i])))),
      h('div', { class: 'lbl' }, 'Footer'),
      h('div', { class: 'form-grid' }, ['bl', 'bc', 'br'].map((k, i) => (slots[k] = inp(k, ['Left', 'Centre', 'Right'][i])))),
      h('div', { class: 'form-grid' }, [
        h('label', {}, ['Font', fontSelect(hf.f, (f) => {
          hf.f = f;
          live();
        })]),
        h('label', {}, ['Size', num(hf.size, { min: 5, max: 40, label: 'Size' }, (v) => {
          hf.size = v;
          live();
        })]),
        h('label', {}, ['Distance from edge', num(hf.margin, { min: 4, max: 120, step: 2, label: 'Margin' }, (v) => {
          hf.margin = v;
          live();
        })]),
        h('label', {}, ['First number', num(hf.start, { min: 0, max: 9999, label: 'Start at' }, (v) => {
          hf.start = v;
          live();
        })]),
      ]),
      colors(hf.color, (c) => {
        hf.color = c;
        live();
      }, { palette: ['#000000', '#444444', '#8a929e', '#1f3fcf', '#c0392b'] }),
      h('label', { class: 'chk' }, [
        h('input', {
          type: 'checkbox',
          checked: hf.skipFirst,
          onchange: (e) => {
            hf.skipFirst = e.target.checked;
            live();
          },
        }),
        'Leave the first page without header and footer (cover page)',
      ]),
    ];
    live();
    U.dialog({
      title: 'Page numbers, header & footer',
      wide: true,
      body,
      actions: [
        {
          label: 'Remove',
          danger: true,
          onClick: () => {
            hf.on = false;
            live();
            PE.commit();
            return true;
          },
          value: 'rm',
        },
        { label: 'Cancel', value: null },
        { label: 'Apply', primary: true, value: 'ok' },
      ],
      onClose: (v) => {
        if (v === 'ok' || v === 'rm') {
          PE.commit();
          if (v === 'ok') PE.toast('Applied to every page.', 'ok');
        } else {
          PE.S.hf = before;
          live();
        }
      },
    });
  };

  U.watermarkDialog = function () {
    const before = PE.clone(PE.S.wm);
    const wm = PE.S.wm;
    wm.on = true;
    const live = () => V.renderVirtualAll();
    const text = h('input', { class: 'field', value: wm.text, 'aria-label': 'Watermark text', id: 'wm-text' });
    text.addEventListener('input', () => {
      wm.text = text.value;
      live();
    });
    live();
    U.dialog({
      title: 'Watermark',
      body: [
        h('label', { class: 'lbl' }, ['Text', text]),
        h('div', { class: 'p-grid2' }, [
          h('label', { class: 'lbl' }, ['Font', fontSelect(wm.f, (f) => {
            wm.f = f;
            live();
          })]),
          h('label', { class: 'lbl' }, ['Size', num(wm.size, { min: 8, max: 200, step: 2, label: 'Size' }, (v) => {
            wm.size = v;
            live();
          })]),
        ]),
        row('Angle', range(wm.angle, -90, 90, 1, (v) => v + '°', (v) => {
          wm.angle = v;
          live();
        })),
        row('Opacity', range(wm.opacity, 0.03, 0.8, 0.01, (v) => Math.round(v * 100) + '%', (v) => {
          wm.opacity = v;
          live();
        })),
        colors(wm.color, (c) => {
          wm.color = c;
          live();
        }),
        h('label', { class: 'chk' }, [
          h('input', {
            type: 'checkbox',
            checked: wm.b,
            onchange: (e) => {
              wm.b = e.target.checked;
              live();
            },
          }),
          'Bold',
        ]),
      ],
      actions: [
        {
          label: 'Remove',
          danger: true,
          value: 'rm',
          onClick: () => {
            wm.on = false;
            live();
            return true;
          },
        },
        { label: 'Cancel', value: null },
        { label: 'Apply', primary: true, value: 'ok' },
      ],
      onClose: (v) => {
        if (v === 'ok' || v === 'rm') PE.commit();
        else {
          PE.S.wm = before;
          live();
        }
      },
    });
  };

  U.propsDialog = function () {
    const t = h('input', { class: 'field', value: PE.S.meta.title || '', id: 'meta-title', 'aria-label': 'Title' });
    const a = h('input', { class: 'field', value: PE.S.meta.author || '', id: 'meta-author', 'aria-label': 'Author' });
    const f = h('input', { class: 'field', value: PE.app.fileName, id: 'meta-file', 'aria-label': 'File name' });
    const docs = Object.values(PE.docs);
    U.dialog({
      title: 'Document properties',
      body: [
        h('label', { class: 'lbl' }, ['File name', f]),
        h('label', { class: 'lbl' }, ['Title', t]),
        h('label', { class: 'lbl' }, ['Author', a]),
        h('dl', { class: 'p-kv' }, [
          h('dt', {}, 'Pages'),
          h('dd', {}, String(PE.S.pages.length)),
          h('dt', {}, 'Source files'),
          h('dd', {}, docs.map((d) => `${d.name} (${(d.bytes.length / 1048576).toFixed(2)} MB)`).join(', ') || 'None'),
        ]),
      ],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Save', primary: true, value: 'ok' },
      ],
      onClose: (v) => {
        if (v !== 'ok') return;
        PE.S.meta.title = t.value.trim();
        PE.S.meta.author = a.value.trim();
        PE.app.setFileName(f.value);
        PE.commit();
      },
    });
  };

  U.formDialog = function () {
    const fields = PE.app.formFields || {};
    const list = h('div', { class: 'form-fields' });
    const vals = Object.assign({}, PE.S.form);
    for (const name in fields) {
      const f = fields[name];
      const cur = name in vals ? vals[name] : f.value;
      let ctrl;
      if (f.type === 'checkbox')
        ctrl = h('label', { class: 'chk' }, [
          h('input', { type: 'checkbox', checked: !!cur && cur !== 'Off', onchange: (e) => (vals[name] = e.target.checked) }),
          'Checked',
        ]);
      else if (f.type === 'combobox' || f.type === 'listbox' || f.type === 'radiobutton') {
        ctrl = h('select', { class: 'field', onchange: (e) => (vals[name] = e.target.value) });
        ctrl.appendChild(h('option', { value: '' }, '—'));
        for (const o of f.options || []) ctrl.appendChild(h('option', { value: o.v, selected: String(cur) === String(o.v) }, o.label));
      } else {
        ctrl = h(f.multiline ? 'textarea' : 'input', { class: 'field', rows: f.multiline ? 3 : null, oninput: (e) => (vals[name] = e.target.value) });
        ctrl.value = cur == null ? '' : String(cur);
      }
      list.appendChild(h('label', { class: 'lbl' }, [f.label || name, ctrl]));
    }
    U.dialog({
      title: 'Fill form fields',
      wide: true,
      body: [h('p', {}, 'You can also type straight into the fields on the page.'), list],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Save values', primary: true, value: 'ok' },
      ],
      onClose: (v) => {
        if (v !== 'ok') return;
        PE.S.form = vals;
        PE.commit();
        V.relayoutAll();
      },
    });
  };

  U.splitDialog = function () {
    let every = 1;
    const n = PE.S.pages.length;
    const info = h('p', {});
    const upd = () => (info.textContent = `${Math.ceil(n / every)} files will be downloaded, ${every} page${every > 1 ? 's' : ''} each.`);
    upd();
    U.dialog({
      title: 'Split into separate files',
      body: [
        row('Pages per file', num(1, { min: 1, max: Math.max(1, n), label: 'Pages per file' }, (v) => {
          every = v;
          upd();
        })),
        info,
        h('p', {}, 'Your browser may ask once for permission to download several files.'),
      ],
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Split and download', primary: true, value: 'ok' },
      ],
      onClose: async (v) => {
        if (v !== 'ok') return;
        const base = PE.app.fileName.replace(/\.pdf$/i, '');
        for (let s = 0, k = 1; s < n; s += every, k++) {
          const ids = PE.S.pages.slice(s, s + every).map((p) => p.id);
          await PE.app.download({ pageIds: ids, name: `${base}-part${k}.pdf`, quiet: true });
          await PE.sleep(350);
        }
        PE.toast('All parts downloaded.', 'ok');
      },
    });
  };

  U.exportPng = async function () {
    const pg = V.currentPage();
    if (!pg) return;
    try {
      U.busy(true, 'Rendering page', 0.3);
      const { bytes } = await PE.exportPdf({ pageIds: [pg.id] });
      const cv = await PE.renderPdfBytesPage(bytes, 0, 2.5);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      PE.download(blob, PE.app.fileName.replace(/\.pdf$/i, '') + `-page-${PE.pageIndex(pg.id) + 1}.png`, 'image/png');
    } catch (e) {
      console.error(e);
      PE.toast('Could not save the image: ' + e.message, 'error');
    } finally {
      U.busy(false);
    }
  };

  U.shortcutsDialog = function () {
    const k = PE.isMac ? '⌘' : 'Ctrl+';
    const list = [
      ['Undo / Redo', `${k}Z / ${k}Shift+Z`],
      ['Download PDF', `${k}S`],
      ['Open PDF', `${k}O`],
      ['Find and replace', `${k}F`],
      ['Zoom in / out', `${k}+ / ${k}−`],
      ['Edit tool / Text tool', 'V / T'],
      ['Draw / Highlight / Whiteout', 'D / H / W'],
      ['Insert image', 'I'],
      ['Delete selection', 'Delete'],
      ['Duplicate', `${k}D`],
      ['Copy / Paste objects', `${k}C / ${k}V`],
      ['Nudge 1 pt / 10 pt', 'Arrows / Shift+Arrows'],
      ['Bold / Italic / Underline', `${k}B / ${k}I / ${k}U`],
      ['New line while editing', 'Enter'],
      ['Finish editing', 'Esc'],
      ['Next table cell', 'Tab'],
    ];
    U.dialog({
      title: 'Keyboard shortcuts',
      body: [h('div', { class: 'shortcut-list' }, list.flatMap(([a, b]) => [h('span', {}, a), h('span', { class: 'kbd' }, b)]))],
      actions: [{ label: 'Close', primary: true, value: null }],
    });
  };

  U.aboutDialog = function () {
    U.dialog({
      title: 'About Pagewright',
      wide: true,
      body: [
        h('p', {}, 'Pagewright runs entirely in your browser. PDFs are read with pdf.js and written with pdf-lib; nothing is uploaded anywhere. Unsaved work is kept in this browser so a refresh does not lose it.'),
        h('p', {}, 'How text editing works: the editor finds paragraphs in the PDF and matches each font to the closest bundled font (Arial, Calibri, Times, Cambria, Courier, Roboto, Open Sans, Lato, Montserrat, Poppins, plus Tamil and Devanagari). Edited paragraphs are redrawn in that font over the original, and content below moves down when a paragraph grows.'),
        h('p', {}, 'Limits to know: fonts that are not in the list are replaced by the closest look-alike. Lines and boxes drawn in the PDF (such as table borders) stay where they are when text moves. Whiteout hides content but leaves it in the file; Redact removes it by saving that page as an image. Password-protected PDFs are saved as images.'),
      ],
      actions: [{ label: 'Close', primary: true, value: null }],
    });
  };

  /* ---------- find & replace ---------- */
  let hits = [],
    hitIdx = -1;
  U.openFind = async function () {
    if (!PE.S.pages.length) return;
    $('#find-bar').hidden = false;
    $('#find-q').focus();
    $('#find-q').select();
    // read text of every page so search covers the whole document
    let pending = PE.S.pages.filter((p) => p.src.t === 'pdf' && !PE.ex[PE.pageKey(p)]);
    if (pending.length) {
      $('#find-count').textContent = 'Reading…';
      for (const p of pending) await PE.extractPage(p.src.doc, p.src.i);
      for (const p of pending) V.renderOverlay(p);
      runFind();
    }
  };
  U.closeFind = function () {
    $('#find-bar').hidden = true;
    clearHitMarks();
    hits = [];
  };
  function clearHitMarks() {
    PE.$$('.find-hit').forEach((e) => e.classList.remove('find-hit'));
  }
  function textOf(pg, kind, id) {
    if (kind === 'obj') return PE.findObj(pg, id).runs.map((r) => r.t).join('');
    const ex = PE.ex[PE.pageKey(pg)];
    const b = ex.blocks.find((x) => x.id === id);
    const ov = pg.ov[id];
    return (ov && ov.runs ? ov.runs : b.runs).map((r) => r.t).join('');
  }
  function runFind() {
    clearHitMarks();
    const q = $('#find-q').value;
    hits = [];
    hitIdx = -1;
    if (!q) {
      $('#find-count').textContent = '';
      return;
    }
    const cs = $('#find-case').checked;
    const norm = (s) => (cs ? s : s.toLowerCase());
    const nq = norm(q);
    for (const pg of PE.S.pages) {
      const ex = pg.src.t === 'pdf' && PE.ex[PE.pageKey(pg)];
      const targets = [];
      if (ex) for (const b of ex.blocks) if (!(pg.ov[b.id] && pg.ov[b.id].del)) targets.push(['base', b.id]);
      for (const o of pg.objs) if (o.type === 'text') targets.push(['obj', o.id]);
      for (const [kind, id] of targets) {
        const t = norm(textOf(pg, kind, id));
        let i = t.indexOf(nq);
        while (i >= 0) {
          hits.push({ pg: pg.id, kind, id, at: i });
          i = t.indexOf(nq, i + nq.length);
        }
      }
    }
    $('#find-count').textContent = hits.length ? `${hits.length} found` : 'No matches';
    if (hits.length) gotoHit(0);
  }
  function gotoHit(i) {
    if (!hits.length) return;
    hitIdx = (i + hits.length) % hits.length;
    const hit = hits[hitIdx];
    clearHitMarks();
    const pg = PE.findPage(hit.pg);
    const pv = V.els.get(pg.id);
    const el = hit.kind === 'obj' ? V.objEl(pg, hit.id) : pv.baseEls && pv.baseEls[hit.id];
    $('#find-count').textContent = `${hitIdx + 1} of ${hits.length}`;
    if (el) {
      el.classList.add('find-hit');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else V.scrollToPage(pg.id);
  }
  function replaceIn(hit, q, rep, cs) {
    const pg = PE.findPage(hit.pg);
    let runs;
    if (hit.kind === 'obj') runs = PE.findObj(pg, hit.id).runs;
    else {
      const ex = PE.ex[PE.pageKey(pg)];
      const b = ex.blocks.find((x) => x.id === hit.id);
      if (!pg.ov[hit.id]) {
        const def = V.blockDefaults(ex, b);
        pg.ov[hit.id] = { runs: PE.clone(b.runs), align: def.align, lh: def.lh, w: def.w, auto: def.auto, h0: def.h0, dx: 0, dy: 0 };
      }
      runs = pg.ov[hit.id].runs;
    }
    const full = runs.map((r) => r.t).join('');
    const at = (cs ? full : full.toLowerCase()).indexOf(cs ? q : q.toLowerCase(), hit.at);
    if (at < 0) return false;
    // replace inside runs, keeping the style of the first matched character
    let pos = 0;
    const out = [];
    let placed = false;
    for (const r of runs) {
      const a = pos,
        b = pos + r.t.length;
      pos = b;
      if (b <= at || a >= at + q.length) {
        out.push(Object.assign({}, r));
        continue;
      }
      let t = '';
      if (at > a) t += r.t.slice(0, at - a);
      if (!placed) {
        t += rep;
        placed = true;
      }
      if (at + q.length < b) t += r.t.slice(at + q.length - a);
      out.push(Object.assign({}, r, { t }));
    }
    const merged = PE.mergeRuns(out);
    if (hit.kind === 'obj') PE.findObj(pg, hit.id).runs = merged;
    else pg.ov[hit.id].runs = merged;
    return pg;
  }
  async function doReplace(all) {
    const q = $('#find-q').value;
    if (!q || !hits.length) return;
    const rep = $('#find-r').value;
    const cs = $('#find-case').checked;
    if (T.editing) T.stopEditing();
    const touched = new Set();
    const list = all ? hits.slice().reverse() : [hits[Math.max(0, hitIdx)]];
    for (const hit of list) {
      const pg = replaceIn(hit, q, rep, cs);
      if (pg) touched.add(pg);
    }
    const runs = [];
    for (const pg of touched) for (const id in pg.ov) if (pg.ov[id].runs) runs.push(...pg.ov[id].runs);
    await PE.fonts.ensureRuns(runs);
    for (const pg of touched) V.renderOverlay(pg);
    PE.commit();
    U.renderThumbs();
    const n = list.length;
    runFind();
    PE.toast(all ? `Replaced ${n} match${n === 1 ? '' : 'es'}.` : 'Replaced.', 'ok');
  }

  /* ---------- wiring ---------- */
  U.init = function () {
    themeIcon();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeIcon);
    $('#btn-theme').addEventListener('click', U.toggleTheme);
    $('#btn-undo').addEventListener('click', () => PE.undo());
    $('#btn-redo').addEventListener('click', () => PE.redo());
    $('#btn-zoom-in').addEventListener('click', () => V.setZoom(V.zoom * 1.2));
    $('#btn-zoom-out').addEventListener('click', () => V.setZoom(V.zoom / 1.2));
    $('#btn-zoom').addEventListener('click', (e) =>
      U.menu(e.currentTarget, [
        { label: 'Fit width', icon: 'fit', onClick: () => V.fitWidth() },
        { label: 'Fit page', icon: 'file', onClick: () => V.fitPage() },
        '-',
        ...[50, 75, 100, 125, 150, 200, 300].map((z) => ({ label: z + '%', on: Math.round(V.zoom * 100) === z, onClick: () => V.setZoom(z / 100) })),
      ])
    );
    $('#btn-find').addEventListener('click', () => U.openFind());
    $('#btn-more').addEventListener('click', (e) => U.moreMenu(e.currentTarget));
    $('#btn-pages-toggle').addEventListener('click', () => document.body.classList.toggle('pages-open'));
    $('#btn-pages-close').addEventListener('click', () => document.body.classList.remove('pages-open'));
    document.addEventListener('click', (e) => {
      if (document.body.classList.contains('pages-open') && !e.target.closest('#pages-panel') && !e.target.closest('#btn-pages-toggle') && !e.target.closest('.menu') && !e.target.closest('.modal-veil'))
        document.body.classList.remove('pages-open');
    });
    $('#props-handle').addEventListener('click', () => document.body.classList.toggle('props-min'));
    PE.$$('#toolrail .tool').forEach((b) => b.addEventListener('click', () => railClick(b)));
    PE.$$('[data-page]').forEach((b) => b.addEventListener('click', () => U.pageOp(b.getAttribute('data-page'))));
    // find bar
    const q = $('#find-q');
    q.addEventListener('input', PE.debounce(runFind, 200));
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        gotoHit(hitIdx + (e.shiftKey ? -1 : 1));
      } else if (e.key === 'Escape') U.closeFind();
    });
    $('#find-r').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') U.closeFind();
      if (e.key === 'Enter') doReplace(false);
    });
    $('#find-case').addEventListener('change', runFind);
    $('#find-next').addEventListener('click', () => gotoHit(hitIdx + 1));
    $('#find-prev').addEventListener('click', () => gotoHit(hitIdx - 1));
    $('#find-close').addEventListener('click', U.closeFind);
    $('#find-rep').addEventListener('click', () => doReplace(false));
    $('#find-all').addEventListener('click', () => doReplace(true));
    V.scroller.addEventListener('scroll', U.markCurrentThumb, { passive: true });
    U.updateZoom();
    if (window.innerWidth < 1000) document.body.classList.add('pages-hidden');
  };
})();
