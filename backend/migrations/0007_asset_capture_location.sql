ALTER TABLE assets ADD COLUMN latitude REAL
CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90));

ALTER TABLE assets ADD COLUMN longitude REAL
CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180));

CREATE TRIGGER assets_capture_location_pair_insert
BEFORE INSERT ON assets
WHEN (NEW.latitude IS NULL) <> (NEW.longitude IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'capture location requires latitude and longitude');
END;

CREATE TRIGGER assets_capture_location_pair_update
BEFORE UPDATE OF latitude, longitude ON assets
WHEN (NEW.latitude IS NULL) <> (NEW.longitude IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'capture location requires latitude and longitude');
END;
