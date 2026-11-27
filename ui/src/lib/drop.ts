// Where files dropped from the OS go (desktop drag-drop gives paths, not File objects).
export interface DropPlan {
  /** `.cerebra` share files: open the import preview. */
  shares: string[];
  /** Everything else: add to `collection`. */
  uploads: string[];
  collection: string;
}

export function planDrop(
  paths: string[],
  opts: { at?: { x: number; y: number }; current: string | null; fallback: string | null; elementAt?: (x: number, y: number) => Element | null; inbox: string },
): DropPlan {
  const shares = paths.filter((p) => p.toLowerCase().endsWith(".cerebra"));
  const uploads = paths.filter((p) => !p.toLowerCase().endsWith(".cerebra"));
  let under: string | null = null;
  if (opts.at && opts.elementAt) {
    const el = opts.elementAt(opts.at.x, opts.at.y);
    under = el?.closest<HTMLElement>("[data-drop-collection]")?.dataset.dropCollection ?? null;
  }
  return { shares, uploads, collection: under ?? opts.current ?? opts.fallback ?? opts.inbox };
}
