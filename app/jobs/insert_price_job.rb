class InsertPriceJob < ApplicationJob
  queue_as :default

  # {"e" => "trade", "E" => 1766747742582, "s" => "BTCUSDT", "t" => 5707873907, "p" => "88667.01000000", "q" => "0.00006000", "T" => 1766747742582, "m" => true, "M" => true}
  def perform(binance_message)
    binance_time = Time.at(0, binance_message["E"], :millisecond) # preserve milliseconds!

    price = Price.create(
      binance_time: binance_time,
      price: binance_message["p"], # price in USD
      symbol: binance_message["s"], # symbol (e.g. BTCUSDT)
    )
  end
end
