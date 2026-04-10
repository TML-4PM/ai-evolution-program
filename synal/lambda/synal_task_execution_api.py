import json
import os
from datetime import datetime
import psycopg2
from psycopg2.extras import RealDictCursor

DB_URL = os.environ.get("DATABASE_URL")

def get_conn():
    return psycopg2.connect(DB_URL, cursor_factory=RealDictCursor)

def handler(event, context):
    path = event.get("rawPath", "")
    body = json.loads(event.get("body") or "{}")

    if path.endswith("/task-run"):
        return run_task(body)
    elif path.endswith("/task-refresh"):
        return refresh_tasks()
    elif path.endswith("/task-intake"):
        return intake_task(body)
    else:
        return resp(404, {"error": "unknown route"})

def intake_task(body):
    conn = get_conn()
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select public.synal_create_task(%s,%s,%s,%s,%s,null,null,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    body.get("task_key"),
                    body.get("source_type", "snap"),
                    body.get("source_id"),
                    body.get("title"),
                    body.get("summary"),
                    body.get("intent"),
                    body.get("impact_area"),
                    body.get("priority", "medium"),
                    body.get("surface"),
                    body.get("source_app"),
                    body.get("page_url"),
                    body.get("domain"),
                    body.get("page_title"),
                    json.dumps(body.get("context") or {}),
                    json.dumps(body.get("evidence") or {}),
                ),
            )
            task_id = cur.fetchone()["synal_create_task"]

            cur.execute(
                "select public.synal_prepare_task_actions(%s)",
                (task_id,),
            )

    return resp(200, {"task_id": str(task_id)})

def run_task(body):
    task_id = body.get("task_id")
    if not task_id:
        return resp(400, {"error": "task_id required"})

    conn = get_conn()
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update public.synal_tasks
                set status='running', started_at=now()
                where id=%s
                returning id, title
                """,
                (task_id,),
            )
            task = cur.fetchone()

            if not task:
                return resp(404, {"error": "task not found"})

            result = {
                "summary": f"Executed task: {task['title']}",
                "executed_at": datetime.utcnow().isoformat(),
            }

            cur.execute(
                """
                update public.synal_tasks
                set status='completed', completed_at=now(), outcome=%s
                where id=%s
                """,
                (json.dumps(result), task_id),
            )

    return resp(200, {"task_id": task_id, "status": "completed"})

def refresh_tasks():
    conn = get_conn()
    with conn:
        with conn.cursor() as cur:
            cur.execute("select public.synal_refresh_task_state() as result")
            res = cur.fetchone()["result"]

    return resp(200, {"refresh": res})

def resp(code, body):
    return {
        "statusCode": code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
