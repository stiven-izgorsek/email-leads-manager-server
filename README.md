# Email Leads Manager Server

Backend API for the Email Leads Manager application. Built with Node.js, Express, PostgreSQL, and TypeORM.

## Features

- **RESTful API** for leads, mailboxes, accounts, templates, CRM clients, companies, portfolios, and users
- **PostgreSQL** with TypeORM entities and versioned migrations
- **JWT authentication** with HTTP-only cookies (middleware available but disabled by default on routes)
- **Lead management** — CRUD, filters, bulk update/delete, CSV/XLSX upload, Millions email verification
- **Outbound marketing** — auto-assign leads to mailboxes, template/AI compose, Nylas send pipeline
- **Follow-up campaigns** — second-touch assignments with reply guards
- **Nylas integration** — send/reply, unread polling, incoming message inbox, calendar sync
- **CRM clients** — pipeline statuses, follow-ups, sent-by mailbox tracking
- **Templates** — subject and message templates with `{{placeholder}}` rendering and AI generation
- **Companies** — Apollo search/import, saved searches, CSV export
- **Incoming messages** — classification rules, Slack notifications, manual reply
- **Calendar** — Nylas events plus local recurring events
- **Application helpers** — OpenAI-powered cover letters and message replies
- **Pagination, search, and filtering** on list endpoints
- **CORS** enabled with credentials for frontend and browser extensions

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js (ES modules) |
| Web | Express.js |
| Database | PostgreSQL |
| ORM | TypeORM |
| Auth | JWT + bcryptjs + cookie-parser |
| Uploads | multer |
| CSV | csv-parser |
| Spreadsheets | xlsx |

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ (local or remote)
- Optional integrations: Nylas (per-mailbox grant/key), OpenAI, Apollo, Millions Verify, Slack webhook

## Installation

1. Install dependencies:

```bash
npm install
```

2. Create environment file:

```bash
cp .env.example .env
```

3. Edit `.env` with your PostgreSQL credentials and any integration API keys.

4. Create the database (if it does not exist):

```sql
CREATE DATABASE email_leads_manager;
```

5. Run migrations (recommended for production and after pulling schema changes):

```bash
npm run migration:run
```

In development, TypeORM `synchronize` is enabled when `NODE_ENV !== 'production'`, so the schema can auto-update locally. Prefer migrations in shared/staging/production environments.

6. Start the server:

```bash
# Development (auto-reload on file changes)
npm run dev

# Production
npm start
```

Default URL: `http://localhost:4000`  
Health check: `GET /health`

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with `node --watch` |
| `npm start` | Start server |
| `npm run migration:run` | Apply pending TypeORM migrations |
| `npm run migration:revert` | Revert last migration |
| `npm run import:leads` | Import leads from CSV via CLI script |
| `npm run cleanup:client` | Client cleanup utility script |

## Background Jobs

On startup the server also:

- Releases orphaned marketing/follow-up “running” mailbox flags after a crash/restart
- Starts **Nylas unread polling** for incoming messages (`NYLAS_POLL_MS`, default 60s)
- Starts **calendar sync** from Nylas grants (`CALENDAR_SYNC_INTERVAL_MS`, default 1 hour)

## API Overview

All routes are prefixed with `/api` unless noted.

### Health

- `GET /health` — server status

### Authentication

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`

### Leads (`client` table)

- `GET /api/leads` — paginated list (`page`, `limit`, `search`, `status`, `assignedTo`, `location`, `leadFilterIds`, …)
- `GET /api/leads/uncontacted` — pool for marketing assignment
- `GET /api/leads/filters` — saved lead filters
- `GET /api/leads/dashboard-kpis`
- `GET /api/leads/emails-date-range`
- `GET /api/leads/followup-candidates`
- `POST /api/leads` — create lead
- `POST /api/leads/upload` — CSV/XLSX upload (`multipart/form-data`, field `file`)
- `POST /api/leads/bulk-delete`, `POST /api/leads/bulk-update`
- `POST /api/leads/bulk-verify-emails`, `POST /api/leads/bulk-verify-all-new`
- `GET /api/leads/verification-status/:jobId`
- `GET /api/leads/new-leads-verification-count`
- `GET /api/leads/download-new-csv`
- `PUT /api/leads/:clientId/mark-sent`
- `POST /api/leads/mark-followed-up`

### Accounts

- `GET /api/accounts`, `GET /api/accounts/:id`
- `POST /api/accounts`, `PUT /api/accounts/:id`, `DELETE /api/accounts/:id`

### Emails (mailboxes)

- `GET /api/emails`, `GET /api/emails/:id`, `GET /api/emails/:id/detail`
- `POST /api/emails`, `PUT /api/emails/:id`
- `POST /api/emails/upload` — bulk mailbox import
- `POST /api/emails/bulk-delete`, `POST /api/emails/bulk-update`
- `GET /api/emails/nylas-integration-status`
- `GET /api/emails/recipients/lookup?emails=a@x.com,b@y.com` — lead/CRM lookup for compose
- `POST /api/emails/:id/send` — send email via Nylas from mailbox

### Templates

- `GET /api/subject-templates`, `POST /api/subject-templates`
- `GET /api/message-templates`, `POST /api/message-templates`
- `POST /api/message-templates/generate` — AI batch generation
- `PUT /api/message-templates/:id`
- `POST /api/compose-email` — pick templates + render placeholders for a lead
- `POST /api/compose-ai-email` — AI industry classification + compose
- `POST /api/render-template-content` — render arbitrary template text with lead/sender vars

### Marketing

- `GET /api/marketing/dashboard`
- `GET /api/marketing/assignments/:emailId/leads`
- `PATCH /api/marketing/emails/:emailId/enabled`
- `POST /api/marketing/assign`, `POST /api/marketing/assign-all`
- `POST /api/marketing/start/:emailId`, `POST /api/marketing/start-all`
- `POST /api/marketing/unassign-all-pending`
- `DELETE /api/marketing/assignments/leads/:assignmentLeadId`
- `POST /api/marketing/reset-daily-sent`, `POST /api/marketing/release-stuck-runs`

### Follow-up

- `GET /api/followup/dashboard`
- `GET /api/followup/assignments/:emailId/leads`
- `PATCH /api/followup/emails/:emailId/enabled`
- `POST /api/followup/assign`, `POST /api/followup/assign-all`
- `POST /api/followup/start/:emailId`, `POST /api/followup/start-all`, `POST /api/followup/stop-all`
- `POST /api/followup/unassign-all-pending`
- `DELETE /api/followup/assignments/leads/:assignmentLeadId`
- `POST /api/followup/reset-daily-sent`, `POST /api/followup/release-stuck-runs`

### CRM Clients

- `GET /api/crm-clients`, `GET /api/crm-clients/:id`
- `POST /api/crm-clients`, `PUT /api/crm-clients/:id`, `DELETE /api/crm-clients/:id`
- `GET /api/crm-clients/statuses`
- `GET /api/crm-clients/counts-by-sent-account`
- `GET /api/crm-clients/follow-ups/today`

### Incoming Messages

- `GET /api/incoming-messages`, `GET /api/incoming-messages/unread-count`
- `GET /api/incoming-messages/:id/content`, `GET /api/incoming-messages/:id/replies`
- `POST /api/incoming-messages/:id/reply`
- `GET /api/message-type-rules`, `POST /api/message-type-rules`, …

### Calendar

- `GET /api/calendar/events`, `POST /api/calendar/sync`
- `POST /api/calendar/local-events`, `PATCH /api/calendar/local-events/:id`, …

### Companies

- `GET /api/companies`, `GET /api/companies/:id`, `POST /api/companies`, …
- `POST /api/companies/apollo/search`, `POST /api/companies/apollo/extract/csv`, …
- `GET /api/companies/saved-searches`, `GET /api/companies/export/csv`

### Portfolios

- `GET /api/portfolios`, `GET /api/portfolios/:id`, `POST /api/portfolios`, …

### Application (OpenAI)

- `POST /api/application/cover-letter`
- `POST /api/application/answer`
- `POST /api/application/message-reply`

### Users

- `GET /api/users`

## Database Entities

Leads are stored in the **`client`** table (API paths use `/leads`). Other main entities:

| Entity | Purpose |
|--------|---------|
| `User` | App login |
| `Account` | Sales/account owner linked to mailboxes |
| `Email` | Mailbox (address, Nylas grant/key, marketing/follow-up flags) |
| `Client` | Lead/contact record |
| `Template` | Subject + message templates (`subject`, `outreach`, `followup`, `2nd-followup`) |
| `LeadFilter` | Saved lead filter definitions |
| `CrmClient` | CRM pipeline client |
| `Company`, `CompanySavedSearch` | Company research / Apollo |
| `Portfolio` (+ industries, tags, work experience) | Portfolio profiles |
| `IncomingMessage`, `IncomingMessageReply` | Nylas inbox + manual replies |
| `MessageTypeRule` | Incoming message classification |
| `MarketingAssignment`, `MarketingAssignmentLead` | Outbound marketing runs |
| `FollowupAssignment`, `FollowupAssignmentLead` | Follow-up campaigns |
| `CalendarEvent`, `CalendarEventLocal`, `CalendarEventLocalException` | Calendar data |

Migrations live in `src/migrations/`.

## Authentication

JWT auth middleware exists in `src/middleware/auth.js` but is **commented out** on most route files. To enable:

1. Uncomment `authenticateToken` import in the route file(s)
2. Uncomment `router.use(authenticateToken)`

Tokens are issued on login and stored in HTTP-only cookies.

## CSV Lead Upload

Upload via `POST /api/leads/upload` with field name `file`. Supports CSV and Excel.

Headers are matched case-insensitively (spaces ignored). Common columns:

| Column | Notes |
|--------|-------|
| `Email` | Required; also accepts `workemail`, `e-mail`, etc. |
| `Email_2`, `Email_3`, … | ContactOut-style alternates; first non-empty wins |
| `First Name`, `Last Name` | |
| `Company`, `Company URL`, `Job Title` | |
| `LinkedIn`, `Location`, `Company Location` | |
| `Status`, `Industries`, `Tech` | |
| `Sent By`, `Contacted By` | |

See `src/utils/csvLeadImport.js` for normalization logic.

## Environment Variables

### Core

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `4000` |
| `NODE_ENV` | `development` enables TypeORM synchronize | `development` |
| `JWT_SECRET` | JWT signing secret | *(required in production)* |
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_USERNAME` | PostgreSQL user | `postgres` |
| `DB_PASSWORD` | PostgreSQL password | `postgres` |
| `DB_NAME` | Database name | `email_leads_manager` |
| `DB_POOL_MAX` | Connection pool size | `20` |

### Integrations

| Variable | Description |
|----------|-------------|
| `OPEN_AI_API_KEY` / `OPENAI_API_KEY` | OpenAI for compose, application, AI templates |
| `OPEN_AI_MODEL` | Model name (default `gpt-4o-mini`) |
| `OPEN_AI_TIMEOUT_MS` | OpenAI request timeout |
| `APOLLO_API_KEY` | Apollo company search |
| `MILLIONS_API_KEY` | Millions Verify email validation |
| `SLACK_INCOMING_MESSAGES_WEBHOOK` | Slack alerts for new incoming mail |
| `NYLAS_REGION` | Optional Nylas region hint (`us` / `eu`) |

Nylas credentials are stored **per mailbox** in the database (`grantId`, `nylasKey` on `Email` rows), not in `.env`.

### Marketing & follow-up

| Variable | Description | Default |
|----------|-------------|---------|
| `MARKETING_USE_AI_COMPOSE` | Use AI template selection for sends | `true` |
| `MARKETING_SEND_DELAY_MIN_MS` | Min delay between sends | `180000` (3 min) |
| `MARKETING_SEND_DELAY_MAX_MS` | Max delay between sends | `300000` (5 min) |
| `MARKETING_MAX_PARALLEL_MAILBOXES` | Concurrent marketing mailboxes | `5` |
| `MARKETING_STUCK_RUNNING_MS` | Stuck run timeout | `2700000` (45 min) |
| `FOLLOWUP_MAX_PARALLEL_MAILBOXES` | Concurrent follow-up mailboxes | `5` |
| `FOLLOWUP_STUCK_RUNNING_MS` | Stuck follow-up timeout | same as marketing |
| `FOLLOWUP_ASSIGN_ALL_CONCURRENCY` | Parallelism for assign-all | `4` |

### Nylas polling & calendar

| Variable | Description | Default |
|----------|-------------|---------|
| `NYLAS_POLL_MS` | Incoming message poll interval | `60000` |
| `NYLAS_POLL_STAGGER_MS` | Stagger between mailbox polls | `400` |
| `NYLAS_PAGE_GAP_MS` | Delay between Nylas API pages | `150` |
| `NYLAS_429_MAX_RETRIES` | Retries on rate limit | `2` |
| `CALENDAR_SYNC_INTERVAL_MS` | Calendar sync job interval | `3600000` |
| `CALENDAR_SYNC_DAYS_BACK` | Days of history to sync | *(service default)* |
| `CALENDAR_SYNC_DAYS_FORWARD` | Days ahead to sync | *(service default)* |

## Project Structure

```
src/
  config/         Database connection
  controllers/    Route handlers
  entities/       TypeORM entity schemas
  middleware/     Auth, etc.
  migrations/     SQL migrations
  routes/         Express routers
  services/       Business logic (Nylas, marketing, follow-up, …)
  utils/          CSV import, email HTML, rate limits
scripts/          CLI utilities (migrations, import, diagnostics)
```

## License

ISC
