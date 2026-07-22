# Pascal AI LangGraph Service

LangGraph-based requirement intake and floor-plan generation service for the Pascal editor.

```text
Pascal editor AI panel
  -> /api/ai (Next.js same-origin proxy)
  -> pascal-ai-mcp :8788
  -> LangGraph requirement workflow
  -> Azure OpenAI or another OpenAI-compatible model
  -> Pascal MCP over stdio or HTTP
  -> Pascal SceneStore + editor SSE
```

## Workflow

1. Accept text or one JPG/PNG floor-plan image with optional text.
2. Extract existing conditions, design goals, hard constraints, assumptions, uncertainties, and conflicts.
3. Classify the input as usable, partially usable, or unusable.
4. Ask up to three structural clarification questions per round.
5. Present a provenance-aware structured summary.
6. Wait for explicit confirmation before changing a scene.
7. Generate a starter scene, refine it through bounded MCP tool calls, validate it, and run bounded repair rounds.
8. Treat later user messages as incremental MCP edits to the generated scene, then re-run checks.

CAD/DXF/DWG input is intentionally outside this AI workflow. The editor's existing DXF importer remains separate.

## Design docs

Rule source of truth lives in `docs/` (change flow: edit doc → sync code → eval regression):

- [docs/LAYOUT_STRATEGY_DESIGN.md](docs/LAYOUT_STRATEGY_DESIGN.md) — 策略层规则与拓扑细则（areaBand / typology / kitchenMode / 打分参数）
- [docs/NORMS_PROFILE_DESIGN.md](docs/NORMS_PROFILE_DESIGN.md) — default / JP 规范档案与参数来源（NormProfile）
- [docs/MODIFY_REDESIGN.md](docs/MODIFY_REDESIGN.md) — 修改流程重设计（Modify = 编辑 Intent；草案，待拍板）

## Configuration

The service loads environment values in this order without overriding existing process values:

1. repository `.env.local`
2. repository `.env`
3. `pascal-ai-mcp/.env`

For Azure OpenAI, configure:

```env
AI_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://your-resource.cognitiveservices.azure.com
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_DEPLOYMENT=your-deployment
AZURE_OPENAI_API_VERSION=2024-10-21
```

OpenRouter-compatible endpoints remain supported when `AI_PROVIDER` is omitted:

```env
OPENROUTER_FALLBACK_API_KEY=...
OPENROUTER_FALLBACK_MODEL=...
```

By default the service starts Pascal MCP as a stdio child process. To connect to an already-running HTTP MCP server instead:

```env
PASCAL_MCP_MODE=http
PASCAL_MCP_URL=http://127.0.0.1:3917/mcp
```

Use the same `PASCAL_DATA_DIR` or `PASCAL_DB_PATH` as the editor so generated scenes and live events share storage.

**Template seeding requires the matching norm profile.** The reference library (`templates/`, all `market: "jp"` today) is matched against the runtime profile — with the default profile no template can ever hit and every request falls back to the from-scratch partitioner. For the template-first experience, start the service with:

```env
PASCAL_NORM_PROFILE=jp
```

## Run

From the repository root, `bun dev` includes this workspace. To run only the AI service:

```bash
cd pascal-ai-mcp
bun run start
```

The service starts even when no model key is configured; chat jobs then end with a recoverable configuration error. The startup log prints a config summary including provider, model, MCP mode, body limit, worker concurrency, and queue depth.

## Deployment boundary

The service has **no authentication** and is intended for local/private-network use only. It binds to `127.0.0.1` by default; set `AI_MCP_HOST` explicitly only if you understand the exposure. Do not put it on a public interface before the identity work in `docs/ARCHITECTURE_TASKS.md` (TX.1) is done.

`/chat` bodies are capped at `AI_MCP_MAX_BODY_MB` (default 28MB — sized for the editor's 20MB image limit after base64 inflation); the cap is enforced by counting the stream, so chunked requests without a Content-Length are covered too. Oversized requests get `413`; malformed JSON or invalid image data URLs (non-png/jpeg, empty or undecodable base64, wrong magic bytes) get `400`.

`POST /chat` is backed by the SQLite `ai_requests` queue. The worker defaults to one concurrent job (`AI_MCP_WORKER_CONCURRENCY=1`) because the current MCP connection targets one active scene; `AI_MCP_MAX_QUEUE_DEPTH` defaults to 100. A full queue returns `429` with `Retry-After`. Cancel bypasses that limit only when its session or an active target actually exists; an unknown target returns `404`. Each claimed job has a renewable lease. Losing the lease cancels local execution. After a hard process interruption, queued jobs are claimed after restart. An expired running job resumes only from a verified durable plan boundary with no scene-write evidence; if the durable session had already reached a terminal phase, the request is finalized without replay. All ambiguous or scene-writing cases become `failed/process_interrupted`, and running workflow steps become `failed_recoverable`. Unsafe scene writes are never replayed automatically.

Queued text is stored only while the job is active and cleared at completion. Uploaded images are decoded to private mode-0600 files under `AI_MCP_REQUEST_ARTIFACTS_DIR` (default `.data/request-artifacts`). Request payloads store only an artifact ID; MIME, size, SHA-256, private storage key, deletion state and expiry live in `ai_artifacts`, never Base64 or a public URL. Files and rows are removed at the request terminal state. `AI_MCP_ARTIFACT_TTL_HOURS` defaults to 24 and bounds crash leftovers that miss normal cleanup.

LangGraph checkpoint tables live in the same `AI_MCP_DATABASE_FILE` and use `AI_MCP_CHECKPOINT_TTL_DAYS` (default 30). The production graph checkpoints only workflow/session/request identifiers, session version, phase and the next safe node; complete messages, prompts, replies, image data, `WorkflowSession` objects and scene snapshots remain in their existing repositories and are never copied into checkpoints. Clarification and confirmation use durable interrupts under the same server-generated `workflowRunId`. Run `bun run data:cleanup` for a dry-run report covering expired checkpoints, expired/failed artifacts and unregistered old files; run `bun run data:cleanup --execute` for idempotent pruning, and add `--delete-incompatible` only for an explicit graph-version cleanup. TTL marks rows eligible for deletion but does not run a background timer, so long-running deployments should schedule the execute command periodically.

On SIGTERM/SIGINT the server stops accepting HTTP requests and claiming queue jobs, waits up to `AI_MCP_DRAIN_TIMEOUT_MS` (default 5000) for handlers and claimed jobs to drain, then closes the checkpoint saver, MCP and the database. A drain timeout exits non-zero.

`GET /ready` is an internal readiness endpoint protected by `AI_MCP_READINESS_TOKEN`. It checks that SQLite and the LangGraph checkpoint tables can acquire real write transactions, the template library accepts traffic, MCP responds to `ping`, and model-attempt telemetry is not degraded. Model-provider configuration is reported as degraded information but does not by itself make readiness fail. `/health` remains an unauthenticated, minimal liveness response.

If an MCP transport closes or a request fails at the transport layer, the AI-side client retires that connection generation immediately. It retries connection establishment up to `PASCAL_MCP_RECONNECT_ATTEMPTS` with bounded backoff, then opens a short circuit controlled by `PASCAL_MCP_CIRCUIT_COOLDOWN_MS`. Mutating MCP tool calls are never replayed automatically. While MCP is not ready, the queue worker leaves unclaimed requests queued; a successful readiness probe wakes it again.

## Endpoints

- `GET /health` — liveness only, returns `{ "ok": true }`
- `GET /ready` — protected readiness; pass `Authorization: Bearer $AI_MCP_READINESS_TOKEN`
- `GET /tools`
- `POST /chat` — enqueue work and return `202`
- `GET /requests/:id` — query queued/running/terminal status and result
- `GET /sessions/:id`
- `DELETE /sessions/:id`

`POST /chat` accepts the following body and immediately returns a server-authoritative request id:

```json
{
  "sessionId": "demo",
  "sceneId": "optional-active-scene-id",
  "message": "设计一个85平方米的两居室",
  "idempotencyKey": "client-generated-stable-key"
}
```

```json
{
  "status": "queued",
  "requestId": "server-generated-uuid",
  "traceId": "trace-id",
  "statusUrl": "/requests/server-generated-uuid"
}
```

Errors use a stable, attributable envelope. `errorCode` is the machine contract;
`stage` is a low-cardinality processing stage, and `message` is safe to show to
users. The legacy `error` field mirrors `errorCode` for the current editor client.
Raw provider bodies, credentials, prompts, replies and image Base64 are never
included.

```json
{
  "error": "mcp_unavailable",
  "errorCode": "mcp_unavailable",
  "stage": "readiness",
  "message": "The scene service is temporarily unavailable. Please retry.",
  "requestId": "server-generated-uuid",
  "traceId": "trace-id"
}
```

Poll `statusUrl` until `status` is `succeeded`, `failed`, or `cancelled`. The status response includes persisted workflow steps; a successful response also includes `result.reply` and the current session snapshot. The editor uses this polling path, so closing the original POST connection does not lose the job.

`idempotencyKey` is optional and must contain 8–128 ASCII letters, digits, `.`, `_`, `:`, or `-`. Repeating the same scoped request with identical input returns the original request id with `reused: true`; changing the input under the same key returns `409 idempotency_conflict`. The browser cannot choose the trusted identity scope. The current local-only service uses one `local` scope; an authenticated BFF must supply the user/organization scope when TX.1 is implemented.

The editor keeps the key stable for the same logical submission while the POST or status-polling outcome is ambiguous. A retry of restored, unchanged input therefore resumes the original request; a definitive rejection, terminal result, changed input, or explicit new attempt gets a new key.

Image input adds `imageDataUrl`. Confirmation and cancellation use:

```json
{ "sessionId": "demo", "action": "confirm" }
```

The service stores workflow state, user-visible messages, request records, workflow steps, LangGraph execution checkpoints, model-call usage, tool-call summaries, scene-version changes, and validation summaries in `.data/ai.db`. Tool audit rows retain parameter shape and counts only; they do not retain parameter values, complete scenes, or raw tool responses. Existing `.data/sessions.json` data is imported once and is never written again. Session updates use optimistic versions so stale concurrent writers cannot overwrite newer state. Deleting a session returns `409 session_busy` while it has queued/running work; after deletion, messages, request payload/results and related workflow checkpoints are removed while request audit identity/status remains. `ai_requests`, `workflow_steps`, and `ai_sessions` remain the durable business truth; LangGraph checkpoints hold only an internal execution cursor and never replace those records.

## Verify

```bash
bun run check-types
bun test
```
