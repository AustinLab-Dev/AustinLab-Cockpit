import Stripe from 'stripe';

const stripeSecret = process.env.STRIPE_SECRET;
if (!stripeSecret) {
  throw new Error('STRIPE_SECRET is not defined in environment');
}

const stripe = new Stripe(stripeSecret, { apiVersion: '2022-11-15' });

export default stripe;

export type CreateSessionParams = {
  line_items?: Stripe.Checkout.SessionCreateParams.LineItem[];
  mode?: Stripe.Checkout.SessionCreateParams.Mode;
  customer_email?: string;
  metadata?: Record<string, string>;
  successPath?: string; // relative path on APP_URL, e.g. '/success'
  cancelPath?: string; // relative path on APP_URL, e.g. '/cancel'
};

export async function createCheckoutSession(params: CreateSessionParams) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    throw new Error('APP_URL is not defined in environment');
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: params.mode ?? 'payment',
    line_items: params.line_items ?? [],
    customer_email: params.customer_email,
    metadata: params.metadata,
    success_url: `${appUrl}${params.successPath ?? '/success'}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}${params.cancelPath ?? '/cancel'}`,
  });

  return session;
}
