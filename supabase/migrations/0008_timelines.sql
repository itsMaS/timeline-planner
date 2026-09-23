-- Timelines (subtabs).
--
-- A project holds several timelines that share its schema (fields, types,
-- folders, layers, hierarchy levels, processors, views) but keep their own
-- sections, items and settings: `doc.timelines = [{id, name, settings}]`, and
-- every item and section carries `timelineId`. Older documents become one
-- timeline with the fixed id `timeline-0`, named "Main", carrying the
-- project-level `settings` — the same migration `normalizeProject` runs in
-- the app, so every client and this backfill agree on the ids and later
-- patches line up. The document version is deliberately left alone (nothing
-- a client can see changes; bumping it would make every open tab pull).
--
-- API: `api_create_item` accepts `timelineId` / `timelineName` (default: the
-- section's timeline, else the first one) and looks sections up within that
-- timeline; `api_schema` returns the timeline list. The token still cannot
-- create, rename or delete timelines, or move items between them
-- (`api_update_item` keeps its title / description / link whitelist).

-- ---------------------------------------------------------------- stored documents

do $$
declare r record; d jsonb; first_id text;
begin
  for r in select id, doc from public.timelines loop
    d := r.doc;
    if coalesce(jsonb_typeof(d->'timelines'), '') <> 'array' or jsonb_array_length(d->'timelines') = 0 then
      d := jsonb_set(d, '{timelines}', jsonb_build_array(jsonb_build_object(
        'id', 'timeline-0', 'name', 'Main', 'settings', coalesce(d->'settings', '{}'::jsonb))), true);
    end if;
    first_id := d->'timelines'->0->>'id';
    if jsonb_typeof(d->'items') = 'array' then
      d := jsonb_set(d, '{items}', coalesce((
        select jsonb_agg(case when coalesce(e.i->>'timelineId', '') = '' then e.i || jsonb_build_object('timelineId', first_id) else e.i end order by e.ord)
        from jsonb_array_elements(d->'items') with ordinality as e(i, ord)), '[]'::jsonb), true);
    end if;
    if jsonb_typeof(d->'sections') = 'array' then
      d := jsonb_set(d, '{sections}', coalesce((
        select jsonb_agg(case when coalesce(e.s->>'timelineId', '') = '' then e.s || jsonb_build_object('timelineId', first_id) else e.s end order by e.ord)
        from jsonb_array_elements(d->'sections') with ordinality as e(s, ord)), '[]'::jsonb), true);
    end if;
    if d <> r.doc then update public.timelines set doc = d where id = r.id; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- api_schema

create or replace function public.api_schema(p_api_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.timelines := public.api_timeline(p_api_token);
begin
  return jsonb_build_object(
    'id', t.id, 'name', t.name, 'version', t.version,
    'timelines', coalesce(t.doc->'timelines', '[]'::jsonb),
    'fields', coalesce(t.doc->'fields', '[]'::jsonb),
    'types', coalesce(t.doc->'types', '[]'::jsonb),
    'typeFolders', coalesce(t.doc->'typeFolders', '[]'::jsonb),
    'hierarchyLevels', coalesce(t.doc->'hierarchyLevels', '[]'::jsonb),
    'layers', coalesce(t.doc->'layers', '[]'::jsonb),
    'processors', coalesce(t.doc->'processors', '[]'::jsonb),
    'tags', coalesce((
      select jsonb_agg(tag order by tag) from (
        select distinct g #>> '{}' as tag
        from jsonb_array_elements(coalesce(t.doc->'items', '[]'::jsonb)) i, jsonb_array_elements(coalesce(i->'tags', '[]'::jsonb)) g
      ) x
    ), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------- api_create_item

/**
 * Create an item. p_item: {typeId | typeName, title, timelineId? | timelineName?,
 * sectionId? | sectionName?, pos?, duration?, description?, link?, tags?,
 * layerId?, fieldValues?}. The timeline is the one named, else the section's,
 * else the project's first; a section name is looked up within that timeline.
 * Without pos the item lands right after the last item of the section (or at
 * the section start when it is empty; after the last item of the timeline
 * when no section is given).
 */
create or replace function public.api_create_item(p_api_token text, p_item jsonb, p_author text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t public.timelines := public.api_timeline(p_api_token);
  typ jsonb; sec jsonb; tl jsonb; tl_id text; sec_doc jsonb; item jsonb; pos numeric; dur numeric; last_pos numeric; v bigint; who text; tags jsonb;
begin
  if p_item is null or jsonb_typeof(p_item) <> 'object' then raise exception 'p_item must be an object'; end if;
  typ := public.api_lookup(t.doc, 'types', p_item->>'typeId', p_item->>'typeName', 'type');
  if coalesce(trim(p_item->>'title'), '') = '' then raise exception 'title is required'; end if;
  if coalesce(p_item->>'timelineId', p_item->>'timelineName', '') <> '' then
    tl := public.api_lookup(t.doc, 'timelines', p_item->>'timelineId', p_item->>'timelineName', 'timeline');
    tl_id := tl->>'id';
  end if;
  if coalesce(p_item->>'sectionId', p_item->>'sectionName', '') <> '' then
    -- With a timeline named, only its sections count (names may repeat across timelines).
    sec_doc := case when tl_id is null then t.doc else jsonb_build_object('sections', coalesce((
      select jsonb_agg(s) from jsonb_array_elements(coalesce(t.doc->'sections', '[]'::jsonb)) s where s->>'timelineId' = tl_id), '[]'::jsonb)) end;
    sec := public.api_lookup(sec_doc, 'sections', p_item->>'sectionId', p_item->>'sectionName', 'section');
    if tl_id is null then tl_id := sec->>'timelineId'; end if;
  end if;
  if tl_id is null then tl_id := t.doc->'timelines'->0->>'id'; end if;
  if p_item ? 'pos' and jsonb_typeof(p_item->'pos') <> 'null' then
    if jsonb_typeof(p_item->'pos') <> 'number' then raise exception 'pos must be a number'; end if;
    pos := (p_item->>'pos')::numeric;
  elsif sec is not null then
    select max((i->>'pos')::numeric) into last_pos from jsonb_array_elements(coalesce(t.doc->'items', '[]'::jsonb)) i
      where coalesce(i->>'timelineId', t.doc->'timelines'->0->>'id') is not distinct from tl_id
        and (i->>'pos')::numeric >= (sec->>'start')::numeric and (i->>'pos')::numeric < (sec->>'end')::numeric;
    pos := case when last_pos is null then (sec->>'start')::numeric else least(last_pos + 1, (sec->>'end')::numeric) end;
  else
    select max((i->>'pos')::numeric) into last_pos from jsonb_array_elements(coalesce(t.doc->'items', '[]'::jsonb)) i
      where coalesce(i->>'timelineId', t.doc->'timelines'->0->>'id') is not distinct from tl_id;
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
    'timelineId', tl_id,
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
