CREATE TABLE `storefront_fulfillment` (
	`order_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storefront_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`brand` text NOT NULL,
	`sku` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`session_id` text,
	`payment_intent` text,
	`status` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storefront_orders_session_id_unique` ON `storefront_orders` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `storefront_orders_payment_intent_unique` ON `storefront_orders` (`payment_intent`);--> statement-breakpoint
CREATE INDEX `idx_storefront_ip` ON `storefront_orders` (`ip_hash`);