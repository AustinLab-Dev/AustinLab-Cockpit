## Stripe Setup

### Environment Variables
Set the following in `.env` and in your Vercel project settings:

- `STRIPE_SECRET` → Your Stripe secret key (starts with `sk_...`)
- `STRIPE_WEBHOOK_SECRET` → The webhook signing secret from Stripe Dashboard
- `APP_URL` → Your deployed app URL (e.g. `https://your-app.vercel.app`)

### Webhook Configuration
1. In Stripe Dashboard, go to **Developers → Webhooks**.
2. Create a new endpoint:
   - URL: `https://your-app.vercel.app/api/billing/webhook`
   - Events to send: `checkout.session.completed`
3. Copy the **Signing Secret** and set it as `STRIPE_WEBHOOK_SECRET`.

### Testing
- Run `stripe listen --forward-to localhost:3000/api/billing/webhook` during local development.
- Trigger a test checkout session:
  ```bash
  stripe checkout sessions create \
    --success_url "http://localhost:3000/success" \
    --cancel_url "http://localhost:3000/cancel" \
    --line-items price_12345:1 \
    --mode subscription ---
  ```

## 📄 Commit Message ---

## 🧭 Workflow
1. Open `/docs/deployment.md`.  
2. Add the section above.  
3. Commit to `feature/stripe-client` with the commit message.  
4. Push branch → test locally with `stripe listen`.  

---

## 🎯 End Destination
Once this is committed, you’ll have:  
- **Billing helper** (`stripeClient.ts`)  
- **Webhook integration** (`/api/billing/webhook.ts`)  
- **Deployment docs** (Stripe setup)  

That’s the full **monetization + provisioning loop** documented and ready for launch. 🚀  

👉 Do you want me to also draft the **PostHog telemetry integration file** next, so you can commit it alongside and complete the telemetry part of your launch model?