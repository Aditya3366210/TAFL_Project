'use strict';

/* ═══════════════════════════════════════════
   GLOBALS
═══════════════════════════════════════════ */
let G_RULES, G_MEMO, G_VISIT, G_MAX_TREES, G_MAX_DEPTH;
let activePZ = null; // the pan-zoom state currently being dragged

/* ═══════════════════════════════════════════
   LOAD SAMPLE
═══════════════════════════════════════════ */
function loadSample(grammar, input) {
  document.getElementById('grammar-input').value = grammar;
  document.getElementById('string-input').value  = input;
}

/* ═══════════════════════════════════════════
   1. GRAMMAR PARSER
═══════════════════════════════════════════ */
function parseGrammar(text) {
  const rules = {};
  let start = null;
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('#'));
  if (!lines.length) throw new Error('Grammar is empty.');
  if (lines.length > 20) throw new Error('Too many rules (max 20 lines).');
  for (const line of lines) {
    const m = line.match(/^([A-Z])\s*(?:→|->)\s*(.+)$/);
    if (!m) throw new Error(`Bad rule: "${line}"\nExpected: A → prod1 | prod2`);
    const [, lhs, rhs] = m;
    if (!start) start = lhs;
    if (!rules[lhs]) rules[lhs] = [];
    rules[lhs].push(...rhs.split('|').map(p => tokenize(p.trim())));
  }
  return { rules, start };
}

function tokenize(prod) {
  if (prod === 'ε' || prod === 'eps' || prod === '') return [];
  return prod.split('').filter(c => c !== ' ');
}

/* ═══════════════════════════════════════════
   2. PARSE TREE GENERATOR
═══════════════════════════════════════════ */
/* Each node: { sym, isNT, prod, children, span } */

function getAllTrees(sym, input, depth) {
  if (depth > G_MAX_DEPTH) return [];
  const key = sym + '\0' + input;
  if (G_MEMO.has(key)) return G_MEMO.get(key);
  if (G_VISIT.has(key)) return [];
  G_VISIT.add(key);
  const out = [];
  if (!G_RULES[sym]) {
    if (input === sym) out.push({ sym, isNT:false, prod:null, children:[], span:input });
  } else {
    for (const prod of G_RULES[sym]) {
      if (out.length >= G_MAX_TREES) break;
      for (const children of splitDerive(prod, input, depth + 1)) {
        if (out.length >= G_MAX_TREES) break;
        out.push({ sym, isNT:true, prod, children:children.slice(), span:input });
      }
    }
  }
  G_VISIT.delete(key);
  G_MEMO.set(key, out);
  return out;
}

function splitDerive(syms, input, depth) {
  if (depth > G_MAX_DEPTH) return [];
  if (!syms.length) return input === '' ? [[]] : [];
  const [first, ...rest] = syms;
  const out = [];
  const CAP = G_MAX_TREES * G_MAX_TREES;
  for (let i = 0; i <= input.length; i++) {
    const lt = getAllTrees(first, input.slice(0, i), depth);
    if (!lt.length) continue;
    const rc = splitDerive(rest, input.slice(i), depth);
    if (!rc.length) continue;
    for (const l of lt) for (const r of rc) { out.push([l, ...r]); if (out.length >= CAP) return out; }
  }
  return out;
}

/* Deduplicate by canonical structural serialisation */
function serTree(n) {
  if (!n.isNT) return `T(${n.sym})`;
  return `N(${n.sym}:${(n.prod||[]).join('')}[${n.children.map(serTree).join(',')}])`;
}
function deduplicate(trees) {
  const seen = new Set();
  return trees.filter(t => { const k = serTree(t); if (seen.has(k)) return false; seen.add(k); return true; });
}

function buildAllParseTrees(grammar, str) {
  G_RULES     = grammar.rules;
  G_MEMO      = new Map();
  G_VISIT     = new Set();
  G_MAX_TREES = +document.getElementById('max-trees').value;
  G_MAX_DEPTH = +document.getElementById('max-depth').value;
  return deduplicate(getAllTrees(grammar.start, str, 0));
}

/* Deep-clone a tree and assign unique _id per node */
let _idc = 0;
function cloneTree(n) {
  return { sym:n.sym, isNT:n.isNT, prod:n.prod, span:n.span, children:n.children.map(cloneTree), _id:++_idc };
}

/* ═══════════════════════════════════════════
   3. LAYOUT ENGINE
═══════════════════════════════════════════ */
const NW=46, NH=30, NR=7, HSEP=16, VGAP=76, TPAD=28;

function layoutTree(root) { measure(root); assign(root, TPAD, 0); }

function measure(n) {
  if (!n.children.length) { n.sw = NW + HSEP; return; }
  n.children.forEach(measure);
  n.sw = Math.max(NW + HSEP, n.children.reduce((s,c) => s + c.sw, 0));
}

function assign(n, left, depth) {
  n.cx = left + n.sw / 2;
  n.cy = TPAD + depth * VGAP + NH / 2;
  if (!n.children.length) return;
  const cw = n.children.reduce((s,c) => s + c.sw, 0);
  let x = left + (n.sw - cw) / 2;
  for (const c of n.children) { assign(c, x, depth + 1); x += c.sw; }
}

function treeDepth(n) {
  if (!n.children.length) return 0;
  return 1 + Math.max(...n.children.map(treeDepth));
}

/* ═══════════════════════════════════════════
   4. SVG DOM RENDERER
═══════════════════════════════════════════ */
const NS = 'http://www.w3.org/2000/svg';
function E(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k,v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function ET(tag, attrs, text) { const e = E(tag, attrs); e.textContent = text; return e; }

/**
 * Build an interactive SVG for the given parse tree.
 * Returns { svg, nodeMap, edgeMap, root(layoutted clone) }
 */
function buildTreeSVG(rawRoot) {
  _idc = 0;
  const root = cloneTree(rawRoot);
  layoutTree(root);

  const depth = treeDepth(root);
  const svgW = root.sw + TPAD * 2;
  const svgH = (depth + 1) * VGAP + TPAD + 48;

  const svg = E('svg', { width: svgW, height: svgH, viewBox: `0 0 ${svgW} ${svgH}`, class:'tsvg', style:'display:block;user-select:none' });

  const nodeMap = new Map(); // _id → { node, g, rect }
  const edgeMap = new Map(); // "pid-cid" → path element

  /* Collect all parent→child pairs */
  const pairs = [];
  (function collectPairs(n) { for (const c of n.children) { pairs.push([n, c]); collectPairs(c); } })(root);

  /* Edge layer */
  const eLayer = E('g', { class:'edge-layer' });
  for (const [p, c] of pairs) {
    const x1=p.cx, y1=p.cy+NH/2, x2=c.cx, y2=c.cy-NH/2, my=(y1+y2)/2;
    const path = E('path', { d:`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, class:'tedge' });
    eLayer.appendChild(path);
    edgeMap.set(`${p._id}-${c._id}`, path);
  }
  svg.appendChild(eLayer);

  /* Node layer */
  const nLayer = E('g', { class:'node-layer' });
  (function renderNode(n) {
    const isNT = n.isNT;
    const g = E('g', { class:`tree-node ${isNT ? 'nt' : 'tt'}`, 'data-nid': n._id });
    const rx = n.cx - NW/2, ry = n.cy - NH/2;
    const fill   = isNT ? 'url(#nt-grad)'  : 'url(#t-grad)';
    const stroke = isNT ? '#3b82f6'         : '#22c55e';
    const txtClr = isNT ? '#7ec8fd'         : '#4dde88';

    const rect = E('rect', { x:rx, y:ry, width:NW, height:NH, rx:NR, fill, stroke, 'stroke-width':'1.5', class:'nr' });
    g.appendChild(rect);
    g.appendChild(ET('text', { x:n.cx, y:n.cy+5, 'text-anchor':'middle', fill:txtClr, 'font-family':'JetBrains Mono,monospace', 'font-size':'13', 'font-weight':'700' }, n.sym));

    if (isNT) {
      const lbl = n.prod && n.prod.length ? '→'+n.prod.join('') : '→ε';
      g.appendChild(ET('text', { x:n.cx, y:ry+NH+11, 'text-anchor':'middle', fill:'#283848', 'font-family':'JetBrains Mono,monospace', 'font-size':'8.5' }, lbl));
    }

    nodeMap.set(n._id, { node:n, g, rect, isNT });

    g.addEventListener('click', ev => {
      ev.stopPropagation();
      selectNode(n, svg, nodeMap, edgeMap);
    });
    nLayer.appendChild(g);
    for (const c of n.children) renderNode(c);
  })(root);

  svg.appendChild(nLayer);

  /* Click on background → deselect */
  svg.addEventListener('click', () => { clearSel(nodeMap, edgeMap); hideNodeInfo(); });

  return { svg, nodeMap, edgeMap, root, svgW, svgH };
}

/* ── Selection helpers ── */
function descIds(n) { return [n._id, ...n.children.flatMap(descIds)]; }
function childEdgeKeys(n) {
  return n.children.flatMap(c => [`${n._id}-${c._id}`, ...childEdgeKeys(c)]);
}

function clearSel(nodeMap, edgeMap) {
  for (const { g, rect, isNT } of nodeMap.values()) {
    g.classList.remove('sel', 'shi');
    rect.setAttribute('fill', isNT ? 'url(#nt-grad)' : 'url(#t-grad)');
    rect.setAttribute('stroke', isNT ? '#3b82f6' : '#22c55e');
    rect.setAttribute('stroke-width', '1.5');
  }
  for (const p of edgeMap.values()) { p.classList.remove('ehi'); p.setAttribute('stroke','#1a2535'); p.setAttribute('stroke-width','1.5'); }
}

function selectNode(n, svg, nodeMap, edgeMap) {
  clearSel(nodeMap, edgeMap);
  const ids = new Set(descIds(n));
  const ekeys = new Set(childEdgeKeys(n));

  for (const [id, { node, g, rect, isNT }] of nodeMap) {
    if (id === n._id) {
      g.classList.add('sel');
      rect.setAttribute('fill', 'url(#sel-grad)');
      rect.setAttribute('stroke', '#f0a030');
      rect.setAttribute('stroke-width', '2.5');
    } else if (ids.has(id)) {
      g.classList.add('shi');
      rect.setAttribute('stroke', '#b07020');
      rect.setAttribute('stroke-width', '2');
    }
  }
  for (const [k, p] of edgeMap) {
    if (ekeys.has(k)) { p.classList.add('ehi'); p.setAttribute('stroke','rgba(220,140,30,.65)'); p.setAttribute('stroke-width','2'); }
  }
  showNodeInfo(n);
}

/* ── Node Info Panel ── */
function showNodeInfo(n) {
  document.getElementById('ni-type').textContent = n.isNT ? 'Non-Terminal' : 'Terminal';
  const sym = document.getElementById('ni-sym');
  sym.textContent = n.sym;
  sym.className = 'ni-sym ' + (n.isNT ? 'nt' : 'tt');
  const prod = document.getElementById('ni-prod');
  prod.textContent = !n.isNT ? '(leaf — no production)' : (!n.prod || !n.prod.length) ? `${n.sym} → ε` : `${n.sym} → ${n.prod.join(' ')}`;
  document.getElementById('ni-derv').textContent = n.span === '' ? 'ε (empty)' : `"${n.span}"`;
  document.getElementById('nipanel').classList.add('vis');
}
function hideNodeInfo() { document.getElementById('nipanel').classList.remove('vis'); }

/* ═══════════════════════════════════════════
   5. PAN / ZOOM
═══════════════════════════════════════════ */
function setupPanZoom(viewport, wrapper) {
  const s = { scale:1, tx:0, ty:0, dragging:false, sx:0, sy:0, stx:0, sty:0, viewport, wrapper };

  s.apply = function() {
    wrapper.style.transform = `translate(${s.tx}px,${s.ty}px) scale(${s.scale})`;
    wrapper.style.transformOrigin = '0 0';
  };

  viewport.addEventListener('wheel', ev => {
    ev.preventDefault();
    const f = ev.deltaY < 0 ? 1.1 : 1/1.1;
    // UPDATED: Changed .2 to .5 to restrict max zoom out
    const ns = Math.max(.5, Math.min(4, s.scale * f));
    const r = viewport.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    s.tx = mx - (mx - s.tx) * (ns / s.scale);
    s.ty = my - (my - s.ty) * (ns / s.scale);
    s.scale = ns;
    s.apply();
    setZoomLabel(viewport, s.scale);
  }, { passive:false });

  viewport.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    s.dragging = true; s.sx = ev.clientX; s.sy = ev.clientY; s.stx = s.tx; s.sty = s.ty;
    viewport.classList.add('pgrab');
    activePZ = s;
    ev.preventDefault();
  });

  /* Touch */
  let lastD = null, ts0 = null;
  viewport.addEventListener('touchstart', ev => {
    ev.preventDefault();
    if (ev.touches.length === 1) { s.dragging = true; s.sx = ev.touches[0].clientX; s.sy = ev.touches[0].clientY; s.stx = s.tx; s.sty = s.ty; activePZ = s; }
    if (ev.touches.length === 2) { s.dragging = false; lastD = dist2(ev.touches); ts0 = { scale:s.scale, tx:s.tx, ty:s.ty }; }
  }, { passive:false });

  viewport.addEventListener('touchmove', ev => {
    ev.preventDefault();
    if (ev.touches.length === 1 && s.dragging) { s.tx = s.stx + ev.touches[0].clientX - s.sx; s.ty = s.sty + ev.touches[0].clientY - s.sy; s.apply(); }
    if (ev.touches.length === 2 && lastD && ts0) {
      const d = dist2(ev.touches);
      // UPDATED: Changed .2 to .5 to restrict max zoom out
      s.scale = Math.max(.5, Math.min(4, ts0.scale * d / lastD));
      s.apply(); setZoomLabel(viewport, s.scale);
    }
  }, { passive:false });

  viewport.addEventListener('touchend', () => { s.dragging = false; lastD = null; ts0 = null; if (activePZ === s) activePZ = null; });

  s.apply();

  return {
    zoomIn:  () => { s.scale = Math.min(4, s.scale * 1.2); s.apply(); setZoomLabel(viewport, s.scale); },
    // UPDATED: Changed .2 to .5 to restrict max zoom out
    zoomOut: () => { s.scale = Math.max(.5, s.scale / 1.2); s.apply(); setZoomLabel(viewport, s.scale); },
    reset:   () => { s.scale = 1; s.tx = 0; s.ty = 0; s.apply(); setZoomLabel(viewport, s.scale); },
  };
}

function dist2(ts) { return Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY); }
function setZoomLabel(vp, sc) { const l = vp.closest('.tcard')?.querySelector('.zlbl'); if (l) l.textContent = Math.round(sc * 100) + '%'; }

/* Global pan handlers */
document.addEventListener('mousemove', ev => {
  if (!activePZ?.dragging) return;
  activePZ.tx = activePZ.stx + ev.clientX - activePZ.sx;
  activePZ.ty = activePZ.sty + ev.clientY - activePZ.sy;
  activePZ.apply();
});
document.addEventListener('mouseup', () => {
  if (activePZ) { activePZ.dragging = false; activePZ.viewport.classList.remove('pgrab'); activePZ = null; }
});

/* ═══════════════════════════════════════════
   6. LEFTMOST DERIVATION
═══════════════════════════════════════════ */
function getDerivation(root) {
  const steps = [];
  let sf = [root];
  const str = f => f.map(n => n.sym).join('');
  steps.push(str(sf));
  for (let g = 60; g > 0; g--) {
    const i = sf.findIndex(n => n.isNT);
    if (i < 0) break;
    sf = [...sf.slice(0, i), ...(sf[i].children || []), ...sf.slice(i+1)];
    steps.push(str(sf));
  }
  return steps;
}

/* ═══════════════════════════════════════════
   7. UTILITIES
═══════════════════════════════════════════ */
function escXML(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ═══════════════════════════════════════════
   8. UI CONTROLLER
═══════════════════════════════════════════ */
function checkAmbiguity() {
  const grammarText = document.getElementById('grammar-input').value.trim();
  const inputStr    = document.getElementById('string-input').value;
  const panel       = document.getElementById('results-panel');

  hideNodeInfo();

  if (!grammarText) { showError('Please enter a grammar.', panel); return; }
  if (inputStr === '') { showError('Please enter an input string.', panel); return; }
  if (inputStr.length > 12) { showError(`Input too long (${inputStr.length} chars). Max is 12.`, panel); return; }

  let grammar;
  try { grammar = parseGrammar(grammarText); }
  catch(e) { showError('Grammar error: ' + e.message, panel); return; }

  panel.innerHTML = `<div class="placeholder"><div class="ph-icon spin">⟳</div><p class="ph-txt">Generating parse trees…</p></div>`;

  setTimeout(() => {
    try {
      const trees = buildAllParseTrees(grammar, inputStr);
      renderResults(trees, inputStr, grammar, panel);
    } catch(e) {
      showError('Analysis error: ' + e.message, panel);
    }
  }, 20);
}

function renderResults(trees, inputStr, grammar, panel) {
  const count    = trees.length;
  const hitLimit = count >= G_MAX_TREES;

  let verdict, vclass;
  if (count === 0)               { verdict = 'NOT IN LANGUAGE'; vclass = 'vn'; }
  else if (count === 1 && !hitLimit) { verdict = 'UNAMBIGUOUS';    vclass = 'vu'; }
  else                               { verdict = 'AMBIGUOUS';      vclass = 'va'; }

  const tcStr = count === 0 ? '0' : hitLimit ? `≥${count}` : `${count}`;

  const grammarHTML = Object.entries(grammar.rules).map(([nt, prods]) => {
    const ps = prods.map(p => {
      if (!p.length) return '<span class="gt">ε</span>';
      return p.map(s => /[A-Z]/.test(s) ? `<span class="gnt">${escXML(s)}</span>` : `<span class="gt">${escXML(s)}</span>`).join('');
    }).join('<span class="gpipe"> | </span>');
    return `<span class="gnt">${nt}</span><span class="garr"> → </span>${ps}`;
  }).join('<br>');

  let html = `
    <div class="rhdg">
      <div class="verdict ${vclass}"><span class="vdot"></span>${verdict}</div>
      <div class="metarow">
        <span class="mpill">String: <strong>"${escXML(inputStr)}"</strong></span>
        <span class="mpill">Trees: <strong>${tcStr}</strong></span>
        <span class="mpill">Start: <strong>${grammar.start}</strong></span>
      </div>
    </div>
    <div class="gdisp">${grammarHTML}</div>
    <div class="legend">
      <span class="li"><span class="lb lb-nt"></span>Non-terminal</span>
      <span class="li"><span class="lb lb-t"></span>Terminal</span>
      <span class="li"><span class="lb lb-sel"></span>Selected / subtree</span>
      <span class="lsep">·</span>
      <span style="font-size:10px;color:var(--td)">Click to inspect · Scroll to zoom · Drag to pan</span>
    </div>`;

  if (count === 0) {
    html += `<div class="errbox">The string <strong>"${escXML(inputStr)}"</strong> cannot be derived from start symbol <strong>${grammar.start}</strong> using the given grammar.</div>`;
    panel.innerHTML = html;
    return;
  }

  if (hitLimit) {
    html += `<div class="warnbox">⚠ Tree limit (${G_MAX_TREES}) reached — showing first ${count} trees. The grammar is <strong>definitely ambiguous</strong>. Increase "Max Trees" or shorten the input for a full count.</div>`;
  }

  panel.innerHTML = html;

  /* Build tree cards via DOM */
  const grid = document.createElement('div');
  grid.className = 'tgrid';
  panel.appendChild(grid);

  trees.forEach((rawTree, i) => {
    const card = document.createElement('div');
    card.className = 'tcard';
    card.style.animationDelay = `${i * 0.05}s`;

    /* Header */
    const hdr = document.createElement('div');
    hdr.className = 'tcardh';
    hdr.innerHTML = `
      <span>Parse Tree ${i+1} <span style="color:var(--td)">/ ${tcStr}</span></span>
      <div class="zctrl">
        <button class="zbtn" title="Zoom out">−</button>
        <span class="zlbl">100%</span>
        <button class="zbtn" title="Zoom in">+</button>
        <button class="zbtn" title="Reset" style="font-size:9px">↺</button>
      </div>`;
    card.appendChild(hdr);

    /* Viewport */
    const vp = document.createElement('div');
    vp.className = 'tvp';

    /* Build SVG */
    const { svg, nodeMap, edgeMap, svgW, svgH } = buildTreeSVG(rawTree);
    const depth = treeDepth(rawTree);
    const naturalH = (depth + 1) * VGAP + TPAD + 48;
    vp.style.height = Math.min(400, Math.max(140, naturalH + 20)) + 'px';

    /* Wrapper for transform */
    const wrap = document.createElement('div');
    wrap.className = 'twrap';
    wrap.appendChild(svg);
    vp.appendChild(wrap);
    card.appendChild(vp);

    /* Pan/zoom */
    const pz = setupPanZoom(vp, wrap);
    const [btnOut, btnIn, btnReset] = hdr.querySelectorAll('.zbtn');
    btnOut.onclick = () => pz.zoomOut();
    btnIn.onclick  = () => pz.zoomIn();
    btnReset.onclick = () => pz.reset();

    /* Derivation */
    const ds = getDerivation(rawTree);
    const dsec = document.createElement('div');
    dsec.className = 'dersec';
    const derivHTML = ds.map((step, si) => {
      const col = step.replace(/[A-Z]/g, m => `<span class="dnt">${m}</span>`);
      return col + (si < ds.length-1 ? '<span class="darr"> ⇒ </span>' : '');
    }).join('');
    dsec.innerHTML = `
      <button class="dertog">▸ Leftmost derivation (${ds.length} step${ds.length!==1?'s':''})</button>
      <div class="dersteps"><span>${derivHTML}</span></div>`;
    dsec.querySelector('.dertog').addEventListener('click', function() {
      const box = this.nextElementSibling;
      const open = box.classList.toggle('open');
      this.textContent = (open ? '▾' : '▸') + this.textContent.slice(1);
    });
    card.appendChild(dsec);

    grid.appendChild(card);
  });
}

function showError(msg, panel) {
  (panel || document.getElementById('results-panel')).innerHTML =
    `<div class="errbox" style="margin-top:6px">⚠ ${escXML(msg)}</div>`;
}

document.getElementById('string-input').addEventListener('keydown', ev => {
  if (ev.key === 'Enter') checkAmbiguity();
});