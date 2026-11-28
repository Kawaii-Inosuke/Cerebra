import { Compass, Download, FolderOpen, Info, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AppState, ModelsProgress } from "../api";
import { useAbout } from "../components/About";
import { useToast } from "../components/Toast";
import { useTour } from "../components/Tour";
import { useUpdates } from "../components/UpdatePrompt";
import { Button, Switch } from "../components/ui";
import { useApi, useLibrary, usePrefs } from "../context";
import { appVersion } from "../lib/appInfo";
import { autoCheck, setAutoCheck } from "../lib/updates";
import type { Density, ThemePref } from "../lib/theme";
import { cx, errorMessage, modKey, plural } from "../lib/util";
import { nearestStep, ZOOM_STEPS, zoomLabel } from "../lib/zoom";

export function Settings({ onSwitchLibrary }: { onSwitchLibrary?: () => void }) {
  const api = useApi();
  const lib = useLibrary();
  const prefs = usePrefs();
  const toast = useToast();
  const [app, setApp] = useState<AppState | null>(null);
  const [progress, setProgress] = useState<ModelsProgress | null>(null);
  const [reloading, setReloading] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const about = useAbout();
  const tour = useTour();
  const updates = useUpdates();
  const [autoUpdates, setAutoUpdates] = useState(autoCheck);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void appVersion(api.desktop).then(setVersion);
  }, [api]);

  useEffect(() => {
    api.appState().then(setApp).catch(() => {});
    return api.onModelsProgress((p) => {
      setProgress(p);
      if (p.total > 0 && p.done >= p.total) api.appState().then(setApp).catch(() => {});
    });
  }, [api]);

  const download = async () => {
    setApp((a) => (a ? { ...a, models: "downloading" } : a));
    try {
      await api.downloadModels();
      setApp(await api.appState());
      toast.show({ kind: "success", title: "Models are ready", description: "Search can now find passages by meaning, and scans are read with OCR." });
    } catch (e) {
      toast.show({ kind: "error", title: "The download didn't finish", description: errorMessage(e) });
      api.appState().then(setApp).catch(() => {});
    }
  };

  const reload = async () => {
    setReloading(true);
    try {
      await lib.refresh({ reload: true });
      toast.show({ kind: "success", title: "Library reloaded", duration: 2500 });
    } finally {
      setReloading(false);
    }
  };

  const modelsLabel: Record<string, string> = {
    ready: "Downloaded and ready",
    missing: "Not downloaded yet",
    downloading: "Downloading…",
    unavailable: "Not available on this computer",
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[720px] flex-col gap-8 px-8 pt-10 pb-20">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Settings</h1>

        <Section title="Appearance">
          <Row label="Theme" description="System follows your computer's light or dark setting.">
            <Segmented<ThemePref>
              label="Theme"
              value={prefs.theme}
              onChange={prefs.setTheme}
              options={[
                { value: "light", label: "Light", icon: <Sun className="size-3.5" /> },
                { value: "dark", label: "Dark", icon: <Moon className="size-3.5" /> },
                { value: "system", label: "System", icon: <Monitor className="size-3.5" /> },
              ]}
            />
          </Row>
          <Row label="Text size" description={`Everything scales together. ${modKey} + and ${modKey} − change it anywhere, ${modKey} 0 resets.`}>
            <Segmented<string>
              label="Text size"
              value={String(ZOOM_STEPS[nearestStep(prefs.zoom)])}
              onChange={(v) => prefs.setZoom(Number(v))}
              options={ZOOM_STEPS.map((z) => ({ value: String(z), label: zoomLabel(z) }))}
            />
          </Row>
          <Row label="Density" description="Compact fits more rows in the sidebar.">
            <Segmented<Density>
              label="Density"
              value={prefs.density}
              onChange={prefs.setDensity}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
          </Row>
        </Section>

        <Section title="Library">
          <Row label="Location" description={lib.info ? `${plural(lib.info.notes, "note")} and ${plural(lib.info.files, "file")}` : undefined}>
            <code className="block max-w-full truncate rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-[12px] text-muted-strong" title={lib.info?.root}>
              {lib.info?.root ?? "—"}
            </code>
          </Row>
          <Row label="Reload" description="Read every file again, for example after changing notes in another app.">
            <Button onClick={() => void reload()} disabled={reloading}>
              <RefreshCw className={cx("size-3.5", reloading && "animate-spin")} aria-hidden /> {reloading ? "Reloading…" : "Reload"}
            </Button>
          </Row>
          <Row label="Switch library" description={api.desktop ? "Open another library folder." : "In the browser preview, restart the preview with another folder."}>
            <Button onClick={onSwitchLibrary} disabled={!api.desktop || !onSwitchLibrary}>
              <FolderOpen className="size-3.5" aria-hidden /> Open another…
            </Button>
          </Row>
        </Section>

        <Section title="Models">
          <Row
            label="Search and OCR models"
            description="Small local models (about 150 MB) for search by meaning and reading scans. Downloaded once; nothing leaves your computer."
          >
            <div className="flex flex-col items-end gap-2">
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-strong">
                <span aria-hidden className={cx("size-1.5 rounded-full", app?.models === "ready" ? "bg-success" : app?.models === "downloading" ? "bg-accent" : "bg-muted")} />
                {app ? modelsLabel[app.models] : "Checking…"}
              </span>
              {app && app.models !== "ready" && app.models !== "unavailable" && (
                <Button onClick={() => void download()} disabled={app.models === "downloading" || !api.desktop} title={api.desktop ? undefined : "Only in the desktop app"}>
                  <Download className="size-3.5" aria-hidden /> {app.models === "downloading" ? "Downloading…" : "Download"}
                </Button>
              )}
            </div>
          </Row>
          {app?.models === "downloading" && progress && progress.total > 0 && (
            <div className="px-4 pb-4">
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label="Model download">
                <div className="h-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }} />
              </div>
              <p className="mt-1 text-right text-[11.5px] text-muted tabular-nums">{Math.round((progress.done / progress.total) * 100)}%</p>
            </div>
          )}
        </Section>

        <Section title="Help">
          <Row label="Guided tour" description="A one-minute walk through the main screens. Skip it at any step.">
            <Button onClick={() => tour?.start()} disabled={!tour}>
              <Compass className="size-3.5" aria-hidden /> Take the tour
            </Button>
          </Row>
          <Row label="Check for updates automatically" description="When Cerebra starts, it asks for a newer version and offers to install it. The check only contacts GitHub, or the Microsoft Store for the Store version.">
            <Switch
              label="Check for updates automatically"
              checked={autoUpdates}
              onChange={(v) => {
                setAutoCheck(v);
                setAutoUpdates(v);
              }}
            />
          </Row>
          <Row label="Updates" description={api.desktop ? `You have version ${version ?? "…"}.` : "Updates work in the desktop app."}>
            <Button
              onClick={() => {
                setChecking(true);
                void updates?.checkNow().finally(() => setChecking(false));
              }}
              disabled={!api.desktop || !updates || checking}
            >
              <RefreshCw className={cx("size-3.5", checking && "animate-spin")} aria-hidden /> {checking ? "Checking…" : "Check now"}
            </Button>
          </Row>
          <Row label="About Cerebra" description={`Version ${version ?? "…"}. Licence, credits, and details for a bug report.`}>
            <Button onClick={() => about?.open()} disabled={!about}>
              <Info className="size-3.5" aria-hidden /> About
            </Button>
          </Row>
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`s-${title}`}>
      <h2 id={`s-${title}`} className="mb-2 text-[13px] font-semibold text-fg">
        {title}
      </h2>
      <div className="divide-y divide-border rounded-card border border-border bg-surface">{children}</div>
    </section>
  );
}

function Row({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-fg">{label}</p>
        {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
      </div>
      <div className="flex max-w-[55%] min-w-0 shrink-0 justify-end">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: ReactNode }[] }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-input border border-border bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12.5px] transition-colors duration-150",
            value === o.value ? "bg-surface font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)] ring-1 ring-border" : "text-muted-strong hover:text-fg",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
