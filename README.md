# OMP sub2api Multi-Key Provider

[English](README.md) | [简体中文](README.zh-CN.md)

A multi-key sub2api provider for [oh-my-pi (OMP)](https://omp.sh/). It discovers and verifies the models available to each API key, merges them into one provider, routes each request to a key that can access the selected model, and can fail over to another eligible key when authentication or model-permission errors occur before output begins.

Current version: `0.4.0`.

## Features

- Stores multiple API keys in OMP's native `AuthStorage`; keys are never written to plugin settings or the model cache.
- Discovers `/v1/models` separately for every key and verifies each advertised model with a minimal non-streaming request.
- Merges the verified model sets while preserving original upstream model IDs.
- Routes requests through an ordered `model ID → credential IDs` pool.
- Fails over on pre-output 401, 403, 404, or model-permission failures.
- Automatically selects Anthropic Messages, OpenAI Responses, or Chat Completions by model ID.
- Calculates key-specific OMP price estimates from sub2api usage and billing multipliers.
- Keeps a non-secret model cache so OMP can display the last published model set during startup.

## Requirements

- OMP `18.2.10` or a compatible release.
- Bun only when developing from source or running tests.
- A sub2api service exposing compatible endpoints:
  - `GET /v1/models`
  - `POST /v1/responses`
  - `POST /v1/chat/completions`
  - `POST /v1/messages` for Claude/Anthropic models
  - Optional `GET /v1/usage` and `GET /v1/sub2api/billing` for price estimates

## Installation

Install from npm:

```powershell
omp plugin install omp-provider-sub2api
```

For local development, run from this repository's parent workspace:

```powershell
npm install
omp plugin link .\omp-provider-sub2api
```

Confirm that OMP loaded the plugin:

```powershell
omp plugin list
omp plugin doctor omp-provider-sub2api
```

## Quick start

### 1. Configure the relay

```powershell
omp plugin config set omp-provider-sub2api providerId sub2api
omp plugin config set omp-provider-sub2api baseURL https://relay.example.com
omp plugin config set omp-provider-sub2api api auto
```

`baseURL` may include or omit the trailing `/v1`; the plugin normalizes it. It must be an HTTP(S) URL without embedded credentials, a query string, or a fragment.

### 2. Add API keys

Start interactive OMP and run this once for each key:

```text
/sub2api-key-add
```

OMP saves the entered value in `AuthStorage`. Adding a key triggers model discovery and verification. Verification makes real upstream requests and may incur a small charge.

### 3. Verify and select a model

```text
/sub2api-test
/model
```

You can also inspect or refresh models from the shell:

```powershell
omp models sub2api
omp models refresh
```

The full selector is `sub2api/<model-id>`. If you change `providerId`, the selector prefix changes with it.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `providerId` | `sub2api` | OMP provider ID for the merged pool and the AuthStorage credential namespace |
| `baseURL` | empty | Relay root; accepts either `https://host` or `https://host/v1` |
| `api` | `auto` | Transport used by discovered models; see below |

Supported `api` values:

| Value | Behavior |
| --- | --- |
| `auto` | IDs containing `claude` use Anthropic Messages; GPT, Codex, ChatGPT, and `o`-series IDs use OpenAI Responses; all other IDs use Chat Completions |
| `openai-responses` | Every model uses `POST /v1/responses` |
| `openai-completions` | Every model uses `POST /v1/chat/completions` |
| `anthropic-messages` | Every model uses `POST /v1/messages` |

An explicit transport is useful for homogeneous relays. Keep `auto` when one relay serves a mixture of Claude, OpenAI, and other compatible models.

Changing `providerId` does not migrate credentials stored under the old ID; add them again under the new ID. Reload OMP or refresh models after changing `baseURL` or `api`.

### Development-only base URL

When loading the extension directly with `omp -e`, `SUB2API_BASE_URL` supplies the non-secret base URL if the saved plugin setting is empty:

```powershell
$env:SUB2API_BASE_URL = "https://relay.example.com"
omp -e .\omp-provider-sub2api\omp-index.ts
```

The saved `baseURL` takes precedence. API keys have no environment-variable fallback and remain managed by OMP `AuthStorage`.

## Commands

| Command | Behavior |
| --- | --- |
| `/sub2api-key-add` | Prompts for one API key, saves or updates an OMP credential, and refreshes the model pool |
| `/sub2api-test` | Ignores the verification cache, rediscovers and re-verifies every stored key, and reports per-key status |

Statuses reported by `/sub2api-test`:

- `ok`: `/v1/models` succeeded; the result also gives verified and rejected model counts.
- `invalid-key`: the model-list request returned 401 or 403.
- `endpoint-error`: a network error, timeout, malformed payload, or another model-list HTTP error occurred.

The plugin currently registers no key-list or key-delete command. Credential lifecycle outside key addition remains the responsibility of OMP's AuthStorage/credential management facilities.

## How it works

### Discovery and verification

For each key, the plugin:

1. sends an authenticated `GET /v1/models` request to obtain candidate IDs;
2. sends a non-streaming request with at most 16 output tokens for every candidate, using the configured transport;
3. retains the model only when the request succeeds and the response `model` exactly matches the requested ID;
4. rejects candidates that the relay silently redirects to a different model;
5. merges, deduplicates, and sorts the verified model IDs from every valid key.

Probe concurrency is 4. The model-list timeout is 10 seconds, and each model probe has a 30-second timeout. Initial verification can therefore take time when a relay advertises many models or responds slowly.

Normal startup reuses verification cached by credential ID. Replacing a key changes its SHA-256 fingerprint and forces that credential to be verified again. `/sub2api-test` always forces verification of all keys.

### Routing and failover

Each model maps to eligible credentials in storage order. A request freezes the current route, keys, and prices so a background refresh cannot alter an in-flight failover chain.

The first eligible key is tried first. Before the first text, thinking, tool-call, or completion event is emitted, the router advances to the next eligible key after:

- HTTP 401, 403, or 404; or
- an error message indicating unauthorized/forbidden access, a permission failure, or an unavailable, unsupported, or missing model.

After any content has been emitted, the request is not replayed and no key failover occurs, which avoids duplicate output. Rate limits, network errors, server errors, and other non-permission failures are returned to OMP without cross-key retry.

### Model cache

The default cache path is:

```text
~/.omp/agent/sub2api-model-cache.json
```

When `PI_CODING_AGENT_DIR` is set, the file is stored there instead. It contains the provider ID, normalized base URL, model IDs, credential IDs, and SHA-256 key fingerprints. It never contains plaintext API keys. The cache lets OMP show the last published model union before the process performs its first online refresh.

A completed refresh publishes the current full union. An empty result also replaces stale models, so inaccessible models do not remain visible.

## Price estimates

For each key, the plugin reads:

- per-model `model_stats.cost` and `model_stats.account_cost` from `GET /v1/usage`;
- `effective_rate_multiplier` from `GET /v1/sub2api/billing`; and
- the model's official USD price from OMP's bundled catalog.

The OMP model cost is:

```text
official USD price × (model_stats.cost / model_stats.account_cost)
                   × effective_rate_multiplier × 0.143
```

The `0.143` factor converts sub2api's CNY settlement amount into OMP's USD cost fields. One model selector can display only one price, so the picker shows the first eligible key's price. At request time, the router applies the price belonging to the key that actually serves the request, including after failover.

If official metadata, a valid usage ratio, or the billing multiplier is unavailable, the price remains `0` instead of being guessed. A transient refresh failure preserves the last valid pricing data for that key. These values are session estimates, not authoritative sub2api invoice settlement.

## Troubleshooting

### `inactive: configure baseURL`

The plugin could not resolve a service URL. Configure it and inspect plugin health:

```powershell
omp plugin config set omp-provider-sub2api baseURL https://relay.example.com
omp plugin doctor omp-provider-sub2api
```

### The model list is empty

1. Run `/sub2api-key-add` at least once.
2. Confirm that `baseURL` points to the correct relay and `/v1/models` is reachable.
3. Run `/sub2api-test` to distinguish `invalid-key`, `endpoint-error`, and candidates rejected by verification.
4. Confirm that `api` matches the endpoints supported by the relay.
5. Reload the session after setting changes and run `omp models refresh` if needed.

### `/v1/models` returns IDs, but the plugin does not publish them

The inventory is only a candidate list. The minimal generation request must succeed, and the response `model` must exactly match the candidate ID. Common causes are missing inference permission, a wrong transport setting, no support for non-streaming calls, or silent routing to another model.

### A shared model did not fail over

Failover occurs only before output and only for authentication, permission, or model-availability failures. It does not occur after a token has been emitted, or for HTTP 429, 5xx, network interruption, and ordinary protocol errors.

### Prices stay at zero

Pricing requires an exact model ID in OMP's official catalog, positive usable `cost/account_cost` data from `/v1/usage`, and a valid multiplier from `/v1/sub2api/billing`. A new key or a model with no prior usage may not yet provide enough data.

## Security notes

- OMP `AuthStorage` holds API keys; `sub2api-model-cache.json` does not.
- Cached SHA-256 fingerprints detect replaced keys. They are not reversible keys, but the OMP data directory should still be protected.
- Do not place keys in `baseURL`, plugin settings, shell history, or repository files.
- Use a trusted HTTPS relay except in a controlled local development environment.
- Verification sends the fixed prompt `Reply OK` to upstream models and can be billable.

## Development and verification

From the parent workspace:

```powershell
npm run typecheck --workspace omp-provider-sub2api
npm test --workspace omp-provider-sub2api
npm run build --workspace omp-provider-sub2api
```

Or from the plugin directory with Bun:

```powershell
bun run typecheck
bun test
bun run build
```

Tests use synthetic keys, temporary AuthStorage, and a loopback HTTP fixture; they do not modify the real OMP configuration. The end-to-end test finds `omp` on `PATH`; set `OMP_BIN` to select another executable.

## Upstream and license

This plugin is derived from [`@indexyz/pi-provider-sub2api` 0.1.35](https://github.com/5aaee9/pi-agent-extensions/tree/83b6832665dd60ea0bdbd467c8e0e7326e03e14e/pi-provider-sub2api) at upstream commit [`83b6832`](https://github.com/5aaee9/pi-agent-extensions/commit/83b6832665dd60ea0bdbd467c8e0e7326e03e14e). See [`UPSTREAM.md`](UPSTREAM.md) for provenance and [`LICENSE`](LICENSE) for license terms.

`package.json#omp.extensions` loads `omp-index.ts`. Other retained upstream entry files are not this package's OMP entry point.
