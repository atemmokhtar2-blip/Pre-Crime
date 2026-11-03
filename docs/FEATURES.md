# Feature Plan

## Control center

- Fleet overview: managed groups, member totals, open alerts, recent moderation actions, webhook status.
- Group switcher with independent settings and health indicators.
- Search across groups, members, actions, and audit history.

## Group management

- Guided onboarding when the bot is added to a group.
- Verify administrator status and required Telegram permissions.
- Group profile, locale, timezone, welcome configuration, and moderation defaults.
- Pause/resume automation without removing the bot.

## Member management

- Searchable member directory with username, Telegram ID, join date, status, role, warnings, and recent activity.
- Member detail page with moderation timeline and admin notes.
- Warn, mute, unmute, restrict, ban, unban, and remove restrictions.
- Bulk actions require preview, permission check, and explicit confirmation.

## Protection center

- Flood detection with configurable message windows and escalation.
- Link, invite, forward, media, and file policies.
- Duplicate-message and repeated-mention detection.
- New-member verification rules and join-spike alerts.
- Allow lists, deny lists, exemptions, and per-group policy presets.
- Every rule has an enabled state, severity, threshold, action, and audit trail.

## Admin governance

- Roles: owner, administrator, moderator, analyst, and custom roles.
- Granular permissions for member actions, settings, automation, exports, and audit access.
- Optional approval workflow for mass bans, group-wide restrictions, and policy changes.
- Session/device history and revocation for dashboard accounts.

## Automation studio

- Welcome and goodbye messages with safe variable substitution.
- Scheduled announcements with timezone-aware scheduling.
- Keyword and event-based rules with dry-run preview.
- Rate limits and delivery history for each automation.

## Analytics

- Member growth, joins/leaves, message volume, active members, moderation volume, and rule effectiveness.
- Date range and per-group comparisons.
- Exportable reports with permission checks and audit records.

## Delivery phases

### Phase 0 — repository and deployment foundation

Architecture, project wiring, secrets, database provisioning, migrations, webhook health endpoint, CI checks.

### Phase 1 — secure bot core

Webhook verification, update idempotency, group onboarding, permission checks, Telegram API client, audit log.

### Phase 2 — operational moderation

Member directory, warnings, mute/ban flows, moderation history, anti-flood and link policies.

### Phase 3 — web control panel

Authentication, group fleet, member detail pages, settings, action confirmations, audit explorer.

### Phase 4 — automation and analytics

Welcome flows, scheduled messages, rule engine, dashboards, reports.

### Phase 5 — enterprise hardening

Approval workflows, retention policies, observability, load tests, disaster recovery, security review.

## Product rule

No UI-only controls: every visible action must have a server-side permission check, a real domain operation, a result state, and an audit record. Destructive actions require a reason and confirmation.
