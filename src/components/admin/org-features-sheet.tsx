import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { OrgFeatureControls } from "@/components/admin/org-feature-controls";

/**
 * Per-organization feature state for Super Admin. The list and the effective
 * state both come from the shared OrgFeatureControls component, so this sheet
 * and the billing sheet can never disagree.
 */
export function OrgFeaturesSheet({
  organizationId,
  organizationName,
  open,
  onClose,
}: {
  organizationId: string;
  organizationName: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{organizationName}</SheetTitle>
          <SheetDescription>
            Every feature AiDwar ships, with its state for this workspace. Off means the feature
            disappears from their navigation entirely.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 pb-10">
          {open ? <OrgFeatureControls organizationId={organizationId} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
