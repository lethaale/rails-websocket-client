import { Controller } from "@hotwired/stimulus"

// Keeps the table scrolled to the newest row and computes average latency client-side.
export default class extends Controller {
  static targets = ["content", "viewport", "ingestAverage"]

  connect() {
    document.addEventListener("turbo:before-stream-render", this.handleBeforeStreamRender)
    this.observer = new MutationObserver(() => this.updateAverage())
    if (this.contentTarget) {
      this.observer.observe(this.contentTarget, { childList: true })
    }
    this.updateAverage()
    this.scrollToBottom()
  }

  disconnect() {
    document.removeEventListener("turbo:before-stream-render", this.handleBeforeStreamRender)
    if (this.observer) this.observer.disconnect()
  }

  handleBeforeStreamRender = (event) => {
    const stream = event.detail?.newStream
    if (!stream) return

    const action = stream.getAttribute("action") || "append"
    const targetId = stream.getAttribute("target")
    const targetElement = targetId ? document.getElementById(targetId) : null
    const affectsList =
      (action === "append" && targetId === this.contentTarget.id) ||
      (targetElement && this.contentTarget.contains(targetElement))

    if (!affectsList) return

    const render = event.detail.render
    event.detail.render = (streamElement) => {
      render(streamElement)
      this.updateAverage()
      if (action === "append" && targetId === this.contentTarget.id) {
        this.scrollToBottom()
      }
    }
  }

  updateAverage() {
    if (!this.contentTarget) return

    let ingestTotal = 0
    let count = 0

    this.contentTarget.querySelectorAll("[data-binance-time][data-created-at]").forEach((row) => {
      const binanceRaw = row.dataset.binanceTime
      const createdRaw = row.dataset.createdAt
      if (!binanceRaw || !createdRaw) return

      const binanceMs = Number(binanceRaw)
      const createdMs = Number(createdRaw)
      if (!Number.isFinite(binanceMs) || !Number.isFinite(createdMs)) return

      ingestTotal += createdMs - binanceMs
      count += 1
    })

    if (count === 0) {
      if (this.hasIngestAverageTarget) this.ingestAverageTarget.textContent = "--"
      return
    }

    const ingestAvg = ingestTotal / count

    if (this.hasIngestAverageTarget) this.ingestAverageTarget.textContent = `${ingestAvg.toFixed(3)} ms`
  }

  scrollToBottom() {
    const element = this.viewportTarget || this.contentTarget
    if (!element) return
    element.scrollTop = element.scrollHeight
  }
}

