-- Migration 2026-10-08 (d): one OTP, one use (open defect 8, closed by the
-- break-it pass). The registration token an OTP earns now registers one
-- phone or sets one password, and is then spent. Matches
-- sql/01_identity_schema.sql (otp_request.token_used_at).
--   psql -h localhost -U postgres -d ncl_identity -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO identity, public;
ALTER TABLE otp_request ADD COLUMN IF NOT EXISTS token_used_at timestamptz NULL;
