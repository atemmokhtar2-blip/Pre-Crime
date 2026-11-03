# Pre-Crime

**Pre-Crime** is an enterprise-grade, multi-tenant Telegram group management platform. It combines a Telegram bot, a secure webhook backend, and a web control panel.

> Current status: architecture and foundation phase. Production activation requires a Vercel project, provisioned database, and Telegram/Vercel secrets.

## Product goals

- Manage many Telegram groups from one bot and one web dashboard.
- Isolate each group's configuration, members, moderation policies, and audit history.
- Make every administrative action explicit, permission-checked, and auditable.
- Use Telegram webhooks on Vercel Functions; do not use long polling.
- Keep the code modular so protection, moderation, analytics, automation, and dashboard features can evolve independently.

## Planned capabilities

1. **Group fleet:** group registry, status, bot permissions, settings, per-group onboarding.
2. **Member intelligence:** member profiles, join/leave history, activity summaries, warnings, restrictions, notes.
3. **Protection:** anti-spam, flood control, link/media policies, suspicious join patterns, configurable escalation.
4. **Moderation:** warn, mute, unmute, restrict, ban, unban, message deletion, bulk actions with confirmation.
5. **Automation:** welcome/goodbye flows, scheduled announcements, keyword rules, configurable triggers.
6. **Admin governance:** roles, granular permissions, approval gates for destructive actions, immutable audit trail.
7. **Analytics:** member growth, message activity, moderation trends, top contributors, per-group comparisons.
8. **Operations:** webhook health, delivery failures, replay-safe update processing, diagnostics, retention controls.

## Architecture

- **Web:** Next.js App Router dashboard.
- **API:** Node.js Vercel Functions.
- **Telegram ingress:** POST /api/telegram/webhook.
- **Persistence:** PostgreSQL (Neon via Vercel Marketplace) for durable records.
- **Optional cache/limits:** Upstash Redis only when measured traffic justifies it.
- **Deployment:** Git-connected Vercel project, separate Preview and Production environments.

See [Architecture](docs/ARCHITECTURE.md) and [Feature plan](docs/FEATURES.md).

## Security principles

- Verify Telegram's X-Telegram-Bot-Api-Secret-Token header on every webhook request.
- Keep bot tokens, webhook secrets, database credentials, and session keys in Vercel encrypted environment variables only.
- Never trust a chat ID, Telegram user ID, callback payload, or dashboard request without server-side authorization.
- Scope every database operation by tenant/group and enforce admin permissions server-side.
- Make webhook update handling idempotent using Telegram's update_id.
- Record who performed each administrative action, what changed, when, and against which group.
- Do not log secrets or full sensitive payloads.

## Required environment

See .env.example. Do not commit real credentials.

## Development

The project foundation will be added in stages after the Vercel project and database integration are provisioned. Production webhook activation must wait until the database schema, secret header, and Telegram setWebhook configuration are verified.
