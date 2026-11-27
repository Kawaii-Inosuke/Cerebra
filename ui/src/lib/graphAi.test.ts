import { describe, expect, it } from "vitest";
import { mapConnection } from "../test/fakeApi";
import { conceptEnd, findConnection } from "./graphAi";

const nodes = [
  { key: "Biology/Membrane.md", note_id: "n_mem", kind: "note" as const },
  { key: "Biology/Cell.md", note_id: "n_cell", kind: "note" as const },
  { key: "concept:k1", note_id: null, kind: "concept" as const },
];

describe("finding the connection behind a graph line", () => {
  const kept = mapConnection();
  const other = mapConnection({ id: "c2", type: "explains" });

  it("matches the two notes and the kind", () => {
    expect(findConnection({ source: "Biology/Membrane.md", target: "Biology/Cell.md", type: "explains" }, nodes, [kept, other])?.id).toBe("c2");
    expect(findConnection({ source: "Biology/Membrane.md", target: "Biology/Cell.md", type: "part_of" }, nodes, [kept, other])?.id).toBe("c1");
  });

  it("accepts the line drawn the other way round", () => {
    expect(findConnection({ source: "Biology/Cell.md", target: "Biology/Membrane.md", type: "part_of" }, nodes, [kept])?.id).toBe("c1");
  });

  it("ignores rejected connections, unknown notes and concept lines", () => {
    expect(findConnection({ source: "Biology/Membrane.md", target: "Biology/Cell.md", type: "part_of" }, nodes, [mapConnection({ status: "dismissed" })])).toBeNull();
    expect(findConnection({ source: "x", target: "Biology/Cell.md", type: "part_of" }, nodes, [kept])).toBeNull();
    expect(findConnection({ source: "Biology/Cell.md", target: "concept:k1", type: "concept" }, nodes, [kept])).toBeNull();
  });

  it("finds the concept end of a concept line", () => {
    expect(conceptEnd({ source: "Biology/Cell.md", target: "concept:k1", type: "concept" }, nodes)).toBe("concept:k1");
    expect(conceptEnd({ source: "concept:k1", target: "Biology/Cell.md", type: "concept" }, nodes)).toBe("concept:k1");
    expect(conceptEnd({ source: "Biology/Cell.md", target: "Biology/Membrane.md", type: "part_of" }, nodes)).toBeNull();
  });
});
