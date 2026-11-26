-- Chat media stored before CHAT_MEDIA existed (kind OTHER under the chat/ prefix) becomes CHAT_MEDIA.
-- Separate migration: a new enum value can't be used in the transaction that added it.
UPDATE "Document" SET "kind" = 'CHAT_MEDIA' WHERE "kind" = 'OTHER' AND "storageKey" LIKE 'chat/%';
