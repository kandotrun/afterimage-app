require "spaceship"

bundle_identifier = ENV.fetch("TESTFLIGHT_BUNDLE_IDENTIFIER")
version = ENV.fetch("TESTFLIGHT_VERSION")
build_number = ENV.fetch("TESTFLIGHT_BUILD_NUMBER")
timeout_seconds = Integer(ENV.fetch("TESTFLIGHT_VERIFY_TIMEOUT_SECONDS", "1800"), 10)
interval_seconds = Integer(ENV.fetch("TESTFLIGHT_VERIFY_INTERVAL_SECONDS", "30"), 10)

token = Spaceship::ConnectAPI::Token.create(
  key_id: ENV.fetch("ASC_KEY_ID"),
  issuer_id: ENV.fetch("ASC_ISSUER_ID"),
  filepath: ENV.fetch("ASC_KEY_PATH")
)
Spaceship::ConnectAPI.token = token

app = Spaceship::ConnectAPI::App.find(bundle_identifier)
raise "App #{bundle_identifier} is missing from App Store Connect" unless app

deadline = Time.now + timeout_seconds
loop do
  build = Spaceship::ConnectAPI::Build.all(
    app_id: app.id,
    version: version,
    build_number: build_number,
    platform: "IOS"
  ).first

  if build
    case build.processing_state
    when Spaceship::ConnectAPI::Build::ProcessingState::VALID
      puts "Build #{bundle_identifier} #{version} (#{build_number}): VALID"
      break
    when Spaceship::ConnectAPI::Build::ProcessingState::FAILED,
         Spaceship::ConnectAPI::Build::ProcessingState::INVALID
      raise "Build #{bundle_identifier} #{version} (#{build_number}): #{build.processing_state}"
    else
      puts "Build #{bundle_identifier} #{version} (#{build_number}): PROCESSING"
    end
  else
    puts "Build #{bundle_identifier} #{version} (#{build_number}): waiting for ingestion"
  end

  raise "Timed out waiting for TestFlight build processing" if Time.now >= deadline

  sleep interval_seconds
end
