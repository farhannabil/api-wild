CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`scope` text DEFAULT 'read' NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`last_used_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE INDEX `idx_keys_owner` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`order_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_ledger_source_unique` ON `credit_ledger` (`source`);--> statement-breakpoint
CREATE INDEX `idx_ledger_owner` ON `credit_ledger` (`user_id`);--> statement-breakpoint
CREATE TABLE `billing_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`pack` text NOT NULL,
	`purchase_mode` text DEFAULT 'one_time' NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`session_id` text,
	`payment_intent` text,
	`status` text DEFAULT 'created' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_orders_session_id_unique` ON `billing_orders` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_orders_payment_intent_unique` ON `billing_orders` (`payment_intent`);--> statement-breakpoint
CREATE INDEX `idx_orders_owner` ON `billing_orders` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_order_retry` ON `billing_orders` (`user_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`account_type` text DEFAULT 'company' NOT NULL,
	`domain` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`country` text DEFAULT '' NOT NULL,
	`building` text DEFAULT '[]' NOT NULL,
	`compliance` text DEFAULT '[]' NOT NULL,
	`project` text DEFAULT '' NOT NULL,
	`retention_days` integer DEFAULT 30 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key_id` text,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_owner_date` ON `usage_events` (`user_id`,`created_at`);
