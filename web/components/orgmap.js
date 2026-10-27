// Org map (#/map): you at the centre, Donna's orbit around you (everything
// routes through her), domains on the next ring, projects on the outer ring
// fanned out from their domain. Hand-built SVG, no chart library.
// The "Claude Code setup" layer (off by default) draws what every session loads as a dashed halo
// around you, with a chip per list, and badges the projects whose repo adds its own setup.
import { html } from '../lib/html.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { Icon, AgentIcon, hasIcon } from './icons.js';
import { StatusGlyph } from './status.js';
import { api } from '../lib/api.js';
import { startSession, focusSession, navigate, openOverlay, dismissImportCard } from '../lib/actions.js';
import { agentStats, sessionName, statusText, KIND_LABEL, STATUS_LABEL, countNeedsYou } from '../lib/model.js';
import { relTime, clamp, prefersReducedMotion, tildify, plural } from '../lib/util.js';
import { load, save } from '../lib/prefs.js';
import { OrgError, useImportStep } from './first-run.js';
import { useSetup, repoAdds, RepoAdds, SetupKindPanelBody, kindOf, countOf } from './setup.js';
import { BLOCKED_TITLE, useStartBlocked } from './health-banner.js';
import { usd, usdOrUnknown, useOrgReport } from './report-card.js';

const TAU = Math.PI * 2;
const R_OWNER = 30;
const R_CHIEF = 24;
const R_DOMAIN = 24;
const R_PROJECT = 17;
const R1 = 100; // Donna's orbit
const R1_SETUP = 150; // with the setup layer on: room for its chips between you and Donna
const HALO = 40; // the setup layer's dashed ring around you
const CHIP_GAP = 46; // chips start this far left/right of your centre
const CHIP_H = 24;
// The layer's chips: two on each side of you, clear of the line up to Donna and your label below.
const CHIPS = [['skills', -1, -1], ['agents', 1, -1], ['mcp', -1, 1], ['hooks', 1, 1]];
const LABEL_CH = 6.9; // px per character at 12px, for collision budgeting

const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

// Spread items on a circle near their ideal angles while keeping >= gap apart.
function relaxCircle(items, gap) {
  for (const it of items) it.angle = it.ideal; // (one item too: it keeps its ideal angle)
  if (items.length < 2) return;
  items.sort((a, b) => a.ideal - b.ideal);
  for (const it of items) it.angle = it.ideal;
  for (let iter = 0; iter < 80; iter += 1) {
    let moved = false;
    for (let i = 0; i < items.length; i += 1) {
      const a = items[i];
      const b = items[(i + 1) % items.length];
      let d = b.angle - a.angle;
      if (i === items.length - 1) d += TAU;
      if (d < gap) {
        const push = (gap - d) / 2 + 1e-4;
        a.angle -= push;
        b.angle += push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

export function layoutOrg(agents, ownerName, { setup = false } = {}) {
  const r1 = setup ? R1_SETUP : R1;
  const chief = agents.find((a) => a.kind === 'chief') || agents.find((a) => a.id === 'donna');
  const domains = agents.filter((a) => a.kind === 'domain');
  const domainIds = new Set(domains.map((d) => d.id));
  const projects = agents.filter((a) => a.kind === 'project');
  const orphans = projects.filter((p) => !p.domain || !domainIds.has(p.domain));

  const ring = domains.map((d) => ({ id: d.id, kind: 'domain', agent: d, label: d.name, kids: projects.filter((p) => p.domain === d.id) }));
  if (orphans.length) ring.push({ id: '__projects', kind: 'cluster', agent: null, label: 'Projects', kids: orphans });

  const nodes = [];
  const edges = [];
  nodes.push({ id: '__owner', kind: 'owner', x: 0, y: 0, r: R_OWNER, label: ownerName || 'You', sub: 'You' });
  if (chief) {
    const [x, y] = polar(r1, -Math.PI / 2);
    nodes.push({ id: chief.id, kind: 'chief', agent: chief, x, y, r: R_CHIEF, label: chief.name, sub: 'Chief of staff', angle: -Math.PI / 2 });
    edges.push({ kind: 'core', from: '__owner', to: chief.id });
  }

  // Domain ring: angular share follows how many projects hang off each domain.
  const weights = ring.map((n) => clamp(n.kids.length, 1, 3));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const unit = TAU / total;
  let minGap = TAU;
  for (let i = 0; i < ring.length && ring.length > 1; i += 1) {
    const j = (i + 1) % ring.length;
    minGap = Math.min(minGap, ((weights[i] + weights[j]) / 2) * unit);
  }
  const longest = Math.max(6, ...ring.map((n) => Math.min(18, n.label.length)));
  const domainArc = Math.max(116, longest * LABEL_CH + 26);
  const R2 = ring.length ? Math.max(212, r1 + 112, ring.length > 1 ? domainArc / minGap : 0) : 0;
  let acc = -Math.PI / 2;
  ring.forEach((n, i) => {
    n.angle = acc + (weights[i] * unit) / 2;
    acc += weights[i] * unit;
    if (ring.length === 1) n.angle = Math.PI / 2;
    const [x, y] = polar(R2, n.angle);
    nodes.push({ id: n.id, kind: n.kind, agent: n.agent, x, y, r: n.kind === 'cluster' ? 19 : R_DOMAIN, label: n.label, angle: n.angle,
      sub: n.kind === 'cluster' ? `${n.kids.length} without a domain` : undefined });
    edges.push({ kind: 'spoke', from: chief ? chief.id : '__owner', to: n.id, angle: n.angle, r0: r1, r1: R2 - (n.kind === 'cluster' ? 19 : R_DOMAIN) });
  });

  // Outer ring: projects start at their domain's angle, then relax apart.
  const outer = [];
  for (const n of ring) {
    const k = n.kids.length;
    n.kids.forEach((p, i) => outer.push({ p, parent: n, ideal: n.angle + (i - (k - 1) / 2) * 0.12 }));
  }
  const projArc = 92;
  const R3 = outer.length ? Math.max(R2 + 150, (outer.length * projArc) / TAU * 1.08) : 0;
  relaxCircle(outer, projArc / (R3 || 1));
  for (const o of outer) {
    const [x, y] = polar(R3, o.angle);
    nodes.push({ id: o.p.id, kind: 'project', agent: o.p, x, y, r: R_PROJECT, label: o.p.name, angle: o.angle, parent: o.parent.id });
    edges.push({ kind: 'branch', from: o.parent.id, to: o.p.id, a0: o.parent.angle, a1: o.angle, r0: R2, r1: R3 });
  }

  // Label placement: inner nodes below; projects outward along their angle.
  let minX = -R_OWNER - 60;
  let maxX = R_OWNER + 60;
  let minY = -r1 - R_CHIEF - 20;
  let maxY = R_OWNER + 44;
  for (const n of nodes) {
    const text = trunc(n.label, n.kind === 'project' ? 20 : 22);
    n.text = text;
    const w = text.length * LABEL_CH;
    if (n.kind === 'project') {
      const c = Math.cos(n.angle);
      const s = Math.sin(n.angle);
      const off = n.r + 9;
      n.lx = n.x + c * off;
      n.ly = n.y + s * off;
      n.anchor = c > 0.35 ? 'start' : c < -0.35 ? 'end' : 'middle';
      n.base = s > 0.35 ? 'hanging' : s < -0.35 ? 'auto' : 'middle';
      if (n.anchor === 'middle') n.ly += s > 0 ? 3 : -3;
      const lx0 = n.anchor === 'start' ? n.lx : n.anchor === 'end' ? n.lx - w : n.lx - w / 2;
      minX = Math.min(minX, lx0 - 6, n.x - n.r);
      maxX = Math.max(maxX, lx0 + w + 6, n.x + n.r);
      minY = Math.min(minY, n.ly - 18, n.y - n.r - 12);
      maxY = Math.max(maxY, n.ly + 18, n.y + n.r + 12);
    } else if (n.kind === 'chief') {
      // Above the node: to its right, the label and "Chief of staff" crossed the first spokes.
      n.lx = n.x;
      n.ly = n.y - n.r - 30; // clear of the needs and selection rings (r + 9)
      n.anchor = 'middle';
      n.base = 'auto';
      minX = Math.min(minX, n.x - w / 2 - 8);
      maxX = Math.max(maxX, n.x + w / 2 + 8);
      minY = Math.min(minY, n.ly - 32);
    } else {
      n.lx = n.x;
      n.ly = n.y + n.r + 15;
      n.anchor = 'middle';
      n.base = 'hanging';
      minX = Math.min(minX, n.x - w / 2 - 8, n.x - n.r - 12);
      maxX = Math.max(maxX, n.x + w / 2 + 8, n.x + n.r + 12);
      minY = Math.min(minY, n.y - n.r - 14);
      maxY = Math.max(maxY, n.ly + (n.sub ? 32 : 18));
    }
  }
  // Room for each agent's usage line (1.5), above or below its label.
  return { nodes, edges, rings: { R1: r1, R2, R3 }, bounds: { minX, maxX, minY: minY - 16, maxY: maxY + 16 }, hasChief: !!chief };
}

function nodeStats(n, sessions) {
  if (n.kind === 'owner' || n.kind === 'cluster') return { live: 0, blocked: 0, turn: 0, needs: 0, working: 0 };
  return agentStats(n.id, sessions); // needs = blocked (Claude asked) + turn (your reply)
}

export function OrgMap() {
  const agents = useStore((s) => s.agents);
  const sessionsMap = useStore((s) => s.sessions);
  const org = useStore((s) => s.org);
  const me = useStore((s) => s.me);
  const orgError = useStore((s) => s.orgError);
  const mobile = useStore((s) => s.mobile);
  const now = useStore((s) => s.now);
  const sessions = useMemo(() => Object.values(sessionsMap), [sessionsMap]);
  const owner = (org && (org.owner || org.name)) || (me && me.owner) || 'You';
  const ownerName = org && org.owner ? org.owner : owner;
  const [layer, setLayer] = useState(() => !!load('mapSetupLayer', false));
  const setup = useSetup(layer);
  const importStep = useImportStep();
  const L = useMemo(() => layoutOrg(agents, ownerName, { setup: layer }), [agents, ownerName, layer]);
  const [sel, setSel] = useState(null);
  const [hover, setHover] = useState(null);
  const wrap = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ k: 1, x: 0, y: 0, auto: true });
  const drag = useRef(null);

  useEffect(() => {
    const node = wrap.current;
    if (!node) return undefined;
    const ro = new ResizeObserver(() => setBox({ w: node.clientWidth, h: node.clientHeight }));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // Below 1100px the side panel floats over the map; fit the org into what is left.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia('(max-width: 1100px)'); } catch { return undefined; }
    const f = () => setNarrow(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  const covered = narrow && sel && box.w > 560 ? 360 : 0;
  const toggleLayer = () => {
    const on = !layer;
    setLayer(on);
    save('mapSetupLayer', on);
    if (!on && sel && sel.startsWith('__setup:')) setSel(null);
  };

  // The hint along the bottom ("just you and Donna", "No project agents yet") gets its own strip,
  // so it never covers a node.
  const hintUp = !orgError && (agents.length <= 1 || importStep);
  const hintRef = useRef(null);
  const [hintH, setHintH] = useState(0);
  useEffect(() => {
    const node = hintUp ? hintRef.current : null;
    if (!node) { setHintH(0); return undefined; }
    const ro = new ResizeObserver(() => setHintH(node.offsetHeight));
    ro.observe(node);
    return () => ro.disconnect();
  }, [hintUp]);
  const below = hintUp && hintH ? hintH + 40 : 0; // the hint sits 32 px above the bottom
  const fit = useMemo(() => {
    const { minX, maxX, minY, maxY } = L.bounds;
    const cw = maxX - minX;
    const ch = maxY - minY;
    if (!box.w || !box.h) return { k: 1, x: 0, y: 0 };
    const w = box.w - covered;
    const h = box.h - below;
    const k = clamp(Math.min((w - 48) / cw, (h - 48) / ch), 0.35, 1.45);
    return { k, x: -((minX + maxX) / 2) * k - covered / 2, y: -((minY + maxY) / 2) * k - below / 2 };
  }, [L, box, covered, below]);

  const t = view.auto ? fit : view;
  const statsById = useMemo(() => {
    const m = {};
    for (const n of L.nodes) m[n.id] = nodeStats(n, sessions);
    return m;
  }, [L, sessions]);
  const nodeById = useMemo(() => Object.fromEntries(L.nodes.map((n) => [n.id, n])), [L]);

  const zoomBy = (f, cx = 0, cy = 0) => {
    setView((v) => {
      const base = v.auto ? fit : v;
      const k = clamp(base.k * f, 0.3, 3);
      const real = k / base.k;
      return { k, x: cx - (cx - base.x) * real, y: cy - (cy - base.y) * real, auto: false };
    });
  };
  const onWheel = (e) => {
    e.preventDefault();
    const r = wrap.current.getBoundingClientRect();
    const cx = e.clientX - r.left - r.width / 2;
    const cy = e.clientY - r.top - r.height / 2;
    zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), cx, cy);
  };
  useEffect(() => {
    const node = wrap.current;
    if (!node) return undefined;
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  });

  const onPointerDown = (e) => {
    // Nodes, chips and the hint's buttons are clicks, not drags (a pointer capture would eat them).
    if (e.button !== 0 || e.target.closest('.node, .setup-chip, .map-hint, .map-layer-note')) return;
    const base = view.auto ? fit : view;
    drag.current = { x: e.clientX, y: e.clientY, bx: base.x, by: base.y, k: base.k, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    setView({ k: d.k, x: d.bx + dx, y: d.by + dy, auto: false });
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) setSel(null);
  };

  // Usage over 7 days and when each agent last finished work (the report card, 1.5).
  const orgRep = useOrgReport(agents.map((a) => a.id).join(','));
  const repById = useMemo(() => Object.fromEntries(((orgRep && orgRep.agents) || []).map((a) => [a.id, a])), [orgRep]);

  const counts = useMemo(() => ({
    domains: agents.filter((a) => a.kind === 'domain').length,
    projects: agents.filter((a) => a.kind === 'project').length,
    live: sessions.filter((s) => s.status !== 'ended').length,
    needs: countNeedsYou(sessions), // blocked + your turn, exactly like the rail's "Needs you"
  }), [agents, sessions]);

  const focusId = hover || sel;
  const related = useMemo(() => {
    if (!focusId) return null;
    const set = new Set([focusId]);
    for (const e of L.edges) {
      if (e.from === focusId) set.add(e.to);
      if (e.to === focusId) set.add(e.from);
    }
    return set;
  }, [focusId, L]);

  const reduced = prefersReducedMotion();
  const selNode = sel ? nodeById[sel] : null;
  const setupSel = sel && sel.startsWith('__setup:') ? sel.slice(8) : null;
  const sdata = layer ? setup.data : null;
  // Project node id -> what its repo adds (a project with several repos has one entry per repo).
  const adds = useMemo(() => {
    const m = {};
    for (const p of (sdata && Array.isArray(sdata.projects) ? sdata.projects : [])) {
      if (!p || !p.agent) continue;
      (m[p.agent] = m[p.agent] || []).push(p);
    }
    return m;
  }, [sdata]);
  const chips = useMemo(() => {
    if (!sdata) return [];
    return CHIPS.map(([k, side, row]) => {
      const n = countOf(k, sdata[k]); // hooks: every hook, like the Settings card and the panel
      const label = kindOf(k).chip;
      const w = Math.round(22 + (label.length + String(n).length + 1) * 6.3);
      return { k, n, label, w, x: side * (CHIP_GAP + w / 2), y: row * (CHIP_H / 2 + 3) };
    });
  }, [sdata]);

  return html`<div class=${`page map-page ${selNode || setupSel ? 'has-panel' : ''}`} data-testid="org-map" data-setup-layer=${layer ? 'on' : 'off'}>
    <header class="page-bar">
      <div class="page-bar-main">
        <h1 class="page-title">Org map</h1>
        <p class="page-sub">${agents.length} agents · ${counts.domains} ${counts.domains === 1 ? 'domain' : 'domains'} · ${counts.projects} ${counts.projects === 1 ? 'project' : 'projects'} · ${counts.live} live${counts.needs ? html` · <span class="tone-amber-text">${counts.needs} need you</span>` : null}${agents.length && !orgError ? ` · ${mobile ? 'Tap' : 'Click'} an agent to see what it knows` : ''}</p>
        ${orgRep && orgRep.totals ? html`<p class="map-usage" data-testid="map-usage">Usage at list price, not a bill: today ${usdOrUnknown(orgRep.totals.today_usd, orgRep.totals.today_complete !== false)}, last 7 days ${usdOrUnknown(orgRep.totals.week_usd, orgRep.totals.week_complete ?? orgRep.totals.complete)}${orgRep.totals.complete ? '' : ' (+ means some usage has an unknown cost)'}. <span class="map-usage-note">Under each agent: its last 7 days, and when it last finished work.</span></p>` : null}
      </div>
      <ul class="legend" aria-label="Legend">
        <li><span class="legend-ring ring-working" aria-hidden="true"></span> Working</li>
        <li title="Claude Code asked something and waits for your answer"><span class="legend-ring ring-needs" aria-hidden="true"></span> Needs you</li>
        <li title="Claude finished and waits for your next message"><span class="legend-ring ring-ready" aria-hidden="true"></span> Your turn</li>
      </ul>
      <div class="zoom" role="group" aria-label="Zoom">
        <button class="icon-btn" aria-label="Zoom out" onClick=${() => zoomBy(1 / 1.25)}><span aria-hidden="true" class="zoom-glyph">−</span></button>
        <button class="btn btn-quiet btn-sm" onClick=${() => setView({ ...fit, auto: true })} aria-label="Fit the whole org">Fit</button>
        <button class="icon-btn" aria-label="Zoom in" onClick=${() => zoomBy(1.25)}><${Icon} name="plus" /></button>
      </div>
      <button class=${`btn btn-quiet layer-btn ${layer ? 'is-on' : ''}`} onClick=${toggleLayer} aria-pressed=${layer ? 'true' : 'false'}
        title="Show the Claude Code setup every session loads" data-testid="map-setup-toggle"><${Icon} name="layers" /> Claude Code setup</button>
      <button class="btn btn-quiet" onClick=${() => openOverlay({ type: 'wizard' })}><${Icon} name="user-plus" /> New agent</button>
    </header>
    <div class="map-body">
      <div class="map-canvas" ref=${wrap} onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp}
        onPointerCancel=${() => { drag.current = null; }}>
        ${box.w ? html`<svg class="map-svg" width=${box.w} height=${box.h} viewBox=${`${-box.w / 2} ${-box.h / 2} ${box.w} ${box.h}`}
            role="group" aria-label="Your org: you, Donna, domains and projects">
          <g class=${`map-world ${drag.current || view.auto === false ? '' : 'is-fitting'}`}
            style=${{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.k})` }}>
            <g class="orbits" aria-hidden="true">
              ${L.hasChief ? html`<circle class="orbit orbit-chief" r=${L.rings.R1} />` : null}
              ${L.rings.R2 ? html`<circle class="orbit" r=${L.rings.R2} />` : null}
              ${L.rings.R3 ? html`<circle class="orbit orbit-outer" r=${L.rings.R3} />` : null}
            </g>
            <g class="edges" aria-hidden="true">
              ${L.edges.map((e) => {
                const hot = related && related.has(e.to) && related.has(e.from);
                if (e.kind === 'core') {
                  return html`<line class=${`edge edge-core ${hot ? 'is-hot' : ''}`} x1="0" y1=${-R_OWNER} x2="0" y2=${-L.rings.R1 + R_CHIEF} />`;
                }
                if (e.kind === 'spoke') {
                  const [x1, y1] = polar(e.r0, e.angle);
                  const [x2, y2] = polar(e.r1, e.angle);
                  return html`<line class=${`edge ${hot ? 'is-hot' : ''}`} x1=${x1} y1=${y1} x2=${x2} y2=${y2} />`;
                }
                const [x0, y0] = polar(e.r0 + R_DOMAIN, e.a0);
                const mid = (e.r0 + e.r1) / 2;
                const [c1x, c1y] = polar(mid, e.a0);
                const [c2x, c2y] = polar(mid, e.a1);
                const [x3, y3] = polar(e.r1 - R_PROJECT, e.a1);
                return html`<path class=${`edge ${hot ? 'is-hot' : ''}`} d=${`M${x0} ${y0}C${c1x} ${c1y} ${c2x} ${c2y} ${x3} ${y3}`} />`;
              })}
            </g>
            ${chips.length ? html`<circle class="setup-halo" r=${HALO} aria-hidden="true" />` : null}
            <g class="nodes">
              ${L.nodes.map((n) => html`<${MapNode} key=${n.id} n=${n} st=${statsById[n.id]} rep=${repById[n.id]} now=${now} selected=${sel === n.id}
                dim=${related ? !related.has(n.id) : false} reduced=${reduced} adds=${n.kind === 'project' && (adds[n.id] || []).some(repoAdds)}
                onSelect=${() => setSel(sel === n.id ? null : n.id)} onHover=${(on) => setHover(on ? n.id : null)} />`)}
            </g>
            ${chips.length ? html`<g class="setup-layer" role="group" aria-label="Your Claude Code setup, loaded in every session" data-testid="setup-halo">
              ${chips.map((c) => html`<${SetupChip} key=${c.k} c=${c} selected=${setupSel === c.k}
                onSelect=${() => setSel(setupSel === c.k ? null : `__setup:${c.k}`)} />`)}
              <text class="setup-caption" x="0" y=${R_OWNER + 52} text-anchor="middle" dominant-baseline="hanging">Loaded in every session</text>
            </g>` : null}
          </g>
        </svg>` : null}
        ${layer && !sdata ? html`<p class="map-layer-note" role="status" data-testid="map-layer-note">${setup.err
          ? `Couldn't read your Claude Code setup: ${setup.err === 'unsupported' ? 'this Clawdling server is too old to show it' : setup.err}`
          : 'Reading your Claude Code setup…'}</p>` : null}
        ${orgError ? html`<div class="map-hint map-error"><${OrgError} /></div>`
          : agents.length <= 1 ? html`<div class="map-hint" ref=${hintRef}><p>Your org is just you and Donna so far.</p>
          <button class="btn btn-primary" onClick=${() => openOverlay({ type: 'wizard' })}><${Icon} name="user-plus" /> Add a domain or project</button>
          <button class="btn btn-quiet" onClick=${() => openOverlay({ type: 'import' })}><${Icon} name="import" /> Bring in your projects</button></div>`
          : importStep ? html`<div class="map-hint" ref=${hintRef} data-testid="map-import-hint"><p>No project agents yet. Bring in the projects you already work on.</p>
          <button class="btn btn-quiet" onClick=${() => openOverlay({ type: 'import' })} data-testid="map-import-go"><${Icon} name="import" /> Bring in your projects</button>
          <button class="icon-btn" onClick=${dismissImportCard} aria-label="Hide this" title="Hide this"><${Icon} name="x" size=${14} /></button></div>` : null}
      </div>
      ${setupSel && sdata ? html`<${SetupPanel} kind=${setupSel} data=${sdata} onClose=${() => setSel(null)} />`
        : selNode ? html`<${MapPanel} n=${selNode} rep=${repById[selNode.id]} sessions=${sessions} onClose=${() => setSel(null)} agents=${agents} ownerName=${ownerName}
          repoSetup=${layer ? (sdata ? adds[selNode.id] || [] : null) : undefined} setupBusy=${layer && setup.refreshing} />` : null}
    </div>
  </div>`;
}

function MapNode({ n, st, rep, now, selected, dim, reduced, adds, onSelect, onHover }) {
  const iconSize = n.kind === 'project' ? 14 : n.kind === 'owner' ? 18 : 16;
  const use = usageLine(rep, now);
  const label = n.kind === 'owner' ? `${n.label} (you)` : `${n.label}, ${n.kind === 'cluster' ? 'projects without a domain' : KIND_LABEL[n.kind]}${st.live ? `, ${st.live} live` : ''}${st.needs ? `, ${st.needs} need you` : ''}${use ? `, ${use.long}` : ''}${adds ? ', its repo adds its own Claude Code setup' : ''}`;
  // The usage line sits on the far side of the label from the node (below a label under it, above
  // one over it, under a label beside it).
  const below = n.base === 'hanging';
  const uy = n.ly - n.y + (n.kind === 'chief' ? -15 : below ? (n.sub && n.kind !== 'project' ? 31 : 15) : n.base === 'middle' ? 15 : 0);
  const ly = n.ly - n.y + (use && n.base === 'auto' && n.kind !== 'chief' ? -15 : 0);
  // Amber only when Claude asked something; green when it is your turn; blue while working.
  const tone = st.blocked ? 'needs' : st.turn ? 'ready' : st.working ? 'working' : 'idle';
  const count = tone === 'needs' || tone === 'ready' ? st.needs : st.live;
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } };
  return html`<g class=${`node kind-${n.kind} tone-${tone} ${selected ? 'is-selected' : ''} ${dim ? 'is-dim' : ''}`}
      transform=${`translate(${n.x} ${n.y})`} role="button" tabindex="0" aria-label=${label} aria-pressed=${selected ? 'true' : 'false'}
      data-node=${n.id} data-kind=${n.kind} onClick=${(e) => { e.stopPropagation(); onSelect(); }} onKeyDown=${onKey}
      onMouseEnter=${() => onHover(true)} onMouseLeave=${() => onHover(false)} onFocus=${() => onHover(true)} onBlur=${() => onHover(false)}>
    ${st.working && !reduced ? html`<circle class="pulse" r=${n.r + 2} />` : null}
    ${st.blocked ? html`<circle class="needs-ring" r=${n.r + 5} />` : st.turn ? html`<circle class="ready-ring" r=${n.r + 5} />` : null}
    <circle class="sel-ring" r=${n.r + (st.needs ? 9 : 5)} />
    ${n.text !== n.label ? html`<title>${n.label}</title>` : null}
    <circle class="node-disc" r=${n.r} />
    <g class="node-icon" transform=${`translate(${-iconSize / 2} ${-iconSize / 2})`}>
      ${n.kind === 'owner' ? html`<text class="owner-initial" x=${iconSize / 2} y=${iconSize / 2 + 1}>${(n.label || '?').charAt(0).toUpperCase()}</text>`
        : n.kind === 'cluster' ? html`<${Icon} name="folder" size=${iconSize} />`
        : hasIcon(n.agent && n.agent.icon) ? html`<${Icon} name=${n.agent.icon} size=${iconSize} />`
        : html`<text class="node-initial" x=${iconSize / 2} y=${iconSize / 2 + 1}>${(n.label || '?').charAt(0).toUpperCase()}</text>`}
    </g>
    ${count ? html`<g class=${`badge-g tone-${tone}`} transform=${`translate(${n.r * 0.74} ${-n.r * 0.74})`}>
      <rect x=${count > 9 ? -11 : -8} y="-8" width=${count > 9 ? 22 : 16} height="16" rx="8" />
      <text y="0.5">${count}</text></g>` : null}
    ${adds ? html`<g class="setup-badge" transform=${`translate(${-n.r * 0.74} ${n.r * 0.74})`} data-setup-badge="true">
      <title>Its repo adds its own Claude Code setup</title><circle r="6" /><circle class="setup-badge-dot" r="2.2" /></g>` : null}
    <text class="node-label" x=${n.lx - n.x} y=${ly} text-anchor=${n.anchor} dominant-baseline=${n.base}>${n.text}</text>
    ${use ? html`<text class="node-usage" x=${n.lx - n.x} y=${uy} text-anchor=${n.anchor} dominant-baseline=${n.base} data-usage=${n.id}>${use.short}</text>` : null}
    ${n.sub && n.kind !== 'project' ? html`<text class="node-sub" x=${n.lx - n.x} y=${n.ly - n.y + (n.kind === 'chief' ? 14 : 16)}
      text-anchor=${n.anchor} dominant-baseline=${n.base}>${n.sub}</text>` : null}
  </g>`;
}

/** An agent's line on the map: "$4.10 · 2h ago" (and a long form for screen readers), or null. */
export function usageLine(rep, now = Date.now()) {
  if (!rep) return null;
  const cost = rep.cost_usd > 0 ? (rep.cost_usd < 0.005 ? '<$0.01' : `$${rep.cost_usd.toFixed(2)}`) : !rep.cost_complete ? 'cost unknown' : null;
  const ago = rep.last_done_at ? relTime(rep.last_done_at, now) : null;
  const when = ago ? (ago === 'now' ? 'just now' : /^\d/.test(ago) ? `${ago} ago` : ago) : null;
  // The last check-up (1.6): its score on the node, its age and cost per run in the long form.
  const up = rep.checkup;
  const upScore = up ? (up.judge_unreliable ? 'judge unreliable' : up.score === null || up.score === undefined ? null : `${Math.round(up.score * 100)}%`) : null;
  const upShort = upScore ? `check-up ${upScore}` : null;
  const upAgo = up ? relTime(up.at, now) : null;
  const upLong = upScore ? `last check-up ${upScore}${upAgo ? `, ${upAgo === 'now' ? 'just now' : /^\d/.test(upAgo) ? `${upAgo} ago` : upAgo}` : ''}${Number.isFinite(up.cost_per_run) ? `, ${usd(up.cost_per_run)} a run` : ''}` : null;
  if (!cost && !when) return { short: ['nothing done in 7 days', upShort].filter(Boolean).join(' · '), long: ['nothing done in the last 7 days', upLong].filter(Boolean).join(', ') };
  return {
    short: [cost ? `${cost}${rep.cost_complete || cost === 'cost unknown' ? '' : '+'}` : null, when, upShort].filter(Boolean).join(' · '),
    long: [cost === 'cost unknown' ? 'usage with an unknown cost in 7 days' : cost ? `${usd(rep.cost_usd)} of usage in 7 days at list price${rep.cost_complete ? '' : ', plus some with an unknown cost'}` : null, when ? `last finished work ${when}` : null, upLong].filter(Boolean).join(', '),
  };
}

// One chip of the setup layer: "Skills 9". Click (or Enter) opens that list in the side panel.
function SetupChip({ c, selected, onSelect }) {
  const k = kindOf(c.k);
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } };
  return html`<g class=${`setup-chip ${selected ? 'is-selected' : ''}`} transform=${`translate(${c.x} ${c.y})`} role="button" tabindex="0"
      aria-pressed=${selected ? 'true' : 'false'} aria-label=${`${plural(c.n, k.one)}, loaded in every session. Show the list`} data-chip=${c.k}
      onClick=${(e) => { e.stopPropagation(); onSelect(); }} onKeyDown=${onKey}>
    <rect x=${-c.w / 2} y=${-CHIP_H / 2} width=${c.w} height=${CHIP_H} rx=${CHIP_H / 2} />
    <text class="setup-chip-text" text-anchor="middle" dominant-baseline="central" y="0.5">${c.label} <tspan class="setup-chip-n">${c.n}</tspan></text>
  </g>`;
}

function usePanelEscape(onClose) {
  useLayoutEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function SetupPanel({ kind, data, onClose }) {
  usePanelEscape(onClose);
  const k = kindOf(kind);
  return html`<aside class="map-panel" aria-label=${`${k.title} in your Claude Code setup`} data-testid="map-panel" data-setup-panel=${kind}>
    <header class="panel-head">
      <span class="panel-icon"><${Icon} name="layers" /></span>
      <div class="panel-titles">
        <h2 class="panel-title">${k.title}</h2>
        <p class="panel-kind">Loaded in every session</p>
      </div>
      <button class="icon-btn" onClick=${onClose} aria-label="Close panel"><${Icon} name="x" /></button>
    </header>
    <div class="panel-body"><${SetupKindPanelBody} kind=${kind} data=${data} /></div>
  </aside>`;
}

function MapPanel({ n, rep, sessions, onClose, agents, ownerName, repoSetup, setupBusy }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  const now = useStore((s) => s.now);
  const agentsById = useStore((s) => s.agentsById);
  const blocked = useStartBlocked();
  const isAgent = n.kind !== 'owner' && n.kind !== 'cluster';
  const panel = useRef(null);

  useEffect(() => {
    setDetail(null);
    setErr('');
    if (!isAgent) return;
    let live = true;
    api.agent(n.id).then((d) => { if (live) setDetail(d); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [n.id]);

  usePanelEscape(onClose);

  const mine = sessions.filter((s) => s.agent === n.id && s.status !== 'ended');
  const a = n.agent;
  const linked = !!(a && (a.repo || (Array.isArray(a.repos) && a.repos.length)));
  const nowMd = detail && typeof detail.now_md === 'string' ? detail.now_md : null;

  let body;
  if (n.kind === 'owner') {
    const g = { chief: agents.filter((x) => x.kind === 'chief').length, d: agents.filter((x) => x.kind === 'domain').length, p: agents.filter((x) => x.kind === 'project').length };
    body = html`<p class="panel-text">This is you. Donna sits on the ring around you: message her on Telegram or iMessage and she hands the work to the right agent.</p>
      <dl class="panel-facts"><div><dt>Domains</dt><dd>${g.d}</dd></div><div><dt>Projects</dt><dd>${g.p}</dd></div><div><dt>Live sessions</dt><dd>${sessions.filter((s) => s.status !== 'ended').length}</dd></div></dl>
      <div class="panel-actions"><button class="btn btn-quiet" onClick=${() => navigate('#/donna')}><${Icon} name="chat" /> Set up Donna</button></div>`;
  } else if (n.kind === 'cluster') {
    const kids = agents.filter((x) => x.kind === 'project' && (!x.domain || !agentsById[x.domain]));
    body = html`<p class="panel-text">Projects that are not attached to a domain. Give one a parent domain from its agent page.</p>
      <ul class="panel-list">${kids.map((k) => html`<li><button class="panel-row" onClick=${() => navigate(`#/agent/${encodeURIComponent(k.id)}`)}>
        <span class="pr-icon"><${AgentIcon} agent=${k} size=${14} /></span><span class="pr-title">${k.name}</span><${Icon} name="chevron-right" size=${14} /></button></li>`)}</ul>`;
  } else {
    body = html`
      ${a && a.mission ? html`<p class="panel-mission">${a.mission}</p>` : null}
      ${rep ? html`<dl class="panel-facts" data-testid="panel-usage"><div><dt>Done, 7 days</dt><dd>${rep.done}</dd></div>
        <div><dt>Usage, 7 days</dt><dd title="List-price equivalent, not a bill">${!rep.cost_complete && !(rep.cost_usd > 0) ? 'Unknown' : `${rep.cost_usd > 0 && rep.cost_usd < 0.005 ? '<$0.01' : `$${rep.cost_usd.toFixed(2)}`}${rep.cost_complete ? '' : '+'}`}</dd></div>
        <div><dt>Last done</dt><dd>${rep.last_done_at ? relTime(rep.last_done_at, now) : '–'}</dd></div>
        <div data-testid="panel-checkup"><dt>Last check-up</dt><dd>${rep.checkup ? `${rep.checkup.judge_unreliable ? 'judge unreliable' : rep.checkup.score === null || rep.checkup.score === undefined ? 'no score' : `${Math.round(rep.checkup.score * 100)}%`} · ${relTime(rep.checkup.at, now)}${Number.isFinite(rep.checkup.cost_per_run) ? ` · ${rep.checkup.cost_per_run < 0.005 ? '<$0.01' : `$${rep.checkup.cost_per_run.toFixed(2)}`} a run` : ''}` : '–'}</dd></div></dl>
        <p class="panel-quiet panel-usage-note">Usage is a list-price equivalent, not a bill. On Pro and Max it is included in your plan.</p>` : null}
      <div class="panel-actions">
        <button class="btn btn-quiet" onClick=${() => startSession(n.id).catch(() => {})} data-testid="panel-new-session"
          disabled=${blocked} title=${blocked ? BLOCKED_TITLE : undefined}><${Icon} name="plus" /> New session</button>
        <button class="btn btn-quiet" onClick=${() => navigate(`#/agent/${encodeURIComponent(n.id)}`)} data-testid="panel-open-agent">Open report card</button>
      </div>
      ${n.kind === 'project' && repoSetup !== undefined ? html`<section class="panel-adds" data-testid="panel-repo-adds">
        <h3 class="panel-h">Its repo adds <span class="panel-h-sub">on top of your own setup</span></h3>
        ${repoSetup === null || (!repoSetup.length && linked && setupBusy) ? html`<div class="panel-skel" aria-label="Loading"></div>`
          : !repoSetup.length ? html`<p class="panel-quiet">${linked ? 'Nothing beyond your own setup.' : 'No repo linked, so nothing extra.'}</p>`
          : repoSetup.map((p) => html`<div class="panel-adds-repo">
            ${repoSetup.length > 1 ? html`<p class="panel-adds-path mono">${tildify(p.path)}</p>` : null}
            <${RepoAdds} p=${p} /></div>`)}
      </section>` : null}
      <h3 class="panel-h">Live sessions <span class="sec-count">${mine.length}</span></h3>
      ${mine.length ? html`<ul class="panel-list">${mine.map((s) => html`<li><button class="panel-row" onClick=${() => focusSession(s.sid)}>
          <${StatusGlyph} status=${s.status} label=${false} /><span class="pr-title">${sessionName(s, agentsById)}</span>
          <span class="pr-meta" title=${statusText(s)}>${STATUS_LABEL[s.status] || s.status} · ${relTime(s.last_activity_at || s.created_at, now)}</span></button></li>`)}</ul>`
        : html`<p class="panel-quiet">No live sessions.</p>`}
      <h3 class="panel-h">NOW.md <span class="panel-h-sub">what ${a ? a.name : 'it'} knows right now</span></h3>
      ${err ? html`<p class="panel-quiet">Could not load memory: ${err}</p>`
        : nowMd == null ? html`<div class="panel-skel" aria-label="Loading"></div>`
        : nowMd.trim() ? html`<pre class="panel-now">${nowMd.split('\n').slice(0, 18).join('\n')}${nowMd.split('\n').length > 18 ? '\n…' : ''}</pre>`
        : html`<p class="panel-quiet">Empty. The agent writes here before it finishes a piece of work.</p>`}`;
  }

  return html`<aside class="map-panel" ref=${panel} aria-label=${`${n.label} details`} data-testid="map-panel">
    <header class="panel-head">
      <span class="panel-icon" style=${a && a.color ? { '--agent': a.color } : undefined}>
        ${n.kind === 'owner' ? html`<${Icon} name="user" />` : n.kind === 'cluster' ? html`<${Icon} name="folder" />` : html`<${AgentIcon} agent=${a} size=${16} />`}
      </span>
      <div class="panel-titles">
        <h2 class="panel-title">${n.kind === 'owner' ? ownerName : n.label}</h2>
        <p class="panel-kind">${n.kind === 'owner' ? 'You' : n.kind === 'cluster' ? 'Unattached projects' : KIND_LABEL[n.kind]}</p>
      </div>
      <button class="icon-btn" onClick=${onClose} aria-label="Close panel"><${Icon} name="x" /></button>
    </header>
    <div class="panel-body">${body}</div>
  </aside>`;
}
