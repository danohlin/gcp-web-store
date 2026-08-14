#
# Cloud SQL for PostgreSQL, reached over Private Service Connect.
#
# PSC rather than Private Service Access (VPC peering), which is the more
# commonly documented option, because of the daily destroy. PSA needs a
# google_service_networking_connection, whose deletion is unreliable enough
# that the resource ships an ABANDON escape hatch for it. An abandoned peering
# plus a stranded reserved range is exactly the "the name is still taken
# tomorrow morning" failure that recovery_window_in_days = 0 was written to
# solve on the AWS side, and there is no reason to import it here.
#
# PSC's consumer side is two ordinary VPC resources that Terraform fully owns
# and destroys: an internal address and a forwarding rule pointing at the
# instance's service attachment.
#
# The application connects to the endpoint address as a normal host:port, so
# backend/src/config/index.ts needs no change. Its resolveDatabaseUrl() builds
# postgresql://user:pass@host:port/db and cannot express the Cloud SQL unix
# socket form (?host=/cloudsql/...), which is one reason the Auth Proxy sidecar
# was rejected.
#

# Cloud SQL instance names cannot always be reused immediately after deletion,
# and the documentation contradicts itself on how long the reservation lasts.
# Rather than depend on the answer, give every build a fresh name. Nothing
# needs it to be derivable: the application reaches the database by the PSC
# endpoint address, which is published through Secret Manager.
resource "random_id" "db" {
  byte_length = 4
}

# Alphanumeric on purpose. This password ends up inside a DATABASE_URL that the
# migration Job assembles with shell string interpolation, and punctuation would
# need percent-encoding at that point.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "main" {
  name             = "${local.name}-${random_id.db.hex}"
  region           = var.region
  database_version = var.db_database_version

  # Provider-level guard, defaults to true.
  deletion_protection = var.db_deletion_protection

  settings {
    tier      = var.db_tier
    edition   = "ENTERPRISE"
    disk_size = var.db_disk_size_gb
    disk_type = "PD_SSD"

    # A one-way ratchet: once grown, the disk cannot shrink. Off for a database
    # that is recreated daily and holds only seeded demo data.
    disk_autoresize = false

    # API-level guard. Distinct from the provider-level field above, and
    # missing either one fails the destroy.
    deletion_protection_enabled = false

    # No backups. The data is reseeded on every deploy, and backups would
    # survive the instance.
    backup_configuration {
      enabled = false
    }

    ip_configuration {
      # No public IP. Mandatory when using PSC.
      ipv4_enabled = false

      # Reject unencrypted connections. Replaces the rds.force_ssl parameter
      # group. The client side is sslmode=require, which config/index.ts
      # already defaults to.
      ssl_mode = "ENCRYPTED_ONLY"

      psc_config {
        psc_enabled               = true
        allowed_consumer_projects = [var.project_id]
      }
    }

    insights_config {
      query_insights_enabled = false
    }

    user_labels = {
      project     = var.project
      environment = var.environment
    }
  }
}

resource "google_sql_database" "main" {
  name     = var.db_name
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "main" {
  name     = var.db_username
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}

# ------------------------------------------------------ private service connect

resource "google_compute_address" "db" {
  name         = "${local.name}-db-psc"
  region       = var.region
  subnetwork   = google_compute_subnetwork.main.id
  address_type = "INTERNAL"
}

# No consumer-side firewall rule is needed: default egress permits it, and the
# forwarding rule terminates inside this VPC.
resource "google_compute_forwarding_rule" "db" {
  name   = "${local.name}-db-psc"
  region = var.region

  network               = google_compute_network.main.id
  subnetwork            = google_compute_subnetwork.main.id
  ip_address            = google_compute_address.db.id
  target                = google_sql_database_instance.main.psc_service_attachment_link
  load_balancing_scheme = ""
}
