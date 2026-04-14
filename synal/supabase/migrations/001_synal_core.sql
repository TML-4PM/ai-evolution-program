-- synal core schema migration v1.0.1
-- Signal → Task → Action → Proof spine
-- idempotent, RLS-ready

-- Tasks (central work object)
create table if not exists synal_tasks (
  id               uuid primary key default gen_random_uuid(),
  event_type       text not null,
  signal_family    text not null default 'general',
  source           text not null,
  actor            text not null default 'system',
  context          jsonb default '{}',
  payload          jsonb default '{}',
  outcome          jsonb default '{}',
  trace_id         text not null,
  idempotency_key  text unique not null,
  status           text not null default 'QUEUED'
                   check (status in ('QUEUED','RUNNING','PROOF_NEEDED','DONE','FAILED','BLOCKED')),
  proof_required   boolean not null default true,
  proof_status     text not null default 'PENDING'
                   check (proof_status in ('PENDING','PROVEN','FAILED','EXEMPT')),
  envelope_version text default '2.1',
  is_rd            boolean default false,
  project_code     text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists idx_synal_tasks_status   on synal_tasks(status);
create index if not exists idx_synal_tasks_trace    on synal_tasks(trace_id);
create index if not exists idx_synal_tasks_family   on synal_tasks(signal_family);
create index if not exists idx_synal_tasks_created  on synal_tasks(created_at desc);

-- Signals
create table if not exists synal_signals (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid references synal_tasks(id) on delete set null,
  signal_family  text not null,
  source         text not null,
  payload        jsonb default '{}',
  trace_id       text,
  status         text not null default 'ACTIVE',
  created_at     timestamptz default now()
);

create index if not exists idx_synal_signals_task   on synal_signals(task_id);
create index if not exists idx_synal_signals_family on synal_signals(signal_family);

-- Proofs
create table if not exists synal_proofs (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid references synal_tasks(id) on delete cascade,
  claim         text not null,
  evidence      jsonb default '{}',
  verifier      text,
  status        text not null default 'PENDING'
                check (status in ('PENDING','PROVEN','FAILED')),
  timestamp_utc timestamptz default now()
);

create index if not exists idx_synal_proofs_task on synal_proofs(task_id);

-- Event log (immutable telemetry)
create table if not exists synal_event_log (
  id            bigint generated always as identity primary key,
  event_type    text not null,
  entity_key    text,
  entity_type   text,
  trace_id      text,
  source        text,
  actor         text,
  payload       jsonb default '{}',
  timestamp_utc timestamptz default now()
);

create index if not exists idx_synal_events_trace  on synal_event_log(trace_id);
create index if not exists idx_synal_events_ts     on synal_event_log(timestamp_utc desc);
create index if not exists idx_synal_events_type   on synal_event_log(event_type);

-- Widget registry
create table if not exists synal_widget_registry (
  id           uuid primary key default gen_random_uuid(),
  widget_key   text unique not null,
  title        text not null,
  purpose      text,
  render_mode  text default 'card',
  data_source  text,
  actions      jsonb default '[]',
  permissions  jsonb default '[]',
  is_active    boolean default true,
  created_at   timestamptz default now()
);

-- Retry queue (for failed bridge calls)
create table if not exists synal_retry_queue (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text unique not null,
  envelope        jsonb not null,
  attempts        int default 0,
  last_error      text,
  next_retry_at   timestamptz,
  status          text default 'PENDING',
  created_at      timestamptz default now()
);

-- Updated_at trigger
create or replace function fn_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_synal_tasks_updated on synal_tasks;
create trigger trg_synal_tasks_updated
  before update on synal_tasks
  for each row execute function fn_set_updated_at();

-- Canonical view: task summary
create or replace view v_synal_task_summary as
select
  status,
  signal_family,
  count(*)            as task_count,
  sum(case when proof_status = 'PROVEN' then 1 else 0 end) as proven_count,
  max(created_at)     as latest_at
from synal_tasks
group by status, signal_family
order by status, signal_family;

-- RLS (enable but allow service role full access)
alter table synal_tasks       enable row level security;
alter table synal_signals     enable row level security;
alter table synal_proofs      enable row level security;
alter table synal_event_log   enable row level security;
alter table synal_retry_queue enable row level security;

-- Service role bypass
create policy "service_full" on synal_tasks       for all using (auth.role() = 'service_role');
create policy "service_full" on synal_signals     for all using (auth.role() = 'service_role');
create policy "service_full" on synal_proofs      for all using (auth.role() = 'service_role');
create policy "service_full" on synal_event_log   for all using (auth.role() = 'service_role');
create policy "service_full" on synal_retry_queue for all using (auth.role() = 'service_role');
