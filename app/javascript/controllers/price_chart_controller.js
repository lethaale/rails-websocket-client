import { Controller } from "@hotwired/stimulus"

// Rolling line chart of every price observed on a single feed since the page
// loaded. X-axis is real time (oldest → now), Y-axis is price range over the
// current buffer. No sliding window: as time elapses the line gets denser, not
// shorter — so the JS Direct chart and the Rails chart can be compared at the
// same time scale even though JS sees ~50× more points than Rails.
//
// To keep the SVG path cheap we downsample on render: at most ~RENDER_POINTS
// segments are drawn, regardless of how many raw points the buffer holds.
const RENDER_INTERVAL_MS = 250
const RENDER_POINTS = 400
// Hard cap so a long-running tab can't grow unbounded. Generous enough that a
// dense feed (JS Direct ~50/sec) gets ~5 hours before the oldest points drop.
const BUFFER_CAP = 1_000_000

export default class extends Controller {
  static values = { source: String }
  static targets = ["polyline", "yMin", "yMid", "yMax", "last", "window", "xOldest", "svg"]

  connect() {
    this.points = []
    this.dirty = false
    this.handler = (e) => this.handlePrice(e)
    window.addEventListener("feed:price", this.handler)
    this.timer = setInterval(() => this.maybeRender(), RENDER_INTERVAL_MS)
  }

  disconnect() {
    window.removeEventListener("feed:price", this.handler)
    clearInterval(this.timer)
  }

  handlePrice(event) {
    const { source, price } = event.detail
    if (source !== this.sourceValue || !Number.isFinite(price)) return
    this.points.push({ t: Date.now(), p: price })
    if (this.points.length > BUFFER_CAP) this.points.shift()
    this.dirty = true
  }

  maybeRender() {
    if (!this.dirty || !this.hasPolylineTarget || !this.hasSvgTarget) return
    const pts = this.points
    if (pts.length < 2) return

    const t0 = pts[0].t
    const t1 = pts[pts.length - 1].t
    const span = t1 - t0 || 1

    let min = Infinity, max = -Infinity
    for (const pt of pts) {
      if (pt.p < min) min = pt.p
      if (pt.p > max) max = pt.p
    }
    const range = max - min || 1
    const viewBox = this.svgTarget.viewBox.baseVal
    const w = viewBox.width
    const h = viewBox.height

    // Downsample for rendering — pick at most RENDER_POINTS indices uniformly
    // along the buffer so the SVG path stays cheap even after long sessions.
    const stride = Math.max(1, Math.floor(pts.length / RENDER_POINTS))
    let d = ""
    let first = true
    for (let i = 0; i < pts.length; i += stride) {
      const pt = pts[i]
      const x = ((pt.t - t0) / span) * w
      const y = h - ((pt.p - min) / range) * h
      d += (first ? "" : " ") + x.toFixed(1) + "," + y.toFixed(1)
      first = false
    }
    // Always include the latest point so "now" is on the right edge.
    const lastPt = pts[pts.length - 1]
    const xLast = w
    const yLast = h - ((lastPt.p - min) / range) * h
    d += " " + xLast.toFixed(1) + "," + yLast.toFixed(1)
    this.polylineTarget.setAttribute("points", d)

    if (this.hasLastTarget) this.lastTarget.textContent = formatCurrency(lastPt.p)
    if (this.hasYMinTarget) this.yMinTarget.textContent = formatCurrency(min)
    if (this.hasYMaxTarget) this.yMaxTarget.textContent = formatCurrency(max)
    if (this.hasYMidTarget) this.yMidTarget.textContent = formatCurrency((min + max) / 2)
    if (this.hasXOldestTarget) this.xOldestTarget.textContent = `${formatDuration(span)} ago`
    if (this.hasWindowTarget) this.windowTarget.textContent = `${pts.length.toLocaleString()} pts · ${formatDuration(span)}`
    this.dirty = false
  }
}

function formatCurrency(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s - m * 60)
  return `${m}m${rem}s`
}
