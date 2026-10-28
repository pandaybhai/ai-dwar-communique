import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { normalizePhone, toWaId } from "@/lib/phone";
import { logActivity } from "@/lib/activity";
import { emitClientEvent, recordClientUsage } from "@/lib/events-capture";
import { callApi } from "@/lib/whatsapp-client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export const ADD_CONTACT_CONSENT_LABEL =
  "This contact agreed to get WhatsApp messages from us (opted in)";
export const ADD_CONTACT_CONSENT_HELPER = "WhatsApp requires consent. Untick if you're not sure.";

export function AddContactDialog({
  organizationId,
  onCreated,
}: {
  organizationId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // Batch 36: ticked by default, like the import.
  const [optedIn, setOptedIn] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const normalized = normalizePhone(phone);
    const digits = toWaId(normalized);
    if (digits.length < 8 || digits.length > 15) {
      setError("Enter a valid phone number with country code, e.g. +91 98765 43210.");
      return;
    }
    setSaving(true);
    const { data: existing } = await aidwar
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("phone", normalized)
      .maybeSingle();
    if (existing) {
      setSaving(false);
      setError("This contact already exists in your workspace.");
      return;
    }
    const { data: inserted, error: insErr } = await aidwar
      .from("contacts")
      .insert({
        organization_id: organizationId,
        phone: normalized,
        wa_id: digits,
        name: name.trim() || null,
        source: "manual",
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      setSaving(false);
      setError("We couldn't save this contact. Please try again.");
      return;
    }
    // The opt-in (and its consent record) goes through the one server path.
    let optInFailed = false;
    if (optedIn) {
      const res = await callApi("/api/contacts/opt-in", {
        body: {
          action: "set",
          organization_id: organizationId,
          contact_id: (inserted as { id: string }).id,
          status: "opted_in",
        },
      });
      optInFailed = Boolean(res.error);
    }
    setSaving(false);
    void logActivity("contact_created", organizationId, { source: "manual" });
    emitClientEvent("contact.created", organizationId, {
      entityType: "contact",
      properties: { contact_source: "manual" },
    });
    recordClientUsage("contacts_stored", organizationId, 1, { source: "manual" });
    if (optInFailed) toast.warning("Contact added, but we couldn't mark it opted in. Open it to try again.");
    else toast.success("Contact added.");
    setName("");
    setPhone("");
    setOptedIn(true);
    setOpen(false);
    onCreated();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="rounded-full">
          <Plus className="mr-2 h-4 w-4" />
          Add contact
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a contact</DialogTitle>
          <DialogDescription>
            Only add people who have agreed to hear from your business.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="contact-name">Name</Label>
            <Input
              id="contact-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Priya Sharma"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contact-phone">Phone number</Label>
            <Input
              id="contact-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
            />
            <p className="text-xs text-muted-foreground">Include the country code.</p>
          </div>
          <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/30 p-3">
            <Checkbox
              id="contact-opted-in"
              checked={optedIn}
              onCheckedChange={(v) => setOptedIn(v === true)}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <Label htmlFor="contact-opted-in" className="text-sm leading-relaxed">
                {ADD_CONTACT_CONSENT_LABEL}
              </Label>
              <p className="text-xs text-muted-foreground">{ADD_CONTACT_CONSENT_HELPER}</p>
            </div>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-full" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={() => void submit()} disabled={saving}>
            {saving ? "Saving…" : "Add contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
