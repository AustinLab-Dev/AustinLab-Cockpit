import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { Pool } from 'pg';
import { logEvent } from '../analytics/telemetry';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

// Initialize Postgres pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Type definitions
interface CheckoutSessionData {
  userId: string;
  email: string;
  priceId: string;
}

interface SubscriptionStatus {
  id: string;
  user_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  status: string;
  plan: string;
  current_period_start: Date;
  current_period_end: Date;
  created_at: Date;
  updated_at: Date;
}

/**
 * Update or create subscription status in PostgreSQL
 */
async function updateSubscriptionStatus(
  userId: string,
  stripeCustomerId: string,
  stripeSubscriptionId: string,
  plan: string,
  status: string
): Promise<SubscriptionStatus> {
  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO subscriptions (
        user_id,
        stripe_customer_id,
        stripe_subscription_id,
        plan,
        status,
        current_period_start,
        current_period_end,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + INTERVAL '1 month', NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        stripe_subscription_id = $3,
        plan = $4,
        status = $5,
        updated_at = NOW()
      RETURNING *;
    `;

    const result = await client.query(query, [
      userId,
      stripeCustomerId,
      stripeSubscriptionId,
      plan,
      status,
    ]);

    return result.rows[0];
  } finally {
    client.release();
  }
}

/**
 * Provision a Notion dashboard for the user
 */
async function provisionNotionDashboard(
  userId: string,
  email: string,
  plan: string
): Promise<string> {
  try {
    // Import Notion client dynamically
    const { Client } = await import('@notionhq/client');
    const notion = new Client({
      auth: process.env.NOTION_API_KEY,
    });

    // Create database for user
    const database = await notion.databases.create({
      parent: {
        type: 'page_id',
        page_id: process.env.NOTION_ROOT_PAGE_ID || '',
      },
      title: [
        {
          type: 'text',
          text: {
            content: `${email} - AustinLab Cockpit (${plan})`,
          },
        },
      ],
      properties: {
        Name: {
          title: {},
        },
        Category: {
          select: {
            options: [
              { name: 'Health & Fitness', color: 'green' },
              { name: 'Study', color: 'blue' },
              { name: 'Career', color: 'purple' },
              { name: 'Finance', color: 'yellow' },
            ],
          },
        },
        Status: {
          select: {
            options: [
              { name: 'Completed', color: 'green' },
              { name: 'In Progress', color: 'yellow' },
              { name: 'Not Started', color: 'gray' },
            ],
          },
        },
        'Last Updated': {
          last_edited_time: {},
        },
      },
    });

    // Log event to telemetry
    await logEvent(userId, 'notion_dashboard_provisioned', {
      databaseId: database.id,
      plan,
      email,
    });

    console.log(`[Billing] Notion dashboard provisioned for ${email}:`, database.id);
    return database.id;
  } catch (error) {
    console.error(`[Billing] Error provisioning Notion dashboard for ${email}:`, error);
    throw error;
  }
}

/**
 * Retrieve plan name from Stripe price ID
 */
async function getPlanNameFromPriceId(priceId: string): Promise<string> {
  try {
    const price = await stripe.prices.retrieve(priceId);
    return (price.metadata?.plan_name as string) || 'starter';
  } catch (error) {
    console.error('[Billing] Error retrieving price:', error);
    return 'starter';
  }
}

/**
 * Handle checkout.session.completed event
 */
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const { client_reference_id, customer, line_items } = session;

  if (!client_reference_id || !customer) {
    console.error('[Billing] Missing required data in checkout session');
    throw new Error('Missing required data: client_reference_id or customer');
  }

  const userId = client_reference_id;
  const customerId = typeof customer === 'string' ? customer : customer.id;

  try {
    // Get subscription details from Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      limit: 1,
    });

    if (!subscriptions.data.length) {
      throw new Error('No subscription found for customer');
    }

    const subscription = subscriptions.data[0];
    const planName = await getPlanNameFromPriceId(subscription.items.data[0].price.id);

    // Update subscription status in database
    const subscriptionRecord = await updateSubscriptionStatus(
      userId,
      customerId,
      subscription.id,
      planName,
      subscription.status
    );

    console.log('[Billing] Subscription status updated:', subscriptionRecord);

    // Get user email from Stripe customer
    const stripeCustomer = await stripe.customers.retrieve(customerId);
    const userEmail =
      typeof stripeCustomer === 'object' && stripeCustomer.email ? stripeCustomer.email : 'unknown';

    // Provision Notion dashboard
    await provisionNotionDashboard(userId, userEmail, planName);

    // Log event
    await logEvent(userId, 'subscription_activated', {
      plan: planName,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
    });

    console.log(`[Billing] Checkout session completed for user ${userId}`);
  } catch (error) {
    console.error('[Billing] Error handling checkout session:', error);
    throw error;
  }
}

/**
 * Webhook endpoint for Stripe events
 * POST /api/billing/webhook
 */
router.post('/', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  if (!sig || !webhookSecret) {
    console.error('[Billing] Missing webhook signature or secret');
    return res.status(400).send('Missing webhook signature or secret');
  }

  try {
    // Verify webhook signature
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    console.log(`[Billing] Received webhook event: ${event.type}`);

    // Handle specific events
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'customer.subscription.updated':
        {
          const subscription = event.data.object as Stripe.Subscription;
          console.log(`[Billing] Subscription updated: ${subscription.id}`);
          // Add additional logic for subscription updates if needed
        }
        break;

      case 'customer.subscription.deleted':
        {
          const subscription = event.data.object as Stripe.Subscription;
          console.log(`[Billing] Subscription deleted: ${subscription.id}`);
          // Add cancellation logic if needed
        }
        break;

      case 'invoice.payment_succeeded':
        {
          const invoice = event.data.object as Stripe.Invoice;
          console.log(`[Billing] Invoice payment succeeded: ${invoice.id}`);
        }
        break;

      case 'invoice.payment_failed':
        {
          const invoice = event.data.object as Stripe.Invoice;
          console.log(`[Billing] Invoice payment failed: ${invoice.id}`);
          // Add retry logic or notification if needed
        }
        break;

      default:
        console.log(`[Billing] Unhandled event type: ${event.type}`);
    }

    // Return success response
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Billing] Webhook error:', error);

    // Log webhook error event
    if (error instanceof Error) {
      try {
        await logEvent('system', 'webhook_error', {
          error: error.message,
          type: 'stripe_webhook',
        });
      } catch (logError) {
        console.error('[Billing] Error logging webhook error:', logError);
      }
    }

    res.status(400).send(`Webhook Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

export default router;
