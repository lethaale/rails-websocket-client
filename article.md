# Rails Is the Websocket Client

_External WebSockets, production real-time, $5 a month_

---

I run a product called Aura — a trading terminal built on top of Hyperliquid and Polymarket. Like any trading interface, Aura needs real-time data flowing through it constantly: prices, orderbook updates, executions. Nothing exotic, but it gave me a problem I hadn't really had to think about much before. How do you get a fast-moving external data stream into a Rails app, without your Rails app turning into something it isn't built to be?

The same shape of problem comes up in plenty of other places. Anywhere you need sub-second freshness from a source you don't own — IoT telemetry, live sports scores, sensor data, market feeds — you run into the same constraints. External feed, your app, no time to spare.

This article is the architecture I landed on. We ran it in production at Aura, and it was delightfully boring. I'll use a public Binance price feed as the example because it's free and the messages are easy to read, but the same pattern works for any of the use cases above. In Aura, prices came from [Codex](https://codex.io?utm_source=aura&utm_medium=article&utm_campaign=tech-blog-feature) (tracked link, not sponsored).

To make it concrete, here's the baseline. Open a terminal:

```
wscat -c wss://stream.binance.com:9443/ws/btcusdt@trade
```

Prices land immediately:

```json
{ "E": 1766317157027, "p": "88643.90000000" }
```

Multiple messages per second. You don't control the rate. The connection stays open indefinitely. This is what _real-time_ feels like, and it's the bar a Rails app has to clear.

[video: wscat in one window, the same trades rendering in a Rails app in another]

Pause the video anywhere — the most recent price in `wscat` is the most recent price in Rails. Honestly, you can't really tell which one is leading.

That's the result. Source code: [github.com/lethaale/rails-websocket-client](https://github.com/lethaale/rails-websocket-client).

The interesting part isn't the architecture itself — it's pretty straightforward once you draw it. The interesting part is that every Rails dev I've shown it to, without exception, asks the wrong question first.

---

## Rails is the client

Whenever I describe this problem to other Rails devs, the first reaction is always the same: _"why aren't you using ActionCable / AnyCable?"_

It's a fair question — but it's the wrong question for this problem.

ActionCable is for when **Rails is the server**. Your app emits events, clients subscribe, your app broadcasts. Solid Cable is the same shape. That's the standard real-time story in Rails, and Rails handles it really well.

What I'm describing is the opposite. **Rails is the websocket client.** I'm subscribing to a stream I don't own, from a process I don't control, with a cadence I can't predict. That's a different problem with a different shape, and Rails is bad at it — not bad at real-time, just bad at babysitting someone else's socket.

That single distinction does most of the work in this article. Once you see it, everything else is pretty mechanical.

### What about modern Ruby concurrency?

Fair pushback. Async + Falcon + the Fiber scheduler can hold thousands of long-lived connections in a single Ruby process.

So why didn't I use them? A few reasons, none of them a knock against Ruby:

- **Deployment cadence.** I redeploy Rails multiple times a day. The Go listener might get redeployed twice a month. If the WebSocket lives inside Rails, every Rails deploy drops the upstream connection — even with Falcon. With a separate process, the two deploy lifecycles don't touch each other. The TL;DR is: a small standalone app talking to your DB is just easier to keep alive.
- **Operational simplicity.** Most Rails shops run Puma, mine included. Switching to Falcon for one use case means a new server, new quirks, new failure modes — and I'd still have the deploy problem above.
- **Code simplicity.** "Open socket, read message, write to DB" is around 80 lines of Go. Even with Async, the Ruby version is bigger and ends up coupled to the Rails process lifecycle.

Faye + EventMachine inside Rails? I tried that in v1. EventMachine wants the event loop, Rails wants its lifecycle, deploys got scary. I wouldn't recommend it.

---

## The architecture

The whole thing fits in one diagram:

```
Binance WebSocket
       ↓
   Go listener
       ↓
      Queue
       ↓
Rails Active Job
       ↓
   Hotwire UI
```

Five arrows, one process boundary. Go owns the socket connection. Rails owns the meaning of the data — the validation, the persistence, the business logic, the UI.

**The queue is whatever you already use.** Solid Queue, Sidekiq, RabbitMQ, SQS, Kafka, raw Redis lists — they all work. The contract is just "Go writes a message somewhere, Rails reads it from there." I went with Solid Queue because it ships with Rails 8 and needs no extra infrastructure (it's just rows in your database), but you should swap it for whatever your app already runs.

If you skip Active Job entirely and write straight to Redis, you're trading convenience for control — you'll have to handle retries and idempotency yourself. For most Rails apps, Active Job is the right floor to stand on.

That's the whole architecture. The rest is implementation.

---

## The Go listener

The Go side is small enough to fit in your head. The shape of it:

```go
for msg := range readWebSocket(binanceURL) {
    insertSolidQueueJob(db, "InsertPriceJob", msg)
    insertSolidQueueReadyExecution(db, jobID)
}
```

Open the socket, read messages, insert two rows per message. The real implementation — with reconnects, backoff, JSON marshaling, signal handling — is around 80 lines. [Full code in the repo.](https://github.com/lethaale/rails-websocket-client/tree/main/script/go-websockets)

Two tables because Solid Queue needs both: `solid_queue_jobs` for the job record, and `solid_queue_ready_executions` for the "this job is ready to run" marker. (Big thanks to Rosa for helping me get this part right — Solid Queue's internals aren't always obvious.)

**One important security note:** create a dedicated DB user with write-only access to those two tables, and nothing else. If the Go process ever gets compromised, the worst case is "queue spam," not "your application database is now somebody else's."

_TL;DR is that Go is really cheap at I/O._ Goroutines are lightweight tasks scheduled onto OS threads, and the netpoller blocks individual goroutines on socket I/O without blocking the underlying threads. So you can have thousands of long-lived connections, each doing very little, all in one small process. Ruby's Async + Fiber scheduler is the closest analog if you want to think about it in Ruby terms.

---

## The Rails side

The Rails side is, well, the Rails part of a Rails app. There's a migration for a `Price` model, a controller, an index view with Turbo Streams. Solid Queue picks up the jobs the Go listener wrote.

```ruby
class InsertPriceJob < ApplicationJob
  def perform(payload)
    binance_time = Time.at(0, binance_message["E"], :millisecond) # preserve milliseconds!
    observed_at = Time.current

    price = Price.new(
      binance_time: binance_time,
      price: binance_message["p"],
      symbol: binance_message["s"],
    )

    Turbo::StreamsChannel.broadcast_append_to(
      "prices",
      target: "prices-list",
      partial: "prices/price",
      locals: { price: price, observed_at: observed_at }
    )

    price.save!
  end
end
```

(Binance gives us millisecond timestamps in `E`, hence the `:millisecond` decomposition.)

Rails workers process the job like any other background job. Hotwire pushes the update to every connected client subscribed to `prices_list`, and the index page updates in real time. With a small Stimulus controller, I show a running average of the difference between the Binance event time and the database `created_at` — and it's almost always under 200ms end-to-end.

[Full source.](https://github.com/lethaale/rails-websocket-client)

---

## How fast is fast?

To make sure I wasn't just hand-waving, I ran the same Binance feed through three different setups and measured end-to-end latency — from the Binance event timestamp (`E`) to whatever lands in the UI:

1. **`wscat` in a terminal.** The baseline. Nothing between the socket and your eyes except the terminal renderer. About as fast as software gets.
2. **WebSocket directly in JavaScript, in the browser.** The browser opens the socket itself, parses the JSON, updates the DOM. No server round-trip.
3. **Go listener → Solid Queue → Rails Active Job → Turbo Streams → browser.** The architecture in this article.

Ballpark numbers from my setup: `wscat` is essentially at the network floor (a couple of ms), JS-direct lands in the low tens of ms, Go + Rails comes in around 150–200ms end-to-end.

So yes — going through Rails is slower than a JS-direct subscription. That's the honest tradeoff. What you get in return is that all your business logic, persistence, idempotency, and UI live in Rails — where they belong — and you're not writing trading logic in JavaScript on top of a raw socket.

For most products, the bar you're trying to clear isn't "absolute fastest"; it's "fast enough that the user can't tell." 200ms feels live. 30ms feels live. The user really can't tell.

### A note on how I measured

All three sources subtract Binance's `E` field from the same client clock at render time, so any NTP skew cancels in the _relative_ comparison between sources. Absolute numbers are approximate; the gaps between architectures are what's reliable.

For each source I track p50, p95, p99, standard deviation, and jitter (mean absolute change between consecutive samples), plus drop rate from gaps in the Binance trade ID sequence. p95 and p99 tell you more about real-time UX than the mean does — a user who sees one trade at 150ms and the next at 1500ms experiences the system as broken even if the average is fine.

If you want to reproduce or extend this, the [demo repo](https://github.com/lethaale/rails-websocket-latency-demo) has the three-source comparison live, with stats panels per source and the measurement code.

---

## The hard part: idempotency, modeling, and the order that matters

This is probably the part of the article where I have the most scars.

Once messages are flowing into Rails, you have to decide what to do with them. There are basically three options:

- **Latest only.** Keep one row per asset, overwrite on each update. Simple, low storage, but you lose history.
- **Every data point.** Append every trade to a time-series table. Full history, great for analysis, but storage gets heavy and it's often more than you actually need.
- **Hybrid.** Time-series table for history, plus a denormalized "current price" on the asset model for fast lookups. Compute derived metrics (24h change, VWAP, realized volatility) off the time-series. This is what we used — TimescaleDB for the time-series, a column on `Asset` for the current price.

The hybrid is what I'd recommend for almost any production case. It's the boring middle option, and the boring middle option tends to be right.

Idempotency matters because the same message can show up twice (the queue retries jobs, the upstream might re-send on reconnect, etc.). I use the upstream timestamp + symbol as the uniqueness key. Don't use the queue's job ID — it's an implementation detail of the queue, not of the data, and you'll regret it the first time you swap queue providers.

And here's the thing I learned the hard way — small, but it changed everything about how the app feels:

**In the Rails job, broadcast to the client first. Then do everything else.**

Persistence, derived metrics, validation, downstream notifications — all of that comes _after_ the Turbo Stream goes out. Why? Because the user's perception of real-time is the entire product. A 50ms delay before the price ticks on screen is the difference between "this feels live" and "this feels like a Rails app."

I shipped the obvious order first — persist, then broadcast — and the latency was fine on paper but felt sluggish in the browser. Flipping the order took five minutes and made the app feel native. I'd say I planned that, but I didn't. It's the kind of thing you only really learn by shipping.

---

## In production

We ran this in production at Aura. One Go program held three different external WebSockets — three feeds, three different upstream services — and wrote to three separate queues. Rails workers picked from each queue independently.

In a busy month, this setup processed over **10 million messages on a single $5 DigitalOcean droplet.** The Go process barely registered on the CPU graph. We used [Codex](https://codex.io?utm_source=aura&utm_medium=article&utm_campaign=tech-blog-feature) for hundreds of real-time price feeds (link is tracked but not sponsored).

The architecture was delightfully boring. It didn't fall over, it didn't need babysitting, and deploys went through without anyone noticing. I'd redeploy Rails multiple times a day; the Go listener kept eating messages, queue depth would grow for a few seconds, then drain. The Go listener itself I'd redeployed maybe twice in the months it ran. The two were completely decoupled, and that was exactly the point.

Aura is still around, just not on Rails anymore — trade signing happens on the frontend now (via Privy MPC) for safety and latency reasons specific to trading apps, and the rest of the stack followed. That migration had nothing to do with this architecture. For any product where your backend still owns the real work — which is most products — this pattern still applies, and I'd build it the same way again.

---

## When you actually need this

Honestly, you don't need this for every external integration. Most providers offer webhooks, and webhooks are simpler. If they work for you, use them.

You need this pattern when webhooks fail you, and they fail for two reasons:

1. **Rate.** The provider can't or won't push hundreds of events per second to a webhook endpoint, or the throttling and cost make it impractical at your volume.
2. **Speed.** Webhook latency is bounded by HTTP round-trips, batching, retries, and network. If you need millisecond-level freshness, webhooks are structurally too slow.

If you're processing a few events per minute, just use webhooks. If you're processing hundreds of events per second, or you need sub-100ms end-to-end, you probably want this.

**Where to deploy.** The Go listener can run on the same droplet as Rails (different process), or on its own $5 box. Both work fine. We used a separate box so Rails deploys didn't touch the listener at all.

**What to monitor.** Two signals do most of the work: connection uptime in the Go logs, and queue depth in your job queue. If either one starts looking weird, you'll know.

---

## Scaling and adapting

A few quick notes for fitting this to your stack:

- **Different database?** The Go listener doesn't really care. Update the connection adapter; the insert logic stays the same.
- **Different queue?** Same idea — adjust the writes on the Go side, and Rails just consumes via Active Job.
- **Different language entirely?** Rust, Node, Python, whatever you're comfortable with. The pattern is "open socket, write to queue." The language doesn't matter much. (In theory you could even use Faye + EventMachine in Ruby. I wouldn't, but you could. 😆)
- **Health checks.** Add metrics, structured logs, and retry logic on the listener side. Watch connection uptime and queue size.

Everything else lives in the repo's README.

---

## Going global

For a single-region app — users and providers all in roughly the same part of the world — collocate everything and skip this section.

For a global app, the latency budget splits into three legs: Binance → Go listener, Go → DB → Rails, and Rails → the user's browser. The third leg is usually the biggest, because the Hotwire broadcast travels over the persistent ActionCable WebSocket between your Rails server and the user's tab. The round-trip on that socket is what the user actually feels.

I haven't shipped this multi-region, but the shape of the answer seems clear enough:

- **Go listener: near the emitter.** WebSocket data is one-way streaming, so a listener near users would just give every regional copy the same upstream latency penalty. One listener near the source feeds everyone.
- **Rails: near users.** The user-perceived latency is dominated by the round-trip on the ActionCable socket; regional Rails deployments help here.
- **The layer between them is its own design problem.** Multiple Rails regions reading from the same queue means cross-region DB replication and its consistency tradeoffs. A distributed message broker (Kafka, NATS, Redis with replication) is cleaner but adds operational weight. Or you accept that distant users eat a higher last-mile latency and call it a day.

If you're solving this for real, your scale will tell you which is right. I'm not pretending to have shipped it.

---

## Thank you

To **DHH** — at Rails World we managed to talk for literally five minutes, and he just said _"It's okay to use Go for this, it's like Kamal proxy."_ That sentence is half this article.

To **Rosa** — for her interest in this, her help with Solid Queue internals, and (let's not forget) for writing it in the first place.

To **Thoughtbot** — for pushing our DevOps to the next level and giving us a broader audience to talk to.

To **Erik** — for helping me get Go right.

And to my colleagues at Aura who helped find this solution.
