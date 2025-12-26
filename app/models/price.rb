class Price < ApplicationRecord
  after_commit on: :create do
    broadcast_append_later_to "prices", target: "prices-list"
  end

  after_commit on: :destroy do
    broadcast_remove_to "prices"
  end
end
