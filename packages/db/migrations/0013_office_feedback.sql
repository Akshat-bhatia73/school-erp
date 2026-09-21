-- Office feedback: full identity numbers, guardian office details and photos.
--
-- The office asked for the whole Aadhaar number rather than the last four
-- digits it can type today, for the guardian's office address and identity
-- numbers, and for a photograph on a student and a staff record. None of that
-- changes who may read a row, so there is no policy work here: RLS already
-- covers students, guardians and staff, and the grants are table level, so the
-- new columns inherit them.
--
-- Every identity number follows the APAAR id added in 0009: the database holds
-- the sealed value and the last digits a screen is allowed to show, and the
-- key stays in the API configuration. Nothing here can be read back without
-- DATA_ENCRYPTION_KEY.
ALTER TABLE students
    ADD COLUMN aadhaar_ciphertext text,
    ADD COLUMN photo_storage_key text,
    ADD COLUMN photo_content_type text,
    ADD COLUMN photo_updated_at timestamptz;

ALTER TABLE guardians
    ADD COLUMN office_address jsonb,
    ADD COLUMN pan_ciphertext text,
    ADD COLUMN pan_last4 text,
    ADD COLUMN aadhaar_ciphertext text,
    ADD COLUMN aadhaar_last4 text;

ALTER TABLE staff
    ADD COLUMN photo_storage_key text,
    ADD COLUMN photo_content_type text,
    ADD COLUMN photo_updated_at timestamptz;

-- The masked forms are the only part of an identity number a response carries,
-- so their shape is fixed here as well as in the contract: four digits for an
-- Aadhaar number, and for a PAN the three digits and the holder letter that
-- end AAAAA9999A.
ALTER TABLE students
    ADD CONSTRAINT students_aadhaar_last4_check CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$');

ALTER TABLE guardians
    ADD CONSTRAINT guardians_aadhaar_last4_check CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$'),
    ADD CONSTRAINT guardians_pan_last4_check CHECK (pan_last4 IS NULL OR pan_last4 ~ '^[0-9]{3}[A-Z]$');

-- A photograph is bytes in the private document store plus the row that names
-- them. The three columns are written and cleared together, so a half state
-- that would make the streaming route guess a type cannot be stored. The type
-- is the one the API decided from the magic bytes, never a claimed type.
ALTER TABLE students
    ADD CONSTRAINT students_photo_complete_check CHECK ((photo_storage_key IS NULL) = (photo_content_type IS NULL) AND (photo_storage_key IS NULL) = (photo_updated_at IS NULL)),
    ADD CONSTRAINT students_photo_content_type_check CHECK (photo_content_type IS NULL OR photo_content_type IN ('image/jpeg', 'image/png', 'image/webp'));

ALTER TABLE staff
    ADD CONSTRAINT staff_photo_complete_check CHECK ((photo_storage_key IS NULL) = (photo_content_type IS NULL) AND (photo_storage_key IS NULL) = (photo_updated_at IS NULL)),
    ADD CONSTRAINT staff_photo_content_type_check CHECK (photo_content_type IS NULL OR photo_content_type IN ('image/jpeg', 'image/png', 'image/webp'));
