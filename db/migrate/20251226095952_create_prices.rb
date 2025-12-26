class CreatePrices < ActiveRecord::Migration[8.1]
  def change
    create_table :prices do |t|
      t.string :symbol
      t.decimal :price
      t.datetime :binance_time

      t.timestamps
    end
  end
end
