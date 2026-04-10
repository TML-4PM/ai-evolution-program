create table if not exists public.synal_proof (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.synal_tasks(id) on delete cascade,
  proof_type text not null,
  proof_status text not null default 'recorded' check (proof_status in ('recorded','verified','rejected')),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);
