###############################################################################
# RDS MySQL 8 — Multi-AZ
#
# - Lives in the private_data subnets only (no public IP, no NAT route).
# - Storage encrypted with the AWS-managed KMS key for RDS.
# - Automated daily snapshots with 7-day retention by default.
# - Performance Insights enabled for free (db.t3 supports the no-cost tier).
# - Enhanced Monitoring at 60-sec interval (1 free metric / instance).
###############################################################################

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db"
  subnet_ids = [for s in aws_subnet.private_data : s.id]

  tags = { Name = "${local.name_prefix}-db" }
}

# Custom parameter group so we can enable slow-query logging without modifying
# the default parameter group (which would affect every RDS in the account).
resource "aws_db_parameter_group" "mysql8" {
  name        = "${local.name_prefix}-mysql8"
  family      = "mysql8.0"
  description = "Sparko MySQL 8 params — slow query + general logs into CloudWatch"

  parameter {
    name  = "slow_query_log"
    value = "1"
  }
  parameter {
    name  = "long_query_time"
    value = "1"
  }
  parameter {
    name  = "log_output"
    value = "FILE"
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name_prefix}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "main" {
  identifier = "${local.name_prefix}-mysql"

  engine            = "mysql"
  engine_version    = "8.0.39"
  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db_master.result
  port     = 3306

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az
  parameter_group_name   = aws_db_parameter_group.mysql8.name

  backup_retention_period = var.db_backup_retention_days
  backup_window           = "07:00-08:00"
  maintenance_window      = "Mon:08:00-Mon:09:00"
  copy_tags_to_snapshot   = true

  # Enable CloudWatch Logs export for the engine + slow query logs.
  enabled_cloudwatch_logs_exports = ["error", "general", "slowquery"]

  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.rds_monitoring.arn

  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  deletion_protection       = var.environment == "prod"
  skip_final_snapshot       = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "${local.name_prefix}-mysql-final-${formatdate("YYYYMMDDhhmmss", timestamp())}" : null

  apply_immediately = false

  tags = { Name = "${local.name_prefix}-mysql" }

  lifecycle {
    # Don't fight an out-of-band password rotation from Secrets Manager.
    ignore_changes = [password, final_snapshot_identifier]
  }
}
