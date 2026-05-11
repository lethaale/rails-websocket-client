class InsertPriceJob < ApplicationJob
  queue_as :default

  # Per-process registry of the most recent Binance event time we've already
  # broadcast, keyed by symbol. Lets a backed-up worker fast-drop stale jobs
  # instead of broadcasting yesterday's prices: when the queue starts trailing,
  # we'd rather show the audience the latest tick than catch up history.
  #
  # Process-local on purpose. If we end up running multiple worker processes
  # they each track their own max — at most one redundant broadcast per process,
  # which is fine for a toy demo. Swap to Rails.cache or a SELECT against
  # `prices` if you ever want strict global ordering.
  @@latest_lock = Mutex.new
  @@latest_event_ms = Hash.new(0)

  # Broadcast first so the user sees the row as soon as the job runs;
  # persistence happens after. This is the article's hard-won lesson.
  def perform(binance_message)
    symbol = binance_message["s"]
    event_ms = binance_message["E"]

    @@latest_lock.synchronize do
      return if event_ms <= @@latest_event_ms[symbol]
      @@latest_event_ms[symbol] = event_ms
    end

    binance_time = Time.at(0, event_ms, :millisecond) # preserve milliseconds!
    observed_at = Time.current

    price = Price.new(
      binance_time: binance_time,
      price: binance_message["p"],
      symbol: symbol,
    )

    Turbo::StreamsChannel.broadcast_prepend_to(
      "prices",
      target: "prices-list",
      partial: "prices/price",
      locals: { price: price, observed_at: observed_at, trade_id: binance_message["t"] }
    )

    price.save!
  end
end
