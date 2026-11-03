# Deployment Runbook

## Vercel project

The Vercel project is named `pre-crime` and is connected to `atemmokhtar2-blip/Pre-Crime`. Deployments are driven by Git pushes. Preview and Production environment variables must be configured separately.

## Deployment protection

The Vercel project currently has SSO deployment protection enabled for deployment URLs, while custom domains are excluded. Telegram cannot complete a Vercel SSO challenge. Before registering the webhook, either attach the intended production custom domain (and verify it is not protected) or explicitly adjust production deployment protection after dashboard authentication is implemented. Do not expose an unauthenticated admin dashboard just to make the webhook public.

## Provision the database

1. Open the Vercel project and open Storage / Marketplace.
2. Add a Neon Postgres integration to this project.
3. Ensure the integration injects `DATABASE_URL` into Development, Preview, and Production as appropriate.
4. Apply `db/schema.sql` once to the selected database, then manage future changes through versioned migrations.
5. Do not put a database URL in GitHub, source files, or chat.

## Configure secrets

Add these as encrypted Vercel environment variables (not plain text):

- `TELEGRAM_BOT_TOKEN`: token from BotFather.
- `TELEGRAM_WEBHOOK_SECRET`: random value 1–256 characters using only A–Z, a–z, 0–9, underscore, and hyphen.
- `DATABASE_URL`: supplied by the provisioned Neon integration.
- `AUTH_SECRET`: a long random secret for dashboard sessions (dashboard auth is a later phase).
- `APP_URL`: the canonical HTTPS production URL.

Never share the bot token or webhook secret in source control or support messages.

## Set Telegram webhook

After the first successful deployment and database migration, set the webhook to:

`https://YOUR-PRODUCTION-DOMAIN/api/telegram/webhook`

Call Telegram's `setWebhook` method with:

- `url`: the HTTPS endpoint above.
- `secret_token`: the exact value of `TELEGRAM_WEBHOOK_SECRET`.
- `allowed_updates`: explicitly selected message, edited_message, callback_query, my_chat_member, chat_member, and chat_join_request update types as the corresponding features are enabled.
- `drop_pending_updates`: false for a normal rollout unless intentionally discarding backlog.

Telegram sends the secret in `X-Telegram-Bot-Api-Secret-Token`. The webhook handler validates it before accepting updates. Do not configure long polling while the webhook is active.

## Verify

1. Open `/api/health`; confirm the app responds and required variables are configured.
2. Confirm the database schema exists.
3. Set the webhook and check Telegram's `getWebhookInfo` result.
4. Add the bot to a test supergroup with only the permissions needed for the test.
5. Confirm an update is persisted in `telegram_updates`; resend the same update and verify the unique `update_id` prevents duplicate insertion.
6. Check Vercel runtime logs for failures without exposing tokens or message contents.

## Current implementation boundary

The current webhook provides secret validation and durable, idempotent update receipt. It does not yet execute moderation or automation actions. Those are implemented in the domain-dispatch phase after database provisioning and verification.
