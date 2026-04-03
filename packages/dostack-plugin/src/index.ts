import type { Plugin, PluginModule } from "@opencode-ai/plugin"

const dostackPlugin: Plugin = async (_input, _options) => {
  return {}
}

export default {
  id: "dostack",
  server: dostackPlugin,
} satisfies PluginModule
