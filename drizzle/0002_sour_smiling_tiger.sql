DROP TABLE "appointments" CASCADE;--> statement-breakpoint
DROP TABLE "patients" CASCADE;--> statement-breakpoint
ALTER TABLE "slots" ADD COLUMN "status" text DEFAULT 'free' NOT NULL;