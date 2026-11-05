import { describe, expect, it } from "vitest";
import {
  canRedeliver,
  deliveryResult,
  deliveryStatus,
  endpointStatus,
  eventLabel,
  eventSummary,
  explainWebhook,
  webhookEvents,
} from "./webhookText";

describe("webhooks", () => {
  it("offers every event the database knows, once", () => {
    expect(webhookEvents.map((e) => e.type)).toEqual([
      "timesheet.submitted",
      "timesheet.approved",
      "timesheet.returned",
      "alert.raised",
      "person.invited",
      "person.deactivated",
      "time_off.decided",
    ]);
  });

  it("names events in the page's order, keeping unknown ones", () => {
    expect(eventSummary(["time_off.decided", "timesheet.submitted"])).toBe(
      "Timesheet submitted, Time off decided",
    );
    expect(eventSummary(["something.new"])).toBe("something.new");
    expect(eventLabel("alert.raised")).toBe("Alert raised");
    expect(eventLabel("ping")).toBe("Test event");
  });

  it("says why an endpoint is off", () => {
    expect(endpointStatus({ enabled: true, disabledReason: null })).toBe("Active");
    expect(endpointStatus({ enabled: false, disabledReason: "admin" })).toBe("Off");
    expect(endpointStatus({ enabled: false, disabledReason: "failing" })).toBe(
      "Turned off: failing",
    );
  });

  it("reads a delivery's state and result", () => {
    expect(deliveryStatus({ status: "pending", attempts: 0 })).toBe("Queued");
    expect(deliveryStatus({ status: "pending", attempts: 2 })).toBe("Retrying");
    expect(deliveryStatus({ status: "delivered", attempts: 1 })).toBe("Delivered");
    expect(deliveryStatus({ status: "failed", attempts: 7 })).toBe("Failed");
    expect(deliveryResult({ responseStatus: 204, lastError: null })).toBe("HTTP 204");
    expect(deliveryResult({ responseStatus: 500, lastError: "HTTP 500" })).toBe("HTTP 500");
    expect(deliveryResult({ responseStatus: null, lastError: "could not connect" })).toBe(
      "could not connect",
    );
    expect(deliveryResult({ responseStatus: null, lastError: null })).toBe("—");
  });

  it("offers a redelivery only once a delivery is done", () => {
    expect(canRedeliver({ status: "delivered" })).toBe(true);
    expect(canRedeliver({ status: "failed" })).toBe(true);
    expect(canRedeliver({ status: "pending" })).toBe(false);
  });

  it("explains the server's refusals and passes anything else through", () => {
    expect(explainWebhook("invalid_url")).toMatch(/https/);
    expect(explainWebhook("too_many_webhooks")).toMatch(/10/);
    expect(explainWebhook("webhook_off")).toMatch(/off/);
    expect(explainWebhook("delivery_pending")).toMatch(/waiting/);
    expect(explainWebhook("something new")).toBe("something new");
  });
});
