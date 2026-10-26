import { readFileSync } from 'node:fs';

function fail(message) {
  throw new Error(`Invalid rate-limit config: ${message}`);
}

function object(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) {
    if (fields && !fields.includes(key)) fail(`${name}.${key} is unknown`);
  }
}

function limit(value, name) {
  object(value, ['capacity', 'refillPeriodSeconds'], name);
  if (!Number.isSafeInteger(value.capacity) || value.capacity < 1) fail(`${name}.capacity must be a positive safe integer`);
  if (!Number.isFinite(value.refillPeriodSeconds) || value.refillPeriodSeconds <= 0 ||
      !Number.isFinite(value.refillPeriodSeconds * 1000) ||
      !Number.isFinite(value.capacity / (value.refillPeriodSeconds * 1000)) ||
      value.capacity / (value.refillPeriodSeconds * 1000) <= 0) {
    fail(`${name}.refillPeriodSeconds must produce a positive finite refill rate`);
  }
}

export function canonicalPath(path) {
  // Match this app's literal, case-insensitive, non-strict Express routes.
  // Remove only one trailing slash: /items// need not route like /items/.
  return path.toLowerCase().replace(/\/$/, '') || '/';
}

export function validateConfig(config) {
  object(config, ['tiers', 'organizations', 'endpoints', 'fallbacks'], 'config');
  object(config.tiers, null, 'tiers');
  object(config.organizations, null, 'organizations');
  if (!Object.keys(config.tiers).length || !Object.keys(config.organizations).length) fail('tiers and organizations must not be empty');
  for (const [name, value] of Object.entries(config.tiers)) limit(value, `tiers.${name}`);
  for (const [id, org] of Object.entries(config.organizations)) {
    if (!id.trim()) fail('organization IDs must not be empty');
    object(org, ['tier', 'limit'], `organizations.${id}`);
    if (typeof org.tier !== 'string' || !Object.hasOwn(config.tiers, org.tier)) fail(`organizations.${id}.tier must reference a configured tier`);
    if (Object.hasOwn(org, 'limit')) limit(org.limit, `organizations.${id}.limit`);
  }
  if (!Array.isArray(config.endpoints)) fail('endpoints must be an array');
  const ids = new Set();
  const routes = new Set();
  for (const endpoint of config.endpoints) {
    object(endpoint, ['id', 'method', 'path', 'limit'], 'endpoint');
    if (typeof endpoint.id !== 'string' || !endpoint.id.trim() || ids.has(endpoint.id)) fail('endpoint IDs must be nonempty and unique');
    ids.add(endpoint.id);
    if (!['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method)) fail(`endpoint ${endpoint.id} has an unsupported method`);
    // Literal ASCII paths only; dynamic route patterns require route-aware matching.
    if (typeof endpoint.path !== 'string' || !/^\/(?:[A-Za-z0-9_~-]+\/?)*$/.test(endpoint.path)) fail(`endpoint ${endpoint.id}.path must be a literal ASCII path`);
    const route = `${endpoint.method} ${canonicalPath(endpoint.path)}`;
    if (routes.has(route)) fail(`duplicate endpoint method/path: ${route}`);
    routes.add(route);
    limit(endpoint.limit, `endpoints.${endpoint.id}.limit`);
  }
  object(config.fallbacks, ['read', 'write'], 'fallbacks');
  limit(config.fallbacks.read, 'fallbacks.read');
  limit(config.fallbacks.write, 'fallbacks.write');
  return config;
}

export function loadConfig(path) {
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')));
}
