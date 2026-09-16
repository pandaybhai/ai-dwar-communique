# Add trust and ad-to-demo context on `/demo`

## What will change
- Add a compact trust strip near the demo offer using only claims already stated in AiDwar’s Privacy Policy and Terms: documented security safeguards, use of the official WhatsApp Business Platform, and opt-in/no-unsolicited-messaging rules.
- Link the relevant trust items directly to the existing Privacy Policy and Terms pages; avoid certifications, guarantees, or unsupported security language.
- Expand the allowlisted campaign bridge so recognised ad context for Retail, Services, Education, Healthcare, Real estate, or Growing teams selects matching owner-friendly headline/supporting copy and the relevant industry example.
- Visibly identify the selected ad context on the landing page and prefill the same existing demo form; unknown or malformed values keep the general default.

## Technical details
- Keep the change within `/demo` presentation and its existing privacy-safe local engagement events.
- Read only allowlisted values from `context`, `utm_content`, or `utm_campaign`; do not collect ad click IDs or contact data for analytics.
- Preserve one lead form, existing validation/storage, recorded proof, customer app, auth, billing, and admin behavior.
- Verify the ad-context selection and trust links at 390px and desktop. Do not publish.
