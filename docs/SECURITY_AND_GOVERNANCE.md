# Security and Governance Plan

The prototype shows role-based behavior, but production security must be enforced by infrastructure, policy, and audit systems rather than client-side controls.

## Identity and Access

- Integrate with KSP identity provider, MFA, device posture, and session timeouts.
- Use RBAC for roles such as investigator, analyst, supervisor, administrator, and auditor.
- Add ABAC for district, station, case assignment, sensitivity level, legal hold, and purpose of access.
- Require step-up approval for sensitive categories such as minors, sexual offences, protected witnesses, and sealed records.

## Data Protection

- Encrypt data in transit and at rest.
- Tokenize or mask personally identifiable information unless the user has a case-linked need.
- Keep Kannada and English transcripts in the same retention class as investigative notes.
- Use minimum cohort thresholds for demographic analytics.
- Redact exports based on role and case sensitivity.

## AI Guardrails

- The LLM should never directly query production databases.
- Use a query planner that emits bounded, parameterized retrieval plans.
- Validate generated SQL or graph queries against allow-lists and row-level policy.
- Return source citations, filters, confidence, and limitations with every analytical answer.
- Require human verification for predictions and network leads.
- Require human verification for case-linkage clusters before merging cases, naming suspects, or assigning enforcement action.

## Audit

Every query should produce an immutable event with:

- Actor, role, device, station, and session.
- User message and normalized intent.
- Query plan, filters, data sources, and record counts.
- Model route, prompt version, policy decisions, and guardrails.
- Export ID or downstream action, when applicable.

## Model Risk Management

- Evaluate separately for English, Kannada, and mixed-language prompts.
- Test for over-disclosure, prompt injection, caste or religion proxy bias, and false certainty.
- Maintain model cards for each deployed model and forecasting component.
- Monitor drift by station, crime type, seasonality, and reporting changes.

## Operational Readiness

- Establish a supervisory review queue for early-warning recommendations.
- Use incident response playbooks for data leakage, model misuse, and compromised credentials.
- Keep disaster recovery plans for audit logs, warehouse connectors, and graph indexes.
- Run periodic access recertification for all privileged roles.
