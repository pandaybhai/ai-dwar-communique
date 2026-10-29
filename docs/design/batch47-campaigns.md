# Campaigns, Templates, Cards in the new design (Batch 47)

Section notes for `docs/design/spec.md` (kept in this file while Batches 48 to
50 edit the spec in parallel; fold it in once they land). The approved look is
`docs/design/preview.html#campaigns`; with `new_design` off every screen here is
the Batch 41 one, unchanged (`src/lib/batch47-campaigns.test.tsx` pins it).

## Campaigns (`/app/campaigns`, `/app/campaigns/$id`)

`src/components/campaigns-v2/`. Three columns over 1000px: the list (300px),
the chosen campaign's results, its message on a PhoneFrame (260px). At 1000px
and under the list comes first; a campaign opens full width at
`/app/campaigns/$id` with "All campaigns" to go back, and its phone sits under
the numbers, before the timeline and recipients.

| Block | Where it comes from |
| --- | --- |
| List | `campaigns` for the workspace, newest first (the Batch 41 list's read), every 5 s |
| Bars on a row | delivered, read, replied as a share of the audience; a campaign that hasn't sent shows its status tag instead |
| Second line | the campaign's own status and timestamps, in the workspace's timezone |
| Funnel | `sent_count`, `delivered_count`, `read_count`, `replied_count`; each bar a share of `total_recipients` (Batch 41's rule) |
| Cost | `charged_amount`, else `estimated_cost` labelled "Estimated cost"; nothing when billing is off |
| Sales from this campaign | `revenue_attributions` with `source_type = 'campaign'` for it (needs `revenue_attribution` and `analytics.view`); left out when there are none, more than one read returns, or more than one currency |
| Failed, coupon numbers | the row's `failed_count`; the Batch 41 offer reads when the campaign carried a code |
| Timeline, recipients | the Batch 41 results page's timeline rules and recipients read (status filters, phone search, 20 a page) |
| Phone | the template's stored components (`message_templates` by name, language and the sending number's WABA), the campaign's own header file and card codes from `send_settings`, `{{n}}` shown as what fills it (`{{name}}`, `{{city}}` or the fixed text) |

Pause, resume, cancel and approve are the results page's own
`/api/campaigns/control` request. "New campaign" (and N, and the palette) opens
the Batch 41 wizard.

## Wizard

Same component (`campaign-wizard.tsx`), same steps, checks, estimate, Batch 35
test send and `/api/campaigns/launch`. With the flag on it draws a numbered
stepper (Audience, Message, Personalise, Test send, Review and cost; Launch is
the last button), the message on a PhoneFrame (`TemplatePhone`) and the cost
card (`NdCostPanel`) beside every step, and commas instead of middle dots.

## Templates (`/app/templates`)

`src/components/templates-v2/`. Starter cards (blank; invoice or receipt with a
PDF) open the Batch 41 editor preloaded (its `start` prop). The gallery is one
small phone per template with its review state (Approved, In review, Rejected,
or Meta's own word for paused ones) and Meta's reason on a rejected one;
search, number and state filters; Sync with Meta is the Batch 41 per-number
sync with its 10-minute auto-sync. The editor keeps its form, Batch 35
toolbar and variable chips (pills under the flag) and submits through its one
`/api/whatsapp/templates` create request; with the flag on its preview is a
PhoneFrame. There is no delete path for templates today, so the gallery has
none.

## Cards (`/app/cards`)

`src/components/cards-v2/`. The five designs first, each as the renderer draws
it on a chat wall (Preview / Draw again), then the brand paint and where cards
go with the product-cards switch. Every request is the Batch 41 page's own
`/api/cards` action.
