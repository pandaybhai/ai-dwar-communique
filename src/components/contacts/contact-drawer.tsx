import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MessageSquare, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { callApi } from "@/lib/whatsapp-client";
import {
  OPT_IN_CLASSES,
  OPT_IN_LABELS,
  TAG_COLORS,
  contactInitials,
  formatDate,
  sourceClass,
  sourceLabel,
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
type ConsentRecord = { opt_in_source: string | null; opted_in_at: string | null };

const CONSENT_SOURCE_LABELS: Record<string, string> = {
  import: "an import",
  manual: "a team member",
  bulk: "a bulk action",
  keyword: "the customer's reply",
};

/** What the merchant can pick in the drawer; an opt-out is never cleared here. */
export function drawerOptInChoices(current: OptInStatus): OptInStatus[] {
  return current === "opted_out" ? [] : ["unknown", "opted_in", "opted_out"];
}

export function consentLine(record: ConsentRecord | null): string | null {
  if (!record?.opted_in_at) return null;
  const how = CONSENT_SOURCE_LABELS[record.opt_in_source ?? ""] ?? "a team member";
  return `Opted in by ${how} on ${formatDate(record.opted_in_at)}.`;
}

/**
 * Batch 57: the drawer's words. Classic passes nothing and gets exactly these;
 * Aiden Workspace passes its own. Consent lines keep
 * their meaning (only the customer can undo an opt-out, by replying START).
 */
export type DrawerWords = {
  /** Before the date, as its own text (Classic's "Added "). */
  addedPrefix: string;
  name: string;
  phone: string;
  tags: string;
  removeTag: (name: string) => string;
  addTag: string;
  noOtherTags: string;
  createTag: string;
  tagPlaceholder: string;
  colour: (c: string) => string;
  createAndAdd: string;
  attributes: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  removeAttribute: string;
  addAttribute: string;
  conversation: string;
  viewConversation: string;
  noConversation: string;
  save: string;
  saving: string;
  delete: string;
  tagAddError: string;
  tagCreateError: string;
  tagRemoveError: string;
  saveError: string;
  updated: string;
  deleteDenied: string;
  deleted: string;
  optIn: OptInWords;
};

export type OptInWords = {
  label: string;
  labels: Record<OptInStatus, string>;
  optedOut: string;
  optOutWarning: string;
};

export const OPT_IN_WORDS: OptInWords = {
  label: "Opt-in status",
  labels: OPT_IN_LABELS,
  optedOut: "This customer opted out. Only they can opt back in, by replying START.",
  optOutWarning: "Once saved, only the customer can undo an opt-out, by replying START.",
};

export const DRAWER_WORDS: DrawerWords = {
  addedPrefix: "Added ",
  name: "Name",
  phone: "Phone",
  tags: "Tags",
  removeTag: (name) => `Remove ${name}`,
  addTag: "Tag",
  noOtherTags: "No other tags yet.",
  createTag: "Create a tag",
  tagPlaceholder: "VIP customers",
  colour: (c) => `Colour ${c}`,
  createAndAdd: "Create & add",
  attributes: "Custom attributes",
  keyPlaceholder: "key",
  valuePlaceholder: "value",
  removeAttribute: "Remove attribute",
  addAttribute: "Add attribute",
  conversation: "Conversation",
  viewConversation: "View conversation",
  noConversation: "No conversation yet.",
  save: "Save changes",
  saving: "Saving…",
  delete: "Delete",
  tagAddError: "We couldn't add that tag.",
  tagCreateError: "A tag with that name may already exist.",
  tagRemoveError: "We couldn't remove that tag.",
  saveError: "We couldn't save these changes.",
  updated: "Contact updated.",
  deleteDenied: "Only owners and admins can delete contacts.",
  deleted: "Contact deleted.",
  optIn: OPT_IN_WORDS,
};

export function ContactDrawer({
  contact,
  organizationId,
  allTags,
  canDelete,
  onClose,
  onChanged,
  extra,
  side,
  words = DRAWER_WORDS,
  roomy = false,
}: {
  contact: ContactRow | null;
  organizationId: string;
  allTags: TagRow[];
  canDelete: boolean;
  onClose: () => void;
  onChanged: () => void;
  /**
   * Batch 48, new design only: the read-only customer summary (chat, orders,
   * flows, consent, what Aiden knows), shown above the edit fields; it
   * replaces the drawer's own "View conversation" link. Unset: as before.
   */
  extra?: ReactNode;
  /** Batch 48: "bottom" makes it the phone's sheet. Unset: the right-hand drawer as before. */
  side?: "bottom";
  /** Batch 57, Aiden Workspace: its words. Unset: Classic's exactly. */
  words?: DrawerWords;
  /** Batch 57, Aiden Workspace: 44px controls on a phone and a spring rise. Unset: as before. */
  roomy?: boolean;
}) {
  const w = words;
  const big = (base: string, more: string) => (roomy ? `${base} ${more}` : base);
  const [name, setName] = useState("");
  const [optIn, setOptIn] = useState<OptInStatus>("unknown");
  const [attrs, setAttrs] = useState<AttrPair[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0] as string);
  const [consent, setConsent] = useState<ConsentRecord | null>(null);

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
    setConsent(null);
    void (async () => {
      // Batch 36 consent record. Read on its own so the drawer still works
      // before 20261140 adds the columns (the read then just fails).
      const { data, error } = await aidwar
        .from("contacts")
        .select("opt_in_source, opted_in_at")
        .eq("id", contact.id)
        .maybeSingle();
      if (!error) setConsent((data as ConsentRecord | null) ?? null);
    })();
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
        toast.error(w.tagAddError);
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
      toast.error(w.tagCreateError);
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
      toast.error(w.tagRemoveError);
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
      .update({ name: name.trim() || null, attributes })
      .eq("id", contact.id);
    if (error) {
      setSaving(false);
      toast.error(w.saveError);
      return;
    }
    // Batch 36: the opt-in switch goes through the server (consent record +
    // activity log with the user); an opt-out is never cleared from here.
    if (optIn !== contact.opt_in_status && contact.opt_in_status !== "opted_out") {
      const res = await callApi("/api/contacts/opt-in", {
        body: {
          action: "set",
          organization_id: organizationId,
          contact_id: contact.id,
          status: optIn,
        },
      });
      if (res.error) {
        setSaving(false);
        toast.error(res.error);
        onChanged();
        return;
      }
    }
    setSaving(false);
    toast.success(w.updated);
    onChanged();
  }

  async function deleteContact() {
    if (!contact) return;
    const { error } = await aidwar.from("contacts").delete().eq("id", contact.id);
    if (error) {
      toast.error(w.deleteDenied);
      return;
    }
    toast.success(w.deleted);
    onClose();
    onChanged();
  }

  return (
    <Sheet open={Boolean(contact)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent
        {...(side === "bottom"
          ? {
              side: "bottom" as const,
              className: big(
                "max-h-[88dvh] w-full overflow-y-auto rounded-t-[24px] pb-[calc(24px+env(safe-area-inset-bottom))]",
                "nd-sheet-spring",
              ),
            }
          : roomy
            ? { className: "w-full overflow-y-auto sm:max-w-md nd-sheet-spring" }
            : { className: "w-full overflow-y-auto sm:max-w-md" })}
      >
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
                    {w.addedPrefix}
                    {formatDate(contact.created_at)}
                  </p>
                </div>
              </div>
            </SheetHeader>

            <div className="mt-6 space-y-6">
              {extra}
              <SourcePanel contact={contact} />

              <div className="space-y-2">
                <Label htmlFor="drawer-name">{w.name}</Label>
                <Input
                  id="drawer-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  {...(roomy ? { className: "phone:h-11" } : {})}
                />
              </div>

              <div className="space-y-2">
                <Label>{w.phone}</Label>
                <Input
                  value={contact.phone}
                  readOnly
                  aria-label={w.phone}
                  className={big("bg-muted/60", "phone:h-11")}
                />
              </div>

              <OptInField
                current={contact.opt_in_status}
                value={optIn}
                consent={consent}
                onChange={setOptIn}
                words={w.optIn}
              />

              <div className="space-y-2">
                <Label>{w.tags}</Label>
                <div className="flex flex-wrap items-center gap-2">
                  {tags.map((t) => (
                    <span
                      key={t.id}
                      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium"
                      style={{
                        borderColor: `${t.color}55`,
                        backgroundColor: `${t.color}18`,
                        color: t.color,
                      }}
                    >
                      {t.name}
                      <button
                        type="button"
                        aria-label={w.removeTag(t.name)}
                        onClick={() => void removeTag(t.id)}
                        className="opacity-60 transition-opacity hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className={big("h-7 rounded-full text-xs", "phone:h-10 phone:px-4")}
                      >
                        <Plus className="mr-1 h-3 w-3" />
                        {` ${w.addTag}`}
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
                        <p className="text-xs text-muted-foreground">{w.noOtherTags}</p>
                      )}
                      <div className="space-y-2 border-t border-border/70 pt-3">
                        <Label className="text-xs">{w.createTag}</Label>
                        <Input
                          value={newTagName}
                          onChange={(e) => setNewTagName(e.target.value)}
                          placeholder={w.tagPlaceholder}
                          className="h-8 text-sm"
                        />
                        <div className="flex flex-wrap gap-1.5">
                          {TAG_COLORS.map((c) => (
                            <button
                              key={c}
                              type="button"
                              aria-label={w.colour(c)}
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
                          {w.createAndAdd}
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              <div className="space-y-2">
                <Label>{w.attributes}</Label>
                <div className="space-y-2">
                  {attrs.map((pair, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={pair.key}
                        placeholder={w.keyPlaceholder}
                        className={big("h-9", "phone:h-11")}
                        onChange={(e) =>
                          setAttrs((prev) =>
                            prev.map((p, idx) => (idx === i ? { ...p, key: e.target.value } : p)),
                          )
                        }
                      />
                      <Input
                        value={pair.value}
                        placeholder={w.valuePlaceholder}
                        className={big("h-9", "phone:h-11")}
                        onChange={(e) =>
                          setAttrs((prev) =>
                            prev.map((p, idx) => (idx === i ? { ...p, value: e.target.value } : p)),
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={w.removeAttribute}
                        onClick={() => setAttrs((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    className={big("rounded-full", "phone:h-10 phone:px-4")}
                    onClick={() => setAttrs((prev) => [...prev, { key: "", value: "" }])}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    {` ${w.addAttribute}`}
                  </Button>
                </div>
              </div>

              {extra ? null : (
                <div className="space-y-2">
                  <Label>{w.conversation}</Label>
                  {loadingConversation ? (
                    <Skeleton className="h-9 w-full rounded-full" />
                  ) : conversationId ? (
                    <Button asChild variant="outline" className="w-full rounded-full">
                      <Link to="/app/inbox">
                        <MessageSquare className="mr-2 h-4 w-4" />
                        {` ${w.viewConversation}`}
                      </Link>
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">{w.noConversation}</p>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 border-t border-border/70 pt-4">
                <Button
                  className={big("rounded-full", "phone:h-11 phone:flex-1")}
                  onClick={() => void save()}
                  disabled={saving}
                >
                  {saving ? w.saving : w.save}
                </Button>
                {canDelete ? (
                  <Button
                    variant="ghost"
                    className={big(
                      "rounded-full text-destructive hover:text-destructive",
                      "phone:h-11",
                    )}
                    onClick={() => void deleteContact()}
                  >
                    {w.delete}
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

export function OptInField({
  current,
  value,
  consent,
  onChange,
  words = OPT_IN_WORDS,
}: {
  current: OptInStatus;
  value: OptInStatus;
  consent: ConsentRecord | null;
  onChange: (v: OptInStatus) => void;
  /** Batch 57, Aiden Workspace: its words. Unset: Classic's exactly. */
  words?: OptInWords;
}) {
  const choices = drawerOptInChoices(current);
  const line = current === "opted_in" ? consentLine(consent) : null;
  return (
    <div className="space-y-2">
      <Label>{words.label}</Label>
      {choices.length === 0 ? (
        <>
          <span
            className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${OPT_IN_CLASSES[current]}`}
          >
            {words.labels[current]}
          </span>
          <p className="text-xs text-muted-foreground">{words.optedOut}</p>
        </>
      ) : (
        <>
          <Select value={value} onValueChange={(v) => onChange(v as OptInStatus)}>
            <SelectTrigger aria-label={words.label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((k) => (
                <SelectItem key={k} value={k}>
                  {words.labels[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {value === "opted_out" && current !== "opted_out" ? (
            <p className="text-xs text-muted-foreground">{words.optOutWarning}</p>
          ) : line ? (
            <p className="text-xs text-muted-foreground">{line}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function SourcePanel({ contact }: { contact: ContactRow }) {
  const detail = (contact.source_detail ?? {}) as Record<string, unknown>;
  const str = (k: string) => {
    const v = detail[k];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const headline = str("headline") ?? str("body");
  const adId = str("source_id");
  const adUrl = str("source_url") ?? str("ctwa_clid");
  const marker = str("marker");

  return (
    <div className="rounded-2xl border border-border/70 bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground">Lead source</Label>
        <span
          className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${sourceClass(contact.source)} nd:border-line nd:bg-surface nd:text-[0.8125rem] nd:font-semibold nd:text-foreground`}
        >
          {sourceLabel(contact.source)}
        </span>
      </div>
      {headline || adId || adUrl || marker ? (
        <dl className="mt-3 space-y-1.5 text-xs">
          {headline ? (
            <div>
              <dt className="text-muted-foreground">Ad message</dt>
              <dd className="text-foreground">{headline}</dd>
            </div>
          ) : null}
          {adId ? (
            <div>
              <dt className="text-muted-foreground">Ad ID</dt>
              <dd className="break-all font-mono text-[11px] text-foreground">{adId}</dd>
            </div>
          ) : null}
          {adUrl ? (
            <div>
              <dt className="text-muted-foreground">Link</dt>
              <dd className="break-all text-foreground">{adUrl}</dd>
            </div>
          ) : null}
          {marker ? (
            <div>
              <dt className="text-muted-foreground">Tracking marker</dt>
              <dd className="text-foreground">{marker}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Captured when this contact was first created.
        </p>
      )}
    </div>
  );
}
