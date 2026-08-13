BEGIN;

-- 1. Merge duplicate contacts differing only by '+' prefix.
WITH norm AS (
  SELECT id, organization_id, regexp_replace(phone, '\D', '', 'g') AS digits, name, created_at
  FROM contacts
), keeper AS (
  SELECT DISTINCT ON (organization_id, digits) id, organization_id, digits
  FROM norm
  ORDER BY organization_id, digits, (name IS NOT NULL) DESC, created_at ASC
), dup AS (
  SELECT n.id AS dup_id, k.id AS keep_id
  FROM norm n JOIN keeper k
    ON k.organization_id = n.organization_id AND k.digits = n.digits
  WHERE n.id <> k.id
)
UPDATE conversations c SET contact_id = d.keep_id FROM dup d WHERE c.contact_id = d.dup_id;

WITH norm AS (
  SELECT id, organization_id, regexp_replace(phone, '\D', '', 'g') AS digits, name, created_at FROM contacts
), keeper AS (
  SELECT DISTINCT ON (organization_id, digits) id, organization_id, digits FROM norm
  ORDER BY organization_id, digits, (name IS NOT NULL) DESC, created_at ASC
)
DELETE FROM contacts c USING norm n, keeper k
WHERE c.id = n.id AND k.organization_id = n.organization_id AND k.digits = n.digits AND c.id <> k.id;

-- 2. Normalise all remaining contact phones / wa_ids.
UPDATE contacts
SET phone = '+' || regexp_replace(phone, '\D', '', 'g'),
    wa_id = COALESCE(NULLIF(regexp_replace(COALESCE(wa_id, phone), '\D', '', 'g'), ''), wa_id)
WHERE phone IS DISTINCT FROM '+' || regexp_replace(phone, '\D', '', 'g')
   OR wa_id IS DISTINCT FROM regexp_replace(COALESCE(wa_id, phone), '\D', '', 'g');

-- 3. Merge duplicate conversations per (org, contact).
WITH keep AS (
  SELECT DISTINCT ON (organization_id, contact_id) id, organization_id, contact_id
  FROM conversations
  ORDER BY organization_id, contact_id, created_at ASC
), dup AS (
  SELECT c.id AS dup_id, k.id AS keep_id
  FROM conversations c JOIN keep k
    ON k.organization_id = c.organization_id AND k.contact_id IS NOT DISTINCT FROM c.contact_id
  WHERE c.id <> k.id
)
UPDATE messages m SET conversation_id = d.keep_id FROM dup d WHERE m.conversation_id = d.dup_id;

WITH keep AS (
  SELECT DISTINCT ON (organization_id, contact_id) id, organization_id, contact_id
  FROM conversations ORDER BY organization_id, contact_id, created_at ASC
)
DELETE FROM conversations c USING keep k
WHERE k.organization_id = c.organization_id
  AND k.contact_id IS NOT DISTINCT FROM c.contact_id
  AND c.id <> k.id;

-- 4. Recalculate conversation counters.
UPDATE conversations c SET
  last_message_at = s.last_at,
  last_customer_message_at = s.last_in,
  unread_count = s.unread
FROM (
  SELECT conversation_id,
         MAX(created_at) AS last_at,
         MAX(created_at) FILTER (WHERE direction = 'inbound') AS last_in,
         COUNT(*) FILTER (WHERE direction = 'inbound') AS unread
  FROM messages GROUP BY conversation_id
) s
WHERE s.conversation_id = c.id;

COMMIT;
