// synal-auto-execute — Lambda handler v1.0.1
// Picks up QUEUED tasks → executes → requires proof

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Health check
  if (event.path === '/synal/task-run' && event.httpMethod === 'GET') {
    return ok({ status: 'healthy', version: '1.0.1', lambda: 'synal-auto-execute' });
  }

  // Process a batch of QUEUED tasks
  const { data: tasks, error } = await supabase
    .from('synal_tasks')
    .select('*')
    .eq('status', 'QUEUED')
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) return err(500, error.message);
  if (!tasks?.length) return ok({ status: 'idle', processed: 0 });

  const results = [];

  for (const task of tasks) {
    try {
      // Mark running
      await supabase.from('synal_tasks').update({ status: 'RUNNING', updated_at: new Date().toISOString() }).eq('id', task.id);

      // Execute based on event_type
      const outcome = await executeTask(task, supabase);

      // Mark done, require proof
      await supabase.from('synal_tasks').update({
        status:       outcome.success ? 'PROOF_NEEDED' : 'FAILED',
        outcome,
        updated_at:   new Date().toISOString()
      }).eq('id', task.id);

      // Log
      await supabase.from('synal_event_log').insert({
        event_type:    outcome.success ? 'TASK_EXECUTED' : 'TASK_FAILED',
        entity_key:    task.id,
        entity_type:   'synal_task',
        trace_id:      task.trace_id,
        source:        'synal-auto-execute',
        actor:         'system',
        payload:       outcome,
        timestamp_utc: new Date().toISOString()
      });

      results.push({ task_id: task.id, status: outcome.success ? 'PROOF_NEEDED' : 'FAILED' });

    } catch (ex) {
      await supabase.from('synal_tasks').update({ status: 'FAILED', outcome: { error: ex.message }, updated_at: new Date().toISOString() }).eq('id', task.id);
      results.push({ task_id: task.id, status: 'FAILED', error: ex.message });
    }
  }

  return ok({ status: 'processed', count: results.length, results });
};

async function executeTask(task, supabase) {
  switch (task.event_type) {
    case 'BROWSER_SNAP':
    case 'SELECTION_SNAP':
    case 'PAGE_SNAP':
      // Store as signal record
      const { data: signal } = await supabase.from('synal_signals').insert({
        task_id:       task.id,
        signal_family: task.signal_family,
        source:        task.source,
        payload:       task.payload,
        trace_id:      task.trace_id,
        status:        'ACTIVE',
        created_at:    new Date().toISOString()
      }).select('id').single();
      return { success: true, signal_id: signal?.id, action: 'signal_stored' };

    default:
      return { success: true, action: 'passthrough', event_type: task.event_type };
  }
}

const ok  = (body) => ({ statusCode: 200, headers: cors(), body: JSON.stringify(body) });
const err = (code, msg) => ({ statusCode: code, headers: cors(), body: JSON.stringify({ error: msg }) });
const cors = () => ({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
