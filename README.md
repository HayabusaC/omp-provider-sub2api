# OMP sub2api Multi-Key Provider

OMP-native fork of `@indexyz/pi-provider-sub2api` for the case where one sub2api service has several API keys and each key unlocks a different model pool.

Package version: `0.3.1`. Fork source: `@indexyz/pi-provider-sub2api` version `0.1.35`, upstream commit `83b6832665dd60ea0bdbd467c8e0e7326e03e14e`; see `UPSTREAM.md`.

## Configure

```powershell
omp plugin config set omp-provider-sub2api providerId sub2api
omp plugin config set omp-provider-sub2api baseURL https://relay.example.com
omp plugin config set omp-provider-sub2api api auto
```

For isolated development only, `SUB2API_BASE_URL` can supply the non-secret base URL when the plugin is loaded explicitly with `omp -e`. Persisted plugin settings take precedence. API keys never use this environment fallback and remain in OMP AuthStorage.

No key belongs in plugin settings or `sub2api.json`. Start OMP and run `/sub2api-key-add` once per key. Each key is persisted by OMP AuthStorage under the configured provider ID. `/sub2api-test` re-fetches `/v1/models` separately with every stored credential and reports each key as valid, invalid (401/403), or endpoint error.

The merged provider keeps original model IDs and de-duplicates them. Its in-memory route is `model ID → ordered credential IDs`; stored credential order is the deterministic priority when keys overlap. Requests automatically use the first key that advertised the model. A pre-output 401/403 or model-permission rejection advances only to the next key for that model. A failed key or one key's model endpoint error does not disable the provider.

The non-secret merged model cache at `~/.omp/agent/sub2api-model-cache.json` lets registry consumers see the last refreshed union before the first session refresh. It contains only provider/base URL/model IDs—never credentials. A refresh republishes the complete union to OMP immediately; if no stored key currently yields models, the empty result also replaces the stale cache instead of leaving inaccessible models visible.

OMP 18.2.7 requires an extension-owned `apiKey` or OAuth declaration when a provider supplies a static `models` array. This plugin deliberately does neither: cached and refreshed unions are exposed through authoritative dynamic discovery, preserving OMP AuthStorage as the only credential source.

`api=auto` uses OMP's built-in transports: Claude IDs use Anthropic Messages, GPT/Codex/OpenAI IDs use Responses, and other IDs use Chat Completions. Explicit transport selection is available for homogeneous relays.

Provider model prices start from OMP's built-in official USD model prices and are scaled by `(model_stats.cost / model_stats.account_cost) × /v1/sub2api/billing.effective_rate_multiplier × 0.143`. The billing result is denominated in CNY, so `0.143` converts it to the USD-denominated cost fields used by OMP. This matches actual settlement as `billed CNY × 0.143`. No account multiplier is hard-coded. Until the required official model metadata and server-side multiplier data have been observed, the discovered model keeps its zero-cost fallback rather than inventing a price; transient refresh failures preserve the last valid per-key price.

The model pool and pricing are fetched once at session startup and remain fixed for that session. Adding a key with `/sub2api-key-add` or explicitly running `/sub2api-test` performs another full refresh. Each stored key has its own price map; the request router applies the startup snapshot belonging to the credential actually used, including after credential failover. The shared model picker necessarily displays the first eligible key's price because one selector cannot represent several simultaneous key-specific prices.

See `UPSTREAM.md` for fork provenance. The retained upstream files are not the OMP entry point; `package.json#omp.extensions` loads only `omp-index.ts`.

## Verification

`bun test` includes an isolated end-to-end OMP test. It creates a temporary native `AuthStorage`, starts a local HTTP-compatible sub2api fixture, loads only `omp-index.ts` with `-e`, verifies the merged selectors, and invokes `model-a` with Key A plus `model-c` with Key B. A shared model deliberately returns 403 for Key A and succeeds with Key B, confirming pre-output credential failover. No test installs the plugin or writes the real OMP configuration.
