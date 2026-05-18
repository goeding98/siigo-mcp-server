import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import axios from "axios";
import NodeCache from "node-cache";
import { z } from "zod";

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
}

const cache = new NodeCache({ stdTTL: 28800 });

let siigoToken: string | null = null;
let tokenExpiresAt: number = 0;

const SERVICE_CATEGORY_MAP: Record<string, string> = {
  peluqueria: "Estética / Grooming",
  consulta: "Consulta Veterinaria",
  cirugia: "Cirugía",
  vacuna: "Vacunas",
  desparasitacion: "Desparasitación",
  laparotomia: "Cirugía Mayor",
  esterilizacion: "Esterilización",
  castracion: "Castración",
  limpieza: "Limpieza Dental",
  radiografia: "Imagenología",
  laboratorio: "Laboratorio",
};

async function getSiigoToken(): Promise<string> {
  if (siigoToken && Date.now() < tokenExpiresAt - 60000) {
    return siigoToken;
  }

  const username = process.env.SIIGO_USERNAME;
  const accessKey = process.env.SIIGO_ACCESS_KEY;

  if (!username || !accessKey) {
    throw new Error("SIIGO_USERNAME or SIIGO_ACCESS_KEY not configured");
  }

  const response = await axios.post<SiigoAuthResponse>(
    "https://api.siigo.com/auth",
    { username, access_key: accessKey },
    { headers: { "Content-Type": "application/json" } }
  );

  siigoToken = response.data.access_token;
  tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
  return siigoToken;
}

async function siigoRequest<T>(
  endpoint: string,
  params?: Record<string, string | number | boolean>
): Promise<T> {
  const token = await getSiigoToken();
  const partnerId = process.env.SIIGO_PARTNER_ID;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  if (partnerId) {
    headers["Partner-Id"] = partnerId;
  }

  const response = await axios.get<T>(`https://api.siigo.com${endpoint}`, {
    headers,
    params,
  });

  return response.data;
}

function normalizeServiceType(reference?: string, description?: string): string {
  const searchStr = (reference || description || "").toLowerCase();
  for (const [key, value] of Object.entries(SERVICE_CATEGORY_MAP)) {
    if (searchStr.includes(key)) return value;
  }
  return description || reference || "Otros Servicios";
}

async function getInvoices(startDate: string, endDate: string): Promise<SiigoInvoice[]> {
  const cacheKey = `invoices_${startDate}_${endDate}`;
  const cached = cache.get<SiigoInvoice[]>(cacheKey);
  if (cached) return cached;

  const result = await siigoRequest<{ data: SiigoInvoice[] }>("/v1/invoices", {
    start_date: startDate,
    end_date: endDate,
    limit: 100,
  });

  cache.set(cacheKey, result.data);
  return result.data;
}

async function getRevenueByService(startDate: string, endDate: string) {
  const cacheKey = `revenue_${startDate}_${endDate}`;
  const cached = cache.get<Array<{ service: string; revenue: number; count: number; margin: number }>>(cacheKey);
  if (cached) return cached;

  const invoices = await getInvoices(startDate, endDate);
  const products = await siigoRequest<{ data: SiigoProduct[] }>("/v1/products", { limit: 500 });
  const productMap = new Map(products.data.map((p) => [p.reference || p.id.toString(), p]));
  const revenueMap = new Map<string, { revenue: number; count: number; cost: number }>();

  for (const invoice of invoices) {
    if (invoice.status !== "PAID" && invoice.status !== "PENDING") continue;
    for (const item of invoice.items) {
      const product = productMap.get(item.reference || item.description);
      const service = normalizeServiceType(item.reference, item.description);
      const itemTotal = item.quantity * item.price;
      if (!revenueMap.has(service)) revenueMap.set(service, { revenue: 0, count: 0, cost: 0 });
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
    margin: data.revenue > 0 ? Math.round(((data.revenue - data.cost) / data.revenue) * 100) : 0,
  }));

  cache.set(cacheKey, result);
  return result;
}

async function getCashFlowSnapshot() {
  const cached = cache.get<object>("cash_flow");
  if (cached) return cached;

  const today = new Date();
  const lastMonth = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const invoices = await getInvoices(lastMonth.toISOString().split("T")[0], today.toISOString().split("T")[0]);

  let pending = 0, overdue = 0, daysSum = 0, invoiceCount = 0;

  for (const invoice of invoices) {
    if (invoice.status === "PAID") continue;
    const daysDiff = Math.floor((today.getTime() - new Date(invoice.date).getTime()) / 86400000);
    if (daysDiff > 30) overdue += invoice.total;
    else pending += invoice.total;
    daysSum += daysDiff;
    invoiceCount++;
  }

  const result = {
    pending: Math.round(pending * 100) / 100,
    overdue: Math.round(overdue * 100) / 100,
    expected30: Math.round((pending + overdue) / 30),
    daysOutstanding: invoiceCount > 0 ? Math.round(daysSum / invoiceCount) : 0,
  };

  cache.set("cash_flow", result);
  return result;
}

async function getFinancialSnapshot() {
  const cached = cache.get<object>("financial_snapshot");
  if (cached) return cached;

  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split("T")[0];
  const yearStart = new Date(today.getFullYear(), 0, 1).toISOString().split("T")[0];
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().split("T")[0];
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().split("T")[0];

  const [mtd, ytd, lastMonth] = await Promise.all([
    getRevenueByService(monthStart, todayStr),
    getRevenueByService(yearStart, todayStr),
    getRevenueByService(lastMonthStart, lastMonthEnd),
  ]);

  const mtdRevenue = mtd.reduce((s, x) => s + x.revenue, 0);
  const ytdRevenue = ytd.reduce((s, x) => s + x.revenue, 0);
  const lastMonthRevenue = lastMonth.reduce((s, x) => s + x.revenue, 0);
  const avgMargin = mtd.length > 0 ? mtd.reduce((s, x) => s + x.margin, 0) / mtd.length : 0;
  const growth = lastMonthRevenue > 0 ? Math.round(((mtdRevenue - lastMonthRevenue) / lastMonthRevenue) * 100) : 0;
  const topService = mtd.sort((a, b) => b.revenue - a.revenue)[0]?.service ?? "N/A";

  const result = {
    mtdRevenue: Math.round(mtdRevenue * 100) / 100,
    ytdRevenue: Math.round(ytdRevenue * 100) / 100,
    mtdMargin: Math.round(avgMargin),
    growth,
    topService,
  };

  cache.set("financial_snapshot", result);
  return result;
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "siigo-mcp-server", version: "0.1.0" });

  server.tool(
    "get_invoices",
    "Get list of invoices in a date range from Siigo",
    { start_date: z.string().describe("Start date YYYY-MM-DD"), end_date: z.string().describe("End date YYYY-MM-DD") },
    async ({ start_date, end_date }) => {
      const invoices = await getInvoices(start_date, end_date);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            invoices: invoices.map((i) => ({ id: i.id, date: i.date, customer: i.customer.name, total: i.total, status: i.status })),
            count: invoices.length,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_revenue_by_service",
    "Get revenue grouped by veterinary service category",
    { start_date: z.string().describe("Start date YYYY-MM-DD"), end_date: z.string().describe("End date YYYY-MM-DD") },
    async ({ start_date, end_date }) => {
      const revenue = await getRevenueByService(start_date, end_date);
      const sorted = revenue.sort((a, b) => b.revenue - a.revenue);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ services: sorted, total: sorted.reduce((s, x) => s + x.revenue, 0) }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_cash_flow_snapshot",
    "Get current cash flow: pending invoices, overdue amounts, average days outstanding",
    {},
    async () => {
      const result = await getCashFlowSnapshot();
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_financial_snapshot",
    "Get MTD/YTD revenue, margin percentage, growth vs last month, and top service",
    {},
    async () => {
      const result = await getFinancialSnapshot();
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_top_customers",
    "Get top 10 customers by revenue in the last 90 days",
    {},
    async () => {
      const today = new Date();
      const last90 = new Date(today.getTime() - 90 * 86400000).toISOString().split("T")[0];
      const invoices = await getInvoices(last90, today.toISOString().split("T")[0]);
      const customerMap = new Map<string, number>();
      for (const inv of invoices) {
        customerMap.set(inv.customer.name, (customerMap.get(inv.customer.name) || 0) + inv.total);
      }
      const customers = Array.from(customerMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ customers }, null, 2) }] };
    }
  );

  server.tool("clear_cache", "Clear the data cache", {}, async () => {
    cache.flushAll();
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: "Cache cleared" }) }] };
  });

  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "siigo-mcp-server" });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Siigo MCP Server running on port ${PORT}`);
  console.log(`MCP endpoint: POST /mcp`);
  console.log(`Health check: GET /health`);
});
