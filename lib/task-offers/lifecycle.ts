import {
  getTaskOffer,
  listTaskOffers,
  transitionTaskOffer,
  TaskOfferConflictError,
  TaskOfferNotFoundError,
  type TaskOffer,
} from "@/lib/task-market/offers"
import {
  freezeTaskOfferEscrow,
  getTaskOfferEscrowRecord,
  releaseTaskOfferEscrow,
  type TaskOfferEscrowRecord,
} from "@/lib/task-offers/escrow"
import { publishSystemEvent } from "@/lib/events/system-events"

const AUTO_RELEASE_DELAY_MS = 10 * 60 * 1000
const AUTO_RELEASE_ACTOR = "system:auto-release"

interface LifecycleOptions {
  now?: Date
}

interface OfferLockState {
  queues: Map<string, Promise<void>>
}

const globalState = globalThis as typeof globalThis & {
  __openStellarTaskOfferLocks__?: OfferLockState
}

const lockState: OfferLockState = globalState.__openStellarTaskOfferLocks__ ?? {
  queues: new Map(),
}

globalState.__openStellarTaskOfferLocks__ ??= lockState

export class TaskOfferPermissionError extends Error {
  readonly code = "TASK_OFFER_FORBIDDEN"

  constructor(message: string) {
    super(message)
    this.name = "TaskOfferPermissionError"
  }
}

export class TaskOfferValidationError extends Error {
  readonly code = "TASK_OFFER_BAD_REQUEST"

  constructor(message: string) {
    super(message)
    this.name = "TaskOfferValidationError"
  }
}

export interface TaskOfferSettlementResult {
  offer: TaskOffer
  escrow: TaskOfferEscrowRecord
  idempotent: boolean
}

function requireNonEmpty(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) throw new TaskOfferValidationError(`${field} is required`)
  return text
}

function requireResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskOfferValidationError("result must be an object")
  }
  return value as Record<string, unknown>
}

function requireOffer(offerId: string, now: Date): TaskOffer {
  const id = requireNonEmpty(offerId, "offerId")
  const offer = getTaskOffer(id, now)
  if (!offer) throw new TaskOfferNotFoundError(id)
  return offer
}

function assertPoster(offer: TaskOffer, actorId: string): void {
  if (offer.postedBy !== actorId) {
    throw new TaskOfferPermissionError("Only the task-offer poster can perform this action")
  }
}

async function withOfferLock<T>(offerId: string, work: () => Promise<T>): Promise<T> {
  const previous = lockState.queues.get(offerId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => gate)
  lockState.queues.set(offerId, queued)

  await previous
  try {
    return await work()
  } finally {
    release()
    if (lockState.queues.get(offerId) === queued) {
      lockState.queues.delete(offerId)
    }
  }
}

function publishTransition(
  type: "task.offer.claimed" | "task.offer.delivered" | "task.offer.accepted" | "task.offer.disputed",
  offer: TaskOffer,
  actorId: string,
  extra: { payoutTx?: string; disputeId?: string; automatic?: boolean } = {},
): void {
  publishSystemEvent({
    type,
    agentId: offer.postedBy,
    offerId: offer.offerId,
    actorId,
    workerId: offer.claimedBy,
    status: offer.status,
    ...extra,
  })
}

export async function claimTaskOffer(
  offerId: string,
  actorId: string,
  options: LifecycleOptions = {},
): Promise<TaskOffer> {
  const actor = requireNonEmpty(actorId, "agentId")
  const now = options.now ?? new Date()

  return withOfferLock(offerId, async () => {
    const current = requireOffer(offerId, now)
    const claimed = transitionTaskOffer({
      offerId: current.offerId,
      actorId: actor,
      expected: "open",
      to: "claimed",
      patch: { claimedBy: actor },
      now,
    })
    publishTransition("task.offer.claimed", claimed, actor)
    return claimed
  })
}

export async function deliverTaskOffer(
  offerId: string,
  actorId: string,
  result: unknown,
  options: LifecycleOptions = {},
): Promise<TaskOffer> {
  const actor = requireNonEmpty(actorId, "agentId")
  const delivery = requireResult(result)
  const now = options.now ?? new Date()

  return withOfferLock(offerId, async () => {
    const current = requireOffer(offerId, now)
    if (current.status === "claimed" && current.claimedBy !== actor) {
      throw new TaskOfferPermissionError("Only the agent that claimed this offer can deliver it")
    }

    const delivered = transitionTaskOffer({
      offerId: current.offerId,
      actorId: actor,
      expected: "claimed",
      to: "delivered",
      patch: {
        result: delivery,
        deliveredAt: now.toISOString(),
      },
      now,
    })
    publishTransition("task.offer.delivered", delivered, actor)
    return delivered
  })
}

async function releaseDeliveredOffer(
  offer: TaskOffer,
  actorId: string,
  now: Date,
  automatic: boolean,
): Promise<TaskOfferSettlementResult> {
  const escrow = await releaseTaskOfferEscrow(offer, actorId, now)
  const accepted = transitionTaskOffer({
    offerId: offer.offerId,
    actorId,
    expected: "delivered",
    to: "accepted",
    patch: {
      payoutTx: escrow.payoutTx,
      acceptedAt: now.toISOString(),
      rewardFrozen: false,
    },
    now,
  })
  publishTransition("task.offer.accepted", accepted, actorId, {
    payoutTx: escrow.payoutTx,
    automatic,
  })
  return { offer: accepted, escrow, idempotent: false }
}

export async function acceptTaskOffer(
  offerId: string,
  actorId: string,
  options: LifecycleOptions = {},
): Promise<TaskOfferSettlementResult> {
  const actor = requireNonEmpty(actorId, "agentId")
  const now = options.now ?? new Date()

  return withOfferLock(offerId, async () => {
    const current = requireOffer(offerId, now)
    assertPoster(current, actor)

    if (current.status === "accepted") {
      const escrow = getTaskOfferEscrowRecord(current.offerId)
      if (!escrow || escrow.status !== "released") {
        throw new TaskOfferConflictError(
          current.status,
          ["accepted"],
          "Accepted task offer is missing its escrow release receipt",
        )
      }
      return { offer: current, escrow, idempotent: true }
    }

    if (current.status !== "delivered") {
      throw new TaskOfferConflictError(current.status, ["delivered"])
    }

    return releaseDeliveredOffer(current, actor, now, false)
  })
}

export async function disputeTaskOffer(
  offerId: string,
  actorId: string,
  options: LifecycleOptions = {},
): Promise<TaskOfferSettlementResult> {
  const actor = requireNonEmpty(actorId, "agentId")
  const now = options.now ?? new Date()

  return withOfferLock(offerId, async () => {
    const current = requireOffer(offerId, now)
    assertPoster(current, actor)

    if (current.status === "disputed") {
      const escrow = getTaskOfferEscrowRecord(current.offerId)
      if (!escrow || escrow.status !== "frozen") {
        throw new TaskOfferConflictError(
          current.status,
          ["disputed"],
          "Disputed task offer is missing its frozen escrow receipt",
        )
      }
      return { offer: current, escrow, idempotent: true }
    }

    if (current.status !== "delivered") {
      throw new TaskOfferConflictError(current.status, ["delivered"])
    }

    const escrow = await freezeTaskOfferEscrow(current, actor, now)
    const disputed = transitionTaskOffer({
      offerId: current.offerId,
      actorId: actor,
      expected: "delivered",
      to: "disputed",
      patch: {
        disputeId: escrow.disputeId,
        disputedAt: now.toISOString(),
        rewardFrozen: true,
      },
      now,
    })
    publishTransition("task.offer.disputed", disputed, actor, {
      disputeId: escrow.disputeId,
    })
    return { offer: disputed, escrow, idempotent: false }
  })
}

export async function autoReleaseDeliveredTaskOffers(
  now: Date = new Date(),
): Promise<TaskOfferSettlementResult[]> {
  const due = listTaskOffers({ includeExpired: true }, now).filter((offer) => {
    if (offer.status !== "delivered" || !offer.deliveredAt) return false
    return now.getTime() - Date.parse(offer.deliveredAt) >= AUTO_RELEASE_DELAY_MS
  })

  const released: TaskOfferSettlementResult[] = []
  for (const candidate of due) {
    const result = await withOfferLock(candidate.offerId, async () => {
      const current = requireOffer(candidate.offerId, now)
      if (current.status !== "delivered" || !current.deliveredAt) return null
      if (now.getTime() - Date.parse(current.deliveredAt) < AUTO_RELEASE_DELAY_MS) return null
      return releaseDeliveredOffer(current, AUTO_RELEASE_ACTOR, now, true)
    })
    if (result) released.push(result)
  }
  return released
}

export function resetTaskOfferLifecycleLocksForTests(): void {
  lockState.queues.clear()
}
