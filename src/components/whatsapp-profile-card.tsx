import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ExternalLink, ImagePlus, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePermissions } from "@/hooks/use-permissions";
import { callApi, uploadApi } from "@/lib/whatsapp-client";
import {
  nameStatusLabel,
  PROFILE_LIMITS,
  PROFILE_PHOTO_MAX_BYTES,
  PROFILE_PHOTO_SIZE,
  PROFILE_PHOTO_TYPES,
  PROFILE_VERTICALS,
  profileProblems,
  squareCropRect,
  type BusinessProfile,
  type DisplayNameStatus,
  type ProfilePatch,
} from "@/lib/whatsapp-profile";

type Loaded = { profile: BusinessProfile; name: DisplayNameStatus };

/** The picture, cropped square and scaled to 640 × 640, as a JPEG. */
async function cropToSquare(src: string, zoom: number, x: number, y: number): Promise<Blob | null> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const { sx, sy, size } = squareCropRect(img.naturalWidth, img.naturalHeight, zoom, x, y);
  const canvas = document.createElement("canvas");
  canvas.width = PROFILE_PHOTO_SIZE;
  canvas.height = PROFILE_PHOTO_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PROFILE_PHOTO_SIZE, PROFILE_PHOTO_SIZE);
  ctx.drawImage(img, sx, sy, size, size, 0, 0, PROFILE_PHOTO_SIZE, PROFILE_PHOTO_SIZE);
  return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9));
}

/**
 * Batch 35: Settings → WhatsApp → one number's business profile, as customers
 * see it in WhatsApp. Read from Meta when opened; owners and admins
 * (settings.manage) can change it.
 */
/**
 * Batch 50: the new Settings shows the profile as its own card at the top of
 * the WhatsApp section, so inside it the per-number copy steps aside. Off this
 * provider (the classic look) nothing changes.
 */
export const WhatsAppProfileHoisted = createContext(false);

export function WhatsAppProfileCard({
  orgId,
  accountId,
  placement = "number",
  numberSwitch,
}: {
  orgId: string;
  accountId: string;
  /** "top": the new Settings' own card (a section card with a heading). */
  placement?: "number" | "top";
  /** Batch 50: the number picker, under the heading, when there are several. */
  numberSwitch?: React.ReactNode;
}) {
  const hoisted = useContext(WhatsAppProfileHoisted);
  const { can } = usePermissions();
  const canEdit = can("settings.manage");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [form, setForm] = useState<BusinessProfile | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "photo" | "name" | null>(null);
  const [newName, setNewName] = useState("");
  const [photo, setPhoto] = useState<{ url: string; zoom: number; x: number; y: number } | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setFailure(null);
    const { data, error } = await callApi<Loaded>("/api/whatsapp/profile", {
      body: { organization_id: orgId, whatsapp_account_id: accountId, action: "get" },
    });
    if (!data) {
      setFailure(error ?? "We couldn't read the profile from Meta.");
      return;
    }
    setLoaded(data);
    setForm({ ...data.profile, websites: [...data.profile.websites, "", ""].slice(0, 2) });
  }, [orgId, accountId]);

  useEffect(() => {
    if (open && !loaded) void load();
  }, [open, loaded, load]);

  // The crop preview: exactly the square the upload will take.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    let made: string | null = null;
    void cropToSquare(photo.url, photo.zoom, photo.x, photo.y).then((blob) => {
      if (cancelled || !blob) return;
      made = URL.createObjectURL(blob);
      setPreview(made);
    });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [photo]);

  if (!canEdit) return null;
  if (hoisted && placement === "number") return null;
  const top = placement === "top";

  const patch: ProfilePatch = {};
  if (form && loaded) {
    const before = loaded.profile;
    for (const key of ["about", "address", "description", "email", "vertical"] as const) {
      if (form[key] !== before[key]) patch[key] = form[key];
    }
    const sites = form.websites.map((w) => w.trim()).filter(Boolean);
    if (sites.join("\n") !== before.websites.join("\n")) patch.websites = sites;
  }
  const problems = profileProblems(patch);
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setBusy("save");
    const { error } = await callApi("/api/whatsapp/profile", {
      body: {
        organization_id: orgId,
        whatsapp_account_id: accountId,
        action: "update",
        profile: patch,
      },
    });
    setBusy(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Profile updated on WhatsApp.");
    await load();
  };

  const pickPhoto = (file: File | undefined) => {
    if (!file) return;
    if (!PROFILE_PHOTO_TYPES.includes(file.type)) {
      toast.error("Use a JPG or PNG picture.");
      return;
    }
    if (file.size > PROFILE_PHOTO_MAX_BYTES) {
      toast.error("That picture is over 5 MB. Use a smaller one.");
      return;
    }
    setPhoto({ url: URL.createObjectURL(file), zoom: 1, x: 0.5, y: 0.5 });
  };

  const uploadPhoto = async () => {
    if (!photo) return;
    setBusy("photo");
    const blob = await cropToSquare(photo.url, photo.zoom, photo.x, photo.y);
    if (!blob) {
      setBusy(null);
      toast.error("We couldn't prepare that picture.");
      return;
    }
    const data = new FormData();
    data.set("organization_id", orgId);
    data.set("whatsapp_account_id", accountId);
    data.set("file", new File([blob], "profile.jpg", { type: "image/jpeg" }));
    const { error } = await uploadApi("/api/whatsapp/profile-photo", data);
    setBusy(null);
    if (error) {
      toast.error(error);
      return;
    }
    URL.revokeObjectURL(photo.url);
    setPhoto(null);
    toast.success("Profile photo updated on WhatsApp.");
    await load();
  };

  const requestName = async () => {
    setBusy("name");
    const { error } = await callApi("/api/whatsapp/profile", {
      body: {
        organization_id: orgId,
        whatsapp_account_id: accountId,
        action: "display_name",
        name: newName,
      },
    });
    setBusy(null);
    if (error) {
      toast.error(error);
      return;
    }
    setNewName("");
    toast.success("Sent to Meta for review.");
    await load();
  };

  return (
    <div
      className={
        top
          ? "rounded-2xl border border-border bg-card p-6 shadow-sm"
          : "mt-6 rounded-xl border border-border/70 p-4"
      }
      data-testid="whatsapp-profile-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-start gap-2">
          <UserRound className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
          <div>
            {top ? (
              <h3 className="font-display text-lg font-semibold">WhatsApp profile</h3>
            ) : (
              <p className="text-sm font-medium">WhatsApp profile</p>
            )}
            <p className="text-xs text-muted-foreground">
              What customers see when they tap your name in WhatsApp: photo, about, address, email,
              websites and category.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="rounded-full"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Close" : "View and edit"}
        </Button>
      </div>

      {top && numberSwitch ? <div className="mt-4">{numberSwitch}</div> : null}
      {open ? (
        <div className="mt-4 space-y-5">
          {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
          {!form || !loaded ? (
            failure ? null : (
              <div className="space-y-2">
                <Skeleton className="h-16 w-16 rounded-full" />
                <Skeleton className="h-9 w-full rounded-lg" />
              </div>
            )
          ) : (
            <>
              <section className="space-y-2">
                <Label className="text-xs">Display name</Label>
                <p className="text-sm">
                  <span className="font-medium">{loaded.name.verified_name ?? "—"}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {nameStatusLabel(loaded.name.name_status)}
                  </span>
                </p>
                {loaded.name.new_display_name ? (
                  <p className="text-xs text-muted-foreground">
                    Requested: “{loaded.name.new_display_name}” —{" "}
                    {nameStatusLabel(loaded.name.new_name_status)}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="New display name"
                    className="max-w-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full"
                    disabled={busy !== null || newName.trim().length < 3}
                    onClick={() => void requestName()}
                  >
                    {busy === "name" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Request name change
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Meta reviews this, usually 1–3 days. The name must follow Meta's display name
                  rules, can change 10 times in 30 days, and once approved the number is
                  re-registered to show it.{" "}
                  <a
                    href="https://business.facebook.com/wa/manage/phone-numbers/"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 underline"
                  >
                    WhatsApp Manager <ExternalLink className="h-3 w-3" />
                  </a>
                </p>
              </section>

              <section className="space-y-2">
                <Label className="text-xs">Profile photo</Label>
                <div className="flex flex-wrap items-center gap-4">
                  {photo ? (
                    preview ? (
                      <img
                        src={preview}
                        alt="New profile photo, cropped"
                        className="h-24 w-24 rounded-full border"
                      />
                    ) : (
                      <Skeleton className="h-24 w-24 rounded-full" />
                    )
                  ) : loaded.profile.profile_picture_url ? (
                    <img
                      src={loaded.profile.profile_picture_url}
                      alt="Current profile photo"
                      className="h-24 w-24 rounded-full border object-cover"
                    />
                  ) : (
                    <div className="flex h-24 w-24 items-center justify-center rounded-full border bg-muted text-xs text-muted-foreground">
                      No photo
                    </div>
                  )}
                  <div className="space-y-2">
                    <input
                      ref={fileRef}
                      type="file"
                      accept={PROFILE_PHOTO_TYPES.join(",")}
                      className="hidden"
                      onChange={(e) => pickPhoto(e.target.files?.[0])}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-full"
                      onClick={() => fileRef.current?.click()}
                    >
                      <ImagePlus className="mr-1.5 h-4 w-4" /> Choose picture
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      JPG or PNG, up to 5 MB. Cropped square.
                    </p>
                  </div>
                </div>
                {photo ? (
                  <div className="max-w-xs space-y-3">
                    <div>
                      <Label className="text-xs">Zoom</Label>
                      <Slider
                        min={1}
                        max={3}
                        step={0.05}
                        value={[photo.zoom]}
                        onValueChange={([v]) => setPhoto({ ...photo, zoom: v ?? 1 })}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Left – right</Label>
                      <Slider
                        min={0}
                        max={1}
                        step={0.01}
                        value={[photo.x]}
                        onValueChange={([v]) => setPhoto({ ...photo, x: v ?? 0.5 })}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Top – bottom</Label>
                      <Slider
                        min={0}
                        max={1}
                        step={0.01}
                        value={[photo.y]}
                        onValueChange={([v]) => setPhoto({ ...photo, y: v ?? 0.5 })}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="rounded-full"
                        disabled={busy !== null}
                        onClick={() => void uploadPhoto()}
                      >
                        {busy === "photo" ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : null}
                        Use this photo
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="rounded-full"
                        onClick={() => setPhoto(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label htmlFor={`wa-about-${accountId}`} className="text-xs">
                    About ({form.about.length}/{PROFILE_LIMITS.about})
                  </Label>
                  <Input
                    id={`wa-about-${accountId}`}
                    value={form.about}
                    maxLength={PROFILE_LIMITS.about}
                    onChange={(e) => setForm({ ...form, about: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor={`wa-desc-${accountId}`} className="text-xs">
                    Description ({form.description.length}/{PROFILE_LIMITS.description})
                  </Label>
                  <Textarea
                    id={`wa-desc-${accountId}`}
                    value={form.description}
                    maxLength={PROFILE_LIMITS.description}
                    rows={3}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor={`wa-address-${accountId}`} className="text-xs">
                    Address
                  </Label>
                  <Input
                    id={`wa-address-${accountId}`}
                    value={form.address}
                    maxLength={PROFILE_LIMITS.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`wa-email-${accountId}`} className="text-xs">
                    Email
                  </Label>
                  <Input
                    id={`wa-email-${accountId}`}
                    type="email"
                    value={form.email}
                    maxLength={PROFILE_LIMITS.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Category</Label>
                  <Select
                    value={form.vertical || "none"}
                    onValueChange={(v) => setForm({ ...form, vertical: v === "none" ? "" : v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROFILE_VERTICALS.map((v) => (
                        <SelectItem key={v.value || "none"} value={v.value || "none"}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {[0, 1].map((i) => (
                  <div key={i}>
                    <Label className="text-xs">Website {i + 1}</Label>
                    <Input
                      value={form.websites[i] ?? ""}
                      placeholder="https://"
                      maxLength={PROFILE_LIMITS.website}
                      onChange={(e) => {
                        const websites = [...form.websites];
                        websites[i] = e.target.value;
                        setForm({ ...form, websites });
                      }}
                    />
                  </div>
                ))}
              </section>
              {problems.length ? <p className="text-xs text-destructive">{problems[0]}</p> : null}
              <Button
                size="sm"
                className="rounded-full"
                disabled={!dirty || problems.length > 0 || busy !== null}
                onClick={() => void save()}
              >
                {busy === "save" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Save profile
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
