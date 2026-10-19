// Bonding conductor size, CEC Table 16: minimum size of field-installed bonding
// conductors and system bonding jumpers, by the rating of the overcurrent device or the
// ampacity of the largest ungrounded conductor (Section 10, Rules 10-614 and 10-616).

/**
 * Table 16 rows: [up to amps, copper size, aluminum size].
 * Rows from the Nexans Electrician's Handbook reprint of the table; current-edition spot
 * checks agree at 20 A (14 Cu, BCcampus Section 10 text), 60 A (10 Cu / 8 Al), 200 A (6 Cu)
 * and 800 A (1/0 Cu / 3/0 Al) (IAEI). VERIFY the other rows against CEC 2024 Table 16.
 */
export const TABLE_16 = [
  [20, '14', '12'],
  [30, '12', '10'],
  [40, '10', '8'],
  [60, '10', '8'],
  [100, '8', '6'],
  [200, '6', '4'],
  [300, '4', '2'],
  [400, '3', '1'],
  [500, '2', '1/0'],
  [600, '1', '2/0'],
  [800, '1/0', '3/0'],
  [1000, '2/0', '4/0'],
  [1200, '3/0', '250'],
  [1600, '4/0', '350'],
  [2000, '250', '400'],
  [2500, '350', '500'],
  [3000, '400', '600'],
  [4000, '500', '800'],
  [5000, '700', '1000'],
  [6000, '800', '1250'],
];

/** Bonding conductor for a circuit of `amps`: { cu, al, upTo } or null above the table. */
export function bondingConductor(amps) {
  const row = TABLE_16.find(([max]) => Number(amps) <= max + 1e-9);
  return row ? { upTo: row[0], cu: row[1], al: row[2] } : null;
}
