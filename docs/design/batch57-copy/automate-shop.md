# Batch 57 copy: Automate (Aiden, Flows, Automations) and Shop (Catalogue, Collections)

All visible strings of the new screens now live in `src/components/automate-v2/copy.ts`
and `src/components/shop-v2/copy.ts` (plurals are functions), ready for a Hindi pass.
Mode names Off / Drafts / Replying, WhatsApp policy words ("24-hour window"),
billing amounts and costs, permission names ("Use AI", "Configure AI") and the
classic screens' own toasts are unchanged.

| Where | Before | After |
| --- | --- | --- |
| Aiden page, description | Aiden is your teammate on WhatsApp: what Aiden is doing, what Aiden knows, and a test chat to try Aiden first. | Your teammate on WhatsApp. See what Aiden is doing, teach the answers Aiden doesn't know yet, and try a test chat first. |
| Aiden page, no permission | The AI employee is restricted | You can't see Aiden yet |
| Status card, Replying | Aiden answers customers on WhatsApp and passes anything unsure to you. | I answer your customers on WhatsApp and pass anything I'm unsure about to you. |
| Status card, Drafts | Aiden drafts a reply for each customer. Nothing goes out until someone on your team sends it. | I'll write replies and you send them. You're always in control. |
| Status card, Off | Your team answers every message. Aiden sends nothing and drafts nothing. | Your team answers every message. I don't send or draft anything. |
| Status card, switched off | Aiden won't answer, draft or even test until AI is turned on for this workspace. | I can't answer, draft or even test until AI is turned on for your workspace. |
| Mode list, Drafts | Aiden writes replies, you read and send them. | I write each reply, you read it and send it. |
| Mode list, Replying | Aiden replies to customers and passes anything unsure to you. | I reply to customers and pass anything I'm unsure about to you. |
| Status card, AI off box | AI is switched off for this workspace. Turn it on to choose Drafts or Replying. | AI is off for your workspace. Turn it on, then pick Drafts or Replying. |
| Status card, not tested | You haven't tried Aiden yet. Ask your last 20 real customer questions before letting Aiden reply alone… | You haven't tried me yet. Before I reply on my own, test me with real customer questions: use Test Aiden below, or compare two setups under Try me. |
| Status card, view only | You can see everything Aiden does. Changing how Aiden works needs the "Configure AI" permission. | You can see everything I do. To change how I work you need the "Configure AI" permission. Ask the shop owner. |
| Needs your answer, empty | Nothing waits on you. When Aiden can't answer a customer, the question lands here… | Nothing is waiting on you. When I can't answer a customer, I'll bring the question here. Answer it once and I'll remember it. [See my answers this week] |
| Needs your answer, gold card | 3 questions Aiden couldn't answer | 3 customer questions I couldn't answer |
| Needs your answer, gold card line | Aiden kept each chat going and noted the question. Answer once… | I kept each chat going and saved the question. Answer it once: if the chat is still open, your answer goes to the customer now, and I'll remember it for next time. |
| Needs your answer, button | Dismiss | Skip this one |
| Needs your answer, button | See all 7 | See all 7 questions |
| Answers to check, line | This week Aiden passed these on or didn't answer. Teach the right answer and Aiden uses it from now on. | This week I passed these on to you or didn't answer. Teach me the right answer and I'll use it from now on. |
| Answers to check, saved | Aiden uses your answer from now on. | Got it. I'll use your answer from now on. |
| Test Aiden, line | Ask what a customer might. Nothing here reaches a customer. | Ask me anything a customer might. Nothing here goes to a real customer. |
| Test Aiden, waiting | Thinking… | (typing dots, read out as "Aiden is typing") |
| Test Aiden, suggestions | Real questions customers asked | Try a question your customers really asked |
| Tabs intro | The job, the knowledge, the rules for handing over, the brain and tools, and every answer given. | My job, what I know, when I hand a chat to you, my brain and tools, and every answer I've given. |
| Flows, description | Menus, questions and follow-ups that run on WhatsApp by themselves, plus your store's automatic messages. | A flow is a chat that runs by itself, step by step: a menu, a few questions, a follow-up. Your store's automatic messages live here too. |
| Flows, not on | This isn't switched on for you yet | Flows aren't on for you yet |
| Chat flows, error | We couldn't load your chat flows. Refresh to try again. | Couldn't load your flows. Check your internet and tap Try again. [Try again] |
| Chat flows, empty | No chat flows yet. Build menus, questions and hand-offs that run on their own, no AI needed. | Your chat flows will show up here. A flow is a chat that runs by itself: a menu, a few questions, then a hand-over to your team. No AI needed. Start from a ready-made one and change the words. |
| Flow card, button | Open builder | Edit flow |
| Flow card, runs | 12 responses, last 3 hr ago | Used 12 times, last 3 hr ago (number counts up) |
| Flow card, no trigger | No trigger yet | Nothing starts it yet |
| Flow card, triggers off | Its triggers are switched off | What starts it is switched off |
| New flow dialog | Start from a template | Start from a ready-made flow |
| Run history, hint | Pick another flow's Run history to switch. | Tap Run history on another flow to see its customers. |
| Run history, empty | Welcome menu hasn't run for anyone yet. Runs show up here as customers go through it. | Nobody has gone through Welcome menu yet. Each customer's steps show up here once it runs. |
| Run history, error | The run history didn't load. Refresh to try again. | Couldn't load the run history. Check your internet and tap Try again. [Try again] |
| Run step, failure | Failed at … | Stopped with a problem at … |
| Builder step, stats tooltip | entered, moved on, dropped | Customers who reached this step, moved on, and stopped here |
| Automations, description | Welcome messages, keyword replies and off-hours cover: one reply per message, always. | Automations are instant replies that go out by themselves: a welcome for new customers, answers to keywords, and a note when you're closed. One reply per message, never more. |
| Automations, error | We couldn't load your automations. Please try again. | Couldn't load your automations. Check your internet and tap Try again. [Try again] |
| Automations, empty | No automations yet | Your automations will show up here. … A welcome message is a good first one. |
| Automations, group | Off-hours / Replies outside your working hours, at most once per contact every 4 hours. | Off-hours replies / Goes when you're closed, at most once every 4 hours per customer. |
| Automations, delete dialog | … will stop replying immediately and its run history will be removed. This can't be undone. | … stops replying straight away and its history is removed. You can't undo this. |
| Catalogue, description | Everything you sell: names, prices, photos and details, read from your website or store, uploaded or added by hand. Aiden uses them to answer customers and show the right pieces. | Everything you sell, with names, prices and photos. Read from your website or store, uploaded, or added by hand. Aiden uses this list to answer customers and show the right products. |
| Catalogue, gates | Products are turned off / You don't have access to Products | The catalogue isn't on for your workspace yet / You don't have access to the catalogue |
| Catalogue, no collections | No collections yet. Make one | No collections yet. A collection is a group of products you can send in one go. Make one |
| WhatsApp shop preview | Tap a piece to see it, or add it to your cart. | Tap a product to see it, or add it to your cart. |

## Polish done

- NumberTicker on Aiden's three tiles (answered, passed, cost this month; the cost ends on exactly
  `moneyText`'s text for INR, other currencies show `moneyText` as before), the catalogue counts
  (already ticking) and each flow card's run count.
- `nd-rise` staggered entrances: Aiden's status card, Needs your answer, Test Aiden, What Aiden knows,
  the weekly report; flow cards and run history entries; automation groups; catalogue blocks;
  collection cards.
- `nd-lift` on the flow cards (on an inner wrapper so the entrance's fill doesn't hold the hover
  transform) and on the ready-made flow choices in the New chat flow dialog.
- Shimmer skeletons (shared `Skeleton`) in each block's own shape instead of pulse boxes or a generic
  page skeleton: Aiden page, Needs your answer, chat flows, run history, a flow card's run count,
  automations, catalogue overview, collection cards.
- Illustrated `EmptyState` (orb) for empty chat flows, deleted flows, automations and Aiden's Needs
  your answer (with one next step). ErrorState with Try again (re-runs the same read) on chat flows,
  run history and automations.
- Test Aiden shows TypingDots while Aiden answers.
- Hierarchy on the Aiden page: tighter gaps (40 to 32px between blocks), the status card then Needs
  your answer lead the left column.
- Phone (390px, checked with the b49 fake-backend screenshots: no horizontal overflow, no console
  errors): "New chat flow" and "New automation" pinned above the bottom bar with `StickyAction`
  (with room left under the page); buttons, chips, the mode switch and icon buttons are 44px tall on
  phones; focus-visible added to the remaining links.

## Decisions

- Mode names Off / Drafts / Replying, the Employee page's tab names and its test-gate dialog stay word
  for word. Status headings ("Aiden is replying to customers") stay in third person because they are
  the app labelling Aiden; the lines under them and everything Aiden says are first person.
- Toasts inside code that must stay the classic code (Automations' toggle and delete, the Teach
  toasts the test pins, "Saved. It will use your answer from now on.") stay inline and unchanged.
- No second empty state for an empty catalogue or no collections: the classic CatalogView and
  CollectionsView below already render the shared EmptyState, which is illustrated in Aiden
  Workspace and holds the real Add / Upload / New collection actions. The overview hides its row of
  zero counts instead.
- Collection cards get the entrance but no hover lift: they are not clickable, and a lift would
  promise a click that does nothing.
- "Template" is not used for ready-made flows ("Start from a ready-made flow"), because "template"
  means a WhatsApp message design elsewhere.
- "Flow", "automation" and "trigger" are explained the first time in the page lines; flow cards say
  "Used 12 times" instead of "responses" or "runs".
