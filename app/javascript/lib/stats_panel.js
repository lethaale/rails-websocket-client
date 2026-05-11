import { formatMs, formatRate, formatInt, formatUptime } from "lib/metrics"

// Pushes a metrics snapshot into the stats panel targets owned by a controller.
// Targets named after the metric key (e.g. `p50Target`); missing targets are skipped.
export function renderSnapshot(controller, snapshot) {
  const set = (key, value) => {
    const name = `${key}Target`
    if (!controller[`has${capitalize(key)}Target`]) return
    controller[name].textContent = value
  }

  set("mean", formatMs(snapshot.mean))
  set("p1", formatMs(snapshot.p1))
  set("p50", formatMs(snapshot.p50))
  set("p95", formatMs(snapshot.p95))
  set("p99", formatMs(snapshot.p99))
  set("stddev", formatMs(snapshot.stddev))
  set("jitter", formatMs(snapshot.jitter))
  set("msgPerSec", formatInt(snapshot.msgPerSec))
  set("msgPerMin", formatInt(snapshot.msgPerMin))
  set("msgPerHour", formatInt(snapshot.msgPerHour))
  set("dropRate", snapshot.dropRate === null ? "--" : formatRate(snapshot.dropRate))
  set("internalMean", formatMs(snapshot.internalMean))
  set("internalP95", formatMs(snapshot.internalP95))
  set("internalMax", formatMs(snapshot.internalMax))
  set("total", formatInt(snapshot.total))
  set("uptime", formatUptime(snapshot.uptimeSec))
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
