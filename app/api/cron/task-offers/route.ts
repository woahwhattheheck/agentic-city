import { NextResponse } from "next/server"
import { autoReleaseDeliveredTaskOffers } from "@/lib/task-offers/lifecycle"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return req.headers.get("authorization") === `Bearer ${secret}`
}

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized cron request", code: "UNAUTHORIZED" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    )
  }

  try {
    const settlements = await autoReleaseDeliveredTaskOffers()
    return NextResponse.json(
      {
        ok: true,
        released: settlements.map(({ offer, escrow }) => ({
          offerId: offer.offerId,
          workerId: offer.claimedBy,
          reward: offer.reward,
          payoutTx: escrow.payoutTx,
        })),
        checkedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Task-offer auto-release failed",
        code: "INTERNAL",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    )
  }
}
