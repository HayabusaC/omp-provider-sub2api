import { afterAll, describe, expect, test } from "bun:test";
import { discoverPool } from "../omp-pool.ts";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/models") {
      const body = await request.json() as { model: string };
      return Response.json({ model: body.model });
    }
    const auth = request.headers.get("authorization");
    if (auth === "Bearer key-a") return Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] });
    if (auth === "Bearer key-b") return Response.json({ data: [{ id: "model-c" }, { id: "model-d" }] });
    return Response.json({ error: "invalid key" }, { status: 401 });
  },
});

afterAll(() => server.stop(true));

describe("sub2api HTTP model-pool integration", () => {
  test("discovers each key independently and merges the exact acceptance case", async () => {
    const pool = await discoverPool([
      { id: 1, key: "key-a" },
      { id: 2, key: "expired" },
      { id: 3, key: "key-b" },
    ], `http://${server.hostname}:${server.port}/v1`);

    expect(pool.models.map(model => model.id)).toEqual(["model-a", "model-b", "model-c", "model-d"]);
    expect(pool.routes.get("model-a")).toEqual([1]);
    expect(pool.routes.get("model-c")).toEqual([3]);
    expect(pool.discoveries.map(item => item.status)).toEqual(["ok", "invalid-key", "ok"]);
  });
});
