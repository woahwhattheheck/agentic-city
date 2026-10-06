import { beforeEach, describe, expect, it, vi } from "vitest"
import { POST as acceptOfferRoute } from "@/app/api/task-offers/[id]/accept/route"
import {
  createTaskOffer,
  getTaskOffer,
  resetTaskOffersForTests,
  TaskOfferConflictError,
} from "@/lib/task-market/offers"
import {
  configureTaskOfferEscrowProvider,
  getTaskOfferEscrowRecord,
  resetTaskOfferEscrowForTests,
} from "@/lib/task-offers/escrow"
import {
  acceptTaskOffer,
  autoReleaseDeliveredTaskOffers,
  claimTaskOffer,
  deliverTaskOffer,
  disputeTaskOffer,
  resetTaskOfferLifecycleLocksForTests,
  TaskOfferPermissionError,
} from "@/lib/task-offers/lifecycle"

function newOffer() {
  return createTaskOffer({
    postedBy: "agent-poster",
    requiredCapability: "run-inference",
    payload: { prompt: "summarize" },
    reward: "5 XLM",
    deadline: Math.floor(Date.now() / 1000) + 3600,
  })
}

function context(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe("task-offer lifecycle", () => {
  const release = vi.fn(async ({ offer }: { offer: { offerId: string } }) => ({
    payoutTx: `x402_test_${offer.offerId}`,
  }))
  const freeze = vi.fn(async ({ offer }: { offer: { offerId: string } }) => ({
    disputeId: `dispute_test_${offer.offerId}`,
  }))

  beforeEach(() => {
    vi.clearAllMocks()
    resetTaskOffersForTests()
    resetTaskOfferEscrowForTests()
    resetTaskOfferLifecycleLocksForTests()
    configureTaskOfferEscrowProvider({ release, freeze })
  })

  it("lets exactly one concurrent claimant win", async () => {
    const offer = newOffer()
    const results = await Promise.allSettled([
      claimTaskOffer(offer.offerId, "agent-alpha"),
      claimTaskOffer(offer.offerId, "agent-beta"),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(getTaskOffer(offer.offerId)?.status).toBe("claimed")
    expect(["agent-alpha", "agent-beta"]).toContain(getTaskOffer(offer.offerId)?.claimedBy)
  })

  it("rejects delivery from anyone except the winning claimant", async () => {
    const offer = newOffer()
    await claimTaskOffer(offer.offerId, "agent-worker")

    await expect(
      deliverTaskOffer(offer.offerId, "agent-third-party", { summary: "not mine" }),
    ).rejects.toBeInstanceOf(TaskOfferPermissionError)

    expect(getTaskOffer(offer.offerId)?.status).toBe("claimed")
  })

  it("accepts once and returns the same x402 payout on a duplicate accept", async () => {
    const offer = newOffer()
    await claimTaskOffer(offer.offerId, "agent-worker")
    await deliverTaskOffer(offer.offerId, "agent-worker", { summary: "done" })

    const first = await acceptTaskOffer(offer.offerId, "agent-poster")
    const second = await acceptTaskOffer(offer.offerId, "agent-poster")

    expect(first.offer.status).toBe("accepted")
    expect(second.idempotent).toBe(true)
    expect(second.escrow.payoutTx).toBe(first.escrow.payoutTx)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("freezes the reward when the poster disputes a delivery", async () => {
    const offer = newOffer()
    await claimTaskOffer(offer.offerId, "agent-worker")
    await deliverTaskOffer(offer.offerId, "agent-worker", { summary: "needs review" })

    const result = await disputeTaskOffer(offer.offerId, "agent-poster")
    const escrow = getTaskOfferEscrowRecord(offer.offerId)

    expect(result.offer.status).toBe("disputed")
    expect(result.offer.rewardFrozen).toBe(true)
    expect(escrow?.status).toBe("frozen")
    expect(release).not.toHaveBeenCalled()
  })

  it("returns HTTP 409 with the current state for an invalid transition", async () => {
    const offer = newOffer()
    const response = await acceptOfferRoute(
      new Request(`http://localhost/api/task-offers/${offer.offerId}/accept`, {
        method: "POST",
        headers: { "x-agent-id": "agent-poster" },
      }),
      context(offer.offerId),
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "TASK_OFFER_CONFLICT",
      currentStatus: "open",
    })
  })

  it("blocks a claim after the unclaimed offer deadline", async () => {
    const offer = newOffer()
    const afterDeadline = new Date((offer.deadline + 1) * 1000)

    await expect(
      claimTaskOffer(offer.offerId, "agent-worker", { now: afterDeadline }),
    ).rejects.toMatchObject<TaskOfferConflictError>({
      currentStatus: "expired",
    })

    expect(getTaskOffer(offer.offerId, afterDeadline)?.status).toBe("expired")
  })

  it("records every transition with its actor and timestamp", async () => {
    const offer = newOffer()
    await claimTaskOffer(offer.offerId, "agent-worker")
    await deliverTaskOffer(offer.offerId, "agent-worker", { summary: "done" })
    await acceptTaskOffer(offer.offerId, "agent-poster")

    const transitions = getTaskOffer(offer.offerId)?.transitions ?? []
    expect(transitions.map(({ to }) => to)).toEqual([
      "open",
      "claimed",
      "delivered",
      "accepted",
    ])
    expect(transitions.map(({ actorId }) => actorId)).toEqual([
      "agent-poster",
      "agent-worker",
      "agent-worker",
      "agent-poster",
    ])
    expect(transitions.every(({ at }) => !Number.isNaN(Date.parse(at)))).toBe(true)
  })

  it("auto-releases a delivered reward after ten minutes", async () => {
    const offer = newOffer()
    const deliveredAt = new Date()
    await claimTaskOffer(offer.offerId, "agent-worker", { now: deliveredAt })
    await deliverTaskOffer(
      offer.offerId,
      "agent-worker",
      { summary: "done" },
      { now: deliveredAt },
    )

    const released = await autoReleaseDeliveredTaskOffers(
      new Date(deliveredAt.getTime() + 10 * 60 * 1000),
    )

    expect(released).toHaveLength(1)
    expect(released[0].offer.status).toBe("accepted")
    expect(released[0].offer.transitions.at(-1)?.actorId).toBe("system:auto-release")
  })
})
