create table if not exists public.synal_agent_chains (
  id uuid primary key default gen_random_uuid(),
  chain_key text unique,
  task_id uuid not null references public.synal_tasks(id) on delete cascade,
  chain_status text not null default 'ready' check (chain_status in ('ready','running','completed','failed','blocked')),
  current_step int not null default 0,
  total_steps int not null default 0,
  chain_definition jsonb not null default '[]'::jsonb,
  chain_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create or replace function public.set_synal_chain_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_synal_agent_chains_updated_at on public.synal_agent_chains;
create trigger trg_synal_agent_chains_updated_at
before update on public.synal_agent_chains
for each row execute function public.set_synal_chain_updated_at();
