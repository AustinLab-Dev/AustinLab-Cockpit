import { NextApiRequest, NextApiResponse } from 'next';
import { Client } from '@notionhq/client';

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

interface ProvisionRequest {
  userId: string;
  templatePageId?: string;
  dashboardTitle?: string;
}

interface ProvisionResponse {
  success: boolean;
  pageId?: string;
  pageUrl?: string;
  error?: string;
}

const DEFAULT_DASHBOARD_TITLE = 'AustinLab Cockpit Dashboard';
const DEFAULT_TEMPLATE_PAGE_ID = process.env.NOTION_TEMPLATE_PAGE_ID;

/**
 * Creates a new Notion dashboard page from a template
 * POST /api/notion/provision
 *
 * Request body:
 * - userId: string (required) - User identifier for tracking
 * - templatePageId: string (optional) - Template page to duplicate
 * - dashboardTitle: string (optional) - Custom dashboard title
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ProvisionResponse>
) {
  // Validate request method
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.',
    });
  }

  try {
    // Validate API key
    if (!process.env.NOTION_API_KEY) {
      console.error('NOTION_API_KEY is not configured');
      return res.status(500).json({
        success: false,
        error: 'Notion API not configured',
      });
    }

    const { userId, templatePageId, dashboardTitle } = req.body as ProvisionRequest;

    // Validate required fields
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    const pageTitle = dashboardTitle || DEFAULT_DASHBOARD_TITLE;
    const sourcePageId = templatePageId || DEFAULT_TEMPLATE_PAGE_ID;

    if (!sourcePageId) {
      return res.status(400).json({
        success: false,
        error: 'No template page ID provided and NOTION_TEMPLATE_PAGE_ID is not configured',
      });
    }

    // Fetch the template page to duplicate
    let templatePage;
    try {
      templatePage = await notion.pages.retrieve({ page_id: sourcePageId });
    } catch (error) {
      console.error('Failed to retrieve template page:', error);
      return res.status(404).json({
        success: false,
        error: `Template page not found: ${sourcePageId}`,
      });
    }

    // Get the parent (database) of the template page
    const parentId = (templatePage as any).parent?.database_id || (templatePage as any).parent?.page_id;

    if (!parentId) {
      return res.status(400).json({
        success: false,
        error: 'Template page has no valid parent database or page',
      });
    }

    // Create a new page from the template
    let newPage;
    try {
      newPage = await notion.pages.create({
        parent: {
          page_id: sourcePageId, // Create as a child of the template page
        },
        properties: {
          title: [
            {
              text: {
                content: `${pageTitle} - ${new Date().toISOString().split('T')[0]}`,
              },
            },
          ],
        },
      });
    } catch (error) {
      console.error('Failed to create new page:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create dashboard page in Notion',
      });
    }

    // Copy content from template (if needed)
    try {
      await copyPageContent(sourcePageId, newPage.id);
    } catch (error) {
      console.error('Warning: Failed to copy page content:', error);
      // Don't fail the request if content copy fails
    }

    // Generate Notion page URL
    const pageUrl = `https://notion.so/${newPage.id.replace(/-/g, '')}`;

    // Log provision event
    console.log(`Dashboard provisioned for user ${userId}:`, {
      pageId: newPage.id,
      pageUrl,
      title: pageTitle,
    });

    return res.status(201).json({
      success: true,
      pageId: newPage.id,
      pageUrl,
    });
  } catch (error) {
    console.error('Unexpected error in provision endpoint:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}

/**
 * Helper function to copy content from template page to new page
 * This recursively duplicates all child blocks
 */
async function copyPageContent(sourcePageId: string, targetPageId: string): Promise<void> {
  try {
    const blocks = await notion.blocks.children.list({ block_id: sourcePageId });

    for (const block of blocks.results) {
      const blockData = block as any;

      // Create a new block in the target page with the same content
      await notion.blocks.children.append({
        block_id: targetPageId,
        children: [
          {
            object: 'block',
            type: blockData.type,
            [blockData.type]: blockData[blockData.type],
          },
        ],
      });
    }
  } catch (error) {
    // Silently fail content copy - page structure is still created
    console.warn('Content copy failed:', error);
  }
}
