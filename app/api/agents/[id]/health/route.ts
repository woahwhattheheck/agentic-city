import { NextResponse } from "next/server"
import { getAgentHealth } from "@/lib/agents/agent-health-store"
import { toPublicAgentHealth, wantsPublicAgentView } from "@/lib/agents/public-profile"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: Request, context: RouteContext) {
  const { id } = await context.params
  const health = getAgentHealth(decodeURIComponent(id))

  if (!health) {
    return NextResponse.json(
      { ok: true, available: false, message: "No live heartbeat has been recorded for this agent", health: null, agentId: decodeURIComponent(id) },
      { headers: { "Cache-Control": "no-store" } },
    )
  }

  return NextResponse.json(
    { ok: true, health: wantsPublicAgentView(req) ? toPublicAgentHealth(health) : health },
    { headers: { "Cache-Control": "no-store" } },
  )
}
