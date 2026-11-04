-- Batch 58 (NOT applied): billing for internal workspaces, cancelled
-- invoices, MCP fresh codes, catalogue and reply-count fixes, faster first
-- load.
--
-- No table, column, function, policy or grant changes. Every Batch 58 item
-- runs on what the database already has:
--   1. Internal workspace = organizations.billing_enabled_at NULL (the rule
--      Admin > Billing, runPlanBilling, runDunning and every debit function
--      already read) + a marker in organization_billing_settings
--      .limits_override._internal_workspace (internal-workspace.server.ts).
--   2. "Cancelled by credit note" is computed from invoices + credit_notes
--      (invoice-cancel.ts); no stored status, so it can't drift. The
--      existing credit_notes_invoice_idx serves the reads.
--   3. refresh_confirm_code reuses the stateless HMAC confirm codes.
--   4. / 5. are code-only (product extractor, applyCampaignReply).
-- The read-only report of campaigns whose reply counts change is
-- scripts/batch58-reply-recount.sql (one SELECT; never run by this file).
--
-- So the code works with or without this file (nothing here is read by it),
-- and applying it twice changes nothing. As every migration after 20261300,
-- it ends with the two OAuth guards (both idempotent: they only add the
-- restrictive policies a table is missing).

SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
