import json
import os
from datetime import datetime
import psycopg2
from psycopg2.extras import RealDictCursor

DB_URL = os.environ.get('DATABASE_URL')

def get_conn():
    return psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)

def resp(code, body):
    return {
        'statusCode': code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body)
    }

def handler(event, context):
    body = json.loads(event.get('body') or '{}')
    mode = body.get('mode', 'single')
    task_id = body.get('task_id')

    conn = get_conn()
    executed = []
    with conn:
        with conn.cursor() as cur:
            if mode == 'single':
                if not task_id:
                    return resp(400, {'error': 'task_id required'})
                executed.append(run_single(cur, task_id))
            else:
                cur.execute("select * from public.synal_get_auto_executable_tasks()")
                rows = cur.fetchall() or []
                for row in rows:
                    executed.append(run_single(cur, row['task_id']))

    return resp(200, {'ok': True, 'executed': executed})

def run_single(cur, task_id):
    cur.execute("update public.synal_tasks set status='executing', started_at=now() where id=%s", (task_id,))
    cur.execute("select public.synal_seed_chain_for_task(%s) as seeded", (task_id,))
    seeded = cur.fetchone()['seeded']

    cur.execute(
        "insert into public.synal_task_events (task_id, event_type, actor_type, payload) values (%s,'chain_started','system',%s)",
        (task_id, json.dumps({'seeded': seeded, 'executed_at': datetime.utcnow().isoformat()}))
    )

    cur.execute(
        "select public.synal_write_proof(%s,%s,%s) as proof_id",
        (task_id, 'auto_execution', json.dumps({'mode': 'auto', 'completed_at': datetime.utcnow().isoformat()}))
    )
    proof_id = cur.fetchone()['proof_id']
    return {'task_id': str(task_id), 'proof_id': str(proof_id)}
