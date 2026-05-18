import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import NodeCache from "node-cache";

interface SiigoAuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SiigoInvoice {
  id: number;
  document_number: string;
  date: string;
  customer: { id: number; name: string };
  items: Array<{
    reference?: string;
    description: string;
    quantity: number;
    price: number;
  }>;
  total: number;
  status: string;
}

interface SiigoProduct {
  id: number;
  reference: string;
  description: string;
  price: number;
  cost?: number;
  category?: string;
}

// Initialize cache (8 hour TTL)
const cache = new NodeCache({ stdTTL: 28800 });

let siigoToken: string | null = null;
let tokenExpiresAt: number = 0;

// Service type mapping for vet clinic
const SERVICE_CATEGORY_MAP: Record<string, string> = {
  peluqueria: "Estética / Grooming",
  consulta: "Consulta Veterinaria",
  cirugia: "Cirugía",
  vacuna: "Vacunas",
  desparasitacion: "Desparasitación",
  laparotomia: "Cirugía Mayor",
  esterilizacion: "Esterilización",
  castracion: "Castracion",
  limpieza: "Limpieza Dental",
  radiografia: "Imagenología",
  laboratorio: "Laboratorio",
};

/**
 * Authenticate with Siigo API and get JWT token
 */
async function getSiigoToken(): Promise<string> {
  if (siigoToken && Date.now() < tokenExpiresAt - 60000) {
    return siigoToken;
  }

  const username = process.env.SIIGO_USERNAME;
  const accessKey = process.env.SIIGO_ACCESS_KEY;

  if (!username || !accessKey) {
    throw new Error("SIIGO_USERNAME or SIIGO_ACCESS_KEY not configured");
  }

  try {
    const response = await axios.post<SiigoAuthResponse>(
      "https://api.siigo.com/auth",
      {
        username,
        access_key: accessKey,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    siigoToken = response.data.access_token;
    tokenExpiresAt = Date.now() + response.data.expires_in * 1000;

    return siigoToken;
  } catch (error) {
    console.error("Siigo auth error:", error);
    throw new Error("Failed to authenticate with Siigo");
  }
}

/**
 * Make authenticated request to Siigo API
 */
async function siigoRequest<T>(
  endpoint: string,
  params?: Record<string, string | number | boolean>
): Promise<T> {
  const token = await getSiigoToken();

  try {
    const response = await axios.get<T>(`https://api.siigo.com${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      params,
    });

    return response.data;
  } catch (error) {
    console.error(`Siigo API error on ${endpoint}:`, error);
    throw error;
  }
}

/**
 * Normalize service category from reference or description
 */
function normalizeServiceType(
  reference?: string,
  description?: string
): string {
  const searchStr = (reference || description || "").toLowerCase();

  for (const [key, value] of Object.entries(SERVICE_CATEGORY_MAP)) {
    if (searchStr.includes(key)) {
      return value;
    }
  }

  return description || reference || "Otros Servicios";
}

/**
 * Get invoices grouped by date range
 */
async function getInvoices(
  startDate: string,
  endDate: string
): Promise<SiigoInvoice[]> {
  const cacheKey = `invoices_${startDate}_${endDate}`;

  const cached = cache.get<SiigoInvoice[]>(cacheKey);
  if (cached) return cached;

  const invoices = await siigoRequest<{ data: SiigoInvoice[] }>(
    "/v1/invoices",
    {
      start_date: startDate,
      end_date: endDate,
      limit: 100,
    }
  );

  cache.set(cacheKey, invoices.data);
  return invoices.data;
}

/**
 * Get revenue by service category
 */
async function getRevenueByService(
  startDate: string,
  endDate: string
): Promise<
  Array<{ service: string; revenue: number; count: number; margin?: number }>
> {
  const cacheKey = `revenue_by_service_${startDate}_${endDate}`;

  const cached = cache.get<
    Array<{ service: string; revenue: number; count: number; margin?: number }>
  >(cacheKey);
  if (cached) return cached;

  const invoices = await getInvoices(startDate, endDate);
  const products = await siigoRequest<{ data: SiigoProduct[] }>(
    "/v1/products",
    { limit: 500 }
  );

  const productMap = new Map(
    products.data.map((p) => [p.reference || p.id.toString(), p])
  );
  const revenueMap = new Map<
    string,
    { revenue: number; count: number; cost: number }
  >();

  for (const invoice of invoices) {
    if (invoice.status !== "PAID" && invoice.status !== "PENDING") continue;

    for (const item of invoice.items) {
      const product = productMap.get(item.reference || item.description);
      const service = normalizeServiceType(
        item.reference,
        item.description
      );
      const itemTotal = item.quantity * item.price;

      if (!revenueMap.has(service)) {
        revenueMap.set(service, { revenue: 0, count: 0, cost: 0 });
      }

      const current = revenueMap.get(service)!;
      current.revenue += itemTotal;
      current.count += item.quantity;
      current.cost += (product?.cost || 0) * item.quantity;
    }
  }

  const result = Array.from(revenueMap.entries()).map(([service, data]) => ({
    service,
    revenue: Math.round(data.revenue * 100) / 100,
    count: data.count,
    margin:
      data.revenue > 0
        ? Math.round(((data.revenue - data.cost) / data.revenue) * 100)
        : 0,
  }));

  cache.set(cacheKey, result);
  return result;
}

/**
 * Get cash flow snapshot (AR aging)
 */
async function getCashFlowSnapshot(): Promise<{
  pending: number;
  overdue: number;
  expected30: number;
  daysOutstanding: number;
}> {
  const cacheKey = "cash_flow_snapshot";

  const cached = cache.get<{
    pending: number;
    overdue: number;
    expected30: number;
    daysOutstanding: number;
  }>(cacheKey);
  if (cached) return cached;

  const today = new Date();
  const lastMonth = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  const invoices = await getInvoices(
    lastMonth.toISOString().split("T")[0],
    today.toISOString().split("T")[0]
  );

  let pending = 0;
  let overdue = 0;
  let daysSum = 0;
  let invoiceCount = 0;

  for (const invoice of invoices) {
    if (invoice.status === "PAID") continue;

    const invoiceDate = new Date(invoice.date);
    const daysDiff = Math.floor(
      (today.getTime() - invoiceDate.getTime()) / (24 * 60 * 60 * 1000)
    );

    if (daysDiff > 30) {
      overdue += invoice.total;
    } else {
      pending += invoice.total;
    }

    daysSum += daysDiff;
    invoiceCount++;
  }

  const result = {
    pending: Math.round(pending * 100) / 100,
    overdue: Math.round(overdue * 100) / 100,
    expected30: Math.round((pending + overdue) / 30),
    daysOutstanding:
      invoiceCount > 0 ? Math.round(daysSum / invoiceCount) : 0,
  };

  cache.set(cacheKey, result);
  return result;
}

/**
 * Get financial snapshot (MTD/YTD)
 */
async function getFinancialSnapshot(): Promise<{
  mtdRevenue: number;
  ytdRevenue: number;
  mtdMargin: number;
  growth: number;
  topService: string;
}> {
  const cacheKey = "financial_snapshot";

  const cached = cache.get<{
    mtdRevenue: number;
    ytdRevenue: number;
    mtdMargin: number;
    growth: number;
    topService: string;
  }>(cacheKey);
  if (cached) return cached;

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    .toISOString()
    .split("T")[0];
  const yearStart = new Date(today.getFullYear(), 0, 1)
    .toISOString()
    .split("T")[0];
  const lastMonthStart = new Date(
    today.getFullYear(),
    today.getMonth() - 1,
    1
  )
    .toISOString()
    .split("T")[0];
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0)
    .toISOString()
    .split("T")[0];
  const todayStr = today.toISOString().split("T")[0];

  const mtdByService = await getRevenueByService(monthStart, todayStr);
  const ytdByService = await getRevenueByService(yearStart, todayStr);
  const lastMonthByService = await getRevenueByService(
    lastMonthStart,
    lastMonthEnd
  );

  const mtdRevenue = mtdByService.reduce((sum, s) => sum + s.revenue, 0);
  const ytdRevenue = ytdByService.reduce((sum, s) => sum + s.revenue, 0);
  const lastMonthRevenue = lastMonthByService.reduce(
    (sum, s) => sum + s.revenue,
    0
  );
  const mtdMargin = mtdByService.reduce((sum, s) => sum + (s.margin || 0), 0);
  const avgMargin = mtdByService.length > 0 ? mtdMargin / mtdByService.length : 0;
  const growth =
    lastMonthRevenue > 0
      ? Math.round(((mtdRevenue - lastMonthRevenue) / lastMonthRevenue) * 100)
      : 0;
  const topService = mtdByService.length > 0 ? mtdByService[0].service : "N/A";

  const result = {
    mtdRevenue: Math.round(mtdRevenue * 100) / 100,
    ytdRevenue: Math.round(ytdRevenue * 100) / 100,
    mtdMargin: Math.round(avgMargin),
    growth,
    topService,
  };

  cache.set(cacheKey, result);
  return result;
}

/**
 * MCP Tool handlers
 */
const tools = {
  get_invoices: async (input: {
    start_date: string;
    end_date: string;
  }) => {
    const invoices = await getInvoices(input.start_date, input.end_date);
    return {
      invoices: invoices.map((i) => ({
        id: i.id,
        date: i.date,
        customer: i.customer.name,
        total: i.total,
        status: i.status,
      })),
      count: invoices.length,
    };
  },

  get_revenue_by_service: async (input: {
    start_date: string;
    end_date: string;
  }) => {
    const revenue = await getRevenueByService(input.start_date, input.end_date);
    return {
      services: revenue.sort((a, b) => b.revenue - a.revenue),
      total: revenue.reduce((sum, s) => sum + s.revenue, 0),
    };
  },

  get_cash_flow_snapshot: async () => {
    return await getCashFlowSnapshot();
  },

  get_financial_snapshot: async () => {
    return await getFinancialSnapshot();
  },

  get_top_customers: async () => {
    const today = new Date();
    const last90 = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const invoices = await getInvoices(
      last90,
      today.toISOString().split("T")[0]
    );

    const customerMap = new Map<string, number>();
    for (const invoice of invoices) {
      const name = invoice.customer.name;
      customerMap.set(
        name,
        (customerMap.get(name) || 0) + invoice.total
      );
    }

    const topCustomers = Array.from(customerMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }));

    return { customers: topCustomers };
  },

  clear_cache: async () => {
    cache.flushAll();
    return { status: "Cache cleared" };
  },
};

/**
 * Process tool calls from Claude
 */
async function processToolCall(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  const tool = tools[toolName as keyof typeof tools];
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const result = await tool(toolInput as any);
  return JSON.stringify(result);
}

/**
 * Main agent loop
 */
async function main() {
  const client = new Anthropic();
  const conversationHistory: Anthropic.Messages.MessageParam[] = [];

  // System prompt
  const systemPrompt = `You are a financial analysis assistant for Pets & Pets veterinary clinic.
You have access to tools to query Siigo accounting data.
Use these tools to answer questions about revenue, cash flow, margins, and financial performance.
Always provide insights tailored to a veterinary clinic context.`;

  console.log("Siigo MCP Server initialized");
  console.log("Tools available:", Object.keys(tools).join(", "));

  // Example query
  const userMessage = `What's our financial situation for this month? I need:
1. Revenue by service
2. Cash flow status (pending/overdue)
3. Top 3 services`;

  conversationHistory.push({
    role: "user",
    content: userMessage,
  });

  console.log("\nUser:", userMessage);

  // Agentic loop
  while (true) {
    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools: [
        {
          name: "get_revenue_by_service",
          description:
            "Get revenue grouped by veterinary service (grooming, consultation, surgery, etc)",
          input_schema: {
            type: "object",
            properties: {
              start_date: {
                type: "string",
                description: "Start date (YYYY-MM-DD)",
              },
              end_date: {
                type: "string",
                description: "End date (YYYY-MM-DD)",
              },
            },
            required: ["start_date", "end_date"],
          },
        },
        {
          name: "get_cash_flow_snapshot",
          description:
            "Get current cash flow status: pending invoices, overdue amounts, days outstanding",
          input_schema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "get_financial_snapshot",
          description:
            "Get MTD/YTD revenue, margins, growth rate, and top service",
          input_schema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "get_invoices",
          description: "Get list of invoices in a date range",
          input_schema: {
            type: "object",
            properties: {
              start_date: {
                type: "string",
                description: "Start date (YYYY-MM-DD)",
              },
              end_date: {
                type: "string",
                description: "End date (YYYY-MM-DD)",
              },
            },
            required: ["start_date", "end_date"],
          },
        },
        {
          name: "get_top_customers",
          description: "Get top 10 customers by revenue (last 90 days)",
          input_schema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      ],
      messages: conversationHistory,
    });

    // Check for stop reason
    if (response.stop_reason === "end_turn") {
      const finalMessage = response.content
        .filter((block) => block.type === "text")
        .map((block) => (block as Anthropic.Messages.TextBlock).text)
        .join("\n");

      console.log("\nAssistant:", finalMessage);
      break;
    }

    // Process tool uses
    if (response.stop_reason === "tool_use") {
      const assistantMessage: Anthropic.Messages.MessageParam = {
        role: "assistant",
        content: response.content,
      };
      conversationHistory.push(assistantMessage);

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          console.log(`\nTool call: ${block.name}`);
          console.log("Input:", JSON.stringify(block.input, null, 2));

          try {
            const result = await processToolCall(
              block.name,
              block.input as Record<string, unknown>
            );
            console.log("Result:", result);

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result,
            });
          } catch (error) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Error: ${error instanceof Error ? error.message : String(error)}`,
              is_error: true,
            });
          }
        }
      }

      conversationHistory.push({
        role: "user",
        content: toolResults,
      });
    }
  }
}

main().catch(console.error);
