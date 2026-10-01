import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { ZcodeProtocolClient, ZcodeProtocolError } from '../src/cli/zcode-protocol-client.js';

type WriteMode = 'ok' | 'syncThrow' | 'asyncReject' | 'hang';

function makeTransport() {
  const frames: string[] = [];
  const state = { mode: 'ok' as WriteMode };
  const write = (frame: string): void | Promise<void> => {
    if (state.mode === 'syncThrow') throw new Error('sync write boom fake-secret');
    if (state.mode === 'asyncReject') return Promise.reject(new Error('async write fail fake-secret'));
    if (state.mode === 'hang') return new Promise<void>(() => {});
    frames.push(frame);
  };
  return { frames, state, write };
}

function makeClient(t: TestContext, options: Record<string, unknown> = {}) {
  const transport = makeTransport();
  const notifications: { method: string; params?: unknown }[] = [];
  const observed: unknown[] = [];
  const reverseCalls: { id: string | number; method: string; params?: unknown }[] = [];
  let reverseHandler: (req: { id: string | number; method: string; params?: unknown }, signal: AbortSignal) => Promise<unknown> =
    async () => ({ ok: true });
  const client = new ZcodeProtocolClient({
    write: transport.write,
    onReverseRequest: (req, signal) => {
      reverseCalls.push(req);
      return reverseHandler(req, signal);
    },
    onNotification: (n) => notifications.push(n),
    observe: (m) => observed.push(m),
    ...options,
  });
  t.after(() => client.dispose());
  return {
    client, transport, notifications, observed, reverseCalls,
    setReverseHandler(handler: typeof reverseHandler) { reverseHandler = handler; },
  };
}

const fixed = (code: number, kind: string) => new ZcodeProtocolError(code, kind as never);

test('request resolves with peer result and writes framed request', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('runtime/capabilities');
  const sent = JSON.parse(ctx.transport.frames[0]);
  assert.equal(sent.method, 'runtime/capabilities');
  ctx.client.push(`${JSON.stringify({ id: sent.id, result: { caps: ['x'] } })}\n`);
  assert.deepEqual(await promise, { caps: ['x'] });
});

test('bidirectional numeric id collision: method frame is reverse, response still resolves', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read', { path: 'a' });
  const id = JSON.parse(ctx.transport.frames[0]).id;
  // 同数字 id 的 reverse request 不得被当作响应
  ctx.client.push(`${JSON.stringify({ id, method: 'session/requestRuntimePreferences', params: {} })}\n`);
  // reverse handler 经 microtask 排队调用，先等一拍再断言。
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.reverseCalls.length, 1);
  ctx.client.push(`${JSON.stringify({ id, result: 'fake-secret-free' })}\n`);
  assert.equal(await promise, 'fake-secret-free');
  const success = JSON.parse(ctx.transport.frames[1]);
  assert.equal(success.id, id);
  assert.deepEqual(success.result, { ok: true });
});

test('bidirectional string id reverse does not confuse pending numeric ids', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id: String(id), method: 'session/requestRuntimePreferences', params: {} })}\n`);
  ctx.client.push(`${JSON.stringify({ id, result: 7 })}\n`);
  assert.equal(await promise, 7);
});

test('official trace keys accepted on reverse request and notification', async (t) => {
  const ctx = makeClient(t);
  ctx.client.push(`${JSON.stringify({
    id: 'r1', method: 'session/requestRuntimePreferences', params: {},
    trace: { traceparent: '00-abc-def-01', traceId: 't', parentId: 'p', spanId: 's' },
  })}\n`);
  ctx.client.push(`${JSON.stringify({ method: 'session/event', params: {}, trace: { traceId: 't2' } })}\n`);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.reverseCalls.length, 1);
  assert.equal(ctx.notifications.length, 1);
  assert.ok(!ctx.client.isClosed());
});

test('unknown trace key closes with fixed error', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/create');
  ctx.client.push(`${JSON.stringify({ id: 9, method: 'session/event', trace: { evil: 'x' } })}\n`);
  await assert.rejects(promise, fixed(-32016, 'frame'));
});

test('empty trace value closes', (t) => {
  const ctx = makeClient(t);
  ctx.client.push(`${JSON.stringify({ method: 'session/event', trace: { traceId: '' } })}\n`);
  assert.ok(ctx.client.isClosed());
});

test('trace on a response closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id, result: 1, trace: { traceId: 't' } })}\n`);
  await assert.rejects(promise, fixed(-32031, 'frame'));
});

test('error response keeps code, fixed text, no leak of message/data', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('provider/updateAccountConfig');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({
    id,
    error: { code: -32050, message: 'leak fake-secret', data: { token: 'fake-secret' } },
  })}\n`);
  const err: ZcodeProtocolError = await promise.then(
    () => assert.fail('should reject'),
    (e) => e,
  );
  assert.equal(err.code, -32050);
  assert.equal(err.message, 'zcode protocol error response');
  assert.ok(!JSON.stringify(err).includes('fake-secret'));
});

test('non-JSON line closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push('not-json\n');
  await assert.rejects(promise, fixed(-32012, 'frame'));
});

test('primitive frame closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push('42\n');
  await assert.rejects(promise, fixed(-32013, 'frame'));
});

test('array frame closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push('[1,2]\n');
  await assert.rejects(promise, fixed(-32013, 'frame'));
});

test('jsonrpc key closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push(`{"jsonrpc":"2.0","id":1,"result":1}\n`);
  await assert.rejects(promise, fixed(-32014, 'frame'));
});

test('top-level extra field closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id, result: 1, extra: 1 })}\n`);
  await assert.rejects(promise, fixed(-32027, 'frame'));
});

test('result and error together closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id, result: 1, error: { code: 1, message: 'x' } })}\n`);
  await assert.rejects(promise, fixed(-32026, 'frame'));
});

test('response missing result and error closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id })}\n`);
  await assert.rejects(promise, fixed(-32030, 'frame'));
});

test('oversized string id closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push(`${JSON.stringify({ id: 'x'.repeat(257), result: 1 })}\n`);
  await assert.rejects(promise, fixed(-32025, 'frame'));
});

test('unsafe integer id closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push(`${JSON.stringify({ id: 2 ** 53, result: 1 })}\n`);
  await assert.rejects(promise, fixed(-32025, 'frame'));
});

test('empty string id closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push(`${JSON.stringify({ id: '', result: 1 })}\n`);
  await assert.rejects(promise, fixed(-32025, 'frame'));
});

test('multibyte UTF-8 split across pushes parses intact', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  const bytes = Buffer.from(`${JSON.stringify({ id, result: '中文payload' })}\n`, 'utf8');
  const split = bytes.indexOf(0xe4);
  ctx.client.push(bytes.subarray(0, split + 1));
  ctx.client.push(bytes.subarray(split + 1));
  assert.equal(await promise, '中文payload');
});

test('EOF tail line without newline delivers response then rejects rest', async (t) => {
  const ctx = makeClient(t);
  const a = ctx.client.request('session/read');
  const b = ctx.client.request('session/stop');
  const idA = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id: idA, result: 'tail' })}`);
  ctx.client.end();
  assert.equal(await a, 'tail');
  await assert.rejects(b, fixed(-32006, 'eof'));
});

test('EOF truncated JSON tail closes with frame error', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push('{"id":1,"res');
  ctx.client.end();
  await assert.rejects(promise, fixed(-32012, 'frame'));
});

test('invalid UTF-8 bytes close', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push(Buffer.from([0xff, 0xfe, 0x0a]));
  await assert.rejects(promise, fixed(-32002, 'frame'));
});

test('single frame budget exceeded closes', async (t) => {
  const ctx = makeClient(t, { limits: { maxFrameBytes: 64 } });
  const promise = ctx.client.request('session/read');
  ctx.client.push(`{"id":1,"result":"${'a'.repeat(200)}"}\n`);
  await assert.rejects(promise, fixed(-32004, 'overflow'));
});

test('cumulative inbound budget exceeded closes', async (t) => {
  const ctx = makeClient(t, { limits: { maxTotalBytes: 64 } });
  const promise = ctx.client.request('session/read');
  // 用 notification 帧累计字节，避免先触发未知响应 id 的关闭。
  ctx.client.push(`${JSON.stringify({ method: 'session/event', params: {} })}\n`);
  ctx.client.push(`${JSON.stringify({ method: 'session/event', params: {} })}\n`);
  await assert.rejects(promise, fixed(-32003, 'overflow'));
});

test('blank lines ignored but counted against budget', async (t) => {
  const ctx = makeClient(t, { limits: { maxTotalBytes: 64 } });
  const promise = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push('\n\n');
  ctx.client.push(`${JSON.stringify({ id, result: 1 })}\n`);
  assert.equal(await promise, 1);
  const ctx2 = makeClient(t, { limits: { maxTotalBytes: 16 } });
  const promise2 = ctx2.client.request('session/read');
  ctx2.client.push('\n'.repeat(20));
  await assert.rejects(promise2, fixed(-32003, 'overflow'));
});

test('pending limit rejects new request without closing', async (t) => {
  const ctx = makeClient(t, { limits: { maxPending: 2 } });
  const a = ctx.client.request('session/read');
  const b = ctx.client.request('session/read');
  try {
    await assert.rejects(ctx.client.request('session/read'), fixed(-32098, 'concurrency'));
    const idA = JSON.parse(ctx.transport.frames[0]).id;
    ctx.client.push(`${JSON.stringify({ id: idA, result: 1 })}\n`);
    assert.equal(await a, 1);
  } finally {
    ctx.client.dispose();
    await b.then(() => assert.fail('reject'), () => undefined);
  }
});

test('reverse concurrency limit closes', async (t) => {
  const ctx = makeClient(t, { limits: { maxReverse: 1 } });
  ctx.setReverseHandler(() => new Promise(() => {}));
  ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  ctx.client.push(`${JSON.stringify({ id: 'r2', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  assert.ok(ctx.client.isClosed());
});

test('unknown reverse method gets fixed -32601, handler not called, no echo', (t) => {
  const ctx = makeClient(t);
  ctx.client.push(`${JSON.stringify({ id: 'r9', method: 'auth/stealToken', params: { token: 'fake-secret' } })}\n`);
  assert.equal(ctx.reverseCalls.length, 0);
  const reply = JSON.parse(ctx.transport.frames[0]);
  assert.equal(reply.error.code, -32601);
  assert.equal(reply.error.message, 'method not found');
  assert.ok(!ctx.transport.frames[0].includes('auth/stealToken'));
  assert.ok(!ctx.transport.frames[0].includes('fake-secret'));
});

test('duplicate in-flight reverse id closes', (t) => {
  const ctx = makeClient(t);
  ctx.setReverseHandler(() => new Promise(() => {}));
  ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  assert.ok(ctx.client.isClosed());
});

test('reverse result goes to wire but not observer', async (t) => {
  const ctx = makeClient(t);
  ctx.setReverseHandler(async () => ({ token: 'fake-secret' }));
  ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'interaction/requestProviderRuntimeHeaders', params: { auth: 'fake-secret' } })}\n`);
  await new Promise((r) => setImmediate(r));
  const reply = JSON.parse(ctx.transport.frames[0]);
  assert.equal(reply.result.token, 'fake-secret');
  assert.ok(!JSON.stringify(ctx.observed).includes('fake-secret'));
});

test('reverse handler failure yields fixed -32603 without leaking cause', async (t) => {
  const ctx = makeClient(t);
  const boom = Object.assign(new Error('handler leaked fake-secret'), { cause: 'fake-secret' });
  ctx.setReverseHandler(async () => { throw boom; });
  ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  await new Promise((r) => setImmediate(r));
  const reply = JSON.parse(ctx.transport.frames[0]);
  assert.equal(reply.error.code, -32603);
  assert.equal(reply.error.message, 'internal error');
  assert.ok(!ctx.transport.frames[0].includes('fake-secret'));
});

test('nested request inside reverse handler does not deadlock', async (t) => {
  const ctx = makeClient(t);
  ctx.setReverseHandler(async (req) => {
    const value = await ctx.client.request('session/read', { ref: req.id });
    return { nested: value };
  });
  ctx.client.push(`${JSON.stringify({ id: 'rev', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  await new Promise((r) => setImmediate(r));
  const outbound = JSON.parse(ctx.transport.frames[0]);
  assert.equal(outbound.method, 'session/read');
  ctx.client.push(`${JSON.stringify({ id: outbound.id, result: 'read-ok' })}\n`);
  await new Promise((r) => setImmediate(r));
  const reply = JSON.parse(ctx.transport.frames[1]);
  assert.deepEqual(reply.result, { nested: 'read-ok' });
});

test('unknown response id closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.push(`${JSON.stringify({ id: 999, result: 1 })}\n`);
  await assert.rejects(promise, fixed(-32033, 'frame'));
});

test('duplicate response hits tombstone and is ignored, client stays usable', async (t) => {
  const ctx = makeClient(t);
  const a = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id, result: 1 })}\n`);
  assert.equal(await a, 1);
  ctx.client.push(`${JSON.stringify({ id, result: 2 })}\n`);
  const b = ctx.client.request('session/read');
  const idB = JSON.parse(ctx.transport.frames[1]).id;
  ctx.client.push(`${JSON.stringify({ id: idB, result: 3 })}\n`);
  assert.equal(await b, 3);
  assert.ok(!ctx.client.isClosed());
});

test('expired tombstone means unknown id and closes', async (t) => {
  let clock = 1000;
  const ctx = makeClient(t, { now: () => clock, limits: { tombstoneTtlMs: 60_000 } });
  const a = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id, result: 1 })}\n`);
  assert.equal(await a, 1);
  clock += 60_001;
  const b = ctx.client.request('session/read');
  ctx.client.push(`${JSON.stringify({ id, result: 2 })}\n`);
  await assert.rejects(b, fixed(-32032, 'frame'));
});

test('tombstone capacity eviction turns late response into unknown id', async (t) => {
  const ctx = makeClient(t, { limits: { maxTombstones: 1 } });
  const a = ctx.client.request('session/read');
  const idA = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id: idA, result: 1 })}\n`);
  assert.equal(await a, 1);
  const b = ctx.client.request('session/read');
  const idB = JSON.parse(ctx.transport.frames[1]).id;
  ctx.client.push(`${JSON.stringify({ id: idB, result: 2 })}\n`);
  assert.equal(await b, 2);
  ctx.client.push(`${JSON.stringify({ id: idA, result: 3 })}\n`);
  assert.ok(ctx.client.isClosed());
});

test('request timeout rejects with fixed error, clears timer and seals connection', async (t) => {
  const ctx = makeClient(t, { requestTimeoutMs: 20 });
  const err: ZcodeProtocolError = await ctx.client.request('session/read').then(
    () => assert.fail('should reject'),
    (e) => e,
  );
  assert.equal(err.message, 'zcode protocol request timeout');
  assert.equal(err.code, -32001);
  // 合同：单 RPC 超时后连接封口，不再编造继续使用。
  assert.ok(ctx.client.isClosed());
});

test('per-request abort rejects and removes listener', async (t) => {
  const ctx = makeClient(t);
  const controller = new AbortController();
  const promise = ctx.client.request('session/read', undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, fixed(-32000, 'aborted'));
  const count = getEventListeners(controller.signal, 'abort').length;
  assert.ok(count <= 1);
});

test('constructor signal abort closes everything and listener is removed', async (t) => {
  const controller = new AbortController();
  const ctx = makeClient(t, { signal: controller.signal });
  const promise = ctx.client.request('session/read');
  controller.abort();
  await assert.rejects(promise, fixed(-32008, 'disposed'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('dispose is idempotent and seals the wire for late reverse replies', async (t) => {
  const ctx = makeClient(t);
  let resolveReverse: (v: unknown) => void = () => {};
  ctx.setReverseHandler(() => new Promise((r) => { resolveReverse = r; }));
  ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  const promise = ctx.client.request('session/read');
  const framesBefore = ctx.transport.frames.length;
  ctx.client.dispose();
  ctx.client.dispose();
  await assert.rejects(promise, fixed(-32008, 'disposed'));
  resolveReverse({ token: 'fake-secret' });
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.transport.frames.length, framesBefore);
  ctx.client.push('{"id":1,"result":1}\n');
  assert.ok(ctx.client.isClosed());
});

test('synchronous write throw rejects all pending with fixed transport error', async (t) => {
  const ctx = makeClient(t);
  const a = ctx.client.request('session/read');
  const b = ctx.client.request('session/stop');
  ctx.transport.state.mode = 'syncThrow';
  // 未知 reverse 方法触发一次同步写（-32601 回复），write 抛错必须关闭所有等待
  ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'auth/stealToken' })}\n`);
  for (const p of [a, b]) {
    const err: ZcodeProtocolError = await p.then(() => assert.fail('reject'), (e) => e);
    assert.equal(err.message, 'zcode protocol transport failure');
    assert.ok(!err.message.includes('fake-secret'));
  }
});

test('async write rejection rejects all pending with fixed transport error', async (t) => {
  const ctx = makeClient(t);
  const promiseA = ctx.client.request('session/read');
  ctx.transport.state.mode = 'asyncReject';
  const promiseB = ctx.client.request('session/stop');
  await assert.rejects(promiseA, fixed(-32011, 'transport'));
  await assert.rejects(promiseB, fixed(-32011, 'transport'));
});

test('transportFailed rejects pending', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.transportFailed();
  await assert.rejects(promise, fixed(-32007, 'transport'));
});

test('end() rejects pending with fixed EOF error', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  ctx.client.end();
  await assert.rejects(promise, fixed(-32006, 'eof'));
});

test('allowlisted notifications reach handler; others are ignored silently', (t) => {
  const ctx = makeClient(t);
  ctx.client.push(`${JSON.stringify({ method: 'session/event', params: { kind: 'turn' } })}\n`);
  ctx.client.push(`${JSON.stringify({ method: 'interaction/providerRuntimeHeadersCancelled', params: {} })}\n`);
  ctx.client.push(`${JSON.stringify({ method: 'debug/unknownNotify', params: {} })}\n`);
  assert.deepEqual(ctx.notifications.map((n) => n.method), [
    'session/event',
    'interaction/providerRuntimeHeadersCancelled',
  ]);
  assert.ok(!JSON.stringify(ctx.observed).includes('debug/unknownNotify'));
  assert.ok(!ctx.client.isClosed());
});

test('notification handler failure closes with fixed error, no leak', async (t) => {
  const ctx = makeClient(t, { onNotification: () => { throw new Error('notify leak fake-secret'); } });
  const promise = ctx.client.request('session/read');
  ctx.client.push(`${JSON.stringify({ method: 'session/event', params: {} })}\n`);
  await assert.rejects(promise, fixed(-32020, 'frame'));
});

test('non-allowlisted forward method is rejected without sending', async (t) => {
  const ctx = makeClient(t);
  await assert.rejects(
    ctx.client.request('session/evil' as never, {}),
    fixed(-32601, 'frame'),
  );
  assert.equal(ctx.transport.frames.length, 0);
});

test('observer throwing closes with fixed error', async (t) => {
  const ctx = makeClient(t, { observe: () => { throw new Error('observer fake-secret'); } });
  const promise = ctx.client.request('session/read');
  await assert.rejects(promise, fixed(-32009, 'observer'));
});

test('unencodable outbound params rejected without write', async (t) => {
  const ctx = makeClient(t);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(ctx.client.request('session/send', circular), fixed(-32097, 'encode'));
  assert.equal(ctx.transport.frames.length, 0);
});

test('observer never sees frames, params, results or traces', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read', { secret: 'fake-secret' });
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id, result: 'fake-secret' })}\n`);
  await promise;
  const text = JSON.stringify(ctx.observed);
  assert.ok(!text.includes('fake-secret'));
  assert.ok(!text.includes('trace'));
  const first = ctx.observed[0] as Record<string, unknown>;
  assert.equal(first.direction, 'outbound');
  assert.equal(first.method, 'session/read');
});

test('error code surfaced in observer only as safe integer', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id, error: { code: -32603, message: 'm' } })}\n`);
  await promise.then(() => assert.fail('reject'), () => undefined);
  const inbound = ctx.observed.find(
    (m) => (m as Record<string, unknown>).category === 'response',
  ) as Record<string, unknown>;
  assert.equal(inbound.errorCode, -32603);
  assert.ok(Number.isSafeInteger(inbound.errorCode));
});

// ---- 236：生命周期与预算修复的独立回放场景 ----

test('already-aborted request signal rejects before any write', async (t) => {
  const ctx = makeClient(t);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      ctx.client.request('session/read', undefined, { signal: controller.signal }),
      fixed(-32000, 'aborted'),
    );
    assert.equal(ctx.transport.frames.length, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    ctx.client.dispose();
  }
});

test('two legal frames merged into one chunk parse when each fits budget', async (t) => {
  const ctx = makeClient(t, { limits: { maxFrameBytes: 100 } });
  try {
    const a = ctx.client.request('session/read');
    const b = ctx.client.request('session/stop');
    const idA = JSON.parse(ctx.transport.frames[0]).id;
    const idB = JSON.parse(ctx.transport.frames[1]).id;
    const frameA = `${JSON.stringify({ id: idA, result: 'a'.repeat(40) })}\n`;
    const frameB = `${JSON.stringify({ id: idB, result: 'b'.repeat(40) })}\n`;
    assert.ok(Buffer.byteLength(frameA, 'utf8') < 100 && Buffer.byteLength(frameB, 'utf8') < 100);
    assert.ok(Buffer.byteLength(frameA + frameB, 'utf8') > 100);
    ctx.client.push(frameA + frameB);
    assert.equal(await a, 'a'.repeat(40));
    assert.equal(await b, 'b'.repeat(40));
    assert.ok(!ctx.client.isClosed());
  } finally {
    ctx.client.dispose();
  }
});

test('observer throwing on outbound request prevents any write', async (t) => {
  const ctx = makeClient(t, { observe: () => { throw new Error('observer boom fake-secret'); } });
  try {
    await assert.rejects(ctx.client.request('session/read'), fixed(-32009, 'observer'));
    assert.equal(ctx.transport.frames.length, 0);
  } finally {
    ctx.client.dispose();
  }
});

test('dispose inside reverse-response observer writes no auth frame', async (t) => {
  const transport = makeTransport();
  const client = new ZcodeProtocolClient({
    write: transport.write,
    onReverseRequest: async () => ({ token: 'fake-secret' }),
    observe: (meta) => {
      if (meta.category === 'reverse-response') client.dispose();
    },
  });
  t.after(() => client.dispose());
  try {
    client.push(`${JSON.stringify({ id: 'r1', method: 'interaction/requestProviderRuntimeHeaders', params: {} })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.equal(transport.frames.length, 0);
    assert.ok(client.isClosed());
  } finally {
    client.dispose();
  }
});

test('synchronous reverse handler throw yields fixed -32603 without leak', async (t) => {
  const ctx = makeClient(t);
  ctx.setReverseHandler(() => { throw new Error('sync handler leak fake-secret'); });
  try {
    ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.transport.frames.length, 1);
    const reply = JSON.parse(ctx.transport.frames[0]);
    assert.equal(reply.error.code, -32603);
    assert.ok(!ctx.transport.frames[0].includes('fake-secret'));
  } finally {
    ctx.client.dispose();
  }
});

test('oversized reverse result closes with zero writes', async (t) => {
  const ctx = makeClient(t, { limits: { maxFrameBytes: 128 } });
  ctx.setReverseHandler(async () => ({ blob: 'x'.repeat(500) }));
  try {
    ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.transport.frames.length, 0);
    assert.ok(ctx.client.isClosed());
  } finally {
    ctx.client.dispose();
  }
});

test('one RPC timeout rejects the other pending and aborts auth handler signal', async (t) => {
  const ctx = makeClient(t);
  let authSignal: AbortSignal | undefined;
  ctx.setReverseHandler((_req, signal) => {
    authSignal = signal;
    return new Promise(() => {});
  });
  const slow = ctx.client.request('session/read', undefined, { timeoutMs: 10 });
  const other = ctx.client.request('session/stop');
  ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  const errSlow = await slow.then(() => assert.fail('reject'), (e) => e);
  const errOther = await other.then(() => assert.fail('reject'), (e) => e);
  assert.equal(errSlow.message, 'zcode protocol request timeout');
  assert.equal(errOther.message, 'zcode protocol request timeout');
  assert.ok(authSignal?.aborted);
  assert.ok(ctx.client.isClosed());
});

test('NaN/Infinity/zero and over-cap limits rejected with fixed error', (t) => {
  const bad: Record<string, unknown>[] = [
    { maxFrameBytes: 0 }, { maxFrameBytes: NaN }, { maxFrameBytes: Infinity },
    { maxTotalBytes: -1 }, { maxPending: 0 }, { maxReverse: NaN },
    { maxTombstones: Infinity }, { tombstoneTtlMs: 0 }, { tombstoneTtlMs: 60_001 },
    { maxFrameBytes: 2 * 1024 * 1024 + 1 }, { maxTotalBytes: 32 * 1024 * 1024 + 1 },
    { maxPending: 129 }, { maxReverse: 9 }, { maxTombstones: 129 },
  ];
  for (const limits of bad) {
    assert.throws(
      () => new ZcodeProtocolClient({
        write: () => undefined,
        onReverseRequest: async () => undefined,
        limits: limits as never,
      }),
      fixed(-32100, 'limits'),
      `expected rejection for ${JSON.stringify(limits)}`,
    );
  }
  // 缺省/undefined 字段落回默认值，不拒绝。
  new ZcodeProtocolClient({
    write: () => undefined,
    onReverseRequest: async () => undefined,
    limits: { maxPending: undefined },
  }).dispose();
});

test('invalid requestTimeoutMs config rejected', (t) => {
  for (const requestTimeoutMs of [0, -5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(
      () => new ZcodeProtocolClient({
        write: () => undefined,
        onReverseRequest: async () => undefined,
        requestTimeoutMs,
      }),
      fixed(-32100, 'limits'),
    );
  }
});

test('invalid per-request timeoutMs rejected without write', async (t) => {
  const ctx = makeClient(t);
  try {
    for (const timeoutMs of [0, -5, NaN, Infinity, 2_147_483_648]) {
      await assert.rejects(
        ctx.client.request('session/read', undefined, { timeoutMs }),
        fixed(-32100, 'limits'),
      );
    }
    assert.equal(ctx.transport.frames.length, 0);
    assert.ok(!ctx.client.isClosed());
  } finally {
    ctx.client.dispose();
  }
});

test('known reverse missing params closes without calling handler', (t) => {
  const ctx = makeClient(t);
  try {
    ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'interaction/requestProviderRuntimeHeaders' })}\n`);
    assert.equal(ctx.reverseCalls.length, 0);
    assert.ok(ctx.client.isClosed());
  } finally {
    ctx.client.dispose();
  }
});

test('unknown notification with array or primitive params is ignored, not closed', (t) => {
  const ctx = makeClient(t);
  try {
    ctx.client.push(`${JSON.stringify({ method: 'debug/unknownNotify', params: [1, 2] })}\n`);
    ctx.client.push(`${JSON.stringify({ method: 'debug/other', params: 'primitive' })}\n`);
    assert.equal(ctx.notifications.length, 0);
    assert.ok(!ctx.client.isClosed());
  } finally {
    ctx.client.dispose();
  }
});

test('undefined reverse result closes without malformed frame', async (t) => {
  const ctx = makeClient(t);
  ctx.setReverseHandler(async () => undefined);
  try {
    ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.transport.frames.length, 0);
    assert.ok(ctx.client.isClosed());
  } finally {
    ctx.client.dispose();
  }
});

test('error object with extra keys closes', async (t) => {
  const ctx = makeClient(t);
  const promise = ctx.client.request('session/read');
  const id = JSON.parse(ctx.transport.frames[0]).id;
  ctx.client.push(`${JSON.stringify({ id, error: { code: 1, message: 'x', extra: true } })}\n`);
  await assert.rejects(promise, fixed(-32034, 'frame'));
});

test('numeric 1 and string "1" are distinct typed pending ids, both directions', async (t) => {
  // 数字 1 与字符串 '1' 是不同协议 ID：可同时 pending 并各自独立应答。
  const idsOne: (string | number)[] = [1, '1'];
  const ctxA = makeClient(t, { idFactory: () => idsOne.shift() as string | number });
  const a = ctxA.client.request('session/read');
  const b = ctxA.client.request('session/stop');
  assert.equal(JSON.parse(ctxA.transport.frames[0]).id, 1);
  assert.equal(JSON.parse(ctxA.transport.frames[1]).id, '1');
  assert.ok(!ctxA.client.isClosed());
  ctxA.client.push(`${JSON.stringify({ id: 1, result: 'num' })}\n`);
  ctxA.client.push(`${JSON.stringify({ id: '1', result: 'str' })}\n`);
  assert.equal(await a, 'num');
  assert.equal(await b, 'str');
  assert.ok(!ctxA.client.isClosed());
  // 反向顺序同理：字符串 '1' pending 后，数字 1 仍可独立登记。
  const idsTwo: (string | number)[] = ['1', 1];
  const ctxB = makeClient(t, { idFactory: () => idsTwo.shift() as string | number });
  const c = ctxB.client.request('session/read');
  const d = ctxB.client.request('session/stop');
  ctxB.client.push(`${JSON.stringify({ id: 1, result: 'num2' })}\n`);
  ctxB.client.push(`${JSON.stringify({ id: '1', result: 'str2' })}\n`);
  assert.equal(await c, 'str2');
  assert.equal(await d, 'num2');
  assert.ok(!ctxB.client.isClosed());
});

test('invalid or tombstone-colliding idFactory closes', async (t) => {
  const ctx = makeClient(t, { idFactory: () => '' });
  try {
    await assert.rejects(ctx.client.request('session/read'), fixed(-32101, 'id'));
    assert.ok(ctx.client.isClosed());
  } finally {
    ctx.client.dispose();
  }
  let next = 0;
  const ctx2 = makeClient(t, { idFactory: () => next++ });
  try {
    const a = ctx2.client.request('session/read');
    const id = JSON.parse(ctx2.transport.frames[0]).id;
    ctx2.client.push(`${JSON.stringify({ id, result: 1 })}\n`);
    assert.equal(await a, 1);
    next = id; // 重用已 tombstone 的 ID
    await assert.rejects(ctx2.client.request('session/read'), fixed(-32101, 'id'));
    assert.ok(ctx2.client.isClosed());
  } finally {
    ctx2.client.dispose();
  }
});

test('dispose inside reverse-request observer prevents handler call', (t) => {
  const transport = makeTransport();
  let called = false;
  const client = new ZcodeProtocolClient({
    write: transport.write,
    onReverseRequest: async () => {
      called = true;
      return { ok: true };
    },
    observe: (meta) => {
      if (meta.category === 'reverse-request') client.dispose();
    },
  });
  t.after(() => client.dispose());
  try {
    client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
    assert.ok(!called);
    assert.equal(transport.frames.length, 0);
    assert.ok(client.isClosed());
  } finally {
    client.dispose();
  }
});

test('late write rejection after dispose causes no unhandled rejection', async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  const ctx = makeClient(t);
  try {
    const promise = ctx.client.request('session/read');
    ctx.transport.state.mode = 'asyncReject';
    const framesBefore = ctx.transport.frames.length;
    ctx.client.dispose();
    await promise.then(() => assert.fail('reject'), () => undefined);
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.transport.frames.length, framesBefore);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    ctx.client.dispose();
  }
});

test('sync and async handler failures leave no unhandled rejection', async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  const ctx = makeClient(t);
  ctx.setReverseHandler(() => { throw new Error('sync boom'); });
  try {
    ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
    ctx.setReverseHandler(() => Promise.reject(new Error('async boom')));
    ctx.client.push(`${JSON.stringify({ id: 'r2', method: 'session/requestRuntimePreferences', params: {} })}\n`);
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.transport.frames.length, 2);
    for (const frame of ctx.transport.frames) {
      assert.equal(JSON.parse(frame).error.code, -32603);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    ctx.client.dispose();
  }
});

test('all abort listeners removed across constructor and request signals', async (t) => {
  const constructorController = new AbortController();
  const ctx = makeClient(t, { signal: constructorController.signal });
  const requestController = new AbortController();
  const promise = ctx.client.request('session/read', undefined, {
    signal: requestController.signal,
    timeoutMs: 50,
  });
  assert.equal(getEventListeners(requestController.signal, 'abort').length, 1);
  assert.equal(getEventListeners(constructorController.signal, 'abort').length, 1);
  requestController.abort();
  await promise.then(() => assert.fail('reject'), () => undefined);
  assert.equal(getEventListeners(requestController.signal, 'abort').length, 0);
  assert.equal(getEventListeners(constructorController.signal, 'abort').length, 0);
});

// ---- 238/239：typed ID、排队 reverse 与出站形态的独立边界 ----

test('pre-aborted request signal seals client and fails other pending too', async (t) => {
  const ctx = makeClient(t);
  const other = ctx.client.request('session/read');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ctx.client.request('session/stop', undefined, { signal: controller.signal }),
    fixed(-32000, 'aborted'),
  );
  // 预先 abort 必须封口：其他 pending 不应保留活跃等待。
  await assert.rejects(other, fixed(-32000, 'aborted'));
  assert.equal(ctx.transport.frames.length, 1);
  assert.ok(ctx.client.isClosed());
});

test('abort inside idFactory or params.toJSON writes nothing and seals', async (t) => {
  const ctx = makeClient(t);
  const controller = new AbortController();
  const params = {
    toJSON: () => {
      controller.abort();
      return { a: 1 };
    },
  };
  await assert.rejects(
    ctx.client.request('session/send', params, { signal: controller.signal }),
    fixed(-32000, 'aborted'),
  );
  assert.equal(ctx.transport.frames.length, 0);
  assert.ok(ctx.client.isClosed());
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);

  const controller2 = new AbortController();
  const ctx2 = makeClient(t, {
    idFactory: () => {
      controller2.abort();
      return 5;
    },
  });
  await assert.rejects(
    ctx2.client.request('session/read', undefined, { signal: controller2.signal }),
    fixed(-32000, 'aborted'),
  );
  assert.equal(ctx2.transport.frames.length, 0);
  assert.ok(ctx2.client.isClosed());
});

test('reverse queued behind same-tick dispose or end never invokes handler', async (t) => {
  let calls = 0;
  const transport = makeTransport();
  const client = new ZcodeProtocolClient({
    write: transport.write,
    onReverseRequest: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  t.after(() => client.dispose());
  client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  client.dispose();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0);
  assert.equal(transport.frames.length, 0);

  const transport2 = makeTransport();
  const client2 = new ZcodeProtocolClient({
    write: transport2.write,
    onReverseRequest: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  t.after(() => client2.dispose());
  client2.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  client2.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0);
  assert.equal(transport2.frames.length, 0);
  assert.ok(client2.isClosed());
});

test('function or toJSON-omitted reverse result closes with zero writes', async (t) => {
  const ctx = makeClient(t);
  ctx.setReverseHandler(() => Promise.resolve({ toJSON: () => undefined }));
  ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.transport.frames.length, 0);
  assert.ok(ctx.client.isClosed());

  const ctx2 = makeClient(t);
  ctx2.setReverseHandler(async () => (() => 'hidden') as unknown as unknown);
  ctx2.client.push(`${JSON.stringify({ id: 'r1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx2.transport.frames.length, 0);
  assert.ok(ctx2.client.isClosed());
});

test('true string id bidirectional with nested request stays independent', async (t) => {
  const ids: (string | number)[] = ['s1'];
  const ctx = makeClient(t, { idFactory: () => (ids.length > 0 ? ids.shift() as string | number : 2) });
  let reverseSawId: unknown;
  ctx.setReverseHandler(async (req) => {
    reverseSawId = req.id;
    const value = await ctx.client.request('session/read', { ref: req.id });
    return { nested: value };
  });
  const forward = ctx.client.request('session/read');
  assert.equal(JSON.parse(ctx.transport.frames[0]).id, 's1');
  // 同 typed 字符串 's1' 的 reverse request 与 forward pending 相互独立。
  ctx.client.push(`${JSON.stringify({ id: 's1', method: 'session/requestRuntimePreferences', params: {} })}\n`);
  await new Promise((r) => setImmediate(r));
  assert.equal(reverseSawId, 's1');
  const outbound = JSON.parse(ctx.transport.frames[1]);
  assert.equal(outbound.method, 'session/read');
  assert.equal(typeof outbound.id, 'number');
  ctx.client.push(`${JSON.stringify({ id: outbound.id, result: 'read-ok' })}\n`);
  await new Promise((r) => setImmediate(r));
  const reply = JSON.parse(ctx.transport.frames[2]);
  assert.equal(reply.id, 's1');
  assert.deepEqual(reply.result, { nested: 'read-ok' });
  // forward pending 的字符串 's1' 仍可独立应答，不被 reverse 干扰。
  ctx.client.push(`${JSON.stringify({ id: 's1', result: 'forward-ok' })}\n`);
  assert.equal(await forward, 'forward-ok');
  assert.ok(!ctx.client.isClosed());
});

test('same-typed idFactory duplicate rejected; expired tombstone id reusable', async (t) => {
  // 完全同 typed（数字 7）重复：第二个拒绝并封口。
  const ctx = makeClient(t, { idFactory: () => 7 });
  const a = ctx.client.request('session/read');
  await assert.rejects(ctx.client.request('session/stop'), fixed(-32101, 'id'));
  await assert.rejects(a, fixed(-32101, 'id'));
  assert.ok(ctx.client.isClosed());
  assert.equal(ctx.transport.frames.length, 1);

  // tombstone 过期后同 typed ID 可重用。
  let clock = 1000;
  let next = 7;
  const ctx2 = makeClient(t, {
    now: () => clock,
    idFactory: () => next,
    limits: { tombstoneTtlMs: 60_000 },
  });
  const b = ctx2.client.request('session/read');
  ctx2.client.push(`${JSON.stringify({ id: 7, result: 1 })}\n`);
  assert.equal(await b, 1);
  clock += 60_001;
  const c = ctx2.client.request('session/read');
  ctx2.client.push(`${JSON.stringify({ id: 7, result: 2 })}\n`);
  assert.equal(await c, 2);
  assert.ok(!ctx2.client.isClosed());
});

test('reverse chain internal throw seals client and rejects pending with fixed -32035', async (t) => {
  // 故障注入：仅在链尾 finishReverse 删除 AbortController 时抛出，
  // 触发 .catch 分支的 failAll(-32035)。全程 finally 恢复原型，不并行污染。
  const originalDelete = Set.prototype.delete;
  let armed = true;
  Set.prototype.delete = function deleted(this: Set<unknown>, value: unknown) {
    if (armed && value instanceof AbortController) {
      armed = false;
      throw new Error('fake-review-secret');
    }
    return originalDelete.call(this, value);
  } as typeof Set.prototype.delete;
  try {
    const ctx = makeClient(t);
    let authSignal: AbortSignal | undefined;
    ctx.setReverseHandler(async (_req, signal) => {
      authSignal = signal;
      return null;
    });
    const pending = ctx.client.request('session/read', { path: 'a' });
    ctx.client.push(`${JSON.stringify({ id: 'r1', method: 'interaction/requestProviderRuntimeHeaders', params: {} })}\n`);
    let caught: unknown;
    await assert.rejects(
      pending,
      (error: unknown) => {
        caught = error;
        return error instanceof ZcodeProtocolError && error.code === -32035;
      },
    );
    const err = caught as ZcodeProtocolError;
    assert.equal(err.message, 'zcode protocol reverse handler failure');
    assert.ok(!err.message.includes('fake-secret'));
    assert.ok(ctx.client.isClosed());
    assert.ok(authSignal?.aborted);
  } finally {
    Set.prototype.delete = originalDelete;
  }
});
