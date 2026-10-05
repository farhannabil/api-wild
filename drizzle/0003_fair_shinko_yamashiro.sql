CREATE TABLE `gateway_accounts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`daily_limit_micros` integer DEFAULT 10000000 NOT NULL,
	`suspended` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`scopes` text NOT NULL,
	`daily_limit_micros` integer NOT NULL,
	`total_limit_micros` integer NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_keys_hash_unique` ON `gateway_keys` (`hash`);--> statement-breakpoint
CREATE INDEX `idx_gateway_keys_owner` ON `gateway_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `gateway_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`payload` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`exported_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_outbox_request_id_unique` ON `gateway_outbox` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_gateway_outbox_state` ON `gateway_outbox` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `gateway_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key_id` text,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`capability` text NOT NULL,
	`model` text NOT NULL,
	`rate_version` text NOT NULL,
	`state` text NOT NULL,
	`reserved_micros` integer NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`together_reserved` integer DEFAULT 0 NOT NULL,
	`you_reserved` integer DEFAULT 0 NOT NULL,
	`deepgram_reserved` integer DEFAULT 0 NOT NULL,
	`together_cost` integer DEFAULT 0 NOT NULL,
	`you_cost` integer DEFAULT 0 NOT NULL,
	`deepgram_cost` integer DEFAULT 0 NOT NULL,
	`usage_json` text DEFAULT '{}' NOT NULL,
	`result_json` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gateway_request_retry` ON `gateway_requests` (`user_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `idx_gateway_request_owner_date` ON `gateway_requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_gateway_request_state` ON `gateway_requests` (`state`,`updated_at`);