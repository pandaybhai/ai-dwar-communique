# Batch 57 copy: Customers (Contacts, Groups, Sales from chats, drawer, import)

Every visible word of these screens now lives in
`src/components/customers-v2/copy.ts` (plain objects, counts as functions), so a
Hindi pass can follow. Aiden Workspace only; Classic is untouched.

| Where | Before | After |
| --- | --- | --- |
| Contacts, page line | Everyone who has your number: tags, opt-in, their last chat and what they bought. | Everyone who has messaged you on WhatsApp or been added by your team, with their tags, last chat and what they bought. "Said yes" means they agreed to get messages from you. |
| Contacts, opt-in chip | Opted in / Not yet / Opted out | Said yes / No answer yet / Said no |
| Contacts, + Filter menu | Opt-in | Said yes to messages? |
| Contacts, + Filter menu | Saved segment | Group |
| Contacts, filter chips | Opted in; Bought in last 90 days; Segment: VIP | Said yes to messages; Bought in the last 90 days; Group: VIP |
| Contacts, header buttons | Import / Add customer | Import a list / Add a customer |
| Contacts, toolbar | Export CSV / Exporting… | Download list / Preparing your file… |
| Contacts, empty list | No customers yet. Import your customers to start reaching them, or add your first one by hand. | Your customers will show up here. Everyone who messages you on WhatsApp is added here on their own. Have a list in Excel? Save it as CSV and import it to bring everyone in at once. (one step: Import a list) |
| Contacts, nothing matches | No customers match these filters. | No one matches these filters. Try another name or number, or remove a filter to see everyone again. (Show everyone) |
| Contacts, load error | We couldn't load your contacts. Please try again. | Couldn't load your customers. Check your internet and tap Try again. (with Try again) |
| Contacts, row | Unnamed customer / Last chat now | No name yet / Last chat just now |
| Bulk bar | Add tag / Mark as opted in / Send campaign | Add a tag / Mark as said yes / Send them a campaign |
| Bulk bar, note | Opted-out customers stay opted out. | Anyone who said no stays a no. |
| Bulk bar, toasts | Everyone selected already has "VIP". / We couldn't add that tag. | Everyone you ticked already has "VIP". / Couldn't add that tag. Check your internet and try again. |
| Groups, page line | Segments update themselves: build the rules once and the audience stays fresh. Campaigns pick a segment as their audience. | A group is a set of customers sorted by rules, like a tag or what they bought. It keeps itself up to date as customers change, and a campaign can go to just one group. |
| Groups, main button | New segment / Create your first segment | Make a group / Make your first group |
| Groups, empty | No segments yet. Group your customers by tag, opt-in status or anything you've imported, then reach exactly the right people. | Your groups will show up here. Sort customers by a tag, whether they said yes to messages, or anything you imported. Then send a campaign to just those people. |
| Groups, card | All rules / Any rule / No description / Duplicate | Matches every rule / Matches any rule / No note added / Make a copy |
| Groups, delete | Delete this segment? Your contacts stay exactly as they are. / Delete | Delete this group? The customers in it stay exactly as they are. / Delete group |
| Groups, toasts | Segment deleted. / We couldn't delete this segment. | Group deleted. / Couldn't delete this group. Check your internet and try again. |
| Sales from chats, tiles | Message charges incl. tax | Message cost with tax |
| Sales from chats, table | Revenue / Spent / Incl. tax / Per ₹1 spent | Sales / Cost / With tax / Back per ₹1 |
| Sales from chats, notes | Nothing billable yet / Cost data incomplete | No cost yet / Some costs not known yet |
| Sales from chats, help line | Tax is added at 18%; change that in Settings. | We add 18% tax (change it in Settings). |
| Sales from chats, empty | Nothing sent in this period. Send a campaign or switch on a flow, and its earnings and costs will appear here. | No sales from chats in these dates. Send a campaign or switch on a flow, and what it earned and what it cost will show up here. Or pick other dates above. |
| Sales from chats, error | (the fetcher's raw message) | Couldn't load your sales from chats. Check your internet and tap Try again. |
| Sales from chats, toolbar | All numbers / Export CSV | All WhatsApp numbers / Download report |
| Drawer summary, headings | Chat history / Consent / Aiden knows / Flows | Last chat / Messages from you / What Aiden knows / Automatic flows |
| Drawer summary, consent | They opted out. Only they can opt back in, by replying START. / No answer yet. Campaigns reach them once they opt in. | They said no to messages. Only they can change that, by replying START. / No answer yet. Campaigns reach them once they say yes to messages. |
| Drawer summary, question | Asked: "…" | Waiting for your answer: "…" |
| Drawer summary, orders | Spent ₹4,200 over 1 orders. | Spent ₹4,200 over 1 order. |
| Notes | Notes / Add a note for your team / No notes yet. Only your team sees them. | Team notes / Write something your team should know, like a size or a good time to call / No notes yet. Only your team sees notes; Aiden doesn't read them. |
| Notes, errors | We couldn't save that note. Please try again. / We couldn't load notes. Please try again. | Couldn't save that note. Check your internet and tap Add note again. / Couldn't load notes. Check your internet and tap Try again. (with Try again) |
| Import, steps | Upload / Columns / Confirm | Upload / Match / Import |
| Import, upload | Drop your CSV here. Up to 10,000 rows. A phone column is needed. | Drop your CSV file here. Up to 10,000 rows, with one column of phone numbers. From Excel, use Save as CSV. |
| Import, columns | Custom attribute / Phone (required) / Exclude this column / Match one column to Phone to continue. | Extra detail / Phone number (needed) / Leave this column out / Pick the column with phone numbers to continue. |
| Import, confirm | Start import | Import 240 rows |
| Import, consent line (meaning kept) | They'll be marked opted in. Anyone who replied STOP stays opted out. | They'll be marked as said yes to messages. Anyone who replied STOP stays marked as said no. |
| Import, done | Import complete / Created / Download error report | All done. Your customers are in. / Added / Download the skipped rows |

## Polish done

- One copy file (`copy.ts`); the helpers in `customers-v2.ts` (chips, last chat,
  flow runs, import steps, the ₹-back ratio) read their words from it.
- Illustrated `EmptyState` for every empty list: contacts (`art="people"`, one
  step: Import a list), nothing-matches (Show everyone), groups (`art="people"`,
  Make your first group), sales from chats (plain, no button).
- Shimmer skeletons in each block's own shape: the contacts list (avatar + two
  lines), group cards, the sales tiles (first load only; a refresh dims the
  numbers instead of blanking them), the drawer's notes (was a spinner).
- `NumberTicker` (counts once): sales-from-chats tiles (rupee amounts and
  orders; paise and other currencies stay static so the final text equals
  `money()`), each group's customer count, "Where your customers come from"
  counts, the import's Added / Updated / Skipped.
- `nd-rise` staggered entrances: contacts toolbar, list, sources; group cards;
  sales toolbar, tiles, table, revenue panel; drawer summary and notes; each
  import step. New notes slide in (tw-animate, `motion-reduce:animate-none`).
- `nd-lift` on the phone's customer cards (press feedback).
- Phone: "Make a group" pinned above the bottom bar with `StickyAction` (page
  gets `phone:pb-20`); 44px tap targets on every control these files own
  (buttons `phone:h-11`, filter chips, search, selects; the 16px tick boxes and
  the chip's remove "x" get a 44px invisible tap area via `after:`).
- `ErrorState` with `onRetry` on contacts, groups and sales from chats.

## Decisions

- Opt-in in plain words: **Said yes / No answer yet / Said no** (the preview's
  "said no to offers" tone). The page line explains "Said yes" the first time.
  The column header stays "Messages".
- "Segment" is **Group** in visible text only; `?tab=segments`, tables, code
  names and the hand-picked segment's saved name/description are unchanged.
  "Picked by hand" stays (it matches `describeCondition` in the shared lib).
- The empty contacts list's one step is now **Import a list** (audit 5.1);
  "Add a customer" stays in the page head. Without import permission the empty
  state falls back to Add a customer, as before.
- New "Show everyone" button on the nothing-matches state only clears the
  search and filters (local state; no read or write of its own beyond the
  list's normal reload).
- Sales from chats' error now shows our own sentence, not the fetcher's raw
  message. The CSV's "All numbers" label is unchanged (it is the file's data).
- Contacts has two equal header actions (Import, Add) and a sticky bulk bar,
  so it gets no `StickyAction`; only Groups (one clear action) does.
- Sales from chats' empty state has no button: the next step (send a campaign
  or switch on a flow) is said in words, so no new permission-dependent link.
- Import's "Import N rows" counts rows, not customers (bad or duplicate rows
  are skipped later). The import consent box (`IMPORT_CONSENT_LABEL` /
  `_HELPER`) is the classic text, untouched; the line under it keeps its
  meaning in the new words.

## Not done (classic or shared components, out of this slice)

- `MarkAllUnknownOptedIn` ("Mark all unknown as opted in", audit 5.3), the
  classic `ContactDrawer`, `SegmentBuilderDialog`, `DateRangePicker` and the
  shared `Pagination` keep their words and sizes (Pagination's buttons are
  under 44px on a phone). They are pinned or shared with Classic.
- The drawer's spring (audit 5.4) is the classic Sheet's animation.
