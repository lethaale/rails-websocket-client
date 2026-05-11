class InsertPriceJob < ApplicationJob
  queue_as :default

  # Broadcast first so the user sees the row as soon as the job runs;
  # persistence happens after. This is the article's hard-won lesson.
  def perform(binance_message)
    binance_time = Time.at(0, binance_message["E"], :millisecond) # preserve milliseconds!
    observed_at = Time.current

    price = Price.new(
      binance_time: binance_time,
      price: binance_message["p"],
      symbol: binance_message["s"],
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
