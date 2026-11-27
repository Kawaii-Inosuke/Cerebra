// Rendered note HTML uses cerebra:// URLs for everything inside the library:
//   cerebra://note/<id>[#sub]  cerebra://embed/<id>  cerebra://file/<path>  cerebra://unresolved/<text>
export type CerebraLink =
  | { kind: "note"; id: string; sub?: string }
  | { kind: "embed"; id: string }
  | { kind: "file"; path: string }
  | { kind: "unresolved"; text: string };

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseCerebraUrl(href: string): CerebraLink | null {
  const m = /^cerebra:\/\/(note|embed|file|unresolved)\/(.*)$/.exec(href);
  if (!m) return null;
  const [, kind, rest = ""] = m;
  switch (kind) {
    case "note": {
      const hash = rest.indexOf("#");
      const id = dec(hash >= 0 ? rest.slice(0, hash) : rest);
      const sub = hash >= 0 ? dec(rest.slice(hash + 1)) : "";
      return sub ? { kind: "note", id, sub } : { kind: "note", id };
    }
    case "embed":
      return { kind: "embed", id: dec(rest.split("#")[0] ?? rest) };
    case "file":
      return { kind: "file", path: dec(rest) };
    default:
      return { kind: "unresolved", text: dec(rest) };
  }
}

/** Point images and file links at URLs the webview can load. */
export function rewriteFileUrls(html: string, fileUrl: (path: string) => string): string {
  return html.replace(/(src|href)="cerebra:\/\/file\/([^"]*)"/g, (_all, attr: string, p: string) => {
    const path = dec(p.replace(/&amp;/g, "&"));
    return `${attr}="${fileUrl(path).replace(/"/g, "%22")}" data-cerebra-file="${p}"`;
  });
}

/** Same slug rule the engine uses for heading ids (lowercase, spaces → dashes). */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

/** Split a search snippet with **highlights** into parts. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  return snippet
    .split("**")
    .map((text, i) => ({ text, hit: i % 2 === 1 }))
    .filter((p) => p.text);
}
