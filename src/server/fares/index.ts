/**
 * Fare sources for the Tickets desk (TKT-8). v1 ships only the ManualFareProvider: staff type the
 * fare and every change is recorded as a FareSnapshot. A B2B portal adapter (Q3, priority C) will
 * implement the same interface and feed snapshots with source PORTAL.
 */
import type { FareSource, TravelMode } from "@prisma/client";

export type FareQuery = {
  mode: TravelMode;
  origin: string;
  destination: string;
  travelDate: Date;
  /** The option as staff described it ("IndiGo · Ranchi → Mumbai → Goa (GOI)"). */
  title: string;
  pax: number;
};

export interface FareProvider {
  readonly source: FareSource;
  /** Current fare per passenger in paise, or null when this provider can't price the option. */
  currentFare(query: FareQuery): Promise<number | null>;
}

/** Manual entry: the fare is whatever staff typed, so there is nothing to fetch. */
export class ManualFareProvider implements FareProvider {
  readonly source = "MANUAL" as const;
  async currentFare(): Promise<number | null> {
    return null;
  }
}

let provider: FareProvider | null = null;

export function getFareProvider(): FareProvider {
  provider ??= new ManualFareProvider();
  return provider;
}
