import type { ProviderStreams } from "@oh-my-pi/pi-ai";

type CompatModule = typeof import("@oh-my-pi/pi-ai/compat");

// OMP's pi-compat shim does not export pi's Codex adapter; without it the provider
// registers plain `openai-responses` models (the relay speaks both) and lets the host
// stream natively. Availability depends on the host runtime, so the probe must stay
// dynamic.
async function loadCodexApi(): Promise<ProviderStreams | undefined> {
  try {
    const compat = (await import("@oh-my-pi/pi-ai/compat")) as CompatModule;
    if (typeof compat.openAICodexResponsesApi !== "function") return undefined;
    return compat.openAICodexResponsesApi();
  } catch {
    return undefined;
  }
}

export const CODEX_API = await loadCodexApi();
