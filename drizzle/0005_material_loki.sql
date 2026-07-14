CREATE TABLE "agentic_setups" (
	"id" text PRIMARY KEY NOT NULL,
	"tag" text NOT NULL,
	"title" text,
	"use_case_summary" text,
	"status" text DEFAULT 'in-progress' NOT NULL,
	"dialog" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seed_plan" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"committed_at" timestamp,
	CONSTRAINT "agentic_setups_tag_unique" UNIQUE("tag")
);
