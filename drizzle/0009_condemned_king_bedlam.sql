CREATE TABLE IF NOT EXISTS `billing_auto_recharge` (
	`user_id` text PRIMARY KEY NOT NULL,
	`requested_enabled` integer DEFAULT 0 NOT NULL,
	`threshold_cents` integer,
	`refill_pack` text,
	`monthly_cap_cents` integer,
	`consent_version` text,
	`consented_at` text,
	`status` text DEFAULT 'disabled' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
