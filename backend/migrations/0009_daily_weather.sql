CREATE TABLE daily_weather (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  temperature_celsius REAL NOT NULL,
  high_temperature_celsius REAL NOT NULL,
  low_temperature_celsius REAL NOT NULL,
  recorded_at TEXT NOT NULL,
  attribution_legal_url TEXT NOT NULL,
  attribution_light_url TEXT NOT NULL,
  attribution_dark_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, local_date)
);

CREATE INDEX daily_weather_timeline_idx ON daily_weather(user_id, local_date DESC);
