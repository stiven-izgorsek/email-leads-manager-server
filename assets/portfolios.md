Image Processing

https://www.viesus.cloud - Account: apptesting.d+123@gmail.com/Test1234@
https://dev.viesus.cloud/

- Shipped Viesus Cloud, a subscription SaaS for AI-powered photo enhancement at scale (folders, workflows, credits, and self-serve billing).
- Served users and teams who need repeatable, high-volume image quality, not one-off edits, with API keys and webhooks for integration into broader pipelines.
- Owned outcomes across product UX, reliability of long-running jobs, and alignment of usage/credits with Stripe-backed plans.
- Built the Next.js / React client with GraphQL (codegen), NextAuth, TanStack Query / Zustand, and Pusher for live enhancement status.
- Implemented Sanity CMS-driven marketing and in-app content where applicable.
- Developed the Fastify + Mercurius GraphQL API with Pothos, Prisma, PostgreSQL, and BullMQ on Redis for worker orchestration (including S3 download/upload around the Viesus engine).
- Integrated AWS S3, Stripe, Postmark, ActiveCampaign, and observability (Sentry, structured logging / Axiom).

Script
This is Viesus Cloud, a subscription SaaS for AI-powered photo and PDF enhancement—users upload files into folders, run enhancements with presets and detailed controls (upscaling, noise, faces, backgrounds, and more), and get results stored in the cloud with credit-based usage tied to Stripe billing. I built the full Next.js / React frontend that talks to a GraphQL API, handles login and account flows, and shows live job progress via real-time updates so long-running jobs don’t stall the UI. On the backend I worked with a Fastify + GraphQL service, PostgreSQL via Prisma, S3 for uploads and outputs, and Redis / BullMQ workers that orchestrate processing: images go through a native Viesus enhancement pipeline with config files and preview modes where appropriate; PDFs are handled in two steps—analysis first (to estimate scope and credits), then enhancement with the same parameter model, reconciling actual vs estimated credits. Other features include workflows (folder-based automation), webhooks and API keys for integrations, batch exports, transactional email and marketing sync, and CMS-driven marketing content—overall a production system with observability and third-party services wired around a clear upload → queue → process → store → notify path.

=====================================================
E-commerce

Tech-Focused Version (Engineering / Shopify / Systems)
- Built and customized a full-scale eCommerce platform using Shopify, including theme customization and storefront optimization
- Implemented end-to-end shopping flow: product catalog, cart system, checkout, and order management
- Integrated third-party services including payment gateways and BNPL provider (Sezzle) for flexible checkout experiences
- Configured analytics and tracking infrastructure (Facebook Pixel, Pinterest Tag) for user behavior tracking and conversion optimization
- Optimized frontend performance and responsiveness to improve load times and user experience across devices
- Managed product data, collections, and inventory workflows within Shopify ecosystem
- Ensured reliability and maintainability of the platform while supporting traffic growth and transaction scalability

Business-Focused Version (Ecommerce / Growth / Product)
- Developed and managed an eCommerce platform for consumer retail (lighter & vape products), optimizing for conversion and user purchase flow
- Delivered a seamless online shopping experience including product discovery, cart, checkout, and payment integrations
- Implemented marketing and analytics tools (tracking pixels, conversion tracking) to support customer acquisition and campaign performance
- Integrated flexible payment solutions (e.g., BNPL) to improve checkout conversion and customer affordability
- Optimized product pages, navigation, and promotional flows to increase average order value and customer retention
- Ensured smooth order lifecycle experience including checkout, shipping communication, and transactional workflows
- Contributed to platform performance and scalability, supporting thousands of monthly visitors and consistent transaction volume

=====================================================
Pet Care

https://digitail.com
https://play.google.com/store/apps/details?id=com.digitail.digitail&hl=en

- Developed a pet care application using React and React Native for the frontend and Python for the backend, delivering a responsive and intuitive platform.
- Collaborated with the product management team to conduct user interviews, surveys, and competitor analysis to identify user pain points and market gaps
- Created user personas to represent diverse user types, ensuring that designs and features reflected specific user needs
- Worked closely with cross-functional teams to prioritize features, focusing on a personalized dashboard for tracking pets' health and fitness metrics
- Adopted an agile methodology, enabling iterative development and regular user feedback to refine features
- Partnered with UI/UX designers to design an intuitive interface, conducting usability testing to validate design decisions before implementation
- Monitored user engagement metrics (e.g., daily active users, session durations, and feature usage) to evaluate application performance and drive improvements
- Collected post-launch feedback through surveys and support tickets to refine features and enhance user satisfaction
- Achieved a 40% increase in user engagement within three months of launch, surpassing initial projections, with positive user feedback on personalized features
=====================================================
E-Learning

http://talaera.com/

FE Focused
Business-focused (outcomes, users, product)
- Delivered features for a B2B/B2C e-learning web app used for live English training, self-study content, and team/company programs.
- Improved learner and instructor workflows: scheduling and session-related UI, progress and assessment touchpoints, and onboarding flows.
- Shipped content consumption experiences: course/library navigation, exercises and homework, and discovery (search/tags).
- Supported organizational needs: team/company views and reporting-related entry points in the product.
- Partnered with design and backend to ship end-to-end flows while keeping accessibility, i18n, and consistent UX in a large, mature codebase.
- Contributed to quality through structured testing handoffs (e.g. alignment with E2E strategy) and careful handling of auth/session behavior in production.

Tech-focused (stack, architecture, engineering)
- Built and maintained a React + TypeScript SPA (Create React App / react-app-rewired) with React Router v6 and a large shared component/page structure.
- Implemented UIs against a REST API (e.g. superagent), including cookie-based auth and HTTPS-sensitive integration patterns.
- Worked with Material UI v4, forms, tables, calendars, charts (Recharts), and complex list/detail flows across learner, instructor, and admin areas.
- Integrated third-party client SDKs where the product required: e.g. video/session-related flows (OpenTok, Zoom Video SDK), Stripe payments, and other product integrations (Firebase, AWS client usage as applicable).
- Added or extended rich content experiences: WYSIWYG/editor-related stacks (Quill, collaborative editing via ot.js), and content/admin tooling.
- Implemented internationalization with i18next and workflows tied to translation/source updates.
- Collaborated on performance and UX of heavy pages (large lists, media, modals) and maintained consistency across role-based route sets (user vs admin vs customer-service).

BE Focused
- Business-focused (product, reliability, stakeholders)
- Designed and implemented REST APIs powering learner/instructor flows: accounts, profiles, sessions/lessons, progress and levels, teams and organizations, and billing-related operations.
- Owned parts of the data model and migrations, keeping schema changes safe for production releases across a large, long-lived product.
- Integrated third-party services used in production (payments, communications, video, CRM/support, cloud providers) behind stable server contracts for web and mobile clients.
- Supported security and compliance-oriented features: authentication patterns, MFA, SSO/SAML-related integration points, and careful handling of PII in APIs and jobs.
- Built or maintained background/async processing for notifications, tasks, and other non-request work so core user flows stay responsive.
- Partnered with frontend and operations on API versioning, observability, and incident response (logging, config, operational behavior).

Tech-focused (stack, architecture, engineering)
- Developed a Python backend using Pyramid (WSGI), structured as REST resources with Cornice, validation (Colander), and transactional DB access (SQLAlchemy + zope.sqlalchemy / pyramid-tm patterns).
- Maintained PostgreSQL persistence with SQLAlchemy ORM and Alembic migrations; implemented domain logic across a large srv/ codebase (models, views, schemas).
- Implemented and documented extensive HTTP APIs (large API.md surface): users, students/instructors, sessions, adaptive testing, teams, invoices, admin operations, and more.
- Integrated external SDKs/APIs: Stripe, OpenTok, Zoom-related flows, Vonage, Slack, Intercom, HubSpot, Google APIs (e.g. translate), FCM push, AWS via boto3, Redis, SAML SSO, etc., as product needs required.
- Worked with async/task execution via internal task tooling (premier) and related operational constraints (retries, idempotency where applicable).
- Added AI/NLP-related capabilities where applicable (OpenAI, NLTK, spaCy) in service utilities.
- Wrote tests with pytest / WebTest and followed team conventions (pre-commit, formatting, conventional commits).
=====================================================
Pump Manufacturing
Business focused
- Rebuilt core pump-selection logic for the web by analyzing a legacy C# desktop application and reproducing its hydraulic behavior in a server-side service, so customers no longer depend on an install-only tool.
- Translated complex engineering calculations and curve behavior into a backend used by the online pump configurator, with results consumed by the web app for search, comparison, and reporting.
- Delivered curve data through APIs so the web UI plots Q–H-style performance consistently with the old desktop tool, reducing disagreement between sales channels.
- Partnered with the web frontend to turn those results into an interactive chart experience (duty points, operating context) that matches how engineers work in the browser instead of a fat client.
- Supported export and sharing by connecting on-screen curves and tables to PDF-oriented workflows, so stakeholders get the same story in meetings and in written offers.
- Reduced reliance on knowledge trapped in desktop code by making behavior accessible through documented APIs and a maintained web product the business can evolve.


Tech focused
- Reverse-engineered and ported hydraulic calculation pipelines from a complex C# desktop codebase to Python on Django REST Framework, preserving numerical behavior for performance data and curve generation.
- Implemented server-side curve computation (batch/single/multi-speed, duty-point) with NumPy/SciPy, exposing JSON for the SPA instead of desktop chart components.
- On the Nuxt 3 / Vue 3 / TypeScript client, visualized backend curve payloads with ECharts (line/scatter series, duty-point overlays, VFD vs fixed-speed cases) via shared composables and state (e.g. Pinia).
- Integrated unit conversion and i18n on the UI so plotted values and tables stay consistent with user settings while still tracing back to the same server-side math.
- Implemented chart-to-PDF paths (ECharts → SVG/PDF pipelines, related table PDFs) so rendered curves could be reproduced in downloadable documents, not only on screen.
- Worked across REST contracts (OpenAPI-backed backend + typed client usage) to keep curve batches and duty-point updates in sync between backend refactors and frontend chart code.

https://hidrostal.com/ (World's Largest Pump Manufacturing Company)
https://hidroselect-dev.pas-app.com/
https://hidroselect.hidrostal.com/
=====================================================
Healthcare
https://twiper.me/


Business-Focused Version (Product / Impact Oriented)
- Conceptualized and launched an AI-powered healthcare assistant platform to improve accessibility to preliminary medical guidance through conversational UX
- Designed the product experience end-to-end, focusing on intuitive chat interactions, user trust, and clear communication of AI-generated health information
- Delivered a responsive, cross-device web application to ensure accessibility for a broad user base
- Translated complex healthcare and AI concepts into a simple, user-friendly interface, improving usability for non-technical users
- Implemented safeguards and response structuring to improve reliability and reduce misleading or unsafe AI outputs
- Iterated on product features based on user behavior and feedback, enhancing engagement and session quality
- Owned full product lifecycle including ideation, development, deployment, and continuous improvement

Tech-Focused Version (Engineering / Systems Oriented)
- Architected and developed a full-stack AI chatbot platform for healthcare-related query handling using modern web technologies
- Built and integrated LLM-based conversational pipelines, including prompt engineering and response post-processing for improved accuracy and safety
- Developed scalable backend services and APIs to manage real-time chat interactions, session state, and request handling
- Engineered a dynamic frontend chat interface with responsive design and seamless real-time user experience
- Implemented structured validation and guardrails to mitigate AI hallucinations and ensure more reliable outputs
- Designed and deployed the application in a production environment, considering performance, scalability, and maintainability
- Optimized system responsiveness and latency for smoother user interactions in AI-driven conversations
=====================================================
MQTT
- Designed and implemented a real-time MQTT ingestion service for battery and energy telemetry using Python
- Integrated with mTLS-secured MQTT broker and handled certificate-based authentication via AWS Secrets Manager
- Built a robust data pipeline (MQTT → validation → PostgreSQL) with <2s ingestion latency
- Implemented protobuf-based decoding for battery (BESS), PV, and site power telemetry
- Designed relational database schemas aligned with production energy data models
- Ensured data integrity and idempotent ingestion with validation and unique constraints
- Developed fault-tolerant system with auto-reconnect, error handling, and graceful shutdown
- Delivered a production-ready MVP deployed on AWS EC2 with integration to existing RDS instance

https://www.gridual.ai/
=====================================================
Fintech
- Led end-to-end delivery of a fund-marketing platform that lets asset managers produce configurable factsheets and embed fund content on their own websites.
- Implemented scheduled factsheet generation so sales and marketing teams receive refreshed PDFs on daily, weekly, monthly, or yearly cadences without manual rebuilds.
- Automated distribution of regulatory and sales documents by syncing prospectuses, PRIIPs, annual and half-year reports, and ESG disclosures from an external fund-document feed into HubSpot file libraries with stable ISIN-based naming.
- Built ingestion workflows that pull attachments from connected mailboxes via Nylas, parse accompanying CSV data, and track processing status with ISIN extraction for downstream use.
- Ran scheduled jobs that ingest index and market history from providers such as Solactive so charts and performance narratives in factsheets and widgets stay current.
- Delivered a widget and CDN-style embedding model so customers configure fund widgets in the product and surface them on corporate sites and campaign pages aligned with marketing operations.
- Extended the same product surface to portfolio file uploads and ESG content so performance, holdings, and sustainability messaging stay in one coherent workflow.



https://cixon.de/

https://doc-generator.cixon.finance/
=====================================================
CRM 

- Designed and implemented advanced CRM features across the application, focusing on functionality, scalability, and user experience
- Developed a modern, responsive frontend using Nuxt.js, Pinia for store management, and NuxtUI (based on Tailwind CSSՅ to maintain a clean design system
- Built a real-time email communication system on the frontend using Socket.io, providing instant notifications and seamless interactions
- Created dynamic features like chart visualizations, PDF/Word document generation and modification, task management tool and advanced column handling and filtering systems, similar to HubSpot
- Engineered the backend using Express.js and MongoDB, leveraging both GraphQL and REST APIs to serve diverse application needs
- Integrated Nylas to implement core email and calendar features, enabling users to send/receive emails, synchronize data, and schedule events programmatically
- Deployed the application using GitHub Actions and Nginx, ensuring smooth CI/CD workflows and reliable development environments
- Conducted unit and end-to-end testing using Jest and Cypress, ensuring high-quality and bug-free functionality
- Utilized Keycloak for secure authentication and identity management, streamlining user access controls
- Collaborated closely with design and product teams to create a highly interactive, user-friendly CRM platform
- Optimized performance and adhered to best practices throughout development, enhancing the platform’s responsiveness and efficiency

https://sigura.be/
https://sigura4.sigura.eu/

