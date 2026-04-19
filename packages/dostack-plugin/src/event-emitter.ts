/**
 * Builder event emitter.
 *
 * Emits builder.* events to the coordinator's /builds/{job_id}/events
 * route. The coordinator enforces a builder.* whitelist and 4KB payload
 * cap; this module defensively truncates large payloads before POST.
 */

const MAX_PAYLOAD_BYTES = 4000 // leave headroom under the 4096 coordinator cap

export interface EmitOpts {
  coordinatorBase: string // https://<composer-api>/...
  buildJobId: string
  authToken: string // BUILDER_AUTH_TOKEN
}

export async function emitEvent(
  opts: EmitOpts,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!eventType.startsWith("builder.")) {
    throw new Error(`event_type must start with "builder.", got: ${eventType}`)
  }
  const url = `${opts.coordinatorBase.replace(/\/$/, "")}/builds/${opts.buildJobId}/events`
  const safePayload = truncatePayload(payload)
  const body = JSON.stringify({ event_type: eventType, payload: safePayload })
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.authToken}`,
        "Content-Type": "application/json",
      },
      body,
    })
    if (!res.ok) {
      // Non-fatal — builder progress events are best-effort. Log but don't throw.
      console.error(
        `[dostack-plugin] emitEvent ${eventType} failed: ${res.status} ${await res.text()}`,
      )
    }
  } catch (err) {
    console.error(`[dostack-plugin] emitEvent ${eventType} network error:`, err)
  }
}

export function truncatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(payload)
  if (serialized.length <= MAX_PAYLOAD_BYTES) return payload
  // Simple truncation: keep the keys, replace string values over some threshold with a tag.
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "string" && v.length > 256) {
      out[k] = v.slice(0, 253) + "..."
    } else {
      out[k] = v
    }
  }
  if (JSON.stringify(out).length > MAX_PAYLOAD_BYTES) {
    return { _truncated: true, _original_bytes: serialized.length }
  }
  return out
}

/**
 * Factory that binds the coordinator base + job_id + auth token up-front
 * so callers (hooks, package-assembler) can emit events with a single call.
 */
export function createEventEmitter(opts: EmitOpts) {
  return {
    emit: (eventType: string, payload: Record<string, unknown>) => emitEvent(opts, eventType, payload),
  }
}

export type EventEmitter = ReturnType<typeof createEventEmitter>
