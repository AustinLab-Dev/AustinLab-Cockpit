import PostHog from "posthog-node";

const client = new PostHog(process.env.POSTHOGAPIKEY || "", {
  host: process.env.POSTHOG_HOST || undefined, // use default if undefined
  // flushAt, flushInterval can be tuned
});

export async function posthogCapture(event: string, props: Record<string, any> = {}) {
  try {
    // anonymousId if no distinct id; in Stripe flows we may not have a user id
    await client.capture({
      distinctId: props.email || props.stripeSessionId || "anonymous",
      event,
      properties: props,
    });
  } catch (err) {
    // swallow telemetry errors but log
    console.error("PostHog capture failed:", err);
  }
}

// Ensure graceful shutdown (use in server shutdown hooks if desired)
export function posthogFlush() {
  try {
    client.shutdownAsync();
  } catch (err) {
    console.error("PostHog shutdown error:", err);
  }
}
