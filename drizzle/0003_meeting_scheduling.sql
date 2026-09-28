ALTER TABLE "meetings" ADD COLUMN "origin" text DEFAULT 'synced' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "invite_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "invite_provider" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "invite_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "invite_error" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "external_event_id" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "transcription_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "transcription_error" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "actions_proposed_at" timestamp with time zone;