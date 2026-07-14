ALTER TABLE "appointments" ADD COLUMN "tag" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "tag" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "tag" text;--> statement-breakpoint
ALTER TABLE "provider_qualifications" ADD COLUMN "tag" text;--> statement-breakpoint
ALTER TABLE "provider_schedules" ADD COLUMN "tag" text;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "tag" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "tag" text;--> statement-breakpoint
ALTER TABLE "slots" ADD COLUMN "tag" text;