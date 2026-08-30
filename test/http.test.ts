import assert from "node:assert/strict";
import test from "node:test";
import { boundedResponseBody, cancelResponseBody } from "../src/http.js";

test("bounded response cancels a declared oversized body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  }), { headers: { "content-length": "2000001" } });

  await assert.rejects(boundedResponseBody(response, 2_000_000), /size limit/);
  assert.equal(cancelled, true);
});

test("rejected responses are cancelled without draining their bodies", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  }));

  await cancelResponseBody(response);
  assert.equal(cancelled, true);
});
