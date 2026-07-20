# PROJECT PROPOSAL

## Xyra Health Companion Platform — Timeline & Effort Estimation (Revised)

**Prepared for:** Hlthera FZCO (UAE)
**Scope:** Core platform delivery — 3 gated phases (RAG core → clinical validation → personalization & launch), with proactive intelligence, report interpretation, and national integration available as follow-on modules
**Delivery model:** Single dedicated senior engineer, full-time
**Date:** July 2026

---

## 1. Executive Summary

This proposal sets out the delivery timeline and engineering effort to build the Xyra core platform — a compliant, agentic health companion for Hlthera FZCO. Xyra extends beyond a document Q&A tool: it is a personalized, action-executing health assistant, architected around UAE data-residency requirements (DHA/DOH) with a self-hosted LLM.

The platform shares a foundational pattern with our previously delivered production work (a FastAPI + pgvector RAG chatbot), which materially de-risks Phase 1 and allows significant pipeline reuse. This engagement is delivered by a **single dedicated senior engineer working full-time**, which keeps cost and communication overhead low; the scope is deliberately focused on what one engineer can deliver to production quality in three months.

Delivery is planned across **3 gated phases over 12 weeks (3 months)**, with total engineering effort of **480 hours**. Each phase ends at a formal gate. The advanced roadmap items — wearables, medical report interpretation, fine-tuning, Arabic/voice, national HIE integration — are preserved as an optional follow-on module catalogue, commissioned after the core is live and validated.

### Headline numbers

| Phase | Duration | Effort (hours) | Cost (USD) |
|-------|----------|----------------|------------|
| Phase 1 — RAG Core & Agentic Foundation | 5 weeks | 200 | $5,000 |
| Phase 2 — Clinical Validation & Safety | 3 weeks | 120 | $3,000 |
| Phase 3 — Personalization & Launch | 4 weeks | 160 | $4,000 |
| **Total** | **12 weeks** | **480** | **$12,000** |

*Hours are net engineering effort at 40 hours/week, single engineer. Rate basis: $25/hour. See §8 for the cost table and §9 for assumptions and client dependencies.*

---

## 2. Delivery Approach

We deliver in three gated phases. Each phase is independently valuable and ends at a go/no-go gate — clinical, technical, and commercial — before the next begins. This keeps risk contained in a regulated healthcare context and gives Hlthera clear decision points.

**Phase gates.** No phase progresses until its acceptance criteria are met — most critically the clinical gate (≥90% clinician agreement, <1% harmful output) before launch.

**Single-engineer delivery.** One senior engineer owns the AI platform end-to-end: architecture, implementation, deployment, and documentation. This eliminates coordination overhead and keeps accountability clear. Gateway-side and Flutter-side changes are coordinated with Hlthera's existing team, who own their respective codebases.

**Compliance-first.** Data residency (DHA/DOH), audit logging, and the non-disableable service-layer safety filter are built in from Phase 1, not retrofitted.

**Reuse of a proven foundation.** The Phase 1 RAG core builds on a production-tested FastAPI + pgvector pattern we have delivered before, which lowers delivery risk and is the main reason the core fits in a 3-month solo engagement.

**Right-sized MVP architecture.** To keep the initial engagement lean without compromising the target architecture, the MVP applies deliberate simplifications, each designed to upgrade cleanly later:

- **Application-level eventing** instead of a dedicated Kafka/MSK cluster; producers and consumers sit behind an interface so Kafka can be introduced without refactoring business logic.
- **PostgreSQL for long-term memory** at MVP scale, behind a repository interface compatible with a later DynamoDB migration.
- **Core agent set** (Health Analyst + Triage & Safety) on a plug-in orchestration contract; Report Interpreter and Wearable Monitor agents join the same contract when their modules are commissioned.
- **Wearables and medical report interpretation** are follow-on modules, not launch blockers — the orchestration, consent, and audit layers they depend on are built in the core.

---

## 3. Phase 1 — RAG Core & Agentic Foundation

**Duration:** 5 weeks (W1–W5) · **Effort:** 200 h · **Cost:** $5,000

Stand up the self-hosted, compliant RAG core with streaming and in-chat action execution. Deliverables: a working agentic chatbot that answers from curated tiered corpora and can book healers and list appointments, served from the UAE region.

| Workstream | Effort (h) |
|------------|------------|
| AI microservice + gateway integration (FastAPI, mTLS to ASP.NET Core 6 gateway) | 30 |
| Self-hosted LLM serving (Llama 3.1 70B on NVIDIA NIM, GPU, AWS UAE, ECS Fargate) — deployment + latency benchmarking | 35 |
| RAG ingestion + retrieval (pgvector, curated tiered corpora, chunking, embeddings — reusing proven pipeline) | 40 |
| Agentic action execution (book healer, list appointments — tool layer with audit records) | 30 |
| Token streaming delivery (SignalR, <500ms time-to-first-token) | 20 |
| Baseline post-generation safety filter (scaffold) | 15 |
| Rich response type contracts for Flutter (healer_card, booking_cta) + integration support | 15 |
| Redis caching + per-request context assembly (SQL Server profile/consent join) | 15 |
| **Phase subtotal** | **200** |

**Gate:** Grounded answers from curated corpora, streaming under target latency, and at least one live agentic action end-to-end, all inside the UAE region.

---

## 4. Phase 2 — Clinical Validation & Safety

**Duration:** 3 weeks (W6–W8) · **Effort:** 120 h · **Cost:** $3,000

Make the platform clinically defensible. Build the non-disableable service-layer Triage & Safety filter, the clinician-graded test suite, the core DHA/DOH compliance ruleset, and the human-review escalation path — then pass the formal clinical gate.

| Workstream | Effort (h) |
|------------|------------|
| Service-layer Triage & Safety middleware (non-disableable output filter, safety_override response type) | 35 |
| Clinical test harness — ~100 clinician-graded test cases at launch, growing over time | 20 |
| DHA/DOH compliance core ruleset | 15 |
| Human review queue (low-confidence outputs) | 20 |
| Clinical advisory board coordination + iteration to clinical gate (≥90% agreement, <1% harmful) | 15 |
| Full audit logging (every prompt / response / tool call) | 10 |
| Evaluation reporting + phase-gate documentation | 5 |
| **Phase subtotal** | **120** |

**Gate:** Clinical gate met — ≥90% clinician agreement and <1% harmful output across the graded test set; audit logging in place. This gate governs progression to launch.

*SaMD regulatory determination support (MOHAP) is available as a follow-on module; audit logging and evidence capture from Phases 1–2 are structured so determination artefacts can be produced when required.*

---

## 5. Phase 3 — Personalization & Launch

**Duration:** 4 weeks (W9–W12) · **Effort:** 160 h · **Cost:** $4,000

Personalize the assistant and harden it for production launch: per-user context, long-term memory, opt-in proactive nudges, observability, and operational readiness.

| Workstream | Effort (h) |
|------------|------------|
| Per-request context assembly hardening (health profile, booking history, consent-gate enforcement at data-access layer) | 30 |
| Long-term memory (PostgreSQL: learnings, preferences across sessions) | 25 |
| Proactive nudge engine (application events → FCM push, ≤1/48h, opt-in) | 30 |
| Observability (Prometheus/Grafana: latency percentiles, token throughput, retrieval quality, safety-filter hit rates) | 20 |
| Load testing + retrieval/prompt tuning | 25 |
| Deployment runbooks + handover documentation | 15 |
| Launch support + contingency buffer | 15 |
| **Phase subtotal** | **160** |

**Gate:** Production launch — personalized, consent-gated assistant live with monitoring and runbooks handed over.

---

## 6. Follow-On Modules (Optional, Post-Launch)

The advanced roadmap items are preserved as independently scoped modules, commissioned in any order once the core platform is live and validated. Effort figures are indicative and refined at commissioning time.

| Module | Scope | Effort (h) | Cost (USD) |
|--------|-------|------------|------------|
| Wearables & proactive monitoring | HealthKit / Health Connect → FHIR R4 ingestion, baselines, anomaly-driven nudges, Wearable Monitor agent | 250 | $6,250 |
| Medical report interpretation | LLM-first extraction + plain-language explanation, human review hold for critical lab values, Report Interpreter agent | 150 | $3,750 |
| Advanced report pipeline | Upgrade to Azure Document Intelligence OCR + AWS Comprehend Medical + LOINC reference DB | 140 | $3,500 |
| Model fine-tuning | NVIDIA NeMo closed-loop fine-tuning on feedback & outcomes, with regression evaluation against the clinical test set | 400 | $10,000 |
| National health records | Riayati / NABIDH HIE integration — connectivity, record mapping, consent flows (subject to external access) | 350 | $8,750 |
| Multilingual — Arabic | Arabic with UAE dialect optimization | 220 | $5,500 |
| Voice | Speech-to-text / text-to-speech interface | 180 | $4,500 |
| Family profiles | Multi-member profiles with per-member consent and data scoping | 150 | $3,750 |
| B2B assistant faces | Healer-facing and Health-Hub-facing assistants | 260 | $6,500 |
| Analytics pipeline | Redshift analytics for product and clinical insight | 180 | $4,500 |
| Production hardening at scale | Load/performance at scale, security review, disaster recovery | 200 | $5,000 |
| Event bus upgrade | Introduce Kafka (AWS MSK) behind the existing eventing interface | 80 | $2,000 |
| SaMD determination support | MOHAP documentation and evidence package | 40 | $1,000 |

Module timelines follow the same solo delivery model (40 h/week); larger modules can be accelerated with additional engineers if desired.

---

## 7. Timeline at a Glance

Sequential delivery by a single dedicated engineer at 40 hours/week. Weeks are indicative and assume timely availability of client dependencies (see §9).

| Phase | Weeks | Primary focus |
|-------|-------|---------------|
| Phase 1 | W1 – W5 | Self-hosted RAG core, streaming, agentic actions |
| Phase 2 | W6 – W8 | Safety filter, clinical validation, compliance gate |
| Phase 3 | W9 – W12 | Personalization, nudges, observability, launch |
| Follow-on modules | Post-launch | Wearables, reports, fine-tuning, national HIE, Arabic/voice — as commissioned |

---

## 8. Effort & Cost

Effort is quoted in net engineering hours per phase at a rate of **$25/hour**, single engineer, 40 hours/week.

| Phase | Effort (h) | Cost (USD) |
|-------|------------|------------|
| Phase 1 — RAG Core & Agentic Foundation | 200 | $5,000 |
| Phase 2 — Clinical Validation & Safety | 120 | $3,000 |
| Phase 3 — Personalization & Launch | 160 | $4,000 |
| **Core platform total** | **480** | **$12,000** |

**Suggested payment schedule:** per-phase invoicing — 30% at phase kickoff, 70% on gate acceptance. Alternative structures (monthly, milestone-based) can be agreed in commercial terms.

### Scope of the estimate

Figures represent net engineering effort across the three core phases, sized for a single senior engineer delivering sequentially. The estimate leans on reuse of a production-tested RAG foundation for Phase 1; clinical validation and human-review steps are paced by domain experts and estimated conservatively.

Infrastructure and third-party costs are excluded from the effort figures — GPU/NIM instances, managed databases, FCM, and any third-party AI services are pass-through operational costs billed directly to Hlthera.

---

## 9. Assumptions & Client Dependencies

The timeline assumes the following are provided by Hlthera in a timely manner. Delays here shift the schedule.

- AWS UAE-region account with sufficient GPU quota for NVIDIA NIM, plus DHA/DOH data-residency sign-off.
- Clinical advisory board (2–3 UAE-licensed physicians) available for test-case grading and gate reviews.
- Licensed access to curated corpora (DHA/DOH, WHO, NICE, MedlinePlus).
- Access to the existing ASP.NET Core 6 gateway, SQL Server schema, and current app for integration; gateway-side and Flutter-side changes implemented by Hlthera's team against contracts I provide.
- Timely feedback and gate decisions at each phase boundary (target: within 5 business days).
- Riayati / NABIDH credentials, wearable entitlements, SNOMED CT/LOINC licensing, and MOHAP liaison apply only if the corresponding follow-on modules are commissioned.

---

## 10. Out of Scope

- Flutter client implementation (response-type contracts, API documentation, and integration support are provided; UI implementation is by Hlthera's mobile team).
- Native mobile app store submission/review management.
- Content authoring/curation of the medical knowledge corpora (we index what is provided).
- Regulatory approval itself (determination artefacts can be produced via the SaMD follow-on module; approval is MOHAP's).
- Ongoing production support / SLA beyond the delivery window (can be quoted as a separate retainer).
- Cloud, GPU, and third-party API operational costs (pass-through, billed to client).

---

## 11. Key Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Clinical gate not met on first pass | Buffer built into Phase 3; iterate on filter + retrieval before launch. |
| GPU quota / UAE-region capacity | Confirm quota during Phase 1 week 1; NIM fallback instance types planned. |
| Self-hosted LLM quality vs. hosted models | Retrieval tuning and prompt iteration in Phases 1–2; fine-tuning module available post-launch if needed. |
| Single-engineer availability | Full-time dedication for the engagement window; documentation and runbooks maintained continuously so nothing is head-locked. |
| Scope creep | Gated phases and fixed per-phase effort; changes handled via change request; advanced features routed to the module catalogue. |

---

## 12. Next Steps

1. Confirm phase scope and gate acceptance criteria.
2. Agree commercial terms and payment milestones (§8).
3. Provision AWS UAE account + GPU quota and confirm clinical advisory board availability.
4. Kick off Phase 1 (target: within 1–2 weeks of sign-off).

---

*Prepared July 2026 · Effort figures are estimates and subject to refinement after a detailed Phase 1 discovery session.*
