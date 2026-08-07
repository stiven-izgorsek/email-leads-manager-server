# Technical Proposal — Xyra AI Health Companion Platform

**Prepared for:** Hlthera FZCO (UAE)
**Prepared by:** Juan
**Date:** July 2026
**Reference:** "AI Chatbot Approach Comparison — Xyra vs. Twiper RAG Chatbot" (July 2026)

---

## 1. Technical Requirements Analysis

Xyra is a multi-agent AI health companion for the UAE market: a regulated health platform in which the conversational interface fronts bookings, curated medical knowledge, and — in later phases — wearables, medical report interpretation, and national health record integration.

The architecture document defines the following core technical constraints and requirements:

| Requirement | Technical implication |
|-------------|----------------------|
| **Data residency (DHA/DOH)** | Patient data must not leave the UAE. All inference must run on a **self-hosted LLM** — Llama 3.1 70B served via NVIDIA NIM on GPU instances in the AWS UAE region. No external LLM APIs. |
| **Grounded responses** | RAG over curated tiered corpora (DHA/DOH, WHO, NICE, MedlinePlus) with pgvector similarity search; retrieval thresholds and fallback behavior for out-of-corpus queries. |
| **Safety enforcement** | A **service-layer, post-generation Triage & Safety filter** that scans every output for emergency keywords, diagnostic/prescription language, and ungrounded claims. Non-disableable by prompting, validated against clinician-graded test cases. |
| **Agentic action execution** | The assistant executes real operations in-chat — booking healers, querying centres, listing appointments — through the existing ASP.NET Core 6 gateway APIs, with full tool-call audit logging. |
| **Personalization** | Per-request context assembly (health profile, booking history, consent flags, session ID) with consent gates on every data source; long-term memory persisted across sessions. |
| **Streaming UX** | Token streaming via SignalR with a <500ms time-to-first-token target, delivered to the Flutter client using structured rich response types (`healer_card`, `booking_cta`, `safety_override`, etc.). |
| **Auditability** | Every prompt, response, and tool call logged from day one to support DHA/DOH compliance and future SaMD determination. |

This proposal delivers the core platform against these requirements in a **fixed 8-week engagement**, with the remaining roadmap items (wearables, report interpretation, Arabic/voice, national HIE, fine-tuning) structured as independent follow-on modules.

---

## 2. Target Architecture

```
                       +--------------------------+
                       |  Flutter client          |
                       |  (iOS / Android / Web)   |
                       +------------+-------------+
                                    |  SignalR (token streaming,
                                    |  rich response types)
                                    v
                       +--------------------------+
                       |  ASP.NET Core 6 gateway  |
                       |  auth, sessions, booking |
                       +------------+-------------+
                                    |  mTLS
                                    v
                       +--------------------------+
                       |  FastAPI AI service      |
                       |  - agent orchestration   |
                       |  - RAG pipeline          |
                       |  - Triage & Safety filter|
                       |  - tool-call executor    |
                       +---+--------+---------+---+
                           |        |         |
              +------------+        |         +-------------+
              v                     v                       v
     +----------------+   +----------------+     +--------------------+
     | NVIDIA NIM     |   | PostgreSQL     |     | SQL Server         |
     | Llama 3.1 70B  |   | + pgvector     |     | (health profiles,  |
     | (GPU, AWS UAE) |   | corpus chunks, |     |  bookings, consent)|
     +----------------+   | audit, memory  |     +--------------------+
                          +----------------+
                                    |
                                    v
                          +----------------+
                          | Redis          |
                          | session cache  |
                          +----------------+
```

All components are deployed in the **AWS UAE region** (ECS Fargate for stateless services, dedicated GPU instances for NIM). No patient data crosses the region boundary.

Design decisions for the MVP stage:

- **Application-level eventing** is used in place of a full Kafka/MSK cluster; event producers/consumers are isolated behind an interface so Kafka can be introduced later without refactoring business logic.
- **Agent orchestration** ships with the two core agents (Health Analyst, Triage & Safety) implementing the merge/rank pattern; Report Interpreter and Wearable Monitor agents plug into the same orchestration contract when their modules are commissioned.
- **Long-term memory** is persisted in PostgreSQL at MVP scale, behind a repository interface compatible with a later DynamoDB migration.

---

## 3. Delivery Plan — 8 Weeks

### Stage 1 — Infrastructure & RAG Core (Weeks 1–3)

- Provision AWS UAE region infrastructure: ECS Fargate services, GPU instance for NVIDIA NIM, PostgreSQL + pgvector, Redis.
- Deploy and benchmark **Llama 3.1 70B via NVIDIA NIM**: throughput, concurrency, and time-to-first-token validation against the <500ms target.
- Implement the **FastAPI AI microservice**; establish mTLS integration with the ASP.NET Core 6 gateway.
- Build the RAG pipeline: corpus ingestion (DHA/DOH, WHO, NICE, MedlinePlus), chunking strategy, embedding generation, pgvector retrieval with similarity thresholds, prompt assembly.
- Implement **SignalR streaming** end-to-end (gateway → Flutter), including the core structured response types.
- Stand up prompt/response **audit logging**.

**Deliverable:** grounded, streaming, UAE-resident assistant answering from the curated corpora.

### Stage 2 — Safety Layer & Action Execution (Weeks 3–5)

- Implement the **Triage & Safety filter** as post-generation service middleware: emergency keyword detection, diagnostic/prescription language screening, ungrounded-claim checks, `safety_override` response type. Not bypassable via prompt input.
- Build the **clinical evaluation harness**: automated regression execution of the clinician-graded test set, scoring reports for the advisory board, CI integration so every prompt/retrieval change is re-validated.
- Implement the **human review queue** for low-confidence outputs.
- Implement **action execution**: healer booking, centre queries, appointment listing via gateway APIs, with structured tool-call audit records.

**Deliverable:** safety filter validated against the graded test set; in-chat booking operational.

### Stage 3 — Personalization & Production Hardening (Weeks 5–8)

- **Per-request context assembly** from SQL Server (health profile, booking history, consent flags, session ID) with consent-gate enforcement at the data-access layer.
- **Long-term memory**: user learnings and preferences persisted across sessions.
- **Proactive nudges** via FCM push — opt-in, frequency-capped — driven by application events.
- **Observability**: Prometheus metrics and Grafana dashboards covering latency percentiles, token throughput, retrieval hit quality, and safety-filter trigger rates.
- Load testing, retrieval and prompt tuning, deployment runbooks, and handover documentation.

**Deliverable:** production launch of the core Xyra assistant.

---

## 4. Timeline Summary

| Stage | Scope | Duration |
|-------|-------|----------|
| 1 | Infrastructure, self-hosted LLM, RAG core, streaming | 3 weeks |
| 2 | Safety filter, evaluation harness, action execution | 2 weeks |
| 3 | Personalization, nudges, observability, hardening | 3 weeks |

**Total: 8 weeks** from kickoff to production launch, with a demonstrable milestone at the end of each stage.

---

## 5. Project Fee

Fixed project fee: **$8,000 USD** for the complete 8-week core platform delivery.

| Milestone | Payment |
|-----------|---------|
| Kickoff | $2,000 |
| Stage 1 accepted — streaming RAG live in UAE region | $2,000 |
| Stage 2 accepted — safety layer + in-chat booking | $2,000 |
| Stage 3 accepted — production launch | $2,000 |

---

## 6. Follow-On Modules (Optional)

Each module below is an independently scoped and priced engagement that extends the core platform. They can be commissioned in any order after launch.

| Module | Scope | Indicative duration | Indicative fee |
|--------|-------|---------------------|----------------|
| Wearables & proactive monitoring | HealthKit / Health Connect → FHIR R4 ingestion, TimescaleDB baselines, anomaly detection, Kafka event bus, Wearable Monitor agent | 4 weeks | $4,000 |
| Medical report interpretation | Azure Document Intelligence OCR + AWS Comprehend Medical + LOINC reference DB, plain-language explanations, human review hold for critical lab values, Report Interpreter agent | 3–4 weeks | $3,000–4,000 |
| Arabic & voice | Arabic with UAE dialect optimization; STT/TTS voice interface | 4 weeks | $4,000 |
| National health records | Riayati / NABIDH HIE integration — connectivity, record mapping, consent flows (subject to external access approvals) | 4–6 weeks | $4,000–6,000 |
| Model fine-tuning | NVIDIA NeMo closed-loop fine-tuning on user feedback and outcomes, with regression evaluation against the clinical test set | 4 weeks | $4,000 |
| B2B assistants & analytics | Healer-facing and Health-Hub-facing assistants; Redshift analytics pipeline | 3 weeks | $3,000 |

This preserves the full roadmap defined in the architecture document while keeping the initial commitment limited to the core platform.

---

## 7. Assumptions & Dependencies

- **Infrastructure costs** (AWS UAE region, GPU instance for NIM, managed databases, third-party AI services) are billed directly to Hlthera's cloud accounts and are not included in the project fee.
- Hlthera provides access to the **ASP.NET Core 6 gateway** codebase and its booking/centre/appointment APIs, coordination with the **Flutter** client team for response-type integration, and clinician availability for grading the safety test set.
- Third-party licensing (NVIDIA AI Enterprise/NIM; SNOMED CT and LOINC when the relevant modules are commissioned) is procured by Hlthera.
- Gateway-side changes are implemented in coordination with the existing Hlthera engineering team; this engagement covers the AI service and its integration surface.
- **Riayati/NABIDH** integration timelines depend on access, credentials, and documentation from the relevant authorities.

---

I am available to walk through this proposal and adjust stage boundaries, scope, or the payment schedule as needed.

**Contact:** Juan
