-- Suggest links and change history.
--
-- A third token per timeline, the *suggest* token, opens the app in suggest
-- mode: everything the person does becomes a proposal instead of an edit.
-- Roles are now 'edit' (edit directly or suggest), 'suggest' (preview and
-- suggest) and 'view' (read only).
--
-- `timeline_history` records every change that reached the document, per
-- entity, with the collaborator who made it: direct edits, undo/redo and
-- applied proposals. The Inspector shows it as a previewable history.

-- ---------------------------------------------------------------- suggest token / role

alter table public.timelines add column if not exists suggest_token text;
update public.timelines set suggest_token = public.gen_token() where suggest_token is null;
alter table public.timelines alter column suggest_token set not null;
alter table public.timelines alter column suggest_token set default public.gen_token();
create unique index if not exists timelines_suggest_token_key on public.timelines (suggest_token);

alter table public.timeline_members drop constraint if exists timeline_members_role_check;
alter table public.timeline_members add constraint timeline_members_role_check check (role in ('edit', 'suggest', 'view'));

/** Role granted by a token, or null when the token is unknown. */
create or replace function public.share_role(t public.timelines, p_token text) returns text
language sql immutable set search_path = public as $$
  select case
    when t.edit_token = p_token then 'edit'
    when t.suggest_token = p_token then 'suggest'
    when t.view_token = p_token then 'view'
  end
$$;

/** Upsert the caller as a member; a membership only ever moves up (view < suggest < edit). */
create or replace function public.share_join(p_timeline uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.timeline_members(timeline_id, user_id, role) values (p_timeline, auth.uid(), p_role)
  on conflict (timeline_id, user_id) do update
    set role = case
      when public.timeline_members.role = 'edit' or excluded.role = 'edit' then 'edit'
      when public.timeline_members.role = 'suggest' or excluded.role = 'suggest' then 'suggest'
      else excluded.role end;
end $$;

create or replace function public.share_create(p_name text, p_doc jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines;
begin
  insert into public.timelines(name, doc, owner_id, edit_token, suggest_token, view_token)
  values (coalesce(nullif(p_name, ''), 'Untitled'), p_doc, auth.uid(), public.gen_token(), public.gen_token(), public.gen_token())
  returning * into t;
  perform public.share_join(t.id, 'edit');
  return jsonb_build_object(
    'id', t.id, 'name', t.name, 'version', t.version,
    'editToken', t.edit_token, 'suggestToken', t.suggest_token, 'viewToken', t.view_token,
    'role', 'edit', 'owner', true
  );
end $$;

create or replace function public.share_open(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines; r text;
begin
  select * into t from public.timelines where edit_token = p_token or suggest_token = p_token or view_token = p_token;
  if t.id is null then return null; end if;
  r := public.share_role(t, p_token);
  perform public.share_join(t.id, r);
  return jsonb_build_object(
    'id', t.id, 'name', t.name, 'doc', t.doc, 'version', t.version,
    'editToken', case when r = 'edit' then t.edit_token else null end,
    'suggestToken', case when r in ('edit', 'suggest') then t.suggest_token else null end,
    'viewToken', t.view_token,
    'role', r,
    'owner', (r = 'edit' and public.share_is_admin(t))
  );
end $$;

create or replace function public.share_pull(p_token text, p_version bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines;
begin
  select * into t from public.timelines where edit_token = p_token or suggest_token = p_token or view_token = p_token;
  if t.id is null then return jsonb_build_object('gone', true); end if;
  if t.version <= p_version then return jsonb_build_object('version', t.version); end if;
  return jsonb_build_object('version', t.version, 'name', t.name, 'doc', t.doc);
end $$;

create or replace function public.share_regenerate(p_edit_token text, p_which text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines; nt text;
begin
  select * into t from public.timelines where edit_token = p_edit_token;
  if t.id is null or not public.share_is_admin(t) then return null; end if;
  nt := public.gen_token();
  if p_which = 'edit' then
    update public.timelines set edit_token = nt where id = t.id;
    delete from public.timeline_members where timeline_id = t.id and role = 'edit'
      and (t.owner_id is null or user_id <> t.owner_id);
  elsif p_which = 'suggest' then
    update public.timelines set suggest_token = nt where id = t.id;
    delete from public.timeline_members where timeline_id = t.id and role = 'suggest';
  elsif p_which = 'view' then
    update public.timelines set view_token = nt where id = t.id;
    delete from public.timeline_members where timeline_id = t.id and role = 'view';
  else
    return null;
  end if;
  return jsonb_build_object('token', nt);
end $$;

-- ---------------------------------------------------------------- proposals: suggesters may create and read

create or replace function public.proposal_create(
  p_edit_token text, p_title text, p_summary text, p_author text, p_base_version bigint, p_changes jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines; p public.timeline_proposals;
begin
  select * into t from public.timelines where edit_token = p_edit_token or suggest_token = p_edit_token;
  if t.id is null then return null; end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception 'A proposal needs at least one change';
  end if;
  insert into public.timeline_proposals(timeline_id, title, summary, author, base_version, changes)
  values (
    t.id, coalesce(nullif(p_title, ''), 'Untitled proposal'), coalesce(p_summary, ''),
    coalesce(nullif(p_author, ''), 'Someone'), coalesce(p_base_version, t.version), p_changes
  ) returning * into p;
  return public.proposal_row(p);
end $$;

create or replace function public.proposal_list(p_edit_token text, p_since timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines;
begin
  select * into t from public.timelines where edit_token = p_edit_token or suggest_token = p_edit_token;
  if t.id is null then return null; end if;
  return jsonb_build_object(
    'version', t.version,
    'ids', coalesce((select jsonb_agg(p.id order by p.created_at) from public.timeline_proposals p where p.timeline_id = t.id), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(public.proposal_row(p) order by p.created_at)
      from public.timeline_proposals p
      where p.timeline_id = t.id and (p_since is null or p.updated_at > p_since)
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.proposal_get(p_edit_token text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines; p public.timeline_proposals;
begin
  select * into t from public.timelines where edit_token = p_edit_token or suggest_token = p_edit_token;
  if t.id is null then return null; end if;
  select * into p from public.timeline_proposals where id = p_id and timeline_id = t.id;
  if p.id is null then return null; end if;
  return public.proposal_row(p);
end $$;

-- ---------------------------------------------------------------- history

create table public.timeline_history (
  id bigserial primary key,
  timeline_id uuid not null references public.timelines(id) on delete cascade,
  col text not null,
  entity_id text not null,
  kind text not null check (kind in ('add', 'update', 'remove', 'set')),
  before jsonb,
  after jsonb,
  /** {name, color} of the collaborator, as shown in presence. */
  author jsonb not null default '{}'::jsonb,
  /** 'edit' | 'undo' | 'redo' | 'proposal:<id>' | 'agent' … */
  source text not null default 'edit',
  at timestamptz not null default now()
);
create index if not exists timeline_history_entity_idx on public.timeline_history (timeline_id, entity_id, at desc);
alter table public.timeline_history enable row level security;
-- No policies on purpose: token-checked RPCs only.

/** Editors append entries: [{col, entityId, kind, before, after, at?}], all stamped with p_author / p_source. Keeps the last 200 per entity. */
create or replace function public.history_append(p_edit_token text, p_author jsonb, p_source text, p_entries jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare t public.timelines; n integer;
begin
  select * into t from public.timelines where edit_token = p_edit_token;
  if t.id is null then return null; end if;
  if jsonb_typeof(p_entries) <> 'array' then return 0; end if;
  insert into public.timeline_history(timeline_id, col, entity_id, kind, before, after, author, source, at)
  select t.id, e->>'col', e->>'entityId', e->>'kind', e->'before', e->'after',
         coalesce(p_author, '{}'::jsonb), coalesce(nullif(p_source, ''), 'edit'),
         coalesce((e->>'at')::timestamptz, now())
  from jsonb_array_elements(p_entries) e
  where e->>'kind' in ('add', 'update', 'remove', 'set') and coalesce(e->>'entityId', '') <> '';
  get diagnostics n = row_count;
  -- Trim: keep the newest 200 entries per touched entity.
  delete from public.timeline_history h
  using (
    select id from (
      select id, row_number() over (partition by entity_id order by at desc, id desc) as rn
      from public.timeline_history
      where timeline_id = t.id and entity_id in (select distinct e->>'entityId' from jsonb_array_elements(p_entries) e)
    ) x where rn > 200
  ) old
  where h.id = old.id;
  return n;
end $$;

/** History of one entity (newest first), readable with any of the three links. */
create or replace function public.history_list(p_token text, p_entity_id text, p_limit integer default 50) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines;
begin
  select * into t from public.timelines where edit_token = p_token or suggest_token = p_token or view_token = p_token;
  if t.id is null then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', h.id, 'col', h.col, 'entityId', h.entity_id, 'kind', h.kind, 'before', h.before, 'after', h.after,
      'author', h.author, 'source', h.source, 'at', h.at) order by h.at desc, h.id desc)
    from (
      select * from public.timeline_history
      where timeline_id = t.id and entity_id = p_entity_id
      order by at desc, id desc
      limit greatest(1, least(coalesce(p_limit, 50), 200))
    ) h
  ), '[]'::jsonb);
end $$;

revoke execute on function public.share_role(public.timelines, text) from public, anon, authenticated;
