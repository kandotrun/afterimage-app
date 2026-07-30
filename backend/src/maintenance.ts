import { legalPageResponse } from "./legal";

const maintenanceResponse = () => new Response(JSON.stringify({
  ok: false,
  service: "afterimage-api",
  maintenance: true,
}), {
  status: 503,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": "60",
  },
});

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/privacy") {
      return legalPageResponse("privacy");
    }
    if (request.method === "GET" && pathname === "/support") {
      return legalPageResponse("support");
    }
    if (request.method === "GET" && pathname === "/terms") {
      return legalPageResponse("terms");
    }
    return maintenanceResponse();
  },

  async scheduled(): Promise<void> {
    // Privacy-sensitive background work must remain paused during schema rollout.
  },
} satisfies ExportedHandler<Env>;
