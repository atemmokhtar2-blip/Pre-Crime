export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    ok: true,
    service: "pre-crime",
    runtime: "vercel-nodejs",
    checks: {
      app: "ok",
      database: process.env.DATABASE_URL ? "configured" : "not_configured",
      telegram: process.env.TELEGRAM_BOT_TOKEN ? "configured" : "not_configured",
    },
  });
}
