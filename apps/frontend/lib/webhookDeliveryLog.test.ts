import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DELIVERY_LOGS,
  SNIPPET_MAX_LENGTH,
  WEBHOOK_LOG_STORAGE_KEY,
  buildDeliveryLog,
  buildRequestBodySnippet,
  clearWebhookDeliveryLogs,
  filterDeliveryLogs,
  formatDuration,
  isSuccessfulStatus,
  loadWebhookDeliveryLogs,
  recordWebhookDelivery,
  saveWebhookDeliveryLogs,
  statusLabel,
  statusTone,
  summarizeDeliveryLogs,
  type WebhookDeliveryLog,
} from "./webhookDeliveryLog";

function log(overrides: Partial<WebhookDeliveryLog> = {}): WebhookDeliveryLog {
  return {
    eventId: "evt_1",
    endpointUrl: "https://merchant.example.com/hooks",
    httpStatus: 200,
    deliveredAt: new Date("2026-02-10T12:00:00.000Z"),
    requestPayload: '{"orderId":"order-1"}',
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

// ─── Status classification (#725 acceptance criterion) ───────────────────────

describe("isSuccessfulStatus", () => {
  it("treats the whole 2xx range as success", () => {
    for (const code of [200, 201, 202, 204, 299]) {
      expect(isSuccessfulStatus(code), String(code)).toBe(true);
    }
  });

  it("treats everything else as a failure", () => {
    for (const code of [100, 199, 300, 301, 400, 404, 410, 422, 429, 500, 502, 503, 504]) {
      expect(isSuccessfulStatus(code), String(code)).toBe(false);
    }
  });
});

describe("statusTone", () => {
  it("maps 2xx to the success tone and everything else to error (red badge)", () => {
    expect(statusTone(200)).toBe("success");
    expect(statusTone(204)).toBe("success");
    expect(statusTone(301)).toBe("error");
    expect(statusTone(404)).toBe("error");
    expect(statusTone(500)).toBe("error");
  });
});

describe("statusLabel", () => {
  it("names the well-known statuses", () => {
    expect(statusLabel(200)).toBe("200 OK");
    expect(statusLabel(500)).toBe("500 Internal Server Error");
    expect(statusLabel(404)).toBe("404 Not Found");
  });

  it("describes an unknown 2xx as success and an unknown non-2xx as failed", () => {
    expect(statusLabel(299)).toBe("299 Success");
    expect(statusLabel(599)).toBe("599 Failed");
  });
});

describe("formatDuration", () => {
  it("uses milliseconds below a second", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(412)).toBe("412 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });

  it("switches to seconds at one second", () => {
    expect(formatDuration(1000)).toBe("1.00 s");
    expect(formatDuration(1420)).toBe("1.42 s");
  });

  it("renders a dash for a negative or non-finite duration", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

// ─── Payload snippet ─────────────────────────────────────────────────────────

describe("buildRequestBodySnippet", () => {
  it("keeps a short body verbatim", () => {
    expect(buildRequestBodySnippet('{"a":1}')).toBe('{"a":1}');
  });

  it("renders an empty body as an empty string", () => {
    expect(buildRequestBodySnippet("")).toBe("");
  });

  it("truncates an oversized body and marks the cut", () => {
    const snippet = buildRequestBodySnippet("x".repeat(500));
    expect(snippet).toHaveLength(SNIPPET_MAX_LENGTH);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("honours a custom max length", () => {
    expect(buildRequestBodySnippet("abcdefghij", 5)).toBe("abcd…");
  });

  it("flattens control characters so a payload cannot break the log table", () => {
    const snippet = buildRequestBodySnippet("line1\nline2\rmid here");
    expect(snippet).not.toMatch(/[\n\r]/);
    expect(snippet).toBe("line1 line2 mid here");
  });
});

describe("buildDeliveryLog", () => {
  it("normalises a raw delivery and flattens the body", () => {
    const built = buildDeliveryLog({
      eventId: "evt_9",
      endpointUrl: "https://merchant.example.com/hooks",
      httpStatus: 500,
      requestPayload: '{\n  "id": "evt_9"\n}',
      deliveredAt: new Date("2026-02-10T12:00:00.000Z"),
    });

    expect(built).toMatchObject({
      eventId: "evt_9",
      httpStatus: 500,
      deliveredAt: new Date("2026-02-10T12:00:00.000Z"),
    });
    // Newlines become spaces so the log table can never be broken by a payload.
    expect(built.requestPayload).not.toMatch(/[\n\r]/);
    expect(built.requestPayload).toContain('"id": "evt_9"');
  });
});

// ─── Persistence ─────────────────────────────────────────────────────────────

describe("loadWebhookDeliveryLogs", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(loadWebhookDeliveryLogs()).toEqual([]);
  });

  it("round-trips through save/load", () => {
    const logs = [log(), log({ eventId: "whd_2", httpStatus: 500 })];
    saveWebhookDeliveryLogs(logs);
    expect(loadWebhookDeliveryLogs()).toEqual(logs);
  });

  it("drops entries that do not match the WebhookDeliveryLog shape", () => {
    window.localStorage.setItem(
      WEBHOOK_LOG_STORAGE_KEY,
      JSON.stringify([log(), { id: "broken" }, null, 42])
    );
    expect(loadWebhookDeliveryLogs()).toEqual([log()]);
  });

  it("returns an empty list for unparseable or non-array JSON", () => {
    window.localStorage.setItem(WEBHOOK_LOG_STORAGE_KEY, "{not json");
    expect(loadWebhookDeliveryLogs()).toEqual([]);
    window.localStorage.setItem(WEBHOOK_LOG_STORAGE_KEY, '{"a":1}');
    expect(loadWebhookDeliveryLogs()).toEqual([]);
  });

  it("caps a stored list at MAX_DELIVERY_LOGS", () => {
    const many = Array.from({ length: MAX_DELIVERY_LOGS + 25 }, (_, i) =>
      log({ eventId: `whd_${i}` })
    );
    saveWebhookDeliveryLogs(many);
    expect(loadWebhookDeliveryLogs()).toHaveLength(MAX_DELIVERY_LOGS);
  });
});

describe("recordWebhookDelivery", () => {
  it("prepends the new entry, newest first", () => {
    const older = log({ eventId: "evt_old" });
    const next = recordWebhookDelivery(log({ eventId: "evt_new" }), [older]);

    expect(next.map((l) => l.eventId)).toEqual(["evt_new", "evt_old"]);
    expect(loadWebhookDeliveryLogs().map((l) => l.eventId)).toEqual([
      "evt_new",
      "evt_old",
    ]);
  });

  it("trims the oldest entries once the cap is reached", () => {
    const existing = Array.from({ length: MAX_DELIVERY_LOGS }, (_, i) =>
      log({ eventId: `whd_${i}` })
    );
    const next = recordWebhookDelivery(log({ eventId: "whd_newest" }), existing);

    expect(next).toHaveLength(MAX_DELIVERY_LOGS);
    expect(next[0].eventId).toBe("whd_newest");
    // The last entry is the oldest, so it is the one that falls off the end.
    expect(next.some((l) => l.eventId === `whd_${MAX_DELIVERY_LOGS - 1}`)).toBe(false);
    expect(next.some((l) => l.eventId === "whd_0")).toBe(true);
  });
});

describe("clearWebhookDeliveryLogs", () => {
  it("removes everything from storage", () => {
    saveWebhookDeliveryLogs([log()]);
    clearWebhookDeliveryLogs();
    expect(loadWebhookDeliveryLogs()).toEqual([]);
  });
});

// ─── Filtering and summary ───────────────────────────────────────────────────

describe("filterDeliveryLogs", () => {
  const logs = [
    log({ eventId: "evt_alpha", deliveredAt: new Date("2026-02-10T12:00:00.000Z"), httpStatus: 200 }),
    log({ eventId: "evt_beta", deliveredAt: new Date("2026-02-11T12:00:00.000Z"), httpStatus: 500 }),
    log({ eventId: "evt_gamma", deliveredAt: new Date("2026-02-12T12:00:00.000Z"), httpStatus: 404, endpointUrl: "https://other.example.com/x" }),
  ];

  it("sorts newest first", () => {
    expect(filterDeliveryLogs(logs).map((l) => l.eventId)).toEqual(["evt_gamma", "evt_beta", "evt_alpha"]);
  });

  it("does not mutate the input array", () => {
    const input = [...logs];
    filterDeliveryLogs(input);
    expect(input.map((l) => l.eventId)).toEqual(["evt_alpha", "evt_beta", "evt_gamma"]);
  });

  it("keeps only successes for the success filter", () => {
    expect(filterDeliveryLogs(logs, { outcome: "success" }).map((l) => l.eventId)).toEqual(["evt_alpha"]);
  });

  it("keeps only failures for the error filter", () => {
    expect(filterDeliveryLogs(logs, { outcome: "error" }).map((l) => l.eventId)).toEqual([
      "evt_gamma",
      "evt_beta",
    ]);
  });

  it("matches the search term against event id and URL", () => {
    expect(filterDeliveryLogs(logs, { search: "BETA" }).map((l) => l.eventId)).toEqual(["evt_beta"]);
    expect(filterDeliveryLogs(logs, { search: "other.example" }).map((l) => l.eventId)).toEqual(["evt_gamma"]);
  });

  it("combines the search term with the outcome filter", () => {
    expect(
      filterDeliveryLogs(logs, { search: "evt", outcome: "error" }).map((l) => l.eventId)
    ).toEqual(["evt_gamma", "evt_beta"]);
  });

  it("ignores a blank search term", () => {
    expect(filterDeliveryLogs(logs, { search: "   " })).toHaveLength(3);
  });
});

describe("summarizeDeliveryLogs", () => {
  it("counts successes, failures, and the mean duration", () => {
    expect(
      summarizeDeliveryLogs([
        log({ httpStatus: 200 }),
        log({ httpStatus: 500 }),
        log({ httpStatus: 204 }),
      ])
    ).toEqual({ total: 3, succeeded: 2, failed: 1, averageDurationMs: 0 });
  });

  it("returns zeroes for an empty log", () => {
    expect(summarizeDeliveryLogs([])).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      averageDurationMs: 0,
    });
  });
});
