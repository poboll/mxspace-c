CREATE TABLE "enrichment_fetch_state" (
  "provider" varchar(64) NOT NULL,
  "external_id" varchar(256) NOT NULL,
  "locale" varchar(8) DEFAULT '' NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "last_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "next_retry_at" timestamptz,
  "lease_token" text,
  "lease_expires_at" timestamptz,
  PRIMARY KEY ("provider", "external_id", "locale")
);
--> statement-breakpoint
-- Old rows record only the last SUCCESS, so their failure time cannot be
-- recovered. Give existing failures one bounded cooldown from migration time.
INSERT INTO "enrichment_fetch_state"
  ("provider", "external_id", "locale", "failure_count", "last_error", "next_retry_at")
SELECT "provider", "external_id", "locale", "failure_count", "last_error",
  now() + make_interval(secs => least(86400, 60 * power(2, least("failure_count", 11)))::double precision)
FROM "enrichment_cache" WHERE "failure_count" > 0;
