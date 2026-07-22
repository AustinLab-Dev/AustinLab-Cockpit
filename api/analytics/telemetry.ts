import { PostHog } from 'posthog-node';

// Initialize PostHog client
const posthog = new PostHog(
  process.env.POSTHOG_API_KEY || '',
  {
    host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
  }
);

/**
 * Event properties interface
 */
export interface EventProperties {
  [key: string]: string | number | boolean | object | null;
}

/**
 * Log an event to PostHog analytics
 * @param userId - The user ID
 * @param eventName - The name of the event
 * @param properties - Optional event properties
 */
export async function logEvent(
  userId: string,
  eventName: string,
  properties?: EventProperties
): Promise<void> {
  try {
    posthog.capture({
      distinctId: userId,
      event: eventName,
      properties: properties || {},
    });

    // Flush to ensure event is sent (optional, for critical events)
    // await posthog.shutdownAsync();
  } catch (error) {
    console.error(`[Telemetry] Error logging event "${eventName}" for user "${userId}":`, error);
  }
}

/**
 * Batch log multiple events
 * @param userId - The user ID
 * @param events - Array of events with name and properties
 */
export async function logBatchEvents(
  userId: string,
  events: Array<{ name: string; properties?: EventProperties }>
): Promise<void> {
  try {
    for (const event of events) {
      posthog.capture({
        distinctId: userId,
        event: event.name,
        properties: event.properties || {},
      });
    }
  } catch (error) {
    console.error(`[Telemetry] Error logging batch events for user "${userId}":`, error);
  }
}

/**
 * Identify a user with properties
 * @param userId - The user ID
 * @param properties - User properties
 */
export async function identifyUser(
  userId: string,
  properties?: Record<string, any>
): Promise<void> {
  try {
    posthog.identify({
      distinctId: userId,
      properties: properties || {},
    });
  } catch (error) {
    console.error(`[Telemetry] Error identifying user "${userId}":`, error);
  }
}

/**
 * Alias a user (for anonymous to authenticated transitions)
 * @param previousId - Previous distinct ID (e.g., anonymous ID)
 * @param newId - New distinct ID (e.g., user ID)
 */
export async function aliasUser(previousId: string, newId: string): Promise<void> {
  try {
    posthog.alias({
      previousDistinctId: previousId,
      distinctId: newId,
    });
  } catch (error) {
    console.error(`[Telemetry] Error aliasing user from "${previousId}" to "${newId}":`, error);
  }
}

/**
 * Shutdown PostHog client (call on app termination)
 */
export async function shutdownTelemetry(): Promise<void> {
  try {
    await posthog.shutdownAsync();
  } catch (error) {
    console.error('[Telemetry] Error shutting down PostHog:', error);
  }
}

export default posthog;
