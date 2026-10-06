import { createHash } from "node:crypto"
import type { TaskOffer, TaskOfferReward } from "@/lib/task-market/offers"

export type TaskOfferEscrowStatus = "locked" | "released" | "frozen"

export interface TaskOfferEscrowRecord {
  offerId: string
  escrowTx: string
  status: TaskOfferEscrowStatus
  reward: TaskOfferReward
  workerId?: string
  actorId?: string
  payoutTx?: string
  disputeId?: string
  lockedAt: string
  releasedAt?: string
  frozenAt?: string
}

export interface TaskOfferEscrowProvider {
  release(input: {
    offer: TaskOffer
    workerId: string
    actorId: string
    idempotencyKey: string
    now: Date
  }): Promise<{ payoutTx: string }>
  freeze(input: {
    offer: TaskOffer
    workerId: string
    actorId: string
    idempotencyKey: string
    now: Date
  }): Promise<{ disputeId: string }>
}

interface EscrowState {
  records: Map<string, TaskOfferEscrowRecord>
  provider: TaskOfferEscrowProvider
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

const receiptBackedX402Provider: TaskOfferEscrowProvider = {
  async release(input) {
    return {
      payoutTx: `x402_release_${digest(`${input.idempotencyKey}:${input.workerId}`)}`,
    }
  },
  async freeze(input) {
    return {
      disputeId: `escrow_dispute_${digest(`${input.idempotencyKey}:${input.actorId}`)}`,
    }
  },
}

const globalState = globalThis as typeof globalThis & {
  __openStellarTaskOfferEscrow__?: EscrowState
}

const state: EscrowState = globalState.__openStellarTaskOfferEscrow__ ?? {
  records: new Map(),
  provider: receiptBackedX402Provider,
}

globalState.__openStellarTaskOfferEscrow__ ??= state

export class TaskOfferEscrowConflictError extends Error {
  readonly code = "TASK_OFFER_ESCROW_CONFLICT"

  constructor(readonly escrowStatus: TaskOfferEscrowStatus, message: string) {
    super(message)
    this.name = "TaskOfferEscrowConflictError"
  }
}

function cloneRecord(record: TaskOfferEscrowRecord): TaskOfferEscrowRecord {
  return {
    ...record,
    reward: { ...record.reward },
  }
}

function ensureLockedRecord(offer: TaskOffer): TaskOfferEscrowRecord {
  const existing = state.records.get(offer.offerId)
  if (existing) return existing

  if (!offer.escrowTx) {
    throw new Error("Task offer has no escrow lock reference")
  }

  const record: TaskOfferEscrowRecord = {
    offerId: offer.offerId,
    escrowTx: offer.escrowTx,
    status: "locked",
    reward: { ...offer.reward },
    lockedAt: offer.createdAt,
  }
  state.records.set(offer.offerId, record)
  return record
}

export function configureTaskOfferEscrowProvider(provider: TaskOfferEscrowProvider): void {
  state.provider = provider
}

export function getTaskOfferEscrowRecord(offerId: string): TaskOfferEscrowRecord | null {
  const record = state.records.get(offerId)
  return record ? cloneRecord(record) : null
}

export function resetTaskOfferEscrowForTests(): void {
  state.records.clear()
  state.provider = receiptBackedX402Provider
}

export async function releaseTaskOfferEscrow(
  offer: TaskOffer,
  actorId: string,
  now: Date = new Date(),
): Promise<TaskOfferEscrowRecord> {
  const workerId = offer.claimedBy
  if (!workerId) throw new Error("Task offer has no claimed worker")

  const current = ensureLockedRecord(offer)
  if (current.status === "released") return cloneRecord(current)
  if (current.status === "frozen") {
    throw new TaskOfferEscrowConflictError(
      current.status,
      "Disputed task-offer reward is frozen and cannot be released",
    )
  }

  const release = await state.provider.release({
    offer,
    workerId,
    actorId,
    idempotencyKey: `task-offer:${offer.offerId}:release`,
    now,
  })

  const released: TaskOfferEscrowRecord = {
    ...current,
    status: "released",
    workerId,
    actorId,
    payoutTx: release.payoutTx,
    releasedAt: now.toISOString(),
  }
  state.records.set(offer.offerId, released)
  return cloneRecord(released)
}

export async function freezeTaskOfferEscrow(
  offer: TaskOffer,
  actorId: string,
  now: Date = new Date(),
): Promise<TaskOfferEscrowRecord> {
  const workerId = offer.claimedBy
  if (!workerId) throw new Error("Task offer has no claimed worker")

  const current = ensureLockedRecord(offer)
  if (current.status === "frozen") return cloneRecord(current)
  if (current.status === "released") {
    throw new TaskOfferEscrowConflictError(
      current.status,
      "Released task-offer reward cannot be disputed",
    )
  }

  const freeze = await state.provider.freeze({
    offer,
    workerId,
    actorId,
    idempotencyKey: `task-offer:${offer.offerId}:dispute`,
    now,
  })

  const frozen: TaskOfferEscrowRecord = {
    ...current,
    status: "frozen",
    workerId,
    actorId,
    disputeId: freeze.disputeId,
    frozenAt: now.toISOString(),
  }
  state.records.set(offer.offerId, frozen)
  return cloneRecord(frozen)
}
