import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const https = vi.hoisted(() => ({ calls: [] as Array<{ url: string; options: Record<string, unknown>; body: string }> }));

vi.mock("node:https", () => ({
  request: (url: string, options: Record<string, unknown>, onResponse: (response: EventEmitter) => void) => {
    const call = { url: String(url), options, body: "" };
    https.calls.push(call);
    const request = new EventEmitter() as EventEmitter & { write: (chunk: string) => void; end: () => void };
    request.write = (chunk) => {
      call.body += chunk;
    };
    request.end = () => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        statusMessage: "OK",
        headers: { "content-type": "application/json" },
      });
      onResponse(response);
      response.emit("data", Buffer.from(JSON.stringify({ ok: true })));
      response.emit("end");
    };
    return request;
  },
}));

const { jiraFetch } = await import("./server");

const untrusted = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("self-signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    }),
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jiraFetch", () => {
  it("retries with the OS trust store when an inspecting proxy re-signs TLS, then keeps using it", async () => {
    const fetchMock = vi.fn().mockRejectedValue(untrusted());
    vi.stubGlobal("fetch", fetchMock);

    const first = await jiraFetch("https://example.atlassian.net/rest/api/3/search/jql", {
      method: "POST",
      headers: { accept: "application/json" },
      body: '{"jql":"x"}',
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(https.calls[0]).toMatchObject({ body: '{"jql":"x"}', options: { method: "POST" } });
    expect(Array.isArray(https.calls[0]!.options.ca)).toBe(true);

    await jiraFetch("https://example.atlassian.net/rest/api/3/field", { headers: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(https.calls).toHaveLength(2);
  });
});
