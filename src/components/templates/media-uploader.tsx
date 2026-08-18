import { useRef, useState } from "react";
import { Loader2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { uploadApi } from "@/lib/whatsapp-client";

type UploadResult = { handle: string; media_url: string; file_name: string; format: string };

const ACCEPT: Record<string, string> = {
  IMAGE: "image/jpeg,image/png",
  VIDEO: "video/mp4,video/3gpp",
  DOCUMENT: "application/pdf",
};

const HINT: Record<string, string> = {
  IMAGE: "JPG or PNG, up to 5 MB.",
  VIDEO: "MP4, up to 16 MB.",
  DOCUMENT: "PDF, up to 16 MB.",
};

/**
 * Uploading the picture, clip or file that sits at the top of a template.
 * Meta reviews the exact file, so it has to be uploaded before submitting.
 */
export function MediaUploader({
  organizationId,
  whatsappAccountId,
  slot,
  format,
  fileName,
  mediaUrl,
  onUploaded,
  onCleared,
}: {
  organizationId: string;
  whatsappAccountId?: string | null;
  slot: string;
  format: "IMAGE" | "VIDEO" | "DOCUMENT";
  fileName: string;
  mediaUrl: string;
  onUploaded: (result: UploadResult) => void;
  onCleared: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.set("organization_id", organizationId);
    if (whatsappAccountId) form.set("whatsapp_account_id", whatsappAccountId);
    form.set("slot", slot);
    form.set("file", file);
    const { data, error } = await uploadApi<UploadResult>("/api/whatsapp/template-media", form);
    setBusy(false);
    if (error || !data) {
      toast.error(error ?? "We couldn't upload that file.");
      return;
    }
    onUploaded(data);
    toast.success("File uploaded.");
  };

  return (
    <div className="rounded-xl border border-dashed border-border bg-muted/20 p-3">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT[format]}
        className="sr-only"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {mediaUrl ? (
        <div className="flex items-center gap-3">
          {format === "IMAGE" ? (
            <img src={mediaUrl} alt="" className="h-12 w-12 rounded-lg object-cover" />
          ) : (
            <Paperclip className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          )}
          <p className="min-w-0 flex-1 truncate text-sm">{fileName || "Uploaded file"}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={onCleared}
          >
            <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Remove
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Paperclip className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            )}
            {busy ? "Uploading…" : "Choose file"}
          </Button>
          <p className="text-xs text-muted-foreground">{HINT[format]}</p>
        </div>
      )}
    </div>
  );
}
