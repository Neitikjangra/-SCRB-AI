# Prototype API

Base URL: `http://127.0.0.1:8000`

## `POST /api/auth/login`

Creates a demo session.

```json
{ "profile": "investigator" }
```

Valid profiles: `investigator`, `analyst`, `supervisor`.

## `GET /api/summary`

Requires `Authorization: Bearer <token>`.

Returns the active role, permitted scope, record count, latest month, and synthetic-data flag.

## `GET /api/analytics`

Returns role-scoped aggregates:

- record counts
- crime type mix
- district mix
- monthly trends
- hotspot scores
- demographic distributions
- AI case linkage clusters, confidence scores, evidence dimensions, and graph links
- graph nodes and links
- early warnings

## `GET /api/linkage`

Requires `Authorization: Bearer <token>`.

Returns the role-scoped AI Case Linkage Engine result:

- pair count
- linked case clusters
- cluster confidence and risk level
- supporting case-pair evidence by dimension
- graph nodes and links for visualization
- explainability guardrails

## `POST /api/chat`

```json
{
  "message": "Show hotspots in Bengaluru City",
  "language": "en",
  "conversation": [
    { "role": "user", "content": "Earlier question" }
  ]
}
```

Returns:

- answer text
- detected intent
- applied filters
- source case IDs
- audit event
- chart update payload

Use messages such as `Run case linkage engine for hidden relationships` to trigger linkage intent from chat.

## `POST /api/export`

```json
{
  "conversation": [
    { "role": "user", "content": "Show hotspots" },
    { "role": "assistant", "content": "..." }
  ]
}
```

Returns printable HTML that the browser can save as a PDF.

## `GET /api/audit`

Supervisor-only endpoint returning recent audit JSONL events.
