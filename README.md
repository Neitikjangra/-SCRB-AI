# KSP SCRB Conversational Intelligence Prototype

This is a production-oriented prototype for an Intelligent Conversational AI Platform for the Karnataka State Police Crime Records Bureau. It demonstrates natural language crime analytics, bilingual chat, voice input, graph visualization, hotspot detection, early warnings, PDF-ready transcript export, explainability, audit trails, and role-based access.

The included records are synthetic. They are only for product and architecture validation.

## Run Locally

```powershell
python app.py --host 127.0.0.1 --port 8000
```

Or on Windows PowerShell:

```powershell
.\run_server.ps1
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Demo Roles

- Investigator: district-scoped analytics with named synthetic network access.
- SCRB Analyst: statewide aggregate analytics with identity masking.
- Supervisor: statewide analytics with network and audit permissions.

## What Is Included

- `app.py`: dependency-free Python API and deterministic analytics engine.
- `public/`: polished investigator console with chat, voice input, visual analytics, and PDF export flow.
- `data/crime_records.json`: synthetic SCRB-style crime records.
- `docs/ARCHITECTURE.md`: production architecture and scaling plan.
- `docs/SECURITY_AND_GOVERNANCE.md`: RBAC, audit, privacy, and model-risk controls.
- `docs/API.md`: local API reference.
- `tests/test_engine.py`: focused engine tests.

## Product Capabilities

- Natural language chatbot in English and Kannada.
- Context-aware follow-up filters for district, station, crime type, and recent period.
- Crime trend and hotspot detection.
- Criminal network visualization with role-sensitive masking.
- Socio-demographic distribution for outreach planning.
- Behavioral profiling by modus operandi, evidence tags, repeat locations, and role-safe repeat links.
- AI case linkage engine for hidden case clusters, confidence scores, supporting evidence, and relationship graphs.
- Predictive early-warning cards with explainable rationale.
- Investigator agent with role-scoped action queue, watchlist, rationale, and auditable runs.
- Audit IDs, source case IDs, guardrails, and model-route metadata.
- Browser print-to-PDF conversation export.

## Production Roadmap

1. Replace synthetic JSON with approved SCRB warehouse, graph, and geo-spatial sources.
2. Put KSP SSO, MFA, RBAC, ABAC, and station-level row policy in front of all APIs.
3. Add a query planner that produces bounded SQL, graph, vector, linkage, and forecast retrieval plans.
4. Use an approved LLM endpoint behind prompt-injection filters and source-grounded response generation.
5. Deploy immutable audit logging, export watermarking, monitoring, and Kannada evaluation suites.
