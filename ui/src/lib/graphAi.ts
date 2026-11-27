// Matching a clicked violet line in the graph to the AI connection behind it.
import type { AiConnection, GraphNode } from "../api";

export interface ClickedEdge {
  source: string;
  target: string;
  type: string;
}

/**
 * The AI connection a line stands for: same two notes (graph keys → note ids) and same kind.
 * Lines to a concept aren't connections; for those the caller selects the concept instead.
 */
export function findConnection(edge: ClickedEdge, nodes: Pick<GraphNode, "key" | "note_id">[], connections: AiConnection[]): AiConnection | null {
  if (edge.type === "concept") return null;
  const noteOf = new Map(nodes.map((n) => [n.key, n.note_id]));
  const from = noteOf.get(edge.source);
  const to = noteOf.get(edge.target);
  if (!from || !to) return null;
  return (
    connections.find((c) => c.status !== "dismissed" && c.from_id === from && c.to_id === to && c.type === edge.type) ??
    // The graph may draw an undirected pair the other way round.
    connections.find((c) => c.status !== "dismissed" && c.from_id === to && c.to_id === from && c.type === edge.type) ??
    null
  );
}

/** For a line between a note and a concept: the concept's end. */
export function conceptEnd(edge: ClickedEdge, nodes: Pick<GraphNode, "key" | "kind">[]): string | null {
  if (edge.type !== "concept") return null;
  const kind = new Map(nodes.map((n) => [n.key, n.kind]));
  if (kind.get(edge.target) === "concept") return edge.target;
  if (kind.get(edge.source) === "concept") return edge.source;
  return null;
}
