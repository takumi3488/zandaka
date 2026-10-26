import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { extractEntries, OpenRouterTimeoutError } from "./openrouter";

const API_KEY = "test-only-openrouter-key";
const IMAGE_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type CapturedRequest = {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: string;
  signal: AbortSignal | undefined;
};

function image(): File {
  return new File([IMAGE_BYTES], "receipt.png", { type: "image/png" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(content: string | undefined, finishReason = "stop"): Response {
  const message: { role: string; content?: string } = { role: "assistant" };
  if (content !== undefined) message.content = content;

  return jsonResponse({
    id: "fixture-completion",
    object: "chat.completion",
    created: 1,
    model: "z-ai/glm-5.3-flash",
    choices: [{ index: 0, finish_reason: finishReason, message }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function installFetchFixture(
  t: TestContext,
  reply: (request: CapturedRequest) => Response | Promise<Response>,
): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : undefined;
      const body = init?.body ?? (request ? await request.clone().text() : undefined);
      const captured: CapturedRequest = {
        url: request?.url ?? String(input),
        method: init?.method ?? request?.method,
        headers: new Headers(init?.headers ?? request?.headers),
        body: typeof body === "string" ? body : "",
        signal: init?.signal ?? request?.signal,
      };
      requests.push(captured);
      return reply(captured);
    },
  );
  return requests;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function rejectedExtraction(
  t: TestContext,
  reply: () => Response | Promise<Response>,
): Promise<{ requests: CapturedRequest[]; error: Error }> {
  const requests = installFetchFixture(t, reply);
  let failure: unknown;
  try {
    await extractEntries(image(), API_KEY);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, "extractEntries should reject");
  return { requests, error: failure };
}

function assertSanitized(error: Error): void {
  assert.doesNotMatch(error.message, /test-only-openrouter-key|fixture-private-provider-detail/);
}

test("extractEntries parses multiple rows and keeps uncertain fields nullable", async (t) => {
  const requests = installFetchFixture(t, () =>
    completion(
      JSON.stringify({
        entries: [
          { occurredOn: "2026-10-01", kind: "income", amountYen: 2000, description: " 会費 " },
          {
            occurredOn: null,
            kind: null,
            amountYen: null,
            description: "日付と金額を確認してください",
          },
        ],
        warnings: ["日付を確認してください"],
      }),
    ),
  );

  const result = await extractEntries(image(), API_KEY);
  assert.deepEqual(result, {
    entries: [
      { occurredOn: "2026-10-01", kind: "income", amountYen: 2000, description: "会費" },
      {
        occurredOn: null,
        kind: null,
        amountYen: null,
        description: "日付と金額を確認してください",
      },
    ],
    warnings: ["日付を確認してください"],
  });
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), `Bearer ${API_KEY}`);
  assert.equal(request.headers.has("http-referer"), false);

  const body = record(JSON.parse(request.body) as unknown);
  assert.equal(body.model, "z-ai/glm-5.3-flash");
  assert.notEqual(body.stream, true);
  assert.equal(body.max_tokens, 16384);
  assert.deepEqual(body.reasoning, { effort: "high", exclude: true });
  assert.deepEqual(body.provider, { require_parameters: true });

  const messages = body.messages as unknown[];
  assert.ok(Array.isArray(messages));
  const userMessage = messages.map(record).find((message) => message.role === "user");
  assert.ok(userMessage);
  const userContent = userMessage.content as unknown[];
  assert.ok(Array.isArray(userContent));
  const textIndex = userContent.findIndex(
    (part) => record(part).type === "text" && typeof record(part).text === "string",
  );
  const imageIndex = userContent.findIndex((part) => record(part).type === "image_url");
  assert.ok(textIndex >= 0 && imageIndex > textIndex, "user text must precede the image");
  const imagePart = record(userContent[imageIndex]);
  const imageUrl = record(imagePart.image_url);
  assert.equal(
    imageUrl.url,
    `data:image/png;base64,${Buffer.from(IMAGE_BYTES).toString("base64")}`,
  );

  const responseFormat = record(body.response_format);
  assert.equal(responseFormat.type, "json_schema");
  const jsonSchema = record(responseFormat.json_schema);
  assert.equal(jsonSchema.strict, true);
  const schema = record(jsonSchema.schema);
  assert.equal(schema.additionalProperties, false);
  const properties = record(schema.properties);
  const entries = record(properties.entries);
  const itemSchema = record(entries.items);
  assert.equal(itemSchema.additionalProperties, false);
});

test("extractEntries accepts an empty candidate list", async (t) => {
  installFetchFixture(t, () => completion(JSON.stringify({ entries: [], warnings: [] })));
  assert.deepEqual(await extractEntries(image(), API_KEY), { entries: [], warnings: [] });
});

test("extractEntries rejects invalid structured output", async (t) => {
  const validEntry = {
    occurredOn: "2026-10-01",
    kind: "expense",
    amountYen: 1,
    description: "文具",
  };
  const invalidOutputs: Array<[string, unknown]> = [
    [
      "invalid calendar date",
      { entries: [{ ...validEntry, occurredOn: "2026-02-30" }], warnings: [] },
    ],
    ["negative amount", { entries: [{ ...validEntry, amountYen: -1 }], warnings: [] }],
    ["zero amount", { entries: [{ ...validEntry, amountYen: 0 }], warnings: [] }],
    [
      "out-of-range amount",
      { entries: [{ ...validEntry, amountYen: 1_000_000_000_000 }], warnings: [] },
    ],
    ["fractional amount", { entries: [{ ...validEntry, amountYen: 1.5 }], warnings: [] }],
    ["too many entries", { entries: Array.from({ length: 51 }, () => validEntry), warnings: [] }],
    ["too many warnings", { entries: [], warnings: Array.from({ length: 21 }, () => "注意") }],
    ["warning too long", { entries: [], warnings: ["注意".repeat(201)] }],
    ["extra root property", { entries: [], warnings: [], unexpected: true }],
    ["extra entry property", { entries: [{ ...validEntry, unexpected: true }], warnings: [] }],
  ];

  for (const [name, output] of invalidOutputs) {
    await t.test(name, async (subtest) => {
      const { requests, error } = await rejectedExtraction(subtest, () =>
        completion(JSON.stringify(output)),
      );
      assert.equal(requests.length, 1);
      assertSanitized(error);
    });
  }
});

test("extractEntries rejects malformed, missing, and truncated output", async (t) => {
  await t.test("malformed JSON", async (subtest) => {
    const { requests, error } = await rejectedExtraction(subtest, () => completion("{"));
    assert.equal(requests.length, 1);
    assertSanitized(error);
  });

  await t.test("missing message content", async (subtest) => {
    const { requests, error } = await rejectedExtraction(subtest, () => completion(undefined));
    assert.equal(requests.length, 1);
    assertSanitized(error);
  });

  await t.test("valid JSON with a length finish reason", async (subtest) => {
    const { requests, error } = await rejectedExtraction(subtest, () =>
      completion(JSON.stringify({ entries: [], warnings: [] }), "length"),
    );
    assert.equal(requests.length, 1);
    assertSanitized(error);
  });
});

test("extractEntries sanitizes provider failures without retrying", async (t) => {
  for (const status of [401, 429, 503]) {
    await t.test(`HTTP ${status}`, async (subtest) => {
      const { requests, error } = await rejectedExtraction(subtest, () =>
        jsonResponse({ error: { message: "fixture-private-provider-detail" } }, status),
      );
      assert.equal(requests.length, 1);
      assertSanitized(error);
    });
  }
});

test("extractEntries classifies an upstream timeout", async (t) => {
  const { requests, error } = await rejectedExtraction(t, () => {
    throw new DOMException("fixture-private-provider-detail", "TimeoutError");
  });
  assert.equal(requests.length, 1);
  assert.ok(error instanceof OpenRouterTimeoutError);
  assertSanitized(error);
});

test("extractEntries sanitizes network failures without retrying", async (t) => {
  const { requests, error } = await rejectedExtraction(t, () => {
    throw new Error("fixture-private-provider-detail");
  });
  assert.equal(requests.length, 1);
  assertSanitized(error);
});

test("extractEntries sanitizes malformed and unreadable HTTP bodies without retrying", async (t) => {
  for (const [name, reply] of [
    [
      "malformed JSON",
      () =>
        new Response("fixture-private-provider-detail", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "unreadable body",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("fixture-private-provider-detail"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
  ] as const) {
    await t.test(name, async (subtest) => {
      const { requests, error } = await rejectedExtraction(subtest, reply);
      assert.equal(requests.length, 1);
      assertSanitized(error);
    });
  }
});

test("extractEntries propagates an aborted request signal as a sanitized timeout without retrying", async (t) => {
  const controller = new AbortController();
  let timeoutMs: number | undefined;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    timeoutMs = milliseconds;
    return controller.signal;
  });

  const { promise: requestStarted, resolve: resolveRequest } =
    Promise.withResolvers<CapturedRequest>();
  const requests = installFetchFixture(t, (request) => {
    const { signal } = request;
    if (!signal) {
      resolveRequest(request);
      return Promise.reject(new Error("missing request signal"));
    }
    const pending = Promise.withResolvers<Response>();
    signal.addEventListener(
      "abort",
      () => pending.reject(new DOMException("fixture-private-provider-detail", "TimeoutError")),
      { once: true },
    );
    resolveRequest(request);
    return pending.promise;
  });
  const outcome = extractEntries(image(), API_KEY).then(
    () => new Error("extractEntries should reject"),
    (error: unknown) => error,
  );

  const request = await requestStarted;
  assert.equal(timeoutMs, 180_000);
  assert.ok(request.signal);
  controller.abort(new DOMException("fixture-private-provider-detail", "TimeoutError"));
  const error = await outcome;

  assert.ok(error instanceof OpenRouterTimeoutError);
  assert.equal(request.signal.aborted, true);
  assert.equal(requests.length, 1);
  assertSanitized(error);
});
