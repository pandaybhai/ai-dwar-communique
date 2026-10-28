import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { Bold, Code, Italic, List, ListOrdered, Quote, Strikethrough } from "lucide-react";
import { Button } from "@/components/ui/button";
import { prefixLines, wrapSelection, type InlineAction, type LineAction } from "@/lib/wa-format";

type Action = InlineAction | LineAction;

const BUTTONS: Array<{ action: Action; label: string; icon: typeof Bold; shortcut?: string }> = [
  { action: "bold", label: "Bold", icon: Bold, shortcut: "Ctrl/⌘+B" },
  { action: "italic", label: "Italic", icon: Italic, shortcut: "Ctrl/⌘+I" },
  { action: "strike", label: "Strikethrough", icon: Strikethrough },
  { action: "mono", label: "Monospace", icon: Code },
  { action: "bullet", label: "Bulleted list", icon: List },
  { action: "number", label: "Numbered list", icon: ListOrdered },
  { action: "quote", label: "Quote", icon: Quote },
];

/**
 * Batch 35: WhatsApp formatting for a template textarea — the toolbar and the
 * Ctrl/⌘+B / Ctrl/⌘+I shortcuts. Markers wrap the selection; a {{n}} is
 * never split (wrapSelection moves the edges outside it).
 */
export function useWhatsAppFormatting(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onChange: (next: string) => void,
) {
  const pendingSelection = useRef<[number, number] | null>(null);

  useEffect(() => {
    const el = ref.current;
    const sel = pendingSelection.current;
    if (!el || !sel) return;
    pendingSelection.current = null;
    el.focus();
    el.setSelectionRange(sel[0], sel[1]);
  }, [value, ref]);

  const apply = (action: Action) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const edit =
      action === "bullet" || action === "number" || action === "quote"
        ? prefixLines(value, start, end, action)
        : wrapSelection(value, start, end, action);
    pendingSelection.current = [edit.start, edit.end];
    onChange(edit.text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "b" || key === "i") {
      e.preventDefault();
      apply(key === "b" ? "bold" : "italic");
    }
  };

  return { apply, onKeyDown };
}

export function FormatToolbar({
  onApply,
  label = "Text style",
}: {
  onApply: (action: Action) => void;
  label?: string;
}) {
  return (
    <div role="toolbar" aria-label={label} className="flex flex-wrap items-center gap-0.5">
      {BUTTONS.map(({ action, label: name, icon: Icon, shortcut }) => (
        <Button
          key={action}
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          title={shortcut ? `${name} (${shortcut})` : name}
          aria-label={name}
          // Keep the textarea's selection: a mouse-down on the button would blur it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onApply(action)}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      ))}
    </div>
  );
}
