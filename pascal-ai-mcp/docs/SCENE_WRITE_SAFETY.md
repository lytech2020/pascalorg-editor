# Scene Write Safety and Recovery Boundary

This document records the scene capabilities available to `pascal-ai-mcp` as of T2.4. It is a safety contract, not a promise that unsupported recovery exists.

## Capability matrix

| Capability | Current support | T2.4 policy |
|---|---|---|
| Authoritative scene version | Yes. `get_project_status.version` | Record it at every durable fresh-build boundary. |
| Compare-and-swap save/delete | Yes. `save_scene.expectedVersion` and `delete_scene.expectedVersion` | Always use it when saving or cleaning a tracked scene. |
| Authoritative graph fingerprint | Yes. `get_project_status.graphHash` | Cleanup requires both the recorded version and graph hash to match. |
| Checkpoint creation | Partial. `save_scene` accepts `saveMode: checkpoint` | A checkpoint can be written, but there is no public restore-to-version operation. It is not a rollback mechanism. |
| Checkpoint restore | No public tool | Never claim that an old version can currently be restored automatically. |
| Hidden staging scene | No. Semantic writes update the browser-visible active draft | Fresh builds are tracked as separate scenes, but cannot truthfully be described as invisible until publication. |
| Whole-workflow atomic batch | No | `apply_patch` is atomic only for one graph mutation batch, not an entire multi-step build. |
| Idempotent scene operation key | No | A crashed mutating step is not automatically replayed. |
| Cross-process same-scene exclusion | Yes for queued server work | `ai_requests` lease/claim logic excludes another worker request with the same session or scene. Direct CLI/eval calls remain outside that guarantee. |

## Fresh-build lifecycle

Fresh generation creates one `scene_builds` row before calling the scene-creation tool. Once the tool returns, the scene id is written immediately, followed by the authoritative version and graph hash. Successful durable boundaries refresh those two values. A failed, cancelled, or crash-orphaned build becomes `abandoned`.

There is an unavoidable cross-system gap between the MCP scene being created and the AI database receiving its scene id. The two stores do not share a transaction. If the process is killed exactly inside that gap, discovery requires a future MCP capability that can list scenes by a caller-supplied operation key. T2.4 does not hide this limitation.

Run cleanup explicitly:

```bash
bun run scenes:cleanup -- --execute
```

Cleanup is deliberately conservative:

- It loads the authoritative status for the abandoned scene.
- It deletes only when both version and graph hash exactly match the last recorded boundary.
- It passes `expectedVersion` to `delete_scene`.
- Missing scenes count as already cleaned.
- A changed scene, missing boundary, version conflict, or MCP failure becomes `cleanup_failed` and is retained for review.
- A second run ignores `cleaned` rows, so the command is idempotent.

Without `--execute`, the command only lists candidates. Run execution in a maintenance window after stopping normal AI traffic and confirming no candidate scene is open for editing. `delete_scene` can compare-and-swap only on version; graph hash is checked immediately before deletion but is not part of the same atomic predicate, and an unsaved browser draft is not a durable store boundary. A concurrent saved edit is protected by version CAS; an unsaved active edit is not. This is another reason T2.4 remains partially blocked.

## Existing-scene destructive rebuild

A structural plan-first modification may delete existing walls, rooms, slabs, ceilings, and furniture before recreating them. The current MCP contract cannot atomically wrap that workflow and cannot restore a checkpoint. Once the first destructive write begins:

- any failure or cancellation is reported as a possibly partial scene;
- pending modification state is cleared, so confirmation cannot automatically replay it;
- the user is told to inspect the scene and choose manual repair or a new generation;
- the recorded pre-change version is audit information only.

`get_scene` plus partial `delete_node`/recreate compensation is prohibited as a general rollback. It cannot preserve original ids, references, metadata, or concurrent third-party edits.

## Remaining blocker

T2.4 cannot be fully closed without extending the MCP contract. The minimum missing capability is either:

1. an authoritative checkpoint restore operation with CAS semantics; or
2. a hidden staging/publish-swap workflow plus an idempotent creation operation key.

Until one exists, original-scene destructive rebuilds remain non-atomic and fresh builds remain visible drafts while under construction. No AI-side compensation should pretend otherwise.
