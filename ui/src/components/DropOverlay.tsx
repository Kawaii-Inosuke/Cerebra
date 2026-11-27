// Drag files anywhere over the window: an overlay names the collection they'll go into.
import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { INBOX, useActions } from "../actions";

export function DropOverlay({ target }: { target: string | null }) {
  const actions = useActions();
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setActive(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      depth.current = 0;
      setActive(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      void actions.uploadFiles(files, targetRef.current);
    };
    const reset = () => {
      depth.current = 0;
      setActive(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("cerebra-drop-done", reset);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("cerebra-drop-done", reset);
    };
  }, [actions]);

  if (!active) return null;
  const name = target ?? actions.defaultCollection() ?? INBOX;
  return (
    <div className="anim-fade pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[var(--overlay)] p-8">
      <div className="anim-pop flex flex-col items-center gap-2 rounded-[14px] border-2 border-dashed border-accent bg-surface px-12 py-9 shadow-pop">
        <Upload className="size-6 text-accent" aria-hidden />
        <p className="text-[15px] font-semibold text-fg">Drop to add to {name}</p>
        <p className="text-[12.5px] text-muted-strong">Or drop onto a collection in the sidebar. Up to 25 MB per file.</p>
      </div>
    </div>
  );
}
