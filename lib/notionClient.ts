import { Client } from '@notionhq/client';
import { CreateDatabaseParameters } from '@notionhq/client/build/src/api-endpoints';
import { logEvent } from '../api/analytics/telemetry';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Database item for sync operations
 */
export interface DatabaseItem {
  id?: string;
  properties: Record<string, any>;
  content?: any[];
}

/**
 * Sync result statistics
 */
export interface SyncResult {
  created: number;
  updated: number;
  failed: number;
}

/**
 * Query options with pagination
 */
export interface QueryOptions {
  filter?: any;
  sorts?: any[];
  pageSize?: number;
  startCursor?: string;
}

/**
 * Page update response
 */
export interface PageUpdateResponse {
  pageId: string;
  success: boolean;
  error?: string;
}

/**
 * Authorization result
 */
export interface AuthResult {
  success: boolean;
  userId?: string;
  type?: string;
  error?: string;
}

/**
 * Dashboard creation options
 */
export interface DashboardOptions {
  title: string;
  parentPageId: string;
  categories?: string[];
  icon?: string;
  description?: string;
}

/**
 * Cache entry
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

/**
 * Request deduplication key
 */
interface DedupRequest {
  promise: Promise<any>;
  timestamp: number;
}

// ============================================================================
// CUSTOM ERROR CLASS
// ============================================================================

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
    Object.setPrototypeOf(this, NotionError.prototype);
  }
}

// ============================================================================
// RATE LIMIT MANAGER
// ============================================================================

/**
 * Rate limit manager for handling API throttling
 */
class RateLimitManager {
  private requestQueue: Array<() => Promise<any>> = [];
  private isProcessing = false;
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL = 100; // milliseconds between requests
  private requestsInWindow = 0;
  private readonly MAX_REQUESTS_PER_60S = 120; // Notion API limit

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
          this.requestsInWindow++;
        } catch (error) {
          console.error('[Notion] Request queue error:', error);
        }
      }

      this.lastRequestTime = Date.now();
    }

    this.isProcessing = false;
  }

  resetWindowCounter(): void {
    this.requestsInWindow = 0;
  }

  getQueueLength(): number {
    return this.requestQueue.length;
  }
}

// ============================================================================
// CONNECTION POOL
// ============================================================================

/**
 * Connection pool for managing multiple Notion client instances
 */
class ConnectionPool {
  private connections: Map<string, Client> = new Map();
  private readonly maxConnections = 5;

  getConnection(apiKey: string, index: number = 0): Client {
    const key = `${apiKey}_${index % this.maxConnections}`;

    if (!this.connections.has(key)) {
      if (this.connections.size >= this.maxConnections) {
        const firstKey = this.connections.keys().next().value;
        this.connections.delete(firstKey);
      }

      this.connections.set(key, new Client({ auth: apiKey }));
    }

    return this.connections.get(key)!;
  }

  clear(): void {
    this.connections.clear();
  }
}

// ============================================================================
// RESPONSE CACHE
// ============================================================================

/**
 * Response cache for reducing API calls
 */
class ResponseCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private readonly defaultTTL = 5 * 60 * 1000; // 5 minutes

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  set<T>(key: string, data: T, ttl: number = this.defaultTTL): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
    });
  }

  invalidate(keyPattern: string): void {
    const regex = new RegExp(keyPattern);
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  getSize(): number {
    return this.cache.size;
  }
}

// ============================================================================
// REQUEST DEDUPLICATION
// ============================================================================

/**
 * Request deduplication to avoid duplicate API calls
 */
class RequestDeduplicator {
  private pendingRequests: Map<string, DedupRequest> = new Map();
  private readonly deduplicateWindow = 1000; // 1 second

  async deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();

    // Check if we have a pending request within the window
    if (this.pendingRequests.has(key)) {
      const pending = this.pendingRequests.get(key)!;
      if (now - pending.timestamp < this.deduplicateWindow) {
        return pending.promise;
      }
    }

    // Create new request
    const promise = fn();
    this.pendingRequests.set(key, { promise, timestamp: now });

    try {
      const result = await promise;
      return result;
    } finally {
      // Clean up after request completes
      setTimeout(() => {
        this.pendingRequests.delete(key);
      }, this.deduplicateWindow);
    }
  }

  clear(): void {
    this.pendingRequests.clear();
  }
}

// ============================================================================
// DATA VALIDATION
// ============================================================================

/**
 * Validate data before syncing to Notion
 */
class DataValidator {
  /**
   * Validate database item structure
   */
  validateItem(item: DatabaseItem): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!item.properties || typeof item.properties !== 'object') {
      errors.push('Item must have properties object');
    }

    if (item.content && !Array.isArray(item.content)) {
      errors.push('Item content must be an array');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate array of items
   */
  validateItems(items: DatabaseItem[]): { valid: boolean; errors: Map<number, string[]> } {
    const errors = new Map<number, string[]>();

    items.forEach((item, index) => {
      const result = this.validateItem(item);
      if (!result.valid) {
        errors.set(index, result.errors);
      }
    });

    return {
      valid: errors.size === 0,
      errors,
    };
  }

  /**
   * Sanitize properties for Notion
   */
  sanitizeProperties(properties: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(properties)) {
      if (value === null || value === undefined) {
        continue;
      }

      sanitized[key] = value;
    }

    return sanitized;
  }
}

// ============================================================================
// NOTION CLIENT WRAPPER
// ============================================================================

/**
 * Notion client wrapper with rate limiting, caching, and error handling
 */
export class NotionClientWrapper {
  private client: Client;
  private rateLimitManager: RateLimitManager;
  private connectionPool: ConnectionPool;
  private responseCache: ResponseCache;
  private requestDeduplicator: RequestDeduplicator;
  private dataValidator: DataValidator;
  private userId?: string;
  private readonly maxRetries = 3;
  private apiKey: string;

  constructor(apiKey: string, userId?: string) {
    this.apiKey = apiKey;
    this.client = new Client({ auth: apiKey });
    this.rateLimitManager = new RateLimitManager();
    this.connectionPool = new ConnectionPool();
    this.responseCache = new ResponseCache();
    this.requestDeduplicator = new RequestDeduplicator();
    this.dataValidator = new DataValidator();
    this.userId = userId;
  }

  /**
   * Validate and authorize the Notion client
   */
  async authorize(): Promise<AuthResult> {
    try {
      console.log('[Notion] Authorizing client...');

      const response = await this.rateLimitManager.enqueue(() => this.client.users.me());

      console.log('[Notion] Authorization successful');

      if (this.userId) {
        await logEvent(this.userId, 'notion_authorized', {
          userId: response.id,
          type: response.type,
        });
      }

      return {
        success: true,
        userId: response.id,
        type: response.type,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Notion] Authorization failed:', message);

      if (this.userId) {
        await logEvent(this.userId, 'notion_auth_failed', {
          error: message,
        });
      }

      throw new NotionError(
        `Failed to authorize Notion client: ${message}`,
        401,
        false
      );
    }
  }

  /**
   * Create a new Notion dashboard database with pre-configured schema
   */
  async createDashboard(options: DashboardOptions): Promise<string> {
    const {
      title,
      parentPageId,
      categories = ['Health & Fitness', 'Study', 'Career', 'Finance'],
    } = options;

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

      // Invalidate related cache
      this.responseCache.invalidate('dashboard_');

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
    options: QueryOptions = {}
  ): Promise<any[]> {
    const { filter, sorts, pageSize = 100, startCursor } = options;

    // Check cache first
    const cacheKey = `query_${databaseId}_${JSON.stringify(filter || {})}`;
    const cachedResult = this.responseCache.get<any[]>(cacheKey);
    if (cachedResult) {
      console.log(`[Notion] Query cache hit for database: ${databaseId}`);
      return cachedResult;
    }

    try {
      console.log(`[Notion] Querying database: ${databaseId}`);

      return await this.requestDeduplicator.deduplicate(
        `query_${databaseId}`,
        async () => {
          const results: any[] = [];
          let cursor: string | undefined = startCursor;

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

          // Cache the results
          this.responseCache.set(cacheKey, results, 2 * 60 * 1000); // 2 minutes

          return results;
        }
      );
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
    items: DatabaseItem[],
    options: { batchSize?: number; upsertKey?: string } = {}
  ): Promise<SyncResult> {
    const { batchSize = 10, upsertKey = 'id' } = options;
    let created = 0;
    let updated = 0;
    let failed = 0;

    try {
      console.log(`[Notion] Syncing ${items.length} items to database ${databaseId}`);

      // Validate items
      const validation = this.dataValidator.validateItems(items);
      if (!validation.valid) {
        console.warn('[Notion] Validation errors found:', validation.errors);
      }

      // Process items in batches
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);

        const results = await Promise.allSettled(
          batch.map((item) => {
            const sanitized = this.dataValidator.sanitizeProperties(item.properties);
            return this.syncItem(databaseId, { ...item, properties: sanitized }, upsertKey);
          })
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

      // Invalidate related cache
      this.responseCache.invalidate(`query_${databaseId}`);

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
    item: DatabaseItem,
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
    properties: Record<string, any>,
    content?: any[]
  ): Promise<PageUpdateResponse> {
    try {
      console.log(`[Notion] Updating page: ${pageId}`);

      const sanitized = this.dataValidator.sanitizeProperties(properties);

      await this.executeWithRetry(
        () =>
          this.client.pages.update({
            page_id: pageId,
            properties: sanitized,
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

      // Invalidate related cache
      this.responseCache.invalidate(`.*${pageId}.*`);

      if (this.userId) {
        await logEvent(this.userId, 'notion_page_updated', {
          pageId,
        });
      }

      return {
        pageId,
        success: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Notion] Page update failed:', message);

      if (this.userId) {
        await logEvent(this.userId, 'notion_page_update_failed', {
          error: message,
          pageId,
        });
      }

      return {
        pageId,
        success: false,
        error: message,
      };
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

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.responseCache.clear();
    this.requestDeduplicator.clear();
    console.log('[Notion] Caches cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { cacheSize: number; queueLength: number } {
    return {
      cacheSize: this.responseCache.getSize(),
      queueLength: this.rateLimitManager.getQueueLength(),
    };
  }
}

// ============================================================================
// SINGLETON INSTANCE FACTORY
// ============================================================================

let notionClientInstance: NotionClientWrapper | null = null;

/**
 * Initialize Notion client (call once at app startup)
 */
export function initializeNotionClient(
  apiKey: string,
  userId?: string
): NotionClientWrapper {
  notionClientInstance = new NotionClientWrapper(apiKey, userId);
  return notionClientInstance;
}

/**
 * Get initialized Notion client instance
 */
export function getNotionClient(): NotionClientWrapper {
  if (!notionClientInstance) {
    throw new Error('Notion client not initialized. Call initializeNotionClient() first.');
  }
  return notionClientInstance;
}

/**
 * Reset Notion client instance (for testing)
 */
export function resetNotionClient(): void {
  notionClientInstance = null;
}

export default NotionClientWrapper;
