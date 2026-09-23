-- Fields: folders, composites, derived fields, processor conditions; the API
-- learns to read them and, for the first time, to change the field schema.
--
-- Document additions (all optional, normalised by the app on load):
--   doc.fieldFolders / doc.processorFolders  [{id, name, color, icon, collapsed, parentId}]
--   field.folderId, processor.folderId       sidebar folder
--   field.kind = 'group', field.children[], field.template, field.parentId   composites
--   field.formula                            derived fields (computed on read, never stored)
--   field.badge                              toggle shown as a ✓ / ✗ badge on the item icon
--   processor.where                          rule expression an entry must satisfy to count
--   attachment.childDefaults                 per-child default overrides on a group attachment
--   filters.rules / offFields / offProcessors   per-user, saved in views
--
-- API changes:
--   api_field_attached   a child of a composite counts as attached when its group is
--   api_field_values     refuses composites (no value of their own) and derived fields (computed)
--   api_schema           adds fieldFolders and processorFolders
--   api_create_field     new: create a field (optionally inside a composite, in a folder, attached to types / levels)
--   api_update_field     new: change a field's settings (never its kind, children or parent)
--
-- Rule evaluation (api_query) and computed values (derived fields, processor
-- results) live in the `api-query` Edge Function, which shares the app's
-- TypeScript evaluator; see API.md.

-- ---------------------------------------------------------------- helpers

/** Resolve one entity of a collection by id, else by (case-insensitive) name. */
create or replace function public.api_lookup_any(p_doc jsonb, p_col text, p_ref text, p_what text) returns jsonb
language plpgsql immutable set search_path = public as $$
begin
  if exists (select 1 from jsonb_array_elements(coalesce(p_doc->p_col, '[]'::jsonb)) e where e->>'id' = p_ref) then
    return public.api_lookup(p_doc, p_col, p_ref, null, p_what);
  end if;
  return public.api_lookup(p_doc, p_col, null, p_ref, p_what);
end $$;

/** Top-level ancestor of a field (itself when it is not inside a composite). */
create or replace function public.api_field_root(p_doc jsonb, p_field_id text) returns text
language sql immutable set search_path = public as $$
  with recursive up as (
    select f.value as field, 0 as depth
    from jsonb_array_elements(coalesce(p_doc->'fields', '[]'::jsonb)) f
    where f.value->>'id' = p_field_id
    union all
    select g.value, up.depth + 1
    from up, jsonb_array_elements(coalesce(p_doc->'fields', '[]'::jsonb)) g
    where coalesce(up.field->>'parentId', '') <> '' and g.value->>'id' = up.field->>'parentId' and g.value->>'kind' = 'group' and up.depth < 32
  )
  select coalesce((select field->>'id' from up order by depth desc limit 1), p_field_id)
$$;

/** Is the field (or, for a composite's child, its top-level group) attached to this entity's type (items) or hierarchy level (sections)? */
create or replace function public.api_field_attached(p_doc jsonb, p_col text, p_entity jsonb, p_field_id text) returns boolean
language sql immutable set search_path = public as $$
  with recursive
    root as (select public.api_field_root(p_doc, p_field_id) as id),
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
    select 1 from lists, jsonb_array_elements(lists.l) a, root where a.value->>'fieldId' = root.id
  )
$$;

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
    if f->>'kind' = 'group' then
      raise exception 'Field "%" is a composite and has no value of its own; set the fields inside it', coalesce(f->>'name', k);
    end if;
    if coalesce(trim(f->>'formula'), '') <> '' then
      raise exception 'Field "%" is derived (= %) and is computed on read; it cannot be set', coalesce(f->>'name', k), f->>'formula';
    end if;
    if not public.api_field_attached(p_doc, p_col, p_entity, k) then
      raise exception 'Field "%" is not attached to this %', coalesce(f->>'name', k), case when p_col = 'items' then 'item''s type' else 'section''s level' end;
    end if;
    cv := public.api_coerce(p_doc, f, v);
    if cv is null then out_vals := out_vals - k; else out_vals := jsonb_set(out_vals, array[k], cv, true); end if;
  end loop;
  return out_vals;
end $$;

-- ---------------------------------------------------------------- api_schema

/** The schema half of the document plus every tag in use: what a tool needs to build its settings UI. */
create or replace function public.api_schema(p_api_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.timelines := public.api_timeline(p_api_token);
begin
  return jsonb_build_object(
    'id', t.id, 'name', t.name, 'version', t.version,
    'timelines', coalesce(t.doc->'timelines', '[]'::jsonb),
    'fields', coalesce(t.doc->'fields', '[]'::jsonb),
    'fieldFolders', coalesce(t.doc->'fieldFolders', '[]'::jsonb),
    'types', coalesce(t.doc->'types', '[]'::jsonb),
    'typeFolders', coalesce(t.doc->'typeFolders', '[]'::jsonb),
    'hierarchyLevels', coalesce(t.doc->'hierarchyLevels', '[]'::jsonb),
    'layers', coalesce(t.doc->'layers', '[]'::jsonb),
    'processors', coalesce(t.doc->'processors', '[]'::jsonb),
    'processorFolders', coalesce(t.doc->'processorFolders', '[]'::jsonb),
    'tags', coalesce((
      select jsonb_agg(tag order by tag) from (
        select distinct g #>> '{}' as tag
        from jsonb_array_elements(coalesce(t.doc->'items', '[]'::jsonb)) i, jsonb_array_elements(coalesce(i->'tags', '[]'::jsonb)) g
      ) x
    ), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------- field settings (shared by create / update)

/**
 * Apply the settable keys of p_patch to a field definition, validating
 * shapes. Never touches id, kind, children, parentId or folderId (those have
 * their own paths). Returns the updated definition; the default value is
 * coerced last so it is checked against the new options / limits.
 */
create or replace function public.api_field_apply(p_doc jsonb, p_field jsonb, p_patch jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare f jsonb := p_field; k text; v jsonb; fname text;
begin
  if p_patch is null or jsonb_typeof(p_patch) = 'null' then return f; end if;
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'field settings must be an object'; end if;
  for k, v in select * from jsonb_each(p_patch) loop
    case k
      when 'name' then
        if jsonb_typeof(v) <> 'string' or trim(v #>> '{}') = '' then raise exception 'name must be a non-empty string'; end if;
        f := jsonb_set(f, '{name}', to_jsonb(trim(v #>> '{}')), true);
      when 'help', 'unit', 'template', 'formula' then
        if jsonb_typeof(v) = 'null' then v := '""'::jsonb; end if;
        if jsonb_typeof(v) <> 'string' then raise exception '% must be a string', k; end if;
        if k = 'template' and f->>'kind' <> 'group' then raise exception 'template only applies to a composite (kind "group")'; end if;
        if k = 'formula' and f->>'kind' = 'group' then raise exception 'a composite cannot have a formula'; end if;
        f := jsonb_set(f, array[k], v, true);
      when 'required', 'showInTooltip', 'showName', 'selectMultiple', 'refMultiple', 'refShowLinks', 'badge' then
        if jsonb_typeof(v) <> 'boolean' then raise exception '% must be true or false', k; end if;
        f := jsonb_set(f, array[k], v, true);
      when 'min', 'max', 'decimals', 'maxLength' then
        if jsonb_typeof(v) not in ('number', 'null') then raise exception '% must be a number or null', k; end if;
        f := jsonb_set(f, array[k], v, true);
      when 'options' then
        if jsonb_typeof(v) <> 'array' or exists (select 1 from jsonb_array_elements(v) o where jsonb_typeof(o) <> 'string') then
          raise exception 'options must be an array of strings';
        end if;
        f := jsonb_set(f, '{options}', coalesce((select jsonb_agg(distinct trim(o #>> '{}')) from jsonb_array_elements(v) o where trim(o #>> '{}') <> ''), '[]'::jsonb), true);
      when 'refTargets' then
        if jsonb_typeof(v) <> 'array' then raise exception 'refTargets must be an array of type / level ids'; end if;
        f := jsonb_set(f, '{refTargets}', v, true);
      when 'defaultValue' then
        null; -- applied below, once the other settings are in place
      when 'id', 'kind', 'children', 'parentId', 'folderId' then
        raise exception '"%" cannot be changed through the API (use the app)', k;
      else
        raise exception 'Unsupported field setting "%"', k;
    end case;
  end loop;
  if p_patch ? 'defaultValue' then
    if f->>'kind' = 'group' then raise exception 'a composite has no default value'; end if;
    fname := f->>'name';
    f := jsonb_set(f, '{defaultValue}', coalesce(public.api_coerce(p_doc, f, p_patch->'defaultValue'), 'null'::jsonb), true);
  end if;
  return f;
end $$;

-- ---------------------------------------------------------------- api_create_field

/**
 * Create a field. p_field: {name, kind?, ...settings (see api_field_apply),
 * group?: composite id or name to file it into, folder?: field folder id or
 * name, attach?: [type or level ids / names]}. A child of a composite is
 * attached through its group, so `attach` and `group` exclude each other.
 */
create or replace function public.api_create_field(p_api_token text, p_field jsonb, p_author text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t public.timelines := public.api_timeline(p_api_token);
  doc jsonb := t.doc; f jsonb; kind text; grp jsonb; fo jsonb; a jsonb; tgt jsonb; lv jsonb; v bigint;
  hist jsonb := '[]'::jsonb; cols jsonb := '{}'::jsonb; changed_types jsonb := '[]'::jsonb; changed_levels jsonb := '[]'::jsonb;
begin
  if p_field is null or jsonb_typeof(p_field) <> 'object' then raise exception 'p_field must be an object'; end if;
  if coalesce(trim(p_field->>'name'), '') = '' then raise exception 'name is required'; end if;
  kind := coalesce(p_field->>'kind', 'text');
  if kind not in ('text', 'int', 'float', 'toggle', 'select', 'ref', 'group') then
    raise exception 'kind must be one of text, int, float, toggle, select, ref, group';
  end if;
  -- Same defaults as newFieldDef in src/model/fields.ts.
  f := jsonb_build_object(
    'id', public.api_uid(), 'name', trim(p_field->>'name'), 'kind', kind, 'help', '', 'required', false,
    'showInTooltip', false, 'showName', true, 'defaultValue', null, 'maxLength', null, 'min', null, 'max', null,
    'decimals', null, 'unit', '', 'options', '[]'::jsonb, 'selectMultiple', false, 'refTargets', '[]'::jsonb,
    'refMultiple', false, 'refShowLinks', false, 'folderId', null, 'badge', false, 'children', '[]'::jsonb,
    'template', '', 'parentId', null, 'formula', ''
  );
  f := public.api_field_apply(doc, f, p_field - 'name' - 'kind' - 'group' - 'folder' - 'attach');
  if coalesce(p_field->>'folder', '') <> '' then
    fo := public.api_lookup_any(doc, 'fieldFolders', p_field->>'folder', 'field folder');
    f := jsonb_set(f, '{folderId}', to_jsonb(fo->>'id'), true);
  end if;
  if coalesce(p_field->>'group', '') <> '' then
    if p_field ? 'attach' and jsonb_typeof(p_field->'attach') <> 'null' then
      raise exception 'a field inside a composite is attached through its group; drop "attach" or "group"';
    end if;
    grp := public.api_lookup_any(doc, 'fields', p_field->>'group', 'field');
    if grp->>'kind' <> 'group' then raise exception '"%" is not a composite', grp->>'name'; end if;
    f := jsonb_set(f, '{parentId}', to_jsonb(grp->>'id'), true);
    f := jsonb_set(f, '{folderId}', 'null'::jsonb, true);
    grp := jsonb_set(grp, '{children}', coalesce(grp->'children', '[]'::jsonb) || jsonb_build_array(f->'id'), true);
    doc := public.api_put(doc, 'fields', grp);
    hist := hist || jsonb_build_object('col', 'fields', 'entityId', grp->>'id', 'kind', 'update', 'before', public.api_lookup(t.doc, 'fields', grp->>'id', null, 'field'), 'after', grp);
  end if;
  doc := public.api_put(doc, 'fields', f);
  hist := hist || jsonb_build_object('col', 'fields', 'entityId', f->>'id', 'kind', 'add', 'before', null, 'after', f);
  -- Attach to types and / or hierarchy levels (ids or names; types are tried first).
  if p_field ? 'attach' and jsonb_typeof(p_field->'attach') = 'array' then
    for a in select * from jsonb_array_elements(p_field->'attach') loop
      if jsonb_typeof(a) <> 'string' then raise exception 'attach must list type / level ids or names'; end if;
      begin
        tgt := public.api_lookup_any(doc, 'types', a #>> '{}', 'type');
      exception when others then
        tgt := null;
      end;
      if tgt is not null then
        tgt := jsonb_set(tgt, '{fields}', coalesce(tgt->'fields', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('fieldId', f->>'id', 'defaultValue', null)), true);
        doc := public.api_put(doc, 'types', tgt);
        changed_types := changed_types || tgt;
        hist := hist || jsonb_build_object('col', 'types', 'entityId', tgt->>'id', 'kind', 'update', 'before', public.api_lookup(t.doc, 'types', tgt->>'id', null, 'type'), 'after', tgt);
      else
        lv := public.api_lookup_any(doc, 'hierarchyLevels', a #>> '{}', 'type or hierarchy level');
        lv := jsonb_set(lv, '{fields}', coalesce(lv->'fields', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('fieldId', f->>'id', 'defaultValue', null)), true);
        doc := public.api_put(doc, 'hierarchyLevels', lv);
        changed_levels := changed_levels || lv;
        hist := hist || jsonb_build_object('col', 'hierarchyLevels', 'entityId', lv->>'id', 'kind', 'update', 'before', public.api_lookup(t.doc, 'hierarchyLevels', lv->>'id', null, 'level'), 'after', lv);
      end if;
    end loop;
  end if;
  cols := jsonb_build_object('fields', jsonb_build_object('upsert', jsonb_build_array(f) || case when grp is null then '[]'::jsonb else jsonb_build_array(grp) end));
  if jsonb_array_length(changed_types) > 0 then cols := cols || jsonb_build_object('types', jsonb_build_object('upsert', changed_types)); end if;
  if jsonb_array_length(changed_levels) > 0 then cols := cols || jsonb_build_object('hierarchyLevels', jsonb_build_object('upsert', changed_levels)); end if;
  v := public.api_commit(t, doc, hist, jsonb_build_object('cols', cols), p_author);
  return jsonb_build_object('version', v, 'changed', true, 'field', f);
end $$;

-- ---------------------------------------------------------------- api_update_field

/** Change a field's settings (name, help, limits, options, defaults, formula, template, flags). Kind, children, parent and folder stay under the app's control. */
create or replace function public.api_update_field(p_api_token text, p_field_id text, p_patch jsonb, p_author text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines := public.api_timeline(p_api_token); f jsonb; next_f jsonb; v bigint;
begin
  select e into f from jsonb_array_elements(coalesce(t.doc->'fields', '[]'::jsonb)) e where e->>'id' = p_field_id;
  if f is null then raise exception 'No field with id "%"', p_field_id; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'p_patch must be an object'; end if;
  next_f := public.api_field_apply(t.doc, f, p_patch);
  if next_f = f then return jsonb_build_object('version', t.version, 'changed', false, 'field', f); end if;
  v := public.api_commit(t, public.api_put(t.doc, 'fields', next_f),
    jsonb_build_array(jsonb_build_object('col', 'fields', 'entityId', p_field_id, 'kind', 'update', 'before', f, 'after', next_f)),
    jsonb_build_object('cols', jsonb_build_object('fields', jsonb_build_object('upsert', jsonb_build_array(next_f)))),
    p_author);
  return jsonb_build_object('version', v, 'changed', true, 'field', next_f);
end $$;

-- ---------------------------------------------------------------- grants

revoke execute on function public.api_lookup_any(jsonb, text, text, text) from public, anon, authenticated;
revoke execute on function public.api_field_root(jsonb, text) from public, anon, authenticated;
revoke execute on function public.api_field_attached(jsonb, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.api_field_values(jsonb, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.api_field_apply(jsonb, jsonb, jsonb) from public, anon, authenticated;
