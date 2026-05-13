import { Controller } from "@hotwired/stimulus"
import { FeedMetrics } from "lib/metrics"
import { renderSnapshot } from "lib/stats_panel"

const MAX_ROWS = 100
const RENDER_INTERVAL_MS = 250

// Observes Turbo Stream appends on its own subtree and feeds samples into the metrics.
// Samples are pulled from the rendered row's data attributes — no second source of truth.
export default class extends Controller {
  static targets = [
    "content", "viewport",
    "mean", "p1", "p50", "p95", "p99", "stddev", "jitter",
    "msgPerSec", "msgPerMin", "msgPerHour",
    "dropRate", "total", "uptime", "currentPrice"
  ]

  connect() {
    this.metrics = new FeedMetrics()
    this.dirty = true
    this.renderTimer = setInterval(() => this.maybeRender(), RENDER_INTERVAL_MS)
    this.observer = new MutationObserver((mutations) => this.handleMutations(mutations))
    this.observer.observe(this.contentTarget, { childList: true })
    this.maybeRender()
  }

  disconnect() {
    clearInterval(this.renderTimer)
    this.observer.disconnect()
  }

  handleMutations(mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue
        this.recordRow(node)
      }
    }
    while (this.contentTarget.children.length > MAX_ROWS) {
      this.contentTarget.removeChild(this.contentTarget.lastChild)
    }
    this.scrollToTop()
  }

  recordRow(row) {
    const binance = Number(row.dataset.binanceTime)
    const observed = Number(row.dataset.observedAt || row.dataset.createdAt)
    if (!Number.isFinite(binance) || !Number.isFinite(observed)) return
    const tradeId = Number(row.dataset.tradeId)
    this.metrics.record({
      binanceTime: binance,
      observedAt: observed,
      tradeId: Number.isFinite(tradeId) ? tradeId : undefined,
    })
    const price = Number(row.dataset.price)
    if (Number.isFinite(price)) {
      if (this.hasCurrentPriceTarget) {
        this.currentPriceTarget.textContent = formatCurrency(price)
      }
      window.dispatchEvent(new CustomEvent("feed:price", {
        detail: { source: "rails", price }
      }))
    }
    this.dirty = true
  }

  maybeRender() {
    if (!this.dirty) return
    const snapshot = this.metrics.snapshot()
    renderSnapshot(this, snapshot)
    window.dispatchEvent(new CustomEvent("feed:snapshot", {
      detail: { source: "rails", snapshot }
    }))
    this.dirty = false
  }

  scrollToTop() {
    const el = this.hasViewportTarget ? this.viewportTarget : this.contentTarget
    el.scrollTop = 0
  }
}

function formatCurrency(n) {
  if (!Number.isFinite(n)) return "--"
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
