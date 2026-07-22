import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTIONAPIKEY });

type ProvisionInput = {
  name: string;
  email?: string;
  stripeSession?: string;
  status?: "Pending" | "Active" | string;
  amount?: number;
  currency?: string;
  stripeEventType?: string;
};

export async function provisionNotion(input: ProvisionInput) {
  const databaseId = process.env.NOTIONDATABASEID;
  if (!databaseId) throw new Error("NOTIONDATABASEID not configured");

  const properties: any = {
    Name: {
      title: [
        {
          text: { content: input.name || "Customer" },
        },
      ],
    },
    Email: {
      rich_text: [{ text: { content: input.email || "" } }],
    },
    "Stripe Session": {
      rich_text: [{ text: { content: input.stripeSession || "" } }],
    },
    Status: {
      select: { name: input.status || "Pending" },
    },
  };

  // Optional additional properties like amount/currency can be added as text properties
  if (typeof input.amount === "number") {
    properties["Amount"] = { rich_text: [{ text: { content: String(input.amount) } }] };
  }
  if (input.currency) {
    properties["Currency"] = { rich_text: [{ text: { content: input.currency } }] };
  }

  const response = await notion.pages.create({
    parent: { database_id: databaseId },
    properties,
  });

  return { id: response.id };
}
