# Upstream lineage

This plugin is derived from [`@indexyz/pi-provider-sub2api`](https://github.com/5aaee9/pi-agent-extensions/tree/main/pi-provider-sub2api), upstream commit `83b6832665dd60ea0bdbd467c8e0e7326e03e14e` (version 0.1.35), under the MIT license preserved in `LICENSE`.

The upstream source files are retained so future improvements can be ported. `omp-index.ts` and `omp-pool.ts` are the OMP-native entry path. The principal divergence is credential architecture: upstream stores one token per relay in `sub2api.json`; this fork stores multiple keys in OMP AuthStorage, discovers each key independently, merges their model sets, and routes every request by model permission.
