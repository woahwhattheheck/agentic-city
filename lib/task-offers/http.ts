import { NextResponse } from "next/server"
import { apiError } from "@/lib/api/error"
import {
  TaskOfferConflictError,
  TaskOfferNotFoundError,
} from "@/lib/task-market/offers"
import { TaskOfferEscrowConflictError } from "@/lib/task-offers/escrow"
import {
  TaskOfferPermissionError,
  TaskOfferValidationError,
} from "@/lib/task-offers/lifecycle"

export function asJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function taskOfferActorFromRequest(
  req: Request,
  body: Record<string, unknown> = {},
): string {
  const url = new URL(req.url)
  return String(
    req.headers.get("x-agent-id")
      ?? body.agentId
      ?? url.searchParams.get("agentId")
      ?? "",
  ).trim()
}

export function requireTaskOfferActor(
  req: Request,
  body: Record<string, unknown> = {},
): string {
  const actorId = taskOfferActorFromRequest(req, body)
  if (!actorId) throw new TaskOfferValidationError("agentId is required")
  return actorId
}

function noStore<T extends NextResponse>(response: T): T {
  response.headers.set("Cache-Control", "no-store")
  return response
}

export function taskOfferErrorResponse(error: unknown): NextResponse {
  if (error instanceof TaskOfferNotFoundError) {
    return noStore(apiError(error.message, error.code, 404))
  }

  if (error instanceof TaskOfferPermissionError) {
    return noStore(apiError(error.message, error.code, 403))
  }

  if (error instanceof TaskOfferValidationError) {
    return noStore(apiError(error.message, error.code, 400))
  }

  if (error instanceof TaskOfferConflictError) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        code: error.code,
        currentStatus: error.currentStatus,
        expectedStatuses: error.expectedStatuses,
      },
      {
        status: 409,
        headers: { "Cache-Control": "no-store" },
      },
    )
  }

  if (error instanceof TaskOfferEscrowConflictError) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        code: error.code,
        escrowStatus: error.escrowStatus,
      },
      {
        status: 409,
        headers: { "Cache-Control": "no-store" },
      },
    )
  }

  return noStore(apiError(
    error instanceof Error ? error.message : "Task offer lifecycle failed",
    "INTERNAL",
    500,
  ))
}
