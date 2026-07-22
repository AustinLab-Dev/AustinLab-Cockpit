import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { buffer } from "micro";
import { provisionNotion } from "../notion/provision";
import { posthogCapture } from "../../lib/posthog";

export const config = {
  api: {
    bodyParser: false, // Stripe requires raw body for signature verification
  },
};

const stripe = new Stripe(process.env.STRIPEAPIKEY || "", {
  apiVersion: "2022-11-15",
});

const relevantEvents = new Set([
  "checkout.session.completed",
  "invoice.payment_succeeded",
  "payment_intent.succeeded",
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end("Method Not Allowed");
  }

  const sig = req.headers["stripe-signature"] as string | undefined;
  if (!sig) return res.status(400).send("Missing Stripe signature");

  const raw = await buffer(req);
  const webhookSecret = process.env.STRIPEWEBHOOKSECRET;
  if (!webhookSecret) {
    console.error("STRIPEWEBHOOKSECRET not configured");
    return res.status(500).send("Webhook not configured");
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw.toString(), sig, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  // Acknowledge receipt early (Stripe requires 2xx). We'll still attempt async processing,
  // but ensure Stripe gets a 2xx quickly after verification.
  res.status(200).send("ok");

  try {
    if (!relevantEvents.has(event.type)) {
      // ignore other events
      await posthogCapture("stripe_webhook.ignored", { event: event.type });
      return;
    }

    await posthogCapture("stripe_webhook.received", { event: event.type, id: event.id });

    // Extract common data from event
    let email: string | undefined;
    let amount: number | undefined;
    let currency: string | undefined;
    let stripeSessionId: string | undefined;

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      email = (session.customer_details?.email as string) || (session.customer as string) || undefined;
      amount = typeof session.amount_total === "number" ? session.amount_total : undefined;
      currency = session.currency || undefined;
      stripeSessionId = session.id;
    } else if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as Stripe.Invoice;
      email = (invoice.customer_email as string) || undefined;
      amount = invoice.total ?? undefined;
      currency = invoice.currency ?? undefined;
      stripeSessionId = invoice.id;
    } else if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as Stripe.PaymentIntent;
      // PaymentIntent may not include email directly
      currency = pi.currency ?? undefined;
      amount = pi.amount ?? undefined;
      stripeSessionId = pi.id;
      // If metadata includes email
      email = (pi.metadata && (pi.metadata.email as string)) || undefined;
    }

    // Call Notion provisioning (best-effort). Provision returns an id or throws.
    try {
      const notionResult = await provisionNotion({
        name: email || "Unknown",
        email,
        stripeSession: stripeSessionId,
        status: "Active",
        amount,
        currency,
        stripeEventType: event.type,
      });
      await posthogCapture("notion.provisioned", { notionId: notionResult.id, event: event.type });
    } catch (err) {
      console.error("Notion provisioning failed:", err);
      await posthogCapture("notion.provision_failed", { error: String(err), event: event.type });
      // don't rethrow; we've already responded 200 to Stripe
    }

    await posthogCapture("stripe_webhook.processed", {
      event: event.type,
      email,
      amount,
      currency,
      stripeSessionId,
    });
  } catch (err) {
    console.error("Unexpected error processing stripe webhook:", err);
    await posthogCapture("stripe_webhook.error", { error: String(err) });
  }
}
