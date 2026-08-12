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
    app_name: "こよみ",
    sku: "kandotrun-koyomi-ios"
  ),
  Target.new(
    bundle_identifier: "run.kan.koyomi.widget",
    bundle_name: "Koyomi Widget"
  ),
  Target.new(
    bundle_identifier: "run.kan.treewatering",
    bundle_name: "Tree Watering iOS",
    app_name: "木のみず",
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

def sync_app_record_name(app, target)
  if app.name == target.app_name
    puts "App record name #{target.bundle_identifier}: already #{target.app_name}"
    return app
  end

  app.update(attributes: { name: target.app_name })
  refreshed_app = Spaceship::ConnectAPI::App.find(target.bundle_identifier)
  unless refreshed_app&.name == target.app_name
    raise "App record name #{target.bundle_identifier}: update verification failed"
  end
  puts "App record name #{target.bundle_identifier}: updated to #{target.app_name}"
  refreshed_app
end

def sync_app_name(app, target)
  app_info = app.fetch_edit_app_info || app.fetch_latest_app_info
  raise "App info #{target.bundle_identifier}: missing" unless app_info

  localization = app_info.get_app_info_localizations(filter: { locale: "ja" }).find do |candidate|
    candidate.locale == "ja"
  end
  raise "App info localization #{target.bundle_identifier}/ja: missing" unless localization

  if localization.name == target.app_name
    puts "App name #{target.bundle_identifier}: already #{target.app_name}"
    return
  end

  localization.update(attributes: { name: target.app_name })
  refreshed_app_info = app.fetch_edit_app_info || app.fetch_latest_app_info
  refreshed_localization = refreshed_app_info&.get_app_info_localizations(
    filter: { locale: "ja" }
  )&.find { |candidate| candidate.locale == "ja" }
  unless refreshed_localization&.name == target.app_name
    raise "App name #{target.bundle_identifier}: update verification failed"
  end
  puts "App name #{target.bundle_identifier}: updated to #{target.app_name}"
end

def ensure_app(target, bundle_id)
  return unless target.app_name

  app = Spaceship::ConnectAPI::App.find(target.bundle_identifier)
  if app
    puts "App #{target.bundle_identifier}: present"
    app = sync_app_record_name(app, target)
    sync_app_name(app, target)
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

bundle_ids = TARGETS.to_h do |target|
  [target, ensure_bundle_id(target)]
end

TARGETS.each do |target|
  ensure_app(target, bundle_ids.fetch(target))
end
