# Batch 57 copy: Campaigns, Message designs, Cards (Aiden Workspace)

Every visible string of these screens now lives in one file per screen:
`src/components/campaigns-v2/copy.ts`, `src/components/templates-v2/copy.ts`,
`src/components/cards-v2/copy.ts` (plain objects, plurals as functions).
Classic is untouched. Routes (`/app/templates`, `/app/cards`), code names and
API names don't change.

| Where | Before | After |
| --- | --- | --- |
| Campaigns, page line | One message to many customers, and how far it got: sent, delivered, read and replied. | Send one message to many customers, then see how far it got: sent, delivered, read and replied. |
| Campaigns, empty title | No campaigns yet | Send your first campaign |
| Campaigns, empty line | Pick who gets it, choose an approved template, and reach every opted-in customer in one go. | Pick who gets it and an approved message design. It goes to every customer who said yes to offers, in one go. |
| Campaigns, empty button | Create your first campaign | Start a campaign |
| Campaigns, list error | We couldn’t load your campaigns. Please try again. | Couldn’t load your campaigns just now. Tap Try again. (with a Try again button) |
| Campaign, not found | We couldn’t find this campaign. | Couldn’t open this campaign. It may have been removed, or the connection dropped. Tap Try again. (with a Try again button) |
| Campaigns off, page line | Reach every opted-in customer with one message. | Reach every customer who said yes to offers with one message. |
| Campaigns off, body | This feature isn’t enabled for your workspace yet. Reach out to your administrator to switch it on. | Campaigns aren’t switched on for your workspace yet. Ask your administrator to turn them on. |
| List row, awaiting approval | To 240 people | To 240 customers |
| List row, failed | Could not send | Couldn’t send |
| Results, cancel button | Cancel | Cancel campaign |
| Results, approve toast | Approved, sending starts now. | Approved. Sending starts now. |
| Results, paused for credits | Paused: not enough credits for the rest of this campaign. Add credits, then resume. | Paused because your credits ran out. Add credits, then tap Resume to send the rest. |
| Results, failed figure | Failed | Couldn’t send |
| Results, failed note | 2% of the audience | 2% of everyone you picked |
| Results, funnel (screen reader) | , 98% of the audience | , 98% of everyone you picked |
| Results, timeline heading | Timeline | What happened |
| Results, recipients heading | Recipients | Who got it |
| Results, phone search | Search by phone | Search by phone number |
| Results, no match | No recipients match. Try another status or number. | Nobody matches. Try another status or phone number. |
| Results, none yet | No recipients yet. | Nobody here yet. People show up as the campaign sends. |
| Results, table column | Detail | Note |
| Results, phone caption | The template diwali_offer isn’t in your library any more. | The message design “diwali_offer” isn’t in your library any more. |
| Wizard cost panel | This send costs about ₹211.20 | Cost ₹211.20 (a row, as the approved summary) |
| Wizard cost panel | 240 will receive it | Who gets it: 240 customers |
| Wizard cost panel | (none; the count sat only in the audience step as "18 excluded (not opted in)") | Skipped (haven’t said yes to offers): 18 |
| Wizard cost panel | ₹0.88 a message, and you have ₹2,000 in credits. | An estimate, about ₹0.88 a message. + Your wallet after this: ₹1,788.80 |
| Wizard cost panel, short | You’re short ₹111.20. Add credits to send this campaign. | Your wallet is ₹111.20 short. Add credits, then send. |
| Wizard cost panel, approval | Above your approval limit: it waits for an owner to approve it before anything sends. | This is above your approval limit, so it waits for an owner to approve it. Nothing sends before that. |
| Wizard cost panel, empty | Pick a template to see the cost. | Pick a message design to see the cost. |
| Wizard footer line | 240 people, about ₹211.20 | 240 customers, about ₹211.20 |
| Templates, name and line | Templates: Messages Meta has approved, which you can send any time, even after the 24-hour window. Meta usually reviews a new one within minutes. | Message designs: WhatsApp approves these before you can send. Once approved, a design can go out any time, even after the 24-hour reply window. A new one is usually reviewed within minutes. |
| Templates, sync button | Sync with Meta / Sync this number | Refresh from WhatsApp / Refresh this number |
| Templates, sync toast | Templates synced from Meta. | Message designs updated from WhatsApp. |
| Templates, starters | Start from; A blank template | Start a new one; A blank design |
| Templates, empty | No templates yet. Start one above and submit it for review, or sync the ones already approved on your business account. | No message designs yet. Start one and send it to WhatsApp for approval. Already have approved ones on your business account? Tap Refresh from WhatsApp. (button: Start a blank design) |
| Templates, no match | No matching templates | Nothing matches (button: Show all) |
| Templates, search | Search templates | Search message designs |
| Templates, error | We couldn’t load your templates. Please refresh. | Couldn’t load your message designs just now. Tap Try again. (with a Try again button) |
| Templates, tile menu and dialog | Delete template | Delete message design |
| Cards, page line | Branded picture cards that go with your campaigns, flows and Aiden’s answers. Set your logo and colours once; every card wears them. | Cards are branded pictures that go out with your campaigns, flows and Aiden’s answers. Set your logo and colours once and every card uses them. |
| Cards, designs heading | The five designs | The five cards |
| Cards, not drawn | Not drawn yet | Tap Preview to see it |

Unchanged on purpose: the review states (Approved, In review, Rejected, Meta's
own word for a paused one), Meta's categories on a tile, "Meta’s reason:", the
delete dialog's 30-day name rule, the funnel's Sent / Delivered / Read /
Replied, every amount and how it is worked out, everything inside a message
preview (template-phone.tsx: "Ends in", "Offer ended", "Copy code"), and the
classic wizard's own words (its step titles, "Launch campaign").

## Polish done

- Results numbers count up once (NumberTicker): the funnel (already), and now
  the cost, sales, failed and coupon figures. Money ends on exactly the text
  `wholeMoney` gives; any amount the ticker can't end on exactly (another
  currency) stays plain text.
- Entrances: `nd-rise` (400ms, 70ms stagger) replaces the 500ms
  `nd-slide-in` on the campaign list, the template tiles and the five cards;
  the results block, its phone and the timeline/recipients rise in that order
  when a campaign opens (once per campaign, not on the 5-second refresh).
- `nd-lift` on the campaign rows (on the link; the rise sits on a wrapper, so
  neither animation overrides the other) and on the template starters.
- Shimmer skeletons everywhere loading shows (the shared Skeleton); illustrated
  EmptyState with one next step for empty campaigns and empty message
  designs; ErrorState with Try again on the list, a campaign and the gallery.
- Phone (390px): "New campaign" in StickyAction above the bottom bar once a
  list exists (spacer under the list so nothing hides behind it); 44px
  targets on phones for the results controls, recipient and review-state
  chips, searches, number picker, "All campaigns", tile menus, Preview and
  Save branding.

## Decisions

- **"Skipped (haven’t said yes to offers)"**, not the preview's "said no to
  offers": the count is `audience.excluded` = matched minus opted in, which
  includes customers who never answered, not only those who said no.
- **"Your wallet after this"** = the estimate's own `available` less its own
  `estimate` (both from `/api/campaigns/estimate`, rounded to paise), shown
  only while billing is on and the wallet covers it; when short, the
  shortfall line shows instead. Nothing new is priced.
- **Cost row says "An estimate"** under it, since the wizard's figure is the
  estimate (the final charge follows the ledger).
- **Stepper labels kept** (Audience ... Review and cost): short, and tests pin
  them.
- **nd-lift only on clickable things.** Template tiles and card tiles aren't
  links or buttons (their actions are the menu and Preview), so a hover lift
  would promise a click that does nothing; the clickable starters and
  campaign rows lift instead.
- **Two new buttons call existing state only:** "Start a blank design" in the
  empty gallery does what the blank starter does (`setStart`), and "Show all"
  clears the gallery's search and filters. No request changes.
- **Not mine to change:** the wizard's final "Launch campaign" button, its
  confirm and success handling (`launch()` / `onLaunched` in
  `src/components/campaigns/campaign-wizard.tsx`, a classic file).
