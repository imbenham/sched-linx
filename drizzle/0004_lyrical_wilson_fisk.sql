CREATE TABLE "services_room_requirements" (
	"service_id" text NOT NULL,
	"room_type" text NOT NULL,
	"tag" text,
	CONSTRAINT "services_room_requirements_service_id_room_type_pk" PRIMARY KEY("service_id","room_type")
);
--> statement-breakpoint
DROP TABLE "devices" CASCADE;--> statement-breakpoint
DROP TABLE "services_device_requirements" CASCADE;--> statement-breakpoint
DROP TABLE "slot_devices" CASCADE;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "requires_room" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "services_room_requirements" ADD CONSTRAINT "services_room_requirements_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;