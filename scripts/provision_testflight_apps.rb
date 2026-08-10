require "spaceship"

Target = Struct.new(
  :bundle_identifier,
  :bundle_name,
  :app_name,
  :sku,
  keyword_init: true
)

TARGETS = [
  Target.new(
    bundle_identifier: "run.kan.koyomi",
    bundle_name: "Koyomi iOS",
    app_name: "こよみ by kandotrun",
    sku: "kandotrun-koyomi-ios"
  ),
  Target.new(
    bundle_identifier: "run.kan.koyomi.widget",
    bundle_name: "Koyomi Widget"
  ),
  Target.new(
    bundle_identifier: "run.kan.treewatering",
    bundle_name: "Tree Watering iOS",
    app_name: "木のみず by kandotrun",
    sku: "kandotrun-tree-watering-ios"
  )
].freeze

def ensure_bundle_id(target)
  bundle_id = Spaceship::ConnectAPI::BundleId.find(target.bundle_identifier)
  if bundle_id
    puts "Bundle ID #{target.bundle_identifier}: present"
    return bundle_id
  end

  bundle_id = Spaceship::ConnectAPI::BundleId.create(
    name: target.bundle_name,
    platform: "IOS",
    identifier: target.bundle_identifier
  )
  puts "Bundle ID #{target.bundle_identifier}: created"
  bundle_id
end

def ensure_app(target, bundle_id)
  return unless target.app_name

  app = Spaceship::ConnectAPI::App.find(target.bundle_identifier)
  if app
    puts "App #{target.bundle_identifier}: present"
    return app
  end

  app = Spaceship::ConnectAPI::App.create(
    name: target.app_name,
    version_string: "1.0",
    sku: target.sku,
    primary_locale: "ja",
    bundle_id: bundle_id,
    platforms: ["IOS"]
  )
  puts "App #{target.bundle_identifier}: created"
  app
end

token = Spaceship::ConnectAPI::Token.create(
  key_id: ENV.fetch("ASC_KEY_ID"),
  issuer_id: ENV.fetch("ASC_ISSUER_ID"),
  filepath: ENV.fetch("ASC_KEY_PATH")
)
Spaceship::ConnectAPI.token = token

TARGETS.each do |target|
  bundle_id = ensure_bundle_id(target)
  ensure_app(target, bundle_id)
end
