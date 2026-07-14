ALTER TABLE "location_schedules" ADD COLUMN "capacity" integer;--> statement-breakpoint
ALTER TABLE "locations" DROP COLUMN "concurrent_capacity";