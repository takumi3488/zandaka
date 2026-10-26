CREATE TABLE `entries` (
	`id` text PRIMARY KEY,
	`fund_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`occurred_on` text NOT NULL,
	`kind` text NOT NULL,
	`amount_yen` integer NOT NULL,
	`description` text NOT NULL,
	`receipt_id` text,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `entries_fund_id_funds_id_fk` FOREIGN KEY (`fund_id`) REFERENCES `funds`(`id`),
	CONSTRAINT `entries_fund_id_submission_id_entry_batches_fk` FOREIGN KEY (`fund_id`,`submission_id`) REFERENCES `entry_batches`(`fund_id`,`submission_id`),
	CONSTRAINT `entries_fund_id_receipt_id_receipts_fk` FOREIGN KEY (`fund_id`,`receipt_id`) REFERENCES `receipts`(`fund_id`,`id`),
	CONSTRAINT "entries_kind_check" CHECK("kind" IN ('income', 'expense')),
	CONSTRAINT "entries_amount_yen_range" CHECK(typeof("amount_yen") = 'integer' AND "amount_yen" BETWEEN 1 AND 999999999999),
	CONSTRAINT "entries_version_positive" CHECK(typeof("version") = 'integer' AND "version" >= 1)
);
--> statement-breakpoint
CREATE TABLE `entry_batches` (
	`fund_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`entry_ids` text NOT NULL,
	`receipt_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `entry_batches_fund_id_submission_id_pk` PRIMARY KEY(`fund_id`, `submission_id`),
	CONSTRAINT `entry_batches_fund_id_funds_id_fk` FOREIGN KEY (`fund_id`) REFERENCES `funds`(`id`)
);
--> statement-breakpoint
CREATE TABLE `funds` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`opening_balance_yen` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "funds_opening_balance_yen_range" CHECK(typeof("opening_balance_yen") = 'integer' AND "opening_balance_yen" BETWEEN -999999999999 AND 999999999999)
);
--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY,
	`fund_id` text NOT NULL,
	`object_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `receipts_fund_id_funds_id_fk` FOREIGN KEY (`fund_id`) REFERENCES `funds`(`id`),
	CONSTRAINT "receipts_state_check" CHECK("state" IN ('uploading', 'ready', 'deleting'))
);
--> statement-breakpoint
CREATE INDEX `entries_fund_id_occurred_on_created_at_id_idx` ON `entries` (`fund_id`,`occurred_on`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `entries_fund_id_receipt_id_idx` ON `entries` (`fund_id`,`receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_object_key_unique` ON `receipts` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_fund_id_id_unique` ON `receipts` (`fund_id`,`id`);--> statement-breakpoint
CREATE INDEX `receipts_state_created_at_idx` ON `receipts` (`state`,`created_at`);