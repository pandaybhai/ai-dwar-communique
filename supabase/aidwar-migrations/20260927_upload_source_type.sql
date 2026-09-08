-- Files an owner sends on the merchant channel all live under one source per
-- workspace ("Files you sent"), so the type list gains 'upload'.
alter table public.knowledge_sources drop constraint if exists knowledge_sources_type_check;
alter table public.knowledge_sources
  add constraint knowledge_sources_type_check
  check (type = any (array[
    'website','pdf','spreadsheet','manual_qa','meta_catalog','woocommerce','shopify','image','docx','upload'
  ]));
