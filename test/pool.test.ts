import { describe, expect, test } from "bun:test";
import { costForCredential, isAuthOrPermissionFailure } from "../omp-index.ts";
import { discoverPool, normalizeBaseURL, routeApi } from "../omp-pool.ts";

describe("sub2api multi-key pool", () => {
  test("normalizes root and versioned base URLs without a double slash", () => {
    expect(normalizeBaseURL("https://sub.example")).toEqual({
      apiBase: "https://sub.example/v1",
      anthropicBase: "https://sub.example",
    });
    expect(normalizeBaseURL("https://sub.example/v1/")).toEqual({
      apiBase: "https://sub.example/v1",
      anthropicBase: "https://sub.example",
    });
  });

  test("merges and de-duplicates models while preserving credential priority", async () => {
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer A") return Response.json({ data: [{ id: "model-a" }, { id: "shared" }] });
      if (auth === "Bearer B") return Response.json({ data: [{ id: "model-c" }, { id: "shared" }] });
      return new Response(null, { status: 401 });
    };
    const pool = await discoverPool([{ id: 10, key: "A" }, { id: 20, key: "B" }], "https://sub.example/v1", fetchMock as typeof fetch);
    expect(pool.models.map(model => model.id)).toEqual(["model-a", "model-c", "shared"]);
    expect(pool.routes.get("shared")).toEqual([10, 20]);
    expect(pool.routes.get("model-c")).toEqual([20]);
  });

  test("one invalid key does not hide valid-key models", async () => {
    const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer bad" ? new Response(null, { status: 403 }) : Response.json({ data: [{ id: "ok" }] });
    };
    const pool = await discoverPool([{ id: 1, key: "bad" }, { id: 2, key: "good" }], "https://sub.example/v1", fetchMock as typeof fetch);
    expect(pool.models.map(model => model.id)).toEqual(["ok"]);
    expect(pool.discoveries.map(item => item.status)).toEqual(["invalid-key", "ok"]);
  });

  test("auto protocol selection is deterministic", () => {
    expect(routeApi("claude-sonnet-4-6", "auto")).toBe("anthropic-messages");
    expect(routeApi("gpt-5.6-sol", "auto")).toBe("openai-responses");
    expect(routeApi("openai/gpt-5.6-sol", "auto")).toBe("openai-responses");
    expect(routeApi("model-a", "auto")).toBe("openai-completions");
  });

  test("uses OMP AssistantMessage.errorStatus for per-key failover", () => {
    expect(isAuthOrPermissionFailure({ errorStatus: 401, errorMessage: "denied" })).toBe(true);
    expect(isAuthOrPermissionFailure({ errorStatus: 403, errorMessage: "denied" })).toBe(true);
    expect(isAuthOrPermissionFailure({ errorStatus: 404, errorMessage: "model not found" })).toBe(true);
    expect(isAuthOrPermissionFailure({ errorStatus: 500, errorMessage: "upstream" })).toBe(false);
  });

  test("never borrows another credential's model price during failover", () => {
    const first = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const costs = new Map([[10, new Map([["shared", first]])]]);
    expect(costForCredential(costs, 10, "shared")).toBe(first);
    expect(costForCredential(costs, 20, "shared")).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    });
  });
});
