CREATE TABLE `vault_rotation_items` (
	`vault_id` text NOT NULL,
	`item_id` text NOT NULL,
	`new_key_version` integer NOT NULL,
	`revision` integer NOT NULL,
	`wrapped_key` text NOT NULL,
	`encrypted_data` text NOT NULL,
	`item_key_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `item_id`),
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vault_rotation_items_item_id_idx` ON `vault_rotation_items` (`item_id`);--> statement-breakpoint
CREATE INDEX `deletions_user_deleted_idx` ON `deletions` (`user_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `deletions_vault_deleted_idx` ON `deletions` (`vault_id`,`deleted_at`);