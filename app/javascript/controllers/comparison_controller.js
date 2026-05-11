import { Controller } from "@hotwired/stimulus"
import { formatMs } from "lib/metrics"

// Listens for snapshot events from both feed controllers and renders a
// side-by-side bar comparison. Bars are normalized to the larger value per row,
// so each row answers "how much taller is the Rails bar than the Direct one?".
export default class extends Controller {
  static targets = ["row"]

  connect() {
    this.snapshots = { direct: null, rails: null }
    this.handler = (e) => this.handleSnapshot(e)
    window.addEventListener("feed:snapshot", this.handler)
  }

  disconnect() {
    window.removeEventListener("feed:snapshot", this.handler)
  }

  handleSnapshot(event) {
    const { source, snapshot } = event.detail
    if (!this.snapshots.hasOwnProperty(source)) return
    this.snapshots[source] = snapshot
    this.render()
  }

  render() {
    const direct = this.snapshots.direct
    const rails = this.snapshots.rails

    for (const row of this.rowTargets) {
      const key = row.dataset.key
      const d = direct ? direct[key] : null
      const r = rails ? rails[key] : null
      const max = Math.max(d || 0, r || 0) || 1

      setBar(row, "directBar", d, max)
      setBar(row, "railsBar", r, max)
      setText(row, "directValue", formatMs(d))
      setText(row, "railsValue", formatMs(r))
      setText(row, "delta", formatDelta(d, r))
    }
  }
}

function setBar(row, cell, value, max) {
  const el = row.querySelector(`[data-cell="${cell}"]`)
  if (!el) return
  const pct = (value != null && Number.isFinite(value)) ? (Math.max(value, 0) / max) * 100 : 0
  el.style.width = `${pct}%`
}

function setText(row, cell, text) {
  const el = row.querySelector(`[data-cell="${cell}"]`)
  if (!el) return
  el.textContent = text
}

function formatDelta(direct, rails) {
  if (direct == null || rails == null || !Number.isFinite(direct) || !Number.isFinite(rails)) return "--"
  const diff = rails - direct
  const sign = diff >= 0 ? "+" : "−"
  const abs = Math.abs(diff).toFixed(0)
  if (direct === 0) return `${sign}${abs} ms`
  const ratio = rails / direct
  return `${sign}${abs} ms  (${ratio.toFixed(1)}×)`
}
