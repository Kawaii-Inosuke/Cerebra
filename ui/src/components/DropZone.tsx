import { Upload } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useActions } from "../actions";
import { cx } from "../lib/util";

/** A big, clickable drop area. Files dropped here go to `collection` (or the default one). */
export function DropZone({ collection, title, children, className }: { collection?: string | null; title: string; children?: ReactNode; className?: string }) {
  const actions = useActions();
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      onClick={() => actions.chooseAndUpload(collection)}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        window.dispatchEvent(new Event("cerebra-drop-done"));
        void actions.uploadFiles(Array.from(e.dataTransfer.files), collection);
      }}
      disabled={actions.uploading}
      className={cx(
        "group flex w-full flex-col items-center justify-center gap-2 rounded-[12px] border-2 border-dashed px-6 py-10 text-center transition-colors duration-150 ease-out",
        over ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-border-strong hover:bg-surface-2",
        className,
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-card border border-border bg-bg text-muted-strong transition-colors group-hover:text-fg">
        <Upload className="size-5" aria-hidden />
      </span>
      <span className="text-[14px] font-medium text-fg">{actions.uploading ? "Adding…" : title}</span>
      <span className="text-[12.5px] text-muted-strong">
        {children ?? "Drop PDFs, Word, PowerPoint, images or Markdown here, or click to choose. Up to 25 MB each."}
      </span>
    </button>
  );
}
