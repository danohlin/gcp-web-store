#
# A safety net for the case this environment is left running by accident.
#
# Budgets are free, and the alert is the difference between noticing an
# overnight cluster the next morning versus at the end of the month.
#
# Creating one needs roles/billing.costsManager on the *billing account*, not
# on the project. That is a higher bar than everything else in this stack, and
# a permission the project owner does not automatically have — which is why
# both billing_account_id and the email default to empty and skip the resource
# entirely rather than failing the apply.
#

locals {
  budget_enabled = var.budget_notification_email != "" && var.billing_account_id != ""
}

resource "google_monitoring_notification_channel" "budget" {
  count = local.budget_enabled ? 1 : 0

  display_name = "${local.name} budget alerts"
  type         = "email"

  labels = {
    email_address = var.budget_notification_email
  }
}

resource "google_billing_budget" "monthly" {
  count = local.budget_enabled ? 1 : 0

  billing_account = var.billing_account_id
  display_name    = "${local.name}-monthly"

  # Scoped to this project rather than the whole billing account.
  #
  # Simpler than the AWS equivalent, which filtered on a cost allocation tag
  # that had to be activated in Billing first and silently matched nothing
  # until it was.
  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_limit_usd)
    }
  }

  # Actual spend crossing 80%.
  threshold_rules {
    threshold_percent = 0.8
    spend_basis       = "CURRENT_SPEND"
  }

  # Forecast crossing 100%, which arrives days earlier than the actual would.
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.budget[0].id]

    # Without this the alert only fires for the billing account admins, not the
    # address configured above.
    disable_default_iam_recipients = true
  }
}
