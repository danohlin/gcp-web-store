#
# Postgres.
#
# Private subnets with no route to the internet, reachable only from the node
# security group. Credentials are generated here and written straight to Secrets
# Manager, so they never appear in terminal output or in any file you handle.
#

resource "aws_db_subnet_group" "main" {
  name_prefix = "${local.name}-"
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "${local.name}-db-subnets"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_parameter_group" "main" {
  name_prefix = "${local.name}-"
  family      = "postgres${split(".", var.db_engine_version)[0]}"

  # Postgres defaults to requiring SSL on RDS; stated explicitly so a future
  # edit cannot quietly turn it off.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = {
    Name = "${local.name}-db-params"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Alphanumeric on purpose. This password ends up inside a DATABASE_URL that the
# migration Job assembles with shell string interpolation, and punctuation would
# need percent-encoding there. 32 alphanumeric characters is ~190 bits of
# entropy, so nothing is lost by excluding symbols.
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_instance" "main" {
  identifier_prefix = "${local.name}-"

  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 2
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false

  multi_az = var.db_multi_az

  # Both must be permissive or `terraform destroy` cannot remove the instance,
  # which is the whole point of an environment that is rebuilt daily.
  deletion_protection = var.db_deletion_protection
  skip_final_snapshot = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_skip_final_snapshot ? null : (
    "${local.name}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  )

  # Minimal backups: the data is reseeded on every deploy.
  backup_retention_period = var.db_skip_final_snapshot ? 0 : 1

  auto_minor_version_upgrade = true
  apply_immediately          = true

  # Performance Insights and enhanced monitoring both cost extra and are noise
  # for a throwaway environment.
  performance_insights_enabled = false
  monitoring_interval          = 0

  tags = {
    Name = "${local.name}-db"
  }

  lifecycle {
    ignore_changes = [
      # Regenerating the password on every plan would fight the value already
      # stored in Secrets Manager.
      password,
      final_snapshot_identifier,
    ]
  }
}
