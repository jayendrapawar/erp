-- detect: select to_regclass('bill_mail_messages') is not null as present
--
-- Purchase bills by mail (owner, 19 Nov 2026): "Check mail" on Purchases reads Relaxo's bill mails
-- (sys_admin@relaxofootwear.com → the shop's Yahoo mailbox) and imports the attached PDFs like an
-- upload. One row per mail looked at, so a mail is never imported twice; mails that failed are
-- retried on the next check. The mailbox is only read, never changed.
--
-- New table only. Rollback: DROP TABLE bill_mail_messages.

CREATE TABLE bill_mail_messages (
  id              serial PRIMARY KEY,
  mailbox         text NOT NULL,
  "uidValidity"   bigint NOT NULL,
  uid             bigint NOT NULL,
  "messageId"     text,
  subject         text NOT NULL DEFAULT '',
  "receivedAt"    timestamptz NOT NULL,
  status          text NOT NULL CHECK (status IN ('imported', 'duplicate', 'no_pdf', 'error')),
  "billIds"       integer[] NOT NULL DEFAULT '{}',
  detail          text,
  "checkedAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bill_mail_messages_uid_unique UNIQUE (mailbox, "uidValidity", uid)
);
CREATE INDEX bill_mail_messages_received_idx ON bill_mail_messages ("receivedAt" DESC);
