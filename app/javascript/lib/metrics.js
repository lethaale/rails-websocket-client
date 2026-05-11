// Pure metrics helpers used by both feed controllers.
//
// A "sample" is: { binanceTime, observedAt, tradeId? }
//   - binanceTime: ms epoch from Binance `E` field
//   - observedAt:  ms epoch when this tab saw it
//   - tradeId:     optional Binance `t` field (only present for JS-direct)
//
// Latency stats use the most recent LATENCY_WINDOW samples.
// Throughput uses timestamps inside a rolling 1h window.

const LATENCY_WINDOW = 5000
const THROUGHPUT_WINDOW_MS = 60 * 60 * 1000

export class FeedMetrics {
  constructor() {
    this.latencies = []
    this.internals = []
    this.internalMax = null
    this.timestamps = []
    this.lastLatency = null
    this.jitterSum = 0
    this.jitterCount = 0
    this.firstTradeId = null
    this.lastTradeId = null
    this.tradeCount = 0
    this.startedAt = Date.now()
    this.total = 0
  }

  record(sample) {
    const latency = sample.observedAt - sample.binanceTime
    this.latencies.push(latency)
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift()

    if (typeof sample.tradeTime === "number") {
      const internal = sample.binanceTime - sample.tradeTime
      this.internals.push(internal)
      if (this.internals.length > LATENCY_WINDOW) this.internals.shift()
      if (this.internalMax === null || internal > this.internalMax) this.internalMax = internal
    }

    if (this.lastLatency !== null) {
      this.jitterSum += Math.abs(latency - this.lastLatency)
      this.jitterCount += 1
    }
    this.lastLatency = latency

    this.timestamps.push(sample.observedAt)
    const cutoff = sample.observedAt - THROUGHPUT_WINDOW_MS
    while (this.timestamps.length && this.timestamps[0] < cutoff) {
      this.timestamps.shift()
    }

    if (typeof sample.tradeId === "number") {
      if (this.firstTradeId === null) this.firstTradeId = sample.tradeId
      this.lastTradeId = sample.tradeId
      this.tradeCount += 1
    }

    this.total += 1
  }

  snapshot() {
    return {
      total: this.total,
      uptimeSec: (Date.now() - this.startedAt) / 1000,
      mean: mean(this.latencies),
      p1: percentile(this.latencies, 0.01),
      p50: percentile(this.latencies, 0.5),
      p95: percentile(this.latencies, 0.95),
      p99: percentile(this.latencies, 0.99),
      stddev: stddev(this.latencies),
      jitter: this.jitterCount > 0 ? this.jitterSum / this.jitterCount : null,
      msgPerSec: countWithin(this.timestamps, 1000),
      msgPerMin: countWithin(this.timestamps, 60 * 1000),
      msgPerHour: this.timestamps.length,
      dropRate: this.tradeCount > 1 && this.lastTradeId !== null
        ? 1 - this.tradeCount / (this.lastTradeId - this.firstTradeId + 1)
        : null,
      internalMean: mean(this.internals),
      internalP95: percentile(this.internals, 0.95),
      internalMax: this.internalMax,
    }
  }
}

function mean(xs) {
  if (xs.length === 0) return null
  let sum = 0
  for (const x of xs) sum += x
  return sum / xs.length
}

function stddev(xs) {
  if (xs.length < 2) return null
  const m = mean(xs)
  let sq = 0
  for (const x of xs) sq += (x - m) ** 2
  return Math.sqrt(sq / xs.length)
}

function percentile(xs, p) {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

function countWithin(timestamps, windowMs) {
  if (timestamps.length === 0) return 0
  const cutoff = Date.now() - windowMs
  let count = 0
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] < cutoff) break
    count += 1
  }
  return count
}

export function formatMs(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--"
  return `${value.toFixed(1)} ms`
}

export function formatRate(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--"
  return `${(value * 100).toFixed(3)}%`
}

export function formatInt(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--"
  return Math.round(value).toLocaleString()
}

export function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "--"
  const s = Math.floor(seconds % 60)
  const m = Math.floor((seconds / 60) % 60)
  const h = Math.floor(seconds / 3600)
  return `${h}h ${m}m ${s}s`
}
