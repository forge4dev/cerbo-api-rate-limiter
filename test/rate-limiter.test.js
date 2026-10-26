import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRateLimiter } from '../src/rate-limiter.js';
import { createApp } from '../src/app.js';
import { validateConfig } from '../src/config.js';

const limit = (capacity, refillPeriodSeconds = 60) => ({ capacity, refillPeriodSeconds });
function fixture() {
  return {
    tiers: { standard: limit(10), premium: limit(50) },
    organizations: { a: { tier: 'standard' }, b: { tier: 'standard' }, p: { tier: 'premium' }, custom: { tier: 'standard', limit: limit(2) } },
    endpoints: [
      { id: 'read', method: 'GET', path: '/items', limit: limit(10) },
      { id: 'write', method: 'POST', path: '/items', limit: limit(2) },
      { id: 'other', method: 'POST', path: '/other', limit: limit(10) }
    ],
    fallbacks: { read: limit(10), write: limit(5) }
  };
}
function setup(config = fixture()) {
  let now = 0;
  const limiter = createRateLimiter(config, { clock: () => now });
  return { ...limiter, advance: ms => { now += ms; } };
}
const tokens = (limiter, ...key) => limiter.snapshot().find(b => JSON.stringify(b.key) === JSON.stringify(key))?.tokens;

async function serve(t, config, clock = () => 0) {
  const { app, limiter } = createApp(config, { clock });
  const handled = [];
  // Existing handlers do not call next. Track whether application logic emitted a success.
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const request = async (path, { method = 'POST', org = 'a' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: org === null ? {} : { 'X-Org-Id': org }
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (response.ok) handled.push(path);
    return { status: response.status, body, retryAfter: response.headers.get('retry-after') };
  };
  return { request, limiter, handled };
}

test('URL aliases share the configured endpoint bucket through actual Express routing', async t => {
  const config = fixture();
  config.tiers.standard = limit(100);
  config.fallbacks.write = limit(10);
  const { request, limiter, handled } = await serve(t, config);
  assert.equal((await request('/items')).status, 201);
  assert.equal((await request('/items')).status, 201);
  for (const path of ['/items/', '/ITEMS', '/ItEmS/', '/items?sync=1']) {
    const result = await request(path);
    assert.equal(result.status, 429, path);
    assert.deepEqual(result.body.limits.map(l => [l.scope, l.id]), [['endpoint', 'write']]);
    assert.equal(result.retryAfter, '30');
  }
  assert.equal(handled.length, 2);
  assert.equal(limiter.snapshot().some(b => b.key[1] === 'fallback'), false);
});

test('endpoint rejection consumes neither bucket and leaves other endpoints available', async t => {
  const config = fixture();
  config.tiers.standard = limit(3);
  config.endpoints[1].limit = limit(1);
  const { request, limiter, handled } = await serve(t, config);
  assert.equal((await request('/items')).status, 201);
  const before = limiter.snapshot();
  for (let i = 0; i < 3; i++) {
    const response = await request('/items');
    assert.equal(response.status, 429);
    assert.deepEqual(response.body.limits.map(l => l.scope), ['endpoint']);
    assert.deepEqual(limiter.snapshot(), before);
  }
  assert.equal(tokens(limiter, 'a', 'organization'), 2);
  assert.equal(tokens(limiter, 'a', 'endpoint', 'write'), 0);
  assert.equal((await request('/items', { method: 'GET' })).status, 200);
  assert.equal((await request('/items', { method: 'GET' })).status, 200);
  assert.equal(handled.length, 3);
  assert.equal((await request('/items', { org: 'b' })).status, 201);
});

test('organization rejection preserves endpoint balances, including other endpoints', async t => {
  const config = fixture();
  config.tiers.standard = limit(1);
  config.endpoints[1].limit = limit(3);
  config.endpoints[0].limit = limit(3);
  const { request, limiter, handled } = await serve(t, config);
  assert.equal((await request('/items')).status, 201);
  for (const method of ['POST', 'GET', 'POST', 'GET']) {
    const response = await request('/items', { method });
    assert.equal(response.status, 429);
    assert.deepEqual(response.body.limits.map(l => l.scope), ['organization']);
    assert.equal(tokens(limiter, 'a', 'organization'), 0);
    assert.equal(tokens(limiter, 'a', 'endpoint', 'write'), 2);
  }
  assert.equal(tokens(limiter, 'a', 'endpoint', 'read'), 3);
  assert.equal(handled.length, 1);
  assert.equal((await request('/items', { org: 'b' })).status, 201);
});

test('tiers, organization overrides, and organization isolation', () => {
  const l = setup();
  for (let i = 0; i < 10; i++) assert(l.check('a', 'GET', '/items').allowed);
  assert.equal(l.check('a', 'GET', '/unknown').allowed, false);
  assert(l.check('b', 'GET', '/items').allowed);
  assert.equal(tokens(l, 'p', 'organization'), undefined);
  assert(l.check('p', 'GET', '/items').allowed);
  assert.equal(tokens(l, 'p', 'organization'), 49);
  assert(l.check('custom', 'GET', '/items').allowed);
  assert(l.check('custom', 'GET', '/items').allowed);
  assert.equal(l.check('custom', 'GET', '/items').allowed, false);
});

test('write endpoint exhausts sooner; reads and other writes retain separate tokens', () => {
  const l = setup();
  assert(l.check('a', 'POST', '/items').allowed);
  assert(l.check('a', 'POST', '/items').allowed);
  assert.equal(l.check('a', 'POST', '/items').allowed, false);
  assert(l.check('a', 'GET', '/items').allowed);
  assert(l.check('a', 'POST', '/other').allowed);
});

test('organization limit applies across endpoints', () => {
  const config = fixture();
  config.tiers.standard = limit(2);
  const l = setup(config);
  assert(l.check('a', 'POST', '/items').allowed);
  assert(l.check('a', 'GET', '/items').allowed);
  assert.deepEqual(l.check('a', 'POST', '/other').limits.map(v => v.scope), ['organization']);
});

test('both exhausted limits are reported and Retry-After uses the longest rounded delay', () => {
  const config = fixture();
  config.tiers.standard = limit(1, 7.2);
  config.endpoints[1].limit = limit(1, 3.1);
  const l = setup(config);
  l.check('a', 'POST', '/items');
  const result = l.check('a', 'POST', '/items');
  assert.deepEqual(result.limits.map(v => v.scope), ['organization', 'endpoint']);
  assert.equal(result.retryAfterSeconds, 8);
  l.advance(7_199);
  assert.equal(l.check('a', 'POST', '/items').retryAfterSeconds, 1);
  l.advance(1);
  assert(l.check('a', 'POST', '/items').allowed);
});

test('continuous refill permits recovery and caps idle balances at capacity', () => {
  const l = setup();
  l.check('a', 'POST', '/items');
  l.check('a', 'POST', '/items');
  l.advance(15_000);
  assert.equal(l.check('a', 'POST', '/items').allowed, false);
  assert.equal(tokens(l, 'a', 'endpoint', 'write'), 0.5);
  l.advance(15_000);
  assert(l.check('a', 'POST', '/items').allowed);
  l.advance(600_000);
  assert(l.check('a', 'POST', '/items').allowed);
  assert.equal(tokens(l, 'a', 'endpoint', 'write'), 1);
  assert.equal(tokens(l, 'a', 'organization'), 9);
});

test('100 sequential admission checks spend only the available tokens', () => {
  const l = setup();
  const results = Array.from({ length: 100 }, () => l.check('a', 'POST', '/items'));
  assert.equal(results.filter(r => r.allowed).length, 2);
  assert.equal(tokens(l, 'a', 'organization'), 8);
  assert.equal(tokens(l, 'a', 'endpoint', 'write'), 0);
});

test('overlapping HTTP requests admit exactly one request with one token available', async t => {
  for (const exhausted of ['endpoint', 'organization']) {
    await t.test(`${exhausted} has one token`, async t => {
      const config = fixture();
      config.tiers.standard = limit(exhausted === 'organization' ? 1 : 10);
      config.endpoints[1].limit = limit(exhausted === 'endpoint' ? 1 : 10);
      // serve() freezes the clock at zero, preventing refill during the burst.
      const { request, limiter, handled } = await serve(t, config);
      let pending = 0;
      let maxPending = 0;
      const responses = await Promise.all(Array.from({ length: 25 }, async () => {
        pending++;
        maxPending = Math.max(maxPending, pending);
        try {
          return await request('/items');
        } finally {
          pending--;
        }
      }));
      // All clients started before any response completed; no sequential awaits.
      assert.equal(maxPending, 25);
      assert.equal(pending, 0);
      assert.equal(responses.filter(r => r.status === 201).length, 1);
      assert.equal(responses.filter(r => r.status === 429).length, 24);
      for (const response of responses.filter(r => r.status === 429)) {
        assert.deepEqual(response.body.limits.map(l => l.scope), [exhausted]);
        assert.equal(response.retryAfter, '60');
      }
      assert.equal(handled.length, 1);
      assert.equal(tokens(limiter, 'a', 'organization'), exhausted === 'organization' ? 0 : 9);
      assert.equal(tokens(limiter, 'a', 'endpoint', 'write'), exhausted === 'endpoint' ? 0 : 9);
    });
  }
});

test('middleware never calls downstream logic on either one-sided rejection', () => {
  for (const exhausted of ['organization', 'endpoint']) {
    const config = fixture();
    config.tiers.standard = limit(exhausted === 'organization' ? 1 : 3);
    config.endpoints[1].limit = limit(exhausted === 'endpoint' ? 1 : 3);
    const l = setup(config);
    const req = { orgId: 'a', method: 'POST', path: '/items' };
    const res = {
      statusCode: 200,
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    let executions = 0;
    const handler = () => executions++;
    l.middleware(req, res, handler);
    const before = l.snapshot();
    for (let i = 0; i < 5; i++) l.middleware(req, res, handler);
    assert.equal(executions, 1);
    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.body.limits.map(v => v.scope), [exhausted]);
    assert.deepEqual(l.snapshot(), before);
  }
});

test('arbitrary URLs share fallback buckets without unbounded keys', () => {
  const l = setup();
  for (let i = 0; i < 1000; i++) l.check('a', 'POST', `/random-${i}`);
  assert.equal(l.snapshot().length, 2);
  assert.equal(tokens(l, 'a', 'fallback', 'write'), 0);
  assert.equal(tokens(l, 'a', 'organization'), 5);
  assert(l.check('a', 'GET', '/unmatched').allowed);
});

test('HEAD inherits GET policy when Express would route HEAD to GET', async t => {
  const config = fixture();
  config.endpoints[0].limit = limit(1);
  const { request } = await serve(t, config);
  assert.equal((await request('/items', { method: 'GET' })).status, 200);
  const response = await request('/ITEMS/', { method: 'HEAD' });
  assert.equal(response.status, 429);
  assert.equal(response.retryAfter, '60');
});

test('configured aliases canonicalize and an explicit HEAD policy takes precedence', () => {
  const config = fixture();
  config.endpoints[0].path = '/ITEMS/';
  config.endpoints[0].limit = limit(1);
  config.endpoints.push({ id: 'head', method: 'HEAD', path: '/items', limit: limit(2) });
  const l = setup(config);
  assert(l.check('a', 'GET', '/items').allowed);
  assert.equal(l.check('a', 'GET', '/Items/').allowed, false);
  assert(l.check('a', 'HEAD', '/items').allowed);
  assert(l.check('a', 'HEAD', '/ITEMS/').allowed);
  assert.equal(l.check('a', 'HEAD', '/items').allowed, false);
});

test('cleanup removes fully refilled idle buckets but preserves depleted slow buckets', () => {
  const config = fixture();
  config.tiers.standard = limit(1, 600);
  const l = setup(config);
  l.check('a', 'POST', '/items');
  l.advance(300_000);
  l.sweep();
  assert.equal(l.snapshot().length, 1);
  assert.equal(tokens(l, 'a', 'organization'), 0);
  l.advance(300_000);
  l.sweep();
  assert.equal(l.snapshot().length, 0);
  assert(l.check('a', 'POST', '/items').allowed);
});

test('missing or unknown identity returns 401 and creates no state', async t => {
  const { request, limiter } = await serve(t, fixture());
  for (const org of [null, 'unknown', 'toString', '__proto__']) {
    assert.equal((await request('/items', { org })).status, 401);
  }
  assert.equal(limiter.snapshot().length, 0);
});

test('config is snapshotted and diagnostics cannot mutate counters', () => {
  const config = fixture();
  const l = setup(config);
  config.tiers.standard.capacity = 1000;
  l.check('a', 'POST', '/items');
  l.snapshot()[0].tokens = 1000;
  assert.equal(tokens(l, 'a', 'organization'), 9);
});

test('supplied config validates', () => {
  validateConfig(JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')));
});

test('invalid config fails early, including equivalent endpoint duplicates', () => {
  const cases = [
    c => { c.tiers.standard.capacity = 0; },
    c => { c.tiers.standard.capacity = 1.5; },
    c => { c.tiers.standard.refillPeriodSeconds = 0; },
    c => { c.tiers.standard.refillPeriodSeconds = Infinity; },
    c => { c.organizations.a.tier = 'missing'; },
    c => { c.organizations.a.limti = limit(1); },
    c => { delete c.fallbacks.write; },
    c => { c.endpoints[1].id = 'read'; },
    c => { c.endpoints.push({ id: 'alias', method: 'POST', path: '/ITEMS/', limit: limit(1) }); },
    c => { c.endpoints[0].path = '/items/:id'; },
    c => { c.typo = true; }
  ];
  for (const mutate of cases) {
    const config = fixture();
    mutate(config);
    assert.throws(() => validateConfig(config), /Invalid rate-limit config/);
  }
});
