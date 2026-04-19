import { z } from "zod"

// The dostack-plugin supports two invocation modes:
//
//  - Legacy (composer-container-manager / DOstack platform API):
//      requires api_url + api_key (dsk_-prefixed) + workbench_id.
//  - Phase 1c (app_builder_coordinator):
//      requires coordinator_api_url + builder_auth_token + build_job_id
//      + package_s3_bucket + workbench_id. The plugin talks to the
//      coordinator via HTTP, so legacy api_url / api_key are irrelevant.
//
// Both paths share workbench_id, so that stays required. Everything else is
// optional at the schema level; runtime code (api-client.ts, index.ts) lazily
// validates that the fields it actually needs are present.
export const DostackConfigSchema = z.object({
  api_url: z.string().url("api_url must be a valid URL").optional().or(z.literal("")),
  api_key: z
    .string()
    .startsWith("dsk_", "api_key must start with 'dsk_'")
    .optional()
    .or(z.literal("")),
  workbench_id: z.string().min(1, "workbench_id must not be empty"),
  workbench_slug: z.string().optional(),
  template_version: z.string().optional(),
  internal_api_url: z.string().url().optional(),
  internal_api_token: z.string().optional(),

  // Phase 1c — builder contract
  // The composer coordinator exposes /builds/{id}/events and /builds/{id}/complete
  // routes; the plugin POSTs builder.* events + the final completion callback
  // to those. coordinator_api_url defaults to api_url if not explicitly set, so
  // legacy configs keep working.
  coordinator_api_url: z.string().url().optional().or(z.literal("")),
  builder_auth_token: z.string().optional(),
  build_job_id: z.string().optional(),
  package_s3_bucket: z.string().optional(),
})

export type DostackConfig = z.infer<typeof DostackConfigSchema>

export function parseDostackConfig(options: unknown): DostackConfig {
  const result = DostackConfigSchema.safeParse(options)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`dostack-plugin: invalid config\n${issues}`)
  }
  return result.data
}
