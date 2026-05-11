# Production runs all Solid* tables (queue, cable, cache) in the same Postgres
# database as the app. Development still keeps four SQLite files with their
# own schema dumps, so we load those schemas into the primary connection at
# deploy time instead of moving them into the canonical db/schema.rb.

namespace :db do
  desc "Load Solid Queue / Cable / Cache schemas into the primary database (Postgres production setup)"
  task load_solid_schemas: :environment do
    %w[queue_schema.rb cable_schema.rb cache_schema.rb].each do |file|
      schema = Rails.root.join("db", file)
      unless schema.exist?
        warn "Skipping #{file} — not found"
        next
      end
      puts "Loading #{file} into #{ActiveRecord::Base.connection_db_config.database}"
      load schema
    end
  end
end
