// A small promise-based prompt dialog (new collection, new note, import paths).
import * as Dialog from "@radix-ui/react-dialog";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui";

export interface PromptField {
  name: string;
  label: string;
  placeholder?: string;
  initial?: string;
  hint?: string;
  /** Return an error message, or null when the value is fine. */
  validate?: (value: string) => string | null;
}

export interface PromptOptions {
  title: string;
  description?: string;
  fields: PromptField[];
  confirm?: string;
}

type PromptFn = (o: PromptOptions) => Promise<Record<string, string> | null>;

const PromptContext = createContext<PromptFn | null>(null);

export function usePrompt(): PromptFn {
  const v = useContext(PromptContext);
  if (!v) throw new Error("usePrompt outside PromptProvider");
  return v;
}

/** Names the engine accepts for collections and note files. */
export function checkName(v: string): string | null {
  const s = v.trim();
  if (!s) return "Please enter a name.";
  if (s.startsWith(".")) return "Names can't start with a dot.";
  if (/[/\\:*?"<>|#^[\]]/.test(s)) return "Names can't contain / \\ : * ? \" < > | # ^ [ ]";
  if (s.length > 120) return "That name is too long.";
  return null;
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<PromptOptions | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const resolver = useRef<((v: Record<string, string> | null) => void) | null>(null);

  const prompt = useCallback<PromptFn>((o) => {
    resolver.current?.(null);
    setOpts(o);
    setValues(Object.fromEntries(o.fields.map((f) => [f.name, f.initial ?? ""])));
    setErrors({});
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (v: Record<string, string> | null) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  };

  const submit = () => {
    if (!opts) return;
    const errs: Record<string, string | null> = {};
    let bad = false;
    for (const f of opts.fields) {
      const e = f.validate?.(values[f.name] ?? "") ?? null;
      errs[f.name] = e;
      if (e) bad = true;
    }
    setErrors(errs);
    if (!bad) close(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
  };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      <Dialog.Root open={!!opts} onOpenChange={(o) => !o && close(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="anim-fade fixed inset-0 z-50 bg-[var(--overlay)]" />
          <Dialog.Content
            className="anim-pop fixed top-[22%] left-1/2 z-50 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-card border border-border bg-surface p-5 shadow-pop"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement | null)?.querySelector("input")?.focus();
            }}
          >
            {opts && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <Dialog.Title className="text-[15px] font-semibold text-fg">{opts.title}</Dialog.Title>
                {opts.description ? (
                  <Dialog.Description className="mt-1 text-[13px] text-muted-strong">{opts.description}</Dialog.Description>
                ) : (
                  <Dialog.Description className="sr-only">{opts.title}</Dialog.Description>
                )}
                <div className="mt-4 flex flex-col gap-3">
                  {opts.fields.map((f) => (
                    <label key={f.name} className="flex flex-col gap-1.5">
                      <span className="text-[12.5px] font-medium text-muted-strong">{f.label}</span>
                      <input
                        value={values[f.name] ?? ""}
                        placeholder={f.placeholder}
                        aria-invalid={!!errors[f.name]}
                        onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                        className="h-9 rounded-input border border-border bg-bg px-3 text-[13.5px] text-fg outline-none transition-colors placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/25 aria-[invalid=true]:border-danger"
                      />
                      {errors[f.name] ? (
                        <span className="text-[12px] text-danger">{errors[f.name]}</span>
                      ) : f.hint ? (
                        <span className="text-[12px] text-muted">{f.hint}</span>
                      ) : null}
                    </label>
                  ))}
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => close(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary">
                    {opts.confirm ?? "Create"}
                  </Button>
                </div>
              </form>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </PromptContext.Provider>
  );
}
