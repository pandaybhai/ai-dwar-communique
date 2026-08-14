import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { MessageSquare, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import {
  OPT_IN_LABELS,
  TAG_COLORS,
  contactInitials,
  formatDate,
  type ContactRow,
  type OptInStatus,
  type TagRow,
} from "@/lib/contacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type AttrPair = { key: string; value: string };

export function ContactDrawer({
  contact,
  organizationId,
  allTags,
  canDelete,
  onClose,
  onChanged,
}: {
  contact: ContactRow | null;
  organizationId: string;
  allTags: TagRow[];
  canDelete: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [optIn, setOptIn] = useState<OptInStatus>("unknown");
  const [attrs, setAttrs] = useState<AttrPair[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0] as string);

  useEffect(() => {
    if (!contact) return;
    setName(contact.name ?? "");
    setOptIn(contact.opt_in_status);
    setTags(contact.tags);
    setAttrs(
      Object.entries(contact.attributes ?? {}).map(([key, value]) => ({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
      })),
    );
    setLoadingConversation(true);
    setConversationId(null);
    void (async () => {
      const { data } = await aidwar
        .from("conversations")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contact.id)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      setConversationId((data?.id as string) ?? null);
      setLoadingConversation(false);
    })();
  }, [contact, organizationId]);

  const availableTags = useMemo(
    () => allTags.filter((t) => !tags.some((x) => x.id === t.id)),
    [allTags, tags],
  );

  const attachTag = useCallback(
    async (tag: TagRow) => {
      if (!contact) return;
      setTags((prev) => [...prev, tag]);
      const { error } = await aidwar
        .from("contact_tags")
        .upsert(
          { contact_id: contact.id, tag_id: tag.id, organization_id: organizationId },
          { onConflict: "contact_id,tag_id" },
        );
      if (error) {
        setTags((prev) => prev.filter((t) => t.id !== tag.id));
        toast.error("We couldn't add that tag.");
        return;
      }
      onChanged();
    },
    [contact, organizationId, onChanged],
  );

  async function createTag() {
    const label = newTagName.trim();
    if (!label || !contact) return;
    const { data, error } = await aidwar
      .from("tags")
      .insert({ organization_id: organizationId, name: label, color: newTagColor })
      .select("id, name, color")
      .single();
    if (error || !data) {
      toast.error("A tag with that name may already exist.");
      return;
    }
    void logActivity("tag_created", organizationId, { tag_name: label });
    setNewTagName("");
    await attachTag(data as TagRow);
  }

  async function removeTag(tagId: string) {
    if (!contact) return;
    const previous = tags;
    setTags((prev) => prev.filter((t) => t.id !== tagId));
    const { error } = await aidwar
      .from("contact_tags")
      .delete()
      .eq("contact_id", contact.id)
      .eq("tag_id", tagId);
    if (error) {
      setTags(previous);
      toast.error("We couldn't remove that tag.");
      return;
    }
    onChanged();
  }

  async function save() {
    if (!contact) return;
    setSaving(true);
    const attributes: Record<string, string> = {};
    for (const pair of attrs) {
      const key = pair.key.trim();
      if (key) attributes[key] = pair.value;
    }
    const { error } = await aidwar
      .from("contacts")
      .update({ name: name.trim() || null, opt_in_status: optIn, attributes })
      .eq("id", contact.id);
    setSaving(false);
    if (error) {
      toast.error("We couldn't save these changes.");
      return;
    }
    if (optIn !== contact.opt_in_status) {
      void logActivity("optin_changed", organizationId, {
        contact_id: contact.id,
        from: contact.opt_in_status,
        to: optIn,
      });
    }
    toast.success("Contact updated.");
    onChanged();
  }

  async function deleteContact() {
    if (!contact) return;
    const { error } = await aidwar.from("contacts").delete().eq("id", contact.id);
    if (error) {
      toast.error("Only owners and admins can delete contacts.");
      return;
    }
    toast.success("Contact deleted.");
    onClose();
    onChanged();
  }

  return (
    <Sheet open={Boolean(contact)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {contact ? (
          <>
            <SheetHeader className="text-left">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 text-sm font-semibold text-primary">
                  {contactInitials(contact)}
                </div>
                <div className="min-w-0">
                  <SheetTitle className="truncate">{contact.name || contact.phone}</SheetTitle>
                  <p className="text-xs text-muted-foreground">
                    Added {formatDate(contact.created_at)}
                  </p>
                </div>
              </div>
            </SheetHeader>

            <div className="mt-6 space-y-6">
              <div className="space-y-2">
                <Label htmlFor="drawer-name">Name</Label>
                <Input id="drawer-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <div className="space-y-2">
                <Label>Phone</Label>
                <Input value={contact.phone} readOnly className="bg-muted/60" />
              </div>

              <div className="space-y-2">
                <Label>Opt-in status</Label>
                <Select value={optIn} onValueChange={(v) => setOptIn(v as OptInStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(OPT_IN_LABELS) as OptInStatus[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {OPT_IN_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Tags</Label>
                <div className="flex flex-wrap items-center gap-2">
                  {tags.map((t) => (
                    <span
                      key={t.id}
                      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium"
                      style={{ borderColor: `${t.color}55`, backgroundColor: `${t.color}18`, color: t.color }}
                    >
                      {t.name}
                      <button
                        type="button"
                        aria-label={`Remove ${t.name}`}
                        onClick={() => void removeTag(t.id)}
                        className="opacity-60 transition-opacity hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 rounded-full text-xs">
                        <Plus className="mr-1 h-3 w-3" /> Tag
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-64 space-y-3">
                      {availableTags.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {availableTags.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => void attachTag(t)}
                              className="rounded-full border px-2.5 py-1 text-xs font-medium transition-transform duration-150 hover:scale-105"
                              style={{
                                borderColor: `${t.color}55`,
                                backgroundColor: `${t.color}18`,
                                color: t.color,
                              }}
                            >
                              {t.name}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">No other tags yet.</p>
                      )}
                      <div className="space-y-2 border-t border-border/70 pt-3">
                        <Label className="text-xs">Create a tag</Label>
                        <Input
                          value={newTagName}
                          onChange={(e) => setNewTagName(e.target.value)}
                          placeholder="VIP customers"
                          className="h-8 text-sm"
                        />
                        <div className="flex flex-wrap gap-1.5">
                          {TAG_COLORS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              aria-label={`Colour ${c}`}
                              onClick={() => setNewTagColor(c)}
                              className={`h-5 w-5 rounded-full transition-transform duration-150 ${
                                newTagColor === c ? "scale-110 ring-2 ring-offset-2 ring-ring" : ""
                              }`}
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                        <Button
                          size="sm"
                          className="w-full rounded-full"
                          onClick={() => void createTag()}
                          disabled={!newTagName.trim()}
                        >
                          Create & add
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Custom attributes</Label>
                <div className="space-y-2">
                  {attrs.map((pair, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={pair.key}
                        placeholder="key"
                        className="h-9"
                        onChange={(e) =>
                          setAttrs((prev) =>
                            prev.map((p, idx) => (idx === i ? { ...p, key: e.target.value } : p)),
                          )
                        }
                      />
                      <Input
                        value={pair.value}
                        placeholder="value"
                        className="h-9"
                        onChange={(e) =>
                          setAttrs((prev) =>
                            prev.map((p, idx) => (idx === i ? { ...p, value: e.target.value } : p)),
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove attribute"
                        onClick={() => setAttrs((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => setAttrs((prev) => [...prev, { key: "", value: "" }])}
                  >
                    <Plus className="mr-1 h-3 w-3" /> Add attribute
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Conversation</Label>
                {loadingConversation ? (
                  <Skeleton className="h-9 w-full rounded-full" />
                ) : conversationId ? (
                  <Button asChild variant="outline" className="w-full rounded-full">
                    <Link to="/app/inbox" search={{ c: conversationId }}>
                      <MessageSquare className="mr-2 h-4 w-4" /> View conversation
                    </Link>
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">No conversation yet.</p>
                )}
              </div>

              <div className="flex items-center gap-2 border-t border-border/70 pt-4">
                <Button className="rounded-full" onClick={() => void save()} disabled={saving}>
                  {saving ? "Saving…" : "Save changes"}
                </Button>
                {canDelete ? (
                  <Button
                    variant="ghost"
                    className="rounded-full text-destructive hover:text-destructive"
                    onClick={() => void deleteContact()}
                  >
                    Delete
                  </Button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
