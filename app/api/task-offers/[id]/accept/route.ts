import { NextResponse } from "next/server"
import { acceptTaskOffer } from "@/lib/task-offers/lifecycle"
import {
  asJsonObject,
  requireTaskOfferActor,
  taskOfferErrorResponse,
} from "@/lib/task-offers/http"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(req: Request, context: RouteContext) {
  try {
    const body = asJsonObject(await req.json().catch(() => ({})))
    const actorId = requireTaskOfferActor(req, body)
    const { id } = await context.params
    const settlement = await acceptTaskOffer(decodeURIComponent(id), actorId)

    return NextResponse.json(
      {
        ok: true,
        offer: settlement.offer,
        payout: settlement.escrow,
        idempotent: settlement.idempotent,
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    return taskOfferErrorResponse(error)
  }
}
