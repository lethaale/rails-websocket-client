class PricesController < ApplicationController
  def index
    @prices = Price.none
    respond_to do |format|
      format.html
      format.turbo_stream
    end
  end
end
