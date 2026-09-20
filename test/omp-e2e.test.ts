import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { AuthStorage } from "@oh-my-pi/pi-ai";

const access = new Map([
  ["key-a", new Set(["model-a", "model-b", "shared"])],
  ["key-b", new Set(["model-c", "model-d", "shared"])],
]);
const routedAttempts: Array<{ model: string; key: string }> = [];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const key = request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
    if (url.pathname === "/v1/models") {
      const models = access.get(key);
      return models
        ? Response.json({ data: [...models].map(id => ({ id })) })
        : Response.json({ error: "invalid key" }, { status: 401 });
    }
    if (url.pathname === "/v1/chat/completions") {
      const body = await request.json() as { model?: string };
      const model = body.model ?? "";
      routedAttempts.push({ model, key });
      if (model === "shared" && key === "key-a") {
        return Response.json({ error: "model permission revoked" }, { status: 403 });
      }
      if (!access.get(key)?.has(model)) return Response.json({ error: "model not permitted" }, { status: 403 });
      const text = model === "model-a" ? "OK-A" : model === "model-c" ? "OK-C" : "OK-S";
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      return new Response(`${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return new Response(null, { status: 404 });
  },
});

let isolatedAgentDir = "";
let isolatedConfigRoot = "";
const pluginEntry = join(import.meta.dir, "..", "omp-index.ts");
const ompExe = "C:\\Users\\Shen Chenye\\.bun\\bin\\omp.exe";

beforeAll(async () => {
  isolatedConfigRoot = await mkdtemp(join(tmpdir(), "omp-sub2api-e2e-"));
  isolatedAgentDir = join(isolatedConfigRoot, "agent");
  await mkdir(isolatedAgentDir);
  const storage = await AuthStorage.create(join(isolatedAgentDir, "agent.db"));
  await storage.reload();
  storage.upsertCredential("sub2api", { type: "api_key", key: "key-a", source: "login" });
  storage.upsertCredential("sub2api", { type: "api_key", key: "key-b", source: "login" });
  storage.close();
  await writeFile(join(isolatedAgentDir, "sub2api-model-cache.json"), JSON.stringify({
    provider: "sub2api",
    baseURL: `http://${server.hostname}:${server.port}/v1`,
    modelIds: ["model-a", "model-b", "model-c", "model-d", "shared"],
  }), "utf8");
});

afterAll(async () => {
  server.stop(true);
  if (isolatedConfigRoot) await rm(isolatedConfigRoot, { recursive: true, force: true });
});

async function runOMP(model: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([
    ompExe,
    "-p",
    "--no-tools",
    "--no-session",
    "--no-extensions",
    "--model",
    `sub2api/${model}`,
    "-e",
    pluginEntry,
    "Reply with exactly the supplied marker.",
  ], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...Bun.env,
      PI_CONFIG_DIR: relative(homedir(), isolatedConfigRoot),
      PI_CODING_AGENT_DIR: isolatedAgentDir,
      SUB2API_BASE_URL: `http://${server.hostname}:${server.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function listOMPModels(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([
    ompExe,
    "models",
    "sub2api",
    "--json",
    "--no-extensions",
    "-e",
    pluginEntry,
  ], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...Bun.env,
      PI_CONFIG_DIR: relative(homedir(), isolatedConfigRoot),
      PI_CODING_AGENT_DIR: isolatedAgentDir,
      SUB2API_BASE_URL: `http://${server.hostname}:${server.port}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("sub2api isolated OMP end-to-end routing", () => {
  test("routes disjoint models to their owning native AuthStorage credentials", async () => {
    const listing = await listOMPModels();
    expect({ exitCode: listing.exitCode, stderr: listing.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect((JSON.parse(listing.stdout) as { models: Array<{ selector: string }> }).models.map(model => model.selector)).toEqual([
      "sub2api/model-a",
      "sub2api/model-b",
      "sub2api/model-c",
      "sub2api/model-d",
      "sub2api/shared",
    ]);
    const a = await runOMP("model-a");
    const c = await runOMP("model-c");
    const shared = await runOMP("shared");
    expect(a.exitCode).toBe(0);
    expect(c.exitCode).toBe(0);
    expect(shared.exitCode).toBe(0);
    expect(a.stderr).toContain("Working...");
    expect(c.stderr).toContain("Working...");
    expect(shared.stderr).toContain("Working...");
    expect(a.stdout).toContain("OK-A");
    expect(c.stdout).toContain("OK-C");
    expect(shared.stdout).toContain("OK-S");
    expect(routedAttempts).toEqual([
      { model: "model-a", key: "key-a" },
      { model: "model-c", key: "key-b" },
      { model: "shared", key: "key-a" },
      { model: "shared", key: "key-b" },
    ]);
  }, 30_000);
});
