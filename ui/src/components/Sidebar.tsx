import * as Tooltip from "@radix-ui/react-tooltip";
import { Bot, Home, Inbox, KeyRound, Plug, Network, PanelLeftClose, PanelLeftOpen, Plus, Settings, Sparkles } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { useActions } from "../actions";
import { useAgentsOptional } from "../agents";
import { useLibrary, useShell } from "../context";
import { colorVar } from "../lib/colors";
import { routeHref, type Route } from "../lib/router";
import { cx } from "../lib/util";
import { LibraryPicker } from "../switcher";
import { Dot } from "./ui";

function isActive(route: Route, target: Route): boolean {
  if (route.name !== target.name) return false;
  if (route.name === "collection" && target.name === "collection") return route.collection === target.collection;
  return true;
}

export function Sidebar({ route }: { route: Route }) {
  const lib = useLibrary();
  const actions = useActions();
  const agents = useAgentsOptional();
  const { sidebarCollapsed: collapsed, setSidebarCollapsed } = useShell();

  return (
    <Tooltip.Provider delayDuration={300}>
      <nav
        aria-label="Main"
        className={cx(
          "flex h-full shrink-0 flex-col border-r border-border bg-bg transition-[width] duration-200 ease-out",
          collapsed ? "w-[56px]" : "w-[232px]",
        )}
      >
        <div className={cx("flex h-12 items-center gap-1", collapsed ? "justify-center" : "justify-between pr-2 pl-2")}>
          {!collapsed && (
            <div data-tour="library" className="flex min-w-0 flex-1">
              <LibraryPicker fallbackName={lib.info?.name} />
            </div>
          )}
          <button
            type="button"
            onClick={() => setSidebarCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>

        <div className="flex flex-col gap-0.5 px-2 pt-1" data-tour="nav">
          <NavItem collapsed={collapsed} href={routeHref({ name: "home" })} active={isActive(route, { name: "home" })} icon={<Home className="size-4" />} label="Home" />
          <NavItem collapsed={collapsed} href={routeHref({ name: "graph" })} active={route.name === "graph"} icon={<Network className="size-4" />} label="Graph" tour="graph" />
          <NavItem
            collapsed={collapsed}
            href={routeHref({ name: "review" })}
            active={route.name === "review"}
            icon={<Sparkles className="size-4" />}
            label="Review"
            tour="review"
            count={agents && agents.suggested > 0 ? agents.suggested : undefined}
            countAccent
          />
          <NavItem collapsed={collapsed} href={routeHref({ name: "agents" })} active={route.name === "agents"} icon={<Bot className="size-4" />} label="Agents" tour="agents" />
          <NavItem collapsed={collapsed} href={routeHref({ name: "connect-ai" })} active={route.name === "connect-ai"} icon={<Plug className="size-4" />} label="Connect your AI" tour="connect-ai" />
          <NavItem collapsed={collapsed} href={routeHref({ name: "ai-sources" })} active={route.name === "ai-sources"} icon={<KeyRound className="size-4" />} label="AI sources" tour="ai-sources" />
        </div>

        <div className="mt-5 flex min-h-0 flex-1 flex-col" data-tour="collections">
          {!collapsed && (
            <div className="flex items-center justify-between px-4 pb-1.5">
              <h2 className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">Collections</h2>
              <button
                type="button"
                onClick={() => void actions.newCollection()}
                aria-label="New collection"
                className="rounded-md p-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          )}
          <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2" aria-label="Collections">
            {lib.collections.map((c) => (
              <li key={c.name}>
                <CollectionItem
                  name={c.name}
                  count={c.notes}
                  color={colorVar(c.name, lib.ordered)}
                  active={isActive(route, { name: "collection", collection: c.name })}
                  collapsed={collapsed}
                  onDropFiles={(files) => void actions.uploadFiles(files, c.name)}
                />
              </li>
            ))}
            {lib.inboxCount > 0 && (
              <li>
                <NavItem
                  collapsed={collapsed}
                  href={routeHref({ name: "collection", collection: null })}
                  active={isActive(route, { name: "collection", collection: null })}
                  icon={<Inbox className="size-4" />}
                  label="Inbox"
                  count={lib.inboxCount}
                />
              </li>
            )}
            {!lib.collections.length && !collapsed && !lib.loading && (
              <li className="px-2 py-2 text-[12.5px] leading-relaxed text-muted">
                No collections yet. A collection holds one subject, course or project.
              </li>
            )}
            <li>
              <NavItem
                collapsed={collapsed}
                onClick={() => void actions.newCollection()}
                icon={<Plus className="size-4" />}
                label="New collection"
                muted
              />
            </li>
          </ul>
        </div>

        <div className="border-t border-border px-2 py-2" data-tour="settings">
          <NavItem collapsed={collapsed} href={routeHref({ name: "settings" })} active={route.name === "settings"} icon={<Settings className="size-4" />} label="Settings" />
        </div>
      </nav>
    </Tooltip.Provider>
  );
}

function Wrap({ collapsed, label, children }: { collapsed: boolean; label: string; children: ReactNode }) {
  if (!collapsed) return <>{children}</>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={8}
          className="anim-fade z-50 rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-fg shadow-float"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const itemClass = (active: boolean, collapsed: boolean) =>
  cx(
    "group flex h-[var(--row)] w-full items-center gap-2.5 rounded-input text-[13px] transition-colors duration-150 ease-out",
    collapsed ? "justify-center px-0" : "px-2",
    active ? "bg-hover font-medium text-fg" : "text-muted-strong hover:bg-hover hover:text-fg",
  );

function NavItem({
  collapsed,
  href,
  onClick,
  active = false,
  disabled = false,
  icon,
  label,
  count,
  countAccent,
  hint,
  tooltip,
  muted,
  tour,
}: {
  collapsed: boolean;
  href?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
  countAccent?: boolean;
  hint?: string;
  tooltip?: string;
  muted?: boolean;
  /** Anchor for the guided tour. */
  tour?: string;
}) {
  const inner = (
    <>
      <span className={cx("shrink-0", muted ? "text-muted" : "")}>{icon}</span>
      {!collapsed && <span className={cx("flex-1 truncate text-left", muted && "text-muted")}>{label}</span>}
      {!collapsed && count !== undefined && (
        <span className={cx("text-[12px] tabular-nums", countAccent ? "rounded-full bg-accent-soft px-1.5 font-medium text-accent-text" : "text-muted")} aria-label={countAccent ? `${count} to review` : undefined}>
          {count}
        </span>
      )}
      {!collapsed && hint && (
        <span className="rounded-full border border-border px-1.5 py-px text-[10.5px] font-medium text-muted">{hint}</span>
      )}
    </>
  );
  if (disabled) {
    return (
      <Wrap collapsed label={tooltip ?? label}>
        <span aria-disabled="true" title={tooltip} className={cx(itemClass(false, collapsed), "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted-strong")}>
          {inner}
          {collapsed && <span className="sr-only">{label}</span>}
        </span>
      </Wrap>
    );
  }
  const common = { className: itemClass(active, collapsed), "aria-label": collapsed ? label : undefined, "data-tour": tour };
  return (
    <Wrap collapsed={collapsed} label={label}>
      {href ? (
        <a href={href} aria-current={active ? "page" : undefined} {...common}>
          {inner}
        </a>
      ) : (
        <button type="button" onClick={onClick} {...common}>
          {inner}
        </button>
      )}
    </Wrap>
  );
}

function CollectionItem({
  name,
  count,
  color,
  active,
  collapsed,
  onDropFiles,
}: {
  name: string;
  count: number;
  color: string;
  active: boolean;
  collapsed: boolean;
  onDropFiles: (files: File[]) => void;
}) {
  const [over, setOver] = useState(false);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  return (
    <Wrap collapsed={collapsed} label={`${name} · ${count}`}>
      <a
        href={routeHref({ name: "collection", collection: name })}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? name : undefined}
        data-testid={`collection-${name}`}
        data-drop-collection={name}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          window.dispatchEvent(new Event("cerebra-drop-done"));
          onDropFiles(Array.from(e.dataTransfer.files));
        }}
        className={cx(itemClass(active, collapsed), over && "bg-accent-soft text-fg ring-1 ring-accent")}
      >
        <Dot color={color} className="size-2.5" />
        {!collapsed && <span className="flex-1 truncate">{name}</span>}
        {!collapsed && <span className="text-[12px] text-muted tabular-nums">{count}</span>}
      </a>
    </Wrap>
  );
}
