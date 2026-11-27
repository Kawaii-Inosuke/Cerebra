// Canvas graph renderer: d3-force physics (ISC licence), our own drawing and interaction.
// Hover a node to light it and its neighbours, drag nodes, wheel to zoom, drag the background
// to pan, click to select, double-click a node to open it, double-click empty space to re-fit.
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { NodeKind } from "../api";

export interface GNode extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: NodeKind;
  color: string;
  noteId: string | null;
  degree: number;
  dim: boolean;
  r: number;
  /** Current and target opacity (for smooth fades). */
  alpha: number;
  target: number;
}

export interface GLink extends SimulationLinkDatum<GNode> {
  weight: number;
  ai: boolean;
  /** AI connection type (`explains`, …, or `concept`) and status. */
  aiType?: string;
  aiStatus?: string;
}

export interface GraphTheme {
  edge: string;
  edgeActive: string;
  ai: string;
  /** Text on top of the accent colour. */
  aiText: string;
  label: string;
  halo: string;
  ring: string;
  hollow: string;
}

export type NodeInput = Pick<GNode, "id" | "label" | "kind" | "color" | "noteId" | "degree" | "dim">;
export interface LinkInput {
  source: string;
  target: string;
  weight: number;
  ai: boolean;
  aiType?: string;
  aiStatus?: string;
}

/** An AI line someone clicked: its two ends (node ids), kind and status. */
export interface EdgeInput {
  source: string;
  target: string;
  type: string;
  status: string;
}

export function edgeKey(e: EdgeInput): string {
  return `${e.source}|${e.target}|${e.type}`;
}

export interface EngineOptions {
  onSelect?: (node: NodeInput | null) => void;
  /** An AI line was clicked (`null` when the selection is cleared by clicking empty space). */
  onSelectEdge?: (edge: EdgeInput | null) => void;
  onOpen?: (node: NodeInput) => void;
  reducedMotion?: boolean;
  /** Text shown when hovering an AI edge. */
  edgeLabel?: (type: string, status: string) => string;
  /** Smaller nodes and labels (local graph in the side panel). */
  compact?: boolean;
}

export class GraphEngine {
  private ctx: CanvasRenderingContext2D;
  private nodes: GNode[] = [];
  private links: GLink[] = [];
  private byId = new Map<string, GNode>();
  private neighbours = new Map<string, Set<string>>();
  private sim: Simulation<GNode, GLink>;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private hovered: string | null = null;
  private hoveredEdge: GLink | null = null;
  private selectedEdge: string | null = null;
  /** Fingerprint of the current dots and lines, to skip no-op refreshes. */
  private shapeKey = "";
  /** Where relationship labels were drawn last frame (screen pixels), so they can be clicked. */
  private labelHits: { box: Rect; link: GLink }[] = [];
  private selected: string | null = null;
  private focus: string | null = null;
  private highlight: Set<string> | null = null;
  private pointer: { node: GNode | null; x: number; y: number; moved: boolean; px: number; py: number } | null = null;
  private raf = 0;
  private userMoved = false;
  private fitted = false;
  private resizeObs: ResizeObserver | null = null;
  private theme: GraphTheme;

  constructor(
    private canvas: HTMLCanvasElement,
    theme: GraphTheme,
    private opts: EngineOptions = {},
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not available");
    this.ctx = ctx;
    this.theme = theme;
    this.sim = forceSimulation<GNode, GLink>([])
      .alphaDecay(0.035)
      // Heavy damping: the graph glides into place instead of bouncing around.
      .velocityDecay(0.6)
      .on("tick", () => this.schedule());
    this.setupForces();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(canvas);
    }
    this.resize();
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointerleave", this.leave);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("dblclick", this.dbl);
  }

  destroy() {
    this.sim.stop();
    this.resizeObs?.disconnect();
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("pointerdown", this.down);
    this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up);
    this.canvas.removeEventListener("pointerleave", this.leave);
    this.canvas.removeEventListener("wheel", this.wheel);
    this.canvas.removeEventListener("dblclick", this.dbl);
  }

  setTheme(theme: GraphTheme) {
    this.theme = theme;
    this.schedule();
  }

  /** Replace the data; nodes that were already there keep their position. */
  setData(nodes: NodeInput[], links: LinkInput[], focus: string | null) {
    const previous = this.byId;
    // Same dots and lines as now (a refresh after a save, a library event…): update in place, don't move anything.
    const shape = (ns: { id: string }[], ls: { source: unknown; target: unknown; ai: boolean; aiType?: string; aiStatus?: string }[]) =>
      `${ns.map((n) => n.id).sort().join(",")}#${ls
        .map((l) => `${typeof l.source === "object" ? (l.source as GNode).id : l.source}>${typeof l.target === "object" ? (l.target as GNode).id : l.target}:${l.ai ? `${l.aiType}/${l.aiStatus}` : ""}`)
        .sort()
        .join(",")}`;
    const sameShape = previous.size > 0 && shape(nodes, links) === this.shapeKey;
    this.shapeKey = shape(nodes, links);
    if (sameShape) {
      for (const n of nodes) {
        const g = previous.get(n.id);
        if (g) Object.assign(g, { label: n.label, color: n.color, dim: n.dim, degree: n.degree, noteId: n.noteId });
      }
      this.focus = focus;
      this.schedule();
      return;
    }
    this.focus = focus;
    const spread = 30 + Math.sqrt(nodes.length) * 14;
    this.nodes = nodes.map((n, i) => {
      const p = previous.get(n.id);
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      // A new dot starts next to a dot it links to, so it slides in instead of crossing the screen.
      const near = p ? null : links.map((l) => (l.source === n.id ? l.target : l.target === n.id ? l.source : null)).map((id) => (id ? previous.get(id) : undefined)).find((g) => g?.x !== undefined);
      return {
        ...n,
        x: p?.x ?? (near ? near.x! + (Math.random() - 0.5) * 30 : Math.cos(a) * spread + (Math.random() - 0.5) * 6),
        y: p?.y ?? (near ? near.y! + (Math.random() - 0.5) * 30 : Math.sin(a) * spread + (Math.random() - 0.5) * 6),
        vx: p?.vx ?? 0,
        vy: p?.vy ?? 0,
        r: 0,
        alpha: p?.alpha ?? 0,
        target: 1,
      };
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.neighbours = new Map(this.nodes.map((n) => [n.id, new Set<string>()]));
    const seen = new Set<string>();
    this.links = [];
    for (const l of links) {
      if (l.source === l.target || !this.byId.has(l.source) || !this.byId.has(l.target)) continue;
      const pair = l.source < l.target ? `${l.source}|${l.target}` : `${l.target}|${l.source}`;
      const key = l.ai ? `ai|${pair}` : pair;
      if (seen.has(key)) continue;
      seen.add(key);
      this.links.push({ ...l });
      this.neighbours.get(l.source)!.add(l.target);
      this.neighbours.get(l.target)!.add(l.source);
    }
    if (this.selected && !this.byId.has(this.selected)) this.selected = null;
    const scale = this.opts.compact ? 0.8 : 1;
    for (const n of this.nodes) {
      const base = n.kind === "note" ? 3.4 + Math.sqrt(n.degree) * 1.7 : n.kind === "concept" ? 4.5 + Math.sqrt(n.degree) * 1.2 : 2.6 + Math.sqrt(n.degree) * 0.9;
      n.r = (n.dim ? base * 0.75 : base) * scale;
    }
    this.sim.nodes(this.nodes);
    this.setupForces();
    // Re-fit only on a first draw; after that, keep the person's view where they left it.
    if (!previous.size) {
      this.fitted = false;
      this.userMoved = false;
    }
    if (this.opts.reducedMotion) {
      // No animation: settle the layout up front and draw once.
      this.sim.stop();
      this.sim.alpha(1);
      for (let i = 0; i < 300; i++) this.sim.tick();
      for (const n of this.nodes) n.alpha = n.target;
      this.fit();
      this.fitted = true;
    } else {
      // A refresh only nudges the layout; a first draw settles it from scratch.
      this.sim.alpha(previous.size ? 0.12 : 1).restart();
    }
    this.schedule();
  }

  /** Highlight nodes whose label contains `query` (empty = none). */
  setSearch(query: string) {
    const q = query.trim().toLowerCase();
    this.highlight = q ? new Set(this.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id)) : null;
    this.schedule();
  }

  get searchCount(): number {
    return this.highlight?.size ?? 0;
  }

  /** Mark an AI line as selected (by `edgeKey`), or none. */
  setSelectedEdge(key: string | null) {
    this.selectedEdge = key;
    this.schedule();
  }

  setSelected(id: string | null) {
    this.selected = id;
    this.schedule();
  }

  fit() {
    if (!this.nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x! - n.r);
      x1 = Math.max(x1, n.x! + n.r);
      y0 = Math.min(y0, n.y! - n.r);
      y1 = Math.max(y1, n.y! + n.r);
    }
    const pad = this.opts.compact ? 24 : 72;
    const k = Math.min((this.width - pad * 2) / Math.max(1, x1 - x0), (this.height - pad * 2) / Math.max(1, y1 - y0), 2.2);
    this.zoom = Math.max(0.05, k);
    this.panX = -((x0 + x1) / 2) * this.zoom;
    this.panY = -((y0 + y1) / 2) * this.zoom;
    this.schedule();
  }

  zoomBy(factor: number) {
    this.zoom = Math.min(10, Math.max(0.04, this.zoom * factor));
    this.panX *= factor;
    this.panY *= factor;
    this.userMoved = true;
    this.schedule();
  }

  private setupForces() {
    const compact = this.opts.compact;
    this.sim
      .force(
        "link",
        forceLink<GNode, GLink>(this.links)
          .id((n) => n.id)
          .distance(compact ? 38 : 54)
          .strength(0.5),
      )
      .force("charge", forceManyBody<GNode>().strength(compact ? -90 : -150).distanceMax(800).theta(0.9))
      .force("x", forceX<GNode>(0).strength(0.06))
      .force("y", forceY<GNode>(0).strength(0.06))
      .force("collide", forceCollide<GNode>((n) => n.r + 3));
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    if (!this.userMoved && this.fitted) this.fit();
    this.schedule();
  }

  private schedule() {
    if (!this.raf)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.draw();
      });
  }

  private world(cx: number, cy: number) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (cx - rect.left - this.width / 2 - this.panX) / this.zoom,
      y: (cy - rect.top - this.height / 2 - this.panY) / this.zoom,
    };
  }

  private hit(cx: number, cy: number): GNode | null {
    const p = this.world(cx, cy);
    let best: GNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x! - p.x, n.y! - p.y);
      if (d < n.r + 6 / this.zoom && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private publicNode(n: GNode): NodeInput {
    return { id: n.id, label: n.label, kind: n.kind, color: n.color, noteId: n.noteId, degree: n.degree, dim: n.dim };
  }

  private down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    const node = this.hit(e.clientX, e.clientY);
    this.pointer = { node, x: e.clientX, y: e.clientY, moved: false, px: this.panX, py: this.panY };
    if (node && !this.opts.reducedMotion) {
      node.fx = node.x;
      node.fy = node.y;
      this.sim.alphaTarget(0.2).restart();
    }
  };

  private move = (e: PointerEvent) => {
    const p = this.pointer;
    if (p) {
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      if (Math.hypot(dx, dy) > 3) p.moved = true;
      if (p.node && p.moved) {
        const w = this.world(e.clientX, e.clientY);
        if (this.opts.reducedMotion) {
          p.node.x = w.x;
          p.node.y = w.y;
        } else {
          p.node.fx = w.x;
          p.node.fy = w.y;
        }
      } else if (!p.node && p.moved) {
        this.panX = p.px + dx;
        this.panY = p.py + dy;
        this.userMoved = true;
        this.canvas.style.cursor = "grabbing";
      }
      this.schedule();
      return;
    }
    const n = this.hit(e.clientX, e.clientY);
    const id = n?.id ?? null;
    const edge = n ? null : this.edgeAt(e.clientX, e.clientY);
    if (id !== this.hovered || edge !== this.hoveredEdge) {
      this.hovered = id;
      this.hoveredEdge = edge;
      this.canvas.style.cursor = n ? "pointer" : edge ? "help" : "grab";
      this.schedule();
    }
  };

  private publicEdge(l: GLink): EdgeInput {
    return { source: (l.source as GNode).id, target: (l.target as GNode).id, type: l.aiType ?? "", status: l.aiStatus ?? "" };
  }

  /** The AI edge under the pointer (within a few pixels), if any. */
  private edgeAt(cx: number, cy: number): GLink | null {
    // The label pill counts as part of the line.
    const rect = this.canvas.getBoundingClientRect();
    const sx = cx - rect.left;
    const sy = cy - rect.top;
    for (let i = this.labelHits.length - 1; i >= 0; i--) {
      const h = this.labelHits[i]!;
      if (sx >= h.box.x && sx <= h.box.x + h.box.w && sy >= h.box.y && sy <= h.box.y + h.box.h) return h.link;
    }
    const p = this.world(cx, cy);
    const tol = 9 / this.zoom;
    let best: GLink | null = null;
    let bestD = tol;
    for (const l of this.links) {
      if (!l.ai) continue;
      const a = l.source as GNode;
      const b = l.target as GNode;
      const dx = b.x! - a.x!;
      const dy = b.y! - a.y!;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x!) * dx + (p.y - a.y!) * dy) / len2));
      const d = Math.hypot(p.x - (a.x! + t * dx), p.y - (a.y! + t * dy));
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  }

  private up = (e: PointerEvent) => {
    const p = this.pointer;
    this.pointer = null;
    if (!p) return;
    if (p.node) {
      p.node.fx = null;
      p.node.fy = null;
      this.sim.alphaTarget(0);
    }
    if (!p.moved) {
      const edge = p.node ? null : this.edgeAt(e.clientX, e.clientY);
      this.selected = p.node?.id ?? null;
      this.selectedEdge = edge ? edgeKey(this.publicEdge(edge)) : null;
      this.opts.onSelect?.(p.node ? this.publicNode(p.node) : null);
      if (edge) this.opts.onSelectEdge?.(this.publicEdge(edge));
      else if (!p.node) this.opts.onSelectEdge?.(null);
    }
    this.move(e);
    this.schedule();
  };

  private leave = () => {
    if (!this.pointer && (this.hovered || this.hoveredEdge)) {
      this.hovered = null;
      this.hoveredEdge = null;
      this.schedule();
    }
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - this.width / 2;
    const my = e.clientY - rect.top - this.height / 2;
    const k = Math.min(10, Math.max(0.04, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    this.panX = mx - ((mx - this.panX) * k) / this.zoom;
    this.panY = my - ((my - this.panY) * k) / this.zoom;
    this.zoom = k;
    this.userMoved = true;
    this.schedule();
  };

  private dbl = (e: MouseEvent) => {
    const n = this.hit(e.clientX, e.clientY);
    if (n) {
      this.opts.onOpen?.(this.publicNode(n));
      return;
    }
    this.userMoved = false;
    this.fit();
  };

  private draw() {
    const { ctx, zoom: k, theme } = this;
    if (!this.fitted && !this.userMoved && this.nodes.length && this.sim.alpha() < 0.5) {
      this.fit();
      this.fitted = true;
    }
    const lit: Set<string> | null = this.hovered
      ? new Set([this.hovered, ...(this.neighbours.get(this.hovered) ?? [])])
      : this.highlight;
    let animating = false;
    for (const n of this.nodes) {
      n.target = lit ? (lit.has(n.id) ? 1 : 0.14) : n.dim ? 0.4 : 1;
      if (this.opts.reducedMotion) n.alpha = n.target;
      else if (Math.abs(n.alpha - n.target) > 0.01) {
        n.alpha += (n.target - n.alpha) * 0.22;
        animating = true;
      } else n.alpha = n.target;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * (this.width / 2 + this.panX), this.dpr * (this.height / 2 + this.panY));

    // Edges
    const lw = 1 / Math.sqrt(k);
    for (const l of this.links) {
      const s = l.source as GNode;
      const t = l.target as GNode;
      const touching = this.hovered !== null && (s.id === this.hovered || t.id === this.hovered);
      ctx.globalAlpha = lit ? (touching || (!this.hovered && lit.has(s.id) && lit.has(t.id)) ? 0.95 : 0.06) : Math.min(s.alpha, t.alpha) * 0.9;
      const edgeOn = l === this.hoveredEdge;
      ctx.strokeStyle = l.ai ? theme.ai : touching ? theme.edgeActive : theme.edge;
      ctx.lineWidth = touching || edgeOn ? lw * 1.8 : l.ai ? lw * (l.aiType === "concept" ? 1 : 1.4) : lw * Math.min(2, 0.8 + l.weight * 0.2);
      if (l.ai && l.aiType === "concept" && !lit) ctx.globalAlpha *= 0.55;
      // Suggested AI connections are dashed; kept ones solid.
      if (l.ai && l.aiStatus !== "kept") ctx.setLineDash([4 / k, 3 / k]);
      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(t.x!, t.y!);
      ctx.stroke();
      if (l.ai) ctx.setLineDash([]);
      // Arrowhead: AI connections have a direction ("Osmosis → example of → Diffusion").
      if (l.ai && l.aiType !== "concept") {
        const dx = t.x! - s.x!;
        const dy = t.y! - s.y!;
        const len = Math.hypot(dx, dy);
        const size = (edgeOn || this.selectedEdge === edgeKey(this.publicEdge(l)) ? 9 : 7) / k;
        if (len > t.r + size * 2) {
          const ux = dx / len;
          const uy = dy / len;
          const tipX = t.x! - ux * (t.r + 1.5 / k);
          const tipY = t.y! - uy * (t.r + 1.5 / k);
          ctx.fillStyle = theme.ai;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55);
          ctx.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // Nodes
    for (const n of this.nodes) {
      ctx.globalAlpha = n.alpha;
      const special = n.id === this.hovered || n.id === this.selected || n.id === this.focus;
      if (special) {
        ctx.fillStyle = n.color;
        ctx.globalAlpha = n.alpha * 0.22;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r + 6 / k, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = n.alpha;
      }
      ctx.beginPath();
      if (n.kind === "tag") {
        const s = n.r * 0.9;
        ctx.roundRect?.(n.x! - s, n.y! - s, s * 2, s * 2, s * 0.4);
        if (!ctx.roundRect) ctx.rect(n.x! - s, n.y! - s, s * 2, s * 2);
      } else {
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      }
      if (n.kind === "concept") {
        ctx.fillStyle = theme.halo;
        ctx.fill();
        ctx.lineWidth = 2.2 / k;
        ctx.strokeStyle = theme.ai;
        ctx.stroke();
      } else if (n.kind === "unresolved") {
        ctx.fillStyle = theme.halo;
        ctx.fill();
        ctx.lineWidth = 1.3 / k;
        ctx.setLineDash([2 / k, 2 / k]);
        ctx.strokeStyle = theme.hollow;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = n.color;
        ctx.fill();
      }
      if (n.id === this.selected || n.id === this.focus) {
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = theme.ring;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r + 2.5 / k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Labels in screen space (crisp at any zoom); they fade in as nodes grow on screen.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const fs = this.opts.compact ? 11 : 12;
    ctx.font = `500 ${fs}px Inter, ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const threshold = this.opts.compact ? 3 : 6;
    const taken: Rect[] = [];
    for (const n of this.nodes) {
      if (lit && !lit.has(n.id)) continue;
      const sr = n.r * k;
      const forced = n.id === this.hovered || n.id === this.selected || n.id === this.focus || (lit !== null && lit.has(n.id));
      let a = forced ? 1 : Math.max(0, Math.min(1, (sr - threshold * 0.6) / (threshold * 0.5)));
      a *= n.alpha;
      if (a < 0.05) continue;
      const sx = this.width / 2 + this.panX + n.x! * k;
      const sy = this.height / 2 + this.panY + n.y! * k + sr + 4;
      if (sx < -120 || sx > this.width + 120 || sy < -20 || sy > this.height + 20) continue;
      const text = n.label.length > 36 ? `${n.label.slice(0, 35)}…` : n.label;
      if (a > 0.5) {
        const tw = ctx.measureText(text).width;
        taken.push({ x: sx - tw / 2, y: sy, w: tw, h: fs + 2 });
        taken.push({ x: sx - sr, y: sy - sr * 2 - 4, w: sr * 2, h: sr * 2 }); // the dot itself
      }
      ctx.globalAlpha = a;
      ctx.lineWidth = 3.5;
      ctx.lineJoin = "round";
      ctx.strokeStyle = theme.halo;
      ctx.strokeText(text, sx, sy);
      ctx.fillStyle = theme.label;
      ctx.fillText(text, sx, sy);
    }
    this.drawEdgeLabels(lit, taken);
    ctx.globalAlpha = 1;
    if (animating) this.schedule();
  }

  /**
   * Relationship labels on AI lines ("explains", "builds on"…): on every line with room for one, always on the
   * hovered or selected line, and on all lines touching the hovered or selected note.
   */
  private drawEdgeLabels(lit: Set<string> | null, taken: Rect[]) {
    const { ctx, zoom: k, theme } = this;
    const active = this.hovered ?? this.selected;
    const edgeBoxes: Rect[] = [];
    this.labelHits = [];
    ctx.font = "500 11.5px Inter, ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // The line pointed at goes last, so its label is drawn on top.
    const isStrong = (l: GLink) => l === this.hoveredEdge || edgeKey(this.publicEdge(l)) === this.selectedEdge;
    const order = this.links.filter((l) => l.ai).sort((x, y) => Number(isStrong(x)) - Number(isStrong(y)));
    for (const l of order) {
      const a = l.source as GNode;
      const b = l.target as GNode;
      const key = edgeKey(this.publicEdge(l));
      const strong = l === this.hoveredEdge || key === this.selectedEdge;
      const touching = active !== null && (a.id === active || b.id === active);
      // Lines to a concept only say "about": shown when pointed at, otherwise just noise.
      if (!strong && l.aiType === "concept") continue;
      if (!strong && lit && !(lit.has(a.id) && lit.has(b.id))) continue;
      const text = this.opts.edgeLabel ? this.opts.edgeLabel(l.aiType ?? "", l.aiStatus ?? "") : (l.aiType ?? "");
      if (!text) continue;
      const ax = this.width / 2 + this.panX + a.x! * k;
      const ay = this.height / 2 + this.panY + a.y! * k;
      const bx = this.width / 2 + this.panX + b.x! * k;
      const by = this.height / 2 + this.panY + b.y! * k;
      const w = ctx.measureText(text).width + 14;
      // Shown wherever there's room between the two dots; around the note pointed at, even on short lines.
      const roomy = Math.hypot(bx - ax, by - ay) >= w + (a.r + b.r) * k + 8;
      if (!strong && !touching && !roomy) continue;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      if (mx < -w || mx > this.width + w || my < -20 || my > this.height + 20) continue;
      // Never cover a note's name or another label (the one pointed at always shows).
      const box = { x: mx - w / 2 - 2, y: my - 12, w: w + 4, h: 24 };
      // Around the note pointed at, labels may cover names, but never each other.
      const blockers = touching ? edgeBoxes : [...taken, ...edgeBoxes];
      if (!strong && blockers.some((r) => overlaps(r, box))) continue;
      edgeBoxes.push(box);
      this.labelHits.push({ box, link: l });
      ctx.globalAlpha = strong ? 1 : Math.min(a.alpha, b.alpha);
      ctx.beginPath();
      ctx.roundRect?.(mx - w / 2, my - 10, w, 20, 10);
      if (!ctx.roundRect) ctx.rect(mx - w / 2, my - 10, w, 20);
      ctx.fillStyle = strong ? theme.ai : theme.halo;
      ctx.fill();
      if (!strong) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = theme.ai;
        ctx.stroke();
      }
      ctx.fillStyle = strong ? theme.aiText : theme.ai;
      ctx.fillText(text, mx, my + 0.5);
    }
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
