-- Option 1: Delete all records from Client table (soft deletes will be preserved)
DELETE FROM "Client";

-- Option 2: Truncate table (removes all data including soft deletes, resets auto-increment if any)
-- TRUNCATE TABLE "Client" CASCADE;

-- Option 3: Delete only non-deleted records (if you want to keep soft-deleted records)
-- DELETE FROM "Client" WHERE "deletedAt" IS NULL;

-- Option 4: Force delete everything including soft-deleted records
-- DELETE FROM "Client" WHERE "deletedAt" IS NOT NULL OR "deletedAt" IS NULL;
