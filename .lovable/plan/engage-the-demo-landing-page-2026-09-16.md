# Engage the `/demo` landing page

## What will change

- Personalize the opening headline and supporting example from an allowlisted campaign context only: Retail, Services, or Growing teams. Unknown URL values will fall back to the current general message.
- Add a compact “Choose what you want to see” control for Customer replies, Owner approvals, and Follow-ups. It will update the nearby example, record a privacy-safe engagement event, and preselect the matching need in the existing single demo form.
- Add a three-step demo deliverable strip: share a website/catalogue, see a grounded answer plus owner handoff, then discuss fit.
- Make both recorded test cases equally prominent while preserving the exact captured questions, answers, timestamps, source facts, and honest “no message was sent” language.
- Add selectable, factual use-case examples for Retail, Services, Education, Healthcare, and Real estate. Selecting one will also preselect the matching business type in the same form.
- Add an owner-control strip showing Off, Draft only, Replying, knowledge sources, and work history as examples of controls available in AiDwar—not live controls.

## Interaction and accessibility

- Keep one conversion action and one durable lead form; selections retain and prefill rather than creating alternate forms.
- Keep the page mobile-first, keyboard operable, screen-reader labelled, reduced-motion friendly, and free of horizontal overflow.
- Preserve the recorded proof’s provenance and avoid testimonials, metrics, guarantees, or invented product outcomes.

## Technical details

- Limit changes to `/demo` presentation, its recorded-proof presentation, the existing demo form prefill behavior, and privacy-safe local event vocabulary.
- Read campaign context from allowlisted query values only; continue storing existing UTM attribution and continue stripping ad click IDs.
- Do not change lead storage, validation, admin access, auth, billing, customer workspaces, AI execution, or messaging.
- Verify type checks and render/interaction behavior at 390px and desktop. Do not publish.
