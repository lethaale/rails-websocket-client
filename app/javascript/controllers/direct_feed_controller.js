import { Controller } from "@hotwired/stimulus"
import { FeedMetrics } from "lib/metrics"
import { renderSnapshot } from "lib/stats_panel"

const MAX_ROWS = 100
const RENDER_INTERVAL_MS = 250

// Opens a WebSocket from the browser straight to the upstream feed.
// No Rails round-trip on the data path.
export default class extends Controller {
  static values = { url: String }
  static targets = [
    "content", "viewport",
    "mean", "p1", "p50", "p95", "p99", "stddev", "jitter",
    "msgPerSec", "msgPerMin", "msgPerHour",
    "dropRate", "internalMean", "internalP95", "internalMax",
    "total", "uptime", "status", "currentPrice"
  ]

  connect() {
    this.metrics = new FeedMetrics()
    this.dirty = true
    this.renderTimer = setInterval(() => this.maybeRender(), RENDER_INTERVAL_MS)
    this.openSocket()
  }

  disconnect() {
    clearInterval(this.renderTimer)
    if (this.socket) {
      this.socket.onclose = null
      this.socket.close()
    }
  }

  openSocket() {
    this.setStatus("connecting")
    const ws = new WebSocket(this.urlValue)
    this.socket = ws

    ws.onopen = () => this.setStatus("connected")
    ws.onerror = () => this.setStatus("error")
    ws.onclose = () => this.setStatus("disconnected")
    ws.onmessage = (event) => this.handleMessage(event.data)
  }

  handleMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (typeof msg.E !== "number") return

    const observedAt = Date.now()
    this.metrics.record({
      binanceTime: msg.E,
      tradeTime: typeof msg.T === "number" ? msg.T : undefined,
      observedAt,
      tradeId: typeof msg.t === "number" ? msg.t : undefined,
    })

    this.appendRow(msg, observedAt)
    this.dirty = true
  }

  appendRow(msg, observedAt) {
    const row = document.createElement("tr")
    row.className = "even:bg-gray-50"
    row.dataset.price = msg.p
    const latency = observedAt - msg.E
    const priceNum = Number(msg.p)
    const priceText = formatCurrency(priceNum)
    const binanceTime = formatClockMs(msg.E)
    const observedTime = formatClockMs(observedAt)

    row.innerHTML = `
      <td class="px-4 py-3 font-mono text-sm font-semibold text-gray-900">${escapeHtml(msg.s || "")}</td>
      <td class="px-4 py-3 text-right font-mono text-sm text-gray-900">${priceText}</td>
      <td class="px-4 py-3 text-sm text-gray-700">${binanceTime}</td>
      <td class="px-4 py-3 text-sm text-gray-700">
        ${observedTime}
        <p class="text-xs text-gray-500">Latency <b>${latency.toFixed(1)}</b> ms</p>
      </td>
    `

    this.contentTarget.prepend(row)
    while (this.contentTarget.children.length > MAX_ROWS) {
      this.contentTarget.removeChild(this.contentTarget.lastChild)
    }
    if (this.hasCurrentPriceTarget) this.currentPriceTarget.textContent = priceText
    window.dispatchEvent(new CustomEvent("feed:price", {
      detail: { source: "direct", price: priceNum }
    }))
    this.scrollToTop()
  }

  maybeRender() {
    if (!this.dirty) return
    const snapshot = this.metrics.snapshot()
    renderSnapshot(this, snapshot)
    window.dispatchEvent(new CustomEvent("feed:snapshot", {
      detail: { source: "direct", snapshot }
    }))
    this.dirty = false
  }

  setStatus(value) {
    if (this.hasStatusTarget) this.statusTarget.textContent = value
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

function formatClockMs(ms) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}
function pad(n) { return String(n).padStart(2, "0") }
function pad3(n) { return String(n).padStart(3, "0") }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}
