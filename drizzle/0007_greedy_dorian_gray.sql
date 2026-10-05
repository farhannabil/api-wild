CREATE TABLE `aaro_checkouts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`active_owner` text,
	`plan_id` text NOT NULL,
	`customer_id` text,
	`session_id` text,
	`subscription_id` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aaro_checkouts_active_owner_unique` ON `aaro_checkouts` (`active_owner`);--> statement-breakpoint
CREATE UNIQUE INDEX `aaro_checkouts_session_id_unique` ON `aaro_checkouts` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `aaro_checkouts_subscription_id_unique` ON `aaro_checkouts` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `idx_aaro_checkout_owner` ON `aaro_checkouts` (`user_id`);--> statement-breakpoint
CREATE TABLE `aaro_credit_periods` (
	`invoice_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`credits` integer NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_aaro_credit_owner` ON `aaro_credit_periods` (`user_id`);--> statement-breakpoint
CREATE TABLE `aaro_payment_holds` (
	`invoice_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `aaro_region_evidence` (
	`user_id` text PRIMARY KEY NOT NULL,
	`country` text NOT NULL,
	`evidence_reference` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text
);
