# Batch 74 (parked) — notes for when it resumes

Status: parked by decision (email + password sign-up stays; /start unchanged).
Nothing here is deployed; 20261390_batch74.sql has never been applied.

## Decisions already taken (Step 0 questions)
- WhatsApp log-in / "already has an account": verified numbers only — WhatsApp
  sign-ups (app_metadata.wa_verified_phone / confirmed auth phone) and email
  accounts whose number was proven in the AD-code chat. A number only typed at
  sign-up (profiles.phone) never logs anyone in.
- "Add email for invoices": our own one-time link via sendEmail, then
  auth.admin.updateUserById sets the confirmed email and clears
  profiles.email_is_placeholder (no dashboard change).
- Day-0 greeting: reuse the exported sendDayOneIntro (AD-code path unchanged).
- Supabase settings: build so it works either way.

## Live DB check (Vinay, 12 Nov 2026)
- public.profiles.email is NULLABLE.
- public.profiles.phone is NULLABLE.
So a phone-only auth user would not break handle_new_user; the placeholder
email is still needed because Supabase's server-made session (magic-link
token hash via auth.admin.generateLink) requires an email on the user.

## Still to confirm in the Supabase dashboard before go-live (list in the PR)
1. Auth → Providers → Phone: whether auth.admin.createUser accepts a phone
   (phone_confirm: true) while the Phone provider is off. The code falls back
   to an email-only account with the proven number in app_metadata if refused
   (logged as scope "wa_auth", stage "phone_refused_fallback_email_only").
2. Auth → Email OTP / magic-link expiry: the token hash handed to the verified
   browser must outlive the hand-off (it is used within seconds); default is
   fine unless set very low.

## Not built yet
Routes (/api/public/start, /api/public/wa-login, /api/onboarding/wa-greet,
/api/account/email), the /start steps 2–4 UI, /login "Continue with
WhatsApp", Settings → Account, Admin → Leads verified badge/filter, the
placeholder-email guards (sendEmail + notice drain, Razorpay/Cashfree
customers, CAPI em, display helper), the aidwar_trial_verify nudge, and the
tests listed in the brief.
