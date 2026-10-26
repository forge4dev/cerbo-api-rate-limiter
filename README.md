# In-memory API rate limiter

An Express middleware proof of concept that bounds each organization's request rate and bursts, reducing the impact of a noisy sync job. Every authenticated demo request must pass **both an organization-wide limit and a per-organization endpoint limit** before application handlers run. Everything lives in one process's memory. These quotas do not guarantee that aggregate traffic stays within total API capacity.

## Run it

Requires Node.js 22 or newer and npm. From this directory:

```sh
npm ci
npm test
npm start
```

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`. The server binds to `http://127.0.0.1:3000`. `PORT` changes the port; `CONFIG_PATH` selects a different JSON configuration file. Relative configuration paths resolve from the working directory. Invalid JSON or configuration stops startup with an error and a nonzero exit code.

Try these in a second terminal (use `curl.exe` in Windows PowerShell):

```sh
curl -i -H "X-Org-Id: org-acme" http://127.0.0.1:3000/items
curl -i -X POST -H "X-Org-Id: org-acme" http://127.0.0.1:3000/items
```

To exhaust the standard organization's write bucket in PowerShell:

```powershell
1..21 | ForEach-Object {
  curl.exe -s -i -X POST -H "X-Org-Id: org-acme" http://127.0.0.1:3000/items
}
```

The first 20 rapid writes succeed; the next returns 429, assuming the loop finishes before one token refills (3 seconds). GET requests still work because they use a separate endpoint bucket and organization tokens remain. Rejected writes don't spend organization tokens. After a fresh restart, `org-globex` has a 500-token organization bucket; its write endpoint bucket is still 20, by design.

Demo handlers: GET `/items` returns an empty collection; POST returns 201; PUT and PATCH return 200; DELETE returns 204. Writes demonstrate admission only and persist nothing. Unknown routes return 404 after passing the limiter. Missing or unrecognized organization IDs return 401 without creating bucket state.

**Identity assumption:** `X-Org-Id` is trusted only for this local demo. A deployed service must derive organization identity from verified authentication and prevent callers from overriding it. Merely knowing another configured ID currently lets a caller use that organization's quota.

## Configuration contract

Edit [`config.json`](config.json) and restart. Limits are data; no source edits are needed. Reloading while running is deliberately out of scope. Restarting also resets all counters.

```json
{
  "tiers": {
    "standard": { "capacity": 100, "refillPeriodSeconds": 60 },
    "premium": { "capacity": 500, "refillPeriodSeconds": 60 }
  },
  "organizations": {
    "org-acme": { "tier": "standard" },
    "org-globex": { "tier": "premium" },
    "org-custom": {
      "tier": "standard",
      "limit": { "capacity": 200, "refillPeriodSeconds": 60 }
    }
  },
  "endpoints": [
    {
      "id": "list-items",
      "method": "GET",
      "path": "/items",
      "limit": { "capacity": 100, "refillPeriodSeconds": 60 }
    },
    {
      "id": "create-item",
      "method": "POST",
      "path": "/items",
      "limit": { "capacity": 20, "refillPeriodSeconds": 60 }
    }
  ],
  "fallbacks": {
    "read": { "capacity": 100, "refillPeriodSeconds": 60 },
    "write": { "capacity": 20, "refillPeriodSeconds": 60 }
  }
}
```

- `capacity` is a positive safe integer: maximum stored tokens and initial burst size. `refillPeriodSeconds` is positive and finite, producing a finite positive refill rate. Tokens refill continuously at `capacity / refillPeriodSeconds` per second. Every admitted request costs one token from each applicable bucket.
- Organization keys match demo identities. `tier` must exist. An optional organization `limit` replaces the tier's entire organization-wide policy. All organizations share endpoint policy definitions, but their endpoint counters are independent.
- Endpoint IDs must be unique. Paths are literal ASCII paths, not Express patterns. Supported configured methods are GET, HEAD, OPTIONS, POST, PUT, PATCH, and DELETE. Method/path pairs must be unique after canonicalization. Unknown fields are errors to catch misspellings.
- Matching is case-insensitive and ignores one trailing slash, matching this demo's explicit Express routing settings. Query strings do not select policies. `/items`, `/items/`, and `/ITEMS` all use the same policy ID and bucket. HEAD inherits GET's policy unless an explicit HEAD policy exists.
- Unmatched GET, HEAD, and OPTIONS requests share one **read fallback bucket per organization**. Other methods share one **write fallback bucket per organization**. PUT, PATCH, and DELETE therefore get the stricter write default. Changing arbitrary URL paths cannot create new buckets.

These are token-bucket limits, not strict rolling-window ceilings: a bucket may start full and refill during a minute, allowing almost twice its capacity in some 60-second intervals. This favors a small implementation and smooth recovery over exact rolling-window accounting. Separate burst capacity and refill rate would be a reasonable extension if initial bursts remain too costly.

## Middleware and rejection behavior

[`src/rate-limiter.js`](src/rate-limiter.js) exports `createRateLimiter(config, { clock }?)`. Each instance owns its state. It returns:

- `middleware(req, res, next)`: expects `req.orgId`, provided by upstream authentication (the demo resolves the header first). Mount once with `app.use(limiter.middleware)` before body parsing and application routes.
- `check(orgId, method, path)`: the synchronous admission operation. Path must be a pathname without a query string. Returns `{ allowed: true }`, or a rejection with exhausted limits and retry seconds. Unknown identity returns `{ allowed: false, unknownOrganization: true }`.
- `sweep()`: removes fully refilled idle buckets; the server calls it every minute with an unreferenced timer.
- `snapshot()`: detached diagnostic entries containing bucket keys and current stored balances, used for token-accounting tests. It does not refill buckets or expose writable state. Do not expose it as a public API endpoint.

The default clock is monotonic (`performance.now()`), so wall-clock adjustments don't alter quotas. Tests inject a frozen clock and advance it without sleeping. Both buckets are refilled and checked **before either is debited**, with no `await` between these steps. That makes admission atomic within one JavaScript isolate. Rejection spends zero tokens from either bucket; elapsed time can still refill their balances.

Exhausting an endpoint leaves other endpoint balances intact. Exhausting the organization bucket intentionally blocks all its endpoints, while preserving their balances. Other organizations are independent. Accepted requests spend tokens even if their handlers later fail, return 404, or reject malformed JSON; the limiter meters admitted traffic, not successful business operations.

Example response when only the configured write endpoint is exhausted:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 3
Cache-Control: no-store
Content-Type: application/json
```

```json
{
  "error": "rate_limit_exceeded",
  "message": "Request rejected before application handlers.",
  "allowed": false,
  "limits": [
    {
      "scope": "endpoint",
      "id": "create-item",
      "capacity": 20,
      "refillPeriodSeconds": 60,
      "retryAfterSeconds": 3
    }
  ],
  "retryAfterSeconds": 3
}
```

All exhausted limits are listed; `scope` is `organization`, `endpoint`, or `fallback`. `Retry-After` is the ceiling of the longest time needed for one token, with a minimum of one second. It is an earliest retry estimate, not a reservation: other traffic may consume tokens first. HEAD responses carry status/headers but no JSON body, per HTTP semantics. Clients should honor the header and add jitter to avoid synchronized retry bursts.

## Verification

`npm test` runs deterministic unit tests and HTTP integration tests against actual Express routing on ephemeral loopback ports.

- Both one-sided exhaustion cases assert exact token balances; endpoint rejection leaves another endpoint available, and organization rejection preserves the other endpoint's full balance while blocking it intentionally. Another organization remains available.
- URL alias regression checks `/items/`, `/ITEMS`, `/ItEmS/`, and query strings after exhausting `/items`. A separate test checks HEAD/GET sharing.
- Coverage includes tier/organization overrides, cross-endpoint organization quotas, simultaneous exhaustion and Retry-After rounding, refill and capacity caps, sequential admission and overlapping HTTP requests, bounded fallback keys, cleanup, identity rejection, and configuration errors.

The direct 100-call test is intentionally synchronous: it proves back-to-back admission and token accounting, not concurrent execution. The HTTP test launches 25 requests before any response completes, with a frozen clock and exactly one token in either the endpoint or organization bucket. Each case must produce one success and 24 rejections, leaving the unconstrained bucket with nine of its ten tokens. This covers overlapping client requests against one Express process; the synchronous admission operation still executes serially on Node's event loop. It does not demonstrate thread safety or coordination across processes/replicas.

Before fixing matching, the actual Express regression returned **201 instead of 429** for `/items/`; the HEAD regression returned **200 instead of 429**. Both tests now pass with canonical matching and GET policy inheritance. The two token-consumption regressions passed before and after that correction.

## Does this prevent the original overload incident?

It addresses the noisy-client part of the incident: a single organization cannot send unlimited admitted requests in one process, and writes have a tighter budget. Whether the configured values would prevent that client's original three-hour overload depends on measured request costs and available capacity. The example thresholds are demonstration values, not capacity measurements. An expensive request or an allowed burst can still cause elevated latency.

In particular, a request-count quota does not guarantee that an organization uses less than 40% of API capacity: one organization can issue fewer but more expensive requests. The assessment requirements are met by the two quota layers, but demonstrating that the original latency/timeouts cannot recur would require representative load testing and additional capacity controls.

There is no shared endpoint-wide budget across organizations and no global admission or in-flight request limit. For example, 100 standard organizations reading `/items` can collectively sustain 10,000 requests/minute and start with 10,000 burst tokens in a single process. Every organization could obey its quota while the API or its database becomes overloaded. Additional replicas independently grant more quota. Passing the quota checks therefore does not establish that a request is safe to execute now.

Production needs a capacity protection layer in addition to tenant quotas, selected and sized through load tests against latency/error targets and downstream bottlenecks:

- **Global rate/burst limit:** bounds total admissions across organizations for a service or shared bottleneck. It is useful when a sustainable throughput budget is known. A fleet-wide limit requires coordinated admission, such as an API gateway or atomic shared store; putting a full-sized global bucket in each replica does not enforce a fleet-wide ceiling. If added to this limiter, all rate buckets must be checked and debited atomically so a global rejection does not spend tenant tokens.
- **Concurrency limit:** bounds work currently executing, especially when request duration varies or a dependency slows down. A fixed request rate cannot provide this protection: at 100 requests/second, increasing average duration from 0.1 to 5 seconds increases average in-flight work from roughly 10 to 500. Use per-instance limits for local resources and coordinated limits or allocated budgets for shared dependencies. Release permits on actual work completion/error, and ensure timeouts cancel or account for work that continues after a client disconnects. Reject excess work or use a bounded queue; an unbounded queue moves the overload into memory and waiting time.
- **Combined protection:** for this incident, plan for both a total admission budget and concurrency limits unless capacity testing establishes that one suffices. Keep tenant quotas alongside them: a global ceiling alone does not reserve fair capacity for other organizations. Monitor rejection rates, in-flight work, latency, and dependency saturation to tune the budgets.

Global and concurrency limits are production follow-up work, not missing assessment requirements. The requested POC implements per-organization and per-endpoint quotas; no middleware behavior, configuration fields, or response contracts are changed by this capacity assessment. It mitigates one source of overload rather than guaranteeing service availability under all permitted traffic.

## What breaks, and what comes next

| Constraint or failure | Consequence | Next step |
| --- | --- | --- |
| Process restarts or deployments | Counters disappear; clients regain full bursts. | Persist bucket state in shared infrastructure with appropriate expiry. |
| Horizontal scaling, cluster workers, or multiple limiter instances | Every instance grants its own quota. Across N replicas, effective allowance can approach N times the configured limit. | Use an atomic shared admission operation, such as a Redis script checking and consuming both buckets together. |
| Memory growth | State grows with active configured organizations and policies. There is no hard byte cap. | Track memory/key counts, bound tenant admission, and move state to expiring shared storage. Avoid evicting depleted buckets, which would reset allowances. |
| Idle state | Buckets would accumulate for the process lifetime without cleanup. | Current sweep removes a bucket only after it is idle for at least max(5 minutes, its full refill period) and fully refilled. Frequent rejected traffic keeps its state live. |
| Aggregate traffic or expensive requests | Per-client request quotas don't cap total CPU, long-running concurrency, or response size. A permitted burst can still hurt service. | Measure capacity, tune burst sizes, add concurrency limits/timeouts, and consider weighted request costs and a global safety limit. |
| Routing evolves | Dynamic params, nested routers, rewrites, or different case/strict settings can make independent path matching disagree with handlers. | This POC supports literal paths and one root router. For broader use, attach stable endpoint IDs through a centralized route-registration layer using the actual router's matching semantics; extend integration tests before enabling new patterns. |
| Shared limiter unavailable later | An infrastructure outage forces a choice between availability and quota enforcement. | Define timeouts and fail-open versus fail-closed policy explicitly; don't silently choose during migration. Use a shared time source inside the atomic operation. |

With current fixed configuration, bucket cardinality is bounded by **organizations × (configured endpoints + 3)**: one organization bucket, one per configured endpoint, and two fallback buckets. Buckets are lazy; unknown identities create none. Cleanup reduces idle usage but is not a replacement for sizing memory.

This POC has no production monitoring. Before rollout, add admission/rejection counts by policy and tier, handler latency/error rates, limiter decision latency, and active bucket/memory gauges. Avoid high-cardinality organization IDs in metric labels. Roll out to a small cohort and verify legitimate burst patterns before enforcing more broadly. A Redis migration needs atomicity/concurrency tests and an explicit strategy for existing in-memory state; expect a quota reset during a simple cutover.
