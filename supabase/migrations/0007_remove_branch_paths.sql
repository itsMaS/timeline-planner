-- Branching paths removed.
--
-- Items no longer carry `pathId` and the document no longer carries
-- `branches`, so the API stops stamping a dead field onto new items and the
-- stored documents lose the leftovers. The app already drops both in
-- `normalizeProject`, so this only brings the server side in step; the
-- document version is deliberately left alone (nothing a client can see
-- changes, and bumping it would make every open tab pull for nothing).

-- ---------------------------------------------------------------- api_create_item

create or replace function public.api_create_item(p_api_token text, p_item jsonb, p_author text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t public.timelines := public.api_timeline(p_api_token);
  typ jsonb; sec jsonb; item jsonb; pos numeric; dur numeric; last_pos numeric; v bigint; who text; tags jsonb;
begin
  if p_item is null or jsonb_typeof(p_item) <> 'object' then raise exception 'p_item must be an object'; end if;
  typ := public.api_lookup(t.doc, 'types', p_item->>'typeId', p_item->>'typeName', 'type');
  if coalesce(trim(p_item->>'title'), '') = '' then raise exception 'title is required'; end if;
  if coalesce(p_item->>'sectionId', p_item->>'sectionName', '') <> '' then
    sec := public.api_lookup(t.doc, 'sections', p_item->>'sectionId', p_item->>'sectionName', 'section');
  end if;
  if p_item ? 'pos' and jsonb_typeof(p_item->'pos') <> 'null' then
    if jsonb_typeof(p_item->'pos') <> 'number' then raise exception 'pos must be a number'; end if;
    pos := (p_item->>'pos')::numeric;
  elsif sec is not null then
    select max((i->>'pos')::numeric) into last_pos from jsonb_array_elements(coalesce(t.doc->'items', '[]'::jsonb)) i
      where (i->>'pos')::numeric >= (sec->>'start')::numeric and (i->>'pos')::numeric < (sec->>'end')::numeric;
    pos := case when last_pos is null then (sec->>'start')::numeric else least(last_pos + 1, (sec->>'end')::numeric) end;
  else
    select max((i->>'pos')::numeric) into last_pos from jsonb_array_elements(coalesce(t.doc->'items', '[]'::jsonb)) i;
    pos := coalesce(last_pos + 1, 0);
  end if;
  dur := coalesce((p_item->>'duration')::numeric, 0);
  if dur < 0 then raise exception 'duration must be >= 0'; end if;
  if coalesce(p_item->>'layerId', '') <> '' then
    perform public.api_lookup(t.doc, 'layers', p_item->>'layerId', null, 'layer');
  end if;
  if p_item ? 'tags' and jsonb_typeof(p_item->'tags') not in ('array', 'null') then raise exception 'tags must be an array of strings'; end if;
  tags := coalesce((select jsonb_agg(distinct trim(g #>> '{}')) from jsonb_array_elements(coalesce(p_item->'tags', '[]'::jsonb)) g where trim(g #>> '{}') <> ''), '[]'::jsonb);
  who := coalesce(nullif(trim(p_author), ''), 'API');
  item := jsonb_build_object(
    'id', public.api_uid(),
    'typeId', typ->>'id',
    'layerId', nullif(p_item->>'layerId', ''),
    'pos', pos,
    'duration', dur,
    'title', trim(p_item->>'title'),
    'description', coalesce(p_item->>'description', ''),
    'tags', tags,
    'link', coalesce(p_item->>'link', ''),
    'images', '[]'::jsonb,
    'fieldValues', '{}'::jsonb,
    'createdBy', jsonb_build_object('name', who, 'color', '#0ea5e9')
  );
  item := jsonb_set(item, '{fieldValues}', public.api_field_values(t.doc, 'items', item, p_item->'fieldValues'), true);
  v := public.api_commit(t, public.api_put(t.doc, 'items', item),
    jsonb_build_array(jsonb_build_object('col', 'items', 'entityId', item->>'id', 'kind', 'add', 'before', null, 'after', item)),
    jsonb_build_object('cols', jsonb_build_object('items', jsonb_build_object('upsert', jsonb_build_array(item)))),
    p_author);
  return jsonb_build_object('version', v, 'changed', true, 'item', item);
end $$;

-- ---------------------------------------------------------------- stored documents

-- Drop `branches` from every document and `pathId` from every item, keeping
-- item order. Items that sat on a path (there are none left) fall back to the
-- main spine, which is exactly what the app does with them on load.
update public.timelines t
set doc = case
    when jsonb_typeof(t.doc->'items') = 'array' then
      jsonb_set(
        t.doc - 'branches',
        '{items}',
        coalesce(
          (select jsonb_agg(e.i - 'pathId' order by e.ord)
             from jsonb_array_elements(t.doc->'items') with ordinality as e(i, ord)),
          '[]'::jsonb),
        true)
    else t.doc - 'branches'
  end
where t.doc ? 'branches'
   or (jsonb_typeof(t.doc->'items') = 'array'
       and exists (select 1 from jsonb_array_elements(t.doc->'items') i where i ? 'pathId'));
