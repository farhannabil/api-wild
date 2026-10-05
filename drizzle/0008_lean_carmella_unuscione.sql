CREATE TABLE `aaro_usage_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`model` text NOT NULL,
	`tariff_version` text NOT NULL,
	`state` text NOT NULL,
	`reserved_credits` integer NOT NULL,
	`actual_credits` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_aaro_usage_retry` ON `aaro_usage_requests` (`user_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `idx_aaro_usage_invoice` ON `aaro_usage_requests` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `idx_aaro_usage_state` ON `aaro_usage_requests` (`state`,`updated_at`);