# OMP sub2api 多密钥 Provider

[English](README.md) | [简体中文](README.zh-CN.md)

为 [oh-my-pi（OMP）](https://omp.sh/) 提供 sub2api 多密钥接入。插件分别发现并验证每个 API Key 可用的模型，将结果合并为一个 Provider，并在请求时按模型权限选择密钥。多个密钥都能使用同一模型时，还可在响应输出前因鉴权或模型权限错误自动切换到下一个密钥。

当前版本：`0.4.1`。

## 功能概览

- 使用 OMP 原生 `AuthStorage` 保存多个 API Key，不把密钥写入插件设置或模型缓存；
- 对每个密钥独立请求 `/v1/models`，再逐模型发送最小非流式请求验证真实权限；
- 合并各密钥的模型列表，并保持上游原始模型 ID；
- 按 `模型 ID → 可用凭据 ID 列表` 路由请求；
- 在首段文本、思考或工具调用输出之前遇到 401、403、404 或模型权限错误时切换密钥；
- 根据模型 ID 自动选择 Anthropic Messages、OpenAI Responses 或 Chat Completions；
- 根据 sub2api 的用量与计费倍率，按密钥计算 OMP 中显示的美元估价；
- 保存不含明文密钥的模型缓存，加快 OMP 启动和模型列表加载。

## 环境要求

- OMP `18.2.10` 或兼容版本；
- Bun（仅从源码开发或运行测试时需要）；
- 一个可访问以下兼容接口的 sub2api 服务：
  - `GET /v1/models`
  - `POST /v1/responses`
  - `POST /v1/chat/completions`
  - `POST /v1/messages`（使用 Claude/Anthropic 模型时）
  - `GET /v1/usage` 和 `GET /v1/sub2api/billing`（可选，用于价格估算）

## 安装

从 npm 安装：

```powershell
omp plugin install omp-provider-sub2api
```

在本仓库的父级 workspace 中本地开发：

```powershell
npm install
omp plugin link .\omp-provider-sub2api
```

可用下面的命令确认插件已加载：

```powershell
omp plugin list
omp plugin doctor omp-provider-sub2api
```

## 快速开始

### 1. 设置服务地址

```powershell
omp plugin config set omp-provider-sub2api providerId sub2api
omp plugin config set omp-provider-sub2api baseURL https://relay.example.com
omp plugin config set omp-provider-sub2api api auto
```

`baseURL` 可以带或不带末尾的 `/v1`，插件会自动规范化。它必须是没有用户名、密码、查询参数或 URL fragment 的 `http`/`https` 地址。

### 2. 添加密钥

启动交互式 OMP，然后对每个密钥分别运行一次：

```text
/sub2api-key-add
```

输入内容由 OMP 保存到 `AuthStorage`。插件设置、README 示例和模型缓存中都不需要填写 API Key。

添加密钥后，插件会发现并验证模型。验证请求会真实访问上游，可能产生少量费用。

### 3. 检查并选择模型

```text
/sub2api-test
/model
```

也可在终端查看或强制刷新目录：

```powershell
omp models sub2api
omp models refresh
```

模型选择器中的完整 selector 形式为 `sub2api/<model-id>`；如果修改了 `providerId`，前缀也会随之改变。

## 配置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `providerId` | `sub2api` | 合并后的 OMP Provider ID，也是 AuthStorage 中保存凭据时使用的 ID |
| `baseURL` | 空 | sub2api 服务根地址；可写 `https://host` 或 `https://host/v1` |
| `api` | `auto` | 模型使用的传输协议；可选值见下表 |

`api` 的可选值：

| 值 | 行为 |
| --- | --- |
| `auto` | ID 含 `claude` 的模型走 Anthropic Messages；GPT、Codex、ChatGPT 和 `o` 系列走 OpenAI Responses；其他模型走 Chat Completions |
| `openai-responses` | 所有模型都使用 `POST /v1/responses` |
| `openai-completions` | 所有模型都使用 `POST /v1/chat/completions` |
| `anthropic-messages` | 所有模型都使用 `POST /v1/messages` |

显式协议适用于所有模型协议一致的中转服务。如果同一服务同时包含 Claude、OpenAI 和其他兼容模型，通常应保留 `auto`。

修改 `providerId` 后，旧 ID 下保存的密钥不会自动迁移，需要在新 ID 下重新执行 `/sub2api-key-add`。修改 `baseURL` 或 `api` 后，重新加载 OMP 或执行模型刷新以应用设置。

### 临时开发配置

使用 `omp -e` 直接加载扩展、且插件设置中没有 `baseURL` 时，可通过非敏感环境变量提供地址：

```powershell
$env:SUB2API_BASE_URL = "https://relay.example.com"
omp -e .\omp-provider-sub2api\omp-index.ts
```

已保存的 `baseURL` 优先于该环境变量。API Key 没有环境变量回退，仍由 OMP `AuthStorage` 管理。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/sub2api-key-add` | 提示输入一个 API Key，保存或更新 OMP 凭据，并刷新模型池 |
| `/sub2api-test` | 忽略已有验证缓存，重新发现并验证所有已保存密钥，并报告每个密钥的状态 |

`/sub2api-test` 报告中的状态含义：

- `ok`：`/v1/models` 可用；报告同时给出通过与被拒绝的模型数；
- `invalid-key`：模型列表请求返回 401 或 403；
- `endpoint-error`：网络错误、超时、响应结构异常，或模型列表接口返回其他错误。

OMP 当前没有由本插件注册的密钥列表或删除命令；凭据生命周期仍由 OMP 的 AuthStorage/凭据管理能力负责。

## 工作原理

### 模型发现与验证

每个密钥按以下流程处理：

1. 使用 Bearer 认证请求 `GET /v1/models`，取得候选模型 ID；
2. 根据 `api` 设置，为每个候选模型发送最多 16 个输出 token 的非流式请求；
3. 仅当请求成功且响应中的 `model` 与请求 ID 完全一致时保留该模型；
4. 若上游把请求静默改路由到另一个模型，则拒绝该候选模型；
5. 合并所有有效密钥的结果，对模型 ID 去重并排序。

探测并发数为 4；模型列表请求超时 10 秒，单模型验证请求超时 30 秒。模型较多或上游较慢时，首次验证可能需要一些时间。

正常启动会复用凭据 ID 对应的验证缓存；密钥内容发生变化时，SHA-256 指纹不再匹配，该密钥会重新验证。`/sub2api-test` 始终强制验证全部密钥。

### 路由与故障转移

插件为每个模型保存按凭据存储顺序排列的候选密钥。一次请求会冻结当时的路由、密钥和价格快照，避免后台刷新改变正在进行的请求。

请求首先使用该模型的第一个可用密钥。首段文本、思考、工具调用或完成事件输出前，如果遇到以下情况，则尝试下一个支持该模型的密钥：

- HTTP 401、403 或 404；
- 错误消息表示未授权、禁止访问、权限不足、模型不存在、不可用或不受支持。

一旦已经向 OMP 输出内容，插件不会重放请求或切换密钥，以免产生重复内容。网络错误、限流、服务端错误以及其他非权限类错误也不会触发跨密钥重试，而是原样返回给 OMP。

### 模型缓存

缓存默认位于：

```text
~/.omp/agent/sub2api-model-cache.json
```

如果设置了 `PI_CODING_AGENT_DIR`，缓存位于该目录中。缓存包含 Provider ID、规范化后的基础地址、模型 ID、凭据 ID 和密钥的 SHA-256 指纹，但不包含明文 API Key。它让 OMP 在当前进程首次在线刷新前即可显示上次成功发布的模型集合。

刷新完成后，插件会发布当前完整集合；即使没有任何密钥可用，也会用空集合替换旧结果，避免继续展示已不可访问的模型。

## 价格估算

插件按密钥读取：

- `GET /v1/usage` 中对应模型的 `model_stats.cost` 与 `model_stats.account_cost`；
- `GET /v1/sub2api/billing` 中的 `effective_rate_multiplier`；
- OMP 内置 OpenAI、Anthropic、Google 和 xAI catalog 中该模型的官方美元单价。

最终写入 OMP 的模型价格为：

```text
官方 USD 单价 × (model_stats.cost / model_stats.account_cost)
             × effective_rate_multiplier × 0.143
```

`0.143` 用于把 sub2api 的 CNY 结算金额换算到 OMP 的 USD 成本字段。模型选择器只能显示一个价格，因此显示第一个可用密钥的价格；真正发起请求时，插件会使用实际服务密钥对应的价格，包括故障转移后的密钥。

价格匹配优先使用完整模型 ID，其次移除 `google/` 等 provider 前缀。Gemini 还支持有界别名匹配：移除 sub2api 的 `-low`、`-medium`、`-high`、`-tiered` 路由后缀，并在需要时匹配官方 catalog 中的 `-preview` 型号。插件不会跨模型版本或系列做宽泛相似度匹配。

写入 OMP 的每百万 token 单价统一保留 12 位小数，避免 JavaScript 浮点运算在费用中显示很长的 `99999` 尾数。缺少官方模型元数据、有效用量比率或计费倍率时，价格保留为 `0`，不会猜测。临时刷新失败时保留该密钥上一次有效的价格数据。这里是会话成本估算，不是 sub2api 账单的最终结算结果。

## 故障排查

### 插件提示 `inactive: configure baseURL`

插件没有读到服务地址。检查：

```powershell
omp plugin config set omp-provider-sub2api baseURL https://relay.example.com
omp plugin doctor omp-provider-sub2api
```

### 模型列表为空

依次确认：

1. 至少执行过一次 `/sub2api-key-add`；
2. `baseURL` 指向正确服务，且 `/v1/models` 可访问；
3. 运行 `/sub2api-test` 查看密钥是 `invalid-key`、`endpoint-error`，还是所有候选模型都被验证拒绝；
4. 检查 `api` 是否与服务实际支持的端点一致；
5. 修改设置后重新加载会话，必要时运行 `omp models refresh`。

### `/v1/models` 有模型，但插件没有发布

模型列表只是候选来源。最小验证请求必须成功，而且响应的 `model` 必须与候选 ID 完全一致。常见原因包括密钥没有推理权限、协议设置错误、上游不支持非流式调用，或服务把请求改路由到别的模型。

### 同一模型没有切换到备用密钥

故障转移只发生在内容输出之前，且只处理鉴权/权限/模型不可用类错误。已经输出 token、429 限流、5xx、网络中断或普通协议错误不会切换密钥。

### 价格一直为 0

价格要求官方模型 ID 能在 OMP catalog 中匹配，并且 `/v1/usage` 已提供可计算的正数 `cost/account_cost`，同时 `/v1/sub2api/billing` 返回有效倍率。新密钥或从未产生用量的模型可能暂时没有足够数据。

## 安全说明

- API Key 由 OMP `AuthStorage` 保存，不会写入 `sub2api-model-cache.json`；
- 缓存中的 SHA-256 指纹用于检测密钥替换，不应视为可逆密钥，但仍建议保护 OMP 数据目录；
- 不要把密钥放入 `baseURL`、插件设置、命令历史或仓库文件；
- 服务地址必须使用可信 HTTPS，除非是受控的本机开发环境；
- 模型验证会向上游发送固定的 `Reply OK` 测试请求，并可能产生费用。

## 开发与验证

在父级 workspace 中运行：

```powershell
npm run typecheck --workspace omp-provider-sub2api
npm test --workspace omp-provider-sub2api
npm run build --workspace omp-provider-sub2api
```

也可在插件目录中使用 Bun：

```powershell
bun run typecheck
bun test
bun run build
```

测试使用合成密钥、临时 AuthStorage 和本机回环 HTTP 服务，不写入真实 OMP 配置。端到端测试从 `PATH` 查找 `omp`；可设置 `OMP_BIN` 指向其他可执行文件。

## 来源与许可

本插件派生自 [`@indexyz/pi-provider-sub2api` 0.1.35](https://github.com/5aaee9/pi-agent-extensions/tree/83b6832665dd60ea0bdbd467c8e0e7326e03e14e/pi-provider-sub2api)，对应上游提交 [`83b6832`](https://github.com/5aaee9/pi-agent-extensions/commit/83b6832665dd60ea0bdbd467c8e0e7326e03e14e)。详细来源见 [`UPSTREAM.md`](UPSTREAM.md)，许可条款见 [`LICENSE`](LICENSE)。

OMP 实际入口为 `omp-index.ts`，由 `package.json#omp.extensions` 加载；仓库中保留的其他上游入口不是本包的 OMP 启动入口。
