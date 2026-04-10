"""
synal-manifest-runner
Pulls BRIDGE_RUNNER_MANIFEST.yaml from GitHub, executes all steps:
  1. apply_supabase_migrations  → psycopg2 (full PL/pgSQL support)
  2. deploy_lambdas             → boto3 (zip from GitHub, deploy to Lambda)
  3. wire_api_routes            → validates bridge reachability
  4. patch_command_centre_ui    → inserts/updates t4h_ui_snippet via bridge
  5. run_validation             → golden path smoke test
  6. update_reality_ledger      → writes REAL/PARTIAL to arch_maturity_spine
"""

import json
import os
import re
import base64
import zipfile
import io
import urllib.request
import urllib.error
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import RealDictCursor
import boto3
import yaml

# ── Config ──────────────────────────────────────────────────────────────────
GITHUB_PAT   = os.environ["GITHUB_PAT"]
GITHUB_REPO  = os.environ.get("GITHUB_REPO", "TML-4PM/ai-evolution-program")
GITHUB_REF   = os.environ.get("GITHUB_REF", "main")
MANIFEST_PATH = os.environ.get("MANIFEST_PATH", "synal/bridge/BRIDGE_RUNNER_MANIFEST.yaml")
DATABASE_URL  = os.environ["DATABASE_URL"]
BRIDGE_URL    = os.environ.get("BRIDGE_URL", "https://zdgnab3py0.execute-api.ap-southeast-2.amazonaws.com/prod/lambda/invoke")
BRIDGE_KEY    = os.environ["BRIDGE_API_KEY"]
AWS_REGION    = os.environ.get("AWS_REGION", "ap-southeast-2")
LAMBDA_ROLE   = os.environ.get("LAMBDA_ROLE_ARN", "")  # IAM role for deployed lambdas

UTC_NOW = datetime.now(timezone.utc).isoformat()

# ── Helpers ──────────────────────────────────────────────────────────────────

def github_get(path):
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}?ref={GITHUB_REF}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {GITHUB_PAT}",
        "Accept": "application/vnd.github.v3+json"
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def github_get_content(path):
    d = github_get(path)
    if isinstance(d, dict) and "content" in d:
        return base64.b64decode(d["content"]).decode()
    raise ValueError(f"No content at {path}")

def github_list(path):
    d = github_get(path)
    if isinstance(d, list):
        return d
    raise ValueError(f"Not a directory: {path}")

def db_conn():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

def bridge_call(fn, sql=None, payload=None):
    body = {"fn": fn}
    if sql:
        body["sql"] = sql
    if payload:
        body.update(payload)
    data = json.dumps(body).encode()
    req = urllib.request.Request(BRIDGE_URL, data=data, headers={
        "x-api-key": BRIDGE_KEY,
        "Content-Type": "application/json"
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def log(step, status, detail=""):
    print(json.dumps({"step": step, "status": status, "detail": detail, "ts": UTC_NOW}))

# ── Step 1: Apply Supabase Migrations ────────────────────────────────────────

def apply_supabase_migrations(manifest_root):
    path = manifest_root.rstrip("/") + "/supabase"
    results = []
    try:
        files = sorted([f["name"] for f in github_list(path) if f["name"].endswith(".sql")])
    except Exception as e:
        log("migrations", "SKIP", f"No supabase dir: {e}")
        return {"status": "SKIP", "reason": str(e)}

    conn = db_conn()
    try:
        for fname in files:
            sql = github_get_content(f"{path}/{fname}")
            try:
                with conn:
                    with conn.cursor() as cur:
                        cur.execute(sql)
                results.append({"file": fname, "ok": True})
                log("migrations", "OK", fname)
            except Exception as e:
                results.append({"file": fname, "ok": False, "error": str(e)})
                log("migrations", "ERROR", f"{fname}: {e}")
    finally:
        conn.close()

    failed = [r for r in results if not r["ok"]]
    return {
        "status": "PARTIAL" if failed else "REAL",
        "applied": len([r for r in results if r["ok"]]),
        "failed": len(failed),
        "files": results
    }

# ── Step 2: Deploy Lambdas ────────────────────────────────────────────────────

def deploy_lambdas(manifest_root):
    path = manifest_root.rstrip("/") + "/lambda"
    results = []
    lc = boto3.client("lambda", region_name=AWS_REGION)

    try:
        files = [f for f in github_list(path) if f["name"].endswith(".py")]
    except Exception as e:
        log("lambdas", "SKIP", str(e))
        return {"status": "SKIP", "reason": str(e)}

    for f in files:
        fn_name = f["name"].replace(".py", "").replace("_", "-")
        code = github_get_content(f"{path}/{f['name']}")

        # Zip it
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("lambda_function.py", code)
        buf.seek(0)
        zip_bytes = buf.read()

        try:
            try:
                lc.update_function_code(FunctionName=fn_name, ZipFile=zip_bytes)
                results.append({"fn": fn_name, "action": "updated", "ok": True})
                log("lambdas", "UPDATED", fn_name)
            except lc.exceptions.ResourceNotFoundException:
                if not LAMBDA_ROLE:
                    results.append({"fn": fn_name, "action": "create_skipped", "ok": False, "error": "No LAMBDA_ROLE_ARN"})
                    continue
                lc.create_function(
                    FunctionName=fn_name,
                    Runtime="python3.12",
                    Role=LAMBDA_ROLE,
                    Handler="lambda_function.handler",
                    Code={"ZipFile": zip_bytes},
                    Timeout=60,
                    MemorySize=256,
                    Environment={"Variables": {"DATABASE_URL": DATABASE_URL}}
                )
                results.append({"fn": fn_name, "action": "created", "ok": True})
                log("lambdas", "CREATED", fn_name)
        except Exception as e:
            results.append({"fn": fn_name, "ok": False, "error": str(e)})
            log("lambdas", "ERROR", f"{fn_name}: {e}")

    failed = [r for r in results if not r["ok"]]
    return {
        "status": "PARTIAL" if failed else "REAL",
        "deployed": len([r for r in results if r.get("ok")]),
        "results": results
    }

# ── Step 3: Wire API Routes ───────────────────────────────────────────────────

def wire_api_routes():
    try:
        r = bridge_call("troy-sql-executor", sql="SELECT 1 AS ping")
        if r.get("success"):
            log("routes", "REAL", "bridge reachable")
            return {"status": "REAL"}
        return {"status": "PARTIAL", "error": r.get("error")}
    except Exception as e:
        log("routes", "ERROR", str(e))
        return {"status": "PRETEND", "error": str(e)}

# ── Step 4: Patch Command Centre UI ──────────────────────────────────────────

def patch_command_centre_ui(manifest_root):
    path = manifest_root.rstrip("/") + "/ui"
    results = []
    try:
        files = github_list(path)
    except Exception as e:
        return {"status": "SKIP", "reason": str(e)}

    for f in files:
        if not f["name"].endswith(".js"):
            continue
        content = github_get_content(f"{path}/{f['name']}")
        # Extract snippet upserts — look for insertOrUpdate patterns
        # For now: register that the patch file exists and is current
        results.append({"file": f["name"], "ok": True, "note": "patch available, manual apply needed"})
        log("ui", "PARTIAL", f["name"])

    return {"status": "PARTIAL", "files": results, "note": "UI patches require manual apply to CC"}

# ── Step 5: Run Validation (Golden Path) ─────────────────────────────────────

def run_validation():
    results = {}

    # Check synal_tasks table exists
    try:
        r = bridge_call("troy-sql-executor", sql="SELECT COUNT(*) AS c FROM public.synal_tasks")
        results["synal_tasks"] = "REAL" if r.get("success") else "MISSING"
    except:
        results["synal_tasks"] = "MISSING"

    # Check synal_agent_chains exists
    try:
        r = bridge_call("troy-sql-executor", sql="SELECT COUNT(*) AS c FROM public.synal_agent_chains")
        results["synal_agent_chains"] = "REAL" if r.get("success") else "MISSING"
    except:
        results["synal_agent_chains"] = "MISSING"

    # Check synal_proof exists
    try:
        r = bridge_call("troy-sql-executor", sql="SELECT COUNT(*) AS c FROM public.synal_proof")
        results["synal_proof"] = "REAL" if r.get("success") else "MISSING"
    except:
        results["synal_proof"] = "MISSING"

    # Check synal_create_task function exists
    try:
        r = bridge_call("troy-sql-executor", sql="SELECT proname FROM pg_proc WHERE proname='synal_create_task'")
        results["synal_create_task_fn"] = "REAL" if r.get("count", 0) > 0 else "MISSING"
    except:
        results["synal_create_task_fn"] = "MISSING"

    all_real = all(v == "REAL" for v in results.values())
    any_missing = any(v == "MISSING" for v in results.values())

    status = "REAL" if all_real else ("PARTIAL" if not any_missing else "PARTIAL")
    log("validation", status, json.dumps(results))
    return {"status": status, "checks": results}

# ── Step 6: Update Reality Ledger ────────────────────────────────────────────

def update_reality_ledger(step_results):
    all_statuses = [r.get("status", "PRETEND") for r in step_results.values()]
    overall = "REAL" if all(s == "REAL" for s in all_statuses) else \
              "PRETEND" if all(s in ("PRETEND", "SKIP") for s in all_statuses) else "PARTIAL"

    sql = f"""
    INSERT INTO public.arch_maturity_spine (business_key, component, maturity_level, evidence, assessed_at)
    VALUES ('SYNAL', 'synal-manifest-runner', '{overall}',
            '{json.dumps(step_results).replace("'", "''")}',
            NOW())
    ON CONFLICT (business_key, component)
    DO UPDATE SET maturity_level=EXCLUDED.maturity_level,
                  evidence=EXCLUDED.evidence,
                  assessed_at=NOW();
    """
    try:
        r = bridge_call("troy-sql-executor", sql=sql)
        log("ledger", "OK", f"overall={overall}")
    except Exception as e:
        log("ledger", "ERROR", str(e))

    return {"status": overall, "step_results": step_results}

# ── Handler ───────────────────────────────────────────────────────────────────

def handler(event, context):
    log("manifest-runner", "START", f"repo={GITHUB_REPO} ref={GITHUB_REF}")

    # 1. Pull manifest
    try:
        manifest_raw = github_get_content(MANIFEST_PATH)
        manifest = yaml.safe_load(manifest_raw)
        root = manifest.get("root", "synal/")
        log("manifest", "OK", f"version={manifest.get('version')} root={root}")
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": f"Manifest pull failed: {e}"})}

    results = {}

    # 2. Execute steps
    results["migrations"] = apply_supabase_migrations(root)
    results["lambdas"]    = deploy_lambdas(root)
    results["routes"]     = wire_api_routes()
    results["ui"]         = patch_command_centre_ui(root)
    results["validation"] = run_validation()
    results["ledger"]     = update_reality_ledger(results)

    log("manifest-runner", "COMPLETE", json.dumps({k: v.get("status") for k, v in results.items()}))

    return {
        "statusCode": 200,
        "body": json.dumps({
            "manifest": manifest.get("system"),
            "ran_at": UTC_NOW,
            "results": results
        })
    }
