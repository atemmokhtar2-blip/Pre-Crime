# Pre-Crime Architecture

## Runtime topology

1. Telegram sends HTTPS POST updates to `/api/telegram/webhook`.
2. The Vercel Node.js Function verifies the configured webhook secret before parsing or processing the update.
3. The ingress layer validates the update envelope and persists it using `update_id` as an idempotency key.
4. A dispatcher routes supported update types to isolated domain modules.
5. Domain services enforce group state, actor permissions, and policy before calling Telegram Bot API methods.
6. The dashboard calls authenticated server-side APIs; it never calls Telegram with the bot token from the browser.

## Application boundaries

- `telegram/`: Bot API client, webhook verification, update parsing, callback payload codecs.
- `groups/`: group onboarding, configuration, bot capability checks, tenant scope.
- `members/`: member records, activity aggregates, join/leave events, notes.
- `moderation/`: warnings, restrictions, bans, anti-flood and content policies.
- `automation/`: welcome flows, scheduled messages, keyword rules.
- `analytics/`: aggregate queries and retention-aware reporting.
- `audit/`: append-only administrative event records.
- `auth/`: dashboard identity, Telegram account linking, session and role checks.
- `db/`: schema, migrations, repositories, transaction boundaries.

## Multi-tenant data model

A Telegram supergroup is a tenant boundary. All group-owned records carry `chat_id` and queries must include it. Global platform operators are separate from group administrators. A user may administer several groups with different roles in each group.

## Webhook reliability

- Verify `X-Telegram-Bot-Api-Secret-Token` using a constant-time comparison.
- Store the update before acknowledging it; use a unique constraint on `update_id`.
- Duplicate updates must be safe no-ops.
- Keep the synchronous webhook path short. Long-running broadcasts, imports, and bulk moderation belong in a durable queue/workflow, not an in-memory background promise.
- Return a non-2xx response for transient persistence failures so Telegram can retry. Do not return success before durable acceptance.
- Configure only the update types the product needs and monitor webhook health.

## Vercel deployment

Use Node.js Functions (Fluid Compute), not the deprecated Edge runtime. Keep the webhook route stateless and store durable state in PostgreSQL. Use Vercel Preview and Production environments with separate credentials. The request/response body limit is 4.5 MB, so media should be referenced by Telegram file identifiers rather than proxied through the webhook.

## Security model

- Webhook secret validation at ingress.
- Dashboard authentication and CSRF-safe mutations.
- Per-group role and capability checks on every action.
- Explicit confirmation for irreversible or bulk actions.
- Audit entries written alongside successful state changes.
- Rate limits on login, webhook administration, search, and moderation endpoints.
- Secret redaction in logs and error reports.

## Initial data entities

`groups`, `users`, `group_members`, `group_admins`, `group_settings`, `telegram_updates`, `moderation_actions`, `warnings`, `automations`, `scheduled_jobs`, `audit_events`, and `daily_group_metrics`.
