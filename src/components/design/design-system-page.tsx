import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Bell,
  Check,
  ChevronDown,
  Inbox,
  Info,
  Loader2,
  Monitor,
  Moon,
  Plus,
  Search,
  Send,
  Sparkles,
  Sun,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Kbd } from "@/components/ui/kbd";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { Bubble } from "@/components/inbox/chat-thread";
import type { MessageRow } from "@/components/inbox/inbox-utils";
import { useThemeChoice, type ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ data */

const BRAND = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
const GRAY = ["0", "25", "50", "100", "150", "200", "300", "400", "500", "600", "700", "800", "850", "900", "950", "1000"];

const SURFACES: Array<[string, string]> = [
  ["background", "Page canvas behind everything."],
  ["card", "Cards, panes, inputs — the main surface."],
  ["popover", "Menus, dialogs, sheets, toasts."],
  ["subtle", "Quiet fills: table headers, sidebars of a card."],
  ["muted", "Tracks, chips, skeletons, disabled fields."],
  ["accent", "Hover and selected rows, ghost-button hover."],
  ["border", "Hairlines between things."],
  ["border-strong", "Inputs on hover, checkbox frames."],
  ["primary", "The one main action per view; links; selection."],
];

const TEXT: Array<[string, string]> = [
  ["foreground", "Body text and headings."],
  ["muted-foreground", "Secondary text: descriptions, previews, meta."],
  ["faint", "Placeholders and the quietest hints (still 4.5:1)."],
  ["primary", "Links and selected states."],
];

const STATUS = ["success", "warning", "danger", "info"] as const;

const WA: Array<[string, string]> = [
  ["wa-wall", "Chat wallpaper"],
  ["wa-in", "Customer's bubble"],
  ["wa-out", "Your bubble"],
  ["wa-text", "Bubble text"],
  ["wa-meta", "Time on a customer bubble"],
  ["wa-meta-out", "Time on your bubble"],
  ["wa-tick", "Read ticks"],
  ["wa-link", "Links and buttons"],
];

const TYPE: Array<[string, string, string]> = [
  ["type-display", "Page title", "28/34 · 700 · −0.022em — one per page (PageHeader)."],
  ["type-title", "Section title", "22/28 · 650 — dialogs' big moments, empty hero."],
  ["text-lg font-semibold", "Card title", "18/28 · 600."],
  ["type-heading", "Group heading", "16/24 · 600 — card and panel headers."],
  ["text-body", "Reading text", "15/24 — messages, long descriptions."],
  ["text-sm", "Dense UI text", "14/20 — the default for tables, lists, forms."],
  ["text-xs", "Meta text", "12/16 — times, counts, helper text."],
  ["type-label", "Overline", "11/16 · 600 · caps — group labels in nav and menus."],
];

const SPACE = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];
const RADII: Array<[string, string]> = [
  ["rounded-sm", "6px · tags inside inputs"],
  ["rounded-md", "8px · small buttons, menu items"],
  ["rounded-lg", "10px · buttons, inputs, selects"],
  ["rounded-xl", "14px · cards, popovers, dialogs"],
  ["rounded-2xl", "18px · large panels, empty states"],
  ["rounded-full", "pills, avatars, chips"],
];
const SHADOWS = ["shadow-2xs", "shadow-xs", "shadow-sm", "shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl"];
const SHADOW_USE: Record<string, string> = {
  "shadow-2xs": "hairline lift",
  "shadow-xs": "buttons, inputs, cards",
  "shadow-sm": "raised cards, bubbles",
  "shadow-md": "tooltips, hovered cards",
  "shadow-lg": "menus, popovers, selects",
  "shadow-xl": "toasts, command palette",
  "shadow-2xl": "dialogs and sheets",
};
const MOTION: Array<[string, string, string]> = [
  ["ease-out", "--dur-fast 120ms", "Hover, press, colour changes."],
  ["ease-out", "--dur-base 180ms", "Menus, tabs, tooltips, new messages."],
  ["ease-in-out", "--dur-slow 280ms", "Sheets, panels, the sidebar collapsing."],
  ["ease-spring", "--dur-base 180ms", "Small delights only (a sent bubble landing)."],
];

const bubble = (id: string, over: Partial<MessageRow>): MessageRow => ({
  id,
  conversation_id: "design",
  direction: "inbound",
  type: "text",
  body: null,
  media_url: null,
  media_mime: null,
  template_name: null,
  status: "read",
  error_detail: null,
  created_at: "2026-10-28T10:41:00Z",
  ...over,
});

const SAMPLE_BUBBLES: MessageRow[] = [
  bubble("ds-1", { body: "Is the rose-gold ring available in size 12?" }),
  bubble("ds-2", { body: "And do you ship to *Pune*?" }),
  bubble("ds-3", { direction: "outbound", body: "Yes! Size 12 is in stock and we ship to Pune in 2 days 💍" }),
  bubble("ds-4", { direction: "outbound", body: "Shall I keep one for you?", status: "delivered", sent_by: "u" }),
  bubble("ds-5", { direction: "outbound", body: "Our cut-off is 6 pm.", status: "failed", error_detail: "Outside the 24-hour window.", sent_by: "u" }),
  bubble("ds-6", { direction: "outbound", body: "Sending…", status: "pending", sent_by: "u" }),
];

/* ------------------------------------------------------------- helpers */

function Section({ id, title, intro, children }: { id: string; title: string; intro: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-border py-12 first:border-t-0 first:pt-0">
      <h2 className="type-title text-foreground">{title}</h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{intro}</p>
      <div className="mt-8 space-y-8">{children}</div>
    </section>
  );
}

function Sub({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <div>
      <h3 className="type-label text-faint">{title}</h3>
      {note ? <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{note}</p> : null}
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** The token's value as the browser resolved it (follows the theme). */
function useTokenValue(name: string, theme: string) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      setValue(getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()),
    );
    return () => cancelAnimationFrame(frame);
  }, [name, theme]);
  return value;
}

function Swatch({ token, label, note, theme, ring }: { token: string; label?: string; note?: string; theme: string; ring?: boolean }) {
  const value = useTokenValue(token, theme);
  return (
    <div className="min-w-0">
      <div
        className={cn("h-14 rounded-lg border border-border/60", ring && "ring-1 ring-inset ring-border")}
        style={{ background: `var(--${token})` }}
      />
      <p className="mt-2 truncate font-mono text-xs font-medium text-foreground">{label ?? `--${token}`}</p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      <p className="truncate font-mono text-[0.6875rem] text-faint" title={value}>
        {value || "…"}
      </p>
    </div>
  );
}

const NAV: Array<[string, string]> = [
  ["colour", "Colour"],
  ["type", "Typography"],
  ["space", "Spacing & radii"],
  ["elevation", "Elevation"],
  ["motion", "Motion & focus"],
  ["buttons", "Buttons"],
  ["forms", "Forms"],
  ["status", "Badges & alerts"],
  ["surfaces", "Cards & tables"],
  ["overlays", "Overlays"],
  ["feedback", "Feedback"],
  ["whatsapp", "WhatsApp"],
];

/* ---------------------------------------------------------------- page */

export function DesignSystemPage() {
  const [theme, setTheme] = useThemeChoice();
  const [progress, setProgress] = useState(64);
  const sentRef = useRef(0);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Design system"
        description="AiDwar's tokens and components — the one source of truth for every screen. Values follow the theme; use the semantic tokens in code, never the raw scales or hard-coded colours."
        actions={<ThemeSwitch theme={theme} onChange={setTheme} />}
      />

      <nav aria-label="Sections" className="sticky top-2 z-10 -mx-1 mb-10 flex gap-1 overflow-x-auto rounded-xl border border-border bg-card/85 p-1 shadow-xs backdrop-blur">
        {NAV.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {label}
          </a>
        ))}
      </nav>

      <Section id="colour" title="Colour" intro="Brand emerald and a cool 16-step gray carry the interface; status colours only ever mean status. Every text pairing here meets WCAG AA (4.5:1) in both themes.">
        <Sub title="Surfaces" note="bg-background · bg-card · bg-popover · bg-subtle · bg-muted · bg-accent · border-border · border-border-strong · bg-primary">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {SURFACES.map(([t, note]) => (
              <Swatch key={t} token={t} note={note} theme={theme} ring />
            ))}
          </div>
        </Sub>
        <Sub title="Text" note="text-foreground · text-muted-foreground · text-faint · text-primary">
          <div className="grid gap-3 sm:grid-cols-2">
            {TEXT.map(([t, note]) => (
              <div key={t} className="flex items-baseline gap-3 rounded-lg border border-border bg-card px-4 py-3">
                <span className="text-sm font-medium" style={{ color: `var(--${t})` }}>
                  The quick brown fox
                </span>
                <span className="ml-auto text-right font-mono text-xs text-faint">--{t}</span>
                <span className="sr-only">{note}</span>
              </div>
            ))}
          </div>
        </Sub>
        <Sub title="Status" note="Each status has a solid (bg-success + text-success-foreground), a soft tint (bg-success-soft + text-success-soft-foreground) and a border (border-success-border). Same for warning, danger, info.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STATUS.map((s) => (
              <div key={s} className="space-y-2">
                <div className="flex h-10 items-center rounded-lg px-3 text-sm font-medium" style={{ background: `var(--${s})`, color: `var(--${s}-foreground)` }}>
                  {s}
                </div>
                <div
                  className="flex h-10 items-center rounded-lg border px-3 text-sm font-medium"
                  style={{ background: `var(--${s}-soft)`, color: `var(--${s}-soft-foreground)`, borderColor: `var(--${s}-border)` }}
                >
                  {s} soft
                </div>
              </div>
            ))}
          </div>
        </Sub>
        <Sub title="Brand scale" note="bg-brand-50 … bg-brand-950. --primary is brand-700 in light (white text 5.3:1) and a lighter emerald in dark.">
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-6 lg:grid-cols-11">
            {BRAND.map((s) => (
              <Swatch key={s} token={`brand-${s}`} label={s} theme={theme} />
            ))}
          </div>
        </Sub>
        <Sub title="Gray scale" note="bg-gray-0 … bg-gray-1000 (cool, hue 255). Light theme uses 0–300 for surfaces and 600–900 for text; dark mirrors it.">
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
            {GRAY.map((s) => (
              <Swatch key={s} token={`gray-${s}`} label={s} theme={theme} />
            ))}
          </div>
        </Sub>
      </Section>

      <Section id="type" title="Typography" intro="Plus Jakarta Sans, as on the developer portal. 14px for dense UI, 15px for reading, 16px in phone inputs (so iOS never zooms). Numbers that line up use .tabular.">
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {TYPE.map(([cls, sample, spec]) => (
            <div key={cls} className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_16rem] sm:items-center">
              <p className={cn(cls, "text-foreground")}>{sample}</p>
              <div className="text-xs">
                <p className="font-mono font-medium text-foreground">.{cls.split(" ")[0]}</p>
                <p className="text-muted-foreground">{spec}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="space" title="Spacing & radii" intro="Everything sits on a 4px grid (Tailwind's spacing: 1 = 4px). Inside a card use 4–6; between cards 4–6; between sections 10–12.">
        <Sub title="Spacing">
          <div className="space-y-2">
            {SPACE.map((n) => (
              <div key={n} className="flex items-center gap-4">
                <span className="w-16 font-mono text-xs text-muted-foreground">{`p-${n}`}</span>
                <div className="h-3 rounded-sm bg-primary/70" style={{ width: n * 4 }} />
                <span className="font-mono text-xs text-faint">{n * 4}px</span>
              </div>
            ))}
          </div>
        </Sub>
        <Sub title="Radii">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {RADII.map(([cls, note]) => (
              <div key={cls}>
                <div className={cn("h-16 border border-border-strong bg-subtle", cls)} />
                <p className="mt-2 font-mono text-xs font-medium">{cls}</p>
                <p className="text-xs text-muted-foreground">{note}</p>
              </div>
            ))}
          </div>
        </Sub>
      </Section>

      <Section id="elevation" title="Elevation" intro="Layered and subtle: a tight contact shadow plus a soft ambient one. Dark mode leans on borders, with a faint highlight ring on the highest layers.">
        <div className="grid grid-cols-2 gap-6 rounded-xl bg-subtle p-6 sm:grid-cols-4 lg:grid-cols-7">
          {SHADOWS.map((s) => (
            <div key={s} className="text-center">
              <div className={cn("mx-auto h-20 rounded-xl bg-card", s)} />
              <p className="mt-3 font-mono text-xs font-medium">{s}</p>
              <p className="text-[0.6875rem] text-muted-foreground">{SHADOW_USE[s]}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="motion" title="Motion & focus" intro="Fast and quiet. Everything animates with transform/opacity; prefers-reduced-motion turns animation and transitions off app-wide.">
        <div className="grid gap-4 sm:grid-cols-2">
          {MOTION.map(([ease, dur, use]) => (
            <MotionDemo key={`${ease}${dur}`} ease={ease} dur={dur} use={use} />
          ))}
        </div>
        <Sub title="Focus" note="Keyboard focus is always visible: a 2px ring in --ring (focus-visible only, never on click). Inputs show a soft 3px halo and a coloured border.">
          <div className="flex flex-wrap items-center gap-3">
            <Button className="ring-2 ring-ring ring-offset-2 ring-offset-background">Focused button</Button>
            <Input className="w-56 border-ring ring-3 ring-ring/20" defaultValue="Focused input" aria-label="Focused input example" />
          </div>
        </Sub>
      </Section>

      <Section id="buttons" title="Buttons" intro="One primary per view. Outline for secondary actions, ghost inside dense toolbars, soft for a tinted secondary, destructive only to confirm loss.">
        <Sub title="Variants">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="soft">Soft</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
            <Button variant="destructive">
              <Trash2 /> Delete
            </Button>
          </div>
        </Sub>
        <Sub title="Sizes & states">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="xs">Extra small</Button>
            <Button size="sm">Small</Button>
            <Button>Default</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" aria-label="Add">
              <Plus />
            </Button>
            <Button size="icon-sm" variant="outline" aria-label="Search">
              <Search />
            </Button>
            <Button disabled>
              <Loader2 className="animate-spin" /> Saving…
            </Button>
            <Button variant="outline" disabled>
              Disabled
            </Button>
            <Button className="rounded-full">
              <Send /> Pill
            </Button>
          </div>
        </Sub>
      </Section>

      <Section id="forms" title="Forms" intro="Labels above fields, helper text below in text-xs muted. Invalid fields set aria-invalid and turn danger.">
        <div className="grid gap-6 rounded-xl border border-border bg-card p-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ds-name">Business name</Label>
            <Input id="ds-name" placeholder="Kesar & Co." />
            <p className="text-xs text-muted-foreground">Customers see this on WhatsApp.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ds-phone">Phone</Label>
            <Input id="ds-phone" defaultValue="98200" aria-invalid="true" aria-describedby="ds-phone-error" />
            <p id="ds-phone-error" className="text-xs text-danger-soft-foreground">
              Enter a full number with the country code.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ds-plan">Plan</Label>
            <Select defaultValue="growth">
              <SelectTrigger id="ds-plan">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="starter">Starter</SelectItem>
                <SelectItem value="growth">Growth</SelectItem>
                <SelectItem value="scale">Scale</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ds-disabled">Disabled</Label>
            <Input id="ds-disabled" disabled defaultValue="Can't change this" />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="ds-note">Note</Label>
            <Textarea id="ds-note" placeholder="Write a message…" />
          </div>
          <div className="flex items-center gap-2.5">
            <Checkbox id="ds-check" defaultChecked />
            <Label htmlFor="ds-check">Send a copy to the team</Label>
          </div>
          <div className="flex items-center gap-2.5">
            <Switch id="ds-switch" defaultChecked />
            <Label htmlFor="ds-switch">Aiden replies automatically</Label>
          </div>
          <RadioGroup defaultValue="all" className="sm:col-span-2 flex flex-wrap gap-5">
            {["all", "opted in", "opted out"].map((v) => (
              <div key={v} className="flex items-center gap-2">
                <RadioGroupItem value={v} id={`ds-radio-${v}`} />
                <Label htmlFor={`ds-radio-${v}`} className="capitalize">
                  {v}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>
      </Section>

      <Section id="status" title="Badges & alerts" intro="Badges label a thing's state; alerts explain a situation and what to do about it.">
        <Sub title="Badges">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="muted">Muted</Badge>
            <Badge variant="success">
              <Check /> Delivered
            </Badge>
            <Badge variant="warning">Waiting for you</Badge>
            <Badge variant="danger">Failed</Badge>
            <Badge variant="info">Sent via API</Badge>
            <Badge variant="destructive">Destructive</Badge>
          </div>
        </Sub>
        <Sub title="Alerts">
          <div className="grid gap-3 sm:grid-cols-2">
            <Alert>
              <Bell className="h-4 w-4" />
              <AlertTitle>Default</AlertTitle>
              <AlertDescription>Neutral information about this page.</AlertDescription>
            </Alert>
            <Alert variant="info">
              <Info className="h-4 w-4" />
              <AlertTitle>Info</AlertTitle>
              <AlertDescription>Meta reviews new templates within a day.</AlertDescription>
            </Alert>
            <Alert variant="success">
              <Check className="h-4 w-4" />
              <AlertTitle>Success</AlertTitle>
              <AlertDescription>Your number is connected and healthy.</AlertDescription>
            </Alert>
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Warning</AlertTitle>
              <AlertDescription>Outside the 24-hour window — send a template instead.</AlertDescription>
            </Alert>
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Destructive</AlertTitle>
              <AlertDescription>This message failed to send.</AlertDescription>
            </Alert>
          </div>
        </Sub>
      </Section>

      <Section id="surfaces" title="Cards & tables" intro="Cards group one topic. Tables are dense (14px, 40px rows) with a subtle header.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Conversations today</CardTitle>
              <CardDescription>Across all your numbers</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="type-display tabular">48</p>
            </CardContent>
          </Card>
          <Card className="transition-shadow hover:shadow-md">
            <CardHeader>
              <CardTitle>Hover me</CardTitle>
              <CardDescription>Clickable cards lift to shadow-md.</CardDescription>
            </CardHeader>
            <CardFooter>
              <Button size="sm" variant="outline">
                Open
              </Button>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <Avatar>
                <AvatarFallback>AI</AvatarFallback>
              </Avatar>
              <div>
                <CardTitle>Asha Iyer</CardTitle>
                <CardDescription>+91 98200 11223</CardDescription>
              </div>
            </CardHeader>
          </Card>
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Read</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                ["Diwali preview", "success", "Done", "4,210", "71%"],
                ["Wedding season", "info", "Sending", "1,180", "—"],
                ["Back in stock", "muted", "Draft", "—", "—"],
              ].map(([name, v, s, sent, read]) => (
                <TableRow key={name}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell>
                    <Badge variant={v as "success"}>{s}</Badge>
                  </TableCell>
                  <TableCell className="tabular text-right">{sent}</TableCell>
                  <TableCell className="tabular text-right">{read}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <Section id="overlays" title="Overlays" intro="Dialogs for decisions, sheets for side work, menus for choices, popovers for small forms, tooltips for names of icon buttons.">
        <div className="flex flex-wrap items-center gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Close this conversation?</DialogTitle>
                <DialogDescription>It moves to Closed. A new message from the customer opens it again.</DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2">
                <Button variant="outline">Cancel</Button>
                <Button>Close conversation</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open sheet</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Contact</SheetTitle>
                <SheetDescription>Side work that keeps the page in view.</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                Menu <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52">
              <DropdownMenuLabel>Assign to</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Riya Kapoor</DropdownMenuItem>
              <DropdownMenuItem>Neha Joshi</DropdownMenuItem>
              <DropdownMenuItem>Unassigned</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Popover</Button>
            </PopoverTrigger>
            <PopoverContent>
              <p className="text-sm font-medium">Snooze until</p>
              <p className="mt-1 text-xs text-muted-foreground">Small forms live in popovers.</p>
            </PopoverContent>
          </Popover>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Catch me up">
                  <Sparkles />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Catch me up <Kbd className="ml-1.5 border-transparent bg-background/15 text-background shadow-none">S</Kbd>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            Shortcut hints use <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </div>
        <Tabs defaultValue="all" className="max-w-md">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="waiting">Waiting</TabsTrigger>
            <TabsTrigger value="closed">Closed</TabsTrigger>
          </TabsList>
          <TabsContent value="all" className="text-sm text-muted-foreground">
            Tabs switch views of the same thing.
          </TabsContent>
          <TabsContent value="waiting" className="text-sm text-muted-foreground">
            Waiting conversations.
          </TabsContent>
          <TabsContent value="closed" className="text-sm text-muted-foreground">
            Closed conversations.
          </TabsContent>
        </Tabs>
      </Section>

      <Section id="feedback" title="Feedback" intro="Skeletons while loading (shaped like what's coming), toasts after an action, progress for known lengths, empty states that say what to do next.">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => toast.success("Conversation assigned.")}>
            Success toast
          </Button>
          <Button variant="outline" onClick={() => toast.error("We couldn't update the assignment. Please try again.")}>
            Error toast
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              sentRef.current += 1;
              toast("Template sent.", { description: `Sent ${sentRef.current} time(s) on this page.` });
            }}
          >
            Plain toast
          </Button>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-3 rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-card p-5">
            <div className="flex justify-between text-sm">
              <span className="font-medium">Reading your website</span>
              <span className="tabular text-muted-foreground">{progress}%</span>
            </div>
            <Progress value={progress} aria-label="Reading progress" />
            <Button size="xs" variant="outline" onClick={() => setProgress((p) => (p >= 100 ? 10 : p + 18))}>
              Advance
            </Button>
          </div>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <EmptyState icon={Inbox} title="No conversations yet" description="New customer messages will appear here the moment they arrive." action={<Button size="sm">Share your number</Button>} />
          <div className="space-y-4">
            <ErrorState message="We couldn't load your conversations. Please refresh." />
            <div className="flex items-center gap-3">
              {["AI", "VM", "MN", "+9"].map((i, n) => (
                <Avatar key={i} className={cn(n === 0 && "h-8 w-8", n === 2 && "h-12 w-12")}>
                  <AvatarFallback className={n === 1 ? "bg-primary/10 text-primary" : undefined}>{i}</AvatarFallback>
                </Avatar>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section id="whatsapp" title="WhatsApp" intro="Inside a chat the customer's world wins: WhatsApp's own wall and bubble colours (bg-wa-wall, bg-wa-in, bg-wa-out, text-wa-meta), in light and dark.">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
          {WA.map(([t, note]) => (
            <Swatch key={t} token={t} note={note} theme={theme} ring />
          ))}
        </div>
        <Sub title="Chat bubbles" note="Inbox's Bubble (components/inbox/chat-thread): tail on the first bubble of a run, time + ticks inside, a sparkle on AI-written replies, a red ring when a send failed. Day labels stick to the top while their day scrolls.">
          <div className="wa-wall rounded-xl border border-border px-2 py-5 sm:px-6">
            <div className="mx-auto flex max-w-xl flex-col">
              <div className="flex justify-center py-2">
                <span className="rounded-lg bg-wa-in/95 px-3 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-wa-meta shadow-[0_1px_0.5px_rgb(11_20_26/0.13)]">
                  Today
                </span>
              </div>
              {SAMPLE_BUBBLES.map((m, i) => (
                <div key={m.id} className={i === 0 || SAMPLE_BUBBLES[i - 1]!.direction !== m.direction ? "mt-2.5" : "mt-0.5"}>
                  <Bubble
                    message={m}
                    organizationId={null}
                    agentName="Aiden"
                    tail={i === 0 || SAMPLE_BUBBLES[i - 1]!.direction !== m.direction}
                    aiRun={m.id === "ds-3" ? { question: "", reply: m.body ?? "", taughtOn: null } : null}
                  />
                </div>
              ))}
            </div>
          </div>
        </Sub>
      </Section>
    </div>
  );
}

function ThemeSwitch({ theme, onChange }: { theme: ThemeChoice; onChange: (t: ThemeChoice) => void }) {
  const options: Array<[ThemeChoice, string, typeof Sun]> = [
    ["light", "Light", Sun],
    ["dark", "Dark", Moon],
    ["system", "System", Monitor],
  ];
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => onChange(value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors",
            theme === value ? "bg-card text-foreground shadow-xs" : "hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

function MotionDemo({ ease, dur, use }: { ease: string; dur: string; use: string }) {
  const [on, setOn] = useState(false);
  const ms = dur.match(/(\d+)ms/)?.[1] ?? "180";
  return (
    <button
      type="button"
      onClick={() => setOn((v) => !v)}
      className="group rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-subtle"
    >
      <div className="relative h-8 rounded-lg bg-muted">
        <span
          className="absolute top-1 left-1 h-6 w-6 rounded-md bg-primary shadow-sm"
          style={{
            transform: on ? "translateX(calc(100% * 6))" : "none",
            transition: `transform ${ms}ms var(--${ease})`,
          }}
        />
      </div>
      <p className="mt-3 font-mono text-xs font-medium">
        {ease} · {dur}
      </p>
      <p className="text-xs text-muted-foreground">{use} (click to play)</p>
    </button>
  );
}
