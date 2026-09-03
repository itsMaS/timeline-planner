create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table public.timelines (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Untitled',
  doc jsonb not null,
  version bigint not null default 1,
  owner_id uuid references auth.users(id) on delete set null,
  edit_token text not null unique,
  view_token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.timelines enable row level security;
-- No policies on purpose: every access goes through the token-checked RPCs below.

create table public.timeline_members (
  timeline_id uuid not null references public.timelines(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('edit', 'view')),
  joined_at timestamptz not null default now(),
  primary key (timeline_id, user_id)
);
create index if not exists timeline_members_user_idx on public.timeline_members (user_id, timeline_id);
alter table public.timeline_members enable row level security;
create policy "members read own memberships" on public.timeline_members
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- helpers

create or replace function public.gen_token() returns text
language sql volatile set search_path = public as $$
  select translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/=', '-_')
$$;

/** Upsert the caller as a member; never downgrade an existing 'edit' membership. */
create or replace function public.share_join(p_timeline uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.timeline_members(timeline_id, user_id, role) values (p_timeline, auth.uid(), p_role)
  on conflict (timeline_id, user_id) do update
    set role = case when public.timeline_members.role = 'edit' then 'edit' else excluded.role end;
end $$;

/** Owner-only (or anyone with the edit link when the timeline has no owner). */
create or replace function public.share_is_admin(t public.timelines) returns boolean
language sql stable set search_path = public as $$
  select t.owner_id is null or t.owner_id = auth.uid()
$$;

-- ---------------------------------------------------------------- rpcs

create or replace function public.share_create(p_name text, p_doc jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines;
begin
  insert into public.timelines(name, doc, owner_id, edit_token, view_token)
  values (coalesce(nullif(p_name, ''), 'Untitled'), p_doc, auth.uid(), public.gen_token(), public.gen_token())
  returning * into t;
  perform public.share_join(t.id, 'edit');
  return jsonb_build_object(
    'id', t.id, 'name', t.name, 'version', t.version,
    'editToken', t.edit_token, 'viewToken', t.view_token,
    'role', 'edit', 'owner', true
  );
end $$;

-- 'owner' means "can administer" (regenerate links / stop sharing), matching share_is_admin.
create or replace function public.share_open(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines; r text;
begin
  select * into t from public.timelines where edit_token = p_token or view_token = p_token;
  if t.id is null then return null; end if;
  r := case when t.edit_token = p_token then 'edit' else 'view' end;
  perform public.share_join(t.id, r);
  return jsonb_build_object(
    'id', t.id, 'name', t.name, 'doc', t.doc, 'version', t.version,
    'editToken', case when r = 'edit' then t.edit_token else null end,
    'viewToken', t.view_token,
    'role', r,
    'owner', (r = 'edit' and public.share_is_admin(t))
  );
end $$;

/** Cheap refresh: returns the doc only when the server is ahead of p_version. */
create or replace function public.share_pull(p_token text, p_version bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines;
begin
  select * into t from public.timelines where edit_token = p_token or view_token = p_token;
  if t.id is null then return jsonb_build_object('gone', true); end if;
  if t.version <= p_version then return jsonb_build_object('version', t.version); end if;
  return jsonb_build_object('version', t.version, 'name', t.name, 'doc', t.doc);
end $$;

create or replace function public.share_save(p_token text, p_name text, p_doc jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  update public.timelines
    set doc = p_doc, name = coalesce(nullif(p_name, ''), name), version = version + 1, updated_at = now()
    where edit_token = p_token
    returning version into v;
  if v is null then return jsonb_build_object('gone', true); end if;
  return jsonb_build_object('version', v);
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
  elsif p_which = 'view' then
    update public.timelines set view_token = nt where id = t.id;
    delete from public.timeline_members where timeline_id = t.id and role = 'view';
  else
    return null;
  end if;
  return jsonb_build_object('token', nt);
end $$;

create or replace function public.share_delete(p_edit_token text) returns boolean
language plpgsql security definer set search_path = public as $$
declare t public.timelines;
begin
  select * into t from public.timelines where edit_token = p_edit_token;
  if t.id is null or not public.share_is_admin(t) then return false; end if;
  delete from public.timelines where id = t.id;
  return true;
end $$;

revoke execute on function public.share_join(uuid, text) from public, anon, authenticated;
revoke execute on function public.share_is_admin(public.timelines) from public, anon, authenticated;

-- ---------------------------------------------------------------- realtime authorization
-- Topic per timeline: 'timeline:<uuid>'. Members receive; editors broadcast; everyone tracks presence.

create policy "timeline members can receive" on realtime.messages
  for select to authenticated using (
    exists (
      select 1 from public.timeline_members m
      where m.user_id = (select auth.uid())
        and 'timeline:' || m.timeline_id::text = (select realtime.topic())
        and realtime.messages.extension in ('broadcast', 'presence')
    )
  );

create policy "timeline members can send" on realtime.messages
  for insert to authenticated with check (
    exists (
      select 1 from public.timeline_members m
      where m.user_id = (select auth.uid())
        and 'timeline:' || m.timeline_id::text = (select realtime.topic())
        and (
          realtime.messages.extension = 'presence'
          or (realtime.messages.extension = 'broadcast' and m.role = 'edit')
        )
    )
  );

-- ---------------------------------------------------------------- image storage

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('timeline-images', 'timeline-images', true, 5242880,
        array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
on conflict (id) do nothing;

create policy "editors upload timeline images" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'timeline-images'
    and exists (
      select 1 from public.timeline_members m
      where m.user_id = (select auth.uid()) and m.role = 'edit'
        and m.timeline_id::text = (storage.foldername(name))[1]
    )
  );

create policy "editors delete timeline images" on storage.objects
  for delete to authenticated using (
    bucket_id = 'timeline-images'
    and exists (
      select 1 from public.timeline_members m
      where m.user_id = (select auth.uid()) and m.role = 'edit'
        and m.timeline_id::text = (storage.foldername(name))[1]
    )
  );

create policy "anyone reads timeline images" on storage.objects
  for select to anon, authenticated using (bucket_id = 'timeline-images');
