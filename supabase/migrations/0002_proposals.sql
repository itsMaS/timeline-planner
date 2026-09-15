-- Proposals: suggested changes to a shared timeline that wait for review in
-- the app instead of landing in the document directly. Created by agents (or
-- anyone with the edit link) through the RPCs below; the app lists them,
-- shows per-change diffs, and applies the accepted ones as one normal edit.
--
-- `changes` is an array of entity-level changes (see src/model/proposal.ts):
--   { id, col, kind: 'add'|'update'|'remove'|'set', entityId, before, after, note? }
-- `decisions` maps change id -> 'applied' | 'rejected'. A proposal is 'done'
-- once every change has a decision.

create table public.timeline_proposals (
  id uuid primary key default gen_random_uuid(),
  timeline_id uuid not null references public.timelines(id) on delete cascade,
  title text not null default 'Untitled proposal',
  summary text not null default '',
  author text not null default 'Agent',
  base_version bigint not null default 0,
  changes jsonb not null default '[]'::jsonb,
  decisions jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists timeline_proposals_timeline_idx
  on public.timeline_proposals (timeline_id, updated_at desc);
alter table public.timeline_proposals enable row level security;
-- No policies on purpose: every access goes through the edit-token RPCs below.

create or replace function public.proposal_row(p public.timeline_proposals) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'id', p.id, 'timelineId', p.timeline_id, 'title', p.title, 'summary', p.summary,
    'author', p.author, 'baseVersion', p.base_version, 'changes', p.changes,
    'decisions', p.decisions, 'status', p.status,
    'createdAt', p.created_at, 'updatedAt', p.updated_at
  )
$$;

create or replace function public.proposal_create(
  p_edit_token text, p_title text, p_summary text, p_author text, p_base_version bigint, p_changes jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines; p public.timeline_proposals;
begin
  select * into t from public.timelines where edit_token = p_edit_token;
  if t.id is null then return null; end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception 'A proposal needs at least one change';
  end if;
  insert into public.timeline_proposals(timeline_id, title, summary, author, base_version, changes)
  values (
    t.id, coalesce(nullif(p_title, ''), 'Untitled proposal'), coalesce(p_summary, ''),
    coalesce(nullif(p_author, ''), 'Agent'), coalesce(p_base_version, t.version), p_changes
  ) returning * into p;
  return public.proposal_row(p);
end $$;

/**
 * Proposals of a timeline. With p_since, only rows updated after that moment
 * are returned in full; `ids` always lists every proposal so deletions can be
 * noticed cheaply. Done proposals are included (the app keeps them as history).
 */
create or replace function public.proposal_list(p_edit_token text, p_since timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines;
begin
  select * into t from public.timelines where edit_token = p_edit_token;
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
  select * into t from public.timelines where edit_token = p_edit_token;
  if t.id is null then return null; end if;
  select * into p from public.timeline_proposals where id = p_id and timeline_id = t.id;
  if p.id is null then return null; end if;
  return public.proposal_row(p);
end $$;

/** Merge decisions ({changeId: 'applied'|'rejected'}); marks the proposal done when every change is decided. */
create or replace function public.proposal_decide(p_edit_token text, p_id uuid, p_decisions jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines; p public.timeline_proposals; total int; decided int;
begin
  select * into t from public.timelines where edit_token = p_edit_token;
  if t.id is null then return null; end if;
  update public.timeline_proposals
    set decisions = decisions || coalesce(p_decisions, '{}'::jsonb), updated_at = now()
    where id = p_id and timeline_id = t.id
    returning * into p;
  if p.id is null then return null; end if;
  select count(*) into total from jsonb_array_elements(p.changes);
  select count(*) into decided from jsonb_array_elements(p.changes) c
    where p.decisions ? (c.value->>'id');
  if decided >= total and p.status <> 'done' then
    update public.timeline_proposals set status = 'done' where id = p.id returning * into p;
  end if;
  return public.proposal_row(p);
end $$;

create or replace function public.proposal_delete(p_edit_token text, p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare t public.timelines; n int;
begin
  select * into t from public.timelines where edit_token = p_edit_token;
  if t.id is null then return false; end if;
  delete from public.timeline_proposals where id = p_id and timeline_id = t.id;
  get diagnostics n = row_count;
  return n > 0;
end $$;

/**
 * Direct save with optimistic concurrency, for agents applying changes
 * outright: fails (returns {conflict, version}) when the timeline moved past
 * p_expected_version since the agent read it.
 */
create or replace function public.share_save_if(p_token text, p_expected_version bigint, p_name text, p_doc jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.timelines; v bigint;
begin
  select * into t from public.timelines where edit_token = p_token;
  if t.id is null then return jsonb_build_object('gone', true); end if;
  if t.version <> p_expected_version then
    return jsonb_build_object('conflict', true, 'version', t.version);
  end if;
  update public.timelines
    set doc = p_doc, name = coalesce(nullif(p_name, ''), name), version = version + 1, updated_at = now()
    where id = t.id
    returning version into v;
  return jsonb_build_object('version', v);
end $$;

revoke execute on function public.proposal_row(public.timeline_proposals) from public, anon, authenticated;
