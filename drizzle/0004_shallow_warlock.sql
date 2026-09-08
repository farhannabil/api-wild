CREATE TABLE `gateway_audio` (
	`request_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateway_audio_request_chunk` ON `gateway_audio` (`request_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `gateway_audio_date` ON `gateway_audio` (`created_at`);