-- Older databases may have received the original projection trigger through
-- the D1 import API. Production uses the explicit atomic batch in
-- MonitorAlertIngressStore so the schema is identical across bootstrap paths.
DROP TRIGGER IF EXISTS trg_monitor_alert_receipt_project;
