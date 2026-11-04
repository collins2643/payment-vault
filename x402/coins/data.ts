// Wheat cent (1909–1958 Lincoln) reference data served by the paid /coins routes.
// Values are dated snapshots; update DATA_AS_OF when refreshing them.

export const DATA_AS_OF = "2026-10-30";

export const COIN = {
  grams: 3.11,
  copperShare: 0.95,
  gramsPerLb: 453.592,
} as const;

/** Spot used when the live copper feed is unavailable (COMEX close, 2026-10-30). */
export const FALLBACK_COPPER_USD_LB = 6.55;

export type Grade = "VG" | "F" | "VF" | "XF" | "AU" | "MS63" | "MS65";
export const GRADES: Grade[] = ["VG", "F", "VF", "XF", "AU", "MS63", "MS65"];

export interface KeyDate {
  id: string;
  name: string;
  mintage: number | null;
  /** Fine-12 retail value by year (USD). 1958–2015 from guide tables, 2026 market. */
  fineHistory: Record<number, number>;
  /** Current market value by grade (USD); null where no reliable figure. */
  ladder: Record<Grade, number | null>;
  sources: string[];
}

const ladder = (v: (number | null)[]): Record<Grade, number | null> =>
  Object.fromEntries(GRADES.map((g, i) => [g, v[i] ?? null])) as Record<Grade, number | null>;

const LOC = "https://www.landofcoins.com/lincoln_cents.php";
const PC = (slug: string) => `https://www.pricecharting.com/game/coins-lincoln-wheat-penny/${slug}`;

export const KEY_DATES: KeyDate[] = [
  {
    id: "1909-s-vdb", name: "1909-S VDB", mintage: 484_000,
    fineHistory: { 1958: 30, 1965: 150, 1980: 155, 1986: 295, 2000: 445, 2015: 840, 2026: 1106 },
    ladder: ladder([799.66, 1106, 1169.2, 1351, 1875.75, 2391.57, 5245.75]),
    sources: [LOC, PC("1909-s-vdb")],
  },
  {
    id: "1914-d", name: "1914-D", mintage: 1_193_000,
    fineHistory: { 1958: 30, 1965: 72, 1980: 65, 1986: 100, 2000: 115, 2015: 220, 2026: 307.61 },
    ladder: ladder([258.58, 307.61, 453.93, 889.43, 1952.75, 4242.45, 12200]),
    sources: [LOC, PC("1914-d")],
  },
  {
    id: "1931-s", name: "1931-S", mintage: 866_000,
    fineHistory: { 1958: 6, 1965: 40, 1980: 28, 1986: 38, 2000: 35, 2015: 100, 2026: 87.6 },
    ladder: ladder([77, 87.6, 89.77, 96, 107, 183.11, 558.75]),
    sources: [LOC, PC("1931-s")],
  },
  {
    id: "1909-s", name: "1909-S", mintage: 1_825_000,
    fineHistory: { 1958: 4, 1965: 38, 1980: 30, 1986: 48, 2000: 45, 2015: 100, 2026: 129 },
    ladder: ladder([109.99, 129, 156.5, 186, 207, 424, 1207.6]),
    sources: [LOC, PC("1909-s")],
  },
  {
    id: "1922-no-d", name: "1922 No D (Strong Reverse, FS-401)", mintage: null,
    fineHistory: {},
    ladder: ladder([626.17, 763, 1141.32, 2684, 4858, 8343, 10198]),
    sources: [PC("1922-no-d-fs-401")],
  },
  {
    id: "1955-ddo", name: "1955 Doubled Die Obverse", mintage: null,
    fineHistory: {},
    ladder: ladder([null, null, 1674.5, 1780.33, 2385, 4100, 5011]),
    sources: [PC("1955-double-die")],
  },
];

export type Channel = "dealer" | "auction" | "wholesale" | "retail";

export interface BulkObservation {
  date: string;
  source: string;
  channel: Channel;
  coins: number;
  totalUsd: number;
  /** true when the figure is an owner-supplied estimate rather than a public listing */
  estimate?: boolean;
}

export const BULK_OBSERVATIONS: BulkObservation[] = [
  { date: "2026-10-29", source: "eBay auction, 3,100+ wheat cents (current bid)", channel: "auction", coins: 3100, totalUsd: 132.5 },
  { date: "2026-10-29", source: "eBay auction, 2,000 wheat cents (current bid)", channel: "auction", coins: 2000, totalUsd: 103 },
  { date: "2026-10-29", source: "eBay auction, 1,000+ wheat cents (current bid)", channel: "auction", coins: 1000, totalUsd: 56.5 },
  { date: "2026-10-29", source: "eBay Buy It Now, 5,000 mostly 1940–58", channel: "wholesale", coins: 5000, totalUsd: 444.84 },
  { date: "2026-10-29", source: "eBay Buy It Now, 1,000 unsearched", channel: "wholesale", coins: 1000, totalUsd: 109.97 },
  { date: "2026-10-29", source: "eBay, 500 wheat cents 1940–58 PDS", channel: "wholesale", coins: 500, totalUsd: 46.99 },
  { date: "2026-10-29", source: "Amazon, 1 lb (148 coins) unsearched", channel: "retail", coins: 148, totalUsd: 29.36 },
  { date: "2026-10-29", source: "Amazon, 1 lb bag mixed dates", channel: "retail", coins: 145, totalUsd: 29.95 },
  { date: "2026-10-30", source: "Typical dealer buy offer, low end", channel: "dealer", coins: 5000, totalUsd: 100, estimate: true },
  { date: "2026-10-30", source: "Typical dealer buy offer, high end", channel: "dealer", coins: 5000, totalUsd: 200, estimate: true },
];

export const LEGAL_NOTICE =
  "Melt value is a reference floor. Melting, treating, or exporting U.S. one-cent coins without a Treasury license is prohibited by 31 CFR Part 82 (penalties under 31 U.S.C. 5111(d)).";
