# What You'll Be Doing
You're a software engineer on a growing B2B SaaS platform. Last week, a single client's automated sync job consumed 40% of your API capacity for three hours, causing elevated latency and timeout errors for other clients. The engineering team has been asked to fix this before it happens again.

Build a rate-limiting middleware layer that sits between incoming requests and API handlers, enforcing configurable limits before requests reach application logic. This is a proof-of-concept — focus on engineering judgment and trade-offs, not production polish. You have 30 minutes for the build phase.

## Requirements:

Per-client rate limiting — configurable per-org thresholds (e.g. 100 req/min standard, 500 premium)
Per-endpoint rate limiting — stricter limits on write endpoints (POST, PUT, DELETE) than reads (GET)
Meaningful error responses — 429 status, which limit was hit, and a Retry-After header
Configurable limits — defined in a config object or file; adjustable without code changes

## Constraints:

In-memory only — no Redis, no external cache, no database. Address what breaks under this constraint and what changes when infrastructure becomes available.
Any language or framework — language choice is not scored; engineering judgment is.
Must work as middleware — implement as a middleware layer or decorator/interceptor pattern, not a modification to every individual route.
Async-first communication — your README is how the team understands your work. Write it for someone reading at 11pm who can't ask follow-up questions.
Demonstrate known failure modes — articulate what breaks (process restarts, horizontal scaling, memory growth); don't pretend limitations don't exist.

