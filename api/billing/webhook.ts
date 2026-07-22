import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import { Pool } from 'pg';
import { logEvent } from '../analytics/telemetry';
import { initializeNotionClient, getNotionClient, NotionError } from '../../lib/notionClient';
import type { DashboardOptions } from '../../lib/notionClient';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

// Initialize Postgres pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Initialize Notion client once on module load
let notionInitialized = false;
function ensureNotionClient() {
  if (!notionInitialized && process.env.NOTION_API_KEY) {
    initializeNotionClient(process.env.NOTION_API_KEY);
    notionInitialized = true;
  }
}

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
 * Store dashboard ID in database for user
 */
async function storeDashboardId(userId: string, databaseId: string): Promise<void> {
  const client = await pool.connect();
  try {
    const query = `
      UPDATE subscriptions
      SET notion_database_id = $2, updated_at = NOW()
      WHERE user_id = $1;
    `;

    await client.query(query, [userId, databaseId]);
    console.log(`[Billing] Stored Notion dashboard ID ${databaseId} for user ${userId}`);
  } catch (error) {
    console.error('[Billing] Error storing dashboard ID:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Provision a Notion dashboard for the user using enhanced wrapper
 */
async function provisionNotionDashboard(
  userId: string,
  email: string,
  plan: string
): Promise<string> {
  try {
    ensureNotionClient();
    const notionClient = getNotionClient();

    console.log(`[Billing] Provisioning Notion dashboard for ${email} with plan: ${plan}`);

    const dashboardOptions: DashboardOptions = {
      title: `${email} - AustinLab Cockpit (${plan})`,
      parentPageId: process.env.NOTION_ROOT_PAGE_ID || '',
      categories: ['Health & Fitness', 'Study', 'Career', 'Finance'],
      icon: '📊',
      description: 'Personal cockpit for unified tracking across all life domains',
    };

    // Create dashboard using enhanced wrapper
    const databaseId = await notionClient.createDashboard(dashboardOptions);

    console.log(`[Billing] ✅ Notion dashboard provisioned successfully`);
    console.log(`   - Database ID: ${databaseId}`);
    console.log(`   - Email: ${email}`);
    console.log(`   - Plan: ${plan}`);

    // Store dashboard ID in database
    await storeDashboardId(userId, databaseId);

    // Log event to telemetry
    await logEvent(userId, 'notion_dashboard_provisioned', {
      databaseId,
      plan,
      email,
      timestamp: new Date().toISOString(),
    });

    return databaseId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`[Billing] ❌ Error provisioning Notion dashboard for ${email}:`, message);

    // Log error event
    await logEvent(userId, 'notion_dashboard_provisioning_failed', {
      error: message,
      email,
      plan,
      isRetryable: error instanceof NotionError ? error.retryable : false,
    });

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
    console.log(`[Billing] Processing checkout for user: ${userId}`);

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

    console.log('[Billing] ✅ Subscription status updated in database');

    // Get user email from Stripe customer
    const stripeCustomer = await stripe.customers.retrieve(customerId);
    const userEmail =
      typeof stripeCustomer === 'object' && stripeCustomer.email ? stripeCustomer.email : 'unknown';

    // Provision Notion dashboard with enhanced wrapper
    const dashboardId = await provisionNotionDashboard(userId, userEmail, planName);

    // Log subscription activation event
    await logEvent(userId, 'subscription_activated', {
      plan: planName,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      notionDatabaseId: dashboardId,
      timestamp: new Date().toISOString(),
    });

    console.log(`[Billing] ✅ Checkout session completed for user ${userId}`);
    console.log(`   - Plan: ${planName}`);
    console.log(`   - Dashboard ID: ${dashboardId}`);
    console.log(`   - Email: ${userEmail}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Billing] ❌ Error handling checkout session:', message);

    // Log error event
    await logEvent(userId, 'checkout_session_failed', {
      error: message,
      customerId,
      isRetryable: error instanceof NotionError ? error.retryable : false,
    });

    throw error;
  }
}

/**
 * Handle subscription update events
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  try {
    console.log(`[Billing] Processing subscription update: ${subscription.id}`);

    // Extract user ID from subscription metadata or customer
    const customerId = typeof subscription.customer === 'string' 
      ? subscription.customer 
      : subscription.customer?.id;

    if (!customerId) {
      console.error('[Billing] Missing customer ID in subscription update');
      return;
    }

    // You can add logic here to update subscription status if needed
    console.log(`[Billing] Subscription updated: ${subscription.id} - Status: ${subscription.status}`);
  } catch (error) {
    console.error('[Billing] Error handling subscription update:', error);
  }
}

/**
 * Handle subscription deletion/cancellation
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  try {
    console.log(`[Billing] Processing subscription deletion: ${subscription.id}`);

    // Extract user ID from subscription metadata or customer
    const customerId = typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id;

    if (!customerId) {
      console.error('[Billing] Missing customer ID in subscription deletion');
      return;
    }

    console.log(`[Billing] Subscription cancelled: ${subscription.id}`);

    // Add cancellation logic here (e.g., disable access, send notification, etc.)
  } catch (error) {
    console.error('[Billing] Error handling subscription deletion:', error);
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
          await handleSubscriptionUpdated(subscription);
        }
        break;

      case 'customer.subscription.deleted':
        {
          const subscription = event.data.object as Stripe.Subscription;
          await handleSubscriptionDeleted(subscription);
        }
        break;

      case 'invoice.payment_succeeded':
        {
          const invoice = event.data.object as Stripe.Invoice;
          console.log(`[Billing] Invoice payment succeeded: ${invoice.id}`);
          await logEvent('system', 'invoice_payment_succeeded', {
            invoiceId: invoice.id,
            customerId: invoice.customer,
            amount: invoice.amount_paid,
          });
        }
        break;

      case 'invoice.payment_failed':
        {
          const invoice = event.data.object as Stripe.Invoice;
          console.log(`[Billing] Invoice payment failed: ${invoice.id}`);
          await logEvent('system', 'invoice_payment_failed', {
            invoiceId: invoice.id,
            customerId: invoice.customer,
            amount: invoice.amount_due,
          });
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
          stack: error.stack,
        });
      } catch (logError) {
        console.error('[Billing] Error logging webhook error:', logError);
      }
    }

    res.status(400).send(`Webhook Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

export default router;
