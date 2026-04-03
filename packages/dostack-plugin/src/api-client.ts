import type { DostackConfig } from "./config"

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(`DOstack API error (${status}): ${code}`)
    this.name = "ApiClientError"
  }
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE"

async function request(
  baseUrl: string,
  path: string,
  method: HttpMethod,
  headers: Record<string, string>,
  body?: unknown,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
  }

  const res = await fetch(url, init)

  if (!res.ok) {
    let errorBody: any = {}
    try {
      errorBody = await res.json()
    } catch {}
    throw new ApiClientError(
      res.status,
      errorBody.error ?? errorBody.code ?? `http_${res.status}`,
      errorBody.details,
    )
  }

  const text = await res.text()
  if (!text) return {}
  return JSON.parse(text)
}

function createHttpClient(
  baseUrl: string | undefined,
  headers: Record<string, string>,
  label: string,
) {
  function ensureConfigured(): string {
    if (!baseUrl) {
      throw new Error(
        `dostack-plugin: ${label} is not configured. Set ${
          label === "internal API" ? "internal_api_url" : "api_url"
        } in plugin options.`,
      )
    }
    return baseUrl
  }

  return {
    get: (path: string) => request(ensureConfigured(), path, "GET", headers),
    post: (path: string, body?: unknown) => request(ensureConfigured(), path, "POST", headers, body),
    put: (path: string, body?: unknown) => request(ensureConfigured(), path, "PUT", headers, body),
    delete: (path: string) => request(ensureConfigured(), path, "DELETE", headers),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

export function createApiClient(config: DostackConfig) {
  const external = createHttpClient(
    config.api_url,
    { "X-Api-Key": config.api_key },
    "external API",
  )

  const internal = createHttpClient(
    config.internal_api_url,
    config.internal_api_token ? { Authorization: `Bearer ${config.internal_api_token}` } : {},
    "internal API",
  )

  return { external, internal }
}
