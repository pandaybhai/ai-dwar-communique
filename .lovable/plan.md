# WhatsApp Forms + "Aiden collects"

Phase A is built and published first, and checked end to end. Phase B follows the same way.

## What each phase touches (nothing else changes)

**Phase A — Forms**
- New tables: `wa_forms`, `wa_form_responses`. Org members can read them. Only people with `ai.configure` or the owner can write. Every insert is checked against org membership.
- New feature flag `wa_forms`. New activity actions (`form_created`, `form_published`, `form_sent`, `form_submitted`) are added to the feature registry.
- AI employee page (`app/employee.tsx`): a new "Forms" tab (component `employee/forms-manager.tsx`). The other tabs stay as they are.
- New `lib/wa-forms.ts`: field model, Flow JSON generator (current version 7.x) and the 4 starter templates. New `lib/wa-forms.server.ts`: calls to create, upload the asset and publish, using the merchant token.
- New admin route `api/forms/*` for save, publish and send. It gets the org from the login token.
- Webhook (`whatsapp-webhook.server.ts`): one **added** branch for `interactive.nfm_reply`. The existing button_reply and list_reply code is not touched. The branch saves the response, updates mapped contact fields and records a `form_submitted` event. It skips duplicates by Meta message ID.
- Inbox thread (`chat-thread.tsx`): a new card for form replies ("field: value"), so they never show as "Unsupported". Composer gets a "Send form" button (only inside the 24 h window).
- Flows: new step type `send_form` in `flows.server.ts` and the flow editor. The old step types behave exactly as before. `form_submitted` becomes available as a trigger event.
- Campaigns plus the template builder: a "Flow" button type in `templates.ts`, `button-editor.tsx` and `template-create.server.ts`. This is how forms go out after the 24 h window.
- Aiden tool `send_form(form_id)` in `ai-tools.server.ts`. It is only offered when a published form exists. The answer policy and all guards are unchanged.

**Phase B — Aiden collects**
- New tables: `collect_goals`, `collect_sessions`, with the same RLS pattern. New flag `aiden_collect`.
- New `lib/collect.server.ts`: validators (pincode 6 digits, future date, phone, email, number, enum), session state, on_complete actions, and a 24 h expiry sweep added to the existing knowledge-worker minute tick.
- Aiden: tools `start_collect` and `record_fields`. While a session is active, the goal, what is already collected and what is still missing are added to his prompt context. He answers the customer first and then asks for one missing field. The reply guards still run.
- Flows: step type `aiden_collect`. Inbox: a "Collecting: 2 of 3" chip with Cancel and Mark done, a summary card, and "Start collecting". Handover marks the conversation Needs you.
- AI employee: a new "Collect" tab with 3 starter goals.

## Dependencies re-checked after each build
Existing flows and their steps, button and list replies, inbox rendering, Aiden replies (answer policy, price guard, claim check), template creation and campaigns, and billing (forms inside 24 h are sent as service messages).

## Report
For each phase: the effective diff per file; a published test form on 91218 81110 sent to +91 79812 23192, with its submission shown in the inbox; a Hinglish transcript of Aiden collecting 3 fields, including one invalid answer; deployment STARTED plus the commit hash.

## Risks
- Meta has to allow Flows on the Ai Dwar WABA. If publishing is refused, I'll show Meta's exact error and report it.
- The live submission needs someone to tap and fill in the form on +91 79812 23192. I can't do that step.
