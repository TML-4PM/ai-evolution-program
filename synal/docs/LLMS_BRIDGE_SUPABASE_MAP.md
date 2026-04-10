# LLMs + Bridge + Supabase Map

## Purpose
This document maps the Synal control path across LLM surfaces, the bridge execution layer, and Supabase as the state and evidence layer.

## Core principle
LLMs think and structure.
The bridge executes and routes.
Supabase stores state, evidence, truth, and control-plane data.

## Canonical stack

### 1. LLM surfaces
These are the thinking and interface layers.
They can:
- generate plans
- create tasks
- suggest actions
- prepare payloads
- interpret signals
- summarise outcomes

They must not be treated as the source of truth for runtime state.

### 2. Bridge layer
The bridge is the execution and routing layer.
It can:
- receive canonical invoke envelopes
- route actions to lambda/functions
- execute SQL safely through approved functions
- push outputs to GitHub, Supabase, Drive, or UI surfaces
- return logs, status, and execution evidence

### 3. Supabase layer
Supabase is the canonical state layer.
It stores:
- synal_tasks
- synal_task_events
- synal_task_actions
- synal_agent_chains
- synal_proof
- reality_ledger
- command-centre widget/state tables

Supabase is the truth for:
- task state
- proof state
- runtime visibility
- control-plane views

## Runtime flow
1. LLM or extension creates event/task intent
2. Bridge receives canonical envelope
3. Bridge invokes lambda or SQL execution path
4. Supabase records task/event/action/proof state
5. Command Centre reads from Supabase views
6. LLMs may read state back for guidance, but do not own the state

## Canonical objects
- Event = incoming occurrence
- Signal = interpreted meaning
- Task = unified work object
- Action = execution step
- Proof = evidence of result
- Command = operator control surface

## Synal-specific mapping

### Browser / extension layer
- Synal Snaps
- future Synal extensions

These should send payloads into the bridge or API surface that results in task creation in Supabase.

### Control plane
- Synal Command

This should read from Supabase views and call bridge/API routes to run, refresh, or auto-execute tasks.

### Flow layer
- Synal Flow (Spiral/HITL posture)

This should remain thin in extension and heavier in bridge/PWA/runtime orchestration.

## GitHub role
GitHub is the durable pickup and distribution layer for:
- SQL migrations
- lambda handlers
- UI patches
- bridge-runner manifests
- deployment notes

GitHub is not the runtime state store.
GitHub is where Bridge Runner should pick up build artifacts from.

## Current canonical runtime target
- Supabase project: `pflisxkcxbzboxwidywf`
- GitHub repo: `TML-4PM/ai-evolution-program`
- Synal root in repo: `synal/`

## Minimum live routes
- `/api/v1/synal/task-intake`
- `/api/v1/synal/task-refresh`
- `/api/v1/synal/task-run`
- `/api/v1/synal/auto-execute`

## Required proof rule
No task should be considered complete unless proof exists and is stored in Supabase.

## Bridge pickup rule
Bridge Runner should pull from GitHub path(s):
- `synal/supabase/`
- `synal/lambda/`
- `synal/ui/`
- `synal/extension/`
- `synal/bridge/`

Then execute in this order:
1. Supabase migrations
2. Lambda deploy/update
3. API route wiring
4. UI patching
5. Extension patching
6. Validation run
7. Reality ledger update
