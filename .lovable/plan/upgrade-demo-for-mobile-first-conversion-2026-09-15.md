# Upgrade `/demo` for mobile-first conversion

## Goal
Turn the existing `/demo` page into a focused, premium demo-request experience without changing or publishing the homepage, customer app, billing, authentication, or admin permissions.

## Page experience
- Replace the shared marketing header with a minimal, non-linking AiDwar wordmark and remove all competing Home, Pricing, Login, and Start free links from `/demo` only.
- Build a compact mobile-first hero using the approved headline, supporting copy, reassurance, and a visible “Request my demo” action at 390×844.
- Reuse the existing illustrative chat/approval interaction, clearly label it “Example,” and avoid claims of recorded or live proof.
- Add three concise benefit lines, keep the form near the top, and add three compact accessible FAQ accordions.
- On desktop, use a balanced explanation/example column beside the form; on mobile, preserve the requested reading order.
- Add a minimal company footer with Privacy and Terms only.

## Form improvements
- Keep the existing two-step qualification questions, durable submission endpoint, retained answers, retry behavior, and submission lock.
- Add a country-code selector defaulting to +91, common international options, and a manual code option; combine it with the telephone field before submission.
- Add client-side validation that requires an explicit valid country code and national number, while retaining authoritative server validation and normalization.
- Add an accessible error summary plus field-level errors, 16px-or-larger controls, 44px touch targets, and focus movement between the form heading and error summary.
- Remove the shared signup fallback only on `/demo` through a focused form option; leave homepage usage unchanged.
- Update success copy to “We have your request” and explain that the team will contact the visitor on WhatsApp to arrange the demo, without promising a time.

## Mobile behavior
- Add a mobile-only sticky “Request my demo” action that disappears while the form is visible, any form field is focused, or submission has succeeded.
- Respect safe-area insets and reduced-motion preferences, avoid covering legal text, and prevent horizontal overflow at 360, 390, and 430 pixels.
- Smooth-scroll to the form and move keyboard focus to its heading.

## Data, security, and measurement
- Continue writing to `demo_leads` through the existing write-only public endpoint and keep `/admin/leads` authorization and RLS unchanged.
- Preserve `/demo` as `landing_path`, bounded UTM/ref attribution, server-side click-ID stripping, explicit contact consent, rate limiting, honeypot, and normalized-phone deduplication.
- Keep analytics payloads free of contact details. Document whether current hooks only dispatch locally or reach an installed data layer.
- Do not send any outbound message or add external tracking.

## Verification
- Check desktop plus 360×844, 390×844, and 430×932 layouts for first-view CTA, touch sizing, overflow, sticky-action behavior, and footer/form clearance.
- Exercise empty and malformed submissions, explicit country-code validation, step-back retention, retry and duplicate prevention, keyboard navigation, hidden honeypot, focus handling, and success state.
- Save one clearly synthetic reserved-contact enquiry with `/demo` and UTM attribution, verify authorized admin retrieval, verify public read attempts remain unavailable, and avoid contacting the number.
- Confirm the homepage is visually and functionally unchanged, then run the relevant type and project checks. Keep everything preview-only and report the proof limitation plus the preview URL.

## Technical details
- Scope layout changes to `src/routes/demo.tsx` and add narrowly scoped options/state hooks to the existing shared demo form rather than forking submission logic.
- Reuse the existing semantic color tokens, button component, illustrative product-proof primitives, route metadata, and lead server helpers.
- Tighten server phone acceptance to explicit international format while keeping stored values normalized; do not alter lead-table structure, admin roles, billing, auth, or customer-app code.
