-- Type folders can attach fields that every type inside them (at any depth)
-- inherits (TypeFolder.fields, see src/model/fields.ts `typeAttachments`).
-- (0005 redefined api_coerce for toggles.) The API's attachment check must therefore also walk the item's folder chain.

create or replace function public.api_field_attached(p_doc jsonb, p_col text, p_entity jsonb, p_field_id text) returns boolean
language sql immutable set search_path = public as $$
  with recursive
    typ as (
      select t.value as type
      from jsonb_array_elements(coalesce(p_doc->'types', '[]'::jsonb)) t
      where p_col = 'items' and t.value->>'id' = p_entity->>'typeId'
    ),
    chain as (
      select fo.value as folder, 1 as depth
      from typ, jsonb_array_elements(coalesce(p_doc->'typeFolders', '[]'::jsonb)) fo
      where fo.value->>'id' = typ.type->>'folderId'
      union all
      select fo.value, chain.depth + 1
      from chain, jsonb_array_elements(coalesce(p_doc->'typeFolders', '[]'::jsonb)) fo
      where fo.value->>'id' = chain.folder->>'parentId' and chain.depth < 64
    ),
    lists as (
      select coalesce(type->'fields', '[]'::jsonb) as l from typ
      union all
      select coalesce(folder->'fields', '[]'::jsonb) from chain
      union all
      select coalesce(p_doc->'hierarchyLevels'->((p_entity->>'depth')::int)->'fields', '[]'::jsonb)
      where p_col <> 'items'
    )
  select exists (
    select 1 from lists, jsonb_array_elements(lists.l) a where a.value->>'fieldId' = p_field_id
  )
$$;
