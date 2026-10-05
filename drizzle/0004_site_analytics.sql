CREATE TABLE "site_salts" (
	"day" text PRIMARY KEY NOT NULL,
	"salt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_visits" (
	"id" text PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"visitor_hash" text NOT NULL,
	"path" text NOT NULL,
	"referrer_host" text,
	"country" text,
	"device" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "site_visits_day_idx" ON "site_visits" USING btree ("day");--> statement-breakpoint
CREATE INDEX "site_visits_day_visitor_idx" ON "site_visits" USING btree ("day","visitor_hash");