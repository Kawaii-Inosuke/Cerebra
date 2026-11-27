import { useEffect, useRef } from "react";
import type { GraphData } from "../api";
import { usePrefs } from "../context";
import { typeLabel } from "../lib/ai";
import { colorIndex, readPalette } from "../lib/colors";
import { GraphEngine, type EdgeInput, type GraphTheme, type NodeInput } from "./graphEngine";

function readTheme(): GraphTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    edge: dark ? "rgba(161,161,170,0.28)" : "rgba(87,83,78,0.26)",
    edgeActive: dark ? "rgba(237,237,239,0.7)" : "rgba(28,25,23,0.6)",
    ai: v("--accent", "#7c3aed"),
    aiText: v("--accent-fg", "#ffffff"),
    label: v("--fg", "#1c1917"),
    halo: v("--bg", "#fafaf9"),
    ring: v("--accent", "#7c3aed"),
    hollow: v("--muted", "#78716c"),
  };
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function GraphCanvas({
  data,
  ordered,
  focus = null,
  search = "",
  selected = null,
  compact = false,
  onSelect,
  onSelectEdge,
  selectedEdge = null,
  onOpen,
  label,
  engineRef,
  showAi = true,
}: {
  data: GraphData | null;
  ordered: string[];
  focus?: string | null;
  search?: string;
  selected?: string | null;
  compact?: boolean;
  onSelect?: (n: NodeInput | null) => void;
  /** A violet AI line was clicked (`null` = cleared). */
  onSelectEdge?: (e: EdgeInput | null) => void;
  /** `edgeKey` of the selected AI line. */
  selectedEdge?: string | null;
  onOpen?: (n: NodeInput) => void;
  label: string;
  engineRef?: React.MutableRefObject<GraphEngine | null>;
  showAi?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<GraphEngine | null>(null);
  const handlers = useRef({ onSelect, onOpen, onSelectEdge });
  handlers.current = { onSelect, onOpen, onSelectEdge };
  const { resolved } = usePrefs();

  useEffect(() => {
    if (!canvas.current) return;
    let e: GraphEngine;
    try {
      e = new GraphEngine(canvas.current, readTheme(), {
        compact,
        reducedMotion: prefersReducedMotion(),
        onSelect: (n) => handlers.current.onSelect?.(n),
        onOpen: (n) => handlers.current.onOpen?.(n),
        onSelectEdge: (edge) => handlers.current.onSelectEdge?.(edge),
        // Suggested lines are already dashed, so the label is just the relationship.
        edgeLabel: (type) => (type === "concept" ? "about" : typeLabel(type)),
      });
    } catch {
      return; // no canvas (tests)
    }
    engine.current = e;
    if (engineRef) engineRef.current = e;
    return () => {
      e.destroy();
      engine.current = null;
      if (engineRef) engineRef.current = null;
    };
  }, [compact, engineRef]);

  useEffect(() => {
    engine.current?.setTheme(readTheme());
  }, [resolved]);

  useEffect(() => {
    const e = engine.current;
    if (!e || !data) return;
    const pal = readPalette();
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c3aed";
    const nodes: NodeInput[] = data.nodes.filter((n) => showAi || n.kind !== "concept").map((n) => {
      const ci = colorIndex(n.collection, ordered);
      return {
        id: n.key,
        label: n.label,
        kind: n.kind,
        noteId: n.note_id,
        degree: n.degree,
        dim: n.dim,
        color: n.kind === "concept" ? accent : n.kind === "note" && ci >= 0 ? pal.slots[ci]! : pal.none,
      };
    });
    const links = [
      ...data.edges.map(([s, t, w]) => ({ source: s, target: t, weight: w, ai: false })),
      ...(showAi ? data.ai_edges.map(([s, t, type, status]) => ({ source: s, target: t, weight: 1, ai: true, aiType: type, aiStatus: status })) : []),
    ];
    const focusKey = focus ? (data.nodes.find((n) => n.note_id === focus)?.key ?? null) : null;
    e.setData(nodes, links, focusKey);
    e.setSearch(search);
    // Colours depend on the theme too.
  }, [data, ordered, focus, resolved, showAi]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    engine.current?.setSearch(search);
  }, [search]);

  useEffect(() => {
    engine.current?.setSelected(selected);
  }, [selected]);

  useEffect(() => {
    engine.current?.setSelectedEdge(selectedEdge);
  }, [selectedEdge]);

  return <canvas ref={canvas} role="img" aria-label={label} className="block size-full cursor-grab touch-none select-none" />;
}
