-- detect: select to_regclass('app_settings') is not null as present
--
-- App settings an admin changes on screen (no redeploy). First use (owner, 19 Nov 2026): the day
-- from which purchase bills are read from mail ("billMail.startDate"); off until set, which on the
-- live site happens after the warehouse stocktake. Every change has an audit_events row.
--
-- New table only. Rollback: DROP TABLE app_settings.

CREATE TABLE app_settings (
  key               text PRIMARY KEY,
  value             jsonb NOT NULL,
  "updatedBy"       text REFERENCES "user"(id) ON DELETE SET NULL,
  "updatedByName"   text NOT NULL DEFAULT '',
  "updatedAt"       timestamptz NOT NULL DEFAULT now()
);
