import { Client } from '@notionhq/client';
import { CreateDatabaseParameters } from '@notionhq/client/build/src/api-endpoints';
import { logEvent } from './analytics/telemetry';

/**
 * Custom error class for Notion API errors
 */
export class NotionError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public retryable: boolean = false,
    public retryAfter?: number
  ) {
    super(message);
    this.name = 'NotionError';
  }
}

/**
 * Rate limit manager for handling API throttling
 */
class RateLimitManager {
  private requestQueue: Array<() => Promise<any>> = [];
  private isProcessing = false;
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL = 100; // milliseconds between requests

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.requestQueue.length > 0) {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;

      if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.MIN_REQUEST_INTERVAL - timeSinceLastRequest)
        );
      }

      const request = this.requestQueue.shift();
      if (request) {
        try {
          await request();
        } catch (error) {
          console.error('[Notion] Request queue error:', error);
        }
      }

      this.lastRequestTime = Date.now();
    }

    this.isProcessing = false;
  }
}

/**
 * Notion client wrapper with rate limiting and error handling
 */
export class NotionClientWrapper {
  private client: Client;
  private rateLimitManager: RateLimitManager;
  private userId?: string;
  private readonly maxRetries = 3;

  constructor(apiKey: string, userId?: string) {
    this.client = new Client({
      auth: apiKey,
    });
    this.rateLimitManager = new RateLimitManager();
    this.userId = userId;
  }

  /**
   * Validate and authorize the Notion client
   */
  async authorize(): Promise<boolean> {
    try {
      console.log('[Notion] Authorizing client...');

      const response = await this.rateLimitManager.enqueue(() =>
        this.client.users.me()
      );

      console.log('[Notion] Authorization successful');

      if (this.userId) {
        await logEvent(this.userId, 'notion_authorized', {
          userId: response.id,
          type: response.type,
        });
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Notion] Authorization failed:', message);

      if (this.userId) {
        await logEvent(this.userId, 'notion_auth_failed', {
          error: message,
        });
      }

      throw new NotionError(`Failed to authorize Notion client: ${message}`, 401, false);
    }
  }

  /**
   * Create a new Notion dashboard database with pre-configured schema
   */
  async createDashboard(
    parentPageId: string,
    title: string,
    categories: string[] = ['Health & Fitness', 'Study', 'Career', 'Finance']
  ): Promise<string> {
    try {
      console.log(`[Notion] Creating dashboard: ${title}`);

      const databaseConfig: CreateDatabaseParameters = {
        parent: {
          type: 'page_id',
          page_id: parentPageId,
        },
        title: [
          {
            type: 'text',
            text: {
              content: title,
            },
          },
        ],
        properties: {
          Name: {
            title: {},
          },
          Category: {
            select: {
              options: categories.map((category) => ({
                name: category,
                color: this.getCategoryColor(category),
              })),
            },
          },
          Status: {
            select: {
              options: [
                { name: 'Completed', color: 'green' },
                { name: 'In Progress', color: 'yellow' },
                { name: 'Not Started', color: 'gray' },
                { name: 'Blocked', color: 'red' },
              ],
            },
          },
          Priority: {
            select: {
              options: [
                { name: 'High', color: 'red' },
                { name: 'Medium', color: 'yellow' },
                { name: 'Low', color: 'blue' },
              ],
            },
          },
          'Due Date': {
            date: {},
          },
          'Last Updated': {
            last_edited_time: {},
          },
          Notes: {
            rich_text: {},
          },
          Tags: {
            multi_select: {
              options: [
                { name: 'Important', color: 'red' },
                { name: 'Urgent', color: 'orange' },
                { name: 'Review', color: 'blue' },
              ],
            },
          },
        },
      };

      const database = await this.rateLimitManager.enqueue(() =>
        this.client.databases.create(databaseConfig as any)
      );

      console.log(`[Notion] Dashboard created successfully: ${database.id}`);

      if (this.userId) {
        await logEvent(this.userId, 'notion_dashboard_created', {
          databaseId: database.id,
          title,
          categories,
        });
      }

      return database.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Notion] Dashboard creation failed:', message);

      if (this.userId) {
        await logEvent(this.userId, 'notion_dashboard_creation_failed', {
          error: message,
          title,
        });
      }

      throw new NotionError(`Failed to create dashboard: ${message}`, 500, true);
    }
  }

  /**
   * Query a Notion database with filtering and pagination
   */
  async queryDatabase(
    databaseId: string,
    filter?: any,
    sorts?: any[],
    pageSize: number = 100
  ): Promise<any[]> {
    try {
      console.log(`[Notion] Querying database: ${databaseId}`);

      const results: any[] = [];
      let cursor: string | undefined = undefined;

      do {
        const response = await this.executeWithRetry(
          () =>
            this.client.databases.query({
              database_id: databaseId,
              filter,
              sorts,
              page_size: Math.min(pageSize, 100),
              start_cursor: cursor,
            } as any),
          `Query database ${databaseId}`
        );

        results.push(...response.results);
        cursor = response.next_cursor || undefined;
      } while (cursor);

      console.log(`[Notion] Query returned ${results.length} results`);

      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Notion] Database query failed:', message);

      if (this.userId) {
        await logEvent(this.userId, 'notion_query_failed', {
          error: message,
          databaseId,
        });
      }

      throw new NotionError(`Failed to query database: ${message}`, 500, true);
    }
  }

  /**
   * Sync data to Notion database (create or update pages)
   */
  async syncDatabase(
    databaseId: string,
    items: Array<{ id?: string; properties: any; content?: any }>,
    options: { batchSize?: number; upsertKey?: string } = {}
  ): Promise<{ created: number; updated: number; failed: number }> {
    const { batchSize = 10, upsertKey = 'id' } = options;
    let created = 0;
    let updated = 0;
    let failed = 0;

    try {
      console.log(`[Notion] Syncing ${items.length} items to database ${databaseId}`);

      // Process items in batches
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);

        const results = await Promise.allSettled(
          batch.map((item) => this.syncItem(databaseId, item, upsertKey))
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            if (result.value.created) {
              created++;
            } else {
              updated++;
            }
          } else {
            failed++;
            console.error('[Notion] Item sync failed:', result.reason);
          }
        }

        // Small delay between batches to avoid rate limits
        if (i + batchSize < items.length) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      console.log(
        `[Notion] Sync completed: ${created} created, ${updated} updated, ${failed} failed`
      );

      if (this.userId) {
        await logEvent(this.userId, 'notion_sync_completed', {
          databaseId,
          created,
          updated,
          failed,
          total: items.length,
        });
      }

      return { created, updated, failed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Notion] Sync operation failed:', message);

      if (this.userId) {
        await logEvent(this.userId, 'notion_sync_failed', {
          error: message,
          databaseId,
          total: items.length,
        });
      }

      throw new NotionError(`Failed to sync database: ${message}`, 500, true);
    }
  }

  /**
   * Sync a single item to Notion
   */
  private async syncItem(
    databaseId: string,
    item: { id?: string; properties: any; content?: any },
    upsertKey: string
  ): Promise<{ created: boolean; pageId: string }> {
    try {
      if (item.id) {
        // Update existing page
        await this.executeWithRetry(
          () =>
            this.client.pages.update({
              page_id: item.id!,
              properties: item.properties,
            } as any),
          `Update page ${item.id}`
        );

        return { created: false, pageId: item.id };
      } else {
        // Create new page
        const page = await this.executeWithRetry(
          () =>
            this.client.pages.create({
              parent: {
                database_id: databaseId,
              },
              properties: item.properties,
            } as any),
          `Create page in database ${databaseId}`
        );

        // Add content blocks if provided
        if (item.content && item.content.length > 0) {
          await this.executeWithRetry(
            () =>
              this.client.blocks.children.append({
                block_id: page.id,
                children: item.content,
              } as any),
            `Add content to page ${page.id}`
          );
        }

        return { created: true, pageId: page.id };
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Update a Notion page
   */
  async updatePage(
    pageId: string,
    properties: any,
    content?: any[]
  ): Promise<void> {
    try {
      console.log(`[Notion] Updating page: ${pageId}`);

      await this.executeWithRetry(
        () =>
          this.client.pages.update({
            page_id: pageId,
            properties,
          } as any),
        `Update page ${pageId}`
      );

      if (content && content.length > 0) {
        await this.executeWithRetry(
          () =>
            this.client.blocks.children.append({
              block_id: pageId,
              children: content,
            } as any),
          `Add content to page ${pageId}`
        );
      }

      console.log(`[Notion] Page updated successfully: ${pageId}`);

      if (this.userId) {
        await logEvent(this.userId, 'notion_page_updated', {
          pageId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Notion] Page update failed:', message);

      if (this.userId) {
        await logEvent(this.userId, 'notion_page_update_failed', {
          error: message,
          pageId,
        });
      }

      throw new NotionError(`Failed to update page: ${message}`, 500, true);
    }
  }

  /**
   * Execute operation with exponential backoff retry for rate limits
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: Error | NotionError = new Error('Unknown error');

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.rateLimitManager.enqueue(fn);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const statusCode = (error as any)?.status;
        const retryAfter = this.parseRetryAfter((error as any)?.response?.headers);

        // Check if error is rate limit (429)
        if (statusCode === 429) {
          const delay = retryAfter || Math.pow(2, attempt) * 1000;
          console.warn(
            `[Notion] Rate limited on attempt ${attempt}/${this.maxRetries}. Retrying in ${delay}ms...`
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Non-retryable errors
        if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
          throw new NotionError(
            `${operationName} failed: ${lastError.message}`,
            statusCode,
            false
          );
        }

        // Server errors are retryable
        if (statusCode && statusCode >= 500) {
          if (attempt < this.maxRetries) {
            const delay = Math.pow(2, attempt) * 1000;
            console.warn(
              `[Notion] Server error on attempt ${attempt}/${this.maxRetries}. Retrying in ${delay}ms...`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        // For other errors on last attempt
        if (attempt === this.maxRetries) {
          throw new NotionError(
            `${operationName} failed after ${this.maxRetries} retries: ${lastError.message}`,
            statusCode,
            false
          );
        }
      }
    }

    throw lastError;
  }

  /**
   * Parse Retry-After header from response
   */
  private parseRetryAfter(headers: any): number | undefined {
    if (!headers) return undefined;

    const retryAfter = headers['retry-after'];
    if (!retryAfter) return undefined;

    // Try parsing as seconds
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try parsing as HTTP date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }

    return undefined;
  }

  /**
   * Get color for category
   */
  private getCategoryColor(category: string): string {
    const colorMap: Record<string, string> = {
      'Health & Fitness': 'green',
      Study: 'blue',
      Career: 'purple',
      Finance: 'yellow',
    };
    return colorMap[category] || 'gray';
  }
}

/**
 * Singleton instance factory
 */
let notionClientInstance: NotionClientWrapper | null = null;

export function initializeNotionClient(apiKey: string, userId?: string): NotionClientWrapper {
  notionClientInstance = new NotionClientWrapper(apiKey, userId);
  return notionClientInstance;
}

export function getNotionClient(): NotionClientWrapper {
  if (!notionClientInstance) {
    throw new Error(
      'Notion client not initialized. Call initializeNotionClient() first.'
    );
  }
  return notionClientInstance;
}

export default NotionClientWrapper;
