-- Synal Unified Task + Execution Pack

create table if not exists public.synal_tasks (
  id uuid primary key default gen_random_uuid(),
  task_key text unique,
  source_type text not null check (source_type in ('snap','alert','intervention','spiral','manual','system')),
  source_id text,
  parent_task_id uuid references public.synal_tasks(id) on delete set null,
  user_id uuid,
  org_id uuid,
  title text not null,
  summary text,
  intent text,
  impact_area text,
  priority text not null default 'medium' check (priority in ('low','medium','high','critical')),
  status text not null default 'detected' check (status in ('detected','suggested','approved','queued','running','completed','failed','dismissed','archived')),
  surface text,
  source_app text,
  page_url text,
  domain text,
  page_title text,
  context jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  outcome jsonb not null default '{}'::jsonb,
  execution jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.synal_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.synal_tasks(id) on delete cascade,
  event_type text not null,
  actor_type text not null default 'system',
  actor_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.synal_task_actions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.synal_tasks(id) on delete cascade,
  action_type text not null,
  action_label text not null,
  action_status text not null default 'available' check (action_status in ('available','queued','running','completed','failed','dismissed')),
  action_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_synal_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_synal_tasks_updated_at on public.synal_tasks;
create trigger trg_synal_tasks_updated_at
before update on public.synal_tasks
for each row execute function public.set_synal_updated_at();

drop trigger if exists trg_synal_task_actions_updated_at on public.synal_task_actions;
create trigger trg_synal_task_actions_updated_at
before update on public.synal_task_actions
for each row execute function public.set_synal_updated_at();

create or replace function public.synal_create_task(
  p_task_key text,
  p_source_type text,
  p_source_id text,
  p_title text,
  p_summary text default null,
  p_user_id uuid default null,
  p_org_id uuid default null,
  p_intent text default null,
  p_impact_area text default null,
  p_priority text default 'medium',
  p_surface text default null,
  p_source_app text default null,
  p_page_url text default null,
  p_domain text default null,
  p_page_title text default null,
  p_context jsonb default '{}'::jsonb,
  p_evidence jsonb default '{}'::jsonb
) returns uuid
language plpgsql
as $$
declare
  v_task_id uuid;
begin
  insert into public.synal_tasks (
    task_key, source_type, source_id, title, summary,
    user_id, org_id, intent, impact_area, priority,
    surface, source_app, page_url, domain, page_title,
    context, evidence
  )
  values (
    p_task_key, p_source_type, p_source_id, p_title, p_summary,
    p_user_id, p_org_id, p_intent, p_impact_area, p_priority,
    p_surface, p_source_app, p_page_url, p_domain, p_page_title,
    coalesce(p_context, '{}'::jsonb), coalesce(p_evidence, '{}'::jsonb)
  )
  on conflict (task_key) do update set
    summary = excluded.summary,
    priority = excluded.priority,
    context = excluded.context,
    evidence = excluded.evidence,
    updated_at = now()
  returning id into v_task_id;

  insert into public.synal_task_events (task_id, event_type, actor_type, payload)
  values (v_task_id, 'task_created_or_updated', 'system', jsonb_build_object('task_key', p_task_key));

  return v_task_id;
end;
$$;

create or replace function public.synal_generate_tasks_from_alerts()
returns jsonb
language plpgsql
as $$
declare
  v_created int := 0;
begin
  insert into public.synal_tasks (
    task_key, source_type, source_id, title, summary, priority, status,
    surface, source_app, context, evidence
  )
  select
    'alert:' || cca.id::text,
    'alert',
    cca.id::text,
    case
      when cca.title = 'Dark spot detected' then 'Investigate dark spot'
      when cca.title = 'Repeated snaps without outcome' then 'Review repeated pattern'
      else cca.title
    end,
    cca.summary,
    case when cca.severity in ('critical','high') then 'high' else 'medium' end,
    'suggested',
    'command-centre',
    'command-centre',
    jsonb_build_object('alert_id', cca.id, 'severity', cca.severity, 'entity_type', cca.entity_type, 'entity_id', cca.entity_id),
    jsonb_build_object('alert', cca.evidence)
  from public.command_centre_alerts cca
  where cca.status = 'open'
    and not exists (
      select 1 from public.synal_tasks st where st.task_key = 'alert:' || cca.id::text
    );

  GET DIAGNOSTICS v_created = ROW_COUNT;
  return jsonb_build_object('created_tasks', v_created);
end;
$$;

create or replace function public.synal_prepare_task_actions(p_task_id uuid)
returns jsonb
language plpgsql
as $$
begin
  insert into public.synal_task_actions (task_id, action_type, action_label, action_payload)
  values
    (p_task_id, 'open_command_centre', 'Open in Command Centre', jsonb_build_object('task_id', p_task_id)),
    (p_task_id, 'run_summary', 'Run Summary', jsonb_build_object('task_id', p_task_id)),
    (p_task_id, 'trigger_agent', 'Trigger Agent', jsonb_build_object('task_id', p_task_id)),
    (p_task_id, 'dismiss_task', 'Dismiss', jsonb_build_object('task_id', p_task_id))
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'task_id', p_task_id);
end;
$$;

create or replace function public.synal_refresh_task_state()
returns jsonb
language plpgsql
as $$
declare
  v_alert jsonb;
begin
  v_alert := public.synal_generate_tasks_from_alerts();
  return jsonb_build_object('alerts', v_alert);
end;
$$;

create or replace view public.v_synal_tasks_open as
select
  id, task_key, source_type, title, summary, priority, status,
  intent, impact_area, surface, source_app, domain, created_at, updated_at
from public.synal_tasks
where status in ('detected','suggested','approved','queued','running')
order by
  case priority when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end desc,
  created_at desc;

create or replace view public.v_synal_tasks_ready_to_run as
select *
from public.synal_tasks
where status in ('approved','queued')
order by updated_at asc;

insert into public.command_centre_widgets
(slug, title, description, widget_type, position_row, position_col, width, height, config)
values
  ('synal-tasks', 'Synal Tasks', 'Unified task queue across snaps, alerts, interventions and Spiral.', 'table', 16, 1, 12, 4,
   '{"source":"v_synal_tasks_open","limit":100}'::jsonb)
on conflict (slug) do update set
  title = excluded.title,
  description = excluded.description,
  widget_type = excluded.widget_type,
  position_row = excluded.position_row,
  position_col = excluded.position_col,
  width = excluded.width,
  height = excluded.height,
  config = excluded.config,
  is_active = true,
  updated_at = now();
