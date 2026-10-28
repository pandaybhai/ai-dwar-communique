import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { MOD_KEY } from "@/lib/keyboard";

/** Every shortcut the app answers to (Batch 39). Keep in step with the handlers. */
export const SHORTCUTS: Array<{ group: string; items: Array<{ keys: string[]; label: string }> }> =
  [
    {
      group: "Everywhere",
      items: [
        { keys: [MOD_KEY, "K"], label: "Search and commands" },
        { keys: ["?"], label: "Keyboard shortcuts" },
        { keys: ["["], label: "Collapse or expand the sidebar" },
        { keys: ["G", "H"], label: "Go to Home" },
        { keys: ["G", "I"], label: "Go to Inbox" },
        { keys: ["G", "C"], label: "Go to Contacts" },
        { keys: ["G", "M"], label: "Go to Campaigns" },
        { keys: ["G", "T"], label: "Go to Templates" },
        { keys: ["G", "S"], label: "Go to Settings" },
      ],
    },
    {
      group: "Inbox",
      items: [
        { keys: ["J"], label: "Next conversation" },
        { keys: ["K"], label: "Previous conversation" },
        { keys: ["Enter"], label: "Open the highlighted conversation" },
        { keys: ["R"], label: "Reply (focus the message box)" },
        { keys: ["E"], label: "Close the conversation" },
        { keys: ["A"], label: "Assign" },
        { keys: ["/"], label: "Search conversations" },
        { keys: ["Esc"], label: "Leave the message box" },
        { keys: ["Enter"], label: "Send (Shift + Enter for a new line)" },
      ],
    },
  ];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single keys work whenever you aren't typing in a box.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-8 sm:grid-cols-2">
          {SHORTCUTS.map((g) => (
            <section key={g.group}>
              <h3 className="type-label text-faint">{g.group}</h3>
              <dl className="mt-3 space-y-2.5">
                {g.items.map((s) => (
                  <div
                    key={`${g.group}-${s.label}`}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <dt className="text-foreground">{s.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {s.keys.map((k, i) => (
                        <Kbd key={`${k}-${i}`}>{k}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
