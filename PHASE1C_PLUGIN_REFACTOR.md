# Phase 1c — dostack-plugin Builder Contract Refactor

Branch: `phase1c/builder-contract` (off `dev`). No functional changes in this
commit; this file documents the starting state for Tasks 10-12.

## Baseline (pre-refactor)

The plugin currently lives in `packages/dostack-plugin/src/` and:

- Receives config (`api_url`, `api_key`, `workbench_id`, `workbench_slug`,
  `internal_api_url`, `internal_api_token`) via the `opencode.jsonc` plugin
  block, which `entrypoint.sh` in the DOstack Fargate image generates from
  container env vars at startup (`DOSTACK_API_URL`, `DOSTACK_API_KEY`,
  `DOSTACK_WORKBENCH_ID`, `WORKBENCH_SLUG`).
- Has no first-class "build request" — the composer's structured app spec
  and workflow bindings are only known to the plugin through whatever prior
  chat context Claude has, not a machine-readable input.
- Reports build status by calling the external platform API directly:
  `PUT /composer/workbenches/{workbench_id}/build-status` with
  `{status: "building" | "complete"}` (see `src/build-status.ts`). The
  platform API handler is what writes `build_status` to the workbench DDB
  record.
- Fetches runtime errors via `GET /composer/runtime-errors` (see
  `src/tools/get-runtime-errors.ts`) and the workflow registry via
  `GET /api/v1/workflows`.
- Triggers previews locally via `src/tools/trigger-preview.ts`
  (spawns `pnpm build` in the frontend).
- Never uploads a package artifact; the template at `/workspace/template` is
  the canonical build output and is served directly out of the live
  container by the preview proxy.

## Target (Phase 1c contract)

- Reads the build request (app spec + binding schemas + workflow metadata)
  from an S3 object whose URI is passed in via env var
  `BUILD_REQUEST_S3_URI` at startup. The plugin loads and parses this once;
  all downstream hooks/tools read from the parsed object.
- Emits events via HTTP `POST ${COMPOSER_API_URL}/builds/${BUILD_JOB_ID}/events`
  with `builder.*` event types (e.g. `builder.log.info`, `builder.log.error`,
  `builder.status.building`, `builder.status.verifying`). Auth header
  `Authorization: Bearer ${BUILDER_AUTH_TOKEN}`.
- Never writes to DynamoDB directly. All state changes flow through the
  coordinator via the events endpoint. `src/build-status.ts` is gutted or
  replaced by an event-emitter.
- On successful generation, assembles a package manifest (file list +
  hashes + entry points + the resolved binding schemas), uploads the
  package contents to `s3://${PACKAGE_S3_BUCKET}/${workbench_id}/${package_version}/`,
  then calls `POST ${COMPOSER_API_URL}/builds/${BUILD_JOB_ID}/complete`
  with the package location and manifest. The coordinator flips the
  workbench to the new package version.
- On failure, emits `builder.log.error` with structured
  `{error_type, message, file?, hint?}` and does NOT call `/complete`. The
  watchdog on the coordinator times the build out and marks it failed.

## Env vars the container will pass in (set by coordinator in Task 14)

- `BUILD_REQUEST_S3_URI` — full `s3://bucket/key` of the build request JSON
- `BUILD_JOB_ID` — the coordinator's build job ID
- `WORKBENCH_ID` — target workbench (same as today's `DOSTACK_WORKBENCH_ID`)
- `COMPOSER_API_URL` — base URL for coordinator endpoints (events, complete)
- `PACKAGE_S3_BUCKET` — destination bucket for the built package
- `BUILDER_AUTH_TOKEN` — bearer token for coordinator auth

`DOSTACK_API_URL` / `DOSTACK_API_KEY` stay for the external workflow API
calls (registry, schema, runtime errors).

## Files to modify

- `packages/dostack-plugin/src/index.ts` — wire new pieces in, drop status
  reporter
- `packages/dostack-plugin/src/config.ts` — extend schema with new env-var
  driven fields (or add a sibling `build-context.ts`)
- `packages/dostack-plugin/src/build-status.ts` — replace with
  `event-emitter.ts` (HTTP POST to coordinator events endpoint)
- `packages/dostack-plugin/src/hooks/before-prompt.ts` — inject parsed
  build request into system prompt instead of relying on chat context
- `packages/dostack-plugin/src/hooks/after-response.ts` — emit
  `builder.status.building` / `builder.log.*` events instead of calling
  `reportBuilding` / `reportComplete`
- New file: `packages/dostack-plugin/src/build-request.ts` — S3 loader +
  types for the spec/binding payload
- New file: `packages/dostack-plugin/src/package-manifest.ts` — manifest
  builder + S3 uploader + `/complete` caller
- Tests in `packages/dostack-plugin/test/` get matching updates.

## Split across tasks

- **Task 10** — Consume spec + bindings from S3. Add `build-request.ts`
  loader, extend config, wire the parsed request into the before-prompt
  hook so the system prompt carries the structured spec.
- **Task 11** — Emit events via HTTP. Replace `build-status.ts` with the
  coordinator event emitter. Update hooks to call the emitter. Delete the
  external `/composer/workbenches/.../build-status` dependency.
- **Task 12** — Emit package on completion. Add `package-manifest.ts`,
  hook it into the text-complete flow after verification, upload to S3,
  call `/complete`. Keep failure path silent (watchdog).
