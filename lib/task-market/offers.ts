export type TaskOfferAsset = "XLM" | "USDC"
export type TaskOfferStatus = "open" | "claimed" | "delivered" | "accepted" | "disputed" | "expired" | "cancelled"

export interface TaskOfferReward {
  amount: string
  asset: TaskOfferAsset
}

export interface TaskOfferTransition {
  from: TaskOfferStatus | null
  to: TaskOfferStatus
  actorId: string
  at: string
}

export interface TaskOffer {
  offerId: string
  postedBy: string
  requiredCapability: string
  payload: unknown
  reward: TaskOfferReward
  deadline: number
  status: TaskOfferStatus
  escrowTx: string
  refundTx?: string
  claimedBy?: string
  result?: unknown
  deliveredAt?: string
  acceptedAt?: string
  disputedAt?: string
  payoutTx?: string
  disputeId?: string
  rewardFrozen?: boolean
  transitions: TaskOfferTransition[]
  createdAt: string
  updatedAt: string
}

export interface CreateTaskOfferInput {
  postedBy: string
  requiredCapability: string
  payload?: unknown
  reward: string | Partial<TaskOfferReward>
  deadline: number
}

export type TaskOfferTransitionPatch = Partial<
  Pick<
    TaskOffer,
    | "claimedBy"
    | "result"
    | "deliveredAt"
    | "acceptedAt"
    | "disputedAt"
    | "payoutTx"
    | "disputeId"
    | "rewardFrozen"
    | "refundTx"
  >
>

export interface TransitionTaskOfferInput {
  offerId: string
  actorId: string
  expected: TaskOfferStatus | readonly TaskOfferStatus[]
  to: TaskOfferStatus
  patch?: TaskOfferTransitionPatch
  now?: Date
}

interface TaskOfferState {
  offers: Map<string, TaskOffer>
  sequence: number
}

const globalState = globalThis as typeof globalThis & {
  __openStellarTaskOffers__?: TaskOfferState
}

const state: TaskOfferState = globalState.__openStellarTaskOffers__ ?? {
  offers: new Map(),
  sequence: 0,
}

globalState.__openStellarTaskOffers__ ??= state

export const TASK_OFFER_TRANSITIONS: Readonly<Record<TaskOfferStatus, readonly TaskOfferStatus[]>> = {
  open: ["claimed", "expired", "cancelled"],
  claimed: ["delivered"],
  delivered: ["accepted", "disputed"],
  accepted: [],
  disputed: [],
  expired: [],
  cancelled: [],
}

export class TaskOfferNotFoundError extends Error {
  readonly code = "TASK_OFFER_NOT_FOUND"

  constructor(readonly offerId: string) {
    super(`Task offer ${offerId} not found`)
    this.name = "TaskOfferNotFoundError"
  }
}

export class TaskOfferConflictError extends Error {
  readonly code = "TASK_OFFER_CONFLICT"

  constructor(
    readonly currentStatus: TaskOfferStatus,
    readonly expectedStatuses: readonly TaskOfferStatus[],
    message?: string,
  ) {
    super(message ?? `Task offer is ${currentStatus}; expected ${expectedStatuses.join(" or ")}`)
    this.name = "TaskOfferConflictError"
  }
}

function assertNonEmpty(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) throw new Error(`${field} is required`)
  return text
}

function nextOfferId(): string {
  state.sequence += 1
  return `off_${Date.now().toString(36)}_${state.sequence.toString(36)}`
}

function isTaskOfferAsset(value: unknown): value is TaskOfferAsset {
  return value === "XLM" || value === "USDC"
}

function normalizeReward(reward: string | Partial<TaskOfferReward>): TaskOfferReward {
  if (typeof reward === "string") {
    const match = /^(\d+(?:\.\d+)?)\s+(XLM|USDC)$/i.exec(reward.trim())
    if (!match) throw new Error("reward must be formatted like '0.05 XLM'")
    const amount = match[1]
    const asset = match[2].toUpperCase()
    if (Number(amount) <= 0) throw new Error("reward amount must be > 0")
    if (!isTaskOfferAsset(asset)) throw new Error("reward asset must be XLM or USDC")
    return { amount, asset }
  }

  if (!reward || typeof reward !== "object") {
    throw new Error("reward is required")
  }

  const amount = String(reward.amount ?? "").trim()
  const asset = String(reward.asset ?? "").trim().toUpperCase()
  if (!amount || Number(amount) <= 0 || !Number.isFinite(Number(amount))) {
    throw new Error("reward amount must be > 0")
  }
  if (!isTaskOfferAsset(asset)) throw new Error("reward asset must be XLM or USDC")
  return { amount, asset }
}

function normalizeDeadline(deadline: number): number {
  const value = Number(deadline)
  if (!Number.isFinite(value)) throw new Error("deadline must be a unix timestamp")
  const timestamp = value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
  if (timestamp <= Math.floor(Date.now() / 1000)) throw new Error("deadline must be in the future")
  return timestamp
}

function escrowHash(prefix: "escrow" | "refund", offerId: string): string {
  return `${prefix}_${offerId}_${crypto.randomUUID()}`
}

function timestamp(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) throw new Error("now must be a valid date")
  return now.toISOString()
}

function epochSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000)
}

function assertTransitionAllowed(from: TaskOfferStatus, to: TaskOfferStatus): void {
  if (!TASK_OFFER_TRANSITIONS[from].includes(to)) {
    throw new TaskOfferConflictError(
      from,
      TASK_OFFER_TRANSITIONS[from],
      `Cannot transition task offer from ${from} to ${to}`,
    )
  }
}

function commitTransition(
  offer: TaskOffer,
  to: TaskOfferStatus,
  actorId: string,
  patch: TaskOfferTransitionPatch,
  now: Date,
): TaskOffer {
  assertTransitionAllowed(offer.status, to)
  const at = timestamp(now)
  const next: TaskOffer = {
    ...offer,
    ...patch,
    status: to,
    updatedAt: at,
    transitions: [
      ...offer.transitions,
      {
        from: offer.status,
        to,
        actorId: assertNonEmpty(actorId, "actorId"),
        at,
      },
    ],
  }
  state.offers.set(offer.offerId, next)
  return next
}

function refreshOfferExpiry(offer: TaskOffer, now: Date = new Date()): TaskOffer {
  if (offer.status !== "open" || offer.deadline > epochSeconds(now)) {
    return offer
  }

  return commitTransition(
    offer,
    "expired",
    "system:deadline-expiry",
    {
      refundTx: offer.refundTx ?? escrowHash("refund", offer.offerId),
    },
    now,
  )
}

export function resetTaskOffersForTests(): void {
  state.offers.clear()
  state.sequence = 0
}

export function createTaskOffer(input: CreateTaskOfferInput): TaskOffer {
  const postedBy = assertNonEmpty(input.postedBy, "postedBy")
  const now = new Date()
  const createdAt = timestamp(now)
  const offerId = nextOfferId()
  const offer: TaskOffer = {
    offerId,
    postedBy,
    requiredCapability: assertNonEmpty(input.requiredCapability, "requiredCapability"),
    payload: input.payload ?? {},
    reward: normalizeReward(input.reward),
    deadline: normalizeDeadline(input.deadline),
    status: "open",
    escrowTx: escrowHash("escrow", offerId),
    transitions: [
      {
        from: null,
        to: "open",
        actorId: postedBy,
        at: createdAt,
      },
    ],
    createdAt,
    updatedAt: createdAt,
  }
  state.offers.set(offer.offerId, offer)
  return offer
}

export function getTaskOffer(offerId: string, now: Date = new Date()): TaskOffer | null {
  const offer = state.offers.get(offerId)
  return offer ? refreshOfferExpiry(offer, now) : null
}

export function listTaskOffers(
  filters: { requiredCapability?: string; includeExpired?: boolean } = {},
  now: Date = new Date(),
): TaskOffer[] {
  return [...state.offers.values()]
    .map((offer) => refreshOfferExpiry(offer, now))
    .filter((offer) => filters.includeExpired || offer.status === "open")
    .filter((offer) => !filters.requiredCapability || offer.requiredCapability === filters.requiredCapability)
    .sort((a, b) => a.deadline - b.deadline || a.offerId.localeCompare(b.offerId))
}

export function transitionTaskOffer(input: TransitionTaskOfferInput): TaskOffer {
  const raw = state.offers.get(input.offerId)
  if (!raw) throw new TaskOfferNotFoundError(input.offerId)

  const now = input.now ?? new Date()
  const offer = refreshOfferExpiry(raw, now)
  const expected = Array.isArray(input.expected) ? input.expected : [input.expected]
  if (!expected.includes(offer.status)) {
    throw new TaskOfferConflictError(offer.status, expected)
  }

  return commitTransition(
    offer,
    input.to,
    input.actorId,
    input.patch ?? {},
    now,
  )
}

export function cancelTaskOffer(offerId: string, actorId: string): TaskOffer {
  const offer = getTaskOffer(offerId)
  if (!offer) throw new TaskOfferNotFoundError(offerId)
  if (offer.postedBy !== actorId) throw new Error("Only the poster can cancel this offer")

  return transitionTaskOffer({
    offerId,
    actorId,
    expected: "open",
    to: "cancelled",
    patch: {
      refundTx: offer.refundTx ?? escrowHash("refund", offer.offerId),
    },
  })
}
