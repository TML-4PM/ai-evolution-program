// synal-task-intake — Lambda handler v1.0.1
// Receives canonical event envelope → creates task → emits telemetry

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  // Health check
  if (event.path === '/synal/health' || event.httpMethod === 'GET') {
    return ok({ status: 'healthy', version: '1.0.1', lambda: 'synal-task-intake', ts: new Date().toISOString() });
  }

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
  } catch {
    return err(400, 'Invalid JSON body');
  }

  const {
    event_type, signal_family, source, actor,
    context = {}, payload = {},
    trace_id, idempotency_key, timestamp_utc, version
  } = body;

  if (!event_type || !trace_id) {
    return err(400, 'Missing required: event_type, trace_id');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Idempotency check
  const { data: existing } = await supabase
    .from('synal_tasks')
    .select('id, status')
    .eq('idempotency_key', idempotency_key)
    .maybeSingle();

  if (existing) {
    return ok({ status: 'duplicate', task_id: existing.id, message: 'Already processed' });
  }

  // Create task
  const task = {
    event_type,
    signal_family:   signal_family || 'general',
    source:          source || 'unknown',
    actor:           actor || 'system',
    context,
    payload,
    trace_id,
    idempotency_key: idempotency_key || trace_id,
    status:          'QUEUED',
    proof_required:  true,
    proof_status:    'PENDING',
    envelope_version: version || '2.1',
    created_at:      timestamp_utc || new Date().toISOString()
  };

  const { data: created, error: insertErr } = await supabase
    .from('synal_tasks')
    .insert(task)
    .select('id, status, trace_id')
    .single();

  if (insertErr) {
    console.error('synal-task-intake insert error:', insertErr);
    return err(500, insertErr.message);
  }

  // Emit telemetry event
  await supabase.from('synal_event_log').insert({
    event_type:  'TASK_CREATED',
    entity_key:  created.id,
    entity_type: 'synal_task',
    trace_id,
    source,
    actor,
    payload:     { task_id: created.id, signal_family },
    timestamp_utc: new Date().toISOString()
  });

  return ok({
    status:     'QUEUED',
    task_id:    created.id,
    trace_id,
    next:       'synal-auto-execute',
    timestamp:  new Date().toISOString()
  });
};

const ok  = (body) => ({ statusCode: 200, headers: cors(), body: JSON.stringify(body) });
const err = (code, msg) => ({ statusCode: code, headers: cors(), body: JSON.stringify({ error: msg }) });
const cors = () => ({
  'Content-Type':                'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,x-api-key'
});
