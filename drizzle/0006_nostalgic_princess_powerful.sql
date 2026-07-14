CREATE TABLE "location_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"start" text NOT NULL,
	"end" text NOT NULL,
	"tag" text
);
--> statement-breakpoint
ALTER TABLE "slots" ALTER COLUMN "provider_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "concurrent_capacity" integer;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "requires_provider" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "location_schedules" ADD CONSTRAINT "location_schedules_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;