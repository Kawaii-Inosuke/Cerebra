import type { AnchorHTMLAttributes } from "react";
import { useApi } from "../context";

/** A web link that opens in the system browser on desktop (opener plugin) and a new tab in the browser. */
export function ExternalLink({ href, children, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const api = useApi();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        void api.openExternal(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
