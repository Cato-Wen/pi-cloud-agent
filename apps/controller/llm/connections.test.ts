import { afterEach, describe, expect, it, vi } from "vitest";
import { testLlmEndpoint, thinkingLevelsFor } from "./connections";

afterEach(() => vi.unstubAllGlobals());

describe("testLlmEndpoint", () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

  it("tests the selected OpenAI-compatible API and model", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testLlmEndpoint(
      {
        baseUrl: "https://gateway.example/v1",
        apiKey: "secret",
        api: "openai-completions",
        model: "gateway/model-a",
      },
      { resolveHostname: publicLookup },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gateway/model-a",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      }),
    );
  });

  // The run calls the Anthropic SDK, which posts to `${baseUrl}/v1/messages`.
  // The test must hit the same URL, or it rejects a base URL the run accepts.
  it("uses Anthropic authentication and the URL the Anthropic SDK calls", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await testLlmEndpoint(
      {
        baseUrl: "https://api.anthropic.com",
        apiKey: "secret",
        api: "anthropic-messages",
        model: "claude-sonnet",
      },
      { resolveHostname: publicLookup },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "secret",
          "anthropic-version": "2023-06-01",
        },
      }),
    );
  });

  it("returns the provider error instead of reporting false success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{"error":"model not found"}', { status: 404 })),
    );

    await expect(
      testLlmEndpoint(
        {
          baseUrl: "https://gateway.example/v1",
          apiKey: "secret",
          api: "openai-responses",
          model: "missing-model",
        },
        { resolveHostname: publicLookup },
      ),
    ).rejects.toThrow('model endpoint returned 404: {"error":"model not found"}');
  });

  it.each([
    {
      name: "IPv4 link-local",
      baseUrl: "https://model.example/v1",
      resolveHostname: async () => [{ address: "169.254.169.254", family: 4 }],
    },
    { name: "IPv6 loopback", baseUrl: "http://[::1]:8080" },
    { name: "IPv4-compatible IPv6 loopback", baseUrl: "http://[::127.0.0.1]:8080" },
    {
      name: "hostname resolving to IPv6 loopback",
      baseUrl: "https://model.example/v1",
      resolveHostname: async () => [{ address: "::1", family: 6 }],
    },
  ])("rejects $name before making a request", async ({ baseUrl, resolveHostname }) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      testLlmEndpoint(
        {
          baseUrl,
          apiKey: "secret",
          api: "openai-completions",
          model: "model-a",
        },
        { resolveHostname },
      ),
    ).rejects.toThrow("public address");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects redirects from an allowed endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(null, { status: 302, headers: { location: "http://127.0.0.1" } }),
        ),
    );

    await expect(
      testLlmEndpoint(
        {
          baseUrl: "https://gateway.example/v1",
          apiKey: "secret",
          api: "openai-completions",
          model: "model-a",
        },
        { resolveHostname: publicLookup },
      ),
    ).rejects.toThrow("model endpoint returned 302");
  });
});

describe("thinking levels offered per connection", () => {
  it("lets API-key Anthropic connections choose a thinking level", () => {
    expect(
      thinkingLevelsFor({ authType: "api_key", api: "anthropic-messages" }, undefined),
    ).toEqual(["off", "low", "medium", "high"]);
  });

  it("keeps other API-key connections at off, since their reasoning controls are unknown", () => {
    expect(
      thinkingLevelsFor({ authType: "api_key", api: "openai-completions" }, undefined),
    ).toEqual(["off"]);
  });

  it("uses the catalog's levels for OAuth connections", () => {
    expect(
      thinkingLevelsFor({ authType: "oauth", api: "openai-codex-responses" }, ["low", "high"]),
    ).toEqual(["low", "high"]);
  });
});
