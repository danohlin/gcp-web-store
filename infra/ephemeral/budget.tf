#
# A safety net for the case this environment is left running by accident.
#
# Budgets are free, and the alert is the difference between noticing an
# overnight EKS cluster the next morning versus at the end of the month.
#

resource "aws_budgets_budget" "monthly" {
  count = var.budget_notification_email != "" ? 1 : 0

  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Scoped by tag so this counts only the project, not the whole account.
  #
  # The AWS filter format is "user:<TagKey>$<TagValue>", where the dollar is a
  # literal separator. It has to be built with format() — writing "$${var.project}"
  # inline would be read by HCL as an escaped interpolation and emit the literal
  # text ${var.project}.
  #
  # Requires the "Project" cost allocation tag to be activated in Billing first;
  # until it is, the filter silently matches nothing.
  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:Project$%s", var.project)]
  }

  # Actual spend crossing 80%.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }

  # Forecast crossing 100%, which arrives days earlier than the actual would.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_notification_email]
  }
}
