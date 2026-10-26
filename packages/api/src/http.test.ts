import assert from "node:assert/strict";
import { test } from "node:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { funds } from "@zandaka/db/schema/index";
import type { AppRouterClient } from "./routers/index";
import { fundCreateOutputSchema } from "./routers/funds";
import { createHttpHandler } from "./http";
import { createTestFixture, testMasterKey } from "./test-fixture";

const BODY_LIMIT = 6 * 1024 * 1024;

function oversizedRequest(url: string) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(BODY_LIMIT + 1));
      controller.close();
    },
  });
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function chunkedJsonRequest(
  url: string,
  body: string,
  size: number,
  requestHeaders?: HeadersInit,
): Request {
  const encodedBody = new TextEncoder().encode(body);
  assert.ok(encodedBody.byteLength <= size);
  const bytes = new Uint8Array(size);
  bytes.set(encodedBody);
  bytes.fill(0x20, encodedBody.byteLength);
  const headers = new Headers(requestHeaders);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        controller.enqueue(bytes.subarray(offset, offset + 64 * 1024));
      }
      controller.close();
    },
  });
  return new Request(url, {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function rpcClient(
  handler: (request: Request) => Promise<Response>,
  bodySize: number,
  responseStatuses?: number[],
): AppRouterClient {
  return createORPCClient<AppRouterClient>(
    new RPCLink({
      url: "http://localhost/rpc",
      fetch: async (request) => {
        const streamed = chunkedJsonRequest(
          request.url,
          await request.clone().text(),
          bodySize,
          request.headers,
        );
        assert.equal(streamed.headers.has("content-length"), false);
        const response = await handler(streamed);
        responseStatuses?.push(response.status);
        return response;
      },
    }),
  );
}

test("HTTP accepts exact-limit chunked JSON and rejects one byte over on RPC and OpenAPI", async () => {
  const fixture = await createTestFixture();
  try {
    const handler = createHttpHandler(async () => fixture.context);
    const rpcCreated = await rpcClient(handler, BODY_LIMIT).funds.create({
      masterKey: testMasterKey,
      name: "RPC exact-limit",
      openingBalanceYen: 1000,
    });

    const openApiRequest = chunkedJsonRequest(
      "http://localhost/rpc/api-reference/funds/create",
      JSON.stringify({
        masterKey: testMasterKey,
        name: "OpenAPI exact-limit",
        openingBalanceYen: 2500,
      }),
      BODY_LIMIT,
    );
    assert.equal(openApiRequest.headers.has("content-length"), false);
    const openApiResponse = await handler(openApiRequest);
    assert.equal(openApiResponse.status, 200);
    const openApiCreated = fundCreateOutputSchema.parse(await openApiResponse.json());

    const rpcStatuses: number[] = [];
    await assert.rejects(() =>
      rpcClient(handler, BODY_LIMIT + 1, rpcStatuses).funds.create({
        masterKey: testMasterKey,
        name: "RPC over-limit",
        openingBalanceYen: 3000,
      }),
    );

    const openApiOverflow = await handler(
      chunkedJsonRequest(
        "http://localhost/rpc/api-reference/funds/create",
        JSON.stringify({
          masterKey: testMasterKey,
          name: "OpenAPI over-limit",
          openingBalanceYen: 4000,
        }),
        BODY_LIMIT + 1,
      ),
    );
    assert.equal(openApiOverflow.status, 413);
    assert.deepEqual(rpcStatuses, [413]);

    const persistedFunds = await fixture.db.select().from(funds);
    assert.deepEqual(
      Object.fromEntries(
        persistedFunds.map(({ name, openingBalanceYen }) => [name, openingBalanceYen]),
      ),
      { "RPC exact-limit": 1000, "OpenAPI exact-limit": 2500 },
    );
    assert.ok(rpcCreated.fundId);
    assert.ok(openApiCreated.fundId);
  } finally {
    await fixture.close();
  }
});

test("HTTP factory dispatches RPCLink and flat OpenAPI requests to D1", async () => {
  const fixture = await createTestFixture();
  try {
    const handler = createHttpHandler(async () => fixture.context);
    const client: AppRouterClient = createORPCClient(
      new RPCLink({
        url: "http://localhost/rpc",
        fetch: (request) => handler(request),
      }),
    );

    const rpcCreated = await client.funds.create({
      masterKey: testMasterKey,
      name: "RPC fund",
      openingBalanceYen: 1000,
    });
    assert.match(
      rpcCreated.fundId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(JSON.stringify(rpcCreated).includes(testMasterKey), false);

    const openApiResponse = await handler(
      new Request("http://localhost/rpc/api-reference/funds/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          masterKey: testMasterKey,
          name: "OpenAPI fund",
          openingBalanceYen: 2500,
        }),
      }),
    );
    assert.equal(openApiResponse.status, 200);
    const openApiCreated = fundCreateOutputSchema.parse(await openApiResponse.json());
    assert.match(
      openApiCreated.fundId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.equal(JSON.stringify(openApiCreated).includes(testMasterKey), false);

    assert.equal(
      (await fixture.client.funds.get({ fundId: rpcCreated.fundId })).balanceYen,
      "1000",
    );
    assert.equal(
      (await fixture.client.funds.get({ fundId: openApiCreated.fundId })).balanceYen,
      "2500",
    );
    const unmatched = await handler(new Request("http://localhost/other"));
    assert.equal(unmatched.status, 404);
  } finally {
    await fixture.close();
  }
});

test("HTTP factory rejects streamed oversized bodies without Content-Length on both protocols", async () => {
  const fixture = await createTestFixture();
  try {
    const handler = createHttpHandler(async () => fixture.context);
    const rpcRequest = oversizedRequest("http://localhost/rpc/funds/create");
    const openApiRequest = oversizedRequest("http://localhost/rpc/api-reference/funds/create");
    assert.equal(rpcRequest.headers.has("content-length"), false);
    assert.equal(openApiRequest.headers.has("content-length"), false);

    const [rpcResponse, openApiResponse] = await Promise.all([
      handler(rpcRequest),
      handler(openApiRequest),
    ]);
    assert.equal(rpcResponse.status, 413);
    assert.equal(openApiResponse.status, 413);

    const savedFunds = await fixture.db.select().from(funds);
    assert.deepEqual(savedFunds, []);
  } finally {
    await fixture.close();
  }
});
