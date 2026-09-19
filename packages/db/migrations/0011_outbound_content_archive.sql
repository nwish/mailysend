-- D1 indexes delivery metadata; rendered message content and MIME live in R2.
--
-- The pointers make that archive observable and sweepable. Keeping them on the
-- send row means broadcasts and automations work too, even though they do not
-- each create a `mail_messages` conversation row.
ALTER TABLE `messages` ADD `body_key` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `raw_key` text;
