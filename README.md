# OMP sub2api Multi-Key Provider

OMP-native fork of `@indexyz/pi-provider-sub2api` for the case where one sub2api service has several API keys and each key unlocks a different model pool.

## Configure

```powershell
omp plugin config set omp-provider-sub2api providerId sub2api
omp plugin config set omp-provider-sub2api baseURL https://relay.example.com
omp plugin config set omp-provider-sub2api api auto
```

For isolated development only, `SUB2API_BASE_URL` can supply the non-secret base URL when the plugin is loaded explicitly with `omp -e`. Persisted plugin settings take precedence. API keys never use this environment fallback and remain in OMP AuthStorage.

No key belongs in plugin settings or `sub2api.json`. Start OMP and run `/sub2api-key-add` once per key. Each key is persisted by OMP AuthStorage under the configured provider ID. `/sub2api-test` re-fetches `/v1/models` separately with every stored credential and reports each key as valid, invalid (401/403), or endpoint error.

The merged provider keeps original model IDs and de-duplicates them. Its in-memory route is `model ID → ordered credential IDs`; stored credential order is the deterministic priority when keys overlap. Requests automatically use the first key that advertised the model. A pre-output 401/403 or model-permission rejection advances only to the next key for that model. A failed key or one key's model endpoint error does not disable the provider.

The non-secret merged model cache at `~/.omp/agent/sub2api-model-cache.json` lets registry consumers see the last successful union before the first session refresh. It contains only provider/base URL/model IDs—never credentials.

OMP 18.2.6 requires an extension-owned `apiKey` or OAuth declaration when a provider supplies a static `models` array. This plugin deliberately does neither: cached and refreshed unions are exposed through authoritative dynamic discovery, preserving OMP AuthStorage as the only credential source.

`api=auto` uses OMP's built-in transports: Claude IDs use Anthropic Messages, GPT/Codex/OpenAI IDs use Responses, and other IDs use Chat Completions. Explicit transport selection is available for homogeneous relays.

See `UPSTREAM.md` for fork provenance. The retained upstream files are not the OMP entry point; `package.json#omp.extensions` loads only `omp-index.ts`.

## Verification

`bun test` includes an isolated end-to-end OMP test. It creates a temporary native `AuthStorage`, starts a local HTTP-compatible sub2api fixture, loads only `omp-index.ts` with `-e`, verifies the merged selectors, and invokes `model-a` with Key A plus `model-c` with Key B. A shared model deliberately returns 403 for Key A and succeeds with Key B, confirming pre-output credential failover. No test installs the plugin or writes the real OMP configuration.
