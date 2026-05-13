import { Controller } from "@hotwired/stimulus"

// Listens for `feed:price` events from both feed controllers and shows whether
// the two paths currently agree on the price. Tracks the share of elapsed time
// spent in the mismatch state at millisecond resolution: every time the state
// flips, we add the elapsed delta to the appropriate bucket.
export default class extends Controller {
  static targets = ["flag", "label", "divergence", "delta", "directPrice", "railsPrice"]

  connect() {
    this.latest = { direct: null, rails: null }
    this.startedAt = null         // ms timestamp when both feeds came online
    this.lastFlipAt = null        // ms timestamp of the last state change
    this.divergedMs = 0           // accumulated ms in mismatch state
    this.matching = null          // current state: true / false / null (not ready)
    this.handler = (e) => this.handlePrice(e)
    window.addEventListener("feed:price", this.handler)
    // Tick once a second so the % keeps moving even while no events arrive
    // (e.g. a sustained mismatch).
    this.tick = setInterval(() => this.render(), 1000)
    this.render()
  }

  disconnect() {
    window.removeEventListener("feed:price", this.handler)
    clearInterval(this.tick)
  }

  handlePrice(event) {
    const { source, price } = event.detail
    if (!this.latest.hasOwnProperty(source) || !Number.isFinite(price)) return
    this.latest[source] = price

    const { direct, rails } = this.latest
    const now = performance.now()

    if (direct == null || rails == null) {
      this.render()
      return
    }

    if (this.startedAt == null) {
      this.startedAt = now
      this.lastFlipAt = now
      this.matching = direct === rails
      this.render()
      return
    }

    const nowMatching = direct === rails
    if (nowMatching !== this.matching) {
      if (this.matching === false) {
        // We're leaving mismatch state: bank the elapsed mismatch ms.
        this.divergedMs += now - this.lastFlipAt
      }
      this.matching = nowMatching
      this.lastFlipAt = now
    }
    this.render()
  }

  render() {
    const { direct, rails } = this.latest
    const ready = direct != null && rails != null
    const match = ready && direct === rails

    if (this.hasFlagTarget) {
      this.flagTarget.className = `inline-block h-3 w-3 rounded-full ${
        !ready ? "bg-gray-300" : match ? "bg-emerald-500" : "bg-red-500"
      }`
    }
    if (this.hasLabelTarget) {
      this.labelTarget.textContent = !ready ? "Waiting for both feeds" : match ? "Prices match" : "Prices differ"
      this.labelTarget.className = `text-sm font-semibold ${
        !ready ? "text-gray-500" : match ? "text-emerald-700" : "text-red-700"
      }`
    }
    if (this.hasDirectPriceTarget) this.directPriceTarget.textContent = direct == null ? "--" : formatCurrency(direct)
    if (this.hasRailsPriceTarget) this.railsPriceTarget.textContent = rails == null ? "--" : formatCurrency(rails)
    if (this.hasDeltaTarget) {
      if (!ready) {
        this.deltaTarget.textContent = "--"
        this.deltaTarget.className = "tabular-nums text-gray-500"
      } else {
        const diff = Math.abs(direct - rails)
        this.deltaTarget.textContent = formatCurrency(diff)
        this.deltaTarget.className = `tabular-nums font-semibold ${diff === 0 ? "text-emerald-700" : "text-red-700"}`
      }
    }
    if (this.hasDivergenceTarget) this.divergenceTarget.textContent = this.formatDivergence()
  }

  formatDivergence() {
    if (this.startedAt == null) return "--"
    const now = performance.now()
    const totalMs = now - this.startedAt
    if (totalMs <= 0) return "--"
    const liveDelta = this.matching === false ? now - this.lastFlipAt : 0
    const diverged = this.divergedMs + liveDelta
    const pct = (diverged / totalMs) * 100
    return `${pct.toFixed(2)}% (${formatDuration(diverged)} / ${formatDuration(totalMs)})`
  }
}

function formatCurrency(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remSec = Math.round(seconds - minutes * 60)
  return `${minutes}m${remSec}s`
}
