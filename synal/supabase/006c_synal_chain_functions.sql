create or replace function public.synal_seed_chain_for_task(p_task_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_chain_key text;
begin
  v_chain_key := 'chain:' || p_task_id::text;
  insert into public.synal_agent_chains (chain_key, task_id, total_steps, chain_definition)
  values (v_chain_key, p_task_id, 2, '[{"step":1,"action_type":"trigger_agent"},{"step":2,"action_type":"write_proof"}]')
  on conflict (chain_key) do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.synal_write_proof(p_task_id uuid,p_proof_type text,p_evidence jsonb)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  insert into public.synal_proof (task_id,proof_type,proof_status,evidence,created_at,verified_at)
  values (p_task_id,p_proof_type,'verified',p_evidence,now(),now())
  returning id into v_id;

  update public.synal_tasks set status='completed',completed_at=now() where id=p_task_id;

  return v_id;
end;
$$;
