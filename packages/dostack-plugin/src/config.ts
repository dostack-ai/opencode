import { z } from "zod"

export const DostackConfigSchema = z.object({
  api_url: z.string().url("api_url must be a valid URL"),
  api_key: z.string().startsWith("dsk_", "api_key must start with 'dsk_'"),
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
  coordinator_api_url: z.string().url().optional(),
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
