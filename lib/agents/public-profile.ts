import type { AgentCapabilityManifest } from "@/lib/agent-registry"
import type { AgentHealthSnapshot } from "@/lib/agents/agent-health-store"

export interface PublicAgentProfile {
  agentId: AgentCapabilityManifest["agentId"]
  model: AgentCapabilityManifest["model"]
  district: AgentCapabilityManifest["district"]
  capabilities: string[]
  x402: AgentCapabilityManifest["x402"]
  status: AgentCapabilityManifest["status"]
  registeredAt: AgentCapabilityManifest["registeredAt"]
}

export interface PublicAgentHealth {
  agentId: AgentHealthSnapshot["agentId"]
  status: AgentHealthSnapshot["status"]
  runtimeStatus: AgentHealthSnapshot["runtimeStatus"]
  uptimeSeconds: AgentHealthSnapshot["uptimeSeconds"]
  uptime: AgentHealthSnapshot["uptime"]
}

export function wantsPublicAgentView(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.get("view") === "public"
  } catch {
    return false
  }
}

export function toPublicAgentProfile(agent: AgentCapabilityManifest): PublicAgentProfile {
  return {
    agentId: agent.agentId,
    model: agent.model,
    district: agent.district,
    capabilities: [...agent.capabilities],
    x402: {
      accepts: agent.x402.accepts,
      ...(agent.x402.pricePerTask === undefined ? {} : { pricePerTask: agent.x402.pricePerTask }),
    },
    status: agent.status,
    registeredAt: agent.registeredAt,
  }
}

export function toPublicAgentHealth(health: AgentHealthSnapshot): PublicAgentHealth {
  return {
    agentId: health.agentId,
    status: health.status,
    runtimeStatus: health.runtimeStatus,
    uptimeSeconds: health.uptimeSeconds,
    uptime: health.uptime,
  }
}
