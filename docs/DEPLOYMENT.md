# Deployment notes — Stripe webhook, Notion provisioning, PostHog telemetry

## Environment variables (required)
- STRIPEAPIKEY - your Stripe secret key (starts with sk_...)
- STRIPEWEBHOOKSECRET - Stripe webhook signing secret for the endpoint
- NOTIONAPIKEY - Notion integration token (secret)
- NOTIONDATABASEID - Notion database ID to create rows in
- POSTHOGAPIKEY - PostHog project API key
- POSTHOG_HOST - Optional (if self-hosted), e.g. https://app.posthog.com

Do NOT commit these values. Use your platform's secret management (Vercel/GCP/Heroku).

## Registering the Stripe webhook
1. Deploy or run the site locally and note the webhook URL:
   - Production: https://your-domain.com/api/webhooks/stripe
   - Local (with Stripe CLI): http://localhost:3000/api/webhooks/stripe
2. In the Stripe Dashboard → Developers → Webhooks → Add endpoint:
   - URL: https://<your-domain>/api/webhooks/stripe
   - Events: checkout.session.completed, invoice.payment_succeeded, payment_intent.succeeded
3. Copy the "Signing secret" into STRIPEWEBHOOKSECRET.

## Notion setup
1. Create a Notion integration and copy the integration token (NOTIONAPIKEY).
2. Create a database with properties:
   - Name (Title)
   - Email (Text / Rich Text)
   - Stripe Session (Text)
   - Status (Select; example values: Pending, Active)
3. Share the database with the integration and copy the database id into NOTIONDATABASEID.

## PostHog
- Use app.posthog.com or your self-hosted host. Copy the API key to POSTHOGAPIKEY.
- Optionally set POSTHOG_HOST for self-hosted deployments.

## Local development (Stripe CLI)
Install the Stripe CLI and forward events to your local server:
stripe listen --forward-to localhost:3000/api/webhooks/stripe

You can trigger test events:
stripe trigger checkout.session.completed

## Security & operational notes
- Keep all keys secret (do not commit).
- Set request size / timeout limits on your runtime.
- Stripe will retry failed webhook deliveries; ensure handlers are idempotent.
- Production: consider background job processing / retries for Notion updates to avoid blocking webhook processing.
