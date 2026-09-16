-- External API for tools (Unity editor plugin, build scripts, …).
--
-- A fourth per-timeline token, the *API token*, is minted by the owner in the
-- Share dialog (nullable: no token until created, null again after revoke).
-- It opens a deliberately narrow surface, the `api_*` RPCs below:
--
--   read    api_read, api_version, api_schema
--   write   api_set_field, api_set_tags, api_update_item, api_create_item
--
-- Writes patch the stored document in place (never a full-document save), bump
-- the version, record history with source 'api', and broadcast the same entity
-- patch the app itself sends so open tabs apply the change immediately.
-- The token cannot change the schema (types, fields, levels), delete anything,
-- or administer links. See API.md for the request/response shapes.

-- ---------------------------------------------------------------- token

alter table public.timelines add column if not exists api_token text;
create unique index if not exists timelines_api_token_key on public.timelines (api_token);

/** Owner: 'get' | 'create' (mint when missing) | 'rotate' | 'revoke'. Returns {token} (null when none). */
create or replace function public.share_api_token(p_edit_token text, p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines;
begin
  select * into t from public.timelines where edit_token = p_edit_token;
  if t.id is null or not public.share_is_admin(t) then return null; end if;
  if p_action = 'create' then
    if t.api_token is null then
      update public.timelines set api_token = public.gen_token() where id = t.id returning api_token into t.api_token;
    end if;
  elsif p_action = 'rotate' then
    update public.timelines set api_token = public.gen_token() where id = t.id returning api_token into t.api_token;
  elsif p_action = 'revoke' then
    update public.timelines set api_token = null where id = t.id;
    t.api_token := null;
  elsif p_action <> 'get' then
    return null;
  end if;
  return jsonb_build_object('token', t.api_token);
end $$;

-- share_open now tells the owner whether an API token exists (and which).
create or replace function public.share_open(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines; r text; adm boolean;
begin
  select * into t from public.timelines where edit_token = p_token or suggest_token = p_token or view_token = p_token;
  if t.id is null then return null; end if;
  r := public.share_role(t, p_token);
  perform public.share_join(t.id, r);
  adm := (r = 'edit' and public.share_is_admin(t));
  return jsonb_build_object(
    'id', t.id, 'name', t.name, 'doc', t.doc, 'version', t.version,
    'editToken', case when r = 'edit' then t.edit_token else null end,
    'suggestToken', case when r in ('edit', 'suggest') then t.suggest_token else null end,
    'viewToken', t.view_token,
    'apiToken', case when adm then t.api_token else null end,
    'role', r,
    'owner', adm
  );
end $$;

-- ---------------------------------------------------------------- private helpers

/** The timeline behind an API token; raises when unknown or revoked. */
create or replace function public.api_timeline(p_api_token text) returns public.timelines
language plpgsql stable security definer set search_path = public as $$
declare t public.timelines;
begin
  if coalesce(p_api_token, '') = '' then raise exception 'API token required'; end if;
  select * into t from public.timelines where api_token = p_api_token;
  if t.id is null then raise exception 'Invalid or revoked API token'; end if;
  return t;
end $$;

/** 12 lowercase alphanumerics, the same shape as the app's ids. */
create or replace function public.api_uid() returns text
language sql volatile set search_path = public as $$
  select string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', (get_byte(b, i) % 36) + 1, 1), '')
  from extensions.gen_random_bytes(12) b, generate_series(0, 11) i
$$;

/** Replace (or append) one entity in a collection of the document. */
create or replace function public.api_put(p_doc jsonb, p_col text, p_entity jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_set(p_doc, array[p_col], coalesce((
    select jsonb_agg(case when e->>'id' = p_entity->>'id' then p_entity else e end)
    from jsonb_array_elements(coalesce(p_doc->p_col, '[]'::jsonb)) e
  ), '[]'::jsonb) || case
    when exists (select 1 from jsonb_array_elements(coalesce(p_doc->p_col, '[]'::jsonb)) e where e->>'id' = p_entity->>'id')
    then '[]'::jsonb else jsonb_build_array(p_entity) end, true)
$$;

/** Find an item ('items') or section ('sections') by id. */
create or replace function public.api_entity(p_doc jsonb, p_id text, out col text, out entity jsonb) returns record
language plpgsql immutable set search_path = public as $$
begin
  select e into entity from jsonb_array_elements(coalesce(p_doc->'items', '[]'::jsonb)) e where e->>'id' = p_id;
  if entity is not null then col := 'items'; return; end if;
  select e into entity from jsonb_array_elements(coalesce(p_doc->'sections', '[]'::jsonb)) e where e->>'id' = p_id;
  if entity is not null then col := 'sections'; return; end if;
  raise exception 'No item or section with id "%"', p_id;
end $$;

/** Resolve one entity of a collection by id or (case-insensitive) name; raises when missing or ambiguous. */
create or replace function public.api_lookup(p_doc jsonb, p_col text, p_id text, p_name text, p_what text) returns jsonb
language plpgsql immutable set search_path = public as $$
declare found jsonb[]; n integer;
begin
  if coalesce(p_id, '') <> '' then
    select array_agg(e) into found from jsonb_array_elements(coalesce(p_doc->p_col, '[]'::jsonb)) e where e->>'id' = p_id;
    if found is null then raise exception 'No % with id "%"', p_what, p_id; end if;
    return found[1];
  end if;
  if coalesce(p_name, '') = '' then raise exception 'A % id or name is required', p_what; end if;
  select array_agg(e) into found from jsonb_array_elements(coalesce(p_doc->p_col, '[]'::jsonb)) e
    where lower(trim(e->>'name')) = lower(trim(p_name));
  n := coalesce(array_length(found, 1), 0);
  if n = 0 then raise exception 'No % named "%"', p_what, p_name; end if;
  if n > 1 then
    raise exception '% %s are named "%" (%); pass the id instead', n, p_what, p_name,
      (select string_agg(f->>'id', ', ') from unnest(found) f);
  end if;
  return found[1];
end $$;

/** Is field p_field_id attached to this entity's type (items) or hierarchy level (sections)? */
create or replace function public.api_field_attached(p_doc jsonb, p_col text, p_entity jsonb, p_field_id text) returns boolean
language sql immutable set search_path = public as $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(
      case when p_col = 'items'
        then (select t->'fields' from jsonb_array_elements(coalesce(p_doc->'types', '[]'::jsonb)) t where t->>'id' = p_entity->>'typeId')
        else p_doc->'hierarchyLevels'->((p_entity->>'depth')::int)->'fields'
      end, '[]'::jsonb)) a
    where a->>'fieldId' = p_field_id
  )
$$;

/**
 * Validate and normalise a value for a field, mirroring src/model/fields.ts:
 * text → string, int/float → number, select → array of option strings,
 * ref → array of existing item/section ids. Returns null for "unset".
 */
create or replace function public.api_coerce(p_doc jsonb, p_field jsonb, p_value jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  kind text := p_field->>'kind';
  fname text := coalesce(p_field->>'name', p_field->>'id');
  s text; n numeric; arr jsonb; el jsonb; bad text; tgt record;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then return null; end if;
  case kind
    when 'text' then
      if jsonb_typeof(p_value) not in ('string', 'number') then
        raise exception 'Field "%" expects a string', fname;
      end if;
      s := p_value #>> '{}';
      if s = '' then return null; end if;
      if (p_field->>'maxLength') is not null and length(s) > (p_field->>'maxLength')::int then
        raise exception 'Field "%" allows at most % characters', fname, p_field->>'maxLength';
      end if;
      return to_jsonb(s);
    when 'int', 'float' then
      if jsonb_typeof(p_value) <> 'number' then raise exception 'Field "%" expects a number', fname; end if;
      n := (p_value #>> '{}')::numeric;
      if kind = 'int' and n <> trunc(n) then raise exception 'Field "%" expects a whole number', fname; end if;
      if (p_field->>'min') is not null and n < (p_field->>'min')::numeric then
        raise exception 'Field "%" must be at least %', fname, p_field->>'min';
      end if;
      if (p_field->>'max') is not null and n > (p_field->>'max')::numeric then
        raise exception 'Field "%" must be at most %', fname, p_field->>'max';
      end if;
      return p_value;
    when 'select', 'ref' then
      if jsonb_typeof(p_value) = 'string' then arr := jsonb_build_array(p_value);
      elsif jsonb_typeof(p_value) = 'array' then arr := p_value;
      else raise exception 'Field "%" expects a string or an array of strings', fname;
      end if;
      if jsonb_array_length(arr) = 0 then return null; end if;
      for el in select * from jsonb_array_elements(arr) loop
        if jsonb_typeof(el) <> 'string' then raise exception 'Field "%" expects strings', fname; end if;
      end loop;
      if kind = 'select' then
        select e #>> '{}' into bad from jsonb_array_elements(arr) e
          where not coalesce(p_field->'options', '[]'::jsonb) ? (e #>> '{}') limit 1;
        if bad is not null then
          raise exception '"%" is not an option of field "%" (options: %)', bad, fname,
            (select string_agg(o #>> '{}', ', ') from jsonb_array_elements(coalesce(p_field->'options', '[]'::jsonb)) o);
        end if;
        if not coalesce((p_field->>'selectMultiple')::boolean, false) and jsonb_array_length(arr) > 1 then
          raise exception 'Field "%" accepts a single option', fname;
        end if;
      else
        for el in select * from jsonb_array_elements(arr) loop
          select * into tgt from public.api_entity(p_doc, el #>> '{}');
          if jsonb_array_length(coalesce(p_field->'refTargets', '[]'::jsonb)) > 0 then
            if not (p_field->'refTargets' ? (case when tgt.col = 'items' then tgt.entity->>'typeId'
                else p_doc->'hierarchyLevels'->((tgt.entity->>'depth')::int)->>'id' end)) then
              raise exception 'Field "%" cannot reference "%" (not an allowed target)', fname, coalesce(tgt.entity->>'title', tgt.entity->>'name', el #>> '{}');
            end if;
          end if;
        end loop;
        if not coalesce((p_field->>'refMultiple')::boolean, false) and jsonb_array_length(arr) > 1 then
          raise exception 'Field "%" accepts a single reference', fname;
        end if;
      end if;
      return arr;
    else
      raise exception 'Field "%" has unsupported kind "%"', fname, kind;
  end case;
end $$;

/** Validate a {fieldId: value} object against an entity; returns the normalised fieldValues to store. */
create or replace function public.api_field_values(p_doc jsonb, p_col text, p_entity jsonb, p_values jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare out_vals jsonb := coalesce(p_entity->'fieldValues', '{}'::jsonb); k text; v jsonb; f jsonb; cv jsonb;
begin
  if p_values is null or jsonb_typeof(p_values) = 'null' then return out_vals; end if;
  if jsonb_typeof(p_values) <> 'object' then raise exception 'fieldValues must be an object keyed by field id'; end if;
  for k, v in select * from jsonb_each(p_values) loop
    select e into f from jsonb_array_elements(coalesce(p_doc->'fields', '[]'::jsonb)) e where e->>'id' = k;
    if f is null then raise exception 'Unknown field id "%"', k; end if;
    if not public.api_field_attached(p_doc, p_col, p_entity, k) then
      raise exception 'Field "%" is not attached to this %', coalesce(f->>'name', k), case when p_col = 'items' then 'item''s type' else 'section''s level' end;
    end if;
    cv := public.api_coerce(p_doc, f, v);
    if cv is null then out_vals := out_vals - k; else out_vals := jsonb_set(out_vals, array[k], cv, true); end if;
  end loop;
  return out_vals;
end $$;

/**
 * Save a changed document: bump the version, record history (source 'api'),
 * and broadcast the entity patch to open tabs. Returns the new version.
 * p_history: [{col, entityId, kind, before, after}]; p_patch: app Patch shape.
 */
create or replace function public.api_commit(t public.timelines, p_doc jsonb, p_history jsonb, p_patch jsonb, p_author text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint; who jsonb;
begin
  update public.timelines set doc = p_doc, version = version + 1, updated_at = now()
    where id = t.id returning version into v;
  who := jsonb_build_object('name', coalesce(nullif(trim(p_author), ''), 'API'), 'color', '#0ea5e9');
  insert into public.timeline_history(timeline_id, col, entity_id, kind, before, after, author, source)
  select t.id, e->>'col', e->>'entityId', e->>'kind', e->'before', e->'after', who, 'api'
  from jsonb_array_elements(p_history) e;
  delete from public.timeline_history h
  using (
    select id from (
      select id, row_number() over (partition by entity_id order by at desc, id desc) as rn
      from public.timeline_history
      where timeline_id = t.id and entity_id in (select distinct e->>'entityId' from jsonb_array_elements(p_history) e)
    ) x where rn > 200
  ) old
  where h.id = old.id;
  -- Same message the app broadcasts after a local edit (src/sync/share.ts); tabs apply it by id.
  begin
    perform realtime.send(jsonb_build_object('from', 'api', 'patch', p_patch), 'patch', 'timeline:' || t.id::text, true);
  exception when others then
    raise warning 'api broadcast failed: %', sqlerrm;
  end;
  return v;
end $$;

-- ---------------------------------------------------------------- read

create or replace function public.api_read(p_api_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.timelines := public.api_timeline(p_api_token);
begin
  return jsonb_build_object('id', t.id, 'name', t.name, 'version', t.version, 'updatedAt', t.updated_at, 'doc', t.doc);
end $$;

create or replace function public.api_version(p_api_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.timelines := public.api_timeline(p_api_token);
begin
  return jsonb_build_object('id', t.id, 'name', t.name, 'version', t.version, 'updatedAt', t.updated_at);
end $$;

/** The schema half of the document plus every tag in use: what a tool needs to build its settings UI. */
create or replace function public.api_schema(p_api_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.timelines := public.api_timeline(p_api_token);
begin
  return jsonb_build_object(
    'id', t.id, 'name', t.name, 'version', t.version,
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

-- ---------------------------------------------------------------- write

/** Set (or unset with null) one field value on an item or section. */
create or replace function public.api_set_field(
  p_api_token text, p_entity_id text, p_field_id text, p_value jsonb, p_author text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines := public.api_timeline(p_api_token); ent record; next_ent jsonb; v bigint;
begin
  select * into ent from public.api_entity(t.doc, p_entity_id);
  next_ent := jsonb_set(ent.entity, '{fieldValues}',
    public.api_field_values(t.doc, ent.col, ent.entity, jsonb_build_object(p_field_id, coalesce(p_value, 'null'::jsonb))), true);
  if next_ent = ent.entity then
    return jsonb_build_object('version', t.version, 'changed', false, 'entity', ent.entity);
  end if;
  v := public.api_commit(t, public.api_put(t.doc, ent.col, next_ent),
    jsonb_build_array(jsonb_build_object('col', ent.col, 'entityId', p_entity_id, 'kind', 'update', 'before', ent.entity, 'after', next_ent)),
    jsonb_build_object('cols', jsonb_build_object(ent.col, jsonb_build_object('upsert', jsonb_build_array(next_ent)))),
    p_author);
  return jsonb_build_object('version', v, 'changed', true, 'entity', next_ent);
end $$;

/** Add and/or remove tags on an item (both arrays of strings, either may be null). */
create or replace function public.api_set_tags(
  p_api_token text, p_item_id text, p_add jsonb default null, p_remove jsonb default null, p_author text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines := public.api_timeline(p_api_token); ent record; tags jsonb; next_ent jsonb; v bigint;
begin
  select * into ent from public.api_entity(t.doc, p_item_id);
  if ent.col <> 'items' then raise exception 'Only items have tags'; end if;
  if p_add is not null and jsonb_typeof(p_add) <> 'array' then raise exception 'p_add must be an array of strings'; end if;
  if p_remove is not null and jsonb_typeof(p_remove) <> 'array' then raise exception 'p_remove must be an array of strings'; end if;
  tags := coalesce((
    select jsonb_agg(tag order by ord) from (
      select tag, min(ord) as ord from (
        select trim(g #>> '{}') as tag, ord
        from jsonb_array_elements(coalesce(ent.entity->'tags', '[]'::jsonb) || coalesce(p_add, '[]'::jsonb)) with ordinality as x(g, ord)
      ) y
      where tag <> '' and not exists (select 1 from jsonb_array_elements(coalesce(p_remove, '[]'::jsonb)) r where trim(r #>> '{}') = y.tag)
      group by tag
    ) z
  ), '[]'::jsonb);
  next_ent := jsonb_set(ent.entity, '{tags}', tags, true);
  if next_ent = ent.entity then
    return jsonb_build_object('version', t.version, 'changed', false, 'item', ent.entity);
  end if;
  v := public.api_commit(t, public.api_put(t.doc, 'items', next_ent),
    jsonb_build_array(jsonb_build_object('col', 'items', 'entityId', p_item_id, 'kind', 'update', 'before', ent.entity, 'after', next_ent)),
    jsonb_build_object('cols', jsonb_build_object('items', jsonb_build_object('upsert', jsonb_build_array(next_ent)))),
    p_author);
  return jsonb_build_object('version', v, 'changed', true, 'item', next_ent);
end $$;

/** Update an item's title, description and/or link (only those keys). */
create or replace function public.api_update_item(
  p_api_token text, p_item_id text, p_patch jsonb, p_author text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines := public.api_timeline(p_api_token); ent record; next_ent jsonb; k text; val jsonb; v bigint;
begin
  select * into ent from public.api_entity(t.doc, p_item_id);
  if ent.col <> 'items' then raise exception 'api_update_item only edits items'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'p_patch must be an object'; end if;
  next_ent := ent.entity;
  for k, val in select * from jsonb_each(p_patch) loop
    if k not in ('title', 'description', 'link') then
      raise exception 'Unsupported key "%" (allowed: title, description, link)', k;
    end if;
    if jsonb_typeof(val) = 'null' then val := '""'::jsonb; end if;
    if jsonb_typeof(val) <> 'string' then raise exception '"%" must be a string', k; end if;
    next_ent := jsonb_set(next_ent, array[k], val, true);
  end loop;
  if next_ent = ent.entity then
    return jsonb_build_object('version', t.version, 'changed', false, 'item', ent.entity);
  end if;
  v := public.api_commit(t, public.api_put(t.doc, 'items', next_ent),
    jsonb_build_array(jsonb_build_object('col', 'items', 'entityId', p_item_id, 'kind', 'update', 'before', ent.entity, 'after', next_ent)),
    jsonb_build_object('cols', jsonb_build_object('items', jsonb_build_object('upsert', jsonb_build_array(next_ent)))),
    p_author);
  return jsonb_build_object('version', v, 'changed', true, 'item', next_ent);
end $$;

/**
 * Create an item. p_item: {typeId | typeName, title, sectionId? | sectionName?,
 * pos?, duration?, description?, link?, tags?, layerId?, fieldValues?}.
 * Without pos the item lands right after the last item of the section (or at
 * the section start when it is empty; after the last item of the whole
 * timeline when no section is given).
 */
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
    'pathId', null,
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

-- ---------------------------------------------------------------- grants

revoke execute on function public.api_timeline(text) from public, anon, authenticated;
revoke execute on function public.api_uid() from public, anon, authenticated;
revoke execute on function public.api_put(jsonb, text, jsonb) from public, anon, authenticated;
revoke execute on function public.api_entity(jsonb, text) from public, anon, authenticated;
revoke execute on function public.api_lookup(jsonb, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.api_field_attached(jsonb, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.api_coerce(jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.api_field_values(jsonb, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.api_commit(public.timelines, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
