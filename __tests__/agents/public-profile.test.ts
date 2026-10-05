import { afterEach, describe, expect, it } from "vitest"
import { GET as getAgent } from "@/app/api/agents/[id]/route"
import { GET as getHealth } from "@/app/api/agents/[id]/health/route"
import { registerAgent, resetAgentRegistryForTests } from "@/lib/agent-registry"
import { recordAgentHeartbeat, resetAgentHealthStore } from "@/lib/agents/agent-health-store"
import { resetTaskQueue } from "@/lib/agents/task-queue"
import { resetAgentXpDb } from "@/lib/gamification/xp"

function context(id: string) {
  return { params: Promise.resolve({ id }) }
}

function seedAgent() {
  registerAgent({
    agentId: "dependency-agent",
    model: "worker-model",
    district: "research",
    capabilities: ["research"],
    x402: { accepts: false },
    status: "idle",
    endpoint: "https://internal.example/dependency",
  })

  return registerAgent({
    agentId: "public-agent",
    model: "claude-haiku-4-5",
    district: "data-center",
    capabilities: ["data-indexing", "log-analysis"],
    skillVersions: [{ id: "log-analysis", version: "2.1.0" }],
    dependencies: ["dependency-agent"],
    x402: { accepts: true, pricePerTask: "0.01 XLM" },
    status: "active",
    endpoint: "https://internal.example/agents/public-agent",
  })
}

afterEach(() => {
  resetAgentRegistryForTests()
  resetAgentHealthStore()
  resetTaskQueue()
  resetAgentXpDb()
})

describe("public agent profile projections", () => {
  it("returns only whitelisted profile fields without authentication", async () => {
    seedAgent()

    const response = await getAgent(
      new Request("http://localhost/api/agents/public-agent?view=public"),
      context("public-agent"),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.agent).toMatchObject({
      agentId: "public-agent",
      model: "claude-haiku-4-5",
      district: "data-center",
      capabilities: ["data-indexing", "log-analysis"],
      x402: { accepts: true, pricePerTask: "0.01 XLM" },
      status: "active",
      xp: 0,
      level: 1,
      tasksCompleted: 0,
    })
    expect(body.agent.registeredAt).toEqual(expect.any(String))
    expect(body.agent).not.toHaveProperty("endpoint")
    expect(body.agent).not.toHaveProperty("dependencies")
    expect(body.agent).not.toHaveProperty("skillVersions")
    expect(body.agent).not.toHaveProperty("updatedAt")
  })

  it("preserves the full operational response when public view is not requested", async () => {
    seedAgent()

    const response = await getAgent(
      new Request("http://localhost/api/agents/public-agent"),
      context("public-agent"),
    )
    const body = await response.json()

    expect(body.agent.endpoint).toBe("https://internal.example/agents/public-agent")
    expect(body.agent.dependencies).toEqual(["dependency-agent"])
    expect(body.agent.skillVersions).toEqual([{ id: "log-analysis", version: "2.1.0" }])
  })

  it("removes telemetry, restart controls, and task text from public health", async () => {
    recordAgentHeartbeat("public-agent", {
      status: "working",
      cpu: 73,
      memory: 64,
      currentTask: "Private operator instruction",
      autoRestart: true,
    })

    const publicResponse = await getHealth(
      new Request("http://localhost/api/agents/public-agent/health?view=public"),
      context("public-agent"),
    )
    const publicBody = await publicResponse.json()

    expect(publicBody.health).toMatchObject({
      agentId: "public-agent",
      status: "healthy",
      runtimeStatus: "working",
      uptimeSeconds: expect.any(Number),
      uptime: expect.any(String),
    })
    expect(publicBody.health).not.toHaveProperty("cpu")
    expect(publicBody.health).not.toHaveProperty("memory")
    expect(publicBody.health).not.toHaveProperty("currentTask")
    expect(publicBody.health).not.toHaveProperty("autoRestart")
    expect(publicBody.health).not.toHaveProperty("restartAttempts")
    expect(publicBody.health).not.toHaveProperty("lastHeartbeat")

    const internalResponse = await getHealth(
      new Request("http://localhost/api/agents/public-agent/health"),
      context("public-agent"),
    )
    const internalBody = await internalResponse.json()
    expect(internalBody.health.currentTask).toBe("Private operator instruction")
    expect(internalBody.health.cpu).toBe(73)
    expect(internalBody.health.autoRestart).toBe(true)
  })

  it("returns 404 for an unknown public agent", async () => {
    const response = await getAgent(
      new Request("http://localhost/api/agents/missing?view=public"),
      context("missing"),
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body).toEqual({ ok: false, error: "agent not found" })
  })
})
