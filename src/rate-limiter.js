import { performance } from 'node:perf_hooks';
import { canonicalPath, validateConfig } from './config.js';

/** Two-bucket admission controller. State belongs to this instance/process only. */
export function createRateLimiter(input, { clock = () => performance.now() } = {}) {
  // Snapshot config so caller mutations cannot change policies under existing buckets.
  const config = validateConfig(structuredClone(input));
  const buckets = new Map();
  const endpointPolicies = new Map(config.endpoints.map(e => [`${e.method} ${canonicalPath(e.path)}`, e]));

  function refill(bucket, now) {
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(bucket.limit.capacity, bucket.tokens + elapsed * bucket.limit.capacity / (bucket.limit.refillPeriodSeconds * 1000));
    bucket.updatedAt = now;
  }

  function getBucket(key, policy, now) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { limit: policy, tokens: policy.capacity, updatedAt: now, lastSeen: now };
      buckets.set(key, bucket);
    }
    refill(bucket, now);
    bucket.lastSeen = now;
    return bucket;
  }

  function check(orgId, method, path) {
    if (typeof orgId !== 'string' || !Object.hasOwn(config.organizations, orgId)) return { allowed: false, unknownOrganization: true };
    const now = clock();
    const org = config.organizations[orgId];
    const canonical = canonicalPath(path);
    const endpoint = endpointPolicies.get(`${method} ${canonical}`) ??
      (method === 'HEAD' ? endpointPolicies.get(`GET ${canonical}`) : undefined);
    const category = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'write';
    const policyId = endpoint?.id ?? category;
    const orgBucket = getBucket(JSON.stringify([orgId, 'organization']), org.limit ?? config.tiers[org.tier], now);
    const endpointBucket = getBucket(JSON.stringify([orgId, endpoint ? 'endpoint' : 'fallback', policyId]), endpoint?.limit ?? config.fallbacks[category], now);
    const candidates = [
      { bucket: orgBucket, scope: 'organization', id: orgId },
      { bucket: endpointBucket, scope: endpoint ? 'endpoint' : 'fallback', id: policyId }
    ];
    const limits = candidates.filter(({ bucket }) => bucket.tokens < 1).map(({ bucket, scope, id }) => ({
      scope,
      id,
      ...bucket.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) * bucket.limit.refillPeriodSeconds / bucket.limit.capacity))
    }));
    // No await between checking both buckets and consuming: atomic in one JS isolate.
    if (limits.length) return { allowed: false, limits, retryAfterSeconds: Math.max(...limits.map(l => l.retryAfterSeconds)) };
    orgBucket.tokens -= 1;
    endpointBucket.tokens -= 1;
    return { allowed: true };
  }

  function middleware(req, res, next) {
    const result = check(req.orgId, req.method, req.path);
    if (result.unknownOrganization) return res.status(401).json({ error: 'unknown_organization', message: 'Supply a configured X-Org-Id for this demo.' });
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfterSeconds));
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({ error: 'rate_limit_exceeded', message: 'Request rejected before application handlers.', ...result });
    }
    next();
  }

  function sweep() {
    const now = clock();
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastSeen < Math.max(300_000, bucket.limit.refillPeriodSeconds * 1000)) continue;
      refill(bucket, now);
      if (bucket.tokens === bucket.limit.capacity) buckets.delete(key);
    }
  }

  // Detached snapshots support diagnostics and deterministic token-accounting tests.
  function snapshot() {
    return [...buckets].map(([key, bucket]) => ({ key: JSON.parse(key), tokens: bucket.tokens, ...bucket.limit }));
  }

  return { middleware, check, sweep, snapshot };
}
