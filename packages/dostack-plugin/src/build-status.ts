import type { ApiClient } from "./api-client"
import type { DostackConfig } from "./config"

export function createBuildStatusReporter(client: ApiClient, config: DostackConfig) {
  let lastReportedStatus: string | null = null

  const reportBuilding = () => {
    if (lastReportedStatus === "building") return
    lastReportedStatus = "building"
    client.external
      .put(`/composer/workbenches/${config.workbench_id}/build-status`, { status: "building" })
      .catch((err: unknown) => console.warn("Failed to set build_status=building:", err))
  }

  const reportComplete = async () => {
    try {
      await client.external.put(
        `/composer/workbenches/${config.workbench_id}/build-status`,
        { status: "complete" },
      )
      lastReportedStatus = "complete"
    } catch (err) {
      console.error("Failed to set build_status=complete:", err)
      // Retry once — if this fails, the frontend won't know the build is done
      try {
        await client.external.put(
          `/composer/workbenches/${config.workbench_id}/build-status`,
          { status: "complete" },
        )
        lastReportedStatus = "complete"
      } catch (retryErr) {
        console.error("Retry failed:", retryErr)
      }
    }
  }

  const resetStatus = () => {
    lastReportedStatus = null
  }

  return { reportBuilding, reportComplete, resetStatus }
}
