CREATE TABLE "platform_vcs_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"account_id" text NOT NULL,
	"account_login" text NOT NULL,
	"access_token" text NOT NULL,
	"expires_at" timestamp with time zone,
	"repo_access" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"probed_at" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_vcs_credentials" ADD CONSTRAINT "platform_vcs_credentials_updated_by_app_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;