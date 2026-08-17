// RS001b — the registration currency allowlist.
//
// Registration currency used to be a free-form 3-char text input flowing
// straight into Stripe `price_data.currency`, so an unsupported value broke the
// PUBLIC pay step rather than the settings save. `REGISTRATION_CURRENCIES` is
// the allowlist that closes that; these are the two properties the rest of the
// programme leans on and that nothing else would notice breaking.
import { describe, expect, it } from "vitest";
import {
  REGISTRATION_CURRENCIES,
  REGISTRATION_CURRENCY_EXCLUSIONS,
  SUPPORTED_CURRENCIES,
  isRegistrationCurrency,
} from "../currency";

describe("REGISTRATION_CURRENCIES", () => {
  it("is DERIVED from SUPPORTED_CURRENCIES minus the exclusions, never a second list", () => {
    // A hand-written parallel list is the failure this asserts against: two
    // vocabularies drift, and the one the public pay step reads is the one
    // nobody remembers to edit. Subscriptions keep the full list; registration
    // only ever subtracts from it.
    expect([...REGISTRATION_CURRENCIES]).toEqual(
      SUPPORTED_CURRENCIES.filter(
        (c) => !(REGISTRATION_CURRENCY_EXCLUSIONS as readonly string[]).includes(c),
      ),
    );
  });

  it("holds only 2-decimal currencies — fee math is ×100 throughout", () => {
    // Every fee input, stored `amount_cents` and Stripe `unit_amount` in the
    // registration path assumes minor units are hundredths. A zero-decimal
    // currency (jpy, krw) would charge 100× the intended amount, silently:
    // Stripe accepts the integer, the organiser sees the number they typed.
    for (const code of REGISTRATION_CURRENCIES) {
      const digits = new Intl.NumberFormat("en", {
        style: "currency",
        currency: code.toUpperCase(),
      }).resolvedOptions().maximumFractionDigits;
      expect(digits, `${code} is not a 2-decimal currency`).toBe(2);
    }
  });

  it("rejects anything outside the list, including a supported-but-excluded code", () => {
    for (const code of REGISTRATION_CURRENCIES) expect(isRegistrationCurrency(code)).toBe(true);
    for (const code of REGISTRATION_CURRENCY_EXCLUSIONS) {
      expect(isRegistrationCurrency(code)).toBe(false);
    }
    expect(isRegistrationCurrency("jpy")).toBe(false);
    expect(isRegistrationCurrency("GBP")).toBe(false); // codes are stored lowercase
    expect(isRegistrationCurrency(undefined)).toBe(false);
  });
});
