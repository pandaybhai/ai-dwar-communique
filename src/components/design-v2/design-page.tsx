import { useState, type ReactNode } from "react";
import { Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/empty-state";
import { ShellSectionContext, type ShellSectionState } from "@/components/shell/section-tabs";
import {
  AidenOrb,
  AnimatedList,
  AvatarCircles,
  BlurFade,
  BottomSheet,
  CountdownRing,
  NeedsYouCard,
  NumberTicker,
  PhoneFrame,
  PhoneMessage,
  ProductBubble,
  TypingText,
  WhatsAppBubble,
  sheetRowClass,
} from "./index";

/**
 * Batch 44: /app/design for a workspace with the new design on — the tokens
 * and every shared component Batches 45 to 50 build with
 * (docs/design/spec.md). The names and numbers here are the preview's sample
 * shop, shown as samples.
 */

const SWATCHES: Array<[string, string, string]> = [
  ["--ground", "Ground", "Page canvas"],
  ["--surface", "Surface", "Cards, menus, inputs"],
  ["--line", "Line", "Hairlines, borders"],
  ["--ink", "Ink", "Text, primary buttons"],
  ["--muted-foreground", "Muted", "Secondary text"],
  ["--aiden", "Aiden", "Orb, bars, focus"],
  ["--aiden-deep", "Aiden deep", "Emerald text, links"],
  ["--aiden-soft", "Aiden soft", "Selected tab"],
  ["--gold", "Gold", "Decisions, counts"],
  ["--gold-ink", "Gold ink", "Text on gold"],
  ["--gold-bg", "Gold background", "Needs you, notes"],
  ["--gold-line", "Gold line", "Gold hairlines"],
  ["--bubble-in", "Bubble in", "Quiet fills"],
  ["--bubble-out", "Bubble out", "Aiden's messages"],
];

const FEED = [
  {
    id: "rk",
    initials: "RK",
    tone: "bg-av2 text-av2-ink",
    name: "Rahul Kapoor",
    asked: "Bridal sets around ₹1.5 lakh?",
    reply: "We have 6 bridal sets in your budget. Shall I send photos?",
  },
  {
    id: "av",
    initials: "AV",
    tone: "bg-av5 text-av5-ink",
    name: "Ananya Verma",
    asked: "Open on Sunday?",
    reply: "Yes, Banjara Hills is open Sunday, 11 am to 8 pm.",
  },
  {
    id: "si",
    initials: "SI",
    tone: "bg-av4 text-av4-ink",
    name: "Sana Iqbal",
    asked: "Where is my order?",
    reply: "Order 1044 left our store at 2 pm and reaches you tomorrow.",
  },
];

const DEMO_TABS = [
  { key: "/app/campaigns", to: "/app/campaigns", label: "Campaigns" },
  { key: "/app/templates", to: "/app/templates", label: "Templates" },
  { key: "/app/cards", to: "/app/cards", label: "Cards" },
];
const DEMO_SECTION: ShellSectionState = {
  section: {
    key: "campaigns",
    label: "Campaigns",
    icon: Megaphone,
    to: "/app/campaigns",
    tabs: DEMO_TABS,
    owns: [],
  },
  activeTab: DEMO_TABS[0]!,
  counts: {},
};

function Block({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className="scroll-mt-6 border-t border-line py-10 first:border-t-0 first:pt-2"
    >
      <h2 id={`${id}-h`} className="font-display text-[1.375rem] font-semibold text-foreground">
        {title}
      </h2>
      <p className="mt-1 max-w-2xl text-body text-muted-foreground">{intro}</p>
      <div className="mt-6 flex flex-col gap-8">{children}</div>
    </section>
  );
}

function Demo({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-w-0">
      <h3 className="mb-3 text-sm font-semibold text-muted-foreground">{title}</h3>
      <div className={className}>{children}</div>
    </div>
  );
}

export function NewDesignSystemPage() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [feedKey, setFeedKey] = useState(0);
  const [typingKey, setTypingKey] = useState(0);

  return (
    <div className="pb-10">
      <header className="mb-6 flex flex-col gap-2">
        <h1 className="font-display text-[clamp(2rem,4.6vw,3.25rem)] font-extrabold leading-[1.02] tracking-[-0.03em] text-foreground [overflow-wrap:break-word]">
          Design system
        </h1>
        <p className="max-w-2xl text-[1.0625rem] text-muted-foreground">
          The new AiDwar design: porcelain, peacock ink, emerald Aiden and gold for what needs you.
          Every screen from Batch 45 on is built from these.
        </p>
      </header>

      <Block
        id="colour"
        title="Colour"
        intro="Tokens only, never a hex in a component. Emerald means Aiden; gold means a person is needed."
      >
        <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4 p-0">
          {SWATCHES.map(([token, name, use]) => (
            <li key={token} className="flex flex-col gap-1.5">
              <span
                aria-hidden="true"
                className="h-16 rounded-[14px] border border-line"
                style={{ background: `var(${token})` }}
              />
              <span className="text-sm font-semibold text-foreground">{name}</span>
              <span className="text-xs text-muted-foreground">
                <code>{token}</code>
              </span>
              <span className="text-xs text-muted-foreground">{use}</span>
            </li>
          ))}
        </ul>
      </Block>

      <Block
        id="type"
        title="Type"
        intro="Bricolage Grotesque for display and numbers, Instrument Sans for everything you read."
      >
        <div className="flex flex-col gap-4">
          <p className="m-0 font-display text-[clamp(2rem,4.6vw,3.25rem)] font-extrabold leading-[1.02] tracking-[-0.03em] [overflow-wrap:break-word]">
            Aiden is replying to 3 customers
          </p>
          <p className="m-0 font-display text-[clamp(1.75rem,3.4vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.03em]">
            Campaigns
          </p>
          <p className="m-0 font-display text-[1.375rem] font-semibold">Diwali drop</p>
          <p className="m-0 font-display text-2xl font-semibold tabular-nums">₹1,84,000</p>
          <p className="m-0 max-w-[44ch] text-[1.0625rem] text-muted-foreground">
            Everything since 9 am is handled. One thing needs you.
          </p>
          <p className="m-0 text-base">Body, 16px: what customers asked and what Aiden said.</p>
          <p className="m-0 text-sm text-muted-foreground">Small, 14px: times, counts and hints.</p>
        </div>
      </Block>

      <Block
        id="shape"
        title="Shape and depth"
        intro="Soft radii, low shadows from one peacock tone."
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5">
          {[
            ["rounded-lg", "11px · buttons, inputs"],
            ["rounded-xl", "15px · menus, rows"],
            ["rounded-2xl", "19px · cards"],
            ["rounded-3xl", "23px · panels"],
          ].map(([r, label]) => (
            <div key={r} className={`flex h-24 items-end bg-surface p-3 shadow-md ${r}`}>
              <span className="text-xs text-muted-foreground">{label!.replace(" · ", ", ")}</span>
            </div>
          ))}
          {["shadow-xs", "shadow-md", "shadow-lg", "shadow-2xl"].map((sh) => (
            <div key={sh} className={`flex h-24 items-end rounded-2xl bg-surface p-3 ${sh}`}>
              <span className="text-xs text-muted-foreground">{sh}</span>
            </div>
          ))}
        </div>
      </Block>

      <Block
        id="buttons"
        title="Buttons and controls"
        intro="One dark primary per view, gold for a decision the owner makes, a line button for the rest."
      >
        <Demo title="Variants" className="flex flex-wrap items-center gap-2">
          <Button>New campaign</Button>
          <Button variant="gold">Yes, ₹1,000 each</Button>
          <Button variant="outline">No discount</Button>
          <Button variant="soft">Try Aiden in draft mode</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="destructive">Delete</Button>
          <Button disabled>Sending</Button>
        </Demo>
        <Demo title="Sizes" className="flex flex-wrap items-center gap-2">
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
        </Demo>
        <Demo title="Fields, chips and tabs" className="flex max-w-md flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nd-msg">Message</Label>
            <Input id="nd-msg" placeholder="Type a message, or / for templates" />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="nd-switch" defaultChecked />
            <Label htmlFor="nd-switch">Aiden replies on his own</Label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="warning">Repeat buyer</Badge>
            <Badge variant="success">Opted in</Badge>
            <Badge variant="outline">Scheduled</Badge>
          </div>
          <Tabs defaultValue="waiting">
            <TabsList>
              <TabsTrigger value="waiting">Waiting for you</TabsTrigger>
              <TabsTrigger value="aiden">Aiden on it</TabsTrigger>
              <TabsTrigger value="done">Done</TabsTrigger>
            </TabsList>
            <TabsContent value="waiting" className="text-sm text-muted-foreground">
              Chats where a customer is waiting for a person.
            </TabsContent>
            <TabsContent value="aiden" className="text-sm text-muted-foreground">
              Chats Aiden is answering.
            </TabsContent>
            <TabsContent value="done" className="text-sm text-muted-foreground">
              Finished chats.
            </TabsContent>
          </Tabs>
        </Demo>
      </Block>

      <Block
        id="page-header"
        title="Page head"
        intro="A section's name, its sub-tabs and the page's main action. The new shell fills the tabs in."
      >
        <ShellSectionContext.Provider value={DEMO_SECTION}>
          <PageHeader
            title="Campaigns"
            description="Messages you send to many customers at once."
            actions={<Button>New campaign</Button>}
          />
        </ShellSectionContext.Provider>
      </Block>

      <Block
        id="aiden"
        title="Aiden and live work"
        intro="Motion only where something is happening: Aiden working, a reply arriving, something waiting."
      >
        <Demo title="Aiden's orb" className="flex flex-wrap items-center gap-10">
          {(
            [
              ["replying", "Replying: rings go out"],
              ["draft", "Drafts: calm breathing"],
              ["off", "Off, your team answers"],
            ] as const
          ).map(([state, label]) => (
            <figure key={state} className="m-0 flex flex-col items-center gap-2">
              <AidenOrb state={state} label={`Aiden ${state}`} />
              <figcaption className="text-sm text-muted-foreground">{label}</figcaption>
            </figure>
          ))}
        </Demo>

        <div className="grid gap-8 wide:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
          <Demo title="Animated list (newest on top)">
            <AnimatedList key={feedKey} delay={900}>
              {FEED.map((f) => (
                <div
                  key={f.id}
                  className="flex items-start gap-3.5 rounded-[18px] border border-line bg-surface px-4 py-3.5 shadow-md"
                >
                  <span
                    className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold ${f.tone}`}
                  >
                    {f.initials}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 font-bold">{f.name}</p>
                    <p className="m-0 text-[0.9375rem] text-muted-foreground">{f.asked}</p>
                    <p className="m-0 mt-2 rounded-[14px] rounded-bl-[4px] bg-bubble-out px-3 py-2 text-[0.9375rem]">
                      <span className="block text-[0.8125rem] font-bold text-aiden-deep">
                        Aiden
                      </span>
                      {f.reply}
                    </p>
                  </div>
                </div>
              ))}
            </AnimatedList>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setFeedKey((k) => k + 1)}
            >
              Play again
            </Button>
          </Demo>

          <div className="flex flex-col gap-8">
            <Demo title="Needs you">
              <NeedsYouCard
                title="Needs you"
                actions={
                  <>
                    <Button variant="gold">Yes, ₹1,000 each</Button>
                    <Button variant="outline">No discount</Button>
                  </>
                }
              >
                <p>
                  <b>Priya Reddy</b> wants ₹2,000 off the Kundan jhumkas if she buys both today.
                </p>
              </NeedsYouCard>
            </Demo>
            <Demo title="Number ticker" className="flex flex-col">
              {[
                ["Chats", 41, ""],
                ["Answered by Aiden", 38, ""],
                ["Sales from chats", 184000, "₹"],
              ].map(([label, n, prefix]) => (
                <div
                  key={label as string}
                  className="flex items-baseline justify-between border-b border-line py-2.5 last:border-b-0"
                >
                  <span className="text-muted-foreground">{label}</span>
                  <NumberTicker
                    value={n as number}
                    prefix={prefix as string}
                    className="font-display text-2xl font-semibold"
                  />
                </div>
              ))}
            </Demo>
            <Demo title="Countdown ring" className="flex items-center gap-3.5">
              <CountdownRing remaining={100} label="1 hour 40 minutes left" />
              <p className="m-0 text-body">
                3 chats lose their free 24-hour window in under 2 hours.
              </p>
            </Demo>
          </div>
        </div>

        <Demo title="Typing text">
          <p className="m-0 max-w-xl rounded-[14px] rounded-bl-[4px] bg-bubble-out px-3 py-2 text-[0.9375rem]">
            <span className="block text-[0.8125rem] font-bold text-aiden-deep">Aiden</span>
            <TypingText key={typingKey}>
              The temple gold set at ₹1,28,000 is our most loved. Shall I send photos?
            </TypingText>
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => setTypingKey((k) => k + 1)}
          >
            Type again
          </Button>
        </Demo>

        <Demo title="Avatars and arrival" className="flex flex-wrap items-center gap-6">
          <AvatarCircles
            people={[
              { initials: "PR", name: "Priya Reddy", tone: 1 },
              { initials: "RK", name: "Rahul Kapoor", tone: 2 },
              { initials: "NM", name: "Neha Menon", tone: 3 },
            ]}
            more={4}
          />
          <BlurFade inView>
            <p className="m-0 text-body text-muted-foreground">
              This line fades up when it scrolls into view.
            </p>
          </BlurFade>
        </Demo>
      </Block>

      <Block
        id="whatsapp"
        title="WhatsApp"
        intro="Chats and previews as the customer sees them: their messages on white, yours in mint."
      >
        <div className="grid gap-8 wide:grid-cols-[minmax(0,1fr)_auto]">
          <Demo title="Bubbles">
            <div className="nd-wall flex flex-col gap-2.5 rounded-[22px] border border-line p-4 wide:p-7">
              <WhatsAppBubble from="in" time="8:44">
                Hi, do you have the Kundan jhumkas from your Diwali post?
              </WhatsAppBubble>
              <WhatsAppBubble from="out" sender="Aiden" time="8:44" ticks="read">
                Yes Priya, 2 pairs left. Here they are:
              </WhatsAppBubble>
              <ProductBubble title="Kundan jhumkas, 22K" detail="₹24,500, 2 in stock" />
              <WhatsAppBubble from="in" time="8:51">
                Can you do ₹2,000 less? I&rsquo;ll take both today.
              </WhatsAppBubble>
              <WhatsAppBubble from="system">
                Aiden paused: discounts need you. He told Priya he&rsquo;s checking with the owner.
              </WhatsAppBubble>
            </div>
          </Demo>
          <Demo title="Phone">
            <PhoneFrame>
              <PhoneMessage
                image={
                  <span
                    aria-hidden="true"
                    className="block h-[150px] bg-gradient-to-br from-av5-ink to-av1-ink"
                  />
                }
                text="Hi {{name}}, our Diwali collection is here. 22K temple jewellery, made in Hyderabad."
                buttons={["View collection", "Talk to us"]}
              />
            </PhoneFrame>
          </Demo>
        </div>
      </Block>

      <Block
        id="sheet"
        title="Bottom sheet"
        intro="On a phone, More and other short choices rise from the bottom."
      >
        <div>
          <Button variant="outline" onClick={() => setSheetOpen(true)}>
            Open a bottom sheet
          </Button>
          <BottomSheet open={sheetOpen} onOpenChange={setSheetOpen} title="More">
            {["Automate", "Shop", "Settings", "Billing and wallet", "Team"].map((label) => (
              <button
                key={label}
                type="button"
                className={sheetRowClass}
                onClick={() => setSheetOpen(false)}
              >
                {label}
              </button>
            ))}
          </BottomSheet>
        </div>
      </Block>
    </div>
  );
}
