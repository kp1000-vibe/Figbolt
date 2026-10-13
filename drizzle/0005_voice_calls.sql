CREATE TABLE "voice_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"contact_id" text,
	"account_id" text,
	"opportunity_id" text,
	"to_number" text NOT NULL,
	"purpose" text NOT NULL,
	"talking_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opening_line" text NOT NULL,
	"record_call" boolean DEFAULT false NOT NULL,
	"max_minutes" integer DEFAULT 5 NOT NULL,
	"consent_confirmed_by_id" text,
	"consent_confirmed_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'placing' NOT NULL,
	"outcome" text,
	"provider" text NOT NULL,
	"provider_call_id" text,
	"webhook_token_hash" text,
	"ended_reason" text,
	"summary" text,
	"error" text,
	"duration_seconds" integer,
	"meeting_id" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_by_id" text,
	"created_by_agent_id" text,
	"approval_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_consent_confirmed_by_id_users_id_fk" FOREIGN KEY ("consent_confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_calls_ws_created_idx" ON "voice_calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_calls_provider_call_idx" ON "voice_calls" USING btree ("provider_call_id");--> statement-breakpoint
CREATE INDEX "voice_calls_ws_number_idx" ON "voice_calls" USING btree ("workspace_id","to_number");