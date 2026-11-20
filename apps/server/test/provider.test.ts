import { describe, expect, it } from "vitest";
import { APIConnectionError } from "openai";
import { mapError } from "../src/ai/openai-compatible.ts";

describe("mapError", () => {
  it("explains TLS interception (corporate proxy) errors", () => {
    const cause = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
    });
    const e = mapError(new APIConnectionError({ cause }));
    expect(e.code).toBe("provider_error");
    expect(e.message).toMatch(/сертификата.*SELF_SIGNED_CERT_IN_CHAIN/);
  });

  it("reports plain network failures", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    expect(mapError(new APIConnectionError({ cause })).message).toMatch(/Нет соединения.*ENOTFOUND/);
  });
});
