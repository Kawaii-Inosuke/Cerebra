// Hash routes, so back/forward and reloads work the same in the desktop app and the preview.
import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "graph"; focus?: string; collection?: string }
  | { name: "note"; id: string; sub?: string; edit?: boolean }
  | { name: "collection"; collection: string | null }
  | { name: "settings" }
  | { name: "review" }
  | { name: "agents" }
  | { name: "ai-sources" }
  | { name: "connect-ai" };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const [pathPart = "", query = ""] = h.split("?");
  const parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case "graph":
    {
      const r: Route = { name: "graph" };
      if (q.get("focus")) r.focus = q.get("focus")!;
      if (q.get("c")) r.collection = q.get("c")!;
      return r;
    }
    case "note":
      if (parts[1]) {
        const r: Route = { name: "note", id: parts[1] };
        if (q.get("sub")) r.sub = q.get("sub")!;
        if (q.get("edit") === "1") r.edit = true;
        return r;
      }
      return { name: "home" };
    case "c":
      return { name: "collection", collection: parts[1] ?? null };
    case "inbox":
      return { name: "collection", collection: null };
    case "settings":
      return { name: "settings" };
    case "review":
      return { name: "review" };
    case "agents":
      return { name: "agents" };
    case "ai-sources":
      return { name: "ai-sources" };
    case "connect-ai":
      return { name: "connect-ai" };
    default:
      return { name: "home" };
  }
}

export function routeHref(r: Route): string {
  switch (r.name) {
    case "home":
      return "#/";
    case "graph":
    {
      const q = new URLSearchParams();
      if (r.focus) q.set("focus", r.focus);
      if (r.collection) q.set("c", r.collection);
      const qs = q.toString();
      return qs ? `#/graph?${qs}` : "#/graph";
    }
    case "note": {
      const q = new URLSearchParams();
      if (r.sub) q.set("sub", r.sub);
      if (r.edit) q.set("edit", "1");
      const qs = q.toString();
      return `#/note/${encodeURIComponent(r.id)}${qs ? `?${qs}` : ""}`;
    }
    case "collection":
      return r.collection === null ? "#/inbox" : `#/c/${encodeURIComponent(r.collection)}`;
    case "settings":
      return "#/settings";
    case "review":
      return "#/review";
    case "agents":
      return "#/agents";
    case "ai-sources":
      return "#/ai-sources";
    case "connect-ai":
      return "#/connect-ai";
  }
}

export function navigate(r: Route, replace = false) {
  const href = routeHref(r);
  if (replace) {
    history.replaceState(null, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else if (location.hash !== href) {
    location.hash = href;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
