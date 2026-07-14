CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"room_id" text,
	"name" text,
	"tag" text
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location_id" text NOT NULL,
	"tag" text
);
--> statement-breakpoint
CREATE TABLE "services_device_requirements" (
	"service_id" text NOT NULL,
	"device_type" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"tag" text,
	CONSTRAINT "services_device_requirements_service_id_device_type_pk" PRIMARY KEY("service_id","device_type")
);
--> statement-breakpoint
CREATE TABLE "slot_devices" (
	"slot_id" text NOT NULL,
	"device_id" text NOT NULL,
	"tag" text,
	CONSTRAINT "slot_devices_slot_id_device_id_pk" PRIMARY KEY("slot_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "slots" ADD COLUMN "room_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services_device_requirements" ADD CONSTRAINT "services_device_requirements_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_devices" ADD CONSTRAINT "slot_devices_slot_id_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_devices" ADD CONSTRAINT "slot_devices_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;